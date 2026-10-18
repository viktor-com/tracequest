/**
 * Run view navigation: one way into analytics, and every way back out of it.
 * A real server and a real browser walk from /run?session= to the analytics
 * panel and the full /view page, then back by the close control, browser
 * Back and the keyboard, at desktop and phone widths.
 */
import "../helpers/skip-lr-watch-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { mkTmp, writeJsonl } from "../helpers/fixtures.js";
import { PLAYWRIGHT, SKIP_NO_PLAYWRIGHT } from "../helpers/playwright-gate.js";
import { sessionHash } from "../../src/sessions/session-hash.js";
import { runPage } from "../../src/browser/run-page.js";

const ROOT = new URL("../../", import.meta.url).pathname;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = (n) => new Date(Date.UTC(2026, 9, 18, 9, 0, n)).toISOString();

async function serve(home) {
  const socket = createServer();
  await new Promise((r) => socket.listen(0, "127.0.0.1", r));
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  const child = spawn(process.execPath, ["bin/tracequest.js", "serve", "--port", String(port)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: home, TRACEQUEST_LIVE_SESSIONS_HOME: home, TRACEQUEST_NO_SIDECAR: "1", TRACEQUEST_SKIP_TMUX: "1", TRACEQUEST_SKIP_LR_WATCH: "1", TRACEQUEST_TMUX_SOCKET: `tq-nav-${port}`, TRACEQUEST_TMUX_SESSION: `tq-nav-${port}` },
  });
  let log = "";
  child.stdout.on("data", (c) => { log += c; });
  child.stderr.on("data", (c) => { log += c; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    if (child.exitCode != null) throw new Error(log);
    try { await fetch(base + "/__probe"); return { child, base }; } catch { await pause(50); }
  }
  child.kill("SIGKILL");
  throw new Error(`serve did not listen: ${log}`);
}

const row = (n, role, content) => ({ type: role, sessionId: "nav", cwd: "/repo", timestamp: ts(n), uuid: `${role}-${n}`, message: role === "assistant" ? { model: "claude-sonnet-4-20250514", usage: { input_tokens: 100, output_tokens: 20 }, content } : { content } });

function recording() {
  return [
    row(0, "user", "Add pagination to the todo list"),
    row(1, "assistant", [{ type: "text", text: "Reading the route first." }, { type: "tool_use", id: "r1", name: "Read", input: { file_path: "/repo/routes.js" } }]),
    row(2, "user", [{ type: "tool_result", tool_use_id: "r1", content: "module.exports = {}" }]),
    row(3, "assistant", [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "npm test" } }]),
    row(4, "user", [{ type: "tool_result", tool_use_id: "b1", content: "1 failing", is_error: true }]),
    row(5, "assistant", [{ type: "text", text: "Pagination is in." }]),
    row(60, "user", "Now document it"),
    row(61, "assistant", [{ type: "text", text: "Documented in the README." }]),
  ];
}

async function withServer(fn) {
  const home = mkTmp("tq-nav-");
  const path = join(home, ".claude/projects/proj/nav.jsonl");
  writeJsonl(path, recording());
  const old = new Date(Date.now() - 3600_000);
  utimesSync(path, old, old);
  const { child, base } = await serve(home);
  const browser = await PLAYWRIGHT.chromium.launch();
  try {
    await fn({ base, browser, path, hash: sessionHash(path) });
  } finally {
    await browser.close();
    if (child.exitCode == null && child.signalCode == null) {
      child.kill("SIGKILL");
      await new Promise((r) => child.once("exit", r));
    }
    rmSync(home, { recursive: true, force: true });
  }
}

async function openRunView(browser, base, hash, { width = 1280, query = "" } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 860 } });
  await page.goto(`${base}/run?session=${hash}${query}`);
  await page.waitForSelector("#chatThread .chat-user");
  return page;
}

const panelOpen = (page) => page.evaluate(() => !document.getElementById("runAnalytics").hidden);
const search = (page) => page.evaluate(() => location.search);
const focusedId = (page) => page.evaluate(() => document.activeElement && document.activeElement.id);

test("run view: one analytics control, and the full page carries the way back", SKIP_NO_PLAYWRIGHT, async () => {
  await withServer(async ({ base, browser, path, hash }) => {
    const page = await openRunView(browser, base, hash);
    assert.equal(await page.locator(".chat-top #analyticsToggle").count(), 1, "one analytics toggle");
    assert.equal(await page.locator(".chat-top .run-view-link, .chat-top a[href^='/view']").count(), 0, "no second analytics link in the header");
    assert.equal((await page.locator("#analyticsToggle").innerText()).trim(), "Analytics");
    const want = `/view?path=${encodeURIComponent(path)}&from=${encodeURIComponent(`/run?session=${hash}`)}`;
    assert.equal(await page.locator("#viewSessionLink").getAttribute("href"), want, "Open full page carries from=");
    assert.equal(await page.locator(".observer-btn", { hasText: "Open full session view" }).getAttribute("href"), want);
    await page.close();
  });
  // The launched-run chat (/run?id=) uses the same header and links its recording with from=.
  const html = runPage({ run: { id: "r9", agent: "claude", cwd: "/repo", startedAt: ts(0), status: "running", prompt: "x" } });
  assert.equal(html.match(/id="analyticsToggle"/g).length, 1);
  assert.doesNotMatch(html, /class="run-view-link"/);
  assert.match(html, /"&from=" \+ encodeURIComponent\("\/run\?id=" \+ runId\)/);
  assert.equal(html.match(/data-hotkey="a"/g).length, 1, "the toggle owns the A key");
});

test("run view: panel back paths — Back, Forward, close, Escape, toggle and A", SKIP_NO_PLAYWRIGHT, async () => {
  await withServer(async ({ base, browser, hash }) => {
    const page = await openRunView(browser, base, hash);
    const startLen = await page.evaluate(() => history.length);

    await page.click("#analyticsToggle");
    assert.equal(await panelOpen(page), true, "toggle opens the panel");
    assert.match(await search(page), /analytics=1/);
    assert.equal(await page.evaluate(() => history.length), startLen + 1, "opening adds one history entry");
    await page.frameLocator("#runAnalyticsFrame").locator(".header, .stats-bar").first().waitFor({ timeout: 15_000 });

    await page.goBack();
    await page.waitForFunction(() => document.getElementById("runAnalytics").hidden);
    assert.equal(new URL(page.url()).pathname, "/run", "Back stays on the run view");
    assert.doesNotMatch(await search(page), /analytics=/);
    assert.equal(await page.locator("#chatThread .chat-user").count() > 0, true, "the chat is still painted");

    await page.goForward();
    await page.waitForFunction(() => !document.getElementById("runAnalytics").hidden);
    assert.match(await search(page), /analytics=1/, "Forward reopens analytics");

    await page.click("#runAnalyticsClose");
    assert.equal(await panelOpen(page), false, "close control closes");
    await page.waitForFunction(() => !/analytics=/.test(location.search));
    assert.equal(await focusedId(page), "analyticsToggle", "focus returns to the toggle");

    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press("a");
    assert.equal(await panelOpen(page), true, "idle A opens the panel");
    await page.keyboard.press("Escape");
    assert.equal(await panelOpen(page), false, "Escape closes the panel");
    assert.equal(await focusedId(page), "analyticsToggle");

    await page.click("#analyticsToggle");
    assert.equal(await panelOpen(page), true);
    await page.click("#analyticsToggle");
    assert.equal(await panelOpen(page), false, "the toggle closes what it opened");
    await page.waitForFunction(() => !/analytics=/.test(location.search));

    // A typed "a" in a field is text, not the shortcut.
    await page.fill("#chatFind", "");
    await page.focus("#chatFind");
    await page.keyboard.type("a");
    assert.equal(await panelOpen(page), false, "A in the find box does not open analytics");
    await page.close();

    // A shared ?analytics=1 link opens in place without adding history.
    const plain = await openRunView(browser, base, hash);
    const plainLen = await plain.evaluate(() => history.length);
    await plain.close();
    const direct = await openRunView(browser, base, hash, { query: "&analytics=1" });
    assert.equal(await panelOpen(direct), true);
    assert.equal(await direct.evaluate(() => history.length), plainLen, "no extra entry for a direct ?analytics=1 load");
    await direct.close();
  });
});

test("run view: full page back paths — link, Escape, browser Back", SKIP_NO_PLAYWRIGHT, async () => {
  await withServer(async ({ base, browser, path, hash }) => {
    const page = await openRunView(browser, base, hash);
    const toFullPage = async () => {
      if (!(await panelOpen(page))) await page.click("#analyticsToggle");
      await Promise.all([page.waitForURL(/\/view\?/), page.click("#viewSessionLink")]);
      await page.waitForSelector("#chatBackLink");
    };

    await toFullPage();
    assert.equal((await page.locator("#chatBackLink").innerText()).trim(), "← Back to chat");
    assert.equal(await page.locator("#chatBackLink").getAttribute("href"), `/run?session=${hash}`);
    assert.match(await search(page), /[?&]from=/, "the page's own URL keeps from= so a reload keeps the way back");
    await Promise.all([page.waitForURL(/\/run\?session=/), page.click("#chatBackLink")]);
    await page.waitForSelector("#chatThread .chat-user");

    await toFullPage();
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press("j");
    await page.waitForSelector(".chapter.kb-focused");
    await page.keyboard.press("Escape");
    await pause(300);
    assert.match(page.url(), /\/view\?/, "the first Escape only clears the focused chapter");
    await Promise.all([page.waitForURL(/\/run\?session=/), page.keyboard.press("Escape")]);
    await page.waitForSelector("#chatThread .chat-user");

    await toFullPage();
    await page.goBack();
    await page.waitForURL(/\/run\?session=/);
    await page.waitForSelector("#chatThread .chat-user");
    assert.equal(new URL(page.url()).pathname, "/run", "browser Back lands on the run view");

    for (const from of ["https://example.com/run?session=x", "//example.com/run?session=x", "/sessions"]) {
      await page.goto(`${base}/view?path=${encodeURIComponent(path)}&from=${encodeURIComponent(from)}`);
      await page.waitForSelector(".header-back");
      assert.equal(await page.locator("#chatBackLink").count(), 0, `from=${from} is ignored`);
      assert.equal((await page.locator(".header-back").innerText()).trim(), "← Runs");
    }
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press("Escape");
    await pause(300);
    assert.match(page.url(), /\/view\?/, "without from=, Escape does not navigate");
    await page.close();
  });
});

test("run view: narrow analytics covers the chat and leads back to it", SKIP_NO_PLAYWRIGHT, async () => {
  await withServer(async ({ base, browser, hash }) => {
    const page = await openRunView(browser, base, hash, { width: 390 });
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok((await overflow()) <= 0, "run view does not scroll sideways at 390px");
    await page.click("#analyticsToggle");
    await page.frameLocator("#runAnalyticsFrame").locator(".header, .stats-bar").first().waitFor({ timeout: 15_000 });
    assert.equal(await page.locator(".chat-app").isVisible(), false, "the chat is covered, not squeezed");
    const box = await page.locator("#runAnalytics").boundingBox();
    assert.ok(box.width >= 389, `panel is full width (${box.width})`);
    assert.equal((await page.locator("#runAnalyticsClose").innerText()).trim(), "← Chat");
    assert.ok((await overflow()) <= 0, "open panel does not scroll sideways at 390px");
    await page.click("#runAnalyticsClose");
    assert.equal(await page.locator(".chat-app").isVisible(), true, "← Chat returns to the chat");
    await page.close();

    const wide = await openRunView(browser, base, hash, { width: 760 });
    await wide.click("#analyticsToggle");
    assert.equal(await wide.locator(".chat-app").isVisible(), false, "760px is still the covering layout");
    await wide.close();
  });
});

test("run view: loading and cheatsheet", SKIP_NO_PLAYWRIGHT, async () => {
  await withServer(async ({ base, browser, hash }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    let release;
    const held = new Promise((r) => { release = r; });
    await page.route(/\/api\/sessions\/live\?id=/, async (route) => { await held; await route.continue(); });
    await page.goto(`${base}/run?session=${hash}`);
    const marker = page.locator("#chatActivity .chat-loading");
    await marker.waitFor({ state: "visible" });
    assert.match(await marker.innerText(), /Loading conversation/);
    release();
    await page.waitForSelector("#chatThread .chat-user");
    await page.waitForFunction(() => !document.querySelector("#chatActivity .chat-loading"));

    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press("?");
    const sheet = page.locator("#shortcutCheatsheet");
    await sheet.waitFor({ state: "visible" });
    assert.match(await sheet.innerText(), /A\s+Show or hide analytics/);
    await page.close();
  });
});
