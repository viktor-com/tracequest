/**
 * Session flyout: selecting a run on / keeps the inventory visible and
 * presents existing /view analytics in a right-hand panel.
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
const FLYOUT_PROMPT = "session flyout analytics prompt";

function listenOnEphemeralPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

async function allocEphemeralPort() {
  const { server, port } = await listenOnEphemeralPort();
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  return port;
}

function httpGet(port, reqPath) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}${reqPath}`, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode }));
      })
      .on("error", reject);
  });
}

async function waitForHttp(port, reqPath, child, { timeoutMs = 15_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`serve exited early (${child.exitCode})\nstdout: ${child._stdout}\nstderr: ${child._stderr}`);
    }
    try {
      const res = await httpGet(port, reqPath);
      if (res.status === 200) return;
      lastErr = new Error(`HTTP ${res.status} for ${reqPath}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
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
  if (child.exitCode == null && !child.killed) child.kill("SIGKILL");
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function seedFlyoutHome() {
  const home = mkTmp("tracequest-session-flyout-");
  const proj = join(home, ".claude", "projects", "flyout-proj");
  mkdirSync(proj, { recursive: true });
  const sessionPath = join(proj, "flyout-session.jsonl");
  writeJsonl(sessionPath, [
    {
      type: "user",
      sessionId: "flyout-session-aaaa",
      cwd: "/home/dev/tracequest",
      timestamp: "2026-06-03T10:00:00.000Z",
      message: { content: [{ type: "text", text: FLYOUT_PROMPT }] },
    },
    {
      type: "assistant",
      sessionId: "flyout-session-aaaa",
      timestamp: "2026-06-03T10:00:05.000Z",
      message: {
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 220, output_tokens: 80 },
        content: [
          { type: "text", text: "I will inspect the flyout analytics." },
          { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "/repo/docs/ui.md" } },
        ],
      },
    },
    {
      type: "user",
      sessionId: "flyout-session-aaaa",
      timestamp: "2026-06-03T10:00:08.000Z",
      message: {
        content: [{ type: "tool_result", tool_use_id: "read-1", content: "guidelines" }],
      },
    },
    {
      type: "assistant",
      sessionId: "flyout-session-aaaa",
      timestamp: "2026-06-03T10:00:10.000Z",
      message: {
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 240, output_tokens: 40 },
        content: [{ type: "text", text: "Analytics summary ready." }],
      },
    },
    {
      type: "user",
      sessionId: "flyout-session-aaaa",
      timestamp: "2026-06-03T10:07:00.000Z",
      message: { content: [{ type: "text", text: "second chapter for flyout chapters list" }] },
    },
    {
      type: "assistant",
      sessionId: "flyout-session-aaaa",
      timestamp: "2026-06-03T10:07:04.000Z",
      message: {
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 100, output_tokens: 30 },
        content: [{ type: "text", text: "Chapter two." }],
      },
    },
  ]);
  return { home, sessionPath, sessionId: sessionHash(sessionPath) };
}

describe("session-flyout playwright", SKIP_NO_PLAYWRIGHT, () => {
  test("opening a session keeps the Runs list and shows /view analytics in a RHS flyout", async () => {
    const { chromium } = PLAYWRIGHT;
    const { home, sessionId } = seedFlyoutHome();
    const port = await allocEphemeralPort();
    const child = spawnServe(port, home);
    const browser = await chromium.launch();
    try {
      await waitForHttp(port, "/sessions", child);
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        colorScheme: "light",
      });
      await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("a.session-row");

      const inventory = page.locator("#sessions");
      const flyout = page.locator("#sessionFlyout");
      assert.equal(await inventory.isVisible(), true, "Runs inventory is on /sessions");
      assert.equal(await flyout.isHidden(), true, "flyout starts closed");
      assert.match(page.url(), /\/sessions(?:\?|$)/);

      await page.locator("a.session-row").first().click();
      await flyout.waitFor({ state: "visible" });

      assert.equal(await inventory.isVisible(), true, "inventory stays after select");
      assert.equal(await page.locator(".runs-title").isVisible(), true);
      assert.equal(await page.locator("#runsToolbar").isVisible(), true);
      assert.equal(await page.locator(".runs-inventory").isVisible(), true);
      assert.match(page.url(), new RegExp(`[?&]session=${sessionId}\\b`));
      assert.doesNotMatch(page.url(), /\/view\?/);

      const boxes = await page.evaluate(() => {
        const list = document.querySelector(".runs-inventory").getBoundingClientRect();
        const panel = document.getElementById("sessionFlyout").getBoundingClientRect();
        return {
          list: { x: list.x, right: list.right, width: list.width, top: list.top },
          panel: { x: panel.x, right: panel.right, width: panel.width, top: panel.top },
          vw: window.innerWidth,
        };
      });
      assert.ok(boxes.list.width > 240, "inventory still has readable width");
      assert.ok(boxes.panel.width > 400, "flyout is a substantial RHS panel");
      assert.ok(boxes.panel.x > boxes.list.x, "flyout sits to the right of the inventory");
      assert.ok(boxes.list.right <= boxes.panel.x + 2, "inventory does not run under the flyout");
      assert.ok(boxes.panel.right > boxes.vw - 8, "flyout docks to the right edge");

      const frame = page.frameLocator("#sessionFlyoutFrame");
      await frame.locator("#app").waitFor({ state: "visible", timeout: 15_000 });
      await frame.locator(".header, .session-summary, .stats-bar").first().waitFor({ state: "visible" });
      assert.ok(await frame.locator(".header").count() > 0, "flyout has session header");
      assert.ok(
        (await frame.locator(".session-summary, .stats-bar, .waveform-wrap, .chapters").count()) > 0,
        "flyout shows existing /view analytics",
      );
      assert.ok(await frame.locator(".chapters, .chapter").count() > 0, "flyout includes chapters");
      assert.equal(await frame.locator("body.embed-view").count(), 1, "embedded /view uses body.embed-view");

      const selected = page.locator(".session-row-wrap.is-selected");
      assert.equal(await selected.count(), 1);

      await page.locator("#sessionFlyoutClose").click();
      await flyout.waitFor({ state: "hidden" });
      assert.equal(await inventory.isVisible(), true);
      assert.doesNotMatch(page.url(), /[?&]session=/);
      assert.equal(await page.locator(".session-row-wrap.is-selected").count(), 1, "closing peek leaves the list cursor");
    } finally {
      await browser.close();
      await stopServe(child);
      rmSync(home, { recursive: true, force: true });
    }
  });
});
