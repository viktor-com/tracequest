import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseFilterExpr, evalFilterExpr } from "../../src/filter/filter.js";
import { sessionToApiObject } from "../../src/server/server-helpers.js";
import { searchSessions } from "../../src/sessions/scan-queries.js";
import { sessionMtimeMs } from "../../src/sessions/session-list.js";
import {
  flushDeferredIndexWriteForTests,
  flushDeferredSearchIdxWriteForTests,
  resetIndexWritersForTests,
  indexPath,
  isNativeExecutable,
  INDEX_VERSION,
} from "../../src/sessions/index-writers.js";
import { SIDECAR_PATH_ENV, SIDECAR_SKIP_ENV } from "./sidecar-mock.js";
import { FIXED_NOW } from "./multi-source-fixtures.js";
import { bumpFileMtime, mkTmp, writeJsonl } from "./fixtures.js";

export { bumpFileMtime };

const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const SEARCH_INDEX_KEYS = ["firstPrompt", "tools", "errors", "model"];

/** Resolve a real Rust sidecar binary; ignore Node mock scripts from other tests. */
export function resolveSidecarBinary() {
  const candidates = [
    path.join(PROJECT_ROOT, "sidecar/target/release/tracequest-sidecar"),
    path.join(PROJECT_ROOT, "sidecar/target/debug/tracequest-sidecar"),
  ];
  for (const c of candidates) {
    if (isNativeExecutable(c)) return c;
  }
  try {
    const which = spawnSync("which", ["tracequest-sidecar"], { encoding: "utf-8" });
    if (which.status === 0) {
      const p = which.stdout.trim();
      if (p && isNativeExecutable(p)) return p;
    }
  } catch {
    /* PATH lookup optional */
  }
  return null;
}

export const SIDECAR_BIN = resolveSidecarBinary();
export const SKIP_NO_SIDECAR = SIDECAR_BIN
  ? {}
  : { skip: "tracequest-sidecar not built (npm run build:sidecar)" };

export const PARITY_KEYS = [
  "firstPrompt",
  "model",
  "tools",
  "toolCounts",
  "chapters",
  "totalTokens",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "durationMs",
  "errors",
  "files",
  "commits",
];

export const MINIMAL_PARITY_LINES = [
  {
    type: "user",
    message: { content: "parity probe prompt" },
    timestamp: "2026-06-03T10:00:00.000Z",
  },
  {
    type: "assistant",
    message: {
      model: "claude-3-sonnet",
      content: [
        { type: "tool_use", name: "bash", input: { command: "git commit -m parity" } },
        { type: "text", text: "assistant reply text" },
      ],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20 },
    },
    timestamp: "2026-06-03T10:01:00.000Z",
  },
];

export function assertGrokToolCountsParity(jsMeta, sidecarMeta, label) {
  assert.deepEqual(jsMeta.toolCounts, sidecarMeta.toolCounts, `${label}: toolCounts`);
  assert.deepEqual(
    [...(jsMeta.tools || [])].sort(),
    [...(sidecarMeta.tools || [])].sort(),
    `${label}: tools`,
  );
}

export function assertIndexParity(jsMeta, sidecarMeta, label = "minimal") {
  for (const key of PARITY_KEYS) {
    if (key === "tools") {
      assert.deepEqual(
        [...(jsMeta.tools || [])].sort(),
        [...(sidecarMeta.tools || [])].sort(),
        `${label}: ${key}`,
      );
      continue;
    }
    if (key === "toolCounts") {
      assert.deepEqual(jsMeta.toolCounts, sidecarMeta.toolCounts, `${label}: ${key}`);
      continue;
    }
    assert.equal(jsMeta[key], sidecarMeta[key], `${label}: ${key}`);
  }
  assert.equal(typeof sidecarMeta.mtime, "number", `${label}: sidecar sets mtime`);
}

export function indexViaSidecar(bin, session) {
  const cacheFile = path.join(os.tmpdir(), `tq-sidecar-parity-${process.pid}.json`);
  const mtime = sessionMtimeMs(session);
  const sessionsJson = JSON.stringify([{ ...session, mtime }]);
  const result = spawnSync(
    bin,
    [
      "index",
      "--index-path",
      cacheFile,
      "--version",
      String(INDEX_VERSION),
      "--sessions-stdin",
    ],
    { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024, input: sessionsJson },
  );
  assert.equal(
    result.status,
    0,
    `sidecar index failed: ${(result.stderr || "").trim().slice(0, 300)}`,
  );
  const map = JSON.parse(result.stdout);
  const entry = map[session.path];
  assert.ok(entry, `sidecar index missing entry for ${session.path}`);
  try {
    fs.unlinkSync(cacheFile);
  } catch {
    /* best-effort */
  }
  return entry;
}

export function withGrokSession({ events, chat, dirName = "grok-sess" }, fn) {
  const tmpDir = mkTmp("tq-sidecar-parity-grok-");
  const sessionDir = path.join(tmpDir, dirName);
  fs.mkdirSync(sessionDir, { recursive: true });
  if (events?.length) writeJsonl(path.join(sessionDir, "events.jsonl"), events);
  const chatPath = path.join(sessionDir, "chat_history.jsonl");
  writeJsonl(chatPath, chat);
  const stat = fs.statSync(chatPath);
  const session = {
    path: sessionDir,
    project: "parity-probe",
    file: dirName,
    source: "grok",
    size: stat.size,
    mtime: stat.mtime,
  };
  try {
    return fn(sessionDir, session);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function withMinimalSession(fn) {
  const tmpDir = mkTmp("tq-sidecar-parity-");
  const filePath = path.join(tmpDir, "minimal.jsonl");
  writeJsonl(filePath, MINIMAL_PARITY_LINES);
  const stat = fs.statSync(filePath);
  const session = {
    path: filePath,
    project: "parity-probe",
    file: "minimal.jsonl",
    source: "claude",
    size: stat.size,
    mtime: stat.mtime,
  };
  try {
    return fn(filePath, session);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function assertIndexSearchParity(jsMeta, sidecarMeta, sessionPath) {
  for (const key of SEARCH_INDEX_KEYS) {
    if (key === "tools") {
      assert.deepEqual(
        [...(jsMeta.tools || [])].sort(),
        [...(sidecarMeta.tools || [])].sort(),
        `${sessionPath}: ${key}`,
      );
      continue;
    }
    assert.equal(jsMeta[key], sidecarMeta[key], `${sessionPath}: ${key}`);
  }
}

export function assertSearchParity(jsHits, sidecarHits, label, { includePromptModel = true } = {}) {
  assert.equal(jsHits.length, sidecarHits.length, `${label}: hit count`);
  const jsPaths = jsHits.map((h) => h.path).sort();
  const sidecarPaths = sidecarHits.map((h) => h.path).sort();
  assert.deepEqual(sidecarPaths, jsPaths, `${label}: paths`);

  const jsByPath = new Map(jsHits.map((h) => [h.path, h]));
  const scByPath = new Map(sidecarHits.map((h) => [h.path, h]));
  for (const p of jsPaths) {
    const js = jsByPath.get(p);
    const sc = scByPath.get(p);
    assert.equal(js.source, sc.source, `${label}: ${p} source`);
    if (includePromptModel) {
      assert.equal(js.prompt, sc.prompt, `${label}: ${p} prompt`);
      assert.equal(js.model, sc.model, `${label}: ${p} model`);
    }
    assert.equal(js.matches.length, sc.matches.length, `${label}: ${p} match count`);
    for (let i = 0; i < js.matches.length; i++) {
      assert.equal(js.matches[i].type, sc.matches[i].type, `${label}: ${p} match[${i}].type`);
      assert.equal(js.matches[i].snippet, sc.matches[i].snippet, `${label}: ${p} match[${i}].snippet`);
    }
  }
}

export function searchWithExprFilter(sessions, index, query, opts = {}) {
  const { expr = null, sessionFilter = null, maxResults = 50, now = FIXED_NOW } = opts;
  let scoped = sessionFilter ? sessions.filter(sessionFilter) : sessions;
  if (expr?.trim()) {
    const ast = parseFilterExpr(expr);
    if (ast) {
      scoped = scoped.filter((s) => {
        const meta = index.get(s.path) || {};
        const api = sessionToApiObject(s, meta);
        api.live = false;
        return evalFilterExpr(api, ast, now);
      });
    }
  }
  return searchSessions(scoped, index, query, maxResults);
}

export function runParitySearch(sessions, jsIndex, sidecarIndex, query, opts = {}) {
  const { includePromptModel = true, ...searchOpts } = opts;
  const jsHits = searchWithExprFilter(sessions, jsIndex, query, searchOpts);
  const sidecarHits = searchWithExprFilter(sessions, sidecarIndex, query, searchOpts);
  assertSearchParity(jsHits, sidecarHits, query, { includePromptModel });
  return { jsHits, sidecarHits };
}

export function clearDiskIndexCache() {
  flushDeferredIndexWriteForTests();
  try {
    fs.unlinkSync(indexPath());
  } catch {
    /* no prior cache */
  }
  resetIndexWritersForTests();
}

export function useJsPipeline() {
  process.env[SIDECAR_SKIP_ENV.NO_SIDECAR] = "1";
  delete process.env[SIDECAR_PATH_ENV];
}

export function useSidecarPipeline() {
  delete process.env[SIDECAR_SKIP_ENV.NO_SIDECAR];
  process.env[SIDECAR_PATH_ENV] = SIDECAR_BIN;
}

