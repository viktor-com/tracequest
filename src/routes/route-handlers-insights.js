/**
 * GET /insights and GET /api/insights — cross-host aggregates over the cached
 * per-session analysis (facts insrt, insap). Never parses a session and never
 * opens a connection: the cache is filled by `tracequest insights --refresh`.
 */
import { send } from "../server/server-http.js";
import { getInitialFilter, hotModules } from "../server/server-state.js";
import { resolveSessionsAndIndex } from "./route-cache.js";
import { loadInsightsData, parseInsightsQuery } from "../insights/load.js";
import { insightsPage } from "../browser/insights-page.js";

async function insightsData(url, _deps) {
  const mods = _deps || await hotModules();
  const query = parseInsightsQuery(url.searchParams);
  if (_deps?.loadInsightsData) return _deps.loadInsightsData(query);
  const { sessions, index } = resolveSessionsAndIndex(getInitialFilter(), mods);
  return loadInsightsData({ sessions, index, query });
}

export async function handleInsights(_req, res, url, _deps = null) {
  const data = await insightsData(url, _deps);
  send(res, 200, insightsPage(data), "text/html; charset=utf-8");
}

export async function handleApiInsights(_req, res, url, _deps = null) {
  const data = await insightsData(url, _deps);
  send(res, 200, JSON.stringify(data), "application/json; charset=utf-8");
}
