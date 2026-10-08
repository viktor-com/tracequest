/**
 * Automated harness for tests/agent-history-integration.md — Claude subagent sidecar integration.
 * Real bin/tracequest.js + serve HTTP; isolated HOME; verifies agentHistory merge vs render stripping.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

const SIDECAR_MARKER = "TQ_AGENT_HISTORY_INTEG_MARKER";
const PARENT_MARKER = "parent-prompt-agent-integ-xyz";
const SECRET = "sk-fake1234567890abcdef";

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

function minimalClaudeSession(sessionId, { prompt = PARENT_MARKER } = {}) {
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
        content: [{ type: "text", text: "parent assistant reply for agent-history integ" }],
      },
    },
  ];
}

function seedClaudeWithSidecar(home, { sidecarText = SIDECAR_MARKER, sidecarSecret = null } = {}) {
  const project = "agent-history-integ";
  const sessionId = "sess-agent-integ-01";
  const projDir = join(home, ".claude", "projects", project);
  const subDir = join(projDir, sessionId, "subagents");
  mkdirSync(subDir, { recursive: true });
  const sessionPath = writeClaudeJsonl(
    projDir,
    `${sessionId}.jsonl`,
    minimalClaudeSession(sessionId),
  );
  const sidecarBody = sidecarSecret
    ? { type: "assistant", timestamp: "2026-06-03T00:00:01.000Z", text: `sidecar holds ${sidecarSecret}` }
    : { type: "assistant", timestamp: "2026-06-03T00:00:01.000Z", text: sidecarText };
  writeFileSync(join(subDir, "scout.jsonl"), JSON.stringify(sidecarBody) + "\n");
  return { sessionPath, project, sessionId };
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
    return await fn({
      port,
      httpGet: (path) => httpGet(port, path),
    });
  } finally {
    const child = serveChildren.pop();
    if (child) await stopServe(child);
  }
}

describe("tests/agent-history-integration.md harness", () => {
  test("Test 1: serve /view SESSION JSON omits agentHistory", async () => {
    const home = mkTmp("tracequest-agent-hist-serve-");
    try {
      const { sessionPath } = seedClaudeWithSidecar(home);
      await withServe(home, async ({ httpGet: get }) => {
        const view = await get(`/view?path=${encodeURIComponent(sessionPath)}`);
        assert.equal(view.status, 200);
        const inlined = parseInlinedSession(view.body);
        assert.equal(inlined.agentHistory, undefined);
        assert.equal(inlined.agentSidecarCount, undefined);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Test 2: serve /view HTML does not leak sidecar marker", async () => {
    const home = mkTmp("tracequest-agent-hist-leak-");
    try {
      const { sessionPath } = seedClaudeWithSidecar(home);
      await withServe(home, async ({ httpGet: get }) => {
        const view = await get(`/view?path=${encodeURIComponent(sessionPath)}`);
        assert.equal(view.status, 200);
        // Sidecar content must not appear in rendered page text or inlined SESSION payload.
        assert.doesNotMatch(view.body, new RegExp(SIDECAR_MARKER));
        const inlined = parseInlinedSession(view.body);
        assert.equal(inlined.agentHistory, undefined);
        assert.equal(inlined.agentSidecarCount, undefined);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Test 3: serve /view retains parent session events", async () => {
    const home = mkTmp("tracequest-agent-hist-parent-");
    try {
      const { sessionPath } = seedClaudeWithSidecar(home);
      await withServe(home, async ({ httpGet: get }) => {
        const view = await get(`/view?path=${encodeURIComponent(sessionPath)}`);
        const inlined = parseInlinedSession(view.body);
        assert.equal(inlined.source, "claude");
        assert.ok(
          inlined.events?.some((e) => e.type === "user" && e.text?.includes(PARENT_MARKER)),
          "inlined SESSION should retain parent user prompt",
        );
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Test 4: CLI render omits agentHistory from SESSION payload", async () => {
    const home = mkTmp("tracequest-agent-hist-render-home-");
    const outDir = mkTmp("tracequest-agent-hist-render-out-");
    const out = join(outDir, "agent-render.html");
    try {
      const { sessionPath } = seedClaudeWithSidecar(home);
      const { stdout } = await runBin(["render", sessionPath, "--out", out], { env: { HOME: home } });
      assert.match(stdout, /Written:/);
      assert.ok(existsSync(out));
      const html = readFileSync(out, "utf8");
      const inlined = parseInlinedSession(html);
      assert.equal(inlined.agentHistory, undefined);
      assert.equal(inlined.agentSidecarCount, undefined);
      assert.doesNotMatch(html, new RegExp(SIDECAR_MARKER));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("Test 5: serve /markdown export omits sidecar content", async () => {
    const home = mkTmp("tracequest-agent-hist-md-");
    try {
      const { sessionPath } = seedClaudeWithSidecar(home);
      await withServe(home, async ({ httpGet: get }) => {
        const mdRes = await get(`/markdown?path=${encodeURIComponent(sessionPath)}`);
        assert.equal(mdRes.status, 200);
        assert.match(mdRes.body, new RegExp(PARENT_MARKER));
        assert.doesNotMatch(mdRes.body, new RegExp(SIDECAR_MARKER));
        assert.doesNotMatch(mdRes.body, /agentHistory|Agent history/i);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Test 6: share CLI scans secrets in subagent sidecars", async () => {
    const home = mkTmp("tracequest-agent-hist-share-");
    try {
      const { sessionPath } = seedClaudeWithSidecar(home, { sidecarSecret: SECRET });
      const { stderr } = await runBin(["share", sessionPath], { env: { HOME: home }, expectCode: 1 });
      const visible = stripAnsi(stderr);
      assert.match(visible, /Scanning session for secrets/);
      assert.match(visible, /finding\(s\)|Secrets detected/i);
      assert.match(visible, /--force/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});