/**
 * Automated harness for tests/edge-integration.md — edge-case CLI integration scenarios.
 * Real bin/tracequest.js invocations; isolated HOME; graceful-failure expectations.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
import { assertPerf } from "../helpers/perf-assert.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;
const UNICODE_PROJECT = "café-日本語";
const UNICODE_MARKER = "unicode-edge-marker-🚀";

/** @type {import("node:child_process").ChildProcess[]} */
const serveChildren = [];

afterEach(() => {
  for (const child of serveChildren) {
    if (child.exitCode == null && !child.killed) {
      child.kill("SIGTERM");
    }
  }
  serveChildren.length = 0;
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

function minimalClaudeSession(sessionId, { prompt = UNICODE_MARKER, model = CLAUDE_FIXTURE_MODEL } = {}) {
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
        model,
        content: [{ type: "text", text: "edge integration reply" }],
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
    // Bind 127.0.0.1, the same address `serve` binds by default. Binding a
    // different address does not collide on macOS, so the "port in use" child
    // would start instead of failing with EADDRINUSE.
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

function spawnServeOnPort(port, home) {
  return new Promise((resolve, reject) => {
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
      reject(new Error(`serve child timeout on port ${port}`));
    }, 15_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe("tests/edge-integration.md harness", () => {
  test("Test 1: empty HOME returns sensible empty results", async () => {
    const home = mkTmp("tracequest-edge-empty-home-");
    try {
      for (const args of [
        ["list"],
        ["find", "--filter", "model:sonnet"],
        ["search", "needle"],
      ]) {
        const { stdout, stderr } = await runBin(args, { env: { HOME: home } });
        const visible = stripAnsi(stdout);
        assert.match(visible, /No sessions found\./, `${args.join(" ")} should report empty state`);
        assert.ok(!stderr.includes("node:internal"), `${args.join(" ")} should not leak stack trace`);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Test 2: serve --port conflict fails clearly", async () => {
    const home = mkTmp("tracequest-edge-serve-inuse-");
    seedClaudeProject(home, "edge-serve", "smoke.jsonl", minimalClaudeSession("edge-serve-1"));
    const { server, port } = await listenOnEphemeralPort();
    try {
      const { code, stderr, stdout } = await spawnServeOnPort(port, home);
      assert.equal(code, 1);
      assert.equal(stdout, "");
      assert.match(stderr, new RegExp(`Error: Port ${port} is already in use`));
      assert.match(stderr, new RegExp(`tracequest serve --port ${port + 1}`));
      assert.ok(!stderr.includes("node:internal"));
    } finally {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Test 3: share reports network errors cleanly", async () => {
    const dir = mkTmp("tracequest-edge-share-net-");
    const sessionPath = writeClaudeJsonl(dir, "sess-net.jsonl", minimalClaudeSession("edge-share-net"));
    const { port } = await listenOnEphemeralPort().then(async ({ server, port: p }) => {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      return { port: p };
    });
    try {
      const { stderr, stdout } = await runBin(
        ["share", sessionPath, "--target", "gist", "--json", "--force"],
        {
          env: {
            GITHUB_TOKEN: "fake-token-for-edge-test",
            GITHUB_API_URL: `http://127.0.0.1:${port}`,
          },
          expectCode: 1,
        },
      );
      assert.equal(stdout, "");
      assert.match(stderr, /Error:/);
      assert.match(stderr, /Gist upload failed|fetch failed|ECONNREFUSED/i);
      assert.ok(!stderr.includes("node:internal"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Test 4: unicode project paths discover and render", async () => {
    const home = mkTmp("tracequest-edge-unicode-home-");
    const outDir = mkTmp("tracequest-edge-unicode-out-");
    const out = join(outDir, "unicode.html");
    const sessionPath = seedClaudeProject(
      home,
      UNICODE_PROJECT,
      "unicode-session.jsonl",
      minimalClaudeSession("edge-unicode-1"),
    );
    try {
      const list = await runBin(["list", "café"], { env: { HOME: home } });
      assert.match(stripAnsi(list.stdout), new RegExp(UNICODE_PROJECT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      const search = await runBin(["search", UNICODE_MARKER], { env: { HOME: home } });
      assert.match(stripAnsi(search.stdout), /Found 1 result/);
      assert.match(stripAnsi(search.stdout), new RegExp(UNICODE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      const render = await runBin(["render", sessionPath, "--out", out]);
      assert.match(render.stdout, /Written:/);
      assert.ok(existsSync(out));
      const html = readFileSync(out, "utf8");
      assert.ok(html.includes(UNICODE_MARKER), "rendered HTML should preserve unicode prompt");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("Test 5: unreadable session file fails gracefully", async () => {
    const dir = mkTmp("tracequest-edge-perm-");
    const sessionPath = writeClaudeJsonl(dir, "locked.jsonl", minimalClaudeSession("edge-perm-1"));
    chmodSync(sessionPath, 0o000);
    try {
      const { stderr, stdout } = await runBin(["render", sessionPath], { expectCode: 1 });
      assert.match(stripAnsi(stdout), /Parsing session/);
      assert.match(stderr, /Error:/);
      assert.match(stderr, /Failed to parse session|EACCES|permission denied/i);
      assert.ok(!stderr.includes("node:internal"));
    } finally {
      chmodSync(sessionPath, 0o644);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Test 7: share times out against hanging mock API", async () => {
    const dir = mkTmp("tracequest-edge-share-hang-");
    const sessionPath = writeClaudeJsonl(dir, "sess-hang.jsonl", minimalClaudeSession("edge-share-hang"));
    /** @type {import("node:net").Socket[]} */
    const sockets = [];
    const server = createServer(() => {
      // Accept but never respond — triggers shareFetch timeout.
    });
    server.on("connection", (socket) => sockets.push(socket));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address();
    const started = Date.now();
    try {
      const { stderr, stdout } = await runBin(
        ["share", sessionPath, "--target", "gist", "--json", "--force"],
        {
          env: {
            GITHUB_TOKEN: "fake-token-for-edge-test",
            GITHUB_API_URL: `http://127.0.0.1:${port}`,
            TRACEQUEST_SHARE_FETCH_TIMEOUT_MS: "1500",
            TRACEQUEST_SHARE_FETCH_RETRIES: "0",
          },
          expectCode: 1,
          timeoutMs: 12_000,
        },
      );
      const elapsed = Date.now() - started;
      assertPerf(elapsed < 10_000, `share should not hang; took ${elapsed}ms`);
      assert.equal(stdout, "");
      assert.match(stderr, /Error:/);
      assert.match(stderr, /timed out/i);
      assert.ok(!stderr.includes("node:internal"));
    } finally {
      for (const socket of sockets) socket.destroy();
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Test 8: share retries 429 from mock API then succeeds", async () => {
    const dir = mkTmp("tracequest-edge-share-429-");
    const sessionPath = writeClaudeJsonl(dir, "sess-429.jsonl", minimalClaudeSession("edge-share-429"));
    let postCount = 0;
    const server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/gists") {
        postCount++;
        if (postCount < 3) {
          res.writeHead(429, { "Content-Type": "text/plain" });
          res.end("rate limited");
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "edge429gist01", html_url: "https://gist.github.com/test/edge429gist01" }));
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address();
    try {
      const { stdout } = await runBin(
        ["share", sessionPath, "--target", "gist", "--json", "--force"],
        {
          env: {
            GITHUB_TOKEN: "fake-token-for-edge-test",
            GITHUB_API_URL: `http://127.0.0.1:${port}`,
            TRACEQUEST_SHARE_FETCH_RETRY_DELAY_MS: "30",
            TRACEQUEST_SHARE_FETCH_TIMEOUT_MS: "5000",
          },
        },
      );
      const payload = JSON.parse(stdout);
      assert.ok(payload.url);
      assert.ok(postCount >= 3, `expected ≥3 POST attempts, got ${postCount}`);
    } finally {
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Test 9: share fails cleanly after 503 retries exhausted", async () => {
    const dir = mkTmp("tracequest-edge-share-503-");
    const sessionPath = writeClaudeJsonl(dir, "sess-503.jsonl", minimalClaudeSession("edge-share-503"));
    let postCount = 0;
    const server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/gists") {
        postCount++;
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("service unavailable");
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address();
    try {
      const { stderr, stdout } = await runBin(
        ["share", sessionPath, "--target", "gist", "--json", "--force"],
        {
          env: {
            GITHUB_TOKEN: "fake-token-for-edge-test",
            GITHUB_API_URL: `http://127.0.0.1:${port}`,
            TRACEQUEST_SHARE_FETCH_RETRIES: "2",
            TRACEQUEST_SHARE_FETCH_RETRY_DELAY_MS: "30",
            TRACEQUEST_SHARE_FETCH_TIMEOUT_MS: "5000",
          },
          expectCode: 1,
        },
      );
      assert.equal(stdout, "");
      assert.match(stderr, /Error:/);
      assert.match(stderr, /503/);
      assert.equal(postCount, 3, "initial attempt + 2 retries");
      assert.ok(!stderr.includes("node:internal"));
    } finally {
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Test 6: symlinked .jsonl session is discovered via list", async () => {
    const home = mkTmp("tracequest-edge-symlink-home-");
    const projectDir = join(home, ".claude", "projects", "edge-symlink-proj");
    mkdirSync(projectDir, { recursive: true });
    const targetPath = writeClaudeJsonl(projectDir, "real-session.jsonl", minimalClaudeSession("edge-symlink-1", { prompt: "symlink-edge-marker" }));
    const linkPath = join(projectDir, "via-link.jsonl");
    symlinkSync(targetPath, linkPath);
    try {
      const { stdout } = await runBin(["list", "edge-symlink"], { env: { HOME: home } });
      const visible = stripAnsi(stdout);
      assert.match(visible, /Found 2 sessions/);
      assert.match(visible, /via-link\.jsonl/);
      assert.match(visible, /real-session\.jsonl/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});