import { send } from "./server-http.js";
import { discoverAgentSidecarPaths, loadAgentHistoryForSession } from "./agent-history.js";
import { isSessionPath, normalizeProjectFolder } from "./server-session-path.js";
import { attachSessionHash, resolveSessionHandle, sessionHash } from "../sessions/session-hash.js";
import { sessionMtimeMs } from "../sessions/session-list.js";
import { computeGrade, estimateCost, shortModel } from "../filter/filter-formats.js";
import { stampLive } from "../sessions/live-sessions.js";

/** Index meta for a session row, with optional peek fallback (API + SSR). */
export function getSessionMeta(index, session, peekSession) {
  return index.get(session.path) || (peekSession ? peekSession(session) : {});
}

export function computeStats(apiObjects) {
  let totalSessions = apiObjects.length;
  let totalTokens = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalDurationMs = 0;
  let totalErrors = 0;
  let totalCommits = 0;
  let totalFiles = 0;
  let totalChapters = 0;
  let totalCost = 0;
  const toolAgg = {};
  const projectCounts = {};
  const sourceCounts = {};
  const modelCounts = {};
  const gradeDist = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  let errorSessionCount = 0;
  for (const s of apiObjects) {
    totalTokens += s.totalTokens || 0;
    totalInputTokens += s.inputTokens || 0;
    totalOutputTokens += s.outputTokens || 0;
    totalCacheReadTokens += s.cacheReadTokens || 0;
    totalDurationMs += s.durationMs || 0;
    totalErrors += s.errors || 0;
    totalCommits += s.commits || 0;
    totalFiles += s.files || 0;
    totalChapters += s.chapters || 0;
    totalCost += estimateCost(s);
    if ((s.errors || 0) > 0) errorSessionCount++;
    const g = computeGrade(s);
    if (g.letter !== '-') gradeDist[g.letter] = (gradeDist[g.letter] || 0) + 1;
    for (const t of (s.tools || [])) {
      toolAgg[t] = (toolAgg[t] || 0) + 1;
    }
    projectCounts[s.project] = (projectCounts[s.project] || 0) + 1;
    sourceCounts[s.source] = (sourceCounts[s.source] || 0) + 1;
    if (s.model) {
      const sm = shortModel(s.model);
      modelCounts[sm] = (modelCounts[sm] || 0) + 1;
    }
  }
  return {
    totalSessions, totalTokens, totalInputTokens, totalOutputTokens,
    totalCacheReadTokens, totalDurationMs, totalErrors, totalCommits,
    totalFiles, totalChapters, totalCost, toolAgg, projectCounts,
    sourceCounts, modelCounts, gradeDist, errorSessionCount,
  };
}

/** Live bar entries for paths returned by detectLiveSessions (not table filter/expr). */
export function buildLiveSessionList(sessions, livePaths, index, peekSession) {
  const byPath = new Map(sessions.map((s) => [s.path, s]));
  const out = [];
  for (const path of livePaths) {
    const s = byPath.get(path);
    if (!s) continue;
    const meta = getSessionMeta(index, s, peekSession);
    const obj = sessionToApiObject(s, meta);
    stampLive(obj, livePaths);
    out.push(obj);
  }
  return out;
}

export function sessionToApiObject(s, meta) {
  const hash = sessionHash(s.path);
  const obj = {
    path: s.path,
    sessionHash: hash,
    source: s.source || "claude",
    projectRaw: s.project,
    project: normalizeProjectFolder(s.project),
    id: hash,
    sizeKB: (s.size / 1024) | 0,
    mtime: sessionMtimeMs(s),
    prompt: meta.firstPrompt || s.title || "",
    model: meta.model || "",
    tools: meta.tools || [],
    toolCounts: meta.toolCounts || {},
    chapters: meta.chapters || 0,
    totalTokens: meta.totalTokens || 0,
    inputTokens: meta.inputTokens || 0,
    outputTokens: meta.outputTokens || 0,
    cacheReadTokens: meta.cacheReadTokens || 0,
    durationMs: meta.durationMs || 0,
    errors: meta.errors || 0,
    files: meta.files || 0,
    commits: meta.commits || 0,
  };
  if (s.host) obj.host = s.host;
  return obj;
}

export function resolveSessionPathForRequest(handle, res, findSessions = null) {
  if (!handle) { send(res, 400, "Missing path"); return null; }
  if (isSessionPath(handle)) return handle;
  if (findSessions) {
    const resolved = resolveSessionHandle(handle, findSessions(null));
    if (resolved.status === "ok") return resolved.session.path;
    if (resolved.status === "ambiguous") {
      send(res, 409, `Ambiguous session hash: ${handle}. Pass the full session path.`);
      return null;
    }
    if (resolved.status === "not-found") {
      send(res, 404, `Session hash not found: ${handle}`);
      return null;
    }
  }
  send(res, 403, "Forbidden: path is not a session file");
  return null;
}

export async function fetchSession(url, parseSession, res, pathParam = "path", sourceParam = "source", findSessions = null) {
  const handle = url.searchParams.get(pathParam) || (pathParam === "path" ? url.searchParams.get("id") : null);
  const source = url.searchParams.get(sourceParam) || undefined;
  const p = resolveSessionPathForRequest(handle, res, findSessions);
  if (!p) return null;
  try {
    const session = await parseSession(p, source);
    if (!session) return session;
    if (!session.path) session.path = p;
    attachSessionHash(session);
    const sidecars = discoverAgentSidecarPaths(p);
    if (sidecars.length) {
      const agentHistory = loadAgentHistoryForSession(p, sidecars);
      if (agentHistory) {
        session.agentHistory = agentHistory;
        session.agentSidecarCount = sidecars.length;
      }
    }
    return session;
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    console.error("fetchSession parse error:", p, detail);
    send(res, 500, "Error parsing session", "text/plain");
    return null;
  }
}
