/**
 * Search loading feedback in the served UI (facts ws1, rf1): the top-bar
 * search box and the Runs filter show a spinner from the keystroke until the
 * answer is on screen, and Enter in the search box never opens a hit of an
 * earlier query.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkTmp, writeJsonl } from "../helpers/fixtures.js";
import { PLAYWRIGHT, SKIP_NO_PLAYWRIGHT } from "../helpers/playwright-gate.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); }).on("error", reject);
  });
}

async function withServe(fn) {
  const home = mkTmp("tq-search-loading-");
  for (let i = 0; i < 4; i++) {
    writeJsonl(join(home, ".claude/projects/-home-dev-app", `s${i}.jsonl`), [
      { type: "user", sessionId: `s${i}`, cwd: "/home/dev/app", timestamp: `2026-05-0${i + 1}T00:00:00Z`, uuid: `u${i}`, message: { content: [{ type: "text", text: `fix the zebra build ${i}` }] } },
      { type: "assistant", sessionId: `s${i}`, timestamp: `2026-05-0${i + 1}T00:00:01Z`, uuid: `a${i}`, message: { model: "claude-sonnet-4-20250514", content: [{ type: "text", text: "you're absolutely right" }], usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
  }
  const port = await freePort();
  const child = spawn(process.execPath, [BIN, "serve", "--port", String(port)], {
    cwd: ROOT,
    stdio: "ignore",
    env: { ...process.env, HOME: home, TRACEQUEST_NO_SIDECAR: "1", TRACEQUEST_SKIP_TMUX: "1", TRACEQUEST_TMUX_BIN: "/nonexistent-tracequest-tmux", TRACEQUEST_SKIP_LR_WATCH: "1" },
  });
  try {
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if (await get(port, "/api/sessions") === 200) break;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error("serve did not start");
      await new Promise((r) => setTimeout(r, 100));
    }
    const browser = await PLAYWRIGHT.chromium.launch({ headless: true });
    try {
      await fn(await browser.newPage(), `http://127.0.0.1:${port}`);
    } finally {
      await browser.close();
    }
  } finally {
    child.kill("SIGKILL");
  }
}

/** Hold matching requests until release() is called. */
async function holdRequests(page, pattern) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route(pattern, async (route) => {
    await gate;
    await route.continue();
  });
  return () => release();
}

/** window.__abortedRequest(value): whether the page aborted a search request for that q or expr. */
async function trackAborts(page) {
  await page.addInitScript(() => {
    const signals = [];
    const original = window.fetch;
    window.fetch = function (input, init) {
      const url = new URL(typeof input === "string" ? input : input.url, location.href);
      const value = url.searchParams.get("expr") ?? url.searchParams.get("q");
      if (value !== null && init && init.signal) signals.push([value, init.signal]);
      return original.apply(this, arguments);
    };
    window.__abortedRequest = (value) => signals.some(([v, signal]) => v === value && signal.aborted);
  });
}

describe("search loading feedback", () => {
  test("the top-bar search box shows a spinner until its results show", SKIP_NO_PLAYWRIGHT, async () => {
    await withServe(async (page, base) => {
      await page.goto(`${base}/sessions`, { waitUntil: "load" });
      const release = await holdRequests(page, /\/api\/search\?q=/);
      await page.click("#workspaceSearch");
      await page.keyboard.type("zebra");
      await page.locator("#workspaceSearchSpinner").waitFor({ state: "visible", timeout: 2_000 });
      assert.equal(await page.getAttribute("#workspaceSearch", "aria-busy"), "true");
      release();
      await page.locator("#workspaceSearchList .tq-search-item").first().waitFor({ timeout: 10_000 });
      await page.locator("#workspaceSearchSpinner").waitFor({ state: "hidden", timeout: 2_000 });
      assert.equal(await page.getAttribute("#workspaceSearch", "aria-busy"), null);
    });
  });

  test("Enter before the results arrive opens the Runs list for the typed query, not an earlier hit", SKIP_NO_PLAYWRIGHT, async () => {
    await withServe(async (page, base) => {
      await page.goto(`${base}/sessions`, { waitUntil: "load" });
      await page.click("#workspaceSearch");
      // Focus lists recent sessions: those are hits of the empty query.
      await page.locator("#workspaceSearchList .tq-search-item").first().waitFor({ timeout: 10_000 });
      await holdRequests(page, /\/api\/search\?q=/);
      await page.keyboard.type("zebra build");
      await Promise.all([page.waitForURL(/\/sessions\?expr=zebra(\+|%20)build$/), page.keyboard.press("Enter")]);
    });
  });

  test("the Runs filter shows a spinner while its rows load", SKIP_NO_PLAYWRIGHT, async () => {
    await withServe(async (page, base) => {
      await page.goto(`${base}/sessions`, { waitUntil: "load" });
      await page.locator("#sessions .session-row").first().waitFor({ timeout: 10_000 });
      const release = await holdRequests(page, /\/api\/sessions\?.*expr=/);
      await page.click("#filterInput");
      await page.keyboard.type("zebra");
      await page.waitForFunction(() => document.getElementById("filterBar").classList.contains("is-loading"), null, { timeout: 2_000 });
      assert.equal(await page.getAttribute("#filterInput", "aria-busy"), "true");
      release();
      await page.waitForFunction(() => !document.getElementById("filterBar").classList.contains("is-loading"), null, { timeout: 10_000 });
      assert.equal(await page.locator("#sessions .session-row").count(), 4);
    });
  });

  test("a partial first page shows its rows at once, then the complete answer (rf3)", SKIP_NO_PLAYWRIGHT, async () => {
    await withServe(async (page, base) => {
      await page.goto(`${base}/sessions`, { waitUntil: "load" });
      await page.locator("#sessions .session-row").first().waitFor({ timeout: 10_000 });
      // The server's first page for the phrase, as a larger list would answer it: two rows, count unknown.
      await page.route((url) => url.pathname === "/api/sessions" && url.searchParams.get("first") === "1", async (route) => {
        const res = await route.fetch();
        const data = await res.json();
        await route.fulfill({ response: res, json: { ...data, sessions: data.sessions.slice(0, 2), total: null, stats: undefined, partial: true } });
      });
      const release = await holdRequests(page, (url) => url.pathname === "/api/sessions" && url.searchParams.has("expr") && !url.searchParams.has("first"));
      await page.click("#filterInput");
      await page.keyboard.insertText('"absolutely right"');
      await page.waitForFunction(() => document.querySelectorAll("#sessions .session-row").length === 2, null, { timeout: 10_000 });
      assert.equal(await page.textContent("#count"), "2+ runs");
      assert.ok(await page.evaluate(() => document.getElementById("filterBar").classList.contains("is-loading")), "still loading the complete answer");
      release();
      await page.waitForFunction(() => !document.getElementById("filterBar").classList.contains("is-loading"), null, { timeout: 10_000 });
      assert.equal(await page.locator("#sessions .session-row").count(), 4);
      assert.equal(await page.textContent("#count"), "4 runs");
    });
  });

  test("typing a new Runs filter cancels the request in flight and sends the new one at once", SKIP_NO_PLAYWRIGHT, async () => {
    await withServe(async (page, base) => {
      await trackAborts(page);
      await page.goto(`${base}/sessions`, { waitUntil: "load" });
      await page.locator("#sessions .session-row").first().waitFor({ timeout: 10_000 });
      // Hold the first expression's answer as if its phrase check were slow.
      await page.route((url) => url.pathname === "/api/sessions" && url.searchParams.get("expr") === '"zebra build"', () => new Promise(() => {}));
      const first = page.waitForRequest((req) => new URL(req.url()).searchParams.get("expr") === '"zebra build"');
      await page.click("#filterInput");
      await page.keyboard.insertText('"zebra build"');
      await first;
      const replacement = page.waitForRequest((req) => new URL(req.url()).searchParams.get("expr") === "fix", { timeout: 2_000 });
      await page.keyboard.press("Control+A");
      await page.keyboard.insertText("fix");
      await replacement;
      assert.equal(await page.evaluate(() => window.__abortedRequest('"zebra build"')), true, "the request typed over was aborted");
      await page.waitForFunction(() => !document.getElementById("filterBar").classList.contains("is-loading"), null, { timeout: 10_000 });
      assert.equal(await page.locator("#sessions .session-row").count(), 4);
    });
  });

  test("typing on in the top-bar search box cancels the query typed over", SKIP_NO_PLAYWRIGHT, async () => {
    await withServe(async (page, base) => {
      await trackAborts(page);
      await page.goto(`${base}/sessions`, { waitUntil: "load" });
      await page.route((url) => url.pathname === "/api/search" && url.searchParams.get("q") === "zeb", () => new Promise(() => {}));
      const first = page.waitForRequest((req) => new URL(req.url()).searchParams.get("q") === "zeb");
      await page.click("#workspaceSearch");
      await page.keyboard.insertText("zeb");
      await first;
      const replacement = page.waitForRequest((req) => new URL(req.url()).searchParams.get("q") === "zebra", { timeout: 2_000 });
      await page.keyboard.insertText("ra");
      await replacement;
      assert.equal(await page.evaluate(() => window.__abortedRequest("zeb")), true, "the query typed over was aborted");
      await page.locator("#workspaceSearchList .tq-search-item").first().waitFor({ timeout: 10_000 });
    });
  });
});
