import { createHash } from "node:crypto";

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
