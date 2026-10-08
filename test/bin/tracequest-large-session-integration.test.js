/**
 * Large-session integration — 120-turn Claude session export/share edge cases.
 * Expectations: render/export/share complete within CI timeouts without OOM.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_FIXTURE_MODEL, mkTmp, writeClaudeJsonl } from "../helpers/fixtures.js";
import {
  LARGE_SESSION_TURN_COUNT,
  PREUPLOAD_SESSION_TURN_COUNT,
  makeLargeClaudeTurnSessionLines,
  makePreuploadClaudeSessionLines,
} from "../helpers/synthetic-sessions.js";
import { HF_PREUPLOAD_THRESHOLD } from "../../src/share/hf-adapter.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;

const RENDER_TIMEOUT_MS = 90_000;
const SHARE_TIMEOUT_MS = 90_000;
const SERVE_TIMEOUT_MS = 60_000;

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function runBin(args, { env = {}, timeoutMs = 60_000, expectCode = 0 } = {}) {
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
      reject(new Error(`bin timeout after ${timeoutMs}ms: ${args.join(" ")}\nstderr: ${stderr}`));
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

async function runBinTimed(args, opts = {}) {
  const t0 = performance.now();
  const result = await runBin(args, opts);
  result.elapsedMs = performance.now() - t0;
  return result;
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

function seedLargeSessionHome() {
  const home = mkTmp("tracequest-large-session-home-");
  const sessionId = "large-session-integ-1";
  const { lines, marker } = makeLargeClaudeTurnSessionLines(sessionId, {
    turnCount: LARGE_SESSION_TURN_COUNT,
    markerPrefix: "large-sess-integ",
    model: CLAUDE_FIXTURE_MODEL,
  });
  const dir = join(home, ".claude", "projects", "large-session-integ");
  mkdirSync(dir, { recursive: true });
  const sessionPath = writeClaudeJsonl(dir, "large-turns.jsonl", lines);
  return { home, sessionPath, sessionId, marker, turnCount: LARGE_SESSION_TURN_COUNT };
}

function seedPreuploadSessionHome() {
  const home = mkTmp("tracequest-preupload-session-home-");
  const sessionId = "preupload-session-integ-1";
  const { lines, marker } = makePreuploadClaudeSessionLines(sessionId, {
    turnCount: PREUPLOAD_SESSION_TURN_COUNT,
    markerPrefix: "preupload-sess-integ",
    model: CLAUDE_FIXTURE_MODEL,
  });
  const dir = join(home, ".claude", "projects", "preupload-session-integ");
  mkdirSync(dir, { recursive: true });
  const sessionPath = writeClaudeJsonl(dir, "preupload-turns.jsonl", lines);
  return { home, sessionPath, sessionId, marker, turnCount: PREUPLOAD_SESSION_TURN_COUNT };
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

async function waitForHttp(port, reqPath, { expectedStatus = 200, timeoutMs = 30_000, intervalMs = 100 } = {}) {
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
  return spawn(NODE, [BIN, "serve", "--port", String(port)], {
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
}

async function stopServe(child) {
  if (child.exitCode == null && !child.killed) child.kill("SIGKILL");
  if (child.exitCode == null) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

async function withServe(home, fn) {
  const port = await allocEphemeralPort();
  const child = spawnServe(port, home);
  try {
    await waitForHttp(port, "/api/sessions", { timeoutMs: SERVE_TIMEOUT_MS });
    return await fn({ port, httpGet: (path) => httpGet(port, path) });
  } finally {
    await stopServe(child);
  }
}

async function withMockGistServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const port = server.address().port;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withMockHfServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const port = server.address().port;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

describe(`large-session integration (${LARGE_SESSION_TURN_COUNT}-turn session)`, () => {
  test(`Test 1: CLI render completes within ${RENDER_TIMEOUT_MS / 1000}s without OOM`, async () => {
    const fx = seedLargeSessionHome();
    const out = join(fx.home, "large-render.html");
    try {
      const { stdout, elapsedMs } = await runBinTimed(
        ["render", fx.sessionPath, "--out", out],
        { timeoutMs: RENDER_TIMEOUT_MS },
      );
      assert.match(stripAnsi(stdout), /Written:/);
      assert.ok(elapsedMs < RENDER_TIMEOUT_MS, `render took ${elapsedMs.toFixed(0)}ms`);
      assert.ok(existsSync(out));
      const html = readFileSync(out, "utf8");
      const session = parseInlinedSession(html);
      assert.ok(session.events.length >= fx.turnCount * 2, "should retain user+assistant events");
      assert.match(html, new RegExp(fx.marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(html, new RegExp(`${fx.marker} 0 user prompt`));
      assert.match(html, new RegExp(`${fx.marker} ${fx.turnCount - 1} assistant reply`));
    } finally {
      rmSync(fx.home, { recursive: true, force: true });
    }
  });

  test(`Test 2: CLI messages exports ${LARGE_SESSION_TURN_COUNT}+ Anthropic messages`, async () => {
    const fx = seedLargeSessionHome();
    try {
      const { stdout, elapsedMs } = await runBinTimed(["messages", fx.sessionPath], {
        timeoutMs: RENDER_TIMEOUT_MS,
      });
      assert.ok(elapsedMs < RENDER_TIMEOUT_MS, `messages took ${elapsedMs.toFixed(0)}ms`);
      const exported = JSON.parse(stdout);
      assert.ok(Array.isArray(exported.messages));
      assert.ok(
        exported.messages.length >= fx.turnCount * 2,
        `expected >= ${fx.turnCount * 2} messages, got ${exported.messages.length}`,
      );
      const firstUser = exported.messages.find((m) => m.role === "user");
      assert.ok(firstUser);
      assert.match(JSON.stringify(firstUser), new RegExp(`${fx.marker} 0 user prompt`));
    } finally {
      rmSync(fx.home, { recursive: true, force: true });
    }
  });

  test("Test 3: serve /view renders large session HTML", async () => {
    const fx = seedLargeSessionHome();
    try {
      await withServe(fx.home, async ({ httpGet: get }) => {
        const t0 = performance.now();
        const view = await get(`/view?path=${encodeURIComponent(fx.sessionPath)}`);
        const elapsedMs = performance.now() - t0;
        assert.equal(view.status, 200);
        assert.match(view.headers["content-type"], /text\/html/);
        assert.ok(elapsedMs < SERVE_TIMEOUT_MS, `serve /view took ${elapsedMs.toFixed(0)}ms`);
        const session = parseInlinedSession(view.body);
        assert.ok(session.events.length >= fx.turnCount * 2);
        assert.match(view.body, new RegExp(`${fx.marker} ${fx.turnCount - 1} assistant reply`));
        assert.match(view.body, /EventSource\("\/__livereload"\)/, "serve /view should inject live-reload hook");
      });
    } finally {
      rmSync(fx.home, { recursive: true, force: true });
    }
  });

  test("Test 4: serve /export and /markdown succeed for large session", async () => {
    const fx = seedLargeSessionHome();
    try {
      await withServe(fx.home, async ({ httpGet: get }) => {
        const exportRes = await get(`/export?path=${encodeURIComponent(fx.sessionPath)}`);
        assert.equal(exportRes.status, 200);
        assert.match(exportRes.headers["content-type"], /text\/html/);
        assert.ok(exportRes.body.length > 50_000, "export HTML should be substantial");
        const exportSession = parseInlinedSession(exportRes.body);
        assert.ok(exportSession.events.length >= fx.turnCount * 2);
        assert.doesNotMatch(exportRes.body, /EventSource\("\/__livereload"\)/);

        const mdRes = await get(`/markdown?path=${encodeURIComponent(fx.sessionPath)}`);
        assert.equal(mdRes.status, 200);
        assert.match(mdRes.headers["content-type"], /text\/markdown/);
        assert.ok(mdRes.body.length > 5_000, "markdown export should be substantial");
        assert.match(mdRes.body, new RegExp(`${fx.marker} 0 user prompt`));
        assert.match(mdRes.body, new RegExp(`${fx.marker} ${fx.turnCount - 1} assistant reply`));
      });
    } finally {
      rmSync(fx.home, { recursive: true, force: true });
    }
  });

  test(`Test 5: share ${LARGE_SESSION_TURN_COUNT}-turn session via mock gist completes`, async () => {
    const fx = seedLargeSessionHome();
    try {
      let gistBody = null;
      await withMockGistServer((req, res) => {
        if (req.url?.endsWith("/gists") && req.method === "POST") {
          let body = "";
          req.on("data", (c) => {
            body += c;
          });
          req.on("end", () => {
            gistBody = JSON.parse(body);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ html_url: "https://gist.github.com/mock/large", id: "large" }));
          });
          return;
        }
        res.writeHead(404);
        res.end();
      }, async (apiUrl) => {
        const { stdout, elapsedMs } = await runBinTimed(
          ["share", fx.sessionPath, "--target", "gist", "--json", "--force"],
          {
            env: { GITHUB_TOKEN: "fake", GITHUB_API_URL: apiUrl },
            timeoutMs: SHARE_TIMEOUT_MS,
          },
        );
        assert.ok(elapsedMs < SHARE_TIMEOUT_MS, `share took ${elapsedMs.toFixed(0)}ms`);
        const parsed = JSON.parse(stdout);
        assert.equal(parsed.target, "gist");
        assert.ok(parsed.chapterCount >= fx.turnCount, `chapterCount ${parsed.chapterCount} < ${fx.turnCount}`);
        const fileContent = Object.values(gistBody.files)[0].content;
        assert.ok(fileContent.length > 50_000, "upload payload should include full rendered HTML");
        assert.match(fileContent, new RegExp(`${fx.marker} ${fx.turnCount - 1} assistant reply`));
      });
    } finally {
      rmSync(fx.home, { recursive: true, force: true });
    }
  });

  test(`Test 6: share ${LARGE_SESSION_TURN_COUNT}-turn session via mock HF completes`, async () => {
    const fx = seedLargeSessionHome();
    try {
      const calls = [];
      await withMockHfServer((req, res) => {
        const url = req.url || "";
        let body = "";
        req.on("data", (c) => {
          body += c;
        });
        req.on("end", () => {
          if (body) {
            try {
              calls.push({ url, method: req.method, body: JSON.parse(body) });
            } catch {
              calls.push({ url, method: req.method, body });
            }
          } else {
            calls.push({ url, method: req.method, body: null });
          }
          if (url.includes("/api/whoami-v2")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ name: "testuser" }));
            return;
          }
          if (url.includes("/api/datasets/testuser/tracequest-sessions") && req.method === "GET") {
            res.writeHead(404);
            res.end();
            return;
          }
          if (url.endsWith("/api/repos/create") && req.method === "POST") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end("{}");
            return;
          }
          if (url.includes("/commit/main") && req.method === "POST") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end("{}");
            return;
          }
          res.writeHead(404);
          res.end();
        });
      }, async (apiUrl) => {
        const { stdout, elapsedMs } = await runBinTimed(
          [
            "share",
            fx.sessionPath,
            "--target",
            "hf",
            "--hf-repo",
            "testuser/tracequest-sessions",
            "--json",
            "--force",
          ],
          {
            env: { HF_TOKEN: "fake", HF_API_URL: apiUrl },
            timeoutMs: SHARE_TIMEOUT_MS,
          },
        );
        assert.ok(elapsedMs < SHARE_TIMEOUT_MS, `HF share took ${elapsedMs.toFixed(0)}ms`);
        const parsed = JSON.parse(stdout);
        assert.equal(parsed.target, "hf");
        assert.ok(parsed.chapterCount >= fx.turnCount, `chapterCount ${parsed.chapterCount} < ${fx.turnCount}`);
        assert.ok(parsed.url.includes("/datasets/testuser/tracequest-sessions"));

        const commitCall = calls.find((c) => c.url.includes("/commit/main") && c.method === "POST");
        assert.ok(commitCall, "expected HF dataset commit");
        const paths = commitCall.body.operations.map((op) => op.path);
        assert.ok(paths.some((p) => p.endsWith(".html")));
        assert.ok(paths.some((p) => p.endsWith(".json")));
        assert.ok(paths.includes("README.md"), "first HF share should include README.md");

        const htmlOp = commitCall.body.operations.find((op) => op.path.endsWith(".html"));
        const htmlContent = htmlOp.content ?? "";
        assert.ok(htmlContent.length > 50_000, "HF commit HTML should include full rendered session");
        assert.match(htmlContent, new RegExp(`${fx.marker} ${fx.turnCount - 1} assistant reply`));

        const jsonOp = commitCall.body.operations.find((op) => op.path.endsWith(".json"));
        const sidecar = JSON.parse(jsonOp.content);
        assert.ok(sidecar.eventCount >= fx.turnCount * 2, "sidecar should reflect large event count");
      });
    } finally {
      rmSync(fx.home, { recursive: true, force: true });
    }
  });

  test(`Test 7: share ${PREUPLOAD_SESSION_TURN_COUNT}-turn session via mock HF preupload path`, async () => {
    const fx = seedPreuploadSessionHome();
    try {
      const calls = [];
      await withMockHfServer((req, res) => {
        const url = req.url || "";
        let body = "";
        req.on("data", (c) => {
          body += c;
        });
        req.on("end", () => {
          if (body) {
            try {
              calls.push({ url, method: req.method, body: JSON.parse(body) });
            } catch {
              calls.push({ url, method: req.method, body, bodyBytes: Buffer.byteLength(body, "utf8") });
            }
          } else {
            calls.push({ url, method: req.method, body: null });
          }
          if (url.includes("/api/whoami-v2")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ name: "testuser" }));
            return;
          }
          if (url.includes("/api/datasets/testuser/tracequest-sessions") && req.method === "GET") {
            res.writeHead(404);
            res.end();
            return;
          }
          if (url.endsWith("/api/repos/create") && req.method === "POST") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end("{}");
            return;
          }
          if (url.includes("/preupload/main") && req.method === "POST") {
            const file = calls.at(-1)?.body?.files?.[0];
            const filePath = file?.path || "unknown.html";
            const uploadUrl = `http://${req.headers.host}/mock-upload?path=${encodeURIComponent(filePath)}`;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                files: [{ path: filePath, uploadUrl, oid: `mock-oid-${filePath}` }],
              }),
            );
            return;
          }
          if (url.startsWith("/mock-upload") && req.method === "PUT") {
            res.writeHead(200);
            res.end();
            return;
          }
          if (url.includes("/commit/main") && req.method === "POST") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end("{}");
            return;
          }
          res.writeHead(404);
          res.end();
        });
      }, async (apiUrl) => {
        const { stdout, elapsedMs } = await runBinTimed(
          [
            "share",
            fx.sessionPath,
            "--target",
            "hf",
            "--hf-repo",
            "testuser/tracequest-sessions",
            "--json",
            "--force",
          ],
          {
            env: { HF_TOKEN: "fake", HF_API_URL: apiUrl },
            timeoutMs: SHARE_TIMEOUT_MS,
          },
        );
        assert.ok(elapsedMs < SHARE_TIMEOUT_MS, `HF preupload share took ${elapsedMs.toFixed(0)}ms`);
        const parsed = JSON.parse(stdout);
        assert.equal(parsed.target, "hf");
        assert.ok(parsed.url.includes("/datasets/testuser/tracequest-sessions"));

        const preuploadCall = calls.find((c) => c.url.includes("/preupload/main") && c.method === "POST");
        assert.ok(preuploadCall, "expected HF preupload request before commit");
        const preuploadPath = preuploadCall.body.files[0].path;
        assert.ok(preuploadPath.endsWith(".html"), "preupload should target rendered HTML path");
        assert.ok(preuploadCall.body.files[0].size >= HF_PREUPLOAD_THRESHOLD, "preupload size should meet HF threshold");

        const putCall = calls.find((c) => c.url.startsWith("/mock-upload") && c.method === "PUT");
        assert.ok(putCall, "expected PUT to preupload uploadUrl");
        assert.ok(putCall.bodyBytes >= HF_PREUPLOAD_THRESHOLD, "uploaded HTML should exceed HF threshold");
        assert.match(putCall.body, new RegExp(`${fx.marker} ${fx.turnCount - 1}`));

        const commitCall = calls.find((c) => c.url.includes("/commit/main") && c.method === "POST");
        assert.ok(commitCall, "expected HF dataset commit after preupload");
        const htmlOp = commitCall.body.operations.find((op) => op.path.endsWith(".html"));
        assert.ok(htmlOp?.oid, "large HTML commit op should reference preupload oid, not inline content");
        assert.equal(htmlOp.content, undefined, "large HTML should not be inlined in commit payload");

        const jsonOp = commitCall.body.operations.find((op) => op.path.endsWith(".json"));
        assert.ok(jsonOp?.content, "small JSON sidecar should still be inlined");
        const sidecar = JSON.parse(jsonOp.content);
        assert.ok(sidecar.eventCount >= fx.turnCount * 2);

        const preuploadIdx = calls.indexOf(preuploadCall);
        const commitIdx = calls.indexOf(commitCall);
        assert.ok(preuploadIdx >= 0 && commitIdx > preuploadIdx, "preupload should precede commit");
        const putIdx = calls.indexOf(putCall);
        assert.ok(putIdx > preuploadIdx && putIdx < commitIdx, "PUT should occur between preupload and commit");
      });
    } finally {
      rmSync(fx.home, { recursive: true, force: true });
    }
  });
});