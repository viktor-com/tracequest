/**
 * Non-blocking live-session detection for the server (fact hlv1).
 *
 * detectLiveSessions spawns pgrep/lsof synchronously — on a busy machine a
 * pass costs hundreds of ms of frozen event loop, and a data-update clears
 * its 5s memo every few seconds while agents write. warmLiveSessions runs
 * the same pass in a worker thread and installs the result as the memo, so
 * the synchronous call a handler makes right after answers from memory.
 * Any worker failure resolves anyway: the synchronous probe then runs as
 * before, so detection never silently stops.
 */
import { Worker } from "node:worker_threads";
import { sessionMtimeMs } from "./session-list.js";
import { installLiveSessionsSnapshot, liveProbeDepsInjected, liveSessionsCacheTime, liveSessionsMemoFresh } from "./live-sessions.js";

/** Sources whose detection consults the discovered session list. */
const LIST_SOURCES = new Set(["codex", "opencode", "cursor", "factory"]);

let _worker = null;
let _seq = 0;
const _pending = new Map();
let _inflight = null;

function failAll() {
  for (const resolve of _pending.values()) resolve(null);
  _pending.clear();
}

function worker() {
  if (_worker) return _worker;
  _worker = new Worker(new URL("./live-probe-worker.js", import.meta.url));
  _worker.on("message", ({ id, live }) => {
    const resolve = _pending.get(id);
    _pending.delete(id);
    if (resolve) resolve(live);
  });
  const reset = () => {
    _worker = null;
    failAll();
  };
  _worker.on("error", (err) => {
    console.error("live-probe worker failed:", err?.message || err);
    reset();
  });
  _worker.on("exit", reset);
  // After the listeners: attaching a "message" listener re-refs the port.
  // An idle probe worker must never keep a process (a CLI, a test) alive.
  _worker.unref();
  return _worker;
}

function slimRows(sessions) {
  const out = [];
  for (const s of sessions || []) {
    if (!s?.path || !LIST_SOURCES.has(s.source)) continue;
    const row = { path: s.path, source: s.source, mtime: sessionMtimeMs(s) };
    if (s.project !== undefined) row.project = s.project;
    if (s.parentSession) row.parentSession = s.parentSession;
    out.push(row);
  }
  return out;
}

/**
 * Age at which a still-valid memo (5 s) is re-probed in the background
 * (fact hlv2): the pass takes ~0.5 s, so the next memo is installed before
 * this one expires and a request never waits for a probe while the hub is in
 * use. The memo it serves is never older than its 5 s validity.
 */
const REFRESH_AHEAD_MS = 2500;

/** Make the next detectLiveSessions call answer from memory without probing on this thread. */
export function warmLiveSessions(sessions) {
  if (process.env.TRACEQUEST_LIVE_PROBE_WORKER === "0" || liveProbeDepsInjected()) return Promise.resolve();
  if (liveSessionsMemoFresh()) {
    if (!_inflight && Date.now() - liveSessionsCacheTime() >= REFRESH_AHEAD_MS) startProbe(sessions);
    return Promise.resolve();
  }
  if (_inflight) return _inflight;
  return startProbe(sessions);
}

function startProbe(sessions) {
  const startedAt = Date.now();
  const id = ++_seq;
  let w;
  try {
    w = worker();
  } catch (err) {
    console.error("live-probe worker unavailable:", err?.message || err);
    return Promise.resolve();
  }
  _inflight = new Promise((resolve) => {
    _pending.set(id, resolve);
    // Held while a pass is pending (the caller awaits it), released when idle.
    w.ref();
    // The worker probes with this thread's current environment (HOME and the
    // TRACEQUEST_* roots), not the copy it was started with.
    w.postMessage({ id, sessions: slimRows(sessions), env: { ...process.env } });
  }).then((live) => {
    if (Array.isArray(live)) installLiveSessionsSnapshot(live, startedAt);
  }).finally(() => {
    _inflight = null;
    if (_worker && !_pending.size) _worker.unref();
  });
  return _inflight;
}
