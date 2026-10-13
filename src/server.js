import { ROUTE_MAP } from "./routes.js";
import { resolveSessionsAndIndexAsync } from "./routes/route-cache.js";
import { findSessions, buildIndex } from "./sessions.js";
import { serve as serveHttp } from "./server/server-http.js";
import { startServerLiveReloadWatchers } from "./server/server-state.js";
import { setSrcHotReload } from "./server/server-live-reload.js";
import { available as muxAvailable, ensureSession, tmuxSession } from "./mux/tmux.js";
import { flushDeferredIndexWrites } from "./sessions/index-writers.js";

/**
 * Keep a SIGTERM/SIGINT handler for serve's whole life (fact hsa5). The index
 * writer only holds its handlers while a write is pending and drops them when
 * the write timer fires; a signal that became due in that same event-loop
 * turn then found no listener and was silently discarded, so serve ignored
 * the stop request. This one flushes the pending index write, as the writer's
 * own handler does, and re-raises with the default handler for the
 * conventional exit status.
 */
let _stopHandlersInstalled = false;

function installStopHandlers() {
  if (_stopHandlersInstalled) return;
  _stopHandlersInstalled = true;
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.once(sig, () => {
      flushDeferredIndexWrites();
      process.removeAllListeners("SIGTERM");
      process.removeAllListeners("SIGINT");
      process.kill(process.pid, sig);
    });
  }
}

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
  installStopHandlers();
  setSrcHotReload(!opts.hub);
  startServerLiveReloadWatchers();
  // A hub only shows collected sessions: it never launches runs, so no tmux.
  if (!opts.hub) ensureMuxSessionAtBoot();
  // Warm the session list and index without blocking startup or the event
  // loop (fact hsa1); the first request that needs them shares this refresh.
  resolveSessionsAndIndexAsync(filter, { findSessions, buildIndex })
    .catch((err) => console.error("tracequest: initial index failed:", err?.message || err));
  return serveHttp(port, filter, ROUTE_MAP, opts);
}
