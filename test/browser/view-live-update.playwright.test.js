/**
 * Served session view never reloads (facts hnr1, hnr3): real `tracequest serve`
 * with fs watchers on, headless Chromium, recordings appended on disk.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { createServer } from "node:http";
import { appendFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_FIXTURE_MODEL, mkTmp, writeJsonlSynced } from "../helpers/fixtures.js";
import { DATA_UPDATE_DEBOUNCE_MS } from "../../src/server/server-live-reload.js";
import { PLAYWRIGHT, SKIP_NO_PLAYWRIGHT } from "../helpers/playwright-gate.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;
const LIVE_MARKER = "live appended chapter marker";

function turn(id, n, prompt, reply) {
  const ts = new Date(Date.UTC(2026, 5, 3, 12, n, 0)).toISOString();
  return [
    { type: "user", sessionId: id, cwd: "/home/dev/live-view", timestamp: ts, uuid: `u-${id}-${n}`, message: { content: [{ type: "text", text: prompt }] } },
    { type: "assistant", sessionId: id, timestamp: ts, uuid: `a-${id}-${n}`, message: { model: CLAUDE_FIXTURE_MODEL, content: [{ type: "text", text: reply }] } },
  ];
}

function longSession(id, turns) {
  const lines = [];
  for (let n = 0; n < turns; n++) {
    lines.push(...turn(id, n, `prompt ${n} for ${id}`, `reply ${n} ${"lorem ipsum dolor sit amet ".repeat(30)}`));
  }
  return lines;
}

async function freePort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    }).on("error", reject);
  });
}

async function withServe(home, fn) {
  const port = await freePort();
  const env = { ...process.env, HOME: home, TRACEQUEST_LIVE_SESSIONS_HOME: home, TRACEQUEST_NO_SIDECAR: "1", TRACEQUEST_SKIP_TMUX: "1", TRACEQUEST_TMUX_BIN: "/nonexistent-tracequest-tmux" };
  delete env.TRACEQUEST_SKIP_LR_WATCH;
  const child = spawn(NODE, [BIN, "serve", "--port", String(port)], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env });
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { out += c; });
  try {
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await get(port, "/api/sessions")) === 200) break;
      } catch { /* not listening yet */ }
      if (child.exitCode != null || Date.now() > deadline) throw new Error(`serve did not start:\n${out}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
  }
}

const SETTLE_MS = DATA_UPDATE_DEBOUNCE_MS + 3_000;

describe("served session view live updates", () => {
  test("a session view never reloads and grows in place keeping chapter, scroll, dialog and typed text", SKIP_NO_PLAYWRIGHT, async () => {
    const home = mkTmp("tq-view-live-");
    const proj = join(home, ".claude", "projects", "-home-dev-live-view");
    const watched = join(proj, "watched-session.jsonl");
    const other = join(proj, "other-session.jsonl");
    writeJsonlSynced(watched, longSession("watched-session", 30));
    writeJsonlSynced(other, longSession("other-session", 3));
    try {
      await withServe(home, async (base) => {
        const browser = await PLAYWRIGHT.chromium.launch({ headless: true });
        try {
          const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
          await page.goto(`${base}/view?path=${encodeURIComponent(watched)}&source=claude`, { waitUntil: "load" });
          await page.waitForSelector("#chapter-0");
          // A reload replaces the document and drops this marker; hash and
          // replaceState updates (chapter permalinks) keep it.
          await page.evaluate(() => { window.__sameDocument = true; });
          const sameDocument = () => page.evaluate(() => window.__sameDocument === true);

          await page.click("#chapter-0 .chapter-head");
          await page.waitForSelector("#chapter-0.expanded");

          // Another recording changes: this page is untouched.
          for (const line of turn("other-session", 50, "other grows", "other reply")) appendFileSync(other, JSON.stringify(line) + "\n");
          await page.waitForTimeout(SETTLE_MS);
          assert.ok(await sameDocument(), "no reload when another session changes");

          // This recording grows: the new chapter appears in place, the
          // expanded chapter and the scroll position stay.
          await page.evaluate(() => window.scrollTo({ top: 900, behavior: "instant" }));
          const scrollBefore = await page.evaluate(() => window.scrollY);
          assert.ok(scrollBefore > 500, "the page is long enough to scroll");
          for (const line of turn("watched-session", 58, LIVE_MARKER, "fresh reply")) appendFileSync(watched, JSON.stringify(line) + "\n");
          await page.waitForFunction((m) => document.body.innerText.includes(m), LIVE_MARKER, { timeout: SETTLE_MS + 10_000 });
          await page.waitForTimeout(300);
          assert.ok(await sameDocument(), "no reload when this session grows");
          assert.ok(await page.$("#chapter-0.expanded"), "expanded chapter stays expanded");
          const scrollAfter = await page.evaluate(() => window.scrollY);
          assert.ok(Math.abs(scrollAfter - scrollBefore) <= 2, `scroll kept (${scrollBefore} -> ${scrollAfter})`);

          // An open dialog with typed text survives the next update.
          await page.click(".hf-btn");
          await page.waitForSelector("#hfModalOverlay .hf-modal-input");
          await page.fill("#hfModalOverlay .hf-modal-input[type=password]", "typed-token-123");
          for (const line of turn("watched-session", 59, LIVE_MARKER + " two", "fresh reply two")) appendFileSync(watched, JSON.stringify(line) + "\n");
          await page.waitForFunction((m) => document.body.innerText.includes(m), LIVE_MARKER + " two", { timeout: SETTLE_MS + 10_000 });
          assert.ok(await sameDocument(), "no reload with the dialog open");
          assert.equal(await page.inputValue("#hfModalOverlay .hf-modal-input[type=password]"), "typed-token-123", "dialog and typed text kept");
        } finally {
          await browser.close();
        }
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

});
