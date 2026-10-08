import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isScanSkippableErr } from "../utils/fs-expected-err.js";

/** `{sessionDir}/subagents` for a Claude parent session directory. */
export function claudeSubagentsDirFromSessionDir(sessionDir) {
  return join(sessionDir, "subagents");
}

/** `{parent}.jsonl` → `{parent}/subagents` (Claude sidecar layout). */
export function claudeSubagentsDirFromSessionPath(sessionPath) {
  return join(dirname(sessionPath), basename(sessionPath, ".jsonl"), "subagents");
}

/**
 * List regular `.jsonl` files in a Claude `subagents/` directory.
 *
 * A directory this process cannot read is that session's problem, not the
 * session list's: every per-entry error yields `[]` so one 0700 `subagents/`
 * folder cannot empty the dashboard. Only a genuinely unexpected error
 * (a broken fd table, EIO) still escapes.
 *
 * @param {string} subDir
 * @param {{ logLabel?: string }} [opts]
 * @returns {Array<{ name: string, path: string }>}
 */
export function listClaudeSubagentJsonlFiles(subDir, opts = {}) {
  const logLabel = opts.logLabel ?? "listClaudeSubagentJsonlFiles";
  const hits = [];
  try {
    for (const ent of readdirSync(subDir, { withFileTypes: true })) {
      if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue;
      hits.push({ name: ent.name, path: join(subDir, ent.name) });
    }
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    if (isScanSkippableErr(err)) {
      warnSubagentDirOnce(logLabel, subDir, err);
      return [];
    }
    console.error(`${logLabel}: failed to read subagents in ${subDir}:`, err.message);
    throw err;
  }
  return hits;
}
/** Unreadable subagent dirs are usually permanent; say so once, not once per scan. */
const _warnedSubagentDirs = new Set();

function warnSubagentDirOnce(logLabel, subDir, err) {
  if (_warnedSubagentDirs.has(subDir)) return;
  // A pathological tree should not turn this into its own unbounded cache.
  if (_warnedSubagentDirs.size >= 64) _warnedSubagentDirs.clear();
  _warnedSubagentDirs.add(subDir);
  console.warn(`${logLabel}: skipping unreadable subagents dir ${subDir}: ${err.message}`);
}

/** Tests: forget which unreadable dirs have already been reported. */
export function resetSubagentDirWarningsForTests() {
  _warnedSubagentDirs.clear();
}
