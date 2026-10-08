/**
 * Automated harness for tests/codex-integration.md — Codex rollout CLI integration.
 * Real bin/tracequest.js invocations; isolated HOME; ~/.codex/sessions/rollout-*.jsonl fixtures.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkTmp, writeClaudeJsonl, writeJsonl, CLAUDE_FIXTURE_CWD, CLAUDE_FIXTURE_MODEL } from "../helpers/fixtures.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;

const CODEX_SESSION_ID = "codex-integ-session-01";
const CODEX_SEARCH_MARKER = "codex-integ-marker-xyz";
const CODEX_PROJECT = "/home/dev/codex-integ-proj";

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

function runBin(args, { env = {}, timeoutMs = 30_000, expectCode = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [BIN, ...args], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        TRACEQUEST_NO_SIDECAR: "1",
        TRACEQUEST_SKIP_TMUX: "1",
        TRACEQUEST_SKIP_LR_WATCH: "1",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`bin timeout after ${timeoutMs}ms: ${args.join(" ")}`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== expectCode) {
        reject(
          new Error(
            `bin ${args.join(" ")} expected exit ${expectCode}, got ${code}\nstdout: ${stdout}\nstderr: ${stderr}`,
          ),
        );
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

function codexRolloutLines({ prompt = `hello ${CODEX_SEARCH_MARKER}` } = {}) {
  const ts = "2026-06-03T12:00:00.000Z";
  return [
    {
      type: "session_meta",
      payload: {
        id: CODEX_SESSION_ID,
        cwd: CODEX_PROJECT,
        model_provider: "openai",
      },
    },
    // Real codex dialect (r8 stub-realism): the FIRST user response_item is
    // the injected instruction context — AGENTS.md markdown plus XML-wrapped
    // blocks — which extraction must never surface as the session's prompt.
    {
      type: "response_item",
      timestamp: ts,
      payload: {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: `# AGENTS.md instructions for ${CODEX_PROJECT}\n\n<INSTRUCTIONS>injected instructions, not user speech</INSTRUCTIONS>` },
          { type: "input_text", text: `<environment_context>\n  <cwd>${CODEX_PROJECT}</cwd>\n</environment_context>` },
        ],
      },
    },
    {
      type: "event_msg",
      timestamp: ts,
      payload: { type: "user_message", message: prompt },
    },
    {
      type: "response_item",
      timestamp: ts,
      payload: {
        role: "assistant",
        content: [{ type: "output_text", text: "codex integration assistant reply" }],
      },
    },
  ];
}

function seedCodexSession(home, { prompt = `hello ${CODEX_SEARCH_MARKER}` } = {}) {
  const codexDir = join(home, ".codex", "sessions", "2026", "06", "03");
  mkdirSync(codexDir, { recursive: true });
  const filePath = join(codexDir, "rollout-codex-integ.jsonl");
  writeJsonl(filePath, codexRolloutLines({ prompt }));
  return filePath;
}

function seedClaudeSession(home) {
  const ts = "2026-06-03T12:00:00.000Z";
  const dir = join(home, ".claude", "projects", "codex-integ-claude");
  mkdirSync(dir, { recursive: true });
  return writeClaudeJsonl(dir, "claude-for-filter.jsonl", [
    {
      type: "user",
      sessionId: "claude-integ-filter",
      cwd: CLAUDE_FIXTURE_CWD,
      timestamp: ts,
      uuid: "u-claude-integ",
      isMeta: false,
      message: { content: [{ type: "text", text: "claude session for source filter test" }] },
    },
    {
      type: "assistant",
      sessionId: "claude-integ-filter",
      timestamp: ts,
      uuid: "a-claude-integ",
      message: {
        model: CLAUDE_FIXTURE_MODEL,
        content: [{ type: "text", text: "claude reply" }],
      },
    },
  ]);
}

function parseInlinedSession(html) {
  const marker = "const SESSION = ";
  const start = html.indexOf(marker);
  assert.ok(start >= 0, "render HTML should embed const SESSION");
  const jsonStart = start + marker.length;
  const jsonEnd = html.indexOf(";\n", jsonStart);
  assert.ok(jsonEnd > jsonStart, "SESSION JSON should terminate before bundle script");
  return JSON.parse(html.slice(jsonStart, jsonEnd));
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

function httpGet(port, reqPath) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}${reqPath}`, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
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

function spawnServe(port, home) {
  const child = spawn(NODE, [BIN, "serve", "--port", String(port)], {
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

async function stopServe(child) {
  if (child.exitCode == null && !child.killed) child.kill("SIGKILL");
  if (child.exitCode == null && !child.killed) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode == null && !child.killed) child.kill("SIGKILL");
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

async function withServe(home, fn) {
  const port = await allocEphemeralPort();
  spawnServe(port, home);
  await waitForHttp(port, "/api/sessions");
  try {
    return await fn({ httpGet: (path) => httpGet(port, path) });
  } finally {
    const child = serveChildren.pop();
    if (child) await stopServe(child);
  }
}

describe("tests/codex-integration.md harness", () => {
  test("Test 1: list discovers Codex rollout sessions", async () => {
    const home = mkTmp("tracequest-codex-list-");
    try {
      const codexPath = seedCodexSession(home);
      const { stdout } = await runBin(["list"], { env: { HOME: home } });
      const visible = stripAnsi(stdout);
      assert.match(visible, /Found 1 sessions/);
      assert.match(visible, /\bcodex\b/);
      assert.match(visible, new RegExp(codexPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Test 2: render produces HTML from Codex path", async () => {
    const home = mkTmp("tracequest-codex-render-home-");
    const outDir = mkTmp("tracequest-codex-render-out-");
    const out = join(outDir, "codex-render.html");
    try {
      const codexPath = seedCodexSession(home);
      const { stdout } = await runBin(["render", codexPath, "--out", out], { env: { HOME: home } });
      assert.match(stdout, /Written:/);
      assert.ok(existsSync(out));
      const inlined = parseInlinedSession(readFileSync(out, "utf8"));
      assert.equal(inlined.source, "codex");
      assert.equal(inlined.sessionId, CODEX_SESSION_ID);
      assert.ok(
        inlined.events?.some((e) => e.type === "user" && e.text?.includes(CODEX_SEARCH_MARKER)),
        "inlined SESSION should retain seeded user prompt",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("Test 3: messages exports JSON from Codex path", async () => {
    const home = mkTmp("tracequest-codex-messages-");
    try {
      const codexPath = seedCodexSession(home);
      const { stdout, stderr } = await runBin(["messages", codexPath], { env: { HOME: home } });
      assert.match(stderr, /Parsing session/);
      const result = JSON.parse(stdout);
      assert.ok(Array.isArray(result.messages));
      assert.ok(result.messages.length >= 2);
      assert.equal(result.messages[0].role, "user");
      assert.equal(result.messages[1].role, "assistant");
      const userText = result.messages[0].content.find((b) => b.type === "text")?.text || "";
      assert.ok(userText.includes(CODEX_SEARCH_MARKER));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Test 4: search indexes Codex session text", async () => {
    const home = mkTmp("tracequest-codex-search-");
    try {
      const codexPath = seedCodexSession(home);
      const { stdout } = await runBin(["search", CODEX_SEARCH_MARKER], { env: { HOME: home } });
      const visible = stripAnsi(stdout);
      assert.match(visible, /Found 1 result/);
      assert.match(visible, new RegExp(codexPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(visible, new RegExp(CODEX_SEARCH_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Test 5: serve /api/sessions lists Codex session", async () => {
    const home = mkTmp("tracequest-codex-serve-");
    try {
      const codexPath = seedCodexSession(home);
      await withServe(home, async ({ httpGet: get }) => {
        const res = await get("/api/sessions");
        assert.equal(res.status, 200);
        const data = JSON.parse(res.body);
        assert.ok(Array.isArray(data.sessions));
        assert.equal(data.sessions.length, 1);
        assert.equal(data.sessions[0].source, "codex");
        assert.equal(data.sessions[0].path, codexPath);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Test 6: list --filter source:codex filters to Codex only", async () => {
    const home = mkTmp("tracequest-codex-filter-");
    try {
      const codexPath = seedCodexSession(home);
      const claudePath = seedClaudeSession(home);
      const { stdout } = await runBin(["list", "--filter", "source:codex"], { env: { HOME: home } });
      const visible = stripAnsi(stdout);
      assert.match(visible, /Found 1 sessions/);
      assert.match(visible, /\bcodex\b/);
      assert.match(visible, new RegExp(codexPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(visible, new RegExp(claudePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});