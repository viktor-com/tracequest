import { homedir } from "node:os";
import { browserPageHTML } from "./browser-page-build.js";
import {
  buildLiveSessionList,
  computeStats,
  getSessionMeta,
  sessionToApiObject,
} from "../server/server-helpers.js";

import { peekSession } from "../sessions.js";
import { detectLiveSessions, stampLive } from "../sessions/live-sessions.js";
import { liveSessionActivity } from "../routes/route-handlers-launch.js";

export function browserPage(sessions, index, initialFilter = null, sessionsForLive = sessions) {
  const livePaths = detectLiveSessions(sessionsForLive);
  const PAGE_SIZE = 50;
  const firstPage = [];
  const allObjects = [];
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const obj = sessionToApiObject(s, getSessionMeta(index, s, peekSession));
    stampLive(obj, livePaths);
    allObjects.push(obj);
    if (i < PAGE_SIZE) firstPage.push(obj);
  }
  const stats = computeStats(allObjects);
  const liveSessions = buildLiveSessionList(sessionsForLive, livePaths, index, peekSession);
  // Same origin-agnostic activity line /api/sessions serves — the initial
  // embed renders external live rows with full live anatomy before the
  // first client poll.
  for (const ls of liveSessions) {
    ls.activity = liveSessionActivity(ls.path, ls.source);
  }
  const data = JSON.stringify({
    sessions: firstPage,
    total: sessions.length,
    page: 1,
    pageSize: PAGE_SIZE,
    stats,
    liveSessions,
    // Launcher default: the client cannot know a server-side path.
    defaultCwd: homedir(),
  }).replace(/<\//g, "<\\/");

  const filterVal = initialFilter ? String(initialFilter).replace(/"/g, "&quot;") : "";

  return browserPageHTML(data, filterVal);
}
