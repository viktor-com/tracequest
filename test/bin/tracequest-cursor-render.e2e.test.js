import "../helpers/skip-lr-watch-env.js";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, statSync, utimesSync } from "node:fs";
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
const cursorRel = join(".cursor/projects/srv-shop/agent-transcripts", composerId, composerId + ".jsonl");
const codexRel = ".codex/sessions/2026/10/14/rollout-gpt-5.6-sol.jsonl";
let scratch, home, freshHome, env, server, browser, page;

function seedRecordings(homeDir) {
  const cursor = join(homeDir, cursorRel);
  mkdirSync(dirname(cursor), { recursive: true });
  copyFileSync(join(root, "test/fixtures/cost-display/cursor-composer.jsonl"), cursor);
  const born = statSync(cursor).birthtimeMs || statSync(cursor).mtimeMs;
  utimesSync(cursor, new Date(born), new Date(born + 2 * 3600_000));
  const codex = join(homeDir, codexRel);
  mkdirSync(dirname(codex), { recursive: true });
  copyFileSync(join(root, "test/fixtures/cost-display/gpt-5.6-sol.jsonl"), codex);
}

async function startServer() {
  const listener = createServer();
  await new Promise(r => listener.listen(0, "127.0.0.1", r));
  const port = listener.address().port;
  await new Promise(r => listener.close(r));
  const base = `http://127.0.0.1:${port}`;
  const logs = [];
  const child = spawn(process.execPath, [join(root, "bin/tracequest.js"), "serve", "--port", String(port)], {
    cwd: root, env: { ...env, HOME: home }, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", b => logs.push(String(b)));
  child.stderr.on("data", b => logs.push(String(b)));
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(base + "/api/sessions");
      if (response.ok) {
        const rows = (await response.json()).sessions;
        if (rows.length === 2) return { child, base, rows };
      }
    } catch {}
    if (child.exitCode !== null) break;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("serve did not start: " + logs.join(""));
}

// SIGTERM flushes the deferred index.json write.
async function stopServer() {
  if (!server || server.child.exitCode !== null) return;
  const exited = new Promise(r => server.child.once("exit", r));
  server.child.kill("SIGTERM");
  await exited;
}

before(async () => {
  scratch = mkdtempSync(join(tmpdir(), "tracequest-cursor-render-"));
  home = join(scratch, "home");
  freshHome = join(scratch, "fresh-home");
  seedRecordings(home);
  seedRecordings(freshHome);
  const stateDb = join(scratch, "state.vscdb");
  const db = new DatabaseSync(stateDb);
  db.exec("CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)").run(
    `composerData:${composerId}`,
    JSON.stringify({ composerId, modelConfig: { modelName: "claude-opus-5-5" } }),
  );
  db.close();
  env = { ...process.env, TRACEQUEST_CURSOR_STATE_DB: stateDb, TRACEQUEST_NO_SIDECAR: "1", TRACEQUEST_SKIP_LR_WATCH: "1" };
  delete env.TRACEQUEST_CACHE_DIR;
  server = await startServer();
});
after(async () => {
  if (browser) await browser.close();
  await stopServer();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

function renderFromCli(homeDir, rel, name) {
  const out = join(scratch, name + ".html");
  execFileSync(process.execPath, [join(root, "bin/tracequest.js"), "render", join(homeDir, rel), "--out", out], {
    cwd: root, env: { ...env, HOME: homeDir }, stdio: "pipe",
  });
  return pathToFileURL(out).href;
}

async function figures(url) {
  if (!page) {
    browser = await PLAYWRIGHT.chromium.launch({ headless: true });
    page = await browser.newPage();
  }
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

function servedUrl(rel) {
  const row = server.rows.find(r => r.path.endsWith(rel));
  assert.ok(row, rel + " is listed");
  return `${server.base}/view?id=${row.id}&source=${row.source}`;
}

function editIndex(edit) {
  const file = join(home, ".cache/tracequest/index.json");
  const index = JSON.parse(readFileSync(file, "utf8"));
  edit(index);
  writeFileSync(file, JSON.stringify(index));
}

test("Cursor CLI render shows the served view's duration, tokens and cost", SKIP_NO_PLAYWRIGHT, async () => {
  assert.equal(server.rows.find(r => r.source === "cursor").model, "claude-opus-5-5");
  const served = await figures(servedUrl(cursorRel));
  // File times are not a duration; the estimate is priced at the model's rates.
  assert.equal(served.duration, null);
  assert.equal(served.metaDuration, "—");
  assert.match(served.cost, /^~\$\d/);
  assert.deepEqual(await figures(renderFromCli(freshHome, cursorRel, "unindexed")), served, "render before any index exists");

  // A served index whose estimate differs from the CLI's own indexer (as the
  // native indexer's may): the export shows the row the server shows.
  await stopServer();
  editIndex((index) => {
    const row = index[join(home, cursorRel)];
    row.outputTokens += 40000;
    row.totalTokens += 40000;
  });
  server = await startServer();
  const reindexed = await figures(servedUrl(cursorRel));
  assert.notDeepEqual(reindexed, served, "the server reuses the index.json row");
  assert.deepEqual(await figures(renderFromCli(home, cursorRel, "indexed")), reindexed, "render with the session index in place");
});

test("CLI render never shows an index row a server build would heal", SKIP_NO_PLAYWRIGHT, async () => {
  await stopServer();
  const unindexed = await figures(renderFromCli(freshHome, codexRel, "codex-unindexed"));
  editIndex((index) => { index[join(home, codexRel)].durationMs = 5 * 3600_000; });
  assert.equal((await figures(renderFromCli(home, codexRel, "codex-current"))).duration, "5h", "a current-format row is shown");
  editIndex((index) => { delete index._active; });
  assert.deepEqual(await figures(renderFromCli(home, codexRel, "codex-old-format")), unindexed, "an old-format row is indexed afresh");
});
