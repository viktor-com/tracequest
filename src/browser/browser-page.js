import { homedir } from "node:os";
import { browserPageHTML } from "./browser-page-build.js";
import { fillAppLive, liveCountOf } from "./app-chrome.js";
import { buildLiveSessionList } from "../server/server-helpers.js";

import { peekSession } from "../sessions.js";
import { detectLiveSessions } from "../sessions/live-sessions.js";
import { liveSessionActivity } from "../routes/route-handlers-launch.js";
import { sessionRows, sessionRowsStats, stampRowsLive } from "../routes/session-rows.js";
import { sortSessionList } from "../filter/filter-formats.js";
import { applyExprToApiObjects, FilterParseError } from "../filter/filter.js";
import { computeStats } from "../server/server-helpers.js";

/** Page sizes the list's pager offers; any other ?pageSize= is the default 50. */
const LIST_PAGE_SIZES = [25, 50, 100, 200];

/**
 * The list state the URL names (?page=, ?pageSize=, ?sort=, ?expr=), read the
 * way the list client reads it, so the embedded rows are the rows its first
 * render shows (facts hnr10, hnr11).
 * @param {URLSearchParams|null|undefined} params
 * @returns {{ page: number, pageSize: number, sort: string, expr: string }}
 */
export function listPageFromParams(params) {
  const page = parseInt(params?.get("page") ?? "", 10);
  const pageSize = parseInt(params?.get("pageSize") ?? "", 10);
  return {
    page: page > 0 ? page : 1,
    pageSize: LIST_PAGE_SIZES.includes(pageSize) ? pageSize : 50,
    sort: params?.get("sort") || "recent",
    expr: (params?.get("expr") || "").trim(),
  };
}

/**
 * The rows, total and stats GET /api/sessions answers for this expr and sort
 * (handleApiSessions), so a filtered or sorted list URL embeds its own rows.
 * @returns {{ objects: object[], stats: object, error: string|null }}
 */
function listStateRows(rows, livePaths, expr, sort) {
  // The live bit is part of the row a live: filter matches, as in the API.
  if (expr) stampRowsLive(rows.objects, livePaths);
  try {
    const objects = applyExprToApiObjects(rows.objects.slice(), expr, sort);
    return { objects, stats: expr ? computeStats(objects) : sessionRowsStats(rows), error: null };
  } catch (err) {
    if (!(err instanceof FilterParseError)) throw err;
    // The list shows the API's 400 for this expression, not someone else's rows.
    return { objects: [], stats: {}, error: `HTTP 400: ${JSON.stringify({ error: err.message }).slice(0, 120)}` };
  }
}

/**
 * listStateRows for serve (fact flt4): the ?expr= rows filtered by `filterAsync`
 * (the off-thread filter: no session file is read on the event loop), for
 * browserPage's listPage.state. Null when the request was abandoned.
 * @param {(objects: object[], expr: string, sort: string) => Promise<object[]|null>} filterAsync
 */
export async function listStateRowsOffThread(sessions, index, sessionsForLive, listPage, filterAsync) {
  const rows = sessionRows(sessions, index, peekSession);
  stampRowsLive(rows.objects, detectLiveSessions(sessionsForLive));
  try {
    const objects = await filterAsync(rows.objects.slice(), listPage.expr, listPage.sort || "recent");
    if (!objects) return null;
    return { objects, stats: computeStats(objects), error: null };
  } catch (err) {
    if (!(err instanceof FilterParseError)) throw err;
    return { objects: [], stats: {}, error: `HTTP 400: ${JSON.stringify({ error: err.message }).slice(0, 120)}` };
  }
}

export function browserPage(sessions, index, initialFilter = null, sessionsForLive = sessions, listPage = null, runs = null, runActiveAt = null) {
  const livePaths = detectLiveSessions(sessionsForLive);
  const PAGE_SIZE = listPage?.pageSize || 50;
  // Rows and stats come from the snapshot memo /api/sessions uses (fact hlmemo).
  const rows = sessionRows(sessions, index, peekSession);
  // The URL's list state picks the embedded rows: ?page=N embeds page N (a
  // page past the end is the last page) and ?expr= / ?sort= the rows
  // /api/sessions answers for them, so the first paint never shows another
  // state's rows (facts hnr10, hnr11). The unfiltered, recent-sorted page 1
  // keeps the snapshot order.
  const sort = listPage?.sort || "recent";
  const expr = listPage?.expr || "";
  // A state the caller already filtered off the event loop (listStateRowsOffThread) is used as is.
  if (listPage?.state && expr) stampRowsLive(rows.objects, livePaths);
  const state = listPage?.state ?? (expr || sort !== "recent" ? listStateRows(rows, livePaths, expr, sort) : null);
  const listed = state ? state.objects : rows.objects;
  const total = listed.length;
  const page = Math.min(Math.max(1, listPage?.page || 1), Math.max(1, Math.ceil(total / PAGE_SIZE)));
  const ordered = state || page === 1 ? listed : sortSessionList(listed.slice(), "recent");
  const firstPage = ordered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  stampRowsLive(firstPage, livePaths);
  const stats = state ? state.stats : sessionRowsStats(rows);
  const liveSessions = buildLiveSessionList(sessionsForLive, livePaths, index, peekSession);
  // Same origin-agnostic activity line /api/sessions serves — the initial
  // embed renders external live rows with full live anatomy before the
  // first client poll.
  for (const ls of liveSessions) {
    ls.activity = liveSessionActivity(ls.path, ls.source);
  }
  const data = JSON.stringify({
    sessions: firstPage,
    total: state ? total : sessions.length,
    page,
    pageSize: PAGE_SIZE,
    sort,
    expr,
    ...(state?.error ? { error: state.error } : {}),
    stats,
    // The filter chips count the whole list, not the filtered rows.
    ...(expr ? { facetStats: sessionRowsStats(rows) } : {}),
    liveSessions,
    // The runs GET /api/runs answers, so the run rows pinned above the list
    // are in the first paint (fact hnr13).
    ...(Array.isArray(runs) ? { runs, runActiveAt: runActiveAt || {} } : {}),
    // Launcher default: the client cannot know a server-side path.
    defaultCwd: homedir(),
  }).replace(/<\//g, "<\\/").replace(/<!--/g, "\\u003c!--");

  const filterVal = initialFilter ? String(initialFilter).replace(/"/g, "&quot;") : "";

  // The app bar's live counter is in the first paint, with the count the
  // client's first render shows (fact hlstrip).
  return fillAppLive(browserPageHTML(data, filterVal), liveCountOf(runs, liveSessions));
}
