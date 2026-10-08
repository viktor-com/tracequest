/**
 * Automated harness for tests/preset-integration.md — CLI preset end-to-end scenarios.
 * Real bin/tracequest.js serve invocations; isolated HOME; HTTP probes on preset ports.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { createServer } from "node:http";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAUDE_FIXTURE_CWD,
  CLAUDE_FIXTURE_MODEL,
  mkTmp,
  writeClaudeJsonl,
} from "../helpers/fixtures.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;

/** @type {import("node:child_process").ChildProcess[]} */
const serveChildren = [];

afterEach(async () => {
  while (serveChildren.length) {
    await stopServe(serveChildren.pop());
  }
  await new Promise((r) => setTimeout(r, 150));
});

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function minimalClaudeSession(sessionId, { prompt = "preset integration prompt" } = {}) {
  const ts = "2026-06-03T12:00:00.000Z";
  return [
    {
      type: "user",
      sessionId,
      cwd: CLAUDE_FIXTURE_CWD,
      timestamp: ts,
      uuid: `u-${sessionId}`,
      isMeta: false,
      message: { content: [{ type: "text", text: prompt }] },
    },
    {
      type: "assistant",
      sessionId,
      timestamp: ts,
      uuid: `a-${sessionId}`,
      message: {
        model: CLAUDE_FIXTURE_MODEL,
        content: [{ type: "text", text: "preset integration reply" }],
      },
    },
  ];
}

function seedClaudeProject(home, projectName, fileName, lines) {
  const dir = join(home, ".claude", "projects", projectName);
  mkdirSync(dir, { recursive: true });
  return writeClaudeJsonl(dir, fileName, lines);
}

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

function assertPortBindable(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });
}

function httpGet(port, reqPath) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}${reqPath}`, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      })
      .on("error", reject);
  });
}

async function waitForHttp(port, reqPath, { expectedStatus = 200, timeoutMs = 15_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await httpGet(port, reqPath);
      if (res.status === expectedStatus) return res;
      lastErr = new Error(`HTTP ${res.status} for ${reqPath}, expected ${expectedStatus}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw lastErr ?? new Error(`timed out waiting for ${reqPath}`);
}

function spawnServeWithPreset(preset, home, { port } = {}) {
  const args = ["serve", "--preset", preset];
  if (port != null) args.push("--port", String(port));
  const child = spawn(NODE, [BIN, ...args], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: home,
      TRACEQUEST_NO_SIDECAR: "1",
      TRACEQUEST_SKIP_TMUX: "1",
      TRACEQUEST_SKIP_LR_WATCH: "1",
    },
  });
  serveChildren.push(child);
  return child;
}

function waitForChildExit(child, { timeoutMs = 5_000 } = {}) {
  if (child.exitCode != null || child.killed) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode == null && !child.killed) child.kill("SIGKILL");
      resolve();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function stopServe(child) {
  if (child.exitCode == null && !child.killed) {
    child.kill("SIGKILL");
  }
  await waitForChildExit(child, { timeoutMs: 2_000 });
}

function rmHomeDir(home) {
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

async function waitForServeReady(child, { untilStdout, timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let stdout = "";
  let stderr = "";
  return new Promise((resolve, reject) => {
    const onDataOut = (d) => {
      stdout += d;
      if (untilStdout && untilStdout.test(stdout)) {
        cleanup();
        resolve({ stdout, stderr, reason: "ready" });
      }
    };
    const onDataErr = (d) => {
      stderr += d;
    };
    const onExit = (code) => {
      cleanup();
      resolve({ stdout, stderr, reason: "exit", code });
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`serve did not become ready within ${timeoutMs}ms\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      child.stdout.off("data", onDataOut);
      child.stderr.off("data", onDataErr);
      child.off("exit", onExit);
    }

    child.stdout.on("data", onDataOut);
    child.stderr.on("data", onDataErr);
    child.once("exit", onExit);

    if (!untilStdout) {
      const poll = setInterval(() => {
        if (Date.now() > deadline) return;
        if (stdout.includes("http://localhost:")) {
          clearInterval(poll);
          cleanup();
          resolve({ stdout, stderr, reason: "ready" });
        }
      }, 50);
      timer.unref?.();
    }
  });
}

async function assertServeOnPresetPort(preset, expectedPort) {
  const home = mkTmp(`tracequest-preset-${preset}-`);
  seedClaudeProject(home, "preset-integ", "sess.jsonl", minimalClaudeSession(`preset-${preset}`));
  const child = spawnServeWithPreset(preset, home);
  let bindable = false;
  try {
    await assertPortBindable(expectedPort);
    bindable = true;
  } catch {
    bindable = false;
  }

  try {
    const { stdout, stderr, reason, code } = await waitForServeReady(child, {
      untilStdout: new RegExp(String(expectedPort)),
    });
    const combined = stripAnsi(stdout + stderr);

    if (reason === "exit" && code === 1 && /already in use/.test(combined)) {
      assert.match(combined, new RegExp(String(expectedPort)));
      return;
    }

    assert.match(stdout, new RegExp(`http://localhost:${expectedPort}`));

    if (bindable) {
      const res = await waitForHttp(expectedPort, "/api/sessions");
      const payload = JSON.parse(res.body);
      assert.ok(Array.isArray(payload.sessions));
      assert.ok(payload.sessions.length >= 1);
      assert.equal(payload.sessions[0].source, "claude");
    }
  } finally {
    await stopServe(child);
    rmHomeDir(home);
  }
}

describe("tests/preset-integration.md harness", () => {
  test("Test 1: serve --preset local binds port 8888", async () => {
    await assertServeOnPresetPort("local", 8888);
  });

  test("Test 2: serve --preset default binds port 7777", async () => {
    await assertServeOnPresetPort("default", 7777);
  });

  test("Test 3: CLI --port overrides preset local port", async () => {
    const home = mkTmp("tracequest-preset-override-");
    seedClaudeProject(home, "preset-override", "sess.jsonl", minimalClaudeSession("preset-override"));
    const port = await allocEphemeralPort();
    const child = spawnServeWithPreset("local", home, { port });
    try {
      const { stdout } = await waitForServeReady(child, {
        untilStdout: new RegExp(String(port)),
      });
      assert.match(stdout, new RegExp(`http://localhost:${port}`));
      assert.doesNotMatch(stdout, /http:\/\/localhost:8888/);

      const res = await waitForHttp(port, "/api/sessions");
      const payload = JSON.parse(res.body);
      assert.ok(payload.sessions.length >= 1);
    } finally {
      await stopServe(child);
      rmHomeDir(home);
    }
  });
});