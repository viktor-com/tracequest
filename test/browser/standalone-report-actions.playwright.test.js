/**
 * Standalone reports (`tracequest render` output and the /export download)
 * are opened away from the tracequest server, so they offer no Markdown or
 * Export link: both are server routes. The served /view keeps them.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkTmp, writeJsonl } from "../helpers/fixtures.js";
import { PLAYWRIGHT, SKIP_NO_PLAYWRIGHT } from "../helpers/playwright-gate.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function allocPort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function serveEnv(home) {
  return {
    ...process.env,
    HOME: home,
    TRACEQUEST_LIVE_SESSIONS_HOME: home,
    TRACEQUEST_NO_SIDECAR: "1",
    TRACEQUEST_SKIP_TMUX: "1",
    TRACEQUEST_TMUX_BIN: "/nonexistent-tracequest-tmux",
    TRACEQUEST_SKIP_LR_WATCH: "1",
  };
}

async function waitForOk(url, child, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`serve exited early (${child.exitCode})`);
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status} for ${url}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw lastErr ?? new Error(`timed out waiting for ${url}`);
}

/** A plain static file server: another origin with no tracequest routes. */
async function plainServer(dir) {
  const server = createServer((req, res) => {
    const name = new URL(req.url, "http://x").pathname.slice(1);
    try {
      const body = readFileSync(join(dir, name));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  const port = await listen(server);
  return { server, port };
}

function seedHome() {
  const home = mkTmp("tracequest-standalone-actions-");
  const sessionPath = join(home, ".claude", "projects", "standalone-proj", "standalone-session.jsonl");
  writeJsonl(sessionPath, [
    {
      type: "user",
      sessionId: "standalone-session-aaaa",
      cwd: "/home/dev/tracequest",
      timestamp: "2026-06-03T10:00:00.000Z",
      message: { content: [{ type: "text", text: "standalone report prompt" }] },
    },
    {
      type: "assistant",
      sessionId: "standalone-session-aaaa",
      timestamp: "2026-06-03T10:00:05.000Z",
      message: {
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 220, output_tokens: 80 },
        content: [{ type: "text", text: "Report ready." }],
      },
    },
  ]);
  return { home, sessionPath };
}

async function headerActions(page) {
  await page.waitForSelector(".header-actions");
  return page.$$eval(".header-actions > *", (els) =>
    els.map((el) => ({ text: el.textContent.trim(), href: el.getAttribute("href") })));
}

describe("standalone report actions playwright", SKIP_NO_PLAYWRIGHT, () => {
  test("rendered and exported reports offer no server-only Markdown or Export links; served /view keeps them", async () => {
    const { chromium } = PLAYWRIGHT;
    const { home, sessionPath } = seedHome();
    const outDir = mkTmp("tracequest-standalone-out-");
    execFileSync(NODE, [BIN, "render", sessionPath, "-o", join(outDir, "rendered.html")], {
      cwd: ROOT, env: serveEnv(home), stdio: "ignore",
    });

    const port = await allocPort();
    const child = spawn(NODE, [BIN, "serve", "--port", String(port)], {
      cwd: ROOT, env: serveEnv(home), stdio: "ignore",
    });
    const plain = await plainServer(outDir);
    const browser = await chromium.launch();
    try {
      const origin = `http://127.0.0.1:${port}`;
      const handle = `path=${encodeURIComponent(sessionPath)}`;
      const exported = await waitForOk(`${origin}/export?${handle}`, child);
      writeFileSync(join(outDir, "exported.html"), await exported.text());

      const page = await browser.newPage();
      for (const file of ["rendered.html", "exported.html"]) {
        await page.goto(`http://127.0.0.1:${plain.port}/${file}`, { waitUntil: "domcontentloaded" });
        const actions = await headerActions(page);
        const texts = actions.map((a) => a.text);
        assert.ok(texts.includes("Print"), `${file} still offers Print: ${JSON.stringify(actions)}`);
        assert.ok(!texts.includes("Markdown"), `${file} offers no Markdown link: ${JSON.stringify(actions)}`);
        assert.ok(!texts.includes("Export"), `${file} offers no Export link: ${JSON.stringify(actions)}`);
        const serverLinks = await page.$$eval("a[href]", (els) =>
          els.map((el) => el.getAttribute("href")).filter((h) => /^\/(markdown|export)\b/.test(h)));
        assert.deepEqual(serverLinks, [], `${file} links no /markdown or /export route`);
      }

      await page.goto(`${origin}/view?${handle}`, { waitUntil: "domcontentloaded" });
      const served = await headerActions(page);
      const md = served.find((a) => a.text === "Markdown");
      const exp = served.find((a) => a.text === "Export");
      assert.ok(md && exp, `served /view offers Markdown and Export: ${JSON.stringify(served)}`);
      const mdRes = await fetch(new URL(md.href, origin));
      assert.equal(mdRes.status, 200);
      assert.match(mdRes.headers.get("content-disposition") || "", /\.md"/);
      const expRes = await fetch(new URL(exp.href, origin));
      assert.equal(expRes.status, 200);
      assert.match(expRes.headers.get("content-disposition") || "", /\.html"/);
    } finally {
      await browser.close();
      plain.server.close();
      child.kill("SIGKILL");
    }
  });
});
