/**
 * One generating word for launched-run identity across list badges,
 * poll APIs, /view chips, /run?id= SSR/#runStatus/data-run-state, and
 * /api/sessions/live state+run.status.
 *
 * running while generating (no recording yet, detectLiveSessions, or
 * an in-flight turn on a launched run's own recording),
 * idle for a linked settled TUI, exited when the pane is dead.
 * Never tmux-alive as running, never the word "live" for that bit.
 * Client runIsLive() is r.status === "running" — this mapping's word.
 */
import { detectLiveSessions } from "./live-sessions.js";
import { recordingIsGenerating } from "./live-session-generating.js";

/** Launch-registry id → recordingIsGenerating source. */
const AGENT_SOURCE = {
  claude: "claude",
  "cursor-agent": "cursor",
  codex: "codex",
  grok: "grok",
  opencode: "opencode",
  droid: "factory",
};

export function runGeneratingStatus(dead, sessionPath, generating) {
  if (dead) return "exited";
  if (!sessionPath) return "running";
  return generating ? "running" : "idle";
}

/**
 * Generating bit for a launched run we already identified.
 * detectLiveSessions (pgrep) is the shared discovery path, but a live pane
 * whose recording shows an in-flight turn is generating even when pgrep
 * misses the stub/script comm (Linux `pgrep -x claude` vs a shebang).
 */
export function launchedRunGenerating(agent, path, extra = {}, deps = {}) {
  if (!path) return false;
  if (livePathSetFor([path], deps).has(path)) return true;
  const source = AGENT_SOURCE[agent] || agent;
  return recordingIsGenerating(source, path, extra);
}

/** detectLiveSessions membership for the given recording paths. */
export function livePathSetFor(paths, deps = {}) {
  const unique = [...new Set((paths || []).filter(Boolean))];
  if (!unique.length) return new Set();
  try {
    const discovered = typeof deps.findSessions === "function" ? deps.findSessions(null) : null;
    const sessions = Array.isArray(discovered) && discovered.length
      ? discovered
      : unique.map((path) => ({ path }));
    const livePaths = (deps.detectLiveSessions || detectLiveSessions)(sessions) || [];
    return new Set(livePaths);
  } catch {
    return new Set();
  }
}
