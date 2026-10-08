import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { includesLower } from "../parse/parse-utils.js";
import { isIndexDiskExpectedErr } from "../utils/fs-expected-err.js";

/** Path segments under $HOME for OpenCode's SQLite session store. */
export const OPENCODE_DB_REL = [".local", "share", "opencode", "opencode.db"];

export function resolveOpenCodeDbPath(home = homedir()) {
  return join(home, ...OPENCODE_DB_REL);
}

/**
 * Path segments under $HOME for the tracequest-owned cursor-cloud import root.
 * Durable data dir (not the rebuildable ~/.cache index dir): deleted cloud
 * agents 404 remotely and cannot be re-fetched (fact ccrt).
 */
export const CURSOR_CLOUD_ROOT_REL = [".local", "share", "tracequest", "cursor-cloud"];

/** Shared resolver for discovery and the importer; env override precedent: TRACEQUEST_CURSOR_STATE_DB. */
export function resolveCursorCloudRoot(home = homedir()) {
  const override = process.env.TRACEQUEST_CURSOR_CLOUD_DIR;
  if (override) return override;
  return join(home, ...CURSOR_CLOUD_ROOT_REL);
}

/**
 * Path segments under $HOME for the tracequest-owned SSH-import hosts root.
 * Durable data dir: a session that vanishes on the remote stays here
 * (the importer never passes rsync --delete).
 */
export const HOSTS_ROOT_REL = [".local", "share", "tracequest", "hosts"];

/** Shared resolver for discovery and the SSH importer; env override: TRACEQUEST_HOSTS_DIR. */
export function resolveHostsRoot(home = homedir()) {
  const override = process.env.TRACEQUEST_HOSTS_DIR;
  if (override) return override;
  return join(home, ...HOSTS_ROOT_REL);
}

/**
 * Host directories already materialised under the hosts root.
 * Absent root → []. Each entry is { host, home } where home is a synthetic $HOME.
 */
export function listImportedHosts(home = homedir()) {
  const root = resolveHostsRoot(home);
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (err) {
    if (isIndexDiskExpectedErr(err) || err?.code === "ENOTDIR") return [];
    throw err;
  }
  const hosts = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    hosts.push(entry.name);
  }
  hosts.sort();
  return hosts.map((host) => ({ host, home: join(root, host) }));
}

const OPENCODE_SESSION_ID_RE = /^ses_[0-9A-Za-z]{20,}$/;

/** Split `opencode://ses_…` (local) or `opencode://<host>/ses_…` (imported). */
export function parseOpenCodeUri(uri) {
  const rest = String(uri ?? "").replace(/^opencode:\/\//, "");
  const slash = rest.indexOf("/");
  if (slash === -1) return { host: null, sessionId: rest };
  return { host: rest.slice(0, slash), sessionId: rest.slice(slash + 1) };
}

export function openCodeUri(sessionId, host) {
  return host ? `opencode://${host}/${sessionId}` : `opencode://${sessionId}`;
}

export function isOpenCodeSessionId(id) {
  return OPENCODE_SESSION_ID_RE.test(String(id ?? ""));
}

/** OpenCode db for a virtual URI: local default, or hosts/<id>/… for imported. */
export function resolveOpenCodeDbForUri(uri, home = homedir()) {
  const { host } = parseOpenCodeUri(uri);
  if (!host) return resolveOpenCodeDbPath(home);
  return resolveOpenCodeDbPath(join(resolveHostsRoot(home), host));
}

/**
 * Stamp `host` on a discovery row whose path sits under the hosts root,
 * or whose opencode URI is host-prefixed.
 */
export function stampImportedHost(session, hostsRoot = resolveHostsRoot()) {
  if (!session || typeof session.path !== "string" || !session.path) return session;
  if (session.path.startsWith("opencode://")) {
    const { host } = parseOpenCodeUri(session.path);
    if (host) session.host = host;
    return session;
  }
  const prefix = hostsRoot.endsWith("/") ? hostsRoot : `${hostsRoot}/`;
  if (!session.path.startsWith(prefix)) return session;
  const host = session.path.slice(prefix.length).split("/").filter(Boolean)[0];
  if (host) session.host = host;
  return session;
}

/** True when a session was materialised by import ssh (host field or hosts-root path). */
export function isImportedHostSession(sessionOrPath) {
  if (sessionOrPath && typeof sessionOrPath === "object") {
    if (sessionOrPath.host) return true;
    return isImportedHostSession(sessionOrPath.path);
  }
  const path = String(sessionOrPath ?? "");
  if (!path) return false;
  if (path.startsWith("opencode://")) return Boolean(parseOpenCodeUri(path).host);
  const root = resolveHostsRoot();
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(prefix);
}

/** Suppress node:sqlite ExperimentalWarning during first require. */
export function loadDatabaseSync() {
  const origEmitWarning = process.emitWarning;
  process.emitWarning = (warning, ...args) => {
    const msg = typeof warning === "string" ? warning : (warning && warning.message) || "";
    if (includesLower(msg, "sqlite") && includesLower(msg, "experimental")) {
      return;
    }
    return origEmitWarning.call(process, warning, ...args);
  };
  try {
    const mod = createRequire(import.meta.url)("node:sqlite");
    return mod.DatabaseSync;
  } finally {
    process.emitWarning = origEmitWarning;
  }
}

export function openOpenCodeDbReadOnly(home = homedir()) {
  return openOpenCodeDbAtPath(resolveOpenCodeDbPath(home));
}

export function openOpenCodeDbAtPath(dbPath) {
  const DatabaseSync = loadDatabaseSync();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  return { db, dbPath };
}

export function withOpenCodeDb(fn, opts = {}) {
  const { db, dbPath } = openOpenCodeDbReadOnly(opts.home);
  try {
    return fn(db, dbPath);
  } finally {
    db.close();
  }
}

export function openCodeDbMtimeMs(dbPath) {
  try {
    return statSync(dbPath).mtime.getTime();
  } catch (err) {
    if (isIndexDiskExpectedErr(err)) return null;
    throw err;
  }
}