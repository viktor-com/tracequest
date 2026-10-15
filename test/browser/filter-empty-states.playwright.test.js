/**
 * Filter interaction and empty states: a chapter search that hides every
 * chapter explains itself and offers a reset; an open toolbar menu does not
 * block the sibling toolbar buttons under a real pointer click.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { createServer } from "node:http";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkTmp, writeJsonl } from "../helpers/fixtures.js";
import { PLAYWRIGHT, SKIP_NO_PLAYWRIGHT } from "../helpers/playwright-gate.js";
import { sessionHash } from "../../src/sessions/session-hash.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;

function allocEphemeralPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function httpStatus(port, reqPath) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}${reqPath}`, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      })
      .on("error", reject);
  });
}

async function waitForHttp(port, reqPath, child, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`serve exited early (${child.exitCode})\nstdout: ${child._stdout}\nstderr: ${child._stderr}`);
    }
    try {
      if ((await httpStatus(port, reqPath)) === 200) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw lastErr ?? new Error(`timed out waiting for ${reqPath}`);
}

function spawnServe(port, home) {
  const child = spawn(NODE, [BIN, "serve", "--port", String(port)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: home,
      TRACEQUEST_LIVE_SESSIONS_HOME: home,
      TRACEQUEST_NO_SIDECAR: "1",
      TRACEQUEST_SKIP_TMUX: "1",
      TRACEQUEST_TMUX_BIN: "/nonexistent-tracequest-tmux",
      TRACEQUEST_SKIP_LR_WATCH: "1",
    },
  });
  child._stdout = "";
  child._stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { child._stdout += chunk; });
  child.stderr.on("data", (chunk) => { child._stderr += chunk; });
  return child;
}

async function stopServe(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  child.kill("SIGKILL");
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function seedHome() {
  const home = mkTmp("tracequest-filter-empty-");
  const proj = join(home, ".claude", "projects", "filter-empty-proj");
  mkdirSync(proj, { recursive: true });
  const sessionPath = join(proj, "filter-empty-session.jsonl");
  const sid = "filter-empty-session-aaaa";
  const assistant = (ts, text) => ({
    type: "assistant",
    sessionId: sid,
    timestamp: ts,
    message: {
      model: "claude-sonnet-4-20250514",
      usage: { input_tokens: 100, output_tokens: 30 },
      content: [{ type: "text", text }],
    },
  });
  writeJsonl(sessionPath, [
    {
      type: "user",
      sessionId: sid,
      cwd: "/home/dev/tracequest",
      timestamp: "2026-06-03T10:00:00.000Z",
      message: { content: [{ type: "text", text: "first chapter about the parser" }] },
    },
    assistant("2026-06-03T10:00:05.000Z", "Parser looks fine."),
    {
      type: "user",
      sessionId: sid,
      timestamp: "2026-06-03T10:07:00.000Z",
      message: { content: [{ type: "text", text: "second chapter about the renderer" }] },
    },
    assistant("2026-06-03T10:07:04.000Z", "Renderer looks fine."),
  ]);
  return { home, sessionId: sessionHash(sessionPath) };
}

async function withServe(fn) {
  const { chromium } = PLAYWRIGHT;
  const { home, sessionId } = seedHome();
  const port = await allocEphemeralPort();
  const child = spawnServe(port, home);
  const browser = await chromium.launch();
  try {
    await waitForHttp(port, "/sessions", child);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await fn({ page, base: `http://127.0.0.1:${port}`, sessionId });
  } finally {
    await browser.close();
    await stopServe(child);
    rmSync(home, { recursive: true, force: true });
  }
}

async function pointerClick(page, selector) {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box, `${selector} has a box`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

describe("filter interaction and empty states playwright", SKIP_NO_PLAYWRIGHT, () => {
  test("chapter search with no match explains the empty list and Clear filters resets it", async () => {
    await withServe(async ({ page, base, sessionId }) => {
      await page.goto(`${base}/view?id=${sessionId}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#chapter-1");
      const empty = page.locator(".chapters-filter-empty");
      assert.equal(await empty.isVisible(), false, "no empty state before filtering");

      await page.fill(".filter-search", "audit-no-such-term");
      await empty.waitFor({ state: "visible", timeout: 5_000 });
      assert.equal(await page.locator(".chapter:not(.filter-hidden)").count(), 0, "every chapter is hidden");
      assert.match(await empty.innerText(), /No chapters match/);
      assert.match(await empty.innerText(), /audit-no-such-term/);

      const clear = empty.getByRole("button", { name: "Clear filters" });
      await clear.click();
      await empty.waitFor({ state: "hidden", timeout: 5_000 });
      assert.equal(await page.inputValue(".filter-search"), "", "search box emptied");
      assert.equal(await page.locator(".chapter:not(.filter-hidden)").count(), 2, "every chapter is back");
      assert.equal((await page.textContent("#filter-count")).trim(), "", "count label cleared");
    });
  });

  test("Display open: a pointer click on a sibling toolbar button switches or closes the menu", async () => {
    await withServe(async ({ page, base }) => {
      await page.goto(`${base}/sessions`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("a.session-row");
      const sortBar = page.locator("#sortBar");
      const ageMenu = page.locator("#ageMenu");

      await page.click("#displayToggle");
      await sortBar.waitFor({ state: "visible" });
      assert.equal(
        await page.evaluate(() => !!document.querySelector("a.session-row").closest("[inert]")),
        true,
        "session rows stay inert behind the open menu",
      );

      await pointerClick(page, "#ageBtn");
      await ageMenu.waitFor({ state: "visible", timeout: 2_000 });
      assert.equal(await sortBar.isHidden(), true, "Display closed when Time range opened");
      assert.equal(await page.getAttribute("#ageBtn", "aria-expanded"), "true");
      assert.equal(await page.getAttribute("#displayToggle", "aria-expanded"), "false");

      await page.keyboard.press("Escape");
      await ageMenu.waitFor({ state: "hidden", timeout: 2_000 });
      assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "ageBtn",
        "Escape returns focus to the Time range button, not Display");
      await pointerClick(page, "#ageBtn");
      await ageMenu.waitFor({ state: "visible", timeout: 2_000 });

      await pointerClick(page, "#displayToggle");
      await sortBar.waitFor({ state: "visible", timeout: 2_000 });
      assert.equal(await ageMenu.isHidden(), true, "Time range closed when Display opened");

      await pointerClick(page, "#displayToggle");
      await sortBar.waitFor({ state: "hidden", timeout: 2_000 });
      assert.equal(await page.getAttribute("#displayToggle", "aria-expanded"), "false");
      assert.equal(
        await page.evaluate(() => !!document.querySelector("a.session-row").closest("[inert]")),
        false,
        "page is interactive again once the menu closes",
      );
    });
  });
});
