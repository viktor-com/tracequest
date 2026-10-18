/**
 * Incremental session-list refresh (facts hsi1, hsi2): apply the paths the data
 * watchers reported to the previous list instead of walking every root again.
 *
 * - A listed session file that changed is re-stat'ed (one stat, no scan).
 * - A new session file, a new directory, or any change to an opencode.db
 *   rescans only the discovery root holding it.
 * - A path that vanished drops the sessions at or under it.
 * - Anything else that cannot be placed exactly returns null: the caller then
 *   runs a full scan, which is always correct.
 *
 * Classification mirrors the sidecar scanner, which decides "is this a session"
 * from the path alone; the one content-derived field, a Codex project read from
 * the first line, is re-derived by rescanning the root while it is still the
 * "codex" placeholder.
 */
import { existsSync, lstatSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { sortSessionsByMtimeDesc } from "./session-list.js";
import { isGrokFamily } from "./session-layout.js";

const OPENCODE_URI = "opencode://";
const GROK_TRANSCRIPT = "chat_history.jsonl";
/** How many of the newest sessions every refresh re-stats regardless of events. */
const TOP_RESTAT = 5;
/** Journaled .jsonl paths a rescan showed are not sessions (bounded memory). */
const MAX_NON_SESSION_PATHS = 10_000;

function isDbRoot(root) {
  return root.endsWith(".db");
}

function under(path, dir) {
  return path.length > dir.length && path.startsWith(dir) && path.charCodeAt(dir.length) === 47; // "/"
}

/** Host id an opencode.db root belongs to ("" for this machine's own). */
function dbRootHost(root, hostsRoot) {
  if (!hostsRoot || !under(root, hostsRoot)) return "";
  return root.slice(hostsRoot.length + 1).split("/")[0] || "";
}

/**
 * The state one refresh hands to the next. `sessions` is the list it produced;
 * the rest are lookups derived from it.
 */
export function createSessionBase(sessions, roots, hostsRoot) {
  return {
    sessions,
    rootsKey: JSON.stringify(roots),
    roots: [...roots].sort((a, b) => b.length - a.length),
    hostsRoot,
    byPath: new Map(sessions.map((s) => [s.path, s])),
    rootOfPath: new Map(),
    ancestors: null,
    rootCounts: null,
    nonSession: new Set(),
  };
}

function rootOf(base, path) {
  for (const root of base.roots) {
    if (path === root || under(path, root) || (isDbRoot(root) && path.startsWith(root))) return root;
  }
  return null;
}

function sessionRoot(base, s) {
  let root = base.rootOfPath.get(s.path);
  if (root !== undefined) return root;
  if (s.path.startsWith(OPENCODE_URI)) {
    const host = s.host || "";
    root = base.roots.find((r) => isDbRoot(r) && dbRootHost(r, base.hostsRoot) === host) || null;
  } else {
    root = rootOf(base, s.path);
  }
  base.rootOfPath.set(s.path, root);
  return root;
}

/** Listed sessions per discovery root (computed when first needed). */
function rootCounts(base) {
  if (base.rootCounts) return base.rootCounts;
  const counts = new Map();
  for (const s of base.sessions) {
    const root = sessionRoot(base, s);
    counts.set(root, (counts.get(root) || 0) + 1);
  }
  base.rootCounts = counts;
  return counts;
}

/** Every directory that holds a listed session file, below its root. */
function ancestorsOf(base) {
  if (base.ancestors) return base.ancestors;
  const dirs = new Set();
  for (const s of base.sessions) addAncestors(base, dirs, s);
  base.ancestors = dirs;
  return dirs;
}

function addAncestors(base, dirs, s) {
  if (s.path.startsWith(OPENCODE_URI)) return;
  const root = sessionRoot(base, s);
  if (!root) return;
  for (let dir = dirname(s.path); dir.length > root.length && !dirs.has(dir); dir = dirname(dir)) dirs.add(dir);
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** The session as a fresh scan would list it now, the same object if unchanged, or null if gone. */
function restat(s) {
  let st;
  try {
    st = statSync(isGrokFamily(s.source) ? join(s.path, GROK_TRANSCRIPT) : s.path, { bigint: true });
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  // The scanner reports whole milliseconds (chrono timestamp_millis).
  const mtimeMs = Number(st.mtimeNs / 1_000_000n);
  const size = Number(st.size);
  const prev = s.mtime instanceof Date ? s.mtime.getTime() : Number(s.mtime);
  if (prev === mtimeMs && s.size === size) return s;
  return { ...s, mtime: new Date(mtimeMs), size };
}

/**
 * @param {ReturnType<typeof createSessionBase>} base previous refresh (mutated into the next one)
 * @param {{ paths: Set<string>, unknown: boolean }} changes drained journal
 * @param {{ roots: string[], watchedRoots: string[], scanRoots: (roots: string[]) => Promise<object[]|null> }} env
 * @returns {Promise<object[]|null>} the new list, newest first, or null when only a full scan is correct
 */
export async function applySessionChanges(base, changes, { roots, watchedRoots, scanRoots }) {
  if (!base || changes.unknown || JSON.stringify(roots) !== base.rootsKey) return null;

  const rescan = new Set();
  // A root no live watcher covers reports nothing: rescan it every time it
  // exists, or while sessions are still listed under it.
  for (const root of base.roots) {
    if (watchedRoots.some((w) => root === w || under(root, w))) continue;
    if (existsSync(root) || rootCounts(base).get(root)) rescan.add(root);
  }

  // The newest sessions are always re-stat'ed, like the route cache's own
  // validity check, so a write whose watcher event is still in flight is not
  // missed by a refresh that check started.
  const touched = new Set(base.sessions.slice(0, TOP_RESTAT).map((s) => s.path));
  const gone = [];
  for (const path of changes.paths) {
    const root = rootOf(base, path);
    if (!root || rescan.has(root)) continue;
    if (isDbRoot(root)) {
      rescan.add(root);
      continue;
    }
    if (base.byPath.has(path)) {
      touched.add(path);
      continue;
    }
    if (basename(path) === GROK_TRANSCRIPT && isGrokFamily(base.byPath.get(dirname(path))?.source)) {
      touched.add(dirname(path));
      continue;
    }
    const st = lstatOrNull(path);
    if (!st) {
      // A deleted file nobody listed changes nothing; a deleted directory
      // takes its sessions with it.
      if (ancestorsOf(base).has(path)) gone.push(path);
      continue;
    }
    if (st.isDirectory()) {
      // New (or moved-in) directory: its files may never be reported one by one.
      if (!ancestorsOf(base).has(path)) rescan.add(root);
      continue;
    }
    // dsh recordings are session.v<N>.jsonl.zstd.
    if ((path.endsWith(".jsonl") || path.endsWith(".jsonl.zstd")) && !base.nonSession.has(path)) rescan.add(root);
  }

  // The common case: only listed files changed. Re-stat just those, and keep
  // the very same list object when none of them really changed, so everything
  // keyed on it (index result, insights aggregates) stays valid.
  const fresh = new Map();
  for (const path of touched) {
    const s = base.byPath.get(path) || base.byPath.get(dirname(path));
    // OpenCode rows live in a database: its root rescan is what refreshes them.
    if (!s || fresh.has(s.path) || s.path.startsWith(OPENCODE_URI)) continue;
    const now = restat(s);
    if (now === s) continue;
    // A Codex project comes from the file's first line; while it is still the
    // placeholder the line was not complete yet, so let the scanner re-read it.
    if (now && s.source === "codex" && s.project === "codex") {
      const root = sessionRoot(base, s);
      if (root) {
        rescan.add(root);
        continue;
      }
    }
    fresh.set(s.path, now);
  }
  if (!rescan.size && !gone.length) {
    if (!fresh.size) return base.sessions;
    // Only listed files changed: swap them in place of their old objects.
    const next = [];
    for (const s of base.sessions) {
      if (!fresh.has(s.path)) next.push(s);
      else if (fresh.get(s.path)) next.push(fresh.get(s.path));
    }
    sortSessionsByMtimeDesc(next);
    for (const [path, now] of fresh) {
      if (now) base.byPath.set(path, now);
      else base.byPath.delete(path);
    }
    if (next.length !== base.sessions.length) base.rootCounts = null;
    base.sessions = next;
    return next;
  }

  const next = [];
  const kept = [];
  for (const s of base.sessions) {
    if (rescan.size && rescan.has(sessionRoot(base, s))) continue;
    if (gone.length && gone.some((dir) => under(s.path, dir))) continue;
    if (!fresh.has(s.path)) {
      kept.push(s);
      continue;
    }
    const now = fresh.get(s.path);
    if (now) kept.push(now);
  }
  // A Codex placeholder above may have added a root after its sessions were kept.
  for (const s of kept) {
    if (!rescan.size || !rescan.has(sessionRoot(base, s))) next.push(s);
  }

  if (rescan.size) {
    const scanned = await scanRoots([...rescan]);
    if (!scanned) return null;
    const found = new Set();
    for (const s of scanned) {
      found.add(s.path);
      next.push(s);
    }
    for (const path of changes.paths) {
      if (path.endsWith(".jsonl") && !found.has(path) && rescan.has(rootOf(base, path)) && !found.has(dirname(path))) {
        if (base.nonSession.size >= MAX_NON_SESSION_PATHS) base.nonSession.clear();
        base.nonSession.add(path);
      }
    }
  }

  sortSessionsByMtimeDesc(next);
  // Carry the lookups forward: unchanged sessions keep their entries.
  const byPath = new Map();
  for (const s of next) byPath.set(s.path, s);
  base.sessions = next;
  base.byPath = byPath;
  base.rootCounts = null;
  if (base.ancestors && rescan.size) {
    for (const s of next) if (rescan.has(sessionRoot(base, s))) addAncestors(base, base.ancestors, s);
  }
  return next;
}
