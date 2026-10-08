import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { forEachJsonlLine } from "../parse/jsonl-read.js";
import { sessionMtimeMs } from "./session-list.js";
import { isIndexDiskExpectedErr, isProcRaceErr } from "../utils/fs-expected-err.js";
import { procCwds, openPathsAmong } from "./proc-probe.js";
import { codexSessionMetaCwd } from "../parse/parse-codex.js";
import { normalizeProjectFolder, shortenProjectPath } from "../server/server-session-path.js";
import {
  claudeProjectDir,
  cursorMainRecording,
  cursorTranscriptsDir,
  factoryWorkspaceDir,
  grokSessionDir,
} from "./session-layout.js";
import { recordingIsGenerating } from "./live-session-generating.js";

// The layout helpers live in session-layout.js (ONE definition shared with
// discovery and run attribution); re-exported here for callers/tests that
// have always imported them from the live-detection module.
export { cursorProjectSlug, factoryWorkspaceSlug } from "./session-layout.js";

function homeDir() {
  return process.env.TRACEQUEST_LIVE_SESSIONS_HOME || homedir();
}

let _liveCache = null;
let _liveCacheTime = 0;

/** @type {import("./proc-probe.js").ProbeDeps & { statSync?: typeof statSync } | null} */
let _findLiveClaudeDeps = null;

/**
 * Inject pgrep/cwd probes in tests only. Applies to every finder in this module,
 * not just findLiveClaude. Pass `platform` to select which probe implementation
 * runs regardless of host OS.
 */
export function setFindLiveClaudeDepsForTests(deps) {
  _findLiveClaudeDeps = deps ?? null;
}

/** True when the probed cwd matches the cwd recorded in active_sessions.json. */
export function grokProcCwdMatches(entryCwd, procCwd) {
  if (procCwd === entryCwd) return true;
  return procCwd === `${entryCwd} (deleted)`;
}

export function findLiveGrok() {
  const home = homeDir();
  const activePath = join(home, ".grok", "active_sessions.json");
  const live = [];
  let entries;
  try {
    entries = JSON.parse(readFileSync(activePath, "utf-8"));
  } catch (err) {
    if (isIndexDiskExpectedErr(err)) return live;
    console.error("findLiveGrok: failed to read active_sessions.json:", err.message);
    return live;
  }
  if (!Array.isArray(entries)) return live;

  const valid = entries.filter((e) => e && e.session_id && e.cwd && e.pid);
  if (!valid.length) return live;
  const cwds = procCwds(valid.map((e) => e.pid), _findLiveClaudeDeps ?? undefined);

  for (const entry of valid) {
    const procCwd = cwds.get(String(entry.pid));
    if (!procCwd || !grokProcCwdMatches(entry.cwd, procCwd)) continue;
    const dir = grokSessionDir(home, entry.cwd, entry.session_id);
    if (recordingIsGenerating("grok", dir)) live.push(dir);
  }
  return live;
}

/** Newest root-level .jsonl in `dir` (null when none, missing dirs silent). */
function newestJsonlInDir(dir, logLabel) {
  const readdir = _findLiveClaudeDeps?.readdirSync ?? readdirSync;
  const stat = _findLiveClaudeDeps?.statSync ?? statSync;
  let newest = null;
  let newestMtime = 0;
  try {
    for (const f of readdir(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const full = join(dir, f);
      try {
        const mt = stat(full).mtime.getTime();
        if (mt > newestMtime) { newestMtime = mt; newest = full; }
      } catch (err) {
        if (!isProcRaceErr(err)) console.error(`${logLabel}: stat failed for ${full}:`, err.message);
      }
    }
  } catch (err) {
    if (!isIndexDiskExpectedErr(err)) {
      console.error(`${logLabel}: failed to read ${dir}:`, err.message);
    }
  }
  return newest;
}

/** Newest root-level .jsonl in a Claude project dir (null when none). */
function newestClaudeJsonlInProjDir(projDir) {
  return newestJsonlInDir(projDir, "findLiveClaude");
}

/**
 * pgrep arguments for finding claude processes.
 *
 * BSD pgrep (darwin) excludes its OWN ANCESTORS from results unless -a is given.
 * tracequest is frequently launched from inside a claude session, which makes
 * that session pgrep's ancestor — so the one session the user is most likely to
 * look for would be silently missing from the live list. -a includes ancestors.
 *
 * On linux, -a means "--list-full" instead and would prepend the command line to
 * every row, breaking pid parsing. Linux pgrep already includes ancestors, so it
 * needs no extra flag.
 */
export function claudePgrepArgs(platform = process.platform) {
  return platform === "darwin" ? ["-ax", "claude"] : ["-x", "claude"];
}

export function findLiveClaude() {
  const home = homeDir();
  const live = [];
  const spawn = _findLiveClaudeDeps?.spawnSync ?? spawnSync;

  let pids;
  try {
    const args = claudePgrepArgs(_findLiveClaudeDeps?.platform);
    const result = spawn("pgrep", args, { encoding: "utf-8", timeout: 2000 });
    if (result.status !== 0 || !result.stdout) return live;
    pids = [];
    forEachJsonlLine(result.stdout, (line) => {
      const pid = line.trim();
      if (pid) pids.push(pid);
    });
  } catch (err) {
    console.error("findLiveClaude: pgrep failed:", err.message);
    return live;
  }
  if (!pids.length) return live;

  const cwds = procCwds(pids, _findLiveClaudeDeps ?? undefined);
  /** @type {Map<string, string | null>} projDir → newest session (null = scanned, none found) */
  const projDirCache = new Map();
  for (const pid of pids) {
    const cwd = cwds.get(pid);
    if (!cwd) continue;
    const projDir = claudeProjectDir(home, cwd);
    let newest;
    if (projDirCache.has(projDir)) {
      newest = projDirCache.get(projDir);
    } else {
      newest = newestClaudeJsonlInProjDir(projDir);
      projDirCache.set(projDir, newest);
    }
    if (newest && recordingIsGenerating("claude", newest, { home, pid })) live.push(newest);
  }
  return live;
}

/**
 * External agents detected by PROCESS, not open fd. None of these CLIs hold
 * their recording open between writes (the same append/close pattern the
 * real claude CLI follows — the reason findLiveClaude is pgrep-based), so
 * open-fd probing alone can never see them. Process presence in a cwd that
 * has a recording is a candidate only: live additionally requires that
 * recording to show a generating or tool-executing turn. Binary names
 * mirror the launch registry (src/agents/agent-detect.js SOURCE_AGENTS).
 * grok is absent (active_sessions.json is a better candidate signal — findLiveGrok);
 * cursor-cloud is absent DELIBERATELY: a cloud agent has no local process
 * to probe, and reporting an imported recording as RUNNING from mere import
 * freshness would be a lie, so cursor-cloud sessions are never live.
 */
const EXTERNAL_AGENT_PROCESS_SPECS = [
  { source: "codex", binary: "codex" },
  { source: "cursor", binary: "cursor-agent" },
  { source: "factory", binary: "droid" },
  { source: "opencode", binary: "opencode" },
];

/** First-line reads per probed cwd when matching codex session_meta cwds. */
const CODEX_CWD_READS_MAX = 8;

/**
 * pgrep invocations that find one agent binary's processes:
 *   1. exact process-name match (-x) — native CLIs (codex, opencode, droid)
 *      and, on darwin, wrappers that rename argv[0] (BSD pgrep matches the
 *      argv[0] basename, verified against cursor-agent's `exec -a` wrapper);
 *   2. an anchored full-argv pattern (-f "(^|/)<binary>($| )") — linux pgrep
 *      -x matches /proc comm, which stays "node" for interpreter-run CLIs
 *      (cursor-agent execs node with a renamed argv[0]; npm launchers spawn
 *      platform-suffixed native binaries), so the argv[0] path is the only
 *      cross-platform spelling of "this is cursor-agent". The anchor keeps
 *      "notes-cursor-agent.md" style substrings from matching.
 * -a rides along on darwin for the same BSD ancestor rule claudePgrepArgs
 * documents (an agent that LAUNCHED tracequest must not hide from pgrep).
 */
export function agentPgrepInvocations(binary, platform = process.platform) {
  const ancestors = platform === "darwin" ? ["-a"] : [];
  const escaped = binary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    [...ancestors, "-x", binary],
    [...ancestors, "-f", `(^|/)${escaped}($| )`],
  ];
}

/**
 * True when some probe in the current detection pass could not answer.
 *
 * A pgrep that times out exits with a null status and no stdout, which reads
 * exactly like "no such process". Treating the two the same made every running
 * agent vanish from the dashboard whenever the machine was busy enough for a
 * 2s-capped probe to miss its deadline — and reappear on the next poll (fact
 * 3w6). Detection records the difference instead of flattening it.
 */
let _probeDegraded = false;

/** Live paths from the last pass in which every probe actually answered. */
let _lastGoodLive = [];

/** Probe could not answer; the pass it belongs to must not be read as a negative. */
function markProbeDegraded() {
  _probeDegraded = true;
}

/** Tests: whether the most recent detection pass ran with a failed probe. */
export function liveProbeDegradedForTests() {
  return _probeDegraded;
}

/** Pids matched by one pgrep invocation ([] on no match; degraded on failure). */
function pgrepPids(args, spawn, logLabel) {
  try {
    const result = spawn("pgrep", args, { encoding: "utf-8", timeout: 2000 });
    // status 1 is pgrep's honest "matched nothing". A null status means the
    // probe was killed (timeout) or never ran — inconclusive, not negative.
    if (result?.error || result?.status === null || result?.status === undefined) {
      markProbeDegraded();
      return [];
    }
    if (result.status !== 0 || !result.stdout) return [];
    const pids = [];
    forEachJsonlLine(result.stdout, (line) => {
      const pid = line.trim();
      if (pid) pids.push(pid);
    });
    return pids;
  } catch (err) {
    console.error(`${logLabel}: pgrep failed:`, err.message);
    markProbeDegraded();
    return [];
  }
}

/** Newest cursor main recording for a cwd: <slug>/agent-transcripts/<uuid>/<uuid>.jsonl. */
function cursorSessionForCwd(cwd, home) {
  const readdir = _findLiveClaudeDeps?.readdirSync ?? readdirSync;
  const stat = _findLiveClaudeDeps?.statSync ?? statSync;
  const transcriptsDir = cursorTranscriptsDir(home, cwd);
  let newest = null;
  let newestMtime = 0;
  let names;
  try {
    names = readdir(transcriptsDir);
  } catch (err) {
    if (!isIndexDiskExpectedErr(err)) {
      console.error(`findLiveAgentSessions: failed to read ${transcriptsDir}:`, err.message);
    }
    return null;
  }
  for (const uuid of names) {
    const mainPath = cursorMainRecording(transcriptsDir, uuid);
    try {
      const mt = stat(mainPath).mtime.getTime();
      if (mt > newestMtime) { newestMtime = mt; newest = mainPath; }
    } catch (err) {
      if (!isIndexDiskExpectedErr(err) && !isProcRaceErr(err)) {
        console.error(`findLiveAgentSessions: stat failed for ${mainPath}:`, err.message);
      }
    }
  }
  return newest;
}

/** Newest factory recording for a cwd: ~/.factory/sessions/ws<slug>/*.jsonl. */
function factorySessionForCwd(cwd, home) {
  return newestJsonlInDir(factoryWorkspaceDir(home, cwd), "findLiveAgentSessions");
}

/**
 * Newest discovered codex session whose first-line session_meta cwd EQUALS
 * the probed cwd. Candidates are prefiltered by the lossy project label so
 * the exact-cwd confirmation (a bounded number of first-line reads) only
 * touches plausible files; mtime-descending order makes the running
 * session's recording win.
 */
function codexSessionForCwd(cwd, sessions) {
  const label = normalizeProjectFolder(cwd);
  const candidates = sessions
    .filter((s) => s?.source === "codex" && !s.parentSession && (!s.project || s.project === label))
    .sort((a, b) => sessionMtimeMs(b) - sessionMtimeMs(a));
  let reads = 0;
  for (const s of candidates) {
    if (reads++ >= CODEX_CWD_READS_MAX) break;
    if (codexSessionMetaCwd(s.path) === cwd) return s.path;
  }
  return null;
}

/** Newest discovered opencode:// session whose project label matches the cwd. */
function openCodeSessionForCwd(cwd, sessions) {
  const label = shortenProjectPath(cwd) || "opencode";
  let best = null;
  for (const s of sessions) {
    if (s?.source !== "opencode" || s.project !== label) continue;
    if (!best || sessionMtimeMs(s) > sessionMtimeMs(best)) best = s;
  }
  return best?.path ?? null;
}

/** (source, cwd) → that agent's newest recording for the cwd (null when none). */
function agentSessionForCwd(source, cwd, home, sessions) {
  switch (source) {
    case "codex": return codexSessionForCwd(cwd, sessions);
    case "cursor": return cursorSessionForCwd(cwd, home);
    case "factory": return factorySessionForCwd(cwd, home);
    case "opencode": return openCodeSessionForCwd(cwd, sessions);
    default: return null;
  }
}

/**
 * Per-agent PROCESS detection for every external CLI beyond claude/grok:
 * pgrep per binary (exact name + anchored argv pattern), then ONE batched
 * procCwds probe over every matched pid, then each deduped (source, cwd)
 * pair resolves to that agent's newest recording by the source's own
 * storage layout. A process whose cwd has no recording contributes nothing;
 * every failure degrades to an empty contribution, never a throw.
 */
export function findLiveAgentSessions(sessions = []) {
  const home = homeDir();
  const spawn = _findLiveClaudeDeps?.spawnSync ?? spawnSync;
  const platform = _findLiveClaudeDeps?.platform ?? process.platform;

  /** @type {Map<string, Set<string>>} pid → sources whose patterns matched it */
  const pidSources = new Map();
  for (const spec of EXTERNAL_AGENT_PROCESS_SPECS) {
    for (const args of agentPgrepInvocations(spec.binary, platform)) {
      for (const pid of pgrepPids(args, spawn, "findLiveAgentSessions")) {
        let set = pidSources.get(pid);
        if (!set) { set = new Set(); pidSources.set(pid, set); }
        set.add(spec.source);
      }
    }
  }
  if (!pidSources.size) return [];

  const cwds = procCwds([...pidSources.keys()], _findLiveClaudeDeps ?? undefined);
  const live = [];
  const seenPairs = new Set();
  const found = new Set();
  for (const [pid, sources] of pidSources) {
    const cwd = cwds.get(pid);
    if (!cwd) continue;
    for (const source of sources) {
      const pair = `${source} ${cwd}`;
      if (seenPairs.has(pair)) continue;
      seenPairs.add(pair);
      const path = agentSessionForCwd(source, cwd, home, sessions);
      if (path && recordingIsGenerating(source, path, { home }) && !found.has(path)) {
        found.add(path);
        live.push(path);
      }
    }
  }
  return live;
}

export function findLiveByOpenFd(sessionPaths) {
  const unique = [...new Set(sessionPaths)];
  if (!unique.length) return [];
  return openPathsAmong(unique);
}

/** Set view of a detectLiveSessions snapshot (array or Set). */
export function livePathSet(livePaths) {
  return livePaths instanceof Set ? livePaths : new Set(livePaths || []);
}

/** True when `path` is a member of the detectLiveSessions snapshot. */
export function pathIsLive(path, livePaths) {
  if (!path) return false;
  return livePathSet(livePaths).has(path);
}

/**
 * Stamp the one live bit on an API/CLI/dashboard object from the same
 * detectLiveSessions snapshot every surface reads. Chat-page QUIET_MS
 * growth chrome is not this bit.
 */
export function stampLive(obj, livePaths) {
  if (obj) obj.live = pathIsLive(obj.path, livePaths);
  return obj;
}

export function detectLiveSessions(sessions) {
  const now = Date.now();
  if (_liveCache !== null && now - _liveCacheTime < 5000) return _liveCache;

  _probeDegraded = false;
  const live = new Set();

  // Four detection families, one union. Each process-backed family still
  // requires a generating turn (idle-open TUIs are not live). Open-fd hits
  // are extra mid-write recall only when the recording is still generating.
  // cursor-cloud is deliberately absent: no local process exists for a
  // cloud agent, so its imported recordings are never reported live.
  for (const p of findLiveGrok()) live.add(p);
  for (const p of findLiveClaude()) live.add(p);
  for (const p of findLiveAgentSessions(sessions)) live.add(p);

  // Open-fd probing stays as extra recall for an agent caught mid-write,
  // but only when that recording is still generating. A completed idle
  // jsonl that is merely held open (idle-open TUI) is not live.
  const fdCandidates = [];
  for (const s of sessions) {
    if (now - sessionMtimeMs(s) > 120_000) continue;
    if (s.source === "codex" || s.source === "cursor" || s.source === "factory") fdCandidates.push(s);
  }
  if (fdCandidates.length) {
    const open = new Set(findLiveByOpenFd(fdCandidates.map((s) => s.path)));
    for (const s of fdCandidates) {
      if (open.has(s.path) && recordingIsGenerating(s.source, s.path)) live.add(s.path);
    }
  }

  if (_probeDegraded) {
    // Inconclusive pass: rather than reporting a confident empty set, keep what
    // the last clean pass saw — but only the paths whose RECORDING still reads
    // as generating. That is a file read, not a process probe, so it stays
    // available exactly when the process probes are the thing failing, and it
    // keeps a finished session from being carried forward indefinitely.
    const sourceByPath = new Map();
    for (const s of sessions ?? []) if (s?.path) sourceByPath.set(s.path, s.source);
    for (const p of _lastGoodLive) {
      if (live.has(p)) continue;
      if (!recordingStillExists(p)) continue;
      if (carriedRecordingStillGenerating(p, sourceByPath.get(p))) live.add(p);
    }
    _liveCache = [...live];
  } else {
    _liveCache = [...live];
    _lastGoodLive = _liveCache;
  }
  _liveCacheTime = now;
  return _liveCache;
}

/**
 * Whether a path carried across a degraded pass is still mid-turn. Any failure
 * here is treated as "still generating": the point of the carry-forward is to
 * avoid asserting a negative from a probe that could not answer.
 */
function carriedRecordingStillGenerating(path, source) {
  const src = source || sourceForCarriedPath(path);
  if (!src) return true;
  try {
    return recordingIsGenerating(src, path, { home: homeDir() }) !== false;
  } catch {
    return true;
  }
}

/** Best-effort source for a carried path when the session list no longer has it. */
function sourceForCarriedPath(path) {
  if (typeof path !== "string") return null;
  if (path.startsWith("opencode://")) return "opencode";
  if (path.includes("/.codex/")) return "codex";
  if (path.includes("/.grok/")) return "grok";
  if (path.includes("/.factory/")) return "factory";
  if (path.includes("/.cursor/")) return "cursor";
  if (path.includes("/.claude/")) return "claude";
  return null;
}

/**
 * Whether a carried-forward live path still has a recording behind it. Keeps a
 * degraded pass from resurrecting a session that was deleted in the meantime.
 * OpenCode's virtual paths have no file, so they carry forward on the db itself.
 */
function recordingStillExists(path) {
  if (typeof path !== "string") return false;
  if (path.startsWith("opencode://")) return true;
  const stat = _findLiveClaudeDeps?.statSync ?? statSync;
  try {
    stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Milliseconds timestamp of the current live-session memo (0 when cold). Used for API body cache keys. */
export function liveSessionsCacheTime() {
  return _liveCacheTime;
}

/**
 * Tests: expire the 5s memo the way the passage of time does, WITHOUT forgetting
 * the last clean probe result. clearLiveSessionsCache() is the full reset.
 */
export function expireLiveMemoForTests() {
  _liveCache = null;
  _liveCacheTime = 0;
}

/** Reset 5s live-session cache (tests only). */
export function clearLiveSessionsCache() {
  _liveCache = null;
  _liveCacheTime = 0;
  _lastGoodLive = [];
  _probeDegraded = false;
}
