/**
 * Analytics panel on the chat home: opening analytics for the current
 * run keeps the conversation + sidebar and shows existing /view
 * analytics in a right-hand panel.
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
const PROMPT = "analytics panel chat-home prompt";

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

function seedAnalyticsHome() {
  const home = mkTmp("tracequest-analytics-panel-");
  const proj = join(home, ".claude", "projects", "analytics-proj");
  mkdirSync(proj, { recursive: true });
  const sessionPath = join(proj, "analytics-session.jsonl");
  writeJsonl(sessionPath, [
    {
      type: "user",
      sessionId: "analytics-session-aaaa",
      cwd: "/home/dev/tracequest",
      timestamp: "2026-06-03T10:00:00.000Z",
      message: { content: [{ type: "text", text: PROMPT }] },
    },
    {
      type: "assistant",
      sessionId: "analytics-session-aaaa",
      timestamp: "2026-06-03T10:00:05.000Z",
      message: {
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 220, output_tokens: 80 },
        content: [
          { type: "text", text: "I will inspect the analytics panel." },
          { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "false" } },
        ],
      },
    },
    {
      type: "user",
      sessionId: "analytics-session-aaaa",
      timestamp: "2026-06-03T10:00:08.000Z",
      message: {
        content: [{ type: "tool_result", tool_use_id: "bash-1", content: "command failed", is_error: true }],
      },
    },
    {
      type: "assistant",
      sessionId: "analytics-session-aaaa",
      timestamp: "2026-06-03T10:00:10.000Z",
      message: {
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 240, output_tokens: 40 },
        content: [{ type: "text", text: "Recovered after the error." }],
      },
    },
    {
      type: "user",
      sessionId: "analytics-session-aaaa",
      timestamp: "2026-06-03T10:07:00.000Z",
      message: { content: [{ type: "text", text: "second chapter for analytics chapters list" }] },
    },
    {
      type: "assistant",
      sessionId: "analytics-session-aaaa",
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

describe("analytics-panel playwright", SKIP_NO_PLAYWRIGHT, () => {
  test("analytics-panel playwright: chat + sidebar stay while /view analytics dock on the right", async () => {
    const { chromium } = PLAYWRIGHT;
    const { home, sessionId } = seedAnalyticsHome();
    const port = await allocEphemeralPort();
    const child = spawnServe(port, home);
    const browser = await chromium.launch();
    try {
      await waitForHttp(port, "/", child);
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        colorScheme: "dark",
      });
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("main.chat-app");
      await page.waitForSelector("#analyticsToggle");

      const rail = page.locator("aside.agent-rail");
      const chat = page.locator("main.chat-app");
      const composer = page.locator(".chat-composer");
      const panel = page.locator("#runAnalytics");

      assert.equal(await rail.isVisible(), true, "sidebar stays on /");
      assert.equal(await chat.isVisible(), true, "chat stays on /");
      assert.equal(await composer.isVisible(), true, "composer stays on /");
      assert.equal(await panel.isHidden(), true, "analytics starts closed");
      assert.doesNotMatch(page.url(), /\/view\?/);

      await page.locator("#analyticsToggle").click();
      await panel.waitFor({ state: "visible" });

      assert.equal(await rail.isVisible(), true, "sidebar stays after opening analytics");
      assert.equal(await chat.isVisible(), true, "chat stays after opening analytics");
      assert.equal(await composer.isVisible(), true, "composer stays after opening analytics");
      assert.match(page.url(), /[?&]analytics=1/);
      assert.doesNotMatch(page.url(), /\/view\?/);

      const boxes = await page.evaluate(() => {
        const railBox = document.querySelector("aside.agent-rail").getBoundingClientRect();
        const chatBox = document.querySelector("main.chat-app").getBoundingClientRect();
        const panelBox = document.getElementById("runAnalytics").getBoundingClientRect();
        return {
          rail: { x: railBox.x, right: railBox.right, width: railBox.width },
          chat: { x: chatBox.x, right: chatBox.right, width: chatBox.width },
          panel: { x: panelBox.x, right: panelBox.right, width: panelBox.width },
          vw: window.innerWidth,
        };
      });
      assert.ok(boxes.rail.width > 200, "sidebar still has readable width");
      assert.ok(boxes.chat.width > 280, "chat still has readable width");
      assert.ok(boxes.panel.width > 360, "analytics is a substantial RHS panel");
      assert.ok(boxes.rail.x < boxes.chat.x, "sidebar sits left of chat");
      assert.ok(boxes.chat.x < boxes.panel.x, "analytics sits to the right of chat");
      assert.ok(boxes.chat.right <= boxes.panel.x + 2, "chat does not run under the panel");
      assert.ok(boxes.panel.right > boxes.vw - 8, "analytics docks to the right edge");

      const frame = page.frameLocator("#runAnalyticsFrame");
      await frame.locator("#app").waitFor({ state: "visible", timeout: 15_000 });
      await frame.locator(".header, .session-summary, .stats-bar").first().waitFor({ state: "visible" });
      assert.ok(await frame.locator(".session-summary, .stats-bar").count() > 0, "panel shows grade/tiles");
      assert.ok(await frame.locator(".activity-timeline, .waveform-wrap").count() > 0, "panel shows timeline/charts");
      assert.ok(await frame.locator(".chapters, .chapter").count() > 0, "panel includes chapters");
      assert.equal(await frame.locator("body.embed-view").count(), 1, "embedded /view uses body.embed-view");

      await page.locator("#runAnalyticsClose").click();
      await panel.waitFor({ state: "hidden" });
      assert.equal(await rail.isVisible(), true);
      assert.equal(await chat.isVisible(), true);
      assert.doesNotMatch(page.url(), /[?&]analytics=/);
      assert.ok(sessionId);
    } finally {
      await browser.close();
      await stopServe(child);
      rmSync(home, { recursive: true, force: true });
    }
  });
});
