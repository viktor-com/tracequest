/**
 * Large-corpus integration — 60-session synthetic Claude project.
 * Exercises list/search/serve end-to-end without 32k-file blowups (shared pipeline
 * pattern from test/sessions/index-search-pipeline-perf.test.js).
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { createServer } from "node:http";
import { rmSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeProj, mkTmp } from "../helpers/fixtures.js";
import { writeSyntheticClaudeSessions } from "../helpers/synthetic-sessions.js";
import { assertPerf } from "../helpers/perf-assert.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;

/** 50+ sessions — large enough to stress index build, small enough for CI. */
export const STRESS_SESSION_COUNT = 60;
const MARKER_PREFIX = "stress-corpus";
const FILLER_LINES = 8;

/** Shared corpus; written once per process. */
let stressFixture = null;

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
      resolve({ code, stdout, stderr, elapsedMs: null });
    });
  });
}

async function runBinTimed(args, opts = {}) {
  const t0 = performance.now();
  const result = await runBin(args, opts);
  result.elapsedMs = performance.now() - t0;
  return result;
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
    await waitForHttp(port, "/api/sessions", { timeoutMs: 45_000 });
    return await fn({ port, httpGet: (path) => httpGet(port, path) });
  } finally {
    await stopServe(child);
  }
}

function ensureStressFixture() {
  if (stressFixture) return stressFixture;

  const home = mkTmp("tracequest-stress-corpus-");
  const projDir = claudeProj(home, "stress-large");
  const tWrite = performance.now();
  const { sessions, markerByPath } = writeSyntheticClaudeSessions(projDir, {
    sessionCount: STRESS_SESSION_COUNT,
    fillerLines: FILLER_LINES,
    markerPrefix: MARKER_PREFIX,
  });
  const writeMs = performance.now() - tWrite;
  const baseMtime = Date.parse("2026-06-01T12:00:00Z");
  for (let i = 0; i < sessions.length; i++) {
    const when = new Date(baseMtime + i * 1000);
    utimesSync(sessions[i].path, when, when);
  }

  stressFixture = {
    home,
    sessions,
    markerByPath,
    writeMs,
    uniqueNeedle: markerByPath.get(sessions[42].path).marker,
    newestSession: sessions[STRESS_SESSION_COUNT - 1],
    oldestSession: sessions[0],
  };
  return stressFixture;
}

describe(`stress integration (${STRESS_SESSION_COUNT}-session corpus)`, () => {
  after(() => {
    if (stressFixture?.home) {
      try {
        rmSync(stressFixture.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        // Best-effort cleanup.
      }
      stressFixture = null;
    }
  });

  test(`Test 1: CLI list discovers all ${STRESS_SESSION_COUNT} sessions within 30s`, async () => {
    const fx = ensureStressFixture();
    const { stdout, elapsedMs } = await runBinTimed(["list", "--limit", "200"], {
      env: { HOME: fx.home },
      timeoutMs: 30_000,
    });
    const visible = stripAnsi(stdout);
    assert.match(visible, new RegExp(`Found ${STRESS_SESSION_COUNT} sessions`));
    assertPerf(
      elapsedMs < 30_000,
      `list should complete within 30s, took ${elapsedMs.toFixed(0)}ms (fixture write ${fx.writeMs.toFixed(0)}ms)`,
    );
  });

  test(`Test 2: CLI search finds unique marker in ${STRESS_SESSION_COUNT}-session index within 30s`, async () => {
    const fx = ensureStressFixture();
    const { stdout, elapsedMs } = await runBinTimed(["search", fx.uniqueNeedle], {
      env: { HOME: fx.home },
      timeoutMs: 30_000,
    });
    const visible = stripAnsi(stdout);
    assert.match(visible, /Found 1 result/);
    assert.match(visible, new RegExp(fx.uniqueNeedle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assertPerf(elapsedMs < 30_000, `search should complete within 30s, took ${elapsedMs.toFixed(0)}ms`);
  });

  test(`Test 3: serve /api/sessions lists ${STRESS_SESSION_COUNT} sessions with pagination within 45s`, async () => {
    const fx = ensureStressFixture();
    const t0 = performance.now();
    await withServe(fx.home, async ({ httpGet: get }) => {
      const page1 = JSON.parse((await get("/api/sessions?pageSize=50&page=1")).body);
      assert.equal(page1.total, STRESS_SESSION_COUNT);
      assert.equal(page1.sessions.length, 50);
      assert.equal(page1.page, 1);

      const page2 = JSON.parse((await get("/api/sessions?pageSize=50&page=2")).body);
      assert.equal(page2.total, STRESS_SESSION_COUNT);
      assert.equal(page2.sessions.length, 10);
      assert.equal(page2.page, 2);

      const paths = new Set([...page1.sessions, ...page2.sessions].map((s) => s.path));
      assert.equal(paths.size, STRESS_SESSION_COUNT, "paginated paths should cover full corpus");
    });
    const elapsedMs = performance.now() - t0;
    assertPerf(elapsedMs < 45_000, `serve list should complete within 45s, took ${elapsedMs.toFixed(0)}ms`);
  });

  test(`Test 4: serve /api/search returns corpus hits for shared prefix within 45s`, async () => {
    const fx = ensureStressFixture();
    const prefix = `${MARKER_PREFIX}-sess-`;
    const t0 = performance.now();
    await withServe(fx.home, async ({ httpGet: get }) => {
      const data = JSON.parse((await get(`/api/search?q=${encodeURIComponent(prefix)}`)).body);
      assert.ok(Array.isArray(data.results));
      assert.equal(
        data.results.length,
        50,
        "prefix search is capped at 50 results by /api/search",
      );
      for (const hit of data.results.slice(0, 5)) {
        assert.ok(hit.prompt.includes(prefix), "search hit prompt should include marker prefix");
      }
    });
    const elapsedMs = performance.now() - t0;
    assertPerf(elapsedMs < 45_000, `serve search should complete within 45s, took ${elapsedMs.toFixed(0)}ms`);
  });

  test(`Test 6: perf regression gate — list + search on ${STRESS_SESSION_COUNT}-session corpus under 45s`, async () => {
    const fx = ensureStressFixture();
    const t0 = performance.now();
    const list = await runBin(["list", "--limit", "5"], {
      env: { HOME: fx.home },
      timeoutMs: 45_000,
    });
    const search = await runBin(["search", fx.uniqueNeedle], {
      env: { HOME: fx.home },
      timeoutMs: 45_000,
    });
    const elapsedMs = performance.now() - t0;
    assert.match(stripAnsi(list.stdout), new RegExp(`Found ${STRESS_SESSION_COUNT} sessions`));
    const visible = stripAnsi(search.stdout);
    assert.match(visible, /Found 1 result/);
    assert.match(visible, new RegExp(fx.uniqueNeedle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assertPerf(
      elapsedMs < 45_000,
      `list+search regression gate: expected under 45s on ${STRESS_SESSION_COUNT}-session corpus, took ${elapsedMs.toFixed(0)}ms`,
    );
  });

  test("Test 5: serve sort=date orders large corpus newest-first (alias for recent)", async () => {
    const fx = ensureStressFixture();
    await withServe(fx.home, async ({ httpGet: get }) => {
      const data = JSON.parse((await get("/api/sessions?sort=date&pageSize=5")).body);
      assert.equal(data.total, STRESS_SESSION_COUNT);
      assert.equal(data.sessions.length, 5);
      for (let i = 0; i < data.sessions.length - 1; i++) {
        assert.ok(
          data.sessions[i].mtime >= data.sessions[i + 1].mtime,
          "sort=date should order by mtime descending",
        );
      }
      const mtimes = data.sessions.map((s) => s.mtime);
      assert.ok(mtimes[0] > mtimes[mtimes.length - 1], "first row should be newer than last on page");
    });
  });
});