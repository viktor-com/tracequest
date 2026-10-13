/**
 * Join discovered sessions with their cached analysis and build everything the
 * insights view shows: the aggregates plus the per-machine pull health.
 */
import { applyExprToApiObjects, parseFilterExpr } from "../filter/filter.js";
import { getSessionMeta, sessionToApiObject } from "../server/server-helpers.js";
import { buildHubStatus, LOCAL_HOST_ID, readPullState } from "../hub/pull-state.js";
import { loadImportHostsFile } from "../import/ssh-import.js";
import { aggregateInsights, workedTimeOf } from "./aggregate.js";
import { loadInsights } from "./store.js";
import { listImportedHosts } from "../sessions/session-discovery-paths.js";

export const INSIGHTS_RANGES = Object.freeze([7, 30, 90]);

/**
 * `expr` is the dashboard filter language, `days` limits to recent sessions,
 * and `host` picks one machine ("local" is this box, which has no host id).
 */
export function parseInsightsQuery(params) {
  const expr = String(params?.get?.("expr") || "").trim();
  const raw = Number(params?.get?.("days") || 0);
  const days = INSIGHTS_RANGES.includes(raw) ? raw : 0;
  const host = String(params?.get?.("host") || "").trim();
  return { expr, days, host };
}

/**
 * Keys written as `key:value` that are not filter keys. The parser matches
 * such a token as plain text, so the page says so instead of silently showing
 * a free-text match (fact hubkey). Quoted tokens are the explicit free-text form.
 */
function unknownFilterKeys(expr) {
  let ast;
  try {
    ast = parseFilterExpr(expr);
  } catch {
    return []; // a malformed expression is reported as exprError instead
  }
  const keys = [];
  (function walk(n) {
    if (!n) return;
    if (n.type === "term" && n.key === "text" && !n.quoted) {
      const m = /^([a-z_]+):\S/i.exec(n.value || "");
      if (m && !keys.includes(m[1].toLowerCase())) keys.push(m[1].toLowerCase());
    }
    walk(n.left);
    walk(n.right);
    walk(n.child);
  })(ast);
  return keys;
}

function configuredHosts() {
  try {
    return loadImportHostsFile();
  } catch {
    // A malformed import-hosts line must not take the page down.
    return [];
  }
}

/**
 * Per-session rows reused while the session, its index entry and its analysis
 * record are the same objects (fact inslm): an incremental refresh replaces only
 * the sessions that changed, so only those rows are rebuilt.
 */
const _rowCache = new WeakMap();

function sessionRow(s, index, records) {
  const meta = getSessionMeta(index, s, null);
  const analysis = records[s.path];
  const hit = _rowCache.get(s);
  if (hit && hit.meta === meta && hit.analysis === analysis) return hit.row;
  const row = sessionToApiObject(s, meta);
  if (analysis) row.analysis = analysis;
  _rowCache.set(s, { meta, analysis, row });
  return row;
}

/**
 * The aggregates of the last unscoped-by-time request, keyed by the exact
 * inputs: a new session list, index, record set or scope recomputes them.
 * Expressions and day ranges depend on the clock, so they always recompute.
 */
let _aggregateMemo = null;

function sameRows(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function loadInsightsData({
  sessions,
  index,
  query = { expr: "", days: 0, host: "" },
  records = loadInsights(),
  pullState = readPullState(),
  configured = configuredHosts(),
  importedHosts = listImportedHosts().map((h) => h.host),
  now = Date.now(),
} = {}) {
  const hub = buildHubStatus({ sessions, pullState, configured, importedHosts, now });
  const memoable = !query.expr && !query.days;
  const memo = _aggregateMemo;
  if (memoable && memo && memo.sessions === sessions && memo.index === index && memo.records === records && memo.host === query.host) {
    return { generatedAt: new Date(now).toISOString(), query, exprError: null, exprWarning: null, hub, ...memo.aggregates };
  }
  let rows = sessions.map((s) => sessionRow(s, index, records));
  let exprError = null;
  let exprWarning = null;
  if (query.expr) {
    const unknown = unknownFilterKeys(query.expr);
    if (unknown.length) {
      exprWarning = `Unknown filter key${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `"${k}:"`).join(", ")} matched as plain text.`;
    }
    try {
      rows = applyExprToApiObjects(rows, query.expr, "recent");
    } catch (err) {
      exprError = err?.message || String(err);
    }
  }
  if (query.host) rows = rows.filter((r) => (r.host || LOCAL_HOST_ID) === query.host);
  if (query.days) {
    const since = now - query.days * 24 * 60 * 60 * 1000;
    rows = rows.filter((r) => r.mtime >= since);
  }
  // aggregateInsights reads the analysed rows only, plus every row's count and
  // agent time (fact durins): when every analysed row is the very same object
  // in the same order (only unanalysed sessions changed), its answer is the
  // previous one with those updated.
  const done = rows.filter((r) => r.analysis);
  let aggregates;
  if (memoable && memo && memo.host === query.host && sameRows(memo.done, done)) {
    const { activeMs, ...worked } = workedTimeOf(rows);
    aggregates = {
      ...memo.aggregates,
      totals: { ...memo.aggregates.totals, sessions: rows.length, pending: rows.length - done.length, activeMs },
      time: { ...memo.aggregates.time, activeMs, ...worked },
    };
  } else {
    aggregates = aggregateInsights(rows);
  }
  _aggregateMemo = memoable ? { sessions, index, records, host: query.host, done, aggregates } : null;
  return {
    generatedAt: new Date(now).toISOString(),
    query,
    exprError,
    exprWarning,
    hub,
    ...aggregates,
  };
}
