/**
 * Session-list row objects, built once per (session list, index) snapshot
 * (fact hlmemo). Every /api/sessions request and the /sessions page used to
 * rebuild one API object per session and recompute the unfiltered stats;
 * the snapshot only changes when a refresh produces a new list or index, and
 * a refresh after a few recordings changed keeps every other session's
 * discovery row and index entry, so their row objects carry over too.
 */
import { computeStats, getSessionMeta, sessionToApiObject } from "../server/server-helpers.js";
import { sessionListChecksum, sessionMtimeMs } from "../sessions/session-list.js";

/** sessions array -> { index, objects, stats, byPath } */
const _rows = new WeakMap();

/** The most recent snapshot's rows, the carry-over source for the next one. */
let _last = null;

/** Row objects for `sessions` in list order; shared, so callers copy before sorting. */
export function sessionRows(sessions, index, peekSession) {
  // Identity plus a content check: a list or index changed in place is a new snapshot.
  const sig = `${sessions.length}:${sessionListChecksum(sessions)}:${index.size}`;
  const hit = _rows.get(sessions);
  if (hit && hit.index === index && hit.sig === sig) return hit;
  const prev = _last?.byPath;
  const byPath = new Map();
  const objects = new Array(sessions.length);
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const meta = index.get(s.path);
    const old = prev?.get(s.path);
    // Same discovery row and same index entry: the row object is unchanged.
    const mtime = sessionMtimeMs(s);
    const obj = old && meta && old.s === s && old.meta === meta && old.mtime === mtime && old.size === s.size
      ? old.obj
      : sessionToApiObject(s, meta || getSessionMeta(index, s, peekSession));
    objects[i] = obj;
    byPath.set(s.path, { s, meta, obj, mtime, size: s.size });
  }
  const entry = { index, sig, objects, stats: null, byPath };
  _rows.set(sessions, entry);
  _last = entry;
  return entry;
}

/** Stats over every row of the snapshot (computed on first use). */
export function sessionRowsStats(entry) {
  if (!entry.stats) entry.stats = computeStats(entry.objects);
  return entry.stats;
}

/** Stamp the live bit on every row from one detectLiveSessions snapshot. */
export function stampRowsLive(objects, livePaths) {
  const live = livePaths instanceof Set ? livePaths : new Set(livePaths || []);
  for (let i = 0; i < objects.length; i++) objects[i].live = live.has(objects[i].path);
}
