import { ROUTE_MAP } from "./routes.js";
import { resolveSessionsAndIndex } from "./routes/route-cache.js";
import { findSessions, buildIndex } from "./sessions.js";
import { serve as serveHttp } from "./server/server-http.js";
import { startServerLiveReloadWatchers } from "./server/server-state.js";
import { available as muxAvailable, ensureSession, tmuxSession } from "./mux/tmux.js";

/**
 * Ensure the tracequest tmux session at boot — create it detached when
 * absent, reuse it untouched when present — and log the session name.
 * Without tmux (or on any mux failure) serve boots normally and never
 * spawns a tmux process.
 */
function ensureMuxSessionAtBoot() {
  try {
    if (!muxAvailable()) return;
    ensureSession();
    console.log(`tracequest mux → tmux session "${tmuxSession()}"`);
  } catch {
    // A mux failure must never prevent serve from starting.
  }
}

/** Start tracequest on `port` with optional `--filter` expression. */
export function serve(port = 7777, filter = null, opts = {}) {
  startServerLiveReloadWatchers();
  // A hub only shows collected sessions: it never launches runs, so no tmux.
  if (!opts.hub) ensureMuxSessionAtBoot();
  resolveSessionsAndIndex(filter, { findSessions, buildIndex });
  return serveHttp(port, filter, ROUTE_MAP, opts);
}
