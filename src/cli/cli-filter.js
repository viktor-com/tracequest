/**
 * --filter for the CLI commands: the filter-expression evaluator and the
 * session metadata it reads. Kept apart from cli-search.js so an unfiltered
 * search or handoff does not load it (fact id4).
 */
import { buildIndex, peekSession, sortSessionsByMtimeDesc } from "../sessions.js";
import { detectLiveSessions, stampLive } from "../sessions/live-sessions.js";
import { sessionToApiObject, getSessionMeta } from "../server/server-helpers.js";
import { applyExprToApiObjects, evalFilterExpr, parseFilterExpr, FilterParseError } from "../filter/filter.js";
import { die } from "./cli-die.js";

const DISCOVERY_FILTER_KEYS = new Set(["project", "source", "host", "size", "age", "live"]);
const EMPTY_DISCOVERY_META = {};
let detectLiveSessionsForCliFilter = detectLiveSessions;

function isRecentSort(sort) {
  return !sort || sort === "recent" || sort === "date";
}

function usesOnlyDiscoveryFilterFields(node) {
  if (!node) return true;
  switch (node.type) {
    case "term": return DISCOVERY_FILTER_KEYS.has(node.key);
    case "and":
    case "or": return usesOnlyDiscoveryFilterFields(node.left) && usesOnlyDiscoveryFilterFields(node.right);
    case "not": return usesOnlyDiscoveryFilterFields(node.child);
    default: return false;
  }
}

export function setCliLiveSessionDetectorForTests(detector) {
  detectLiveSessionsForCliFilter = detector || detectLiveSessions;
}

function filterUsesField(node, key) {
  if (!node) return false;
  switch (node.type) {
    case "term": return node.key === key;
    case "and":
    case "or": return filterUsesField(node.left, key) || filterUsesField(node.right, key);
    case "not": return filterUsesField(node.child, key);
    default: return false;
  }
}

function buildLivePathSetForFilter(sessions, ast) {
  if (!filterUsesField(ast, "live")) return null;
  return new Set(detectLiveSessionsForCliFilter(sessions));
}

function sessionToCliFilterObject(session, meta, livePathSet) {
  const obj = sessionToApiObject(session, meta);
  if (livePathSet) stampLive(obj, livePathSet);
  return obj;
}

/**
 * Apply --filter expression and --sort to a discovered session list.
 * Returns an array of session-discovery objects (same shape as findSessions
 * output) so callers can still use .path / .mtime / .project / .size etc.
 *
 * When expr is set, we build the index, convert to API objects (so the filter
 * evaluator has access to model, tools, tokens, etc.), filter, sort, then map
 * back to the original session objects (preserving order).
 */
export function applyExprFilter(sessions, expr, sort) {
  try {
    return applyExprFilterUnsafe(sessions, expr, sort);
  } catch (err) {
    if (err instanceof FilterParseError) die(err.message);
    throw err;
  }
}

function applyExprFilterUnsafe(sessions, expr, sort) {
  const exprTrimmed = expr && String(expr).trim();
  const ast = exprTrimmed ? parseFilterExpr(exprTrimmed) : null;
  const livePathSet = buildLivePathSetForFilter(sessions, ast);
  if (!exprTrimmed && (sort === "recent" || sort === "date")) {
    return sortSessionsByMtimeDesc([...sessions]);
  }
  if (exprTrimmed && isRecentSort(sort)) {
    if (usesOnlyDiscoveryFilterFields(ast)) {
      if (!ast) return sortSessionsByMtimeDesc([...sessions]);
      const now = Date.now();
      const filtered = [];
      for (const session of sessions) {
        if (evalFilterExpr(sessionToCliFilterObject(session, EMPTY_DISCOVERY_META, livePathSet), ast, now, null)) {
          filtered.push(session);
        }
      }
      return sortSessionsByMtimeDesc(filtered);
    }
  }

  const index = buildIndex(sessions);
  const apiObjects = sessions.map((s) => {
    const meta = getSessionMeta(index, s, peekSession);
    const obj = sessionToCliFilterObject(s, meta, livePathSet);
    obj._origSession = s;
    return obj;
  });

  return applyExprToApiObjects(apiObjects, expr, sort).map((obj) => obj._origSession);
}
