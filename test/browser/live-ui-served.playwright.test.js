/**
 * Served-browser live UI coverage: real tracequest serve + headless Chromium.
 * The live session is detected via the open-fd path used for Codex/Factory sessions.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { createServer } from "node:http";
import { closeSync, mkdirSync, openSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkTmp, writeJsonl, writeJsonlSynced } from "../helpers/fixtures.js";
import { PLAYWRIGHT, SKIP_NO_PLAYWRIGHT } from "../helpers/playwright-gate.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;
const LIVE_PROMPT = "served browser live prompt marker";
const SSE_LIVE_PROMPT = "served browser SSE live prompt marker";

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

function spawnServe(port, home, { enableWatchers = false } = {}) {
  const env = {
    ...process.env,
    HOME: home,
    TRACEQUEST_LIVE_SESSIONS_HOME: home,
    TRACEQUEST_NO_SIDECAR: "1",
    TRACEQUEST_SKIP_TMUX: "1",
    // The dashboard now lists launched runs from /api/runs — point the serve
    // child at a nonexistent tmux so the developer's real runs never leak
    // into this test's Agents strip.
    TRACEQUEST_TMUX_BIN: "/nonexistent-tracequest-tmux",
  };
  if (enableWatchers) {
    delete env.TRACEQUEST_SKIP_LR_WATCH;
  } else {
    env.TRACEQUEST_SKIP_LR_WATCH = "1";
  }

  const child = spawn(NODE, [BIN, "serve", "--port", String(port)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env,
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

async function withServe(home, fn, opts = {}) {
  const port = await allocEphemeralPort();
  const child = spawnServe(port, home, opts);
  try {
    await waitForHttp(port, "/api/sessions", child);
    await fn(`http://127.0.0.1:${port}/`);
  } finally {
    await stopServe(child);
  }
}

function seedLiveCodexHome() {
  const home = mkTmp("tracequest-live-ui-served-");
  const codexDir = join(home, ".codex", "sessions", "2026", "06", "03");
  mkdirSync(codexDir, { recursive: true });
  const codexPath = join(codexDir, "rollout-live-ui-served.jsonl");
  writeJsonl(codexPath, [
    {
      type: "session_meta",
      payload: {
        id: "live-ui-served-codex",
        cwd: "/home/dev/live-ui-served",
        model_provider: "gpt-5-codex",
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-06-03T12:00:00.000Z",
      payload: { type: "user_message", message: LIVE_PROMPT },
    },
    {
      type: "event_msg",
      timestamp: "2026-06-03T12:00:01.000Z",
      payload: { type: "task_started", turn_id: "turn-live" },
    },
    {
      type: "response_item",
      timestamp: "2026-06-03T12:00:05.000Z",
      payload: {
        role: "assistant",
        content: [{ type: "output_text", text: "served live browser response" }],
      },
    },
  ]);
  return { home, codexPath };
}

function seedEmptyLiveCodexHome() {
  const home = mkTmp("tracequest-live-ui-sse-served-");
  const codexDir = join(home, ".codex", "sessions", "2026", "06", "03");
  mkdirSync(codexDir, { recursive: true });
  return { home, codexDir };
}

function liveCodexLines({ id, prompt, cwd }) {
  return [
    {
      type: "session_meta",
      payload: {
        id,
        cwd,
        model_provider: "gpt-5-codex",
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-06-03T12:00:00.000Z",
      payload: { type: "user_message", message: prompt },
    },
    {
      type: "event_msg",
      timestamp: "2026-06-03T12:00:01.000Z",
      payload: { type: "task_started", turn_id: "turn-live" },
    },
    {
      type: "response_item",
      timestamp: "2026-06-03T12:00:05.000Z",
      payload: {
        role: "assistant",
        content: [{ type: "output_text", text: "served browser SSE live response" }],
      },
    },
  ];
}

function writeLiveCodexSession(codexDir) {
  const codexPath = join(codexDir, "rollout-live-ui-sse-served.jsonl");
  writeJsonlSynced(codexPath, liveCodexLines({
    id: "live-ui-sse-served-codex",
    cwd: "/home/dev/live-ui-sse-served",
    prompt: SSE_LIVE_PROMPT,
  }));
  return codexPath;
}

describe("served browser live UI", () => {
  test(
    "initial page and refresh render the external live session as ONE unified live row",
    SKIP_NO_PLAYWRIGHT,
    async () => {
      const { chromium } = PLAYWRIGHT;
      const { home, codexPath } = seedLiveCodexHome();
      const fd = openSync(codexPath, "r");
      try {
        await withServe(home, async (url) => {
          const browser = await chromium.launch({ headless: true });
          try {
            const page = await browser.newPage();
            await page.goto(`${url}sessions`, { waitUntil: "load" });

            // The external live session is a first-class live row with the
            // unified vocabulary — same treatment as a run row.
            const liveRow = page.locator('.run-row[data-run-origin="external"]', { hasText: LIVE_PROMPT }).first();
            await liveRow.waitFor({ timeout: 15_000 });
            assert.match(await liveRow.getAttribute("data-href"), /^\/run\?session=[0-9a-f]{8}$/);
            await liveRow.locator('.run-state-badge[data-status="running"]', { hasText: "running" }).waitFor();
            await liveRow.locator(".run-origin", { hasText: "external" }).waitFor();

            // ONE object: no separate Live strip, no duplicate session row.
            assert.equal(await page.locator("#liveBar").count(), 0, "separate Live strip is gone");
            assert.equal(
              await page.locator(".session-row-wrap", { hasText: LIVE_PROMPT }).count(),
              1,
              "the live session appears exactly once",
            );

            const refreshResponse = page.waitForResponse((res) => {
              return res.url().includes("/api/sessions") && res.status() === 200;
            });
            await page.evaluate(() => window._refreshData());
            await refreshResponse;

            await page.locator('.run-row[data-run-origin="external"]', { hasText: LIVE_PROMPT }).first().waitFor();
            assert.equal(
              await page.locator(".session-row-wrap", { hasText: LIVE_PROMPT }).count(),
              1,
              "still one object after refresh",
            );
          } finally {
            await browser.close();
          }
        });
      } finally {
        closeSync(fd);
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  test(
    "data-update SSE refreshes the open page without direct refresh invocation",
    SKIP_NO_PLAYWRIGHT,
    async () => {
      const { chromium } = PLAYWRIGHT;
      const { home, codexDir } = seedEmptyLiveCodexHome();
      let liveFd = null;
      try {
        await withServe(home, async (url) => {
          const browser = await chromium.launch({ headless: true });
          try {
            const page = await browser.newPage();
            const sseConnected = page.waitForResponse((res) => {
              return res.url().includes("/__livereload") && res.status() === 200;
            });
            await page.goto(`${url}sessions`, { waitUntil: "load" });
            await sseConnected;

            assert.equal(
              await page.locator(".session-row-wrap", { hasText: SSE_LIVE_PROMPT }).count(),
              0,
            );

            const refreshResponse = page.waitForResponse((res) => {
              return res.url().includes("/api/sessions") && res.status() === 200;
            }, { timeout: 25_000 });
            const codexPath = writeLiveCodexSession(codexDir);
            liveFd = openSync(codexPath, "r");
            const response = await refreshResponse;
            const data = await response.json();
            assert.equal(data.total, 1);
            assert.match(data.sessions[0].prompt, new RegExp(SSE_LIVE_PROMPT));
            assert.equal(data.sessions[0].live, true);
            assert.equal(data.liveSessions.length, 1);

            const liveRow = page.locator('.run-row[data-run-origin="external"]', { hasText: SSE_LIVE_PROMPT }).first();
            await liveRow.waitFor({ timeout: 15_000 });
            assert.match(await liveRow.getAttribute("data-href"), /^\/run\?session=[0-9a-f]{8}$/);
            await liveRow.locator('.run-state-badge[data-status="running"]', { hasText: "running" }).waitFor();
            assert.equal(
              await page.locator(".session-row-wrap", { hasText: SSE_LIVE_PROMPT }).count(),
              1,
              "the live session appears exactly once — absorbed, no strip",
            );
          } finally {
            await browser.close();
          }
        }, { enableWatchers: true });
      } finally {
        if (liveFd != null) closeSync(liveFd);
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
});
