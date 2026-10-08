import {
  existsSync,
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir, availableParallelism } from "node:os";
import { Worker, MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sessionMtimeMs } from "./session-list.js";
import { openOpenCodeDbReadOnly } from "./session-discovery-paths.js";
import { indexOpenCode } from "./session-index-opencode.js";
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

const SIDECAR_SPAWN_OPTS = { encoding: "utf-8", maxBuffer: 128 * 1024 * 1024 };

export function runSidecar(op, args, parseSuccess, spawnExtra = {}) {
  const sidecar = detectSidecar();
  if (!sidecar) return null;
  try {
    const result = spawnSync(sidecar, args, { ...SIDECAR_SPAWN_OPTS, ...spawnExtra });
    if (result.status === 0) {
      try {
        return parseSuccess(result);
      } catch (err) {
        const detail = (result.stderr || "").trim();
        const suffix = detail ? ` (stderr: ${safeSlice(detail, 120)})` : "";
        console.warn(`Sidecar ${op} output parse failed, falling back to JS:`, err.message + suffix);
        return null;
      }
    }
    warnSidecarFailure(op, result);
  } catch (e) {
    console.warn(`Sidecar ${op} spawn failed, falling back to JS:`, e.message);
  }
  return null;
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
    if (k !== "_v") n++;
  }
  _indexCachePathCount = n;
}

/** Drop stale index entries; skip scan when cache cannot exceed current session count. */
export function pruneIndexCache(cache, validPaths) {
  if (_indexCachePathCount <= validPaths.size) return;
  for (const k of Object.keys(cache)) {
    if (k === "_v") continue;
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
  let opencodeDb = null;
  // _indexSession fails closed on an unrecognised source, so the close must run
  // on the throw path too or the read-only SQLite handle leaks (fact 80i).
  try {
    for (const entry of chunk) {
      const s = sessionFromStaleEntry(entry);
      if ((s.source || "claude") === "opencode") {
        if (!opencodeDb) opencodeDb = openOpenCodeDbReadOnly();
        out[s.path] = indexOpenCode(s, opencodeDb.db);
      } else {
        out[s.path] = _indexSession(s);
      }
    }
  } finally {
    if (opencodeDb) opencodeDb.db.close();
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

export function storeStaleIndex(s, data, cache, result, mtimeMs) {
  data.mtime = mtimeMs ?? sessionMtimeMs(s);
  if (!Object.hasOwn(cache, s.path)) _indexCachePathCount++;
  // Capture SearchIndex terms, then strip transient/legacy full-text fields from metadata.
  const tf = termFreqsFromMeta(data);
  if (data.termFreqs !== undefined) delete data.termFreqs;
  stripLegacySearchText(data);
  cache[s.path] = data;
  result.set(s.path, data);
  // Update SearchIndex immediately (fact msg / v99).
  const si = getSearchIndex();
  si.upsert(s.path, tf);
}

export function buildIndex(sessions, opts = {}) {
  const t0 = Date.now();

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
  let cached = 0;
  let searchIdxMutated = false;

  // When an existing search.idx failed to load, SI is empty and every
  // mtime-cached session must re-emit termFreqs. When search.idx is simply
  // absent, this flag stays false; individual cache hits still re-tokenize
  // through the !si.has(s.path) check because index.json is metadata-only.
  const siNeedsRebuild = _searchIdxLoadFailedExistingFile && si.docCount === 0;

  for (const s of sessions) {
    const mtime = sessionMtimeMs(s);
    if (cache[s.path] && cache[s.path].mtime === mtime) {
      if (siNeedsRebuild || !si.has(s.path)) {
        // Existing search.idx load failure emptied SI, or this session is absent
        // from SI (e.g. search.idx deleted): re-index to get termFreqs because
        // index.json has metadata only (fact msg).
        staleSessions.push({ session: s, mtime });
      } else {
        result.set(s.path, cache[s.path]);
        cached++;
      }
    } else {
      staleSessions.push({ session: s, mtime });
    }
  }

  if (staleSessions.length === 0) {
    // All surviving sessions are cache hits. Check whether the cache contains
    // entries for sessions that no longer exist on disk (e.g. a session was
    // deleted while all remaining sessions had unchanged mtimes). The fast path
    // is O(1): only build validPaths and prune when counts differ (fact 03w).
    if (_indexCachePathCount > sessions.length) {
      const validPaths = new Set();
      for (const s of sessions) validPaths.add(s.path);
      pruneIndexCache(cache, validPaths);
      cache._v = INDEX_VERSION;
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

  const useSidecar = detectSidecar();
  indexStatusBuilding(sessions.length, staleSessions.length, useSidecar);
  if (useSidecar) {
    const sidecarSessions = new Array(sessions.length);
    for (let i = 0; i < sessions.length; i++) {
      sidecarSessions[i] = sessionPayloadForSidecarIndex(sessions[i]);
    }
    // Compute search-stale: sessions present in metadata cache but absent from
    // the SearchIndex (fact 8rj). The sidecar will re-parse these even if mtime
    // matches, so termFreqs are emitted and available for SearchIndex upsert.
    const searchStale = [];
    for (const s of sessions) {
      if (!si.has(s.path)) searchStale.push(s.path);
    }

    const sidecarArgs = [
      "index",
      "--index-path", indexPath(),
      "--version", String(INDEX_VERSION),
      "--sessions-stdin",
      "--term-freqs",
    ];

    // Pass sessions and searchStale together in stdin object to avoid ARG_MAX (fact 4hh).
    const stdinPayload = JSON.stringify({ sessions: sidecarSessions, searchStale });

    const sidecarIndex = runSidecar("index", sidecarArgs,
      (result) => parseSidecarIndexStdout(result.stdout), { input: stdinPayload });
    if (sidecarIndex) {
      // Merge sidecar entries into metadata cache and SearchIndex (facts 8rj, wyt).
      // The sidecar emits termFreqs (plain object) for freshly parsed/search-stale
      // entries; convert to Map and upsert via the same path as JS indexers.
      let sidecarSearchMutated = false;
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
        if (tf !== null) {
          si.upsert(path, tf);
          sidecarSearchMutated = true;
        }
      }

      // Prune sessions no longer on disk from cache and SearchIndex (fact 03w).
      const validPaths = new Set(sessions.map(s => s.path));
      pruneIndexCache(cache, validPaths);
      cache._v = INDEX_VERSION;
      _indexFileCache = cache;
      syncIndexCachePathCount(cache);
      scheduleIndexWrite();
      if (sidecarSearchMutated || searchIdxMutated) scheduleSearchIdxWrite();

      _resultMapCache = result;
      _resultMapKey = mapKey;
      indexStatus(
        `tracequest: indexed ${sidecarIndex.size} session${sidecarIndex.size !== 1 ? "s" : ""} via sidecar (${Date.now() - t0}ms)`,
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
    if (cache === _indexFileCache) {
      const next = { _v: _indexFileCache._v };
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
    for (const { session: s, mtime } of staleSessions) {
      storeStaleIndex(s, indexed[s.path] || _indexSession(s), cache, result, mtime);
    }
  } else {
    const logEvery = sessions.length > 1000 ? 500 : 100;
    let opencodeDb = null;
    // _indexSession fails closed on an unrecognised source, so the close must run
    // on the throw path too or the read-only SQLite handle leaks (fact 80i).
    try {
      for (let i = 0; i < staleSessions.length; i++) {
        const { session: s, mtime } = staleSessions[i];
        const tIndex = Date.now();
        let meta;
        if ((s.source || "claude") === "opencode") {
          if (!opencodeDb) opencodeDb = openOpenCodeDbReadOnly();
          meta = indexOpenCode(s, opencodeDb.db);
        } else {
          meta = _indexSession(s);
        }
        storeStaleIndex(s, meta, cache, result, mtime);
        const indexMs = Date.now() - tIndex;
        if (indexMs > 100 || (i + 1) % logEvery === 0 || i < 3) {
          const elapsed = Date.now() - t0;
          indexLog(`  [${i + 1}/${staleSessions.length}] ${s.source} ${(s.file || "").slice(0, 20)} index=${indexMs}ms total=${elapsed}ms`);
        }
      }
    } finally {
      if (opencodeDb) opencodeDb.db.close();
    }
  }

  const stale = staleSessions.length;

  if (stale) {
    pruneIndexCache(cache, validPaths);
    cache._v = INDEX_VERSION;
    _indexFileCache = cache;
    syncIndexCachePathCount(cache);
    scheduleIndexWrite();
    scheduleSearchIdxWrite(); // deferred write of search.idx (fact v99)
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
