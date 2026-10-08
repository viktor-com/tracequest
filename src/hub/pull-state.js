/**
 * Per-host pull record for a central collection box (facts hubps, hubst).
 * `import ssh` writes one entry per host after every real run, so the hub can
 * show when each machine was last pulled and whether the pull worked without
 * opening a connection. Lives in the hosts root as a dotfile, which host
 * discovery (listImportedHosts) already ignores.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listImportedHosts, resolveHostsRoot } from "../sessions/session-discovery-paths.js";
import { sessionMtimeMs } from "../sessions/session-list.js";
import { isIndexDiskExpectedErr } from "../utils/fs-expected-err.js";

export const PULL_STATE_FILE = ".pull-state.json";
/** A host whose last good pull is older than this is shown as stale. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
export const LOCAL_HOST_ID = "local";

export function pullStatePath(hostsRoot = resolveHostsRoot()) {
  return join(hostsRoot, PULL_STATE_FILE);
}

/** Pull records by host id; a missing or unreadable file is {}. */
export function readPullState(hostsRoot = resolveHostsRoot()) {
  let text;
  try {
    text = readFileSync(pullStatePath(hostsRoot), "utf8");
  } catch (err) {
    if (isIndexDiskExpectedErr(err) || err?.code === "ENOTDIR") return {};
    throw err;
  }
  try {
    const doc = JSON.parse(text);
    return doc && typeof doc.hosts === "object" && doc.hosts ? doc.hosts : {};
  } catch {
    return {};
  }
}

/** Keep the first line of an ssh/rsync error: enough to act on, never a dump. */
function firstLine(text) {
  const line = String(text ?? "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/**
 * Merge this run's per-host outcomes into the pull record.
 * @param {Array<{hostId, spec, fetched, changed, skipped, failed, error}>} outcomes
 */
export function recordPulls(outcomes, { hostsRoot = resolveHostsRoot(), now = Date.now() } = {}) {
  const list = Array.isArray(outcomes) ? outcomes : [];
  if (!list.length) return null;
  const hosts = readPullState(hostsRoot);
  const at = new Date(now).toISOString();
  for (const o of list) {
    const prev = hosts[o.hostId] || {};
    const ok = o.failed === 0;
    hosts[o.hostId] = {
      spec: o.spec,
      lastAttemptAt: at,
      lastSuccessAt: ok ? at : prev.lastSuccessAt || null,
      ok,
      fetched: o.fetched,
      changed: o.changed,
      skipped: o.skipped,
      failed: o.failed,
      consecutiveFailures: ok ? 0 : (prev.consecutiveFailures || 0) + 1,
      error: ok ? null : firstLine(o.error) || "pull failed",
    };
  }
  mkdirSync(hostsRoot, { recursive: true });
  const path = pullStatePath(hostsRoot);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ hosts }, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
  return path;
}

/**
 * One row per machine the hub knows about: this box's own sessions first, then
 * every host that is configured, was pulled, or has imported sessions on disk.
 * state is local | fresh | stale | failing | never.
 */
export function buildHubStatus({
  sessions = [],
  pullState = readPullState(),
  configured = [],
  importedHosts = listImportedHosts().map((h) => h.host),
  now = Date.now(),
} = {}) {
  const counts = new Map();
  for (const s of sessions) {
    const id = s.host || LOCAL_HOST_ID;
    const row = counts.get(id) || { sessions: 0, newest: 0 };
    row.sessions += 1;
    row.newest = Math.max(row.newest, sessionMtimeMs(s));
    counts.set(id, row);
  }
  const specs = new Map(configured.map((h) => [h.hostId, h.spec]));
  const ids = new Set([...specs.keys(), ...Object.keys(pullState), ...importedHosts]);
  const rows = [{
    host: LOCAL_HOST_ID,
    spec: null,
    state: "local",
    sessions: counts.get(LOCAL_HOST_ID)?.sessions || 0,
    newestSessionAt: counts.get(LOCAL_HOST_ID)?.newest || null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    consecutiveFailures: 0,
    error: null,
  }];
  for (const id of [...ids].sort()) {
    const pull = pullState[id] || null;
    const success = pull?.lastSuccessAt ? Date.parse(pull.lastSuccessAt) : NaN;
    let state = "never";
    if (pull) {
      if (!pull.ok) state = "failing";
      else state = Number.isFinite(success) && now - success > STALE_AFTER_MS ? "stale" : "fresh";
    }
    rows.push({
      host: id,
      spec: specs.get(id) || pull?.spec || null,
      state,
      sessions: counts.get(id)?.sessions || 0,
      newestSessionAt: counts.get(id)?.newest || null,
      lastAttemptAt: pull?.lastAttemptAt || null,
      lastSuccessAt: pull?.lastSuccessAt || null,
      consecutiveFailures: pull?.consecutiveFailures || 0,
      error: pull?.error || null,
    });
  }
  return rows;
}
