/**
 * Automated harness for tests/multi-source-integration.md — Claude JSONL + OpenCode DB
 * in the same HOME. Verifies list/search CLI and serve HTTP see mixed sources.
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
import { seedOpenCodeIndexDb } from "../helpers/opencode-db-fixtures.js";
import {
  BM25_RANK_NEEDLE,
  SEVEN_WAY_MARKER,
  seedBm25RankMultiSourceHome,
  seedSevenSourceSearchHome,
} from "../helpers/multi-source-fixtures.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;

const MULTI_MARKER = "multi-src-home-marker-xyz";
const OC_SESSION_ID = "ses_multiSrcHomeIntegSession01";
const OC_URI = `opencode://${OC_SESSION_ID}`;
const OC_PROJECT = "/home/dev/multi-src-oc-proj";

/** @type {import("node:child_process").ChildProcess[]} */
const serveChildren = [];

afterEach(async () => {
  while (serveChildren.length) {
    const child = serveChildren.pop();
    if (child.exitCode == null && !child.killed) child.kill("SIGKILL");
    await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(), 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
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

function minimalClaudeSession(sessionId) {
  const ts = "2026-06-03T12:00:00.000Z";
  return [
    {
      type: "user",
      sessionId,
      cwd: CLAUDE_FIXTURE_CWD,
      timestamp: ts,
      uuid: `u-${sessionId}`,
      isMeta: false,
      message: { content: [{ type: "text", text: `claude side ${MULTI_MARKER}` }] },
    },
    {
      type: "assistant",
      sessionId,
      timestamp: ts,
      uuid: `a-${sessionId}`,
      message: {
        model: CLAUDE_FIXTURE_MODEL,
        content: [{ type: "text", text: "multi-source claude assistant reply" }],
      },
    },
    {
      type: "user",
      sessionId,
      timestamp: ts,
      uuid: `u2-${sessionId}`,
      isMeta: false,
      message: { content: [{ type: "text", text: "third turn for discovery msg-count threshold" }] },
    },
  ];
}

function seedClaudeProject(home, projectName, fileName, lines) {
  const dir = join(home, ".claude", "projects", projectName);
  mkdirSync(dir, { recursive: true });
  return writeClaudeJsonl(dir, fileName, lines);
}

async function seedMultiSourceHome() {
  const home = mkTmp("tracequest-multi-src-home-");
  const claudePath = seedClaudeProject(
    home,
    "multi-src-claude",
    "claude-session.jsonl",
    minimalClaudeSession("multi-src-claude-1"),
  );
  await seedOpenCodeIndexDb(home, [
    {
      id: OC_SESSION_ID,
      title: "Multi-Source OpenCode",
      directory: OC_PROJECT,
      messages: [
        {
          role: "user",
          parts: [{ type: "text", text: `opencode side ${MULTI_MARKER}` }],
        },
        {
          role: "assistant",
          modelID: "gpt-4o",
          parts: [{ type: "text", text: "multi-source opencode assistant reply" }],
        },
        {
          role: "user",
          parts: [{ type: "text", text: "third turn for discovery msg-count threshold" }],
        },
      ],
    },
  ]);
  return { home, claudePath, ocUri: OC_URI };
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

function rmHomeDir(home) {
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function pathOrderInStdout(stdout, ...needles) {
  const visible = stripAnsi(stdout);
  return needles.map((needle) => visible.indexOf(needle));
}

describe("tests/multi-source-integration.md harness", () => {
  test("Test 1: list and search discover Claude JSONL and OpenCode DB in same HOME", async () => {
    const { home, claudePath, ocUri } = await seedMultiSourceHome();
    try {
      const { stdout: listOut } = await runBin(["list"], { env: { HOME: home } });
      const listVisible = stripAnsi(listOut);
      assert.match(listVisible, /Found 2 session/);
      assert.match(listVisible, /claude/i);
      assert.match(listVisible, /opencode/i);
      assert.match(listVisible, new RegExp(claudePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(listVisible, new RegExp(ocUri.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

      const { stdout: searchOut } = await runBin(["search", MULTI_MARKER], { env: { HOME: home } });
      const searchVisible = stripAnsi(searchOut);
      assert.match(searchVisible, /Found 2 result/);
      assert.match(searchVisible, /multi-src-claude/);
      assert.match(searchVisible, /multi-src-oc-proj|opencode/i);
    } finally {
      rmHomeDir(home);
    }
  });

  test("Test 2: serve /api/sessions and /api/search see mixed Claude + OpenCode sources", async () => {
    const { home, claudePath, ocUri } = await seedMultiSourceHome();
    const port = await allocEphemeralPort();
    const child = spawnServe(port, home);
    try {
      await waitForHttp(port, "/api/sessions");

      const sessions = JSON.parse((await httpGet(port, "/api/sessions")).body);
      assert.equal(sessions.sessions.length, 2);
      const sources = new Set(sessions.sessions.map((s) => s.source));
      assert.deepEqual(sources, new Set(["claude", "opencode"]));
      const paths = new Set(sessions.sessions.map((s) => s.path));
      assert.ok(paths.has(claudePath));
      assert.ok(paths.has(ocUri));
      assert.ok(sessions.sessions.every((s) => s.prompt.includes(MULTI_MARKER)));

      const search = JSON.parse(
        (await httpGet(port, `/api/search?q=${encodeURIComponent(MULTI_MARKER)}`)).body,
      );
      assert.equal(search.results.length, 2);
      const searchSources = new Set(search.results.map((r) => r.source));
      assert.deepEqual(searchSources, new Set(["claude", "opencode"]));
      assert.ok(search.results.every((r) => r.prompt.includes(MULTI_MARKER)));
      assert.ok(search.results.every((r) => r.matches.length >= 1));
    } finally {
      if (child.exitCode == null && !child.killed) child.kill("SIGKILL");
      await new Promise((r) => setTimeout(r, 150));
      rmHomeDir(home);
    }
  });

  test("Test 3: GET /compare?a=claude&b=opencode renders cross-source comparison", async () => {
    const { home, claudePath, ocUri } = await seedMultiSourceHome();
    const port = await allocEphemeralPort();
    const child = spawnServe(port, home);
    const comparePath =
      `/compare?a=${encodeURIComponent(claudePath)}&b=${encodeURIComponent(ocUri)}`;
    try {
      await waitForHttp(port, "/api/sessions");

      const res = await httpGet(port, comparePath);
      assert.equal(res.status, 200);
      assert.match(res.body, /session comparison/i);
      assert.match(res.body, /session-a/);
      assert.match(res.body, /session-b/);
      assert.match(res.body, /cmp-session-prompt/);
      assert.match(res.body, /claude side/);
      assert.match(res.body, /opencode side/);
      assert.match(res.body, />claude</);
      assert.match(res.body, />opencode</);
      assert.match(res.body, /Metrics/);
      assert.match(res.body, /Tool usage/);
      assert.match(res.body, /Chapter quality/);
      assert.match(res.body, /cmp-label">Model</);
      assert.match(res.body, /sonnet/i);
      assert.match(res.body, /gpt-4o/i);
      assert.match(res.body, /\/view\?id=[0-9a-f]{8}/);
      assert.match(res.body, /\/view\?id=[0-9a-f]{8}&source=opencode/);
    } finally {
      if (child.exitCode == null && !child.killed) child.kill("SIGKILL");
      await new Promise((r) => setTimeout(r, 150));
      rmHomeDir(home);
    }
  });

  test("Test 4: BM25 search ranks dense Claude session above sparse OpenCode in same HOME", async () => {
    const home = mkTmp("tracequest-multi-src-bm25-rank-");
    try {
      const { densePath, sparseOcUri } = await seedBm25RankMultiSourceHome(home);
      const { stdout } = await runBin(["search", BM25_RANK_NEEDLE], { env: { HOME: home } });
      const visible = stripAnsi(stdout);
      assert.match(visible, /Found 2 results/);
      const [denseIdx, sparseIdx] = pathOrderInStdout(stdout, densePath, sparseOcUri);
      assert.ok(denseIdx >= 0, "dense Claude path should appear in output");
      assert.ok(sparseIdx >= 0, "sparse OpenCode URI should appear in output");
      assert.ok(denseIdx < sparseIdx, "dense Claude session should rank above sparse OpenCode (BM25 score)");
    } finally {
      rmHomeDir(home);
    }
  });

  test("Test 5: search and serve API return hits from all seven agent sources", async () => {
    const home = mkTmp("tracequest-multi-src-seven-way-");
    const {
      claudePath,
      cursorPath,
      cursorCloudPath,
      ocUri,
      codexPath,
      factoryPath,
      grokSessDir,
    } = await seedSevenSourceSearchHome(home);
    const port = await allocEphemeralPort();
    const child = spawnServe(port, home);
    try {
      const { stdout } = await runBin(["search", SEVEN_WAY_MARKER], { env: { HOME: home } });
      const visible = stripAnsi(stdout);
      assert.match(visible, /Found 7 results/);
      for (const pathNeedle of [claudePath, cursorPath, cursorCloudPath, ocUri, codexPath, factoryPath, grokSessDir]) {
        assert.ok(visible.includes(pathNeedle), `search stdout should reference ${pathNeedle}`);
      }
      assert.match(visible, /claude/i);
      assert.match(visible, /cursor/i);
      assert.match(visible, /cursor-cloud/i);
      assert.match(visible, /opencode/i);
      assert.match(visible, /codex/i);
      assert.match(visible, /factory/i);
      assert.match(visible, /grok/i);

      await waitForHttp(port, "/api/sessions");
      const search = JSON.parse(
        (await httpGet(port, `/api/search?q=${encodeURIComponent(SEVEN_WAY_MARKER)}`)).body,
      );
      assert.equal(search.results.length, 7);
      const sources = new Set(search.results.map((r) => r.source));
      assert.deepEqual(sources, new Set(["claude", "cursor", "cursor-cloud", "opencode", "codex", "factory", "grok"]));
      assert.ok(search.results.every((r) => r.prompt.includes(SEVEN_WAY_MARKER)));
      assert.ok(search.results.every((r) => r.matches.length >= 1));
    } finally {
      if (child.exitCode == null && !child.killed) child.kill("SIGKILL");
      await new Promise((r) => setTimeout(r, 150));
      rmHomeDir(home);
    }
  });
});
