/**
 * Session flyout is a non-modal side panel: while it is open the Runs list
 * on the left stays clickable, scrollable and keyboard-reachable, and
 * picking another run there updates the open panel.
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;
const RUNS = 40;

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
    if (child.exitCode != null) throw new Error(`serve exited early (${child.exitCode})\nstderr: ${child._stderr}`);
    try {
      const status = await httpStatus(port, reqPath);
      if (status === 200) return;
      lastErr = new Error(`HTTP ${status} for ${reqPath}`);
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
  child._stderr = "";
  child.stdout.resume();
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { child._stderr += chunk; });
  return child;
}

async function stopServe(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  child.kill("SIGKILL");
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

function seedManyRuns() {
  const home = mkTmp("tracequest-flyout-nonmodal-");
  const proj = join(home, ".claude", "projects", "nonmodal-proj");
  mkdirSync(proj, { recursive: true });
  for (let i = 0; i < RUNS; i++) {
    const sid = `nonmodal-session-${String(i).padStart(2, "0")}`;
    const t = (s) => new Date(Date.UTC(2026, 5, 3, 10, i, s)).toISOString();
    writeJsonl(join(proj, `${sid}.jsonl`), [
      { type: "user", sessionId: sid, cwd: "/home/dev/tracequest", timestamp: t(0), message: { content: [{ type: "text", text: `nonmodal run prompt ${i}` }] } },
      {
        type: "assistant",
        sessionId: sid,
        timestamp: t(5),
        message: { model: "claude-sonnet-4-20250514", usage: { input_tokens: 100, output_tokens: 20 }, content: [{ type: "text", text: `Answer ${i}.` }] },
      },
    ]);
  }
  return home;
}

/** Scroll offset of the window plus every scrolled ancestor of the run list. */
function listScrollOffset(page) {
  return page.evaluate(() => {
    let total = window.scrollY;
    for (let n = document.getElementById("sessions"); n; n = n.parentElement) total += n.scrollTop;
    return total;
  });
}

const activeInFlyout = (page) => page.evaluate(() => document.getElementById("sessionFlyout").contains(document.activeElement));

describe("session-flyout non-modal playwright", SKIP_NO_PLAYWRIGHT, () => {
  test("open flyout leaves the Runs list clickable, scrollable and keyboard-reachable", async () => {
    const { chromium } = PLAYWRIGHT;
    const home = seedManyRuns();
    const port = await allocEphemeralPort();
    const child = spawnServe(port, home);
    const browser = await chromium.launch();
    try {
      await waitForHttp(port, "/sessions", child);
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
      await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("a.session-row");
      const rows = page.locator(".session-row-wrap");
      assert.ok(await rows.count() >= 20, "enough runs to scroll the list");

      const flyout = page.locator("#sessionFlyout");
      const title = page.locator("#sessionFlyoutTitle");
      const rowId = (i) => rows.nth(i).getAttribute("data-session-id");

      await rows.nth(0).locator("a.session-row").click();
      await flyout.waitFor({ state: "visible" });
      await page.frameLocator("#sessionFlyoutFrame").locator("#app").waitFor({ state: "visible", timeout: 15_000 });
      assert.equal(await title.textContent(), await rowId(0));

      assert.equal(
        await page.evaluate(() => !!document.getElementById("sessions").closest("[inert]")),
        false,
        "the run list is not inert behind the open panel",
      );
      assert.equal(await page.evaluate(() => document.getElementById("sessionFlyout").getAttribute("aria-modal")), null);

      // Keyboard: Shift+Tab from the panel's first control leaves the panel.
      assert.equal(await activeInFlyout(page), true, "opening moves focus into the panel");
      await page.keyboard.press("Shift+Tab");
      assert.equal(await activeInFlyout(page), false, "Shift+Tab is not trapped inside the panel");

      // Scroll the list with the wheel while the panel stays open.
      const before = await listScrollOffset(page);
      const box = await page.locator("#sessions").boundingBox();
      await page.mouse.move(box.x + box.width / 2, Math.min(box.y + 200, 700));
      await page.mouse.wheel(0, 900);
      await page.waitForFunction((b) => {
        let total = window.scrollY;
        for (let n = document.getElementById("sessions"); n; n = n.parentElement) total += n.scrollTop;
        return total > b;
      }, before, { timeout: 5_000 });
      assert.equal(await flyout.isVisible(), true, "scrolling the list keeps the panel open");

      // Click another run on the left: the open panel follows it.
      const target = 15;
      await rows.nth(target).locator("a.session-row").click({ timeout: 5_000 });
      const targetId = await rowId(target);
      await page.waitForFunction((id) => document.getElementById("sessionFlyoutTitle").textContent === id, targetId);
      assert.equal(await flyout.isVisible(), true);
      assert.match(page.url(), new RegExp(`[?&]session=${targetId}\\b`));
      assert.equal(await page.locator(".session-row-wrap.is-selected").getAttribute("data-session-id"), targetId);
      await page.frameLocator("#sessionFlyoutFrame").locator("#app").waitFor({ state: "visible", timeout: 15_000 });

      // Keyboard: Tab from that row to the next run's link and open it with Enter.
      const nextId = await rowId(target + 1);
      let reached = false;
      for (let i = 0; i < 20 && !reached; i++) {
        await page.keyboard.press("Tab");
        reached = await page.evaluate((id) => {
          const a = document.activeElement;
          const wrap = a && a.matches("a.session-row") && a.closest(".session-row-wrap");
          return !!wrap && wrap.getAttribute("data-session-id") === id;
        }, nextId);
      }
      assert.ok(reached, "Tab reaches the next run's link on the left");
      await page.keyboard.press("Enter");
      await page.waitForFunction((id) => document.getElementById("sessionFlyoutTitle").textContent === id, nextId);

      // Escape with focus on the left still closes the panel.
      await page.keyboard.press("Escape");
      await flyout.waitFor({ state: "hidden" });
      assert.doesNotMatch(page.url(), /[?&]session=/);

      // Escape from inside the panel's analytics frame closes it too.
      await rows.nth(2).locator("a.session-row").click();
      await flyout.waitFor({ state: "visible" });
      const frame = page.frameLocator("#sessionFlyoutFrame");
      await frame.locator("#app").waitFor({ state: "visible", timeout: 15_000 });
      await frame.locator("body").click({ position: { x: 5, y: 5 } });
      await page.keyboard.press("Escape");
      await flyout.waitFor({ state: "hidden" });

      // Close button still closes it.
      await rows.nth(3).locator("a.session-row").click();
      await flyout.waitFor({ state: "visible" });
      await page.locator("#sessionFlyoutClose").click();
      await flyout.waitFor({ state: "hidden" });
    } finally {
      await browser.close();
      await stopServe(child);
      rmSync(home, { recursive: true, force: true });
    }
  });
});
