import { statSync } from "node:fs";
import {
  beginIndexDiskMtimeCoalesce,
  endIndexDiskMtimeCoalesce,
  indexDiskMtimeMs,
} from "../sessions/index-writers.js";
import { isIndexDiskExpectedErr } from "../utils/fs-expected-err.js";
import { discoveryRoots } from "../sessions/session-discovery.js";
import { sessionMtimeMs } from "../sessions/session-list.js";
import { modVersion, registerDataUpdateListener } from "../server/server-live-reload.js";

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

/** True when cached top-N session mtimes still match disk. */
export function isRouteCacheTopMtimesValid(entry) {
  if (entry.topMtimes === undefined) return false;
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
    const index = deps.buildIndex(sessions, { indexDiskMtimeMs: indexMtimeMs });
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