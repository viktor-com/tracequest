/**
 * On-disk cache of per-session analysis records (fact insch):
 * Default: ~/.cache/tracequest/insights.json (TRACEQUEST_CACHE_DIR overrides the directory),
 * keyed by session path and invalidated by the session mtime, INSIGHTS_VERSION
 * or parser/index format version. Rebuildable — deleting
 * the file only costs one refresh.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { sessionMtimeMs } from "../sessions/session-list.js";
import { isIndexDiskExpectedErr } from "../utils/fs-expected-err.js";
import { analyzeSession, INSIGHTS_VERSION } from "./analyze.js";
import { INDEX_VERSION } from "../sessions/index-writers.js";

export function insightsCachePath(home = homedir()) {
  return join(process.env.TRACEQUEST_CACHE_DIR || join(home, ".cache", "tracequest"), "insights.json");
}

/** Cached records by session path; a missing, corrupt or stale-version file is {}. */
export function loadInsights(home = homedir()) {
  let text;
  try {
    text = readFileSync(insightsCachePath(home), "utf8");
  } catch (err) {
    if (isIndexDiskExpectedErr(err)) return {};
    throw err;
  }
  try {
    const doc = JSON.parse(text);
    if (!doc || doc._v !== INSIGHTS_VERSION || doc._indexVersion !== INDEX_VERSION || typeof doc.sessions !== "object") return {};
    return doc.sessions || {};
  } catch {
    return {};
  }
}

export function saveInsights(records, home = homedir()) {
  const path = insightsCachePath(home);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ _v: INSIGHTS_VERSION, _indexVersion: INDEX_VERSION, sessions: records }), "utf8");
  renameSync(tmp, path);
  return path;
}

/**
 * Analyse every discovered session whose file changed since the cached record
 * was written, drop records for sessions that are gone, and persist the result.
 * A session that fails to parse is counted and skipped, never fatal.
 *
 * @returns {{ records: object, analyzed: number, reused: number, failed: number, removed: number }}
 */
export async function refreshInsights({ sessions, parseSession, home = homedir(), onProgress = null } = {}) {
  const previous = loadInsights(home);
  const records = {};
  let analyzed = 0;
  let reused = 0;
  let failed = 0;
  const list = Array.isArray(sessions) ? sessions : [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const mtime = sessionMtimeMs(s);
    const cached = previous[s.path];
    if (cached && cached.mtime === mtime && cached.v === INSIGHTS_VERSION) {
      records[s.path] = cached;
      reused += 1;
      continue;
    }
    try {
      const parsed = await parseSession(s.path, s.source);
      records[s.path] = { ...analyzeSession(parsed), mtime };
      analyzed += 1;
    } catch {
      failed += 1;
    }
    if (onProgress && (i + 1) % 500 === 0) onProgress(i + 1, list.length);
  }
  let removed = 0;
  for (const path of Object.keys(previous)) if (!records[path]) removed += 1;
  saveInsights(records, home);
  return { records, analyzed, reused, failed, removed };
}
