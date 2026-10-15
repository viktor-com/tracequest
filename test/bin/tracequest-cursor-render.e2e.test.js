import "../helpers/skip-lr-watch-env.js";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { PLAYWRIGHT, SKIP_NO_PLAYWRIGHT } from "../helpers/playwright-gate.js";

// A Cursor composer transcript: no event timestamps, no recorded usage, the
// model only in Cursor's state.vscdb, and file times spanning two hours.
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const composerId = "5e1d0c3a-7b2f-4c19-9a8e-2f6d4b1c0e77";
const fixture = join(root, "test/fixtures/cost-display/cursor-composer.jsonl");
let scratch, home, stateDb, child, base, env;
const logs = [];

function seedRecording(homeDir) {
  const dir = join(homeDir, ".cursor/projects/srv-shop/agent-transcripts", composerId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, composerId + ".jsonl");
  copyFileSync(fixture, file);
  const born = statSync(file).birthtimeMs || statSync(file).mtimeMs;
  utimesSync(file, new Date(born), new Date(born + 2 * 3600_000));
  return file;
}

before(async () => {
  scratch = mkdtempSync(join(tmpdir(), "tracequest-cursor-render-"));
  home = join(scratch, "home");
  seedRecording(home);
  stateDb = join(scratch, "state.vscdb");
  const db = new DatabaseSync(stateDb);
  db.exec("CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)").run(
    `composerData:${composerId}`,
    JSON.stringify({ composerId, modelConfig: { modelName: "claude-opus-5-5" } }),
  );
  db.close();
  env = { ...process.env, TRACEQUEST_CURSOR_STATE_DB: stateDb, TRACEQUEST_NO_SIDECAR: "1", TRACEQUEST_SKIP_LR_WATCH: "1" };
  const listener = createServer();
  await new Promise(r => listener.listen(0, "127.0.0.1", r));
  const port = listener.address().port;
  await new Promise(r => listener.close(r));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(root, "bin/tracequest.js"), "serve", "--port", String(port)], {
    cwd: root, env: { ...env, HOME: home }, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", b => logs.push(String(b)));
  child.stderr.on("data", b => logs.push(String(b)));
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(base + "/api/sessions");
      if (response.ok && (await response.json()).sessions.length) return;
    } catch {}
    if (child.exitCode !== null) break;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("serve did not start: " + logs.join(""));
});
after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise(r => child.once("exit", r));
    child.kill("SIGTERM");
    await exited;
  }
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

function renderFromCli(homeDir, out) {
  const file = join(homeDir, ".cursor/projects/srv-shop/agent-transcripts", composerId, composerId + ".jsonl");
  execFileSync(process.execPath, [join(root, "bin/tracequest.js"), "render", file, "--out", out], {
    cwd: root, env: { ...env, HOME: homeDir }, stdio: "pipe",
  });
  return pathToFileURL(out).href;
}

async function figures(page, url) {
  await page.goto(url);
  await page.locator(".session-summary").first().waitFor();
  return page.evaluate(() => {
    const text = (sel) => document.querySelector(sel)?.textContent.trim() ?? null;
    const stat = (label) => [...document.querySelectorAll(".stats-bar .stat")]
      .find(s => s.querySelector(".stat-label")?.textContent.trim() === label)
      ?.querySelector(".stat-value")?.textContent.trim() ?? null;
    const meta = (label) => [...document.querySelectorAll(".meta-item")]
      .find(m => m.querySelector(".meta-label")?.textContent.trim() === label)
      ?.querySelector(".meta-value")?.textContent.trim() ?? null;
    return {
      duration: text(".ss-duration .ss-value"),
      metaDuration: meta("duration"),
      cost: text(".ss-cost .ss-value"),
      tokens: text(".ss-tokens .ss-value"),
      inputTokens: stat("input tok"),
      outputTokens: stat("output tok"),
    };
  });
}

test("Cursor CLI render shows the served view's duration, tokens and cost", SKIP_NO_PLAYWRIGHT, async () => {
  const row = (await (await fetch(base + "/api/sessions")).json()).sessions.find(r => r.path.endsWith(composerId + ".jsonl"));
  assert.ok(row, "the Cursor session is listed");
  assert.equal(row.model, "claude-opus-5-5");
  const indexed = renderFromCli(home, join(scratch, "indexed.html"));
  const freshHome = join(scratch, "fresh-home");
  seedRecording(freshHome);
  const unindexed = renderFromCli(freshHome, join(scratch, "unindexed.html"));

  const browser = await PLAYWRIGHT.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const served = await figures(page, `${base}/view?id=${row.id}&source=cursor`);
    // File times are not a duration; the estimate is priced at the model's rates.
    assert.equal(served.duration, null);
    assert.equal(served.metaDuration, "—");
    assert.match(served.cost, /^~\$\d/);
    assert.deepEqual(await figures(page, indexed), served, "render with the session index in place");
    assert.deepEqual(await figures(page, unindexed), served, "render before any index exists");
  } finally { await browser.close(); }
});
