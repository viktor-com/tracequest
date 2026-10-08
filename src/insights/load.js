/**
 * Join discovered sessions with their cached analysis and build everything the
 * insights view shows: the aggregates plus the per-machine pull health.
 */
import { applyExprToApiObjects } from "../filter/filter.js";
import { getSessionMeta, sessionToApiObject } from "../server/server-helpers.js";
import { buildHubStatus, LOCAL_HOST_ID, readPullState } from "../hub/pull-state.js";
import { loadImportHostsFile } from "../import/ssh-import.js";
import { aggregateInsights } from "./aggregate.js";
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

function configuredHosts() {
  try {
    return loadImportHostsFile();
  } catch {
    // A malformed import-hosts line must not take the page down.
    return [];
  }
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
  let rows = sessions.map((s) => {
    const row = sessionToApiObject(s, getSessionMeta(index, s, null));
    const analysis = records[s.path];
    if (analysis) row.analysis = analysis;
    return row;
  });
  let exprError = null;
  if (query.expr) {
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
  return {
    generatedAt: new Date(now).toISOString(),
    query,
    exprError,
    hub: buildHubStatus({ sessions, pullState, configured, importedHosts, now }),
    ...aggregateInsights(rows),
  };
}
