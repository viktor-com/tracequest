import { sessionGrade } from "../sessions/session-grade.js";
import { sessionHash } from "../sessions/session-hash.js";

/**
 * The session object the viewer embeds as SESSION — also what
 * /api/view-session serves for in-place live updates (fact hnr2).
 */
export function viewerSessionData(session) {
  // agentHistory is server-side metadata from subagent sidecars; not rendered in the viewer.
  const { agentHistory: _agentHistory, agentSidecarCount: _agentSidecarCount, ...sessionForViewer } =
    session;
  if (!sessionForViewer.sessionHash && sessionForViewer.path) {
    sessionForViewer.sessionHash = sessionHash(sessionForViewer.path);
  }
  sessionForViewer.grade = sessionGrade(session);
  return sessionForViewer;
}
