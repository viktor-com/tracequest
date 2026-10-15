// Usage: node repro.mjs <worktree> <label>
// CLI-renders two real recordings, exports one through a scratch serve, then
// opens every file on a plain HTTP server and reports the header actions.
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";
import { createRequire } from "node:module";

const [wt, label] = process.argv.slice(2);
const { chromium } = createRequire(join(wt, "package.json"))("playwright");
const S = "/tmp/tq-fix-09";
const HOME = join(S, "home");
const OUT = join(S, "out", label);
mkdirSync(OUT, { recursive: true });
const env = { ...process.env, HOME, TRACEQUEST_TMUX_SOCKET: "tq-fix-09", TRACEQUEST_TMUX_SESSION: "tq-fix-09", TRACEQUEST_SKIP_LR_WATCH: "1" };
const BIN = join(wt, "bin/tracequest.js");
const CLAUDE = join(HOME, ".claude/projects/-home-everlier-code-naiou/f1651f5b-5bd1-41a5-8f9e-63d85bd93c6b.jsonl");
const CURSOR = join(HOME, ".cursor/projects/tmp-zeta-vault-hook/agent-transcripts/ac0a83a3-d995-424a-b4f0-22a59c6ccbf7/ac0a83a3-d995-424a-b4f0-22a59c6ccbf7.jsonl");

execFileSync(process.execPath, [BIN, "render", CLAUDE, "-o", join(OUT, "cli-claude.html")], { env, stdio: "inherit" });
execFileSync(process.execPath, [BIN, "render", CURSOR, "-o", join(OUT, "cli-cursor.html")], { env, stdio: "inherit" });

// Export through the real server (scratch HOME, unique port and tmux socket).
const PORT = 47909;
const serve = spawn(process.execPath, [BIN, "serve", "--port", String(PORT)], { env, stdio: "ignore" });
try {
  let res;
  for (let i = 0; i < 100; i++) {
    try { res = await fetch(`http://127.0.0.1:${PORT}/export?path=${encodeURIComponent(CLAUDE)}`); if (res.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log("export status", res.status, res.headers.get("content-disposition"));
  writeFileSync(join(OUT, "exported-claude.html"), await res.text());

  // Served page: Markdown / Export must still be offered and work there.
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`http://127.0.0.1:${PORT}/view?path=${encodeURIComponent(CLAUDE)}`);
  await page.waitForSelector(".header-actions");
  const served = await page.$$eval(".header-actions > *", (els) => els.map((e) => [e.textContent.trim(), e.getAttribute("href")]));
  console.log("served /view actions:", JSON.stringify(served));
  for (const [name, href] of served) {
    if (!href) continue;
    const r = await fetch(new URL(href, `http://127.0.0.1:${PORT}`));
    console.log(`  served ${name} -> ${r.status} ${r.headers.get("content-disposition")}`);
  }
  await page.locator(".header").screenshot({ path: join(OUT, "served-view-header.png") });
  await browser.close();
} finally {
  serve.kill();
}

// A plain HTTP server on another origin, like the audit used.
const plain = createServer((req, res) => {
  const p = join(OUT, decodeURIComponent(new URL(req.url, "http://x").pathname));
  try {
    const body = readFileSync(p);
    res.writeHead(200, { "content-type": extname(p) === ".html" ? "text/html" : "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404); res.end("404 not found"); }
});
await new Promise((r) => plain.listen(47910, "127.0.0.1", r));
const browser = await chromium.launch();
for (const f of ["exported-claude.html", "cli-claude.html", "cli-cursor.html"]) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`http://127.0.0.1:47910/${f}`);
  await page.waitForSelector(".header-actions");
  const actions = await page.$$eval(".header-actions > *", (els) => els.map((e) => [e.textContent.trim(), e.getAttribute("href")]));
  console.log(`${f} actions:`, JSON.stringify(actions));
  await page.locator(".header").screenshot({ path: join(OUT, f.replace(".html", "-header.png")) });
  const md = page.locator(".md-btn");
  if (await md.count()) {
    const [resp] = await Promise.all([page.waitForResponse(() => true), md.click()]);
    console.log(`  click Markdown -> ${resp.url()} ${resp.status()}`);
    await page.screenshot({ path: join(OUT, f.replace(".html", "-after-markdown-click.png")) });
  } else {
    console.log("  no Markdown link offered");
  }
  await page.close();
}
await browser.close();
plain.close();
