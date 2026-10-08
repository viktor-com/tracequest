import { send } from "../server/server-http.js";
import { getInitialFilter, hotModules } from "../server/server-state.js";
import {
  buildLiveSessionList,
  computeStats,
  getSessionMeta,
  sessionToApiObject,
} from "../server/server-helpers.js";
import { applyExprToApiObjects, FilterParseError } from "../filter/filter.js";
import { detectLiveSessions, liveSessionsCacheTime, stampLive } from "../sessions/live-sessions.js";
import { sessionHash } from "../sessions/session-hash.js";
import { liveSessionActivity } from "./route-handlers-launch.js";
import {
  beginIndexDiskMtimeCoalesce,
  endIndexDiskMtimeCoalesce,
} from "../sessions/index-writers.js";
import {
  peekApiResponseBody,
  resolveSessionsAndIndex,
  routeCacheKeyWithIndexMtime,
  storeApiResponseBody,
} from "./route-cache.js";

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
  let indexMtimeMs;
  let sessions;
  let index;
  let allSessions;
  try {
    ({ cacheKey, indexMtimeMs } = routeCacheKeyWithIndexMtime(filter));
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

    ({ sessions, index, allSessions } = resolveSessionsAndIndex(filter, deps, { indexMtimeMs }));
  } finally {
    endIndexDiskMtimeCoalesce();
  }
  const peekSession = deps.peekSession ?? (await hotModules()).peekSession;

  const sessionsForLive = allSessions ?? sessions;
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

  let allObjects = sessions.map(s => {
    const meta = getSessionMeta(index, s, peekSession);
    const obj = sessionToApiObject(s, meta);
    stampLive(obj, liveSet);
    return obj;
  });

  try {
    allObjects = applyExprToApiObjects(allObjects, exprParam, sort);
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
  const stats = computeStats(allObjects);
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
  let indexMtimeMs;
  let sessions;
  let index;
  const responseSubKey = `search:${q}:${exprTrimmed}:${limit}:${snippets ? 1 : 0}`;
  try {
    ({ cacheKey, indexMtimeMs } = routeCacheKeyWithIndexMtime(filter));
    const cachedBody = peekApiResponseBody(cacheKey, responseSubKey);
    if (cachedBody !== undefined) {
      send(res, 200, cachedBody, "application/json; charset=utf-8");
      return;
    }

    ({ sessions, index } = resolveSessionsAndIndex(filter, deps, { indexMtimeMs }));
  } finally {
    endIndexDiskMtimeCoalesce();
  }
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
      scopedSessions = applyExprToApiObjects(apiObjects, exprTrimmed, "recent").map((obj) => obj._origSession);
    } catch (err) {
      if (err instanceof FilterParseError) {
        send(res, 400, JSON.stringify({ error: err.message }), "application/json; charset=utf-8");
        return;
      }
      throw err;
    }
  }

  const results = searchSessionsFn(scopedSessions, index, q, limit, { snippets });

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
  let indexMtimeMs;
  let sessions;
  let index;
  const responseSubKey = `search:catalog:${exprTrimmed}`;
  try {
    ({ cacheKey, indexMtimeMs } = routeCacheKeyWithIndexMtime(filter));
    const cachedBody = peekApiResponseBody(cacheKey, responseSubKey);
    if (cachedBody !== undefined) {
      send(res, 200, cachedBody, "application/json; charset=utf-8");
      return;
    }

    ({ sessions, index } = resolveSessionsAndIndex(filter, deps, { indexMtimeMs }));
  } finally {
    endIndexDiskMtimeCoalesce();
  }

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
      scopedSessions = applyExprToApiObjects(apiObjects, exprTrimmed, "recent").map((obj) => obj._origSession);
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