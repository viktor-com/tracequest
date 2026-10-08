import { readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { isScanSkippableErr } from "../utils/fs-expected-err.js";
import { claudeSubagentsDirFromSessionDir, listClaudeSubagentJsonlFiles } from "./claude-subagents.js";
import { discoverCodexSessionMeta } from "../parse/parse-codex.js";
import { projectLabel, shortenProjectPath } from "../server/server-session-path.js";
import { openOpenCodeDbAtPath, openCodeDbMtimeMs, resolveOpenCodeDbPath, resolveCursorCloudRoot, listImportedHosts, openCodeUri } from "./session-discovery-paths.js";
import {
  CURSOR_TRANSCRIPTS_DIR,
  GROK_CHAT_FILE,
  claudeProjectsRoot,
  codexSessionsRoot,
  cursorMainRecording,
  cursorProjectsRoot,
  factorySessionsRoot,
  grokSessionsRoot,
  isCodexRolloutFile,
} from "./session-layout.js";

export { loadDatabaseSync, resolveOpenCodeDbPath, resolveCursorCloudRoot, resolveHostsRoot, listImportedHosts, stampImportedHost, isImportedHostSession, parseOpenCodeUri, openCodeUri, resolveOpenCodeDbForUri, openOpenCodeDbReadOnly, withOpenCodeDb } from "./session-discovery-paths.js";
export { extractCodexProject } from "../parse/parse-codex.js";

/** Resolve provider paths from current HOME (lazy for tests and chdir). */
export function getDiscoveryPaths() {
  const home = homedir();
  // Roots come from the shared layout module (src/sessions/session-layout.js)
  // so discovery, live detection and run attribution can never disagree.
  return {
    claudeDir: claudeProjectsRoot(home),
    codexDir: codexSessionsRoot(home),
    cursorDir: cursorProjectsRoot(home),
    cursorCloudDir: resolveCursorCloudRoot(home),
    factoryDir: factorySessionsRoot(home),
    grokDir: grokSessionsRoot(home),
    openCodeDb: resolveOpenCodeDbPath(home),
  };
}

/** Local filesystem roots for one synthetic $HOME (no cursor-cloud). */
function filesystemRootsForHome(home) {
  return [
    claudeProjectsRoot(home),
    cursorProjectsRoot(home),
    codexSessionsRoot(home),
    factorySessionsRoot(home),
    grokSessionsRoot(home),
    resolveOpenCodeDbPath(home),
  ];
}

/** Extra discovery roots for hosts already imported under resolveHostsRoot. */
function extraHostDiscoveryRoots(home = homedir()) {
  const extra = [];
  for (const imported of listImportedHosts(home)) {
    extra.push(...filesystemRootsForHome(imported.home));
  }
  return extra;
}

/** Roots passed to the Rust sidecar scan and JS discovery fallback (OpenCode DB last among local roots). */
export function discoveryRoots() {
  const p = getDiscoveryPaths();
  return [
    p.claudeDir,
    p.codexDir,
    p.cursorDir,
    p.cursorCloudDir,
    p.factoryDir,
    p.grokDir,
    p.openCodeDb,
    ...extraHostDiscoveryRoots(),
  ];
}

/**
 * Newest-only OpenCode row cache: dbPath -> { mtime, rows }.
 *
 * Keying this by (path, mtime) meant every write to an actively-used
 * opencode.db minted a new entry holding up to 10000 row objects, and nothing
 * ever dropped the old ones — a `serve` process watching a live OpenCode
 * session grew without bound (fact dqe). Only the current mtime is ever read,
 * so one slot per database is all the cache was ever using.
 */
let _openCodeCache = new Map();

/** Reset OpenCode DB row cache (tests). */
export function clearOpenCodeDiscoveryCache() {
  _openCodeCache = new Map();
}

/** Number of cached OpenCode databases; one per database is the invariant (fact dqe). */
export function openCodeDiscoveryCacheSizeForTests() {
  return _openCodeCache.size;
}

/**
 * Single stat per path; an unreadable entry is null, never a throw
 * (avoids withFileTypes lstat + statSync duplication).
 */
function statEntry(path) {
  try {
    return statSync(path);
  } catch (err) {
    if (isScanSkippableErr(err)) return null;
    throw err;
  }
}

/**
 * Directory listing that degrades to "nothing here" for the errors that make a
 * single subtree unreadable. Every readdir in discovery goes through this: an
 * unguarded one turns one bad directory into an empty session list.
 */
function readDirEntries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (isScanSkippableErr(err)) return [];
    throw err;
  }
}

/** Depth ceiling for the one unbounded walk (codex dates nest YYYY/MM/DD). */
const MAX_WALK_DEPTH = 8;

/**
 * Real path of a directory, used as the cycle key. Falls back to the literal
 * path when it cannot be resolved so an unresolvable entry is still visited once.
 */
function realDirKey(dir) {
  try {
    return realpathSync(dir);
  } catch (err) {
    if (isScanSkippableErr(err)) return dir;
    throw err;
  }
}

function dirEntryIsDirectory(path, entry) {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  return Boolean(statEntry(path)?.isDirectory());
}

function discoveryPathsForHome(home, host = null) {
  return {
    claudeDir: claudeProjectsRoot(home),
    codexDir: codexSessionsRoot(home),
    cursorDir: cursorProjectsRoot(home),
    factoryDir: factorySessionsRoot(home),
    grokDir: grokSessionsRoot(home),
    openCodeDb: resolveOpenCodeDbPath(home),
    host,
  };
}

export function discoverSessions(projectFilter, out = []) {
  const paths = getDiscoveryPaths();
  findClaudeSessions(projectFilter, out, paths);
  findCodexSessions(projectFilter, out, paths);
  findCursorSessions(projectFilter, out, paths);
  findFactorySessions(projectFilter, out, paths);
  findGrokSessions(projectFilter, out, paths);
  findCursorCloudSessions(projectFilter, out, paths);
  findOpenCodeSessions(projectFilter, out, paths);
  // Imported SSH hosts: walk mirrored filesystem trees plus OpenCode DBs.
  // cursor-cloud is not copied by import ssh.
  for (const imported of listImportedHosts()) {
    const hostPaths = discoveryPathsForHome(imported.home, imported.host);
    findClaudeSessions(projectFilter, out, hostPaths);
    findCodexSessions(projectFilter, out, hostPaths);
    findCursorSessions(projectFilter, out, hostPaths);
    findFactorySessions(projectFilter, out, hostPaths);
    findGrokSessions(projectFilter, out, hostPaths);
    findOpenCodeSessions(projectFilter, out, hostPaths);
  }
  return out;
}

export function findClaudeSessions(projectFilter, out = [], paths = getDiscoveryPaths()) {
  return findClaudeFamilySessions(projectFilter, out, paths.claudeDir, "claude");
}

export function findCursorSessions(projectFilter, out = [], paths = getDiscoveryPaths()) {
  const cursorDir = paths.cursorDir;
  const projectEntries = readDirEntries(cursorDir);
  for (const projEntry of projectEntries) {
    const projName = projEntry.name;
    if (projectFilter && !projName.includes(projectFilter)) continue;
    const projDir = join(cursorDir, projName);
    if (!dirEntryIsDirectory(projDir, projEntry)) continue;

    const transcriptsDir = join(projDir, CURSOR_TRANSCRIPTS_DIR);
    const uuidEntries = readDirEntries(transcriptsDir);
    for (const uuidEntry of uuidEntries) {
      const uuidName = uuidEntry.name;
      const uuidDir = join(transcriptsDir, uuidName);
      if (!dirEntryIsDirectory(uuidDir, uuidEntry)) continue;

      // Main session file: <uuid>/<uuid>.jsonl (shared layout helper)
      const mainFile = uuidName + ".jsonl";
      const mainPath = cursorMainRecording(transcriptsDir, uuidName);
      const mainStat = statEntry(mainPath);
      if (mainStat?.isFile()) {
        out.push({ path: mainPath, project: projName, file: mainFile, size: mainStat.size, mtime: mainStat.mtime, source: "cursor" });
      }

      // Subagent files reuse Claude's convention: <uuid>/subagents/<sub>.jsonl
      const subDir = claudeSubagentsDirFromSessionDir(uuidDir);
      for (const { name: subName, path: subFull } of listClaudeSubagentJsonlFiles(subDir, {
        logLabel: "findCursorSessions",
      })) {
        const subStat = statEntry(subFull);
        if (!subStat?.isFile()) continue;
        out.push({
          path: subFull,
          project: projName,
          file: subName,
          size: subStat.size,
          mtime: subStat.mtime,
          source: "cursor",
          parentSession: uuidName,
        });
      }
    }
  }
  return out;
}

/** Imported cloud-agent sessions: <root>/<project-slug>/<agentId>.jsonl (no subagents). */
export function findCursorCloudSessions(projectFilter, out = [], paths = getDiscoveryPaths()) {
  return findClaudeFamilySessions(projectFilter, out, paths.cursorCloudDir, "cursor-cloud");
}

function findClaudeFamilySessions(projectFilter, out, rootDir, source) {
  const claudeDir = rootDir;
  const projectEntries = readDirEntries(claudeDir);
  for (const projEntry of projectEntries) {
    const projName = projEntry.name;
    if (projectFilter && !projName.includes(projectFilter)) continue;
    const projDir = join(claudeDir, projName);
    if (!dirEntryIsDirectory(projDir, projEntry)) continue;
    for (const entry of readDirEntries(projDir)) {
      const name = entry.name;
      const full = join(projDir, name);
      if (name.endsWith(".jsonl")) {
        const stat = statEntry(full);
        if (!stat?.isFile()) continue;
        out.push({ path: full, project: projName, file: name, size: stat.size, mtime: stat.mtime, source });
        continue;
      }
      if (!dirEntryIsDirectory(full, entry)) continue;
      const subDir = claudeSubagentsDirFromSessionDir(full);
      for (const { name: subName, path: subFull } of listClaudeSubagentJsonlFiles(subDir, {
        logLabel: source === "cursor" ? "findCursorSessions" : "findClaudeSessions",
      })) {
        const subStat = statEntry(subFull);
        if (!subStat?.isFile()) continue;
        out.push({
          path: subFull,
          project: projName,
          file: subName,
          size: subStat.size,
          mtime: subStat.mtime,
          source,
          parentSession: name,
        });
      }
    }
  }
  return out;
}

export function findCodexSessions(projectFilter, out = [], paths = getDiscoveryPaths()) {
  const { codexDir } = paths;
  const rootEntries = readDirEntries(codexDir);
  // Symlinks are followed, so the walk needs both a depth ceiling and a
  // visited-real-path set: without them a directory linked to its own ancestor
  // recurses until ELOOP, which used to escape and empty the whole list.
  const visited = new Set();
  const walk = (dir, entries = readDirEntries(dir), depth = 0) => {
    for (const entry of entries) {
      const name = entry.name;
      const full = join(dir, name);
      if (dirEntryIsDirectory(full, entry)) {
        if (depth >= MAX_WALK_DEPTH) continue;
        const key = realDirKey(full);
        if (visited.has(key)) continue;
        visited.add(key);
        walk(full, undefined, depth + 1);
        continue;
      }
      if (!isCodexRolloutFile(name)) continue;
      const { project, size, mtime } = discoverCodexSessionMeta(full);
      if (projectFilter && !project.includes(projectFilter)) continue;
      out.push({ path: full, project, file: name, size, mtime, source: "codex" });
    }
  };
  visited.add(realDirKey(codexDir));
  walk(codexDir, rootEntries, 0);
  return out;
}

export function findFactorySessions(projectFilter, out = [], paths = getDiscoveryPaths()) {
  const { factoryDir } = paths;
  const wsEntries = readDirEntries(factoryDir);
  for (const wsEntry of wsEntries) {
    const wsName = wsEntry.name;
    const wsDir = join(factoryDir, wsName);
    if (!dirEntryIsDirectory(wsDir, wsEntry)) continue;
    if (projectFilter) {
      const label = projectLabel(wsName);
      if (!wsName.includes(projectFilter) && !label.includes(projectFilter)) continue;
    }
    const project = projectLabel(wsName);
    for (const entry of readDirEntries(wsDir)) {
      const name = entry.name;
      if (!name.endsWith(".jsonl")) continue;
      const full = join(wsDir, name);
      const stat = statEntry(full);
      if (!stat?.isFile()) continue;
      out.push({ path: full, project: project || "factory", file: name, size: stat.size, mtime: stat.mtime, source: "factory" });
    }
  }
  return out;
}

export function findGrokSessions(projectFilter, out = [], paths = getDiscoveryPaths()) {
  const { grokDir } = paths;
  const wsEntries = readDirEntries(grokDir);
  for (const wsEntry of wsEntries) {
    const wsName = wsEntry.name;
    const wsDir = join(grokDir, wsName);
    if (!dirEntryIsDirectory(wsDir, wsEntry)) continue;
    const decoded = decodeURIComponent(wsName);
    const project = shortenProjectPath(decoded);
    if (projectFilter && !project.includes(projectFilter) && !decoded.includes(projectFilter)) continue;
    for (const entry of readDirEntries(wsDir)) {
      const name = entry.name;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const chatPath = join(wsDir, name, GROK_CHAT_FILE);
      const stat = statEntry(chatPath);
      if (!stat?.isFile()) continue;
      out.push({
        path: join(wsDir, name),
        project: project || "grok",
        file: name,
        size: stat.size,
        mtime: stat.mtime,
        source: "grok",
      });
    }
  }
  return out;
}

export function findOpenCodeSessions(projectFilter, out = [], paths = getDiscoveryPaths()) {
  const openCodeDb = paths.openCodeDb;
  const host = paths.host || null;
  const dbMtime = openCodeDbMtimeMs(openCodeDb);
  if (dbMtime === null) {
    return out;
  }
  try {
    const cached = _openCodeCache.get(openCodeDb);
    let rows;
    if (cached && cached.mtime === dbMtime) {
      rows = cached.rows;
    } else {
      const { db } = openOpenCodeDbAtPath(openCodeDb);
      rows = db
        .prepare(
          `
        SELECT s.id, s.title, s.directory, s.version, s.time_created, s.time_updated,
               COUNT(m.rowid) AS msg_count
        FROM session s
        INNER JOIN message m ON m.session_id = s.id
        GROUP BY s.id
        HAVING COUNT(m.rowid) >= 3
        ORDER BY s.time_updated DESC
        LIMIT 10000
      `
        )
        .all();
      db.close();
      // Replaces any older mtime for this database rather than adding to it.
      _openCodeCache.set(openCodeDb, { mtime: dbMtime, rows });
    }

    for (const row of rows) {
      const dir = row.directory || "";
      const project = shortenProjectPath(dir) || "opencode";
      if (projectFilter && !project.includes(projectFilter) && !dir.includes(projectFilter)) continue;
      const rowOut = {
        path: openCodeUri(row.id, host),
        project,
        file: row.id,
        size: row.msg_count * 1024,
        mtime: new Date(row.time_updated || row.time_created),
        source: "opencode",
        title: row.title,
      };
      if (host) rowOut.host = host;
      out.push(rowOut);
    }
    return out;
  } catch (err) {
    console.error(`findOpenCodeSessions: failed to query ${openCodeDb}:`, err.message);
    _openCodeCache.delete(openCodeDb);
    return out;
  }
}
