/**
 * Journal of the paths serve's data-root watchers reported since the last
 * session-list refresh (facts hsi1, hsi2). The incremental refresh drains it and
 * re-reads only those paths; anything it cannot name forces a full scan.
 *
 * The journal is inactive (and the refresh always scans everything) until a
 * data root is actually being watched, so CLI commands and servers started with
 * TRACEQUEST_SKIP_LR_WATCH=1 keep the full-scan behaviour.
 */
import { join } from "node:path";

/** Past this many distinct paths a full scan is cheaper than stat-ing each one. */
const MAX_JOURNAL_PATHS = 20_000;

const _watchedRoots = new Set();
let _paths = new Set();
let _unknown = false;

/**
 * A watcher is now live on `root`: every change under it will be journaled.
 * Changes made before it started were not, so the next refresh scans fully.
 */
export function noteWatchedDataRoot(root) {
  if (!_watchedRoots.has(root)) {
    _unknown = true;
    _paths = new Set();
  }
  _watchedRoots.add(root);
}

/** Roots with a live recursive watcher. */
export function watchedDataRoots() {
  return [..._watchedRoots];
}

export function sessionChangeJournalActive() {
  return _watchedRoots.size > 0;
}

/**
 * Record one watcher event. `filename` is relative to `root`; null means the
 * platform could not name the change, so only a full scan is correct.
 */
export function noteDataChange(root, filename) {
  if (!_watchedRoots.size || _unknown) return;
  if (filename == null) {
    _unknown = true;
    _paths = new Set();
    return;
  }
  _paths.add(filename === "" ? root : join(root, String(filename)));
  if (_paths.size > MAX_JOURNAL_PATHS) {
    _unknown = true;
    _paths = new Set();
  }
}

/** Every change so far, emptied: `{ paths, unknown }`. */
export function takeDataChanges() {
  const out = { paths: _paths, unknown: _unknown };
  _paths = new Set();
  _unknown = false;
  return out;
}

/** @internal — tests only */
export function _resetSessionChangesForTests() {
  _watchedRoots.clear();
  _paths = new Set();
  _unknown = false;
}
