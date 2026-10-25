import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

export const SESSION_HASH_RE = /^[0-9a-f]{8}$/;

export function sessionHash(path) {
  return createHash("sha256").update(String(path || ""), "utf8").digest("hex").slice(0, 8);
}

export function isSessionHash(value) {
  return typeof value === "string" && SESSION_HASH_RE.test(value);
}

export function sessionHashFor(session) {
  return sessionHash(session?.path || session?._path || "");
}

export function attachSessionHash(session) {
  if (session && session.path) session.sessionHash = sessionHash(session.path);
  return session;
}

export function findSessionsByHash(hash, sessions) {
  if (!isSessionHash(hash) || !Array.isArray(sessions)) return [];
  return sessions.filter((session) => sessionHashFor(session) === hash);
}

export function resolveSessionHandle(input, sessions) {
  if (!isSessionHash(input)) return { status: "not-hash", session: null, matches: [] };
  const matches = findSessionsByHash(input, sessions);
  if (matches.length === 1) return { status: "ok", session: matches[0], matches };
  if (matches.length > 1) return { status: "ambiguous", session: null, matches };
  return { status: "not-found", session: null, matches };
}

/**
 * Hash → path memo of every session file discovery has reported. Lets a hash
 * handle (/view?id=<hash>) resolve without walking the whole session tree
 * again: a memo hit is used only when exactly one remembered file carries the
 * hash and it still exists; anything else falls back to a fresh discovery.
 */
const _hashByPath = new Map();
const _pathsByHash = new Map();
/**
 * Paths reported but not hashed yet: hashing every discovered path costs a
 * sha256 each, which a command that never resolves a hash (search, list)
 * should not pay, so they are hashed on the first lookup.
 */
let _pendingPaths = [];
const MAX_PENDING_PATHS = 100_000;

export function rememberSessionPaths(sessions) {
  if (!Array.isArray(sessions)) return;
  for (const s of sessions) {
    const path = s?.path;
    if (typeof path === "string" && path) _pendingPaths.push(path);
  }
  // A long-lived process (serve) rescans often without resolving a hash: fold
  // the queue into the memo now and then, so it never grows without bound.
  if (_pendingPaths.length > MAX_PENDING_PATHS) hashPendingPaths();
}

function hashPendingPaths() {
  const pending = _pendingPaths;
  _pendingPaths = [];
  for (const path of pending) {
    if (_hashByPath.has(path)) continue;
    const hash = sessionHash(path);
    _hashByPath.set(path, hash);
    let paths = _pathsByHash.get(hash);
    if (!paths) _pathsByHash.set(hash, (paths = new Set()));
    paths.add(path);
  }
}

/** The one existing remembered session file whose hash is `hash`, else null. */
export function rememberedSessionPathForHash(hash) {
  if (!isSessionHash(hash)) return null;
  if (_pendingPaths.length) hashPendingPaths();
  const paths = _pathsByHash.get(hash);
  if (!paths || paths.size !== 1) return null;
  const [path] = paths;
  if (path.includes("://") || !existsSync(path)) return null;
  return path;
}

export function forgetSessionPathsForTests() {
  _pendingPaths = [];
  _hashByPath.clear();
  _pathsByHash.clear();
}
