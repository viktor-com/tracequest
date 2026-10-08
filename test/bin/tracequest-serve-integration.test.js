/**
 * Automated harness for tests/serve-integration.md — serve HTTP API integration.
 * Real bin/tracequest.js serve process; isolated HOME fixtures; real HTTP requests.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { createServer } from "node:http";
import { mkdirSync, rmSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAUDE_FIXTURE_CWD,
  CLAUDE_FIXTURE_MODEL,
  mkTmp,
  writeClaudeJsonl,
} from "../helpers/fixtures.js";
import { seedOpenCodeIndexDb } from "../helpers/opencode-db-fixtures.js";
import { computeGrade, estimateCost } from "../../src/filter/filter-formats.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;
const SEARCH_MARKER = "serve-api-search-marker-xyz";
const OC_SERVE_SESSION_ID = "ses_serveOpenCodeIntegSession01";
const OC_SERVE_URI = `opencode://${OC_SERVE_SESSION_ID}`;
const OC_SERVE_MARKER = "serve-opencode-search-marker-xyz";
const OC_SERVE_PROJECT = "/home/dev/serve-oc-integ-proj";

/** @type {import("node:child_process").ChildProcess[]} */
const serveChildren = [];
/** @type {string[]} */
const pendingHomes = [];

afterEach(async () => {
  while (serveChildren.length) {
    await stopServe(serveChildren.pop());
  }
  await new Promise((r) => setTimeout(r, 150));
  while (pendingHomes.length) {
    const home = pendingHomes.pop();
    try {
      rmHomeDir(home);
    } catch {
      // Best-effort: worker threads may still flush index files under HOME.
    }
  }
});

function minimalClaudeSession(sessionId, { prompt = "integration prompt", model = CLAUDE_FIXTURE_MODEL } = {}) {
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
        content: [{ type: "text", text: "integration assistant reply" }],
      },
    },
  ];
}

/** Claude session with explicit usage + timestamps for sort=tokens/duration integration. */
function claudeSessionWithSortMetrics(
  sessionId,
  {
    prompt = "integration prompt",
    model = CLAUDE_FIXTURE_MODEL,
    usage = { input_tokens: 10, output_tokens: 5 },
    tStart = "2026-01-01T00:00:00.000Z",
    tEnd = "2026-01-01T00:01:00.000Z",
  } = {},
) {
  return [
    {
      type: "user",
      sessionId,
      cwd: CLAUDE_FIXTURE_CWD,
      timestamp: tStart,
      uuid: `u-${sessionId}`,
      isMeta: false,
      message: { content: [{ type: "text", text: prompt }] },
    },
    {
      type: "assistant",
      sessionId,
      timestamp: tEnd,
      uuid: `a-${sessionId}`,
      message: {
        model,
        content: [{ type: "text", text: "integration assistant reply" }],
        usage,
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

function waitForProcessExit(child, { timeoutMs = 5_000, label = "child" } = {}) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
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

function spawnServe(port, home, extraArgs = []) {
  const child = spawn(NODE, [BIN, "serve", "--port", String(port), ...extraArgs], {
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

function trackHome(home) {
  pendingHomes.push(home);
}

async function withServe(home, fn, { serveArgs = [] } = {}) {
  const port = await allocEphemeralPort();
  const child = spawnServe(port, home, serveArgs);
  try {
    assert.equal(child.exitCode, null, "serve should stay running until stopped");
    await waitForHttp(port, "/api/sessions");
    return await fn({ port, home, httpGet: (path) => httpGet(port, path) });
  } finally {
    await stopServe(child);
  }
}

/** Three sessions with distinct mtimes for sort integration (newest → oldest: zzz, mmm, aaa). */
function seedSortFixtureHome() {
  const home = mkTmp("tracequest-serve-sort-home-");
  const pathAaa = seedClaudeProject(
    home,
    "serve-sort",
    "aaa-oldest.jsonl",
    minimalClaudeSession("sort-aaa", { prompt: "aaa oldest prompt" }),
  );
  const pathMmm = seedClaudeProject(
    home,
    "serve-sort",
    "mmm-middle.jsonl",
    minimalClaudeSession("sort-mmm", { prompt: "mmm middle prompt" }),
  );
  const pathZzz = seedClaudeProject(
    home,
    "serve-sort",
    "zzz-newest.jsonl",
    minimalClaudeSession("sort-zzz", { prompt: "zzz newest prompt" }),
  );
  utimesSync(pathAaa, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
  utimesSync(pathMmm, new Date("2026-03-01T00:00:00Z"), new Date("2026-03-01T00:00:00Z"));
  utimesSync(pathZzz, new Date("2026-06-01T00:00:00Z"), new Date("2026-06-01T00:00:00Z"));
  return {
    home,
    recentFirstPrompts: ["zzz newest prompt", "mmm middle prompt", "aaa oldest prompt"],
    alphaFirstPrompts: ["aaa oldest prompt", "mmm middle prompt", "zzz newest prompt"],
  };
}

/** Three sessions with distinct totalTokens for sort=tokens integration (high → low). */
function seedTokenSortFixtureHome() {
  const home = mkTmp("tracequest-serve-tok-sort-home-");
  seedClaudeProject(
    home,
    "serve-tok-sort",
    "tok-low.jsonl",
    claudeSessionWithSortMetrics("sort-tok-low", {
      prompt: "low token session",
      usage: { input_tokens: 100, output_tokens: 50 },
    }),
  );
  seedClaudeProject(
    home,
    "serve-tok-sort",
    "tok-mid.jsonl",
    claudeSessionWithSortMetrics("sort-tok-mid", {
      prompt: "mid token session",
      usage: { input_tokens: 400, output_tokens: 100 },
    }),
  );
  seedClaudeProject(
    home,
    "serve-tok-sort",
    "tok-high.jsonl",
    claudeSessionWithSortMetrics("sort-tok-high", {
      prompt: "high token session",
      usage: { input_tokens: 700, output_tokens: 200 },
    }),
  );
  return {
    home,
    tokenFirstPrompts: ["high token session", "mid token session", "low token session"],
    tokenFirstTotals: [900, 500, 150],
  };
}

/** Claude session with N tool_result errors for sort=errors integration. */
function claudeSessionWithErrors(sessionId, errorCount, { prompt = "integration prompt" } = {}) {
  const ts = "2026-06-03T12:00:00.000Z";
  const rows = [
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
        content: [{ type: "text", text: "integration assistant reply" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
  ];
  for (let i = 0; i < errorCount; i++) {
    rows.push({
      type: "user",
      sessionId,
      timestamp: ts,
      uuid: `e-${sessionId}-${i}`,
      message: {
        content: [
          {
            type: "tool_result",
            content: [{ type: "text", text: "Error: command failed with exit code 2" }],
            is_error: true,
          },
        ],
      },
    });
  }
  return rows;
}

/** Claude session with N Read tool_use file_path entries for sort=files integration. */
function claudeSessionWithFiles(sessionId, fileCount, { prompt = "integration prompt" } = {}) {
  const ts = "2026-06-03T12:00:00.000Z";
  const toolUses = [];
  for (let i = 0; i < fileCount; i++) {
    toolUses.push({
      type: "tool_use",
      name: "Read",
      input: { file_path: `/src/serve-sort-file-${sessionId}-${i}.js` },
    });
  }
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
        content: toolUses,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
  ];
}

/** Three sessions with distinct durationMs for sort=duration integration (long → short). */
function seedDurationSortFixtureHome() {
  const home = mkTmp("tracequest-serve-dur-sort-home-");
  seedClaudeProject(
    home,
    "serve-dur-sort",
    "dur-short.jsonl",
    claudeSessionWithSortMetrics("sort-dur-short", {
      prompt: "short duration session",
      tStart: "2026-01-01T00:00:00.000Z",
      tEnd: "2026-01-01T00:00:10.000Z",
    }),
  );
  seedClaudeProject(
    home,
    "serve-dur-sort",
    "dur-mid.jsonl",
    claudeSessionWithSortMetrics("sort-dur-mid", {
      prompt: "mid duration session",
      tStart: "2026-01-01T00:00:00.000Z",
      tEnd: "2026-01-01T00:00:50.000Z",
    }),
  );
  seedClaudeProject(
    home,
    "serve-dur-sort",
    "dur-long.jsonl",
    claudeSessionWithSortMetrics("sort-dur-long", {
      prompt: "long duration session",
      tStart: "2026-01-01T00:00:00.000Z",
      tEnd: "2026-01-01T00:01:39.000Z",
    }),
  );
  return {
    home,
    durationFirstPrompts: ["long duration session", "mid duration session", "short duration session"],
    durationFirstMs: [99_000, 50_000, 10_000],
  };
}

/** Three sessions with distinct estimateCost for sort=cost integration (high → low). */
function seedCostSortFixtureHome() {
  const home = mkTmp("tracequest-serve-cost-sort-home-");
  seedClaudeProject(
    home,
    "serve-cost-sort",
    "cost-low.jsonl",
    claudeSessionWithSortMetrics("sort-cost-low", {
      prompt: "low cost session",
      usage: { input_tokens: 1_000, output_tokens: 100 },
    }),
  );
  seedClaudeProject(
    home,
    "serve-cost-sort",
    "cost-mid.jsonl",
    claudeSessionWithSortMetrics("sort-cost-mid", {
      prompt: "mid cost session",
      usage: { input_tokens: 10_000, output_tokens: 1_000 },
    }),
  );
  seedClaudeProject(
    home,
    "serve-cost-sort",
    "cost-high.jsonl",
    claudeSessionWithSortMetrics("sort-cost-high", {
      prompt: "high cost session",
      usage: { input_tokens: 100_000, output_tokens: 10_000 },
    }),
  );
  return {
    home,
    costFirstPrompts: ["high cost session", "mid cost session", "low cost session"],
  };
}

/** Three sessions with distinct error counts for sort=errors integration (high → low). */
function seedErrorsSortFixtureHome() {
  const home = mkTmp("tracequest-serve-err-sort-home-");
  seedClaudeProject(
    home,
    "serve-err-sort",
    "err-none.jsonl",
    claudeSessionWithErrors("sort-err-none", 0, { prompt: "zero errors session" }),
  );
  seedClaudeProject(
    home,
    "serve-err-sort",
    "err-few.jsonl",
    claudeSessionWithErrors("sort-err-few", 2, { prompt: "two errors session" }),
  );
  seedClaudeProject(
    home,
    "serve-err-sort",
    "err-many.jsonl",
    claudeSessionWithErrors("sort-err-many", 5, { prompt: "five errors session" }),
  );
  return {
    home,
    errorsFirstPrompts: ["five errors session", "two errors session", "zero errors session"],
    errorsFirstCounts: [5, 2, 0],
  };
}

/** Claude session with N Bash git commit tool_use entries for sort=commits integration. */
function claudeSessionWithCommits(sessionId, commitCount, { prompt = "integration prompt" } = {}) {
  const ts = "2026-06-03T12:00:00.000Z";
  const toolUses = [];
  for (let i = 0; i < commitCount; i++) {
    toolUses.push({
      type: "tool_use",
      id: `bash-${sessionId}-${i}`,
      name: "Bash",
      input: { command: `git commit -m "serve-sort-commit-${i}"` },
    });
  }
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
        content: toolUses,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
  ];
}

/** Claude session with N user turns for sort=chapters integration. */
function claudeSessionWithChapterCount(sessionId, chapterCount, { prompt = "integration prompt" } = {}) {
  const ts = "2026-06-03T12:00:00.000Z";
  const rows = [];
  for (let i = 0; i < chapterCount; i++) {
    rows.push({
      type: "user",
      sessionId,
      cwd: CLAUDE_FIXTURE_CWD,
      timestamp: ts,
      uuid: `u-${sessionId}-${i}`,
      isMeta: false,
      message: { content: [{ type: "text", text: `${prompt} turn ${i}` }] },
    });
  }
  rows.push({
    type: "assistant",
    sessionId,
    timestamp: ts,
    uuid: `a-${sessionId}`,
    message: {
      model: CLAUDE_FIXTURE_MODEL,
      content: [{ type: "text", text: "integration assistant reply" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  });
  return rows;
}

/** Claude session shaped for distinct grade scores (high / mid / low). */
function claudeSessionWithGradeProfile(
  sessionId,
  {
    prompt = "integration prompt",
    chapterCount = 4,
    errorCount = 0,
    bashToolUses = 4,
    usage = { input_tokens: 10_000, output_tokens: 1_000, cache_read_input_tokens: 8_000 },
  } = {},
) {
  const ts = "2026-06-03T12:00:00.000Z";
  const rows = [];
  for (let i = 0; i < chapterCount; i++) {
    rows.push({
      type: "user",
      sessionId,
      cwd: CLAUDE_FIXTURE_CWD,
      timestamp: ts,
      uuid: `u-${sessionId}-${i}`,
      isMeta: false,
      message: { content: [{ type: "text", text: `${prompt} ch ${i}` }] },
    });
  }
  const toolUses = [];
  for (let i = 0; i < bashToolUses; i++) {
    toolUses.push({
      type: "tool_use",
      id: `bash-${sessionId}-${i}`,
      name: "Bash",
      input: { command: `npm test -- shard ${i}` },
    });
  }
  rows.push({
    type: "assistant",
    sessionId,
    timestamp: ts,
    uuid: `a-${sessionId}`,
    message: {
      model: CLAUDE_FIXTURE_MODEL,
      content: toolUses,
      usage,
    },
  });
  for (let i = 0; i < errorCount; i++) {
    rows.push({
      type: "user",
      sessionId,
      timestamp: ts,
      uuid: `e-${sessionId}-${i}`,
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: `bash-${sessionId}-${i % bashToolUses}`,
            content: [{ type: "text", text: "Error: command failed with exit code 2" }],
            is_error: true,
          },
        ],
      },
    });
  }
  return rows;
}

/** Three sessions with distinct commit counts for sort=commits integration (high → low). */
function seedCommitsSortFixtureHome() {
  const home = mkTmp("tracequest-serve-cmt-sort-home-");
  seedClaudeProject(
    home,
    "serve-cmt-sort",
    "cmt-few.jsonl",
    claudeSessionWithCommits("sort-cmt-few", 1, { prompt: "one commit session" }),
  );
  seedClaudeProject(
    home,
    "serve-cmt-sort",
    "cmt-mid.jsonl",
    claudeSessionWithCommits("sort-cmt-mid", 3, { prompt: "three commits session" }),
  );
  seedClaudeProject(
    home,
    "serve-cmt-sort",
    "cmt-many.jsonl",
    claudeSessionWithCommits("sort-cmt-many", 6, { prompt: "six commits session" }),
  );
  return {
    home,
    commitsFirstPrompts: ["six commits session", "three commits session", "one commit session"],
    commitsFirstCounts: [6, 3, 1],
  };
}

/** Three sessions with distinct chapter counts for sort=chapters integration (high → low). */
function seedChaptersSortFixtureHome() {
  const home = mkTmp("tracequest-serve-ch-sort-home-");
  seedClaudeProject(
    home,
    "serve-ch-sort",
    "ch-few.jsonl",
    claudeSessionWithChapterCount("sort-ch-few", 2, { prompt: "two chapters session" }),
  );
  seedClaudeProject(
    home,
    "serve-ch-sort",
    "ch-mid.jsonl",
    claudeSessionWithChapterCount("sort-ch-mid", 5, { prompt: "five chapters session" }),
  );
  seedClaudeProject(
    home,
    "serve-ch-sort",
    "ch-many.jsonl",
    claudeSessionWithChapterCount("sort-ch-many", 9, { prompt: "nine chapters session" }),
  );
  return {
    home,
    chaptersFirstPrompts: ["nine chapters session turn 0", "five chapters session turn 0", "two chapters session turn 0"],
    chaptersFirstCounts: [9, 5, 2],
  };
}

/** Three sessions with distinct grade scores for sort=grade integration (high → low). */
function seedGradeSortFixtureHome() {
  const home = mkTmp("tracequest-serve-grd-sort-home-");
  seedClaudeProject(
    home,
    "serve-grd-sort",
    "grd-low.jsonl",
    claudeSessionWithGradeProfile("sort-grd-low", {
      prompt: "low grade session",
      chapterCount: 3,
      errorCount: 8,
      bashToolUses: 8,
      usage: { input_tokens: 30_000, output_tokens: 3_000, cache_read_input_tokens: 20_000 },
    }),
  );
  seedClaudeProject(
    home,
    "serve-grd-sort",
    "grd-mid.jsonl",
    claudeSessionWithGradeProfile("sort-grd-mid", {
      prompt: "mid grade session",
      chapterCount: 6,
      errorCount: 1,
      bashToolUses: 5,
      usage: { input_tokens: 15_000, output_tokens: 1_500, cache_read_input_tokens: 10_000 },
    }),
  );
  seedClaudeProject(
    home,
    "serve-grd-sort",
    "grd-high.jsonl",
    claudeSessionWithGradeProfile("sort-grd-high", {
      prompt: "high grade session",
      chapterCount: 8,
      errorCount: 0,
      bashToolUses: 5,
      usage: { input_tokens: 10_000, output_tokens: 1_000, cache_read_input_tokens: 8_000 },
    }),
  );
  return {
    home,
    gradeFirstPrompts: ["high grade session ch 0", "mid grade session ch 0", "low grade session ch 0"],
  };
}

/** Three sessions with distinct file counts for sort=files integration (high → low). */
function seedFilesSortFixtureHome() {
  const home = mkTmp("tracequest-serve-file-sort-home-");
  seedClaudeProject(
    home,
    "serve-file-sort",
    "files-few.jsonl",
    claudeSessionWithFiles("sort-files-few", 1, { prompt: "one file session" }),
  );
  seedClaudeProject(
    home,
    "serve-file-sort",
    "files-mid.jsonl",
    claudeSessionWithFiles("sort-files-mid", 4, { prompt: "four files session" }),
  );
  seedClaudeProject(
    home,
    "serve-file-sort",
    "files-many.jsonl",
    claudeSessionWithFiles("sort-files-many", 7, { prompt: "seven files session" }),
  );
  return {
    home,
    filesFirstPrompts: ["seven files session", "four files session", "one file session"],
    filesFirstCounts: [7, 4, 1],
  };
}

async function seedOpenCodeServeHome() {
  const home = mkTmp("tracequest-serve-opencode-home-");
  await seedOpenCodeIndexDb(home, [
    {
      id: OC_SERVE_SESSION_ID,
      title: "Serve OpenCode Integration",
      directory: OC_SERVE_PROJECT,
      messages: [
        {
          role: "user",
          parts: [{ type: "text", text: `hello ${OC_SERVE_MARKER}` }],
        },
        {
          role: "assistant",
          modelID: "gpt-4o",
          parts: [{ type: "text", text: "serve opencode assistant reply" }],
        },
        {
          role: "user",
          parts: [{ type: "text", text: "third turn for discovery msg-count threshold" }],
        },
      ],
    },
  ]);
  return { home, uri: OC_SERVE_URI };
}

function seedServeFixtureHome() {
  const home = mkTmp("tracequest-serve-home-");
  const sessionPath = seedClaudeProject(
    home,
    "serve-api-smoke",
    "smoke-session.jsonl",
    minimalClaudeSession("serve-view-1", { prompt: SEARCH_MARKER }),
  );
  const secondSessionPath = seedClaudeProject(
    home,
    "serve-api-smoke",
    "second-session.jsonl",
    minimalClaudeSession("serve-view-2", { prompt: "other prompt text" }),
  );
  seedClaudeProject(
    home,
    "serve-api-smoke",
    "third-session.jsonl",
    minimalClaudeSession("serve-view-3", { prompt: "third prompt text" }),
  );
  return { home, sessionPath, secondSessionPath };
}

describe("tests/serve-integration.md harness", () => {
  test("Test 1: /api/sessions returns valid JSON list envelope", async () => {
    const { home } = seedServeFixtureHome();
    trackHome(home);
    await withServe(home, async ({ httpGet: get }) => {
      const res = await get("/api/sessions");
      assert.equal(res.status, 200);
      assert.match(res.headers["content-type"], /application\/json/);
      const data = JSON.parse(res.body);
      assert.ok(Array.isArray(data.sessions));
      assert.ok(data.sessions.length >= 1);
      assert.equal(typeof data.total, "number");
      assert.equal(data.page, 1);
      assert.equal(data.pageSize, 50);
      assert.ok(data.stats && typeof data.stats === "object");
      assert.ok(Array.isArray(data.liveSessions));
      const first = data.sessions[0];
      for (const key of ["source", "project", "path", "id", "prompt"]) {
        assert.ok(key in first, `session should include ${key}`);
      }
    });
  });

  test("Test 2: /api/sessions pagination respects page and pageSize", async () => {
    const { home } = seedServeFixtureHome();
    trackHome(home);
    await withServe(home, async ({ httpGet: get }) => {
      const page1 = JSON.parse((await get("/api/sessions?page=1&pageSize=2")).body);
      assert.equal(page1.page, 1);
      assert.equal(page1.pageSize, 2);
      assert.equal(page1.sessions.length, 2);
      assert.equal(page1.total, 3);

      const page2 = JSON.parse((await get("/api/sessions?page=2&pageSize=2")).body);
      assert.equal(page2.page, 2);
      assert.equal(page2.sessions.length, 1);
    });
  });

  test("Test 3: /api/search?q=... returns matching sessions", async () => {
    const { home } = seedServeFixtureHome();
    trackHome(home);
    await withServe(home, async ({ httpGet: get }) => {
      const res = await get(`/api/search?q=${encodeURIComponent(SEARCH_MARKER)}`);
      assert.equal(res.status, 200);
      assert.match(res.headers["content-type"], /application\/json/);
      const data = JSON.parse(res.body);
      assert.ok(Array.isArray(data.results));
      assert.ok(data.results.length >= 1);
      const hit = data.results[0];
      for (const key of ["path", "source", "prompt", "matches"]) {
        assert.ok(key in hit, `search hit should include ${key}`);
      }
      assert.ok(hit.prompt.includes(SEARCH_MARKER));
      assert.ok(Array.isArray(hit.matches) && hit.matches.length >= 1);
    });
  });

  test("Test 4: /api/search empty and unmatched queries", async () => {
    const { home } = seedServeFixtureHome();
    trackHome(home);
    await withServe(home, async ({ httpGet: get }) => {
      const empty = JSON.parse((await get("/api/search?q=")).body);
      assert.deepEqual(empty, { results: [] });

      const miss = JSON.parse((await get("/api/search?q=zzzz-serve-no-match-token")).body);
      assert.deepEqual(miss.results, []);
    });
  });

  test("Test 5: /view?path=... renders session HTML", async () => {
    const { home, sessionPath } = seedServeFixtureHome();
    trackHome(home);
    await withServe(home, async ({ httpGet: get }) => {
      const res = await get(`/view?path=${encodeURIComponent(sessionPath)}`);
      assert.equal(res.status, 200);
      assert.match(res.headers["content-type"], /text\/html/);
      assert.match(res.body, /<html/i);
      assert.match(res.body, /SESSION\s*=/);
      assert.match(res.body, /serve-view-1/);
    });
  });

  test("Test 6: /export?path=... returns downloadable HTML", async () => {
    const { home, sessionPath } = seedServeFixtureHome();
    trackHome(home);
    await withServe(home, async ({ httpGet: get }) => {
      const res = await get(`/export?path=${encodeURIComponent(sessionPath)}`);
      assert.equal(res.status, 200);
      assert.match(res.headers["content-type"], /text\/html/);
      assert.match(res.headers["content-disposition"], /attachment/i);
      assert.match(res.headers["content-disposition"], /tracequest-.*\.html/i);
      assert.match(res.body, /SESSION\s*=/);
    });
  });

  test("Test 7: /markdown?path=... returns downloadable markdown", async () => {
    const { home, sessionPath } = seedServeFixtureHome();
    trackHome(home);
    await withServe(home, async ({ httpGet: get }) => {
      const res = await get(`/markdown?path=${encodeURIComponent(sessionPath)}`);
      assert.equal(res.status, 200);
      assert.match(res.headers["content-type"], /text\/markdown/);
      assert.match(res.headers["content-disposition"], /attachment/i);
      assert.match(res.headers["content-disposition"], /\.md/i);
      assert.ok(res.body.length > 0);
      assert.doesNotMatch(res.body, /<!DOCTYPE html>/i);
    });
  });

  test("Test 8: /raw?path=... returns JSONL attachment", async () => {
    const { home, sessionPath } = seedServeFixtureHome();
    trackHome(home);
    await withServe(home, async ({ httpGet: get }) => {
      const res = await get(`/raw?path=${encodeURIComponent(sessionPath)}`);
      assert.equal(res.status, 200);
      assert.match(res.headers["content-disposition"], /attachment/i);
      assert.match(res.headers["content-disposition"], /\.jsonl/i);
      assert.match(res.body, new RegExp(SEARCH_MARKER));
    });
  });

  test("Test 9: unknown route returns 404", async () => {
    const { home } = seedServeFixtureHome();
    trackHome(home);
    await withServe(home, async ({ httpGet: get }) => {
      const res = await get("/api/does-not-exist");
      assert.equal(res.status, 404);
      assert.equal(res.body, "Not found");
    });
  });

  test("Test 10: /view without path returns 400", async () => {
    const { home } = seedServeFixtureHome();
    trackHome(home);
    await withServe(home, async ({ httpGet: get }) => {
      const res = await get("/view");
      assert.equal(res.status, 400);
      assert.match(res.headers["content-type"], /text\/html/);
      assert.match(res.body, /<!DOCTYPE html>/i);
      assert.match(res.body, /data-view-state="error"/);
      assert.match(res.body, /Could not load session/);
      assert.match(res.body, /HTTP 400/);
      assert.match(res.body, /Missing path/);
      assert.match(res.body, /\(missing\)/);
      assert.match(res.body, /back to sessions/);
      assert.match(res.body, /EventSource\("\/__livereload"\)/);
    });
  });

  test("Test 11: /view forbidden path returns 403 without leaking path", async () => {
    const { home } = seedServeFixtureHome();
    trackHome(home);
    const secret = "/etc/passwd";
    await withServe(home, async ({ httpGet: get }) => {
      const res = await get(`/view?path=${encodeURIComponent(secret)}`);
      assert.equal(res.status, 403);
      assert.match(res.headers["content-type"], /text\/html/);
      assert.match(res.body, /<!DOCTYPE html>/i);
      assert.match(res.body, /data-view-state="error"/);
      assert.match(res.body, /Could not load session/);
      assert.match(res.body, /HTTP 403/);
      assert.match(res.body, /Forbidden: path is not a session file/);
      assert.ok(res.body.includes(secret));
      assert.match(res.body, /back to sessions/);
      assert.match(res.body, /EventSource\("\/__livereload"\)/);
    });
  });

  test("Test 13: GET / returns the chat surface HTML", async () => {
    const { home } = seedServeFixtureHome();
    trackHome(home);
    await withServe(home, async ({ httpGet: get }) => {
      const res = await get("/");
      assert.equal(res.status, 200);
      assert.match(res.headers["content-type"], /text\/html/);
      assert.match(res.body, /<!DOCTYPE html>/i);
      assert.match(res.body, /class="tq-shell"/);
      assert.match(res.body, /class="agent-rail"/);
      assert.match(res.body, /class="chat-composer"/);
      assert.match(res.body, /\/api\/sessions/);
      assert.doesNotMatch(res.body, /<title>Runs · tracequest<\/title>/i);
    });
  });

  test("Test 14: GET /compare?a=&b= renders session comparison HTML", async () => {
    const { home, sessionPath, secondSessionPath } = seedServeFixtureHome();
    trackHome(home);
    const comparePath =
      `/compare?a=${encodeURIComponent(sessionPath)}&b=${encodeURIComponent(secondSessionPath)}`;
    await withServe(home, async ({ httpGet: get }) => {
      const res = await get(comparePath);
      assert.equal(res.status, 200);
      assert.match(res.headers["content-type"], /text\/html/);
      assert.match(res.body, /session comparison/i);
      assert.match(res.body, /session-a/);
      assert.match(res.body, /session-b/);
      assert.match(res.body, /cmp-session-prompt/);
      assert.match(res.body, new RegExp(SEARCH_MARKER));
      assert.match(res.body, /other prompt text/);
      assert.match(res.body, /view full session/);
      assert.match(res.body, /\/view\?id=[0-9a-f]{8}/);
      assert.match(res.body, /Metrics/);
      assert.match(res.body, /Tool usage/);
    });
  });

  test("Test 35: GET /compare without param a returns 400", async () => {
    const { home, secondSessionPath } = seedServeFixtureHome();
    trackHome(home);
    await withServe(home, async ({ httpGet: get }) => {
      const res = await get(`/compare?b=${encodeURIComponent(secondSessionPath)}`);
      assert.equal(res.status, 400);
      assert.match(res.body, /<!DOCTYPE html>/i);
      assert.match(res.body, /data-compare-state="error"/);
      assert.match(res.body, /Could not load session A/);
      assert.match(res.body, /HTTP 400/);
      assert.match(res.body, /Missing compare parameter &quot;a&quot;/);
      assert.match(res.body, /\(missing\)/);
      assert.doesNotMatch(res.body, /<div class="cmp-sessions">/);
    });
  });

  test("Test 36: GET /compare with valid a but missing b returns 400", async () => {
    const { home, sessionPath } = seedServeFixtureHome();
    trackHome(home);
    await withServe(home, async ({ httpGet: get }) => {
      const res = await get(`/compare?a=${encodeURIComponent(sessionPath)}`);
      assert.equal(res.status, 400);
      assert.match(res.body, /<!DOCTYPE html>/i);
      assert.match(res.body, /data-compare-state="error"/);
      assert.match(res.body, /Could not load session B/);
      assert.match(res.body, /HTTP 400/);
      assert.match(res.body, /Missing compare parameter &quot;b&quot;/);
      assert.match(res.body, /\(missing\)/);
      assert.doesNotMatch(res.body, /<div class="cmp-sessions">/);
    });
  });

  test("Test 37: GET /compare with forbidden path returns 403", async () => {
    const { home, sessionPath } = seedServeFixtureHome();
    trackHome(home);
    await withServe(home, async ({ httpGet: get }) => {
      const res = await get(
        `/compare?a=${encodeURIComponent(sessionPath)}&b=${encodeURIComponent("/etc/passwd")}`,
      );
      assert.equal(res.status, 403);
      assert.match(res.headers["content-type"], /text\/html/);
      assert.match(res.body, /<!DOCTYPE html>/i);
      assert.match(res.body, /data-compare-state="error"/);
      assert.match(res.body, /Could not load session B/);
      assert.match(res.body, /HTTP 403/);
      assert.match(res.body, /Forbidden/);
      assert.ok(res.body.includes("/etc/passwd"));
      assert.match(res.body, /back to sessions/);
      assert.match(res.body, /EventSource\("\/__livereload"\)/);
      assert.doesNotMatch(res.body, /<div class="cmp-sessions">/);
      assert.doesNotMatch(res.body, /<table class="cmp-table">/);
    });
  });

  test("Test 15: GET /export without path returns 400", async () => {
    const { home } = seedServeFixtureHome();
    trackHome(home);
    await withServe(home, async ({ httpGet: get }) => {
      const res = await get("/export");
      assert.equal(res.status, 400);
      assert.equal(res.body, "Missing path");
      assert.doesNotMatch(res.body, /<!DOCTYPE html>/i);
      assert.equal(res.headers["content-disposition"], undefined);
    });
  });

  test("Test 16: /api/sessions?sort=recent returns sessions newest-first", async () => {
    const { home, recentFirstPrompts } = seedSortFixtureHome();
    trackHome(home);
    await withServe(home, async ({ httpGet: get }) => {
      const data = JSON.parse((await get("/api/sessions?sort=recent&pageSize=10")).body);
      assert.equal(data.sessions.length, 3);
      assert.deepEqual(
        data.sessions.map((s) => s.prompt),
        recentFirstPrompts,
      );
      assert.ok(data.sessions[0].mtime >= data.sessions[1].mtime);
      assert.ok(data.sessions[1].mtime >= data.sessions[2].mtime);
    });
  });

  test("Test 17: /api/sessions default sort matches recent (newest-first)", async () => {
    const { home, recentFirstPrompts } = seedSortFixtureHome();
    trackHome(home);
    await withServe(home, async ({ httpGet: get }) => {
      const data = JSON.parse((await get("/api/sessions?pageSize=10")).body);
      assert.deepEqual(
        data.sessions.map((s) => s.prompt),
        recentFirstPrompts,
      );
    });
  });

  test("Test 18: invalid sort param returns 200 and falls back to recent ordering", async () => {
    const { home, recentFirstPrompts, alphaFirstPrompts } = seedSortFixtureHome();
    trackHome(home);
    await withServe(home, async ({ httpGet: get }) => {
      for (const badSort of ["not-a-real-key", "name"]) {
        const res = await get(`/api/sessions?sort=${badSort}&pageSize=10`);
        assert.equal(res.status, 200, `sort=${badSort} should not error`);
        const data = JSON.parse(res.body);
        assert.deepEqual(
          data.sessions.map((s) => s.prompt),
          recentFirstPrompts,
          `sort=${badSort} should fall back to recent (mtime desc)`,
        );
        assert.notDeepEqual(
          data.sessions.map((s) => s.prompt),
          alphaFirstPrompts,
          `sort=${badSort} should not sort alphabetically by id`,
        );
      }
    });
  });

  test("Test 19: /export forbidden path returns 403 without leaking path", async () => {
    const { home } = seedServeFixtureHome();
    trackHome(home);
    const secret = "/etc/passwd";
    await withServe(home, async ({ httpGet: get }) => {
      const res = await get(`/export?path=${encodeURIComponent(secret)}`);
      assert.equal(res.status, 403);
      assert.equal(res.body, "Forbidden: path is not a session file");
      assert.equal(res.body.includes(secret), false);
    });
  });

  test("Test 20: /markdown forbidden path returns 403 without leaking path", async () => {
    const { home } = seedServeFixtureHome();
    trackHome(home);
    const secret = "/etc/passwd";
    await withServe(home, async ({ httpGet: get }) => {
      const res = await get(`/markdown?path=${encodeURIComponent(secret)}`);
      assert.equal(res.status, 403);
      assert.equal(res.body, "Forbidden: path is not a session file");
      assert.equal(res.body.includes(secret), false);
    });
  });

  test("Test 21: /raw forbidden path returns 403 without leaking path", async () => {
    const { home } = seedServeFixtureHome();
    trackHome(home);
    const secret = "/etc/passwd";
    await withServe(home, async ({ httpGet: get }) => {
      const res = await get(`/raw?path=${encodeURIComponent(secret)}`);
      assert.equal(res.status, 403);
      assert.equal(res.body, "Forbidden: path is not a session file");
      assert.equal(res.body.includes(secret), false);
    });
  });

  test("Test 22: two concurrent serve instances on different ports serve independently", async () => {
    const homeA = mkTmp("tracequest-serve-concurrent-a-");
    const homeB = mkTmp("tracequest-serve-concurrent-b-");
    trackHome(homeA);
    trackHome(homeB);
    seedClaudeProject(
      homeA,
      "concurrent-alpha",
      "alpha.jsonl",
      minimalClaudeSession("concurrent-a-1", { prompt: "concurrent-marker-alpha-only" }),
    );
    seedClaudeProject(
      homeB,
      "concurrent-beta",
      "beta.jsonl",
      minimalClaudeSession("concurrent-b-1", { prompt: "concurrent-marker-beta-only" }),
    );

    const portA = await allocEphemeralPort();
    const portB = await allocEphemeralPort();
    assert.notEqual(portA, portB);

    const childA = spawnServe(portA, homeA);
    const childB = spawnServe(portB, homeB);

    try {
      await Promise.all([waitForHttp(portA, "/api/sessions"), waitForHttp(portB, "/api/sessions")]);

      const dataA = JSON.parse((await httpGet(portA, "/api/sessions")).body);
      const dataB = JSON.parse((await httpGet(portB, "/api/sessions")).body);
      assert.equal(dataA.sessions.length, 1);
      assert.equal(dataB.sessions.length, 1);
      assert.match(dataA.sessions[0].prompt, /concurrent-marker-alpha-only/);
      assert.match(dataB.sessions[0].prompt, /concurrent-marker-beta-only/);
      assert.ok(!dataA.sessions[0].prompt.includes("concurrent-marker-beta"));
      assert.ok(!dataB.sessions[0].prompt.includes("concurrent-marker-alpha"));

      const missOnA = JSON.parse(
        (await httpGet(portA, "/api/search?q=concurrent-marker-beta-only")).body,
      );
      const missOnB = JSON.parse(
        (await httpGet(portB, "/api/search?q=concurrent-marker-alpha-only")).body,
      );
      assert.deepEqual(missOnA.results, []);
      assert.deepEqual(missOnB.results, []);

      const hitOnA = JSON.parse(
        (await httpGet(portA, "/api/search?q=concurrent-marker-alpha-only")).body,
      );
      const hitOnB = JSON.parse(
        (await httpGet(portB, "/api/search?q=concurrent-marker-beta-only")).body,
      );
      assert.equal(hitOnA.results.length, 1);
      assert.equal(hitOnB.results.length, 1);
    } finally {
      await stopServe(childA);
      await stopServe(childB);
      const idxA = serveChildren.indexOf(childA);
      if (idxA >= 0) serveChildren.splice(idxA, 1);
      const idxB = serveChildren.indexOf(childB);
      if (idxB >= 0) serveChildren.splice(idxB, 1);
    }

    await waitForProcessExit(childA, { label: "serve A" });
    await waitForProcessExit(childB, { label: "serve B" });
    await assertPortBindable(portA);
    await assertPortBindable(portB);
  });

  test("Test 23: /api/sessions lists OpenCode sessions from opencode.db", async () => {
    const { home, uri } = await seedOpenCodeServeHome();
    trackHome(home);
    await withServe(home, async ({ httpGet: get }) => {
      const data = JSON.parse((await get("/api/sessions")).body);
      assert.equal(data.sessions.length, 1);
      const session = data.sessions[0];
      assert.equal(session.source, "opencode");
      assert.equal(session.path, uri);
      assert.match(session.prompt, new RegExp(OC_SERVE_MARKER));
      assert.match(session.project, /serve-oc-integ/);
    });
  });

  test("Test 24: /view?path=opencode:// renders session HTML", async () => {
    const { home, uri } = await seedOpenCodeServeHome();
    trackHome(home);
    await withServe(home, async ({ httpGet: get }) => {
      const res = await get(`/view?path=${encodeURIComponent(uri)}`);
      assert.equal(res.status, 200);
      assert.match(res.headers["content-type"], /text\/html/);
      assert.match(res.body, /<html/i);
      assert.match(res.body, /SESSION\s*=/);
      assert.match(res.body, new RegExp(OC_SERVE_SESSION_ID));
      assert.match(res.body, new RegExp(OC_SERVE_MARKER));
    });
  });

  test("Test 25: /api/search indexes OpenCode session text", async () => {
    const { home } = await seedOpenCodeServeHome();
    trackHome(home);
    await withServe(home, async ({ httpGet: get }) => {
      const data = JSON.parse((await get(`/api/search?q=${encodeURIComponent(OC_SERVE_MARKER)}`)).body);
      assert.ok(data.results.length >= 1);
      const hit = data.results.find((r) => r.path === OC_SERVE_URI);
      assert.ok(hit, "search should return the OpenCode virtual URI");
      assert.equal(hit.source, "opencode");
      assert.ok(hit.prompt.includes(OC_SERVE_MARKER));
      assert.ok(Array.isArray(hit.matches) && hit.matches.length >= 1);
    });
  });

  test("Test 26: /api/sessions?sort=tokens orders by totalTokens descending", async () => {
    const { home, tokenFirstPrompts, tokenFirstTotals } = seedTokenSortFixtureHome();
    trackHome(home);
    await withServe(home, async ({ httpGet: get }) => {
      const data = JSON.parse((await get("/api/sessions?sort=tokens&pageSize=10")).body);
      assert.equal(data.sessions.length, 3);
      assert.deepEqual(
        data.sessions.map((s) => s.prompt),
        tokenFirstPrompts,
      );
      assert.deepEqual(
        data.sessions.map((s) => s.totalTokens),
        tokenFirstTotals,
      );
      assert.ok(data.sessions[0].totalTokens >= data.sessions[1].totalTokens);
      assert.ok(data.sessions[1].totalTokens >= data.sessions[2].totalTokens);
    });
  });

  test("Test 27: /api/sessions?sort=duration orders by durationMs descending", async () => {
    const { home, durationFirstPrompts, durationFirstMs } = seedDurationSortFixtureHome();
    trackHome(home);
    await withServe(home, async ({ httpGet: get }) => {
      const data = JSON.parse((await get("/api/sessions?sort=duration&pageSize=10")).body);
      assert.equal(data.sessions.length, 3);
      assert.deepEqual(
        data.sessions.map((s) => s.prompt),
        durationFirstPrompts,
      );
      assert.deepEqual(
        data.sessions.map((s) => s.durationMs),
        durationFirstMs,
      );
      assert.ok(data.sessions[0].durationMs >= data.sessions[1].durationMs);
      assert.ok(data.sessions[1].durationMs >= data.sessions[2].durationMs);
    });
  });

  test("Test 28: /api/sessions?sort=cost orders by estimateCost descending", async () => {
    const { home, costFirstPrompts } = seedCostSortFixtureHome();
    trackHome(home);
    await withServe(home, async ({ httpGet: get }) => {
      const data = JSON.parse((await get("/api/sessions?sort=cost&pageSize=10")).body);
      assert.equal(data.sessions.length, 3);
      assert.deepEqual(
        data.sessions.map((s) => s.prompt),
        costFirstPrompts,
      );
      const costs = data.sessions.map((s) => estimateCost(s));
      assert.ok(costs[0] >= costs[1]);
      assert.ok(costs[1] >= costs[2]);
      assert.ok(costs[0] > costs[2], "high-cost session should exceed low-cost session");
    });
  });

  test("Test 29: /api/sessions?sort=errors orders by errors descending", async () => {
    const { home, errorsFirstPrompts, errorsFirstCounts } = seedErrorsSortFixtureHome();
    trackHome(home);
    await withServe(home, async ({ httpGet: get }) => {
      const data = JSON.parse((await get("/api/sessions?sort=errors&pageSize=10")).body);
      assert.equal(data.sessions.length, 3);
      assert.deepEqual(
        data.sessions.map((s) => s.prompt),
        errorsFirstPrompts,
      );
      assert.deepEqual(
        data.sessions.map((s) => s.errors),
        errorsFirstCounts,
      );
      assert.ok(data.sessions[0].errors >= data.sessions[1].errors);
      assert.ok(data.sessions[1].errors >= data.sessions[2].errors);
    });
  });

  test("Test 30: /api/sessions?sort=files orders by files descending", async () => {
    const { home, filesFirstPrompts, filesFirstCounts } = seedFilesSortFixtureHome();
    trackHome(home);
    await withServe(home, async ({ httpGet: get }) => {
      const data = JSON.parse((await get("/api/sessions?sort=files&pageSize=10")).body);
      assert.equal(data.sessions.length, 3);
      assert.deepEqual(
        data.sessions.map((s) => s.prompt),
        filesFirstPrompts,
      );
      assert.deepEqual(
        data.sessions.map((s) => s.files),
        filesFirstCounts,
      );
      assert.ok(data.sessions[0].files >= data.sessions[1].files);
      assert.ok(data.sessions[1].files >= data.sessions[2].files);
    });
  });

  test("Test 31: /api/sessions?sort=commits orders by commits descending", async () => {
    const { home, commitsFirstPrompts, commitsFirstCounts } = seedCommitsSortFixtureHome();
    trackHome(home);
    await withServe(home, async ({ httpGet: get }) => {
      const data = JSON.parse((await get("/api/sessions?sort=commits&pageSize=10")).body);
      assert.equal(data.sessions.length, 3);
      assert.deepEqual(
        data.sessions.map((s) => s.prompt),
        commitsFirstPrompts,
      );
      assert.deepEqual(
        data.sessions.map((s) => s.commits),
        commitsFirstCounts,
      );
      assert.ok(data.sessions[0].commits >= data.sessions[1].commits);
      assert.ok(data.sessions[1].commits >= data.sessions[2].commits);
    });
  });

  test("Test 32: /api/sessions?sort=chapters orders by chapters descending", async () => {
    const { home, chaptersFirstPrompts, chaptersFirstCounts } = seedChaptersSortFixtureHome();
    trackHome(home);
    await withServe(home, async ({ httpGet: get }) => {
      const data = JSON.parse((await get("/api/sessions?sort=chapters&pageSize=10")).body);
      assert.equal(data.sessions.length, 3);
      assert.deepEqual(
        data.sessions.map((s) => s.prompt),
        chaptersFirstPrompts,
      );
      assert.deepEqual(
        data.sessions.map((s) => s.chapters),
        chaptersFirstCounts,
      );
      assert.ok(data.sessions[0].chapters >= data.sessions[1].chapters);
      assert.ok(data.sessions[1].chapters >= data.sessions[2].chapters);
    });
  });

  test("Test 34: /api/sessions?sort=date alias matches recent (newest-first)", async () => {
    const { home, recentFirstPrompts } = seedSortFixtureHome();
    trackHome(home);
    await withServe(home, async ({ httpGet: get }) => {
      const data = JSON.parse((await get("/api/sessions?sort=date&pageSize=10")).body);
      assert.equal(data.sessions.length, 3);
      assert.deepEqual(
        data.sessions.map((s) => s.prompt),
        recentFirstPrompts,
        "sort=date should alias sort=recent (mtime desc)",
      );
      assert.ok(data.sessions[0].mtime >= data.sessions[1].mtime);
      assert.ok(data.sessions[1].mtime >= data.sessions[2].mtime);
    });
  });

  test("Test 33: /api/sessions?sort=grade orders by grade score descending", async () => {
    const { home, gradeFirstPrompts } = seedGradeSortFixtureHome();
    trackHome(home);
    await withServe(home, async ({ httpGet: get }) => {
      const data = JSON.parse((await get("/api/sessions?sort=grade&pageSize=10")).body);
      assert.equal(data.sessions.length, 3);
      assert.deepEqual(
        data.sessions.map((s) => s.prompt),
        gradeFirstPrompts,
      );
      const scores = data.sessions.map((s) => computeGrade(s).score);
      assert.ok(scores[0] >= scores[1]);
      assert.ok(scores[1] >= scores[2]);
      assert.ok(scores[0] > scores[2], "high-grade session should exceed low-grade session");
    });
  });

  test("Test 38: three concurrent serve instances on different ports serve independently", async () => {
    const homeA = mkTmp("tracequest-serve-concurrent-a-");
    const homeB = mkTmp("tracequest-serve-concurrent-b-");
    const homeC = mkTmp("tracequest-serve-concurrent-c-");
    trackHome(homeA);
    trackHome(homeB);
    trackHome(homeC);
    seedClaudeProject(
      homeA,
      "concurrent-alpha",
      "alpha.jsonl",
      minimalClaudeSession("concurrent-a-1", { prompt: "concurrent-marker-alpha-only" }),
    );
    seedClaudeProject(
      homeB,
      "concurrent-beta",
      "beta.jsonl",
      minimalClaudeSession("concurrent-b-1", { prompt: "concurrent-marker-beta-only" }),
    );
    seedClaudeProject(
      homeC,
      "concurrent-gamma",
      "gamma.jsonl",
      minimalClaudeSession("concurrent-c-1", { prompt: "concurrent-marker-gamma-only" }),
    );

    const portA = await allocEphemeralPort();
    const portB = await allocEphemeralPort();
    const portC = await allocEphemeralPort();
    assert.notEqual(portA, portB);
    assert.notEqual(portB, portC);
    assert.notEqual(portA, portC);

    const childA = spawnServe(portA, homeA);
    const childB = spawnServe(portB, homeB);
    const childC = spawnServe(portC, homeC);

    try {
      await Promise.all([
        waitForHttp(portA, "/api/sessions"),
        waitForHttp(portB, "/api/sessions"),
        waitForHttp(portC, "/api/sessions"),
      ]);

      const [dataA, dataB, dataC] = await Promise.all([
        httpGet(portA, "/api/sessions").then((r) => JSON.parse(r.body)),
        httpGet(portB, "/api/sessions").then((r) => JSON.parse(r.body)),
        httpGet(portC, "/api/sessions").then((r) => JSON.parse(r.body)),
      ]);
      assert.equal(dataA.sessions.length, 1);
      assert.equal(dataB.sessions.length, 1);
      assert.equal(dataC.sessions.length, 1);
      assert.match(dataA.sessions[0].prompt, /concurrent-marker-alpha-only/);
      assert.match(dataB.sessions[0].prompt, /concurrent-marker-beta-only/);
      assert.match(dataC.sessions[0].prompt, /concurrent-marker-gamma-only/);

      const markers = ["alpha-only", "beta-only", "gamma-only"];
      const ports = [portA, portB, portC];
      const datasets = [dataA, dataB, dataC];
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          if (i === j) continue;
          const marker = `concurrent-marker-${markers[j]}`;
          const res = JSON.parse((await httpGet(ports[i], `/api/search?q=${marker}`)).body);
          assert.deepEqual(res.results, [], `port ${ports[i]} must not see ${marker}`);
          assert.ok(!datasets[i].sessions[0].prompt.includes(marker));
        }
      }
    } finally {
      for (const child of [childA, childB, childC]) {
        await stopServe(child);
        const idx = serveChildren.indexOf(child);
        if (idx >= 0) serveChildren.splice(idx, 1);
      }
    }

    await Promise.all([
      waitForProcessExit(childA, { label: "serve A" }),
      waitForProcessExit(childB, { label: "serve B" }),
      waitForProcessExit(childC, { label: "serve C" }),
    ]);
    await Promise.all([assertPortBindable(portA), assertPortBindable(portB), assertPortBindable(portC)]);
  });

  test("Test 39: rapid serve start/stop cycles do not leak ports", async () => {
    const home = mkTmp("tracequest-serve-rapid-cycle-");
    trackHome(home);
    seedClaudeProject(
      home,
      "rapid-cycle",
      "sess.jsonl",
      minimalClaudeSession("rapid-cycle-1", { prompt: "rapid-cycle-marker-xyz" }),
    );

    const port = await allocEphemeralPort();
    const cycles = 5;

    for (let i = 0; i < cycles; i++) {
      const child = spawnServe(port, home);
      try {
        await waitForHttp(port, "/api/sessions");
        const data = JSON.parse((await httpGet(port, "/api/sessions")).body);
        assert.equal(data.sessions.length, 1, `cycle ${i + 1} should list seeded session`);
        assert.match(data.sessions[0].prompt, /rapid-cycle-marker-xyz/);
      } finally {
        await stopServe(child);
        const idx = serveChildren.indexOf(child);
        if (idx >= 0) serveChildren.splice(idx, 1);
        await waitForProcessExit(child, { label: `serve cycle ${i + 1}`, timeoutMs: 8_000 });
      }
    }

    await assertPortBindable(port);
  });

  test("Test 12: serve --filter scopes API session list", async () => {
    const home = mkTmp("tracequest-serve-filter-home-");
    trackHome(home);
    seedClaudeProject(
      home,
      "serve-filter-alpha",
      "alpha.jsonl",
      minimalClaudeSession("serve-filter-alpha-1", { prompt: "alpha only" }),
    );
    seedClaudeProject(
      home,
      "serve-filter-beta",
      "beta.jsonl",
      minimalClaudeSession("serve-filter-beta-1", { prompt: "beta only" }),
    );
    await withServe(
      home,
      async ({ httpGet: get }) => {
        const data = JSON.parse((await get("/api/sessions")).body);
        assert.ok(data.sessions.length >= 1);
        for (const s of data.sessions) {
          assert.match(s.project, /serve-filter-alpha/);
          assert.ok(!String(s.project).includes("serve-filter-beta"));
        }
      },
      { serveArgs: ["--filter", "serve-filter-alpha"] },
    );
  });

  test("Test 40: serve --filter scopes /api/search to matching sessions", async () => {
    const ALPHA_MARKER = "serve-filter-search-alpha-marker-xyz";
    const BETA_MARKER = "serve-filter-search-beta-marker-xyz";
    const home = mkTmp("tracequest-serve-filter-search-home-");
    trackHome(home);
    seedClaudeProject(
      home,
      "serve-filter-alpha",
      "alpha-search.jsonl",
      minimalClaudeSession("serve-filter-alpha-search", { prompt: ALPHA_MARKER }),
    );
    seedClaudeProject(
      home,
      "serve-filter-beta",
      "beta-search.jsonl",
      minimalClaudeSession("serve-filter-beta-search", { prompt: BETA_MARKER }),
    );
    await withServe(
      home,
      async ({ httpGet: get }) => {
        const alphaHit = JSON.parse((await get(`/api/search?q=${encodeURIComponent(ALPHA_MARKER)}`)).body);
        assert.equal(alphaHit.results.length, 1);
        assert.match(alphaHit.results[0].prompt, new RegExp(ALPHA_MARKER));
        assert.match(alphaHit.results[0].project, /serve-filter-alpha/);

        const betaMiss = JSON.parse((await get(`/api/search?q=${encodeURIComponent(BETA_MARKER)}`)).body);
        assert.deepEqual(betaMiss.results, []);
      },
      { serveArgs: ["--filter", "serve-filter-alpha"] },
    );
  });

  test("Test 41: /api/sessions?expr= compound expression filters API list", async () => {
    const home = mkTmp("tracequest-serve-expr-api-home-");
    trackHome(home);
    seedClaudeProject(
      home,
      "serve-expr-alpha",
      "alpha-sonnet.jsonl",
      minimalClaudeSession("serve-expr-alpha-sonnet", {
        model: "claude-sonnet-4-20250514",
        prompt: "serve-expr-alpha-sonnet-marker",
      }),
    );
    seedClaudeProject(
      home,
      "serve-expr-alpha",
      "alpha-opus.jsonl",
      minimalClaudeSession("serve-expr-alpha-opus", {
        model: "claude-opus-4-20250514",
        prompt: "serve-expr-alpha-opus-marker",
      }),
    );
    seedClaudeProject(
      home,
      "serve-expr-beta",
      "beta-sonnet.jsonl",
      minimalClaudeSession("serve-expr-beta-sonnet", {
        model: "claude-sonnet-4-20250514",
        prompt: "serve-expr-beta-sonnet-marker",
      }),
    );
    await withServe(home, async ({ httpGet: get }) => {
      const expr = encodeURIComponent("project:serve-expr-alpha AND model:sonnet");
      const data = JSON.parse((await get(`/api/sessions?expr=${expr}`)).body);
      assert.equal(data.total, 1);
      assert.equal(data.sessions.length, 1);
      assert.match(data.sessions[0].project, /serve-expr-alpha/);
      assert.match(data.sessions[0].model, /sonnet/i);
      assert.match(data.sessions[0].path, /alpha-sonnet\.jsonl$/);
      assert.match(data.sessions[0].prompt, /serve-expr-alpha-sonnet-marker/);
    });
  });

  test("Test 42: /api/search?expr= compound expression filters search hits", async () => {
    const SHARED_MARKER = "serve-search-expr-shared-marker-xyz";
    const home = mkTmp("tracequest-serve-search-expr-home-");
    trackHome(home);
    seedClaudeProject(
      home,
      "serve-search-expr-alpha",
      "alpha-sonnet.jsonl",
      minimalClaudeSession("serve-search-expr-alpha-sonnet", {
        model: "claude-sonnet-4-20250514",
        prompt: `${SHARED_MARKER} alpha sonnet`,
      }),
    );
    seedClaudeProject(
      home,
      "serve-search-expr-alpha",
      "alpha-opus.jsonl",
      minimalClaudeSession("serve-search-expr-alpha-opus", {
        model: "claude-opus-4-20250514",
        prompt: `${SHARED_MARKER} alpha opus`,
      }),
    );
    seedClaudeProject(
      home,
      "serve-search-expr-beta",
      "beta-sonnet.jsonl",
      minimalClaudeSession("serve-search-expr-beta-sonnet", {
        model: "claude-sonnet-4-20250514",
        prompt: `${SHARED_MARKER} beta sonnet`,
      }),
    );
    await withServe(home, async ({ httpGet: get }) => {
      const q = encodeURIComponent(SHARED_MARKER);
      const expr = encodeURIComponent("project:serve-search-expr-alpha AND model:sonnet");
      const data = JSON.parse((await get(`/api/search?q=${q}&expr=${expr}`)).body);
      assert.equal(data.results.length, 1);
      assert.match(data.results[0].project, /serve-search-expr-alpha/);
      assert.match(data.results[0].model, /sonnet/i);
      assert.match(data.results[0].path, /alpha-sonnet\.jsonl$/);
      assert.match(data.results[0].prompt, /alpha sonnet/);
    });
  });
});
