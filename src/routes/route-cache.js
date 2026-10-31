import { existsSync, statSync } from "node:fs";
import {
  beginIndexDiskMtimeCoalesce,
  endIndexDiskMtimeCoalesce,
  indexDiskMtimeMs,
} from "../sessions/index-writers.js";
import { isIndexDiskExpectedErr } from "../utils/fs-expected-err.js";
import { getSearchIndex } from "../sessions/search-index.js";
import { discoveryRoots } from "../sessions/session-discovery.js";
import { sessionChangeJournalActive, takeDataChanges, watchedDataRoots } from "../sessions/session-changes.js";
import { applySessionChanges, createSessionBase } from "../sessions/session-incremental.js";
import { sessionMtimeMs } from "../sessions/session-list.js";
import { isSessionHash, resolveSessionHandle } from "../sessions/session-hash.js";
import { resolveHostsRoot } from "../sessions/session-discovery-paths.js";
import {
  broadcastLr,
  dataChangeSeq,
  dataUpdateGeneration,
  dataWatching,
  modVersion,
  registerDataUpdateListener,
} from "../server/server-live-reload.js";

export function getDataRoots() {
  return discoveryRoots();
}

export const DATA_ROOTS = getDataRoots();

let _routeCache = null;

/** Unfiltered session list snapshot for live detection when the table is filtered. */
let _globalSessionsSnapshot = null;

export function buildRouteCacheKey(filter, roots = getDataRoots(), indexMtimeMs = indexDiskMtimeMs()) {
  const parts = [filter || "", String(modVersion()), String(indexMtimeMs)];
  for (const root of roots) {
    try {
      parts.push(String(statSync(root).mtime.getTime()));
    } catch (err) {
      if (!isIndexDiskExpectedErr(err)) {
        console.error(`buildRouteCacheKey: stat failed for ${root}:`, err.message);
      }
      parts.push("0");
    }
  }
  return parts.join(":");
}

export function clearRouteCache() {
  _routeCache = null;
  _globalSessionsSnapshot = null;
}

export function peekApiResponseBody(cacheKey, subKey) {
  // TRACEQUEST_NO_RESPONSE_CACHE=1 answers every API request afresh (timing repeated queries).
  if (process.env.TRACEQUEST_NO_RESPONSE_CACHE === "1") return undefined;
  if (!_routeCache || _routeCache.key !== cacheKey) return undefined;
  if (!isRouteCacheTopMtimesValid(_routeCache)) return undefined;
  return _routeCache.responseBodies?.get(subKey);
}

export function storeApiResponseBody(cacheKey, subKey, body) {
  if (!_routeCache || _routeCache.key !== cacheKey) return;
  if (!isRouteCacheTopMtimesValid(_routeCache)) return;
  if (!_routeCache.responseBodies) _routeCache.responseBodies = new Map();
  _routeCache.responseBodies.set(subKey, body);
}

function rememberGlobalSessions(sessions, indexMtimeMs = indexDiskMtimeMs()) {
  _globalSessionsSnapshot = { key: buildRouteCacheKey(null, getDataRoots(), indexMtimeMs), sessions };
}

function getGlobalSessionsSnapshot(indexMtimeMs = indexDiskMtimeMs()) {
  const nullKey = buildRouteCacheKey(null, getDataRoots(), indexMtimeMs);
  if (_globalSessionsSnapshot?.key === nullKey) {
    return _globalSessionsSnapshot.sessions;
  }
  const nullCached = peekRouteCache(nullKey);
  if (nullCached) {
    _globalSessionsSnapshot = { key: nullKey, sessions: nullCached.sessions };
    return nullCached.sessions;
  }
  return undefined;
}

/**
 * True when cached top-N session mtimes still match disk. While the data roots
 * are watched, every change is recorded and the cache is dropped at the next
 * data-update tick, so the entry stays valid until then (fact hlinc).
 */
export function isRouteCacheTopMtimesValid(entry) {
  if (entry.topMtimes === undefined) return false;
  if (dataWatching()) return true;
  if (!entry.sessions.length) return true;
  const limit = Math.min(5, entry.sessions.length);
  for (let i = 0; i < limit; i++) {
    try {
      const currentMtime = statSync(entry.sessions[i].path).mtime.getTime();
      if (currentMtime !== entry.topMtimes[i]) return false;
    } catch (err) {
      // Missing file: directory mtime would change on Linux; base key would miss.
      // For mocked paths in tests, treat ENOENT as still valid.
      if (!isIndexDiskExpectedErr(err)) {
        console.error(`route-cache: stat failed for ${entry.sessions[i].path}:`, err.message);
        return false;
      }
    }
  }
  return true;
}

export function peekRouteCache(cacheKey) {
  if (!_routeCache || _routeCache.key !== cacheKey) return null;
  if (!isRouteCacheTopMtimesValid(_routeCache)) return null;
  const { sessions, index, allSessions } = _routeCache;
  return allSessions !== undefined
    ? { sessions, index, allSessions }
    : { sessions, index };
}

export function storeRouteCache(cacheKey, sessions, index, allSessions = undefined) {
  const topMtimes = [];
  const limit = Math.min(5, sessions.length);
  for (let i = 0; i < limit; i++) {
    topMtimes.push(sessionMtimeMs(sessions[i]));
  }
  const newestMtime = sessions.length ? sessionMtimeMs(sessions[0]) : 0;
  const responseBodies = _routeCache?.key === cacheKey ? _routeCache.responseBodies : undefined;
  _routeCache = { key: cacheKey, sessions, index, topMtimes, newestMtime, allSessions, responseBodies };
}

export function routeCacheKeyWithIndexMtime(filter, roots = getDataRoots()) {
  const indexMtimeMs = indexDiskMtimeMs();
  return { cacheKey: buildRouteCacheKey(filter, roots, indexMtimeMs), indexMtimeMs };
}

registerDataUpdateListener(() => clearRouteCache());

export function resolveSessionsAndIndex(filter, deps, opts = {}) {
  const coalesceOwned = !opts.indexMtimeMs;
  if (coalesceOwned) beginIndexDiskMtimeCoalesce();
  try {
    const { cacheKey, indexMtimeMs } = opts.indexMtimeMs != null
      ? { cacheKey: buildRouteCacheKey(filter, getDataRoots(), opts.indexMtimeMs), indexMtimeMs: opts.indexMtimeMs }
      : routeCacheKeyWithIndexMtime(filter);
    const cached = peekRouteCache(cacheKey);
    if (cached) return cached;
    const sessions = deps.findSessions(filter);
    // A filtered list is a subset: it must never prune the shared index (fact hsf1).
    const index = deps.buildIndex(sessions, filter
      ? { indexDiskMtimeMs: indexMtimeMs, partial: true }
      : { indexDiskMtimeMs: indexMtimeMs });
    if (!filter) {
      rememberGlobalSessions(sessions, indexMtimeMs);
      storeRouteCache(cacheKey, sessions, index);
      return { sessions, index, allSessions: sessions };
    }
    const allSessions = getGlobalSessionsSnapshot(indexMtimeMs);
    storeRouteCache(cacheKey, sessions, index, allSessions);
    return { sessions, index, allSessions };
  } finally {
    if (coalesceOwned) endIndexDiskMtimeCoalesce();
  }
}

/** A refresh still running after this long is not waited for (fact sidx4). */
const STALE_AFTER_MS = 50;

/** Refreshes some request was answered ahead of (fact sidx4). */
const _staleServed = new Set();

/** In-flight async refreshes by route-cache key: concurrent requests share one (fact hsa4). */
const _inflight = new Map();

/** Filtered async results (the single route-cache slot holds the global list). */
const _filteredCache = new Map();
const FILTERED_CACHE_MAX = 8;

function coalescedRouteKey(filter) {
  beginIndexDiskMtimeCoalesce();
  try {
    return routeCacheKeyWithIndexMtime(filter).cacheKey;
  } finally {
    endIndexDiskMtimeCoalesce();
  }
}

function singleFlight(key, start) {
  let p = _inflight.get(key);
  if (!p) {
    p = start().finally(() => {
      if (_inflight.get(key) === p) _inflight.delete(key);
    });
    _inflight.set(key, p);
  }
  return p;
}

/** The last global discovery, the base the next incremental refresh starts from. */
let _discoveryBase = null;

/**
 * The unfiltered session list, refreshed incrementally from the watcher journal
 * when serve watches the data roots (facts hsi1, hsi2), else by a full scan.
 * Callers serialize it (refreshGlobal): each run applies the journal to the
 * list the previous one left.
 */
async function discoverGlobalSessions(deps) {
  // Drain before scanning: whatever changes during the scan is journaled
  // again and applied by the next refresh.
  const changes = takeDataChanges();
  const roots = getDataRoots();
  if (_discoveryBase && deps.scanRootsAsync && sessionChangeJournalActive()) {
    try {
      const next = await applySessionChanges(_discoveryBase, changes, {
        roots,
        watchedRoots: watchedDataRoots(),
        scanRoots: deps.scanRootsAsync,
      });
      if (next) return next;
    } catch (err) {
      // Never worse than before: a failed incremental step costs one full scan.
      console.error("tracequest: incremental session refresh failed, rescanning:", err?.message || err);
    }
  }
  // The drained journal is gone: until this scan completes there is no base
  // the next refresh could patch correctly.
  _discoveryBase = null;
  const sessions = await deps.findSessionsAsync(null);
  _discoveryBase = deps.scanRootsAsync ? createSessionBase(sessions, roots, resolveHostsRoot()) : null;
  return sessions;
}

/** @internal — tests only */
export function _resetDiscoveryBaseForTests() {
  _discoveryBase = null;
  _lastGlobalResult = null;
}

/** Global refreshes run one at a time: each patches the list the previous one left. */
let _refreshChain = Promise.resolve();

function refreshGlobal(deps) {
  const run = _refreshChain.then(() => refreshGlobalNow(deps));
  _refreshChain = run.catch(() => {});
  return run;
}

async function refreshGlobalNow(deps) {
  const seq = dataChangeSeq();
  const gen = dataUpdateGeneration();
  const watching = dataWatching();
  const rootsBefore = buildRouteCacheKey(null, getDataRoots(), 0);
  const sessions = await discoverGlobalSessions(deps);
  // The first list of a watched server is served from the index as it is on
  // disk; what changed since it was written is indexed right after (fact sidx4).
  const first = !_lastGlobalResult && watching;
  const index = await deps.buildIndexAsync(sessions, first ? { deferStale: true } : undefined);
  if (index?.deferredStale) {
    getSearchIndex().buildTrigramsAsync().catch(() => {});
    _lastGlobal = sessions;
    _lastGlobalResult = { sessions, index, allSessions: sessions };
    setImmediate(() => resolveSessionsAndIndexAsync(null, deps).catch(() => {}));
    return _lastGlobalResult;
  }
  // Ready for the first fuzzy query without stalling one (fact sidx3).
  getSearchIndex().buildTrigramsAsync().catch(() => {});
  // Key AFTER the build: an index run may rewrite index.json, and the next
  // request computes its key from the disk mtime it finds then. Store only
  // when nothing changed while the refresh ran (while watched: no data-update
  // tick passed); the result itself is still newer than the request that
  // started it, so callers get it either way.
  const unchanged = watching && dataWatching() ? gen === dataUpdateGeneration() : seq === dataChangeSeq();
  if (unchanged && rootsBefore === buildRouteCacheKey(null, getDataRoots(), 0)) {
    const indexMtimeMs = indexDiskMtimeMs();
    rememberGlobalSessions(sessions, indexMtimeMs);
    storeRouteCache(buildRouteCacheKey(null, getDataRoots(), indexMtimeMs), sessions, index);
  }
  _lastGlobal = sessions;
  _lastGlobalResult = { sessions, index, allSessions: sessions };
  return _lastGlobalResult;
}

/** The last complete global refresh, answered while a newer one runs (fact sidx4). */
let _lastGlobalResult = null;

/** Newest global session list any refresh produced (for hash-handle lookup). */
let _lastGlobal = null;

/** The newest global session list already discovered, or null before the first refresh. */
export function latestSessionsSnapshot() {
  return _lastGlobal || _globalSessionsSnapshot?.sessions || null;
}

/** Async discovery/indexing twins of deps' functions, or null (test doubles). */
function asyncDeps(deps) {
  const findSessionsAsync = deps?.findSessionsAsync || deps?.findSessions?.async;
  const buildIndexAsync = deps?.buildIndexAsync || deps?.buildIndex?.async;
  if (typeof findSessionsAsync !== "function" || typeof buildIndexAsync !== "function") return null;
  const scanRootsAsync = deps?.scanRootsAsync || deps?.findSessions?.inRootsAsync;
  return { findSessionsAsync, buildIndexAsync, scanRootsAsync: typeof scanRootsAsync === "function" ? scanRootsAsync : null };
}

/**
 * Server variant of resolveSessionsAndIndex (facts hsa1, hsa4, hsf1). Discovery
 * and indexing run as asynchronous sidecar children, so the event loop keeps
 * answering other requests; concurrent callers share one refresh; a filtered
 * request answers from the global index restricted to the filtered sessions
 * and never rebuilds or prunes it. Deps without async capabilities (tests)
 * fall back to the synchronous resolver.
 */
export async function resolveSessionsAndIndexAsync(filter, depsIn, { staleAfterMs = STALE_AFTER_MS } = {}) {
  const deps = asyncDeps(depsIn);
  if (!deps) return resolveSessionsAndIndex(filter, depsIn);
  const globalKey = coalescedRouteKey(null);
  let global = peekRouteCache(globalKey);
  if (global) global = { ...global, allSessions: global.sessions };
  else if (_lastGlobalResult && dataWatching()) {
    // Watched data changed: a refresh that takes longer than STALE_AFTER_MS is
    // not waited for; the sessions and index already built answer meanwhile
    // (fact sidx4), and pages are told to refetch once it lands.
    const last = _lastGlobalResult;
    const refresh = singleFlight(`global:${globalKey}`, () => refreshGlobal(deps));
    let timer;
    global = await Promise.race([refresh, new Promise((resolve) => { timer = setTimeout(resolve, staleAfterMs, null); })]);
    clearTimeout(timer);
    if (!global) {
      global = { ...last, stale: true };
      if (!_staleServed.has(refresh)) {
        _staleServed.add(refresh);
        refresh.then(() => broadcastLr("data: data-update\n\n"), () => {}).finally(() => _staleServed.delete(refresh));
      }
    }
  } else global = await singleFlight(`global:${globalKey}`, () => refreshGlobal(deps));
  if (!filter) return global;

  const filteredKey = coalescedRouteKey(filter);
  const hit = _filteredCache.get(filter);
  if (hit && hit.key === filteredKey && hit.index === global.index && isRouteCacheTopMtimesValid(hit)) {
    return { sessions: hit.sessions, index: global.index, allSessions: global.sessions };
  }
  const sessions = await singleFlight(`filter:${filteredKey}`, () => deps.findSessionsAsync(filter));
  const topMtimes = sessions.slice(0, 5).map((s) => sessionMtimeMs(s));
  _filteredCache.delete(filter);
  _filteredCache.set(filter, { key: filteredKey, sessions, index: global.index, topMtimes });
  if (_filteredCache.size > FILTERED_CACHE_MAX) _filteredCache.delete(_filteredCache.keys().next().value);
  return { sessions, index: global.index, allSessions: global.sessions };
}

/**
 * Session list for resolving a short hash handle without blocking: the last
 * global list when it already names the handle, else the current list, else
 * one fresh asynchronous walk.
 * Returns a synchronous finder for resolveSessionPathForRequest.
 */
export async function sessionFinderForHandle(handle, deps) {
  if (!asyncDeps(deps)) return deps?.findSessions || null;
  const snapshot = latestSessionsSnapshot();
  // Only a hash the last list does not know needs a fresh scan: a path never
  // consults the list for resolution, and a known hash names the same file.
  if (!isSessionHash(handle)) return () => snapshot || [];
  if (snapshot && namesExisting(handle, snapshot)) return () => snapshot;
  const { sessions } = await resolveSessionsAndIndexAsync(null, deps);
  if (namesExisting(handle, sessions)) return () => sessions;
  // A recording written after the current list (its tick not yet applied, or
  // under a root whose mtime did not change), or one removed since: one fresh
  // walk, off the event loop.
  const fresh = await asyncDeps(deps).findSessionsAsync(null);
  return () => fresh;
}

/** True when `list` resolves `handle` (ambiguity included) to recordings still on disk. */
function namesExisting(handle, list) {
  const r = resolveSessionHandle(handle, list);
  if (r.status === "not-found") return false;
  const p = r.session?.path;
  return !p || p.startsWith("opencode://") || existsSync(p);
}

registerDataUpdateListener(() => _filteredCache.clear());
