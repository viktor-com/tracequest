import { send } from "../server/server-http.js";
import { getInitialFilter, hotModules } from "../server/server-state.js";
import { dataWatching, registerDataUpdateListener } from "../server/server-live-reload.js";
import {
  buildLiveSessionList,
  computeStats,
  getSessionMeta,
  sessionToApiObject,
} from "../server/server-helpers.js";
import { applyExprFirstResultsAsync, FilterParseError } from "../filter/filter.js";
import { verifyPhraseOffThread } from "../server/phrase-check.js";
import { searchStepRunner } from "../server/search-steps.js";
import { searchSessionsAsync } from "../sessions/scan-queries.js";
import { detectLiveSessions, liveSessionsCacheTime } from "../sessions/live-sessions.js";
import { sessionRows, sessionRowsStats, stampRowsLive } from "./session-rows.js";
import { warmLiveSessions } from "../sessions/live-sessions-async.js";
import { sessionHash } from "../sessions/session-hash.js";
import { liveSessionActivity } from "./route-handlers-launch.js";
import {
  beginIndexDiskMtimeCoalesce,
  endIndexDiskMtimeCoalesce,
} from "../sessions/index-writers.js";
import {
  peekApiResponseBody,
  resolveSessionsAndIndex,
  resolveSessionsAndIndexAsync,
  routeCacheKeyWithIndexMtime,
  storeApiResponseBody,
} from "./route-cache.js";

/**
 * A data-update tick invalidates the session list and the live memo. While
 * the data roots are watched, the server applies the change when it happens
 * — the incremental refresh and one off-thread live probe — the way an index
 * is maintained on write, instead of making the next page or API request
 * wait for it; a request that arrives meanwhile shares the work in flight
 * (fact hleager).
 */
registerDataUpdateListener(() => {
  if (!dataWatching()) return;
  hotModules()
    .then((deps) => resolveSessionsAndIndexAsync(null, deps))
    .then(({ sessions }) => warmLiveSessions(sessions))
    .catch((err) => console.error("data-update refresh failed:", err?.message || err));
});

export function getSessionsAndIndex(url, deps) {
  const filter = url.searchParams.get("filter") || getInitialFilter() || null;
  return resolveSessionsAndIndex(filter, deps);
}

export { computeStats } from "../server/server-helpers.js";

export async function handleApiSessions(_req, res, url, _deps = null) {
  const deps = _deps || await hotModules();
  const filter = url.searchParams.get("filter") || getInitialFilter() || null;
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const pageSize = Math.max(1, Math.min(200, parseInt(url.searchParams.get("pageSize") || "50", 10) || 50));
  const sort = url.searchParams.get("sort") || "recent";
  const exprParam = url.searchParams.get("expr") || "";
  beginIndexDiskMtimeCoalesce();
  let cacheKey;
  let sessions;
  let index;
  let allSessions;
  try {
    ({ cacheKey } = routeCacheKeyWithIndexMtime(filter));
    const liveTime = liveSessionsCacheTime();
    const liveMemoFresh = liveTime > 0 && Date.now() - liveTime < 5000;
    if (liveMemoFresh) {
      const responseSubKey = `sessions:${page}:${pageSize}:${sort}:${exprParam.trim()}:${liveTime}`;
      const cachedBody = peekApiResponseBody(cacheKey, responseSubKey);
      if (cachedBody !== undefined) {
        send(res, 200, cachedBody, "application/json; charset=utf-8");
        return;
      }
    }
  } finally {
    endIndexDiskMtimeCoalesce();
  }
  ({ sessions, index, allSessions } = await resolveSessionsAndIndexAsync(filter, deps));
  if (res.destroyed) return;
  const peekSession = deps.peekSession ?? (await hotModules()).peekSession;

  const sessionsForLive = allSessions ?? sessions;
  await warmLiveSessions(sessionsForLive);
  const livePaths = detectLiveSessions(sessionsForLive);
  const liveSet = new Set(livePaths);
  const liveSessions = buildLiveSessionList(sessionsForLive, livePaths, index, peekSession);
  // Every live session carries the SAME server-derived activity line a run
  // row gets — one origin-agnostic derivation (runActivityLine through the
  // shared etag-keyed parse memo), so the dashboard can render identical
  // live anatomy for launched and external agents alike.
  for (const ls of liveSessions) {
    ls.activity = liveSessionActivity(ls.path, ls.source, deps);
  }

  // Rows are built once per snapshot (fact hlmemo); the live bit is per request.
  const rows = sessionRows(sessions, index, peekSession);
  stampRowsLive(rows.objects, liveSet);
  let allObjects;
  // first=1: answer as soon as this page's rows are known (fact flt5).
  const firstResults = url.searchParams.get("first") === "1" && exprParam.trim() ? page * pageSize : 0;
  try {
    const answer = await filterFirstOffThread(res, rows.objects.slice(), exprParam, sort, firstResults);
    if (!answer) return;
    if (answer.partial) {
      const pageItems = answer.objects.slice((page - 1) * pageSize);
      send(res, 200, JSON.stringify({ sessions: pageItems, total: null, partial: true, page, pageSize, liveSessions }), "application/json; charset=utf-8");
      return;
    }
    allObjects = answer.objects;
  } catch (err) {
    if (err instanceof FilterParseError) {
      send(res, 400, JSON.stringify({ error: err.message }), "application/json; charset=utf-8");
      return;
    }
    throw err;
  }

  const total = allObjects.length;
  const maxPage = Math.max(1, Math.ceil(total / pageSize));
  const clampedPage = Math.min(page, maxPage);
  const stats = exprParam.trim() ? computeStats(allObjects) : sessionRowsStats(rows);
  const start = (clampedPage - 1) * pageSize;
  const end = Math.min(start + pageSize, total);
  const pageLen = end - start;
  const pageItems = pageLen ? new Array(pageLen) : [];
  for (let i = 0; i < pageLen; i++) {
    pageItems[i] = allObjects[start + i];
  }

  const body = JSON.stringify({ sessions: pageItems, total, page: clampedPage, pageSize, stats, liveSessions });
  storeApiResponseBody(
    cacheKey,
    `sessions:${page}:${pageSize}:${sort}:${exprParam.trim()}:${liveSessionsCacheTime()}`,
    body,
  );
  send(res, 200, body, "application/json; charset=utf-8");
}

/**
 * applyExprToApiObjects for a request (facts flt1, flt3): evaluated in slices,
 * quoted phrases checked in worker threads, stopped (null) once the client
 * has gone, as when it typed on and closed the request.
 */
export async function filterOffThread(res, apiObjects, expr, sort) {
  const answer = await filterFirstOffThread(res, apiObjects, expr, sort, 0);
  return answer && answer.objects;
}

/**
 * filterOffThread that, with `firstResults` > 0, may answer
 * `{ objects, partial: true }` with only the first `firstResults` rows (fact
 * flt5); otherwise `{ objects, partial: false }` with all of them.
 */
export async function filterFirstOffThread(res, apiObjects, expr, sort, firstResults) {
  const gone = new AbortController();
  if (res.destroyed) gone.abort();
  else if (typeof res.once === "function") res.once("close", () => { if (!res.writableEnded) gone.abort(); });
  // Typing sends one request per keystroke and aborts the one before: let a
  // pending close arrive before the expression's word sets are built.
  await new Promise((resolve) => setImmediate(resolve));
  if (gone.signal.aborted) return null;
  return applyExprFirstResultsAsync(apiObjects, expr, sort, { signal: gone.signal, verifyPhrase: verifyPhraseOffThread, firstResults });
}

export function parseApiSearchLimit(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(50, n);
}

export function parseApiSearchSnippets(raw) {
  if (raw == null || raw === "") return true;
  const v = String(raw).trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no" || v === "index");
}

export function parseApiSearchCatalog(raw) {
  if (raw == null || raw === "") return false;
  const v = String(raw).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Compact palette rows from metadata index — no JSONL / scanSessionForQuery. */
export function buildSearchCatalog(sessions, index) {
  const list = Array.isArray(sessions) ? sessions : [];
  const out = new Array(list.length);
  for (let i = 0; i < list.length; i++) {
    const s = list[i] || {};
    const meta = (index && typeof index.get === "function" ? index.get(s.path) : null) || {};
    const tools = Array.isArray(meta.tools) ? meta.tools : (Array.isArray(s.tools) ? s.tools : []);
    out[i] = {
      id: s.sessionHash || s.id || sessionHash(s.path),
      source: s.source || "claude",
      prompt: meta.firstPrompt || s.title || s.prompt || "",
      model: meta.model || s.model || "",
      project: s.project || "",
      tools,
    };
  }
  return out;
}

/** Identity catalog for palette pages / GET catalog=1. null when deps cannot resolve sessions. */
export function getSearchCatalog(deps, opts = {}) {
  if (!deps || typeof deps.findSessions !== "function" || typeof deps.buildIndex !== "function") {
    return null;
  }
  const filter = opts.filter !== undefined ? opts.filter : (getInitialFilter() || null);
  if (opts.sessions && opts.index) {
    const catalog = buildSearchCatalog(opts.sessions, opts.index);
    return catalog;
  }
  beginIndexDiskMtimeCoalesce();
  try {
    const { cacheKey, indexMtimeMs } = routeCacheKeyWithIndexMtime(filter);
    const responseSubKey = "search:catalog:";
    const cachedBody = peekApiResponseBody(cacheKey, responseSubKey);
    if (cachedBody !== undefined) {
      try {
        const data = JSON.parse(cachedBody);
        if (Array.isArray(data.sessions)) return data.sessions;
      } catch {
        // rebuild below
      }
    }
    const { sessions, index } = resolveSessionsAndIndex(filter, deps, { indexMtimeMs });
    const catalog = buildSearchCatalog(sessions, index);
    storeApiResponseBody(cacheKey, responseSubKey, JSON.stringify({ sessions: catalog }));
    return catalog;
  } finally {
    endIndexDiskMtimeCoalesce();
  }
}

/**
 * getSearchCatalog for request handlers: resolves sessions and index without
 * blocking the event loop (fact hsa1). Same cache and result shape.
 */
export async function getSearchCatalogAsync(deps, opts = {}) {
  if (!deps || typeof deps.findSessions !== "function" || typeof deps.buildIndex !== "function") {
    return null;
  }
  const filter = opts.filter !== undefined ? opts.filter : (getInitialFilter() || null);
  if (opts.sessions && opts.index) return buildSearchCatalog(opts.sessions, opts.index);
  const responseSubKey = "search:catalog:";
  let cacheKey;
  beginIndexDiskMtimeCoalesce();
  try {
    ({ cacheKey } = routeCacheKeyWithIndexMtime(filter));
    const cachedBody = peekApiResponseBody(cacheKey, responseSubKey);
    if (cachedBody !== undefined) {
      try {
        const data = JSON.parse(cachedBody);
        if (Array.isArray(data.sessions)) return data.sessions;
      } catch {
        // rebuild below
      }
    }
  } finally {
    endIndexDiskMtimeCoalesce();
  }
  const { sessions, index } = await resolveSessionsAndIndexAsync(filter, deps);
  const catalog = buildSearchCatalog(sessions, index);
  storeApiResponseBody(cacheKey, responseSubKey, JSON.stringify({ sessions: catalog }));
  return catalog;
}

export async function handleApiSearch(_req, res, url, _deps = null) {
  const deps = _deps || await hotModules();
  if (parseApiSearchCatalog(url.searchParams.get("catalog"))) {
    await handleApiSearchCatalog(_req, res, url, deps);
    return;
  }
  const q = url.searchParams.get("q") || "";
  if (!q.trim()) {
    send(res, 200, JSON.stringify({ results: [] }), "application/json; charset=utf-8");
    return;
  }

  const filter = url.searchParams.get("filter") || getInitialFilter() || null;
  const exprParam = url.searchParams.get("expr") || "";
  const exprTrimmed = exprParam.trim();
  const limit = parseApiSearchLimit(url.searchParams.get("limit"));
  const snippets = parseApiSearchSnippets(url.searchParams.get("snippets"));
  beginIndexDiskMtimeCoalesce();
  let cacheKey;
  let sessions;
  let index;
  const responseSubKey = `search:${q}:${exprTrimmed}:${limit}:${snippets ? 1 : 0}`;
  try {
    ({ cacheKey } = routeCacheKeyWithIndexMtime(filter));
    const cachedBody = peekApiResponseBody(cacheKey, responseSubKey);
    if (cachedBody !== undefined) {
      send(res, 200, cachedBody, "application/json; charset=utf-8");
      return;
    }
  } finally {
    endIndexDiskMtimeCoalesce();
  }
  ({ sessions, index } = await resolveSessionsAndIndexAsync(filter, deps));
  // A query the client replaced (it closed this request) is not searched (fact flt3).
  await new Promise((resolve) => setImmediate(resolve));
  if (res.destroyed) return;
  const peekSession = deps.peekSession ?? (await hotModules()).peekSession;
  const searchSessionsFn = deps.searchSessions ?? (await hotModules()).searchSessions;

  let scopedSessions = sessions;
  if (exprTrimmed) {
    const apiObjects = sessions.map((s) => {
      const meta = getSessionMeta(index, s, peekSession);
      const obj = sessionToApiObject(s, meta);
      obj._origSession = s;
      return obj;
    });
    try {
      const kept = await filterOffThread(res, apiObjects, exprTrimmed, "recent");
      if (!kept) return;
      scopedSessions = kept.map((obj) => obj._origSession);
    } catch (err) {
      if (err instanceof FilterParseError) {
        send(res, 400, JSON.stringify({ error: err.message }), "application/json; charset=utf-8");
        return;
      }
      throw err;
    }
  }

  // The search's file work runs in worker threads (fact hsw1); an injected searchSessions runs as given.
  let results;
  try {
    results = _deps?.searchSessions
      ? searchSessionsFn(scopedSessions, index, q, limit, { snippets })
      : await searchSessionsAsync(scopedSessions, index, q, limit, { snippets }, searchStepRunner(() => res.destroyed));
  } catch (err) {
    // A query the client replaced stops at its next step (fact flt3).
    if (res.destroyed) return;
    throw err;
  }
  if (res.destroyed) return;

  const body = JSON.stringify({ results });
  storeApiResponseBody(cacheKey, responseSubKey, body);
  send(res, 200, body, "application/json; charset=utf-8");
}

export async function handleApiSearchCatalog(_req, res, url, deps) {
  const filter = url.searchParams.get("filter") || getInitialFilter() || null;
  const exprParam = url.searchParams.get("expr") || "";
  const exprTrimmed = exprParam.trim();
  beginIndexDiskMtimeCoalesce();
  let cacheKey;
  let sessions;
  let index;
  const responseSubKey = `search:catalog:${exprTrimmed}`;
  try {
    ({ cacheKey } = routeCacheKeyWithIndexMtime(filter));
    const cachedBody = peekApiResponseBody(cacheKey, responseSubKey);
    if (cachedBody !== undefined) {
      send(res, 200, cachedBody, "application/json; charset=utf-8");
      return;
    }
  } finally {
    endIndexDiskMtimeCoalesce();
  }
  ({ sessions, index } = await resolveSessionsAndIndexAsync(filter, deps));

  let scopedSessions = sessions;
  if (exprTrimmed) {
    const peekSession = deps.peekSession ?? (await hotModules()).peekSession;
    const apiObjects = sessions.map((s) => {
      const meta = getSessionMeta(index, s, peekSession);
      const obj = sessionToApiObject(s, meta);
      obj._origSession = s;
      return obj;
    });
    try {
      const kept = await filterOffThread(res, apiObjects, exprTrimmed, "recent");
      if (!kept) return;
      scopedSessions = kept.map((obj) => obj._origSession);
    } catch (err) {
      if (err instanceof FilterParseError) {
        send(res, 400, JSON.stringify({ error: err.message }), "application/json; charset=utf-8");
        return;
      }
      throw err;
    }
  }

  const catalog = buildSearchCatalog(scopedSessions, index);
  const body = JSON.stringify({ sessions: catalog });
  storeApiResponseBody(cacheKey, responseSubKey, body);
  send(res, 200, body, "application/json; charset=utf-8");
}