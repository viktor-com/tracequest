import { existsSync } from "node:fs";
import { watchDir, watchTree, watchFile } from "./fs-watch.js";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { clearLiveSessionsCache } from "../sessions/live-sessions.js";
import {
  resolveCursorCloudRoot,
  resolveHostsRoot,
  resolveOpenCodeDbPath,
} from "../sessions/session-discovery-paths.js";
import {
  claudeProjectsRoot,
  codexSessionsRoot,
  cursorProjectsRoot,
  factorySessionsRoot,
} from "../sessions/session-layout.js";

/** Debounce window (ms) before broadcasting session-data SSE after fs churn. */
export const DATA_UPDATE_DEBOUNCE_MS = 3000;

/** Connected SSE response objects for /__livereload. */
export const lrClients = new Set();

export const SRC_HOT_RELOAD_HELPER_DIRS = ["render", "server", "browser"];

let _modVersion = 0;

/** Monotonic counter bumped when src/*.js changes (invalidates hotModules + route cache). */
export function modVersion() {
  return _modVersion;
}

/** @internal — used by src watcher and tests */
export function bumpModVersion() {
  _modVersion++;
}

/** @internal — restore hot-reload generation after tests (parallel suites must not leak bumps) */
export function _resetModVersionForTests(value = 0) {
  _modVersion = value;
}

/** Serializes suites that bump modVersion so parallel workers cannot clobber each other's baseline. */
let _modVersionTestChain = Promise.resolve();

/** @internal — await before bumping modVersion in tests; call release() in afterEach */
export function _acquireModVersionTestIsolation() {
  const waitTurn = _modVersionTestChain;
  /** @type {() => void} */
  let releaseTurn;
  _modVersionTestChain = new Promise((resolve) => {
    releaseTurn = resolve;
  });
  return waitTurn.then(() => {
    const baseline = _modVersion;
    return {
      baseline,
      release() {
        _modVersion = baseline;
        releaseTurn();
      },
    };
  });
}

export function isRelevantDataFilename(filename) {
  if (!filename) return false;
  return (
    filename.includes("chat_history") ||
    filename.endsWith(".jsonl") ||
    filename.includes("opencode.db") ||
    basename(filename) === "active_sessions.json"
  );
}

export function isSrcHotReloadFile(filename) {
  return Boolean(filename && filename.endsWith(".js"));
}

/**
 * Null-filename policy for data roots: fail open. The platform saw a change but
 * could not name it, and a missed session update is worse than one extra
 * debounced refresh. The src watcher deliberately does the opposite — see
 * isSrcHotReloadFile, where null is falsy, because a spurious browser reload
 * interrupts the developer and the next real edit reports a name anyway.
 */
export function shouldTriggerDataUpdate(filename) {
  return filename === null || isRelevantDataFilename(filename);
}

export function broadcastLr(payload) {
  for (const client of lrClients) {
    try {
      client.write(payload);
    } catch (err) {
      console.warn("live-reload SSE write failed:", err.message);
      lrClients.delete(client);
    }
  }
}

let _dataTimer = null;

/** Callbacks run after debounced fs churn (e.g. route-cache invalidation). */
const _dataUpdateListeners = new Set();

/** Register a handler invoked once per debounced data-update (tests may reset via _resetDataUpdateListenersForTests). */
export function registerDataUpdateListener(fn) {
  _dataUpdateListeners.add(fn);
  return () => _dataUpdateListeners.delete(fn);
}

/** @internal — clear listener registry (tests only) */
export function _resetDataUpdateListenersForTests() {
  _dataUpdateListeners.clear();
}

export function triggerDataUpdate() {
  if (_dataTimer) return;
  _dataTimer = setTimeout(() => {
    _dataTimer = null;
    clearLiveSessionsCache();
    for (const fn of _dataUpdateListeners) {
      try {
        fn();
      } catch (err) {
        console.error("data-update listener failed:", err);
      }
    }
    broadcastLr("data: data-update\n\n");
  }, DATA_UPDATE_DEBOUNCE_MS);
}

/** @internal — reset debounce timer (tests only) */
export function _resetDataUpdateTimerForTests() {
  if (_dataTimer) {
    clearTimeout(_dataTimer);
    _dataTimer = null;
  }
}

/** @internal — whether fs.watch listeners were registered (tests only) */
export function _watchersStartedForTests() {
  return _watchersStarted;
}

/** Active fs.watch handles — closed on test reset so listeners do not leak. */
const _activeWatchers = [];

function trackWatcher(handle) {
  if (handle && typeof handle.close === "function") {
    _activeWatchers.push(handle);
  }
}

/** @internal — allow startLiveReloadWatchers to run again (tests only) */
export function _resetWatchersStartedForTests() {
  for (const handle of _activeWatchers) {
    try {
      handle.close();
    } catch {
      /* ignore close errors in tests */
    }
  }
  _activeWatchers.length = 0;
  _watchersStarted = false;
}

function sourcePath(srcDir) {
  return srcDir instanceof URL ? fileURLToPath(srcDir) : srcDir;
}

function watchSrcHotReloadDir(dir, label) {
  if (!existsSync(dir)) return;
  // Fail-closed on a null filename: a spurious reload interrupts the developer,
  // and the next real edit reports a name anyway.
  trackWatcher(
    watchDir(dir, (filename) => {
      if (isSrcHotReloadFile(filename)) {
        bumpModVersion();
        broadcastLr("data: reload\n\n");
      }
    }, { label })
  );
}

function watchSrcHotReload(srcDir) {
  const srcPath = sourcePath(srcDir);
  watchSrcHotReloadDir(srcPath, "src/");
  for (const dir of SRC_HOT_RELOAD_HELPER_DIRS) {
    watchSrcHotReloadDir(join(srcPath, dir), `src/${dir}/`);
  }
}

function watchDataRoot(root) {
  trackWatcher(
    watchTree(root, (filename) => {
      if (shouldTriggerDataUpdate(filename)) triggerDataUpdate();
    }, { label: `data root ${root}` })
  );
}

function watchOpenCodeDb(dbPath) {
  // watchFile (not watchTree): SQLite is replaced by rename, which kills a plain
  // inode-bound watcher. The facade re-arms.
  trackWatcher(watchFile(dbPath, () => triggerDataUpdate(), { label: "opencode.db" }));
}

let _watchersStarted = false;

/** Idempotent; no-op when TRACEQUEST_SKIP_LR_WATCH=1. */
export function startLiveReloadWatchers(opts) {
  if (_watchersStarted || process.env.TRACEQUEST_SKIP_LR_WATCH === "1") return;
  _watchersStarted = true;

  const { srcDir, dataRoots, openCodeDbPath } = opts;
  watchSrcHotReload(srcDir);

  for (const root of dataRoots) {
    watchDataRoot(root);
  }

  const dbPath = openCodeDbPath ?? resolveOpenCodeDbPath(homedir());
  watchOpenCodeDb(dbPath);
}

/**
 * Default session data roots (mirrors route-cache DATA_ROOTS minus the db
 * file path), built from the shared layout module. The cursor projects root
 * used to be MISSING here — the same "cursor is invisible to half the
 * codebase" drift the round-7 attribution fix closes: recordings the real
 * Cursor CLI appends to triggered no data-update tick, so a live cursor
 * session's page never refreshed itself.
 */
export function defaultDataRoots(home = homedir()) {
  return [
    join(home, ".grok"),
    claudeProjectsRoot(home),
    codexSessionsRoot(home),
    cursorProjectsRoot(home),
    factorySessionsRoot(home),
    join(home, ".local", "share", "opencode"),
    // The two tracequest-owned import roots. discoveryRoots() has always
    // scanned these, so a recording imported from cursor-cloud or over ssh was
    // listed by the next scan but raised no data-update tick of its own — it
    // appeared only when something else happened to invalidate the cache, or
    // after a restart (fact dyr). Watching the hosts ROOT rather than each host
    // covers hosts imported after the server started, too.
    resolveCursorCloudRoot(home),
    resolveHostsRoot(home),
  ];
}
