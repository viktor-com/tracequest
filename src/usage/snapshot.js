/**
 * Read/write secret-free usage-limits.json next to an imported host's
 * synthetic HOME (resolveHostsRoot / listImportedHosts).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { listImportedHosts, resolveHostsRoot } from "../sessions/session-discovery-paths.js";
import { isIndexDiskExpectedErr } from "../utils/fs-expected-err.js";
import { looksLikeSecretBlob } from "./redact.js";

export const USAGE_LIMITS_REL = Object.freeze([".tracequest", "usage-limits.json"]);

export function usageLimitsPath(hostId, hostsRoot = resolveHostsRoot()) {
  return join(hostsRoot, hostId, ...USAGE_LIMITS_REL);
}

export function validateSnapshotShape(snapshot) {
  if (!snapshot || typeof snapshot !== "object") throw new Error("snapshot is not an object");
  if (typeof snapshot.collectedAt !== "string" || !snapshot.collectedAt) {
    throw new Error("snapshot.collectedAt must be an ISO-8601 string");
  }
  if (snapshot.host != null && typeof snapshot.host !== "string") {
    throw new Error("snapshot.host must be null or a string");
  }
  if (!Array.isArray(snapshot.harnesses)) throw new Error("snapshot.harnesses must be an array");
  for (const row of snapshot.harnesses) {
    if (!row || typeof row.id !== "string") throw new Error("harness.id required");
    if (!["ok", "missing", "unauthenticated", "unavailable", "error"].includes(row.status)) {
      throw new Error(`invalid harness status: ${row.status}`);
    }
    if (row.plan != null && typeof row.plan !== "string") throw new Error("harness.plan must be a string or null");
    if (!Array.isArray(row.windows)) throw new Error("harness.windows must be an array");
    for (const win of row.windows) {
      if (!win || typeof win.id !== "string") throw new Error("window.id required");
      if (typeof win.utilization !== "number" || !Number.isFinite(win.utilization)) {
        throw new Error("window.utilization must be a finite number");
      }
      if (win.resetsAt != null && typeof win.resetsAt !== "string") {
        throw new Error("window.resetsAt must be ISO-8601 or null");
      }
    }
  }
  if (looksLikeSecretBlob(snapshot)) {
    throw new Error("snapshot contains a token-shaped secret");
  }
  return snapshot;
}

export function writeUsageSnapshot(hostId, snapshot, { hostsRoot = resolveHostsRoot() } = {}) {
  const path = usageLimitsPath(hostId, hostsRoot);
  const doc = validateSnapshotShape({ ...snapshot, host: hostId });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  return path;
}

export function readUsageSnapshot(hostId, { hostsRoot = resolveHostsRoot() } = {}) {
  const path = usageLimitsPath(hostId, hostsRoot);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (isIndexDiskExpectedErr(err)) return null;
    throw err;
  }
  try {
    return validateSnapshotShape(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Disk snapshots for imported hosts. Missing files are omitted, never thrown. */
export function listImportedUsageSnapshots({ home, hostsRoot } = {}) {
  const hosts = listImportedHosts(home);
  const root = hostsRoot || resolveHostsRoot(home);
  const out = [];
  for (const { host } of hosts) {
    const snapshot = readUsageSnapshot(host, { hostsRoot: root });
    if (snapshot) out.push(snapshot);
  }
  return out;
}
