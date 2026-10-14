import "../helpers/skip-lr-watch-env.js";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { estimateCost, estimateParsedStatsCost, estimateChapterTokenCost } from "../../src/filter/filter-formats.js";
import { buildSessionChapters } from "../../src/chapters/session-chapters.js";
import { PLAYWRIGHT, SKIP_NO_PLAYWRIGHT } from "../helpers/playwright-gate.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
let home, child, base, rows;
const logs = [];
before(async () => {
  home = mkdtempSync(join(tmpdir(), "tracequest-cost-"));
  for (const name of ["claude-fragments", "claude-cache", "claude-cache-five-minute", "gpt-6.1-sol", "gpt-5.6-sol"]) {
    const dir = join(home, name.startsWith("claude") ? ".claude/projects/cost" : ".codex/sessions/2026/10/14");
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(root, "test/fixtures/cost-display", name + ".jsonl"), join(dir, name.startsWith("claude") ? name + ".jsonl" : "rollout-" + name + ".jsonl"));
  }
  const listener = createServer();
  await new Promise(r => listener.listen(0, "127.0.0.1", r));
  const port = listener.address().port;
  await new Promise(r => listener.close(r));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(root, "bin/tracequest.js"), "serve", "--port", String(port)], {
    cwd: root, env: { ...process.env, HOME: home, TRACEQUEST_NO_SIDECAR: process.env.COST_TEST_SIDECAR === "1" ? "0" : "1", TRACEQUEST_SKIP_LR_WATCH: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", b => logs.push(String(b)));
  child.stderr.on("data", b => logs.push(String(b)));
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(base + "/api/sessions");
      if (response.ok) {
        rows = (await response.json()).sessions;
        if (process.env.COST_TEST_SIDECAR === "1") assert.match(logs.join(""), /indexed \d+ session.*via sidecar/, "native indexer must run");
        return;
      }
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
  if (home) rmSync(home, { recursive: true, force: true });
});

async function run(name) {
  const row = rows.find(r => r.path.endsWith(name + ".jsonl"));
  assert.ok(row, name + " is listed");
  const query = `id=${row.id}&source=${row.source}`;
  const response = await fetch(base + "/api/view-session?" + query);
  assert.equal(response.status, 200);
  const session = (await response.json()).session;
  return { row, session, query };
}
function close(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`); }
function costsAgree(row, session, expected) {
  close(estimateCost(row), expected);
  close(estimateCost(session.summary), expected);
  close(estimateParsedStatsCost(session.model, session.stats), expected);
  close(buildSessionChapters(session).reduce((s, ch) => s + estimateChapterTokenCost(session.model, ch.tokens), 0), expected);
}

test("Claude fragments count usage once and preserve every tool call", async () => {
  const { row, session } = await run("claude-fragments");
  assert.equal(row.totalTokens, 104707);
  assert.equal(session.stats.totalInputTokens, 103881);
  assert.equal(session.stats.totalOutputTokens, 826);
  assert.equal(session.stats.totalCacheHit, 72033);
  assert.equal(session.stats.toolCounts.Bash, 3);
  assert.equal(row.toolCounts.Bash, 3);
  assert.equal(buildSessionChapters(session)[0].tokens.input, 103881);
});
test("cache writes use the recorded five-minute or one-hour rate", async () => {
  const { row, session } = await run("claude-cache");
  costsAgree(row, session, 0.093937);
  const fiveMinute = await run("claude-cache-five-minute");
  costsAgree(fiveMinute.row, fiveMinute.session, 0.05959);
});
test("published rates price Opus 5.5 in list, detail and chapters", async () => {
  const { row, session } = await run("claude-fragments");
  costsAgree(row, session, 0.2856866);
});
test("published rates price Codex cached reads and per-request long context", async () => {
  const { row, session } = await run("gpt-6.1-sol");
  assert.equal(row.totalTokens, 30271625);
  assert.equal(session.stats.totalInputTokens, 30175842);
  // Independently derived from each growing raw token_count, including 24 long requests.
  costsAgree(row, session, 5.7758562);
});
test("published rates price GPT-5.6 Sol cached reads", async () => {
  const { row, session } = await run("gpt-5.6-sol");
  costsAgree(row, session, 1.7374792);
});
test("published rates appear in the served browser", SKIP_NO_PLAYWRIGHT, async () => {
  const { query } = await run("claude-cache");
  const browser = await PLAYWRIGHT.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(base + "/view?" + query);
    await page.locator(".ss-cost .ss-value").waitFor();
    assert.equal(await page.locator(".ss-cost .ss-value").innerText(), "~$0.094");
  } finally { await browser.close(); }
});
