import {
  existsSync,
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir, availableParallelism } from "node:os";
import { Worker, MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sessionMtimeMs } from "./session-list.js";
import { openCodeEntryReadNoMessages, openCodeIndexer } from "./session-index-opencode.js";
import { codexHealModel } from "./session-index-jsonl.js";
import { readClaudeSpanTrims, readClaudeSpanTrimsAsync } from "./claude-span-heal.js";
import { ACTIVE_TIME_SOURCES, STALL_MS } from "./active-time.js";
import { isIndexDiskExpectedErr, isWorkerTerminateExpectedErr } from "../utils/fs-expected-err.js";
import { isNativeExecutable as isNativeExecutableMagic } from "./native-executable.js";
import { safeSlice, truncateFirstPrompt } from "../parse/parse-utils.js";
import {
  getSearchIndex,
  loadSearchIndex,
  searchIdxPath,
  scheduleSearchIdxWrite,
  flushSearchIdxWriteForTests as _flushSearchIdxWriteForTests,
  resetSearchIndexForTests as _resetSearchIndexForTests,
} from "./search-index.js";

// Bump this when index fields change to invalidate stale cache entries.
export const INDEX_VERSION = 11;

/**
 * Codex entry format, stored as index.json's top-level `_codex` (fact cdxheal).
 * Format 2 records the turn_context model id; earlier entries carry the
 * session_meta provider ("openai"). Format 3 also records, for a rollout
 * without a turn_context model, its thread_settings_applied or provenance
 * model (fact cdxheal3). Format 4 also counts a review sub-thread's prompt
 * and commands (fact cdxsub). An index without the current marker gets
 * its cached codex rows' model ids healed once (applyCodexCacheModels), and
 * its cached codex rows with neither a prompt nor a tool re-indexed once
 * (fact cdxsub2), instead of an INDEX_VERSION bump that would re-index every
 * source and drop the insights cache.
 * Mirrors sidecar CODEX_INDEX_FORMAT.
 */
export const CODEX_INDEX_FORMAT = 4;

/**
 * A cached codex row an index from before fact cdxsub may have left empty:
 * no prompt and no tool call (a review rollout whose work is all in its
 * sub-thread's item_completed events). Re-indexed once (fact cdxsub2).
 */
function codexRowMayMissSubThread(entry) {
  if (entry.firstPrompt) return false;
  const counts = entry.toolCounts;
  return !counts || typeof counts !== "object" || Object.keys(counts).length === 0;
}

/**
 * Claude span format, stored as index.json's top-level `_spans` (fact durcl2).
 * Format 1 ends a Claude session's durationMs at its last user/assistant line
 * (fact durcl). An index without the marker gets its cached Claude rows'
 * durations corrected once from each file's tail (applyClaudeSpanTrims)
 * instead of an INDEX_VERSION bump. Only that heal sets the marker.
 */
export const CLAUDE_SPAN_FORMAT = 1;

/**
 * Duration format, stored as index.json's top-level `_active` (fact durac2).
 * Format 1 indexed a Claude Code, Codex, OpenCode, Factory or Grok session's
 * durationMs as the time it was worked on; format 2 counts a long gap ending at
 * a tool result only for a long-running tool (fact durac). An index without the
 * current marker has its cached rows of those sources longer than STALL_MS
 * re-indexed once (queueActiveTimeReindex) instead of an INDEX_VERSION bump: a
 * shorter row has no long gap, so no format changes its duration.
 */
export const ACTIVE_TIME_FORMAT = 2;

/** Top-level index.json keys that are not session paths. */
const INDEX_META_KEYS = new Set(["_v", "_codex", "_spans", "_active"]);

function markIndexCurrent(cache) {
  cache._v = INDEX_VERSION;
  cache._codex = CODEX_INDEX_FORMAT;
}

/**
 * Give mtime-matched codex rows from an index without the current `_codex`
 * marker their turn_context model id (fact cdxheal). Only the head of each
 * rollout is read — everything else in the row is already current — and the
 * marked index is written before the sidecar reads index.json, so this runs
 * once per old index rather than re-parsing gigabytes of codex recordings.
 * The reads are a driver step (`{ codexHeal: paths }`): the server's driver
 * runs them in short slices that yield the event loop (fact cdxheal2).
 */
function applyCodexCacheModels(cache, paths, models, t0) {
  let updated = 0;
  for (const p of paths) {
    const model = models.get(p);
    if (model && cache[p] && cache[p].model !== model) {
      cache[p].model = model;
      updated++;
    }
  }
  markIndexCurrent(cache);
  _indexFileCache = cache;
  syncIndexCachePathCount(cache);
  try {
    writeIndexFileToDisk();
  } catch (err) {
    console.warn("  codex model index write failed:", err.message);
    scheduleIndexWrite();
  }
  indexStatus(`tracequest: codex model ids checked for ${paths.length} cached session${paths.length !== 1 ? "s" : ""} (${updated} updated) in ${Date.now() - t0}ms`);
}

/**
 * Take each cached Claude row's trailer off its durationMs (fact durcl2). A row
 * whose tail read could not tell is dropped from the cache and queued stale,
 * so the sidecar (which reuses index.json rows by mtime) indexes it afresh.
 * The marked index is written at once, before any sidecar run reads it.
 */
function applyClaudeSpanTrims(cache, result, hits, trims, staleSessions, t0) {
  let trimmed = 0;
  let reindexed = 0;
  for (const hit of hits) {
    const p = hit.session.path;
    const entry = cache[p];
    if (!entry || typeof entry !== "object") continue;
    const trim = trims.get(p);
    if (trim === null || trim === undefined) {
      delete cache[p];
      result.delete(p);
      staleSessions.push(hit);
      reindexed++;
    } else if (trim > 0) {
      entry.durationMs = Math.max(0, (entry.durationMs || 0) - trim);
      result.set(p, entry);
      trimmed++;
    }
  }
  cache._spans = CLAUDE_SPAN_FORMAT;
  // Nothing corrected: the marker rides along with the next index write.
  if (trimmed || reindexed) {
    _indexFileCache = cache;
    syncIndexCachePathCount(cache);
    try {
      writeIndexFileToDisk();
    } catch (err) {
      console.warn("  claude span index write failed:", err.message);
      scheduleIndexWrite();
    }
  }
  indexStatus(`tracequest: claude session spans checked for ${hits.length} cached session${hits.length !== 1 ? "s" : ""} (${trimmed} shortened, ${reindexed} to re-index) in ${Date.now() - t0}ms`);
}

/**
 * Queue the cached rows an index from before fact durac measured as a wall
 * span for one re-index (fact durac2): `hits` are the mtime-current rows of
 * the active-time sources whose durationMs is longer than STALL_MS (of
 * `checked` such rows). Returns their paths; the sidecar must re-read them
 * although their mtime matches the index.json rows it would otherwise reuse.
 */
function queueActiveTimeReindex(cache, result, hits, staleSessions, checked) {
  const paths = [];
  for (const hit of hits) {
    if (!result.delete(hit.session.path)) continue;
    staleSessions.push(hit);
    paths.push(hit.session.path);
  }
  cache._active = ACTIVE_TIME_FORMAT;
  indexStatus(`tracequest: session durations checked for ${checked} cached session${checked !== 1 ? "s" : ""} (${paths.length} to re-index as worked time)`);
  return paths;
}

/**
 * Persist re-measured rows and their `_active` marker at once rather than
 * after the write debounce (which keeps moving while sessions change): a
 * restart after a crash must not re-index them again (fact durac2).
 */
function writeActiveTimeHealNow(cache) {
  cache._active = ACTIVE_TIME_FORMAT;
  try {
    writeIndexFileToDisk();
  } catch (err) {
    console.warn("  session duration index write failed:", err.message);
  }
}

/** Model id (codexHealModel) of each codex rollout in `paths` (synchronous driver). */
function readCodexModels(paths) {
  const models = new Map();
  for (const p of paths) models.set(p, codexHealModel(p));
  return models;
}

/** Event-loop time one slice of readCodexModelsAsync may take before yielding. */
const CODEX_HEAL_SLICE_MS = 15;

/** readCodexModels in slices of at most ~15 ms, yielding the event loop between them. */
async function readCodexModelsAsync(paths) {
  const models = new Map();
  let sliceStart = Date.now();
  for (const p of paths) {
    models.set(p, codexHealModel(p));
    if (Date.now() - sliceStart >= CODEX_HEAL_SLICE_MS) {
      await new Promise((resolve) => setImmediate(resolve));
      sliceStart = Date.now();
    }
  }
  return models;
}

/** Lazy paths so tests can set HOME before first index access. */
function cacheDir() {
  return process.env.TRACEQUEST_CACHE_DIR || join(homedir(), ".cache", "tracequest");
}

export function indexPath() {
  return join(cacheDir(), "index.json");
}

let _indexDiskMtimeCoalesce = undefined;
let _indexDiskMtimeCoalesceDepth = 0;
let _indexDiskMtimeStatCalls = 0;

export function beginIndexDiskMtimeCoalesce() {
  _indexDiskMtimeCoalesceDepth++;
}

export function endIndexDiskMtimeCoalesce() {
  if (_indexDiskMtimeCoalesceDepth > 0) _indexDiskMtimeCoalesceDepth--;
  if (_indexDiskMtimeCoalesceDepth === 0) _indexDiskMtimeCoalesce = undefined;
}

export function indexDiskMtimeStatCallsForTests() {
  return _indexDiskMtimeStatCalls;
}

export function resetIndexDiskMtimeStatCallsForTests() {
  _indexDiskMtimeStatCalls = 0;
}

function readIndexDiskMtimeMs(logContext) {
  if (_indexDiskMtimeCoalesceDepth > 0 && _indexDiskMtimeCoalesce !== undefined) {
    return _indexDiskMtimeCoalesce;
  }
  try {
    _indexDiskMtimeStatCalls++;
    const mtime = statSync(indexPath()).mtime.getTime();
    if (_indexDiskMtimeCoalesceDepth > 0) _indexDiskMtimeCoalesce = mtime;
    return mtime;
  } catch (err) {
    if (!isIndexDiskExpectedErr(err)) {
      console.error(`${logContext}: stat failed for ${indexPath()}:`, err.message);
    }
    if (_indexDiskMtimeCoalesceDepth > 0) _indexDiskMtimeCoalesce = null;
    return null;
  }
}

/** Record the mtime of the index.json the sidecar just wrote as our own (no coalesced value). */
function adoptSidecarWrittenIndexMtime() {
  let mtime;
  try {
    mtime = statSync(indexPath()).mtime.getTime();
  } catch {
    return null;
  }
  _indexFileMtime = mtime;
  if (_indexDiskMtimeCoalesceDepth > 0) _indexDiskMtimeCoalesce = mtime;
  return mtime;
}

export function indexDiskMtimeMs() {
  return readIndexDiskMtimeMs("indexDiskMtimeMs") ?? 0;
}

const MAX_INDEX_JSON_SIZE = 2 * 1024 * 1024 * 1024; // 2GB cap

function indexLog(...args) {
  if (process.env.TRACEQUEST_VERBOSE === "1") console.log(...args);
}

function indexStatus(...args) {
  console.error(...args);
}

function indexStatusUpToDate(sessionCount, cached) {
  if (!sessionCount) return;
  const cachedSuffix = cached !== undefined ? `, ${cached} cached` : "";
  indexStatus(`tracequest: index up to date (${sessionCount} session${sessionCount !== 1 ? "s" : ""}${cachedSuffix})`);
}

function indexStatusBuilding(sessionCount, staleCount, viaSidecar = false) {
  const sidecarSuffix = viaSidecar ? " via sidecar" : "";
  indexStatus(
    `tracequest: building index for ${sessionCount} session${sessionCount !== 1 ? "s" : ""} (${staleCount} stale)${sidecarSuffix}...`,
  );
}

let _sidecarPath = undefined;

export function isNativeExecutable(filePath) {
  return isNativeExecutableMagic(filePath, (err) => {
    if (!isIndexDiskExpectedErr(err)) {
      console.warn(`isNativeExecutable: read failed for ${filePath}:`, err.message);
    }
  });
}

const _sessionsDir = dirname(fileURLToPath(import.meta.url));
const _projectRoot = join(_sessionsDir, "../..");

/** Binary bundled in the distribution tarball for the host platform. */
export function bundledPlatformSidecarPath() {
  const exe = process.platform === "win32" ? "tracequest-sidecar.exe" : "tracequest-sidecar";
  return join(_projectRoot, "sidecar/bin", `${process.platform}-${process.arch}`, exe);
}

function bundledSidecarPaths() {
  return [
    bundledPlatformSidecarPath(),
    join(_projectRoot, "sidecar/target/release/tracequest-sidecar"),
    join(_projectRoot, "sidecar/target/debug/tracequest-sidecar"),
  ];
}

function validateSidecarPath(filePath, { requireNative = true } = {}) {
  if (!existsSync(filePath)) return null;
  if (requireNative && !isNativeExecutable(filePath)) {
    console.warn(
      `detectSidecar: ignoring non-executable sidecar at ${filePath} (run: npm run build:sidecar)`,
    );
    return null;
  }
  return filePath;
}

/**
 * A distribution tarball carries one platform's sidecar. Installing the wrong
 * one would otherwise fall through to the JS indexer with no explanation.
 */
function warnOnPlatformMismatch() {
  const binRoot = join(_projectRoot, "sidecar/bin");
  if (!existsSync(binRoot)) return;
  const host = `${process.platform}-${process.arch}`;
  let staged;
  try {
    staged = readdirSync(binRoot);
  } catch {
    return;
  }
  if (!staged.length || staged.includes(host)) return;
  console.warn(
    `detectSidecar: this build bundles the sidecar for ${staged.join(", ")}, but you are on ${host}; ` +
      `falling back to the JS indexer. Install the ${host} tarball for full speed.`,
  );
}

function resolveBundledSidecarBinaryPath() {
  for (const c of bundledSidecarPaths()) {
    const ok = validateSidecarPath(c);
    if (ok) return ok;
  }
  warnOnPlatformMismatch();
  try {
    const locator = process.platform === "win32" ? "where" : "which";
    const result = spawnSync(locator, ["tracequest-sidecar"], { encoding: "utf-8" });
    const fromPath = result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : "";
    if (fromPath) return validateSidecarPath(fromPath);
  } catch (err) {
    console.error("detectSidecar: failed to locate tracequest-sidecar via PATH:", err.message);
  }
  return null;
}

/** True when a sidecar binary is available to this process. */
export function sidecarAvailable() {
  return Boolean(detectSidecar());
}

function detectSidecar() {
  if (process.env.TRACEQUEST_NO_SIDECAR === "1") return null;
  const override = process.env.TRACEQUEST_SIDECAR_PATH;
  if (override) return validateSidecarPath(override, { requireNative: false });
  if (_sidecarPath !== undefined) return _sidecarPath;
  _sidecarPath = resolveBundledSidecarBinaryPath();
  return _sidecarPath;
}

export function warnSidecarFailure(op, result) {
  if (result.error) {
    console.warn(`Sidecar ${op} failed (${result.error.message}), falling back to JS`);
    return;
  }
  if (result.status !== 0) {
    const detail = (result.stderr || "").trim();
    const suffix = detail ? `: ${truncateFirstPrompt(detail)}` : "";
    console.warn(`Sidecar ${op} exited ${result.status}${suffix}, falling back to JS`);
  }
}

const SIDECAR_MAX_BUFFER = 128 * 1024 * 1024;
const SIDECAR_SPAWN_OPTS = { encoding: "utf-8", maxBuffer: SIDECAR_MAX_BUFFER, killSignal: "SIGKILL" };
const SIDECAR_DEFAULT_TIMEOUT_MS = 60_000;
/** Index runs re-parse stale sessions; allow time per stale session, capped at 15 min. */
const SIDECAR_INDEX_MS_PER_STALE = 50;
const SIDECAR_INDEX_MAX_TIMEOUT_MS = 15 * 60_000;

/**
 * Time limit for one sidecar invocation (fact hsa2). TRACEQUEST_SIDECAR_TIMEOUT_MS
 * overrides the base; index runs scale with the number of sessions to re-parse.
 */
export function sidecarTimeoutMs(op, staleCount = 0) {
  const env = Number(process.env.TRACEQUEST_SIDECAR_TIMEOUT_MS);
  const base = Number.isFinite(env) && env > 0 ? env : SIDECAR_DEFAULT_TIMEOUT_MS;
  if (op !== "index") return base;
  return Math.max(base, Math.min(SIDECAR_INDEX_MAX_TIMEOUT_MS, staleCount * SIDECAR_INDEX_MS_PER_STALE));
}

function warnSidecarTimeout(op, timeoutMs) {
  console.warn(`Sidecar ${op} did not finish within ${timeoutMs}ms; killed, falling back to JS`);
}

function parseSidecarResult(op, result, parseSuccess) {
  try {
    return parseSuccess(result);
  } catch (err) {
    const detail = (result.stderr || "").trim();
    const suffix = detail ? ` (stderr: ${safeSlice(detail, 120)})` : "";
    console.warn(`Sidecar ${op} output parse failed, falling back to JS:`, err.message + suffix);
    return null;
  }
}

/**
 * Synchronous sidecar call for the CLI. Bounded by sidecarTimeoutMs so a child
 * that never exits (e.g. blocked reading stdin) can never hang the caller.
 * The server never uses this: it calls runSidecarAsync (fact hsa1).
 */
export function runSidecar(op, args, parseSuccess, spawnExtra = {}) {
  const sidecar = detectSidecar();
  if (!sidecar) return null;
  try {
    const timeout = spawnExtra.timeout ?? sidecarTimeoutMs(op);
    const result = spawnSync(sidecar, args, { ...SIDECAR_SPAWN_OPTS, ...spawnExtra, timeout });
    if (result.error?.code === "ETIMEDOUT") {
      warnSidecarTimeout(op, timeout);
      return null;
    }
    if (result.status === 0) return parseSidecarResult(op, result, parseSuccess);
    warnSidecarFailure(op, result);
  } catch (e) {
    console.warn(`Sidecar ${op} spawn failed, falling back to JS:`, e.message);
  }
  return null;
}

/**
 * Asynchronous sidecar call (fact hsa1): the event loop keeps serving while the
 * child runs. Input is streamed to stdin; a child that has not exited within
 * the time limit is SIGKILLed and the caller gets null (JS fallback, fact hsa2).
 * Resolves to parseSuccess(result) or null; never rejects.
 */
export function runSidecarAsync(op, args, parseSuccess, { input = null, timeoutMs } = {}) {
  const sidecar = detectSidecar();
  if (!sidecar) return Promise.resolve(null);
  const limit = timeoutMs ?? sidecarTimeoutMs(op);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(sidecar, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      console.warn(`Sidecar ${op} spawn failed, falling back to JS:`, e.message);
      resolve(null);
      return;
    }
    const out = [];
    const err = [];
    let outBytes = 0;
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      warnSidecarTimeout(op, limit);
      child.kill("SIGKILL");
      settle(null);
    }, limit);
    child.stdout.on("data", (chunk) => {
      outBytes += chunk.length;
      if (outBytes > SIDECAR_MAX_BUFFER) {
        console.warn(`Sidecar ${op} output exceeded ${SIDECAR_MAX_BUFFER} bytes, falling back to JS`);
        child.kill("SIGKILL");
        settle(null);
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (e) => {
      console.warn(`Sidecar ${op} spawn failed, falling back to JS:`, e.message);
      settle(null);
    });
    child.on("close", (status, signal) => {
      if (settled) return;
      const result = {
        status,
        signal,
        stdout: Buffer.concat(out).toString("utf-8"),
        stderr: Buffer.concat(err).toString("utf-8"),
      };
      if (status === 0) {
        settle(parseSidecarResult(op, result, parseSuccess));
        return;
      }
      warnSidecarFailure(op, result);
      settle(null);
    });
    // A child that exits before reading all input closes the pipe: EPIPE is
    // its exit status's business, not an uncaught exception.
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? undefined);
  });
}

let _indexFileMtime = null;
let _indexFileCache = null;
let _indexCachePathCount = 0;
let _resultMapCache = null;
let _resultMapKey = null;
let _writeTimer = null;
const INDEX_WRITE_DELAY_MS = 30_000;

/** True once we've registered the process exit handler. */
let _exitHandlerRegistered = false;
/** Signal handlers registered while a write is pending (fact eli). */
let _sigintHandler = null;
let _sigtermHandler = null;

function _makeSignalHandler(sig) {
  return function () {
    // Remove both handlers before flushing so re-raise goes to default.
    _removePendingSignalHandlers();
    flushDeferredIndexWrites();
    // Re-raise with default handler so the process exits with the conventional
    // code: 128 + signal number (SIGINT=2 → 130, SIGTERM=15 → 143).
    process.kill(process.pid, sig);
  };
}

function _installPendingSignalHandlers() {
  if (_sigintHandler) return; // already installed
  _sigintHandler = _makeSignalHandler("SIGINT");
  _sigtermHandler = _makeSignalHandler("SIGTERM");
  process.on("SIGINT", _sigintHandler);
  process.on("SIGTERM", _sigtermHandler);
}

function _removePendingSignalHandlers() {
  if (_sigintHandler) {
    process.removeListener("SIGINT", _sigintHandler);
    _sigintHandler = null;
  }
  if (_sigtermHandler) {
    process.removeListener("SIGTERM", _sigtermHandler);
    _sigtermHandler = null;
  }
}

/**
 * Flush any pending deferred index.json and search.idx writes synchronously.
 * Called on process exit so short-lived CLI invocations persist caches (fact 66c).
 * Also called by signal handlers (fact eli).
 * Safe to call multiple times; no-op when nothing is pending.
 */
export function flushDeferredIndexWrites() {
  if (_writeTimer) {
    clearTimeout(_writeTimer);
    _writeTimer = null;
  }
  _removePendingSignalHandlers();
  try {
    writeIndexFileToDisk();
  } catch (err) {
    // Suppress on exit path — nothing useful can be done at this point.
  }
  // Flush search.idx using the same internals as the test helper. This needs the
  // SAME guard as index.json above: it runs from the process exit handler, where
  // an unwritable or vanished ~/.cache/tracequest used to throw an uncaught
  // EACCES and turn an otherwise successful command into exit 1 (fact 5pu). A
  // cache that cannot be written is only ever a slower next run.
  try {
    _flushSearchIdxWriteForTests();
  } catch (err) {
    // Same posture: the work already succeeded, the cache is an optimisation.
  }
}
export const INDEX_WORKER_BATCH = 32;

/** Most stale sessions a delta sidecar run takes (fact hsi3); more use the full run. */
export const DELTA_INDEX_MAX = 256;

/** Whether we've attempted to load search.idx from disk this process lifetime. */
let _searchIdxLoaded = false;
/** True when an existing search.idx failed to load (version mismatch/corrupt/unreadable). */
let _searchIdxLoadFailedExistingFile = false;

export function indexWorkerCountForStale(staleCount) {
  const maxWorkers = Math.min(8, Math.max(2, Math.floor(availableParallelism() / 2)));
  return Math.min(maxWorkers, Math.max(2, Math.ceil(staleCount / INDEX_WORKER_BATCH)));
}

/**
 * Worker threads inherit `--input-type` from `node --input-type=module -e` parents and
 * then fail/hang loading ESM. Serial indexing is required in that process shape.
 */
export function workersBrokenExecArgv(execArgv = process.execArgv) {
  if (!execArgv?.length) return false;
  const hasInputType = execArgv.some(
    (a) => a === "--input-type" || a.startsWith("--input-type="),
  );
  if (!hasInputType) return false;
  return execArgv.some(
    (a) => a === "-e" || a === "--eval" || a === "-p" || a === "--print",
  );
}

let _indexSession = null;
let _sessionListChecksum = null;

export function initIndexWriters({ indexSession, sessionListChecksum }) {
  _indexSession = indexSession;
  _sessionListChecksum = sessionListChecksum;
}

function syncIndexCachePathCount(cache) {
  let n = 0;
  for (const k of Object.keys(cache)) {
    if (!INDEX_META_KEYS.has(k)) n++;
  }
  _indexCachePathCount = n;
}

/** Drop stale index entries; skip scan when cache cannot exceed current session count. */
export function pruneIndexCache(cache, validPaths) {
  if (_indexCachePathCount <= validPaths.size) return;
  for (const k of Object.keys(cache)) {
    if (INDEX_META_KEYS.has(k)) continue;
    if (!validPaths.has(k)) delete cache[k];
  }
  // Also prune SearchIndex (fact 03w).
  getSearchIndex().pruneRemovedSessions(validPaths);
}

export function resetIndexWritersForTests() {
  _indexFileMtime = null;
  _indexFileCache = null;
  _indexCachePathCount = 0;
  _resultMapCache = null;
  _resultMapKey = null;
  _indexDiskMtimeCoalesce = undefined;
  _indexDiskMtimeCoalesceDepth = 0;
  _indexDiskMtimeStatCalls = 0;
  if (_writeTimer) {
    clearTimeout(_writeTimer);
    _writeTimer = null;
  }
  _removePendingSignalHandlers();
  _exitHandlerRegistered = false;
  _sidecarPath = undefined;
  _searchIdxLoaded = false;
  _searchIdxLoadFailedExistingFile = false;
  _resetSearchIndexForTests();
}

export function flushDeferredSearchIdxWriteForTests() {
  _flushSearchIdxWriteForTests();
}

export function buildResultMapCacheKey(sessions, indexMtime) {
  return `${indexMtime}:${sessions.length}:${_sessionListChecksum(sessions)}`;
}

export function parseSidecarIndexStdout(stdout) {
  const obj = JSON.parse(stdout);
  const map = new Map();
  for (const k in obj) {
    if (Object.hasOwn(obj, k)) map.set(k, obj[k]);
  }
  return map;
}

export function sessionPayloadForSidecarIndex(s) {
  const payload = {
    path: s.path,
    project: s.project,
    file: s.file,
    source: s.source || "claude",
    size: s.size || 0,
    mtime: sessionMtimeMs(s),
  };
  if (s.parentSession) payload.parentSession = s.parentSession;
  if (s.title) payload.title = s.title;
  return payload;
}

function writeIndexFileToDisk() {
  if (!_indexFileCache) return;
  const indexJson = JSON.stringify(_indexFileCache);
  if (indexJson.length > MAX_INDEX_JSON_SIZE) {
    console.warn(
      `  deferred index write skipped: ${Math.round(indexJson.length / 1024 / 1024)}MB exceeds ${Math.round(MAX_INDEX_JSON_SIZE / 1024 / 1024)}MB cap`
    );
    return;
  }
  const dir = cacheDir();
  mkdirSync(dir, { recursive: true });
  const path = indexPath();
  const tmp = path + ".tmp";
  const tWrite = Date.now();
  writeFileSync(tmp, indexJson);
  renameSync(tmp, path);
  const newStat = statSync(path);
  _indexFileMtime = newStat.mtime.getTime();
  if (_indexDiskMtimeCoalesceDepth > 0) _indexDiskMtimeCoalesce = _indexFileMtime;
  indexLog(`  deferred index write: ${Date.now() - tWrite}ms (${Math.round(indexJson.length / 1024 / 1024)}MB)`);
}

function scheduleIndexWrite() {
  if (!_exitHandlerRegistered) {
    _exitHandlerRegistered = true;
    process.on("exit", flushDeferredIndexWrites);
  }
  _installPendingSignalHandlers();
  if (_writeTimer) clearTimeout(_writeTimer);
  _writeTimer = setTimeout(() => {
    _writeTimer = null;
    _removePendingSignalHandlers();
    try {
      writeIndexFileToDisk();
    } catch (err) {
      console.warn("  deferred index write failed:", err.message);
    }
    // Also flush search.idx if it was scheduled (both debounces may fire together).
  }, INDEX_WRITE_DELAY_MS);
  if (_writeTimer.unref) _writeTimer.unref();
}

export function flushDeferredIndexWriteForTests() {
  if (_writeTimer) {
    clearTimeout(_writeTimer);
    _writeTimer = null;
  }
  writeIndexFileToDisk();
}

export function loadIndexFile(indexMtime) {
  if (_indexFileCache !== null && _indexFileMtime === indexMtime) {
    return _indexFileCache;
  }
  try {
    const path = indexPath();
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (raw._v === INDEX_VERSION) {
      _indexFileMtime = indexMtime;
      _indexFileCache = raw;
      syncIndexCachePathCount(raw);
      return raw;
    }
  } catch (err) {
    if (!isIndexDiskExpectedErr(err)) {
      console.error(`loadIndexFile: failed to read ${indexPath()}:`, err.message);
    }
  }
  return null;
}

/**
 * The session index entry for `path` when it describes the file as it is now
 * (its recorded mtime equals `mtimeMs`), else null. Reads the in-memory index
 * the session list builds; loads index.json only when nothing has loaded it yet.
 */
export function currentIndexEntry(path, mtimeMs) {
  const cache = _indexFileCache !== null ? _indexFileCache : loadIndexFile(readIndexDiskMtimeMs("currentIndexEntry"));
  return indexEntryIfCurrent(cache && path !== "_v" ? cache[path] : undefined, mtimeMs);
}

/** `entry` when it is an index entry recorded for a file whose mtime is `mtimeMs`, else null. */
export function indexEntryIfCurrent(entry, mtimeMs) {
  if (!entry || typeof entry !== "object") return null;
  // Discovery records whole milliseconds; a sub-millisecond stat may round either way.
  return entry.mtime === Math.floor(mtimeMs) || entry.mtime === Math.round(mtimeMs) ? entry : null;
}

/**
 * The entry the in-memory index holds for `path` (null when it has none), or
 * undefined when no index is loaded in this thread. Never reads index.json:
 * a session worker gets the server's entry with its job (fact hps2).
 */
export function loadedIndexEntry(path) {
  if (_indexFileCache === null) return undefined;
  const entry = path !== "_v" ? _indexFileCache[path] : undefined;
  return entry && typeof entry === "object" ? entry : null;
}

function indexWorkerUrl() {
  const override = process.env.TRACEQUEST_TEST_INDEX_WORKER;
  if (override) return new URL(override, import.meta.url);
  return new URL("./index-worker.js", import.meta.url);
}

/** Greedy LPT partition: largest sessions first to least-loaded worker. */
export function partitionStaleSessionsForWorkers(items, workerCount, getSession = (x) => x) {
  const chunks = Array.from({ length: workerCount }, () => []);
  if (!items.length) return chunks;
  const loads = new Array(workerCount).fill(0);
  const order = new Uint32Array(items.length);
  for (let i = 0; i < items.length; i++) order[i] = i;
  order.sort(
    (ia, ib) => (getSession(items[ib]).size || 0) - (getSession(items[ia]).size || 0),
  );
  for (let k = 0; k < order.length; k++) {
    const s = getSession(items[order[k]]);
    let pick = 0;
    for (let i = 1; i < workerCount; i++) {
      if (loads[i] < loads[pick]) pick = i;
    }
    chunks[pick].push(s);
    loads[pick] += s.size || 1;
  }
  return chunks;
}

function sessionFromStaleEntry(e) {
  return e != null && typeof e === "object" && "session" in e && e.session != null ? e.session : e;
}

function mergeIndexWorkerResults(signals, channels, workerCount) {
  const merged = {};
  const done = new Array(workerCount).fill(false);
  let remaining = workerCount;
  const deadline = Date.now() + 120_000;
  while (remaining > 0) {
    for (let i = 0; i < workerCount; i++) {
      if (done[i] || Atomics.load(signals, i) === 0) continue;
      done[i] = true;
      remaining--;
      if (!channels[i]) continue;
      const msg = receiveMessageOnPort(channels[i].port2);
      if (!msg || !msg.message) continue;
      if (msg.message._error) {
        console.error(`indexSessionsParallel: worker ${i} failed:`, msg.message._error);
        continue;
      }
      Object.assign(merged, msg.message);
    }
    if (remaining === 0) break;
    if (Date.now() > deadline) {
      throw new Error(
        `indexSessionsParallel: timed out waiting for ${remaining} worker(s)`,
      );
    }
    for (let i = 0; i < workerCount; i++) {
      if (!done[i]) Atomics.wait(signals, i, 0, 8);
    }
  }
  return merged;
}

function indexStaleChunkSerial(chunk) {
  const out = {};
  let opencode = null;
  // _indexSession fails closed on an unrecognised source, so the close must run
  // on the throw path too or the read-only SQLite handles leak (fact 80i).
  try {
    for (const entry of chunk) {
      const s = sessionFromStaleEntry(entry);
      if ((s.source || "claude") === "opencode") {
        if (!opencode) opencode = openCodeIndexer();
        out[s.path] = opencode.index(s);
      } else {
        out[s.path] = _indexSession(s);
      }
    }
  } finally {
    opencode?.close();
  }
  return out;
}

function terminateIndexWorker(worker) {
  if (!worker) return;
  worker.terminate().catch((err) => {
    if (!isWorkerTerminateExpectedErr(err)) {
      console.error("indexSessionsParallel: worker terminate failed:", err.message);
    }
  });
}

function indexSessionsParallel(staleEntries, workerCount) {
  const chunks = partitionStaleSessionsForWorkers(staleEntries, workerCount, sessionFromStaleEntry);

  const sab = new SharedArrayBuffer(4 * workerCount);
  const signals = new Int32Array(sab);
  const channels = [];
  const workers = [];
  const prefilled = {};
  const startupTimers = [];
  /** Error raised by a serial fallback running inside a worker event handler. */
  let deferredError = null;

  const signalWorkerDone = (i) => {
    if (Atomics.load(signals, i) !== 0) return;
    clearTimeout(startupTimers[i]);
    Atomics.store(signals, i, 1);
    Atomics.notify(signals, i);
  };

  for (let i = 0; i < workerCount; i++) {
    if (!chunks[i].length) {
      signalWorkerDone(i);
      continue;
    }
    const ch = new MessageChannel();
    channels[i] = ch;
    const workerSessions = chunks[i].map((entry) => sessionFromStaleEntry(entry));
    const w = new Worker(indexWorkerUrl(), {
      workerData: { sessions: workerSessions, sab, workerIndex: i, port: ch.port1 },
      transferList: [ch.port1],
    });
    workers[i] = w;
    const serialFallback = (reason) => {
      if (Atomics.load(signals, i) !== 0) return;
      console.error(`indexSessionsParallel: worker ${i} ${reason}, using serial fallback`);
      terminateIndexWorker(w);
      try {
        Object.assign(prefilled, indexStaleChunkSerial(chunks[i]));
      } catch (err) {
        // This runs inside a worker 'error'/'exit'/startup-timeout handler, where a
        // throw would surface as an uncaught exception with no useful context.
        // Defer it and rethrow from the main flow so the caller sees the real
        // failure — e.g. indexSession failing closed on an unrecognised source.
        deferredError ??= err;
      }
      signalWorkerDone(i);
    };
    startupTimers[i] = setTimeout(() => serialFallback("startup timeout"), 10_000);
    w.on("error", (err) => serialFallback(`error: ${err.message}`));
    w.on("exit", (code) => {
      if (code !== 0 && Atomics.load(signals, i) === 0) {
        serialFallback(`exited with code ${code}`);
      }
    });
  }

  const merged = mergeIndexWorkerResults(signals, channels, workerCount);
  Object.assign(merged, prefilled);
  for (const ch of channels) ch?.port2?.close();
  for (const w of workers) terminateIndexWorker(w);
  if (deferredError) throw deferredError;
  return merged;
}

/**
 * Extract termFreqs map for a session from JS indexer results.
 * @param {object} meta
 * @returns {Map<string,number>|null}
 */
export function termFreqsFromMeta(meta) {
  if (meta && meta.termFreqs instanceof Map && meta.termFreqs.size) {
    return meta.termFreqs;
  }
  return null;
}

function stripLegacySearchText(data) {
  if (data && Object.hasOwn(data, "searchText")) delete data.searchText;
}

/**
 * Stores a freshly indexed session in the metadata cache and the SearchIndex.
 * With `siBatch` (an array) its SearchIndex entry is queued there instead, for
 * one upsertMany() when the index pass ends.
 */
export function storeStaleIndex(s, data, cache, result, mtimeMs, siBatch = null) {
  data.mtime = mtimeMs ?? sessionMtimeMs(s);
  if (!Object.hasOwn(cache, s.path)) _indexCachePathCount++;
  // Capture SearchIndex terms, then strip transient/legacy full-text fields from metadata.
  const tf = termFreqsFromMeta(data);
  if (data.termFreqs !== undefined) delete data.termFreqs;
  stripLegacySearchText(data);
  cache[s.path] = data;
  result.set(s.path, data);
  // Update SearchIndex within this index pass (fact msg / v99).
  if (siBatch) siBatch.push([s.path, tf]);
  else getSearchIndex().upsert(s.path, tf);
}

/**
 * Build (or refresh) the metadata index for `sessions`. The one step that may
 * run the sidecar is a `yield` of its request, so the same algorithm has a
 * synchronous driver (CLI: buildIndex) and an asynchronous one (serve:
 * buildIndexAsync, fact hsa1) without two copies drifting apart.
 */
function* buildIndexSteps(sessions, opts = {}) {
  const t0 = Date.now();
  // partial: `sessions` is a filtered subset of the corpus, so nothing outside
  // it may be pruned from the shared cache (fact hsf1).
  const partial = opts.partial === true;

  const precomputedMtime = opts.indexDiskMtimeMs;

  let indexMtime;
  if (precomputedMtime !== undefined) {
    indexMtime = precomputedMtime > 0 ? precomputedMtime : null;
  } else {
    if (_indexFileMtime !== null && _resultMapCache !== null) {
      const probeKey = buildResultMapCacheKey(sessions, _indexFileMtime);
      if (_resultMapKey === probeKey) {
        const diskMtime = readIndexDiskMtimeMs("buildIndex");
        if (diskMtime === _indexFileMtime) {
          indexStatusUpToDate(sessions.length);
          return _resultMapCache;
        }
        indexMtime = diskMtime !== null ? diskMtime : null;
      }
    }
    if (indexMtime === undefined) {
      const diskMtime = readIndexDiskMtimeMs("buildIndex");
      indexMtime = diskMtime !== null ? diskMtime : null;
    }
  }

  const mapKey = buildResultMapCacheKey(sessions, indexMtime || 0);
  if (_resultMapKey === mapKey && _resultMapCache !== null) {
    indexStatusUpToDate(sessions.length);
    return _resultMapCache;
  }

  let cache = {};

  if (_indexFileCache !== null) {
    if (_indexFileMtime === indexMtime || indexMtime === null) {
      cache = _indexFileCache;
    } else {
      const loaded = loadIndexFile(indexMtime);
      cache = loaded ?? _indexFileCache;
    }
  } else if (indexMtime !== null) {
    loadIndexFile(indexMtime);
    if (_indexFileCache) cache = _indexFileCache;
  }

  // Load SearchIndex from disk on first call. An existing-file load failure
  // requires mtime-cached sessions to re-emit termFreqs (facts msg, 21x).
  if (!_searchIdxLoaded) {
    _searchIdxLoaded = true;
    const loaded = loadSearchIndex(); // populates getSearchIndex() singleton when successful
    // loadSearchIndex returns false for both a missing file and load failure.
    // Existence distinguishes "existing search.idx is unusable" from "never
    // persisted"; both still rely on per-session SI membership below because
    // index.json metadata does not carry termFreqs.
    if (!loaded) {
      _searchIdxLoadFailedExistingFile = existsSync(searchIdxPath());
    }
  }
  const si = getSearchIndex();

  const result = new Map();
  /** @type {{ session: (typeof sessions)[0], mtime: number }[]} */
  const staleSessions = [];
  /** mtime-current OpenCode entries that read none of their session's messages: re-read. */
  const rereadOpenCode = [];
  let cached = 0;
  let searchIdxMutated = false;

  // When an existing search.idx failed to load, SI is empty and every
  // mtime-cached session must re-emit termFreqs. When search.idx is simply
  // absent, this flag stays false; individual cache hits still re-tokenize
  // through the !si.has(s.path) check because index.json is metadata-only.
  const siNeedsRebuild = _searchIdxLoadFailedExistingFile && si.docCount === 0;
  // Cached codex rows written before the current codex format still carry the
  // provider as their model; they get the model id patched in (fact cdxheal).
  const codexStale = cache._codex !== CODEX_INDEX_FORMAT;
  /** @type {string[]} */
  const codexCacheHits = [];
  /** Cached codex rows re-indexed for their sub-thread items (fact cdxsub2). */
  const codexReindexHits = [];
  // Cached Claude rows from before fact durcl may end at a late trailer line (fact durcl2).
  const spansStale = cache._spans !== CLAUDE_SPAN_FORMAT;
  const claudeCacheHits = [];
  // Cached rows from before fact durac may count idle days as duration (fact
  // durac2). A partial build sees a subset: the next full build heals them all.
  const activeStale = !partial && cache._active !== ACTIVE_TIME_FORMAT;
  const activeCacheHits = [];
  let activeChecked = 0;

  for (const s of sessions) {
    const mtime = sessionMtimeMs(s);
    if (cache[s.path] && cache[s.path].mtime === mtime) {
      const reread = s.source === "opencode" && openCodeEntryReadNoMessages(cache[s.path]);
      if (reread) rereadOpenCode.push(s.path);
      if (siNeedsRebuild || !si.has(s.path) || reread) {
        // Existing search.idx load failure emptied SI, or this session is absent
        // from SI (e.g. search.idx deleted): re-index to get termFreqs because
        // index.json has metadata only (fact msg).
        staleSessions.push({ session: s, mtime });
      } else {
        result.set(s.path, cache[s.path]);
        cached++;
        if (activeStale && ACTIVE_TIME_SOURCES.has(s.source)) {
          activeChecked++;
          // A row the duration heal re-indexes gets its model and span from
          // that re-index: the model and span heals skip it.
          if ((cache[s.path].durationMs || 0) > STALL_MS) {
            activeCacheHits.push({ session: s, mtime });
            continue;
          }
        }
        if (codexStale && s.source === "codex") {
          if (codexRowMayMissSubThread(cache[s.path])) codexReindexHits.push({ session: s, mtime });
          else codexCacheHits.push(s.path);
        }
        if (spansStale && s.source === "claude") claudeCacheHits.push({ session: s, mtime });
      }
    } else {
      staleSessions.push({ session: s, mtime });
    }
  }
  const codexReindex = [];
  if (codexReindexHits.length) {
    // Off the cache (so a crash before they are re-indexed leaves them stale,
    // not marked healed) and queued stale; the sidecar re-reads them below.
    for (const hit of codexReindexHits) {
      const p = hit.session.path;
      if (!result.delete(p)) continue;
      delete cache[p];
      staleSessions.push(hit);
      codexReindex.push(p);
    }
    cached -= codexReindex.length;
    if (cache === _indexFileCache) syncIndexCachePathCount(cache);
    indexStatus(`tracequest: codex sessions with no prompt or tool call re-indexed for review sub-threads: ${codexReindex.length}`);
  }
  if (codexCacheHits.length) {
    const tHeal = Date.now();
    const models = yield { codexHeal: codexCacheHits };
    // An async driver yielded the event loop: patch the cache that is current now.
    if (_indexFileCache !== null && _indexFileCache !== cache) cache = _indexFileCache;
    applyCodexCacheModels(cache, codexCacheHits, models, tHeal);
  }
  if (spansStale && claudeCacheHits.length) {
    const tHeal = Date.now();
    const trims = yield { spanHeal: claudeCacheHits.map((h) => h.session.path) };
    if (_indexFileCache !== null && _indexFileCache !== cache) cache = _indexFileCache;
    applyClaudeSpanTrims(cache, result, claudeCacheHits, trims, staleSessions, tHeal);
    cached -= staleSessions.filter((e) => e.session.source === "claude" && trims.get(e.session.path) === null).length;
  } else if (spansStale) {
    // Nothing cached predates fact durcl: every Claude row is indexed by it.
    cache._spans = CLAUDE_SPAN_FORMAT;
  }
  const reindexCached = activeStale ? queueActiveTimeReindex(cache, result, activeCacheHits, staleSessions, activeChecked) : [];
  cached -= reindexCached.length;

  if (staleSessions.length === 0) {
    // All surviving sessions are cache hits. Check whether the cache contains
    // entries for sessions that no longer exist on disk (e.g. a session was
    // deleted while all remaining sessions had unchanged mtimes). The fast path
    // is O(1): only build validPaths and prune when counts differ (fact 03w).
    if (!partial && _indexCachePathCount > sessions.length) {
      const validPaths = new Set();
      for (const s of sessions) validPaths.add(s.path);
      pruneIndexCache(cache, validPaths);
      markIndexCurrent(cache);
      _indexFileCache = cache;
      syncIndexCachePathCount(cache);
      scheduleIndexWrite();
      scheduleSearchIdxWrite();
    }
    _resultMapCache = result;
    _resultMapKey = mapKey;
    indexStatusUpToDate(sessions.length, cached);
    if (searchIdxMutated) scheduleSearchIdxWrite();
    return result;
  }

  // A partial (filtered) build must not hand the sidecar a subset: the sidecar
  // rewrites index.json with exactly the sessions it was given (fact hsf1).
  const useSidecar = partial ? null : detectSidecar();
  indexStatusBuilding(sessions.length, staleSessions.length, useSidecar);
  if (useSidecar) {
    // Compute search-stale: sessions present in metadata cache but absent from
    // the SearchIndex (fact 8rj). The sidecar will re-parse these even if mtime
    // matches, so termFreqs are emitted and available for SearchIndex upsert.
    const searchStale = [];
    for (const s of sessions) {
      if (!si.has(s.path)) searchStale.push(s.path);
    }
    // The sidecar also re-reads OpenCode entries that found none of their messages.
    for (const path of rereadOpenCode) {
      if (si.has(path)) searchStale.push(path);
    }
    // ...and the cached rows re-measured as worked time (fact durac2) or
    // re-read for a review sub-thread (fact cdxsub2).
    for (const path of reindexCached) {
      if (si.has(path)) searchStale.push(path);
    }
    for (const path of codexReindex) {
      if (si.has(path)) searchStale.push(path);
    }
    // Delta run (fact hsi3): with an index already loaded and only a few stale
    // sessions, the sidecar gets just those and a throwaway index path, so it
    // neither reads nor rewrites the whole index.json nor echoes every entry;
    // the cache hits are already in `result` and the deferred write persists.
    const deltaPaths = new Set(staleSessions.map((e) => e.session.path));
    for (const p of searchStale) deltaPaths.add(p);
    const delta = _indexCachePathCount > 0 && cache === _indexFileCache && deltaPaths.size <= DELTA_INDEX_MAX;
    const sidecarSessions = [];
    for (const s of sessions) {
      if (!delta || deltaPaths.has(s.path)) sidecarSessions.push(sessionPayloadForSidecarIndex(s));
    }
    const sidecarIndexPath = delta ? join(cacheDir(), `index.delta-${process.pid}.json`) : indexPath();

    const sidecarArgs = [
      "index",
      "--index-path", sidecarIndexPath,
      "--version", String(INDEX_VERSION),
      "--sessions-stdin",
      "--term-freqs",
    ];

    // Pass sessions and searchStale together in stdin object to avoid ARG_MAX (fact 4hh).
    const stdinPayload = JSON.stringify({ sessions: sidecarSessions, searchStale });

    const sidecarIndex = yield { args: sidecarArgs, input: stdinPayload, staleCount: staleSessions.length + searchStale.length };
    if (delta) rmSync(sidecarIndexPath, { force: true });
    if (sidecarIndex) {
      // An async build yielded the event loop: merge into whatever cache is
      // current now, not the object captured before the sidecar ran.
      if (_indexFileCache !== null && _indexFileCache !== cache) cache = _indexFileCache;
      // Merge sidecar entries into metadata cache and SearchIndex (facts 8rj, wyt).
      // The sidecar emits termFreqs (plain object) for freshly parsed/search-stale
      // entries; convert to Map and upsert via the same path as JS indexers.
      const siBatch = [];
      for (const [path, data] of sidecarIndex) {
        if (!Object.hasOwn(cache, path)) _indexCachePathCount++;
        // Extract termFreqs (plain object from JSON) before stripping it from cache entry.
        let tf = null;
        if (data.termFreqs && typeof data.termFreqs === "object") {
          tf = new Map(Object.entries(data.termFreqs));
          delete data.termFreqs;
        }
        stripLegacySearchText(data);
        cache[path] = data;
        result.set(path, data);
        // Only upsert when termFreqs are present (freshly parsed by sidecar).
        // Sidecar omits termFreqs for mtime-cache-reused entries; calling
        // upsert(path, null) would delete existing SI postings for those
        // sessions. Removal is pruneRemovedSessions' responsibility (fact 03w).
        if (tf !== null) siBatch.push([path, tf]);
      }
      // One pass over the vocabulary for every re-indexed session.
      si.upsertMany(siBatch);
      const sidecarSearchMutated = siBatch.length > 0;

      // Prune sessions no longer on disk from cache and SearchIndex (fact 03w).
      // pruneIndexCache is a no-op unless the cache holds more paths than
      // there are sessions, so the path set is only built when it can matter.
      const pruning = _indexCachePathCount > sessions.length;
      if (pruning) pruneIndexCache(cache, new Set(sessions.map(s => s.path)));
      markIndexCurrent(cache);
      _indexFileCache = cache;
      // A delta merge counted each new path above; recount after a prune or a full run.
      if (pruning || !delta) syncIndexCachePathCount(cache);
      scheduleIndexWrite();
      if (reindexCached.length) writeActiveTimeHealNow(cache);
      if (sidecarSearchMutated || searchIdxMutated) scheduleSearchIdxWrite();

      // The sidecar just wrote index.json with exactly these entries: adopt its
      // mtime so the next build does not re-read the file this cache mirrors.
      // A delta run wrote only its throwaway file; index.json is unchanged.
      const writtenMtime = delta ? null : adoptSidecarWrittenIndexMtime();
      _resultMapCache = result;
      _resultMapKey = buildResultMapCacheKey(sessions, writtenMtime || indexMtime || 0);
      indexStatus(
        `tracequest: indexed ${sidecarIndex.size} session${sidecarIndex.size !== 1 ? "s" : ""} via sidecar${delta ? ` (delta of ${sessions.length})` : ""} (${Date.now() - t0}ms)`,
      );
      return result;
    }
  }

  const PARALLEL_THRESHOLD =
    process.env.TRACEQUEST_TEST_PARALLEL_THRESHOLD != null
      ? Number(process.env.TRACEQUEST_TEST_PARALLEL_THRESHOLD)
      : 100;
  let validPaths;
  if (staleSessions.length > 0) {
    validPaths = new Set();
    for (const s of sessions) validPaths.add(s.path);
    if (cache === _indexFileCache && partial) {
      cache = { ..._indexFileCache };
    } else if (cache === _indexFileCache) {
      const next = { _v: _indexFileCache._v, _codex: _indexFileCache._codex, _spans: _indexFileCache._spans, _active: _indexFileCache._active };
      for (const s of sessions) {
        const entry = _indexFileCache[s.path];
        if (entry !== undefined) next[s.path] = entry;
      }
      cache = next;
    }
  }
  if (staleSessions.length > PARALLEL_THRESHOLD && !workersBrokenExecArgv()) {
    const workerCount = indexWorkerCountForStale(staleSessions.length);
    indexLog(`  indexing ${staleSessions.length} sessions across ${workerCount} workers...`);
    const indexed = indexSessionsParallel(staleSessions, workerCount);
    const siBatch = [];
    try {
      for (const { session: s, mtime } of staleSessions) {
        storeStaleIndex(s, indexed[s.path] || _indexSession(s), cache, result, mtime, siBatch);
      }
    } finally {
      getSearchIndex().upsertMany(siBatch);
    }
  } else {
    const logEvery = sessions.length > 1000 ? 500 : 100;
    let opencode = null;
    const siBatch = [];
    // _indexSession fails closed on an unrecognised source, so the close must run
    // on the throw path too or the read-only SQLite handles leak (fact 80i).
    try {
      for (let i = 0; i < staleSessions.length; i++) {
        const { session: s, mtime } = staleSessions[i];
        const tIndex = Date.now();
        let meta;
        if ((s.source || "claude") === "opencode") {
          if (!opencode) opencode = openCodeIndexer();
          meta = opencode.index(s);
        } else {
          meta = _indexSession(s);
        }
        storeStaleIndex(s, meta, cache, result, mtime, siBatch);
        const indexMs = Date.now() - tIndex;
        if (indexMs > 100 || (i + 1) % logEvery === 0 || i < 3) {
          const elapsed = Date.now() - t0;
          indexLog(`  [${i + 1}/${staleSessions.length}] ${s.source} ${(s.file || "").slice(0, 20)} index=${indexMs}ms total=${elapsed}ms`);
        }
      }
    } finally {
      opencode?.close();
      getSearchIndex().upsertMany(siBatch);
    }
  }

  const stale = staleSessions.length;

  if (stale) {
    if (!partial) pruneIndexCache(cache, validPaths);
    markIndexCurrent(cache);
    _indexFileCache = cache;
    syncIndexCachePathCount(cache);
    scheduleIndexWrite();
    scheduleSearchIdxWrite(); // deferred write of search.idx (fact v99)
    if (reindexCached.length) writeActiveTimeHealNow(cache);
  }

  _resultMapCache = result;
  _resultMapKey = buildResultMapCacheKey(sessions, indexMtime || 0);

  const elapsed = Date.now() - t0;
  if (stale) {
    indexStatus(
      `tracequest: indexed ${stale} session${stale !== 1 ? "s" : ""} (${cached} cached) in ${elapsed}ms`,
    );
  }

  return result;
}

const parseIndexOutput = (result) => parseSidecarIndexStdout(result.stdout);

export function buildIndex(sessions, opts = {}) {
  const steps = buildIndexSteps(sessions, opts);
  let step = steps.next();
  while (!step.done) {
    const req = step.value;
    step = steps.next(req.codexHeal ? readCodexModels(req.codexHeal) : req.spanHeal ? readClaudeSpanTrims(req.spanHeal) : runSidecar("index", req.args, parseIndexOutput, {
      input: req.input,
      timeout: sidecarTimeoutMs("index", req.staleCount),
    }));
  }
  return step.value;
}

/** Async builds run one at a time: each sees the cache the previous one left. */
let _asyncBuildChain = Promise.resolve();

/**
 * buildIndex for the server (fact hsa1): identical algorithm, but the sidecar
 * runs as an asynchronous child so the event loop keeps answering requests.
 */
export function buildIndexAsync(sessions, opts = {}) {
  const run = _asyncBuildChain.then(async () => {
    const steps = buildIndexSteps(sessions, opts);
    let step = steps.next();
    while (!step.done) {
      const req = step.value;
      step = steps.next(req.codexHeal ? await readCodexModelsAsync(req.codexHeal) : req.spanHeal ? await readClaudeSpanTrimsAsync(req.spanHeal) : await runSidecarAsync("index", req.args, parseIndexOutput, {
        input: req.input,
        timeoutMs: sidecarTimeoutMs("index", req.staleCount),
      }));
    }
    return step.value;
  });
  _asyncBuildChain = run.catch(() => {});
  return run;
}
