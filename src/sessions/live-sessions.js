import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { forEachJsonlLine } from "../parse/jsonl-read.js";
import { sessionMtimeMs } from "./session-list.js";
import { isIndexDiskExpectedErr, isProcRaceErr } from "../utils/fs-expected-err.js";
import { procCwds, procCwdsAsync, openPathsAmong, openPathsAmongAsync, spawnText } from "./proc-probe.js";
import { codexSessionMetaCwd } from "../parse/parse-codex.js";
import { readFxSessionMeta } from "../parse/parse-fx.js";
import { readDshSessionRow } from "../parse/parse-dsh.js";
import { normalizeProjectFolder, shortenProjectPath } from "../server/server-session-path.js";
import {
  claudeProjectDir,
  cursorMainRecording,
  cursorTranscriptsDir,
  factoryWorkspaceDir,
  grokSessionDir,
  GROK_FAMILY,
  grokFamilySourceForPath,
} from "./session-layout.js";
import { recordingIsGenerating } from "./live-session-generating.js";
import { isImportedHostSession } from "./session-discovery-paths.js";
import { claudeSubagentsDirFromSessionPath, listClaudeSubagentJsonlFiles } from "./claude-subagents.js";

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

/**
 * The well-formed entries of ~/.grok/active_sessions.json (or ~/.vktr/... for
 * source "vktr"; [] when absent or unreadable).
 */
function grokActiveEntries(home, member = GROK_FAMILY[0]) {
  let entries;
  try {
    entries = JSON.parse(readFileSync(join(home, member.homeDir, "active_sessions.json"), "utf-8"));
  } catch (err) {
    if (!isIndexDiskExpectedErr(err)) console.error("findLiveGrok: failed to read active_sessions.json:", err.message);
    return [];
  }
  if (!Array.isArray(entries)) return [];
  return entries.filter((e) => e && e.session_id && e.cwd && e.pid);
}

/**
 * @typedef {object} ProbeFacts What one detection pass learned from its
 *   process probes, gathered concurrently by detectLiveSessionsAsync (fact hlv3).
 * @property {Map<string, { status: number | null, stdout: string, error?: Error }>} pgrep
 *   each pgrep invocation's result, keyed by pgrepKey(args)
 * @property {Map<string, string>} cwds pid → cwd for every pid any family matched
 */

/** Every grok-family agent's active_sessions.json entries, each tagged with its member. */
function grokFamilyActiveEntries(home) {
  const out = [];
  for (const member of GROK_FAMILY) {
    for (const entry of grokActiveEntries(home, member)) out.push({ member, entry });
  }
  return out;
}

/**
 * Live grok-family sessions (grok and vktr): each agent's active_sessions.json
 * names candidate pids, live needs the pid's cwd to match and a generating turn.
 * @param {ProbeFacts | null} [facts]
 */
export function findLiveGrok(facts = null) {
  const home = homeDir();
  const live = [];
  const valid = grokFamilyActiveEntries(home);
  if (!valid.length) return live;
  const cwds = facts?.cwds ?? procCwds(valid.map(({ entry }) => entry.pid), _findLiveClaudeDeps ?? undefined);

  for (const { member, entry } of valid) {
    const procCwd = cwds.get(String(entry.pid));
    if (!procCwd || !grokProcCwdMatches(entry.cwd, procCwd)) continue;
    const dir = grokSessionDir(home, entry.cwd, entry.session_id, member.id);
    if (recordingIsGenerating(member.id, dir)) live.push(dir);
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

/** True when `path` is a directory (the injected statSync in tests). */
function isDirForLiveProbe(path) {
  const stat = _findLiveClaudeDeps?.statSync ?? statSync;
  try {
    return stat(path).isDirectory();
  } catch {
    return false;
  }
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

/** One line per pid, as pgrep prints them. */
function pidsFromStdout(stdout) {
  const pids = [];
  forEachJsonlLine(stdout, (line) => {
    const pid = line.trim();
    if (pid) pids.push(pid);
  });
  return pids;
}

/** Key of one pgrep invocation in ProbeFacts.pgrep. */
function pgrepKey(args) {
  return args.join("\0");
}

/** One pgrep invocation's result: from the pass's gathered facts, else run now. */
function runPgrep(args, facts) {
  const gathered = facts?.pgrep.get(pgrepKey(args));
  if (gathered) return gathered;
  const spawn = _findLiveClaudeDeps?.spawnSync ?? spawnSync;
  return spawn("pgrep", args, { encoding: "utf-8", timeout: 2000 });
}

/** @param {ProbeFacts | null} [facts] */
export function findLiveClaude(facts = null) {
  const home = homeDir();
  const live = [];

  let pids;
  try {
    const result = runPgrep(claudePgrepArgs(_findLiveClaudeDeps?.platform), facts);
    if (result.status !== 0 || !result.stdout) return live;
    pids = pidsFromStdout(result.stdout);
  } catch (err) {
    console.error("findLiveClaude: pgrep failed:", err.message);
    return live;
  }
  if (!pids.length) return live;

  const cwds = facts?.cwds ?? procCwds(pids, _findLiveClaudeDeps ?? undefined);
  /** @type {Map<string, string | null>} projDir → newest session (null = scanned, none found) */
  const projDirCache = new Map();
  /** Parents whose subagents/ dir this pass already checked. */
  const subagentParents = new Set();
  for (const pid of pids) {
    const cwd = cwds.get(pid);
    if (!cwd) continue;
    const projDir = claudeProjectDir(home, cwd, isDirForLiveProbe);
    let newest;
    if (projDirCache.has(projDir)) {
      newest = projDirCache.get(projDir);
    } else {
      newest = newestClaudeJsonlInProjDir(projDir);
      projDirCache.set(projDir, newest);
    }
    if (!newest) continue;
    if (recordingIsGenerating("claude", newest, { home, pid })) live.push(newest);
    if (!subagentParents.has(newest)) {
      subagentParents.add(newest);
      for (const child of generatingClaudeSubagents(newest)) live.push(child);
    }
  }
  return live;
}

/** True when Claude Code recorded that the user stopped this subagent (<name>.meta.json). */
function claudeSubagentStopped(childPath) {
  try {
    const meta = JSON.parse(readFileSync(childPath.replace(/\.jsonl$/, ".meta.json"), "utf-8"));
    return meta?.stoppedByUser === true;
  } catch {
    return false;
  }
}

/**
 * Subagent transcripts (<parent>/subagents/agent-*.jsonl) the same claude
 * process is writing. Each child is classified from its OWN transcript: the
 * pid's sidecar status describes the parent's turn, never a child's, and a
 * background child keeps running after its parent's turn has ended.
 */
function generatingClaudeSubagents(parentPath) {
  const out = [];
  let children;
  try {
    children = listClaudeSubagentJsonlFiles(claudeSubagentsDirFromSessionPath(parentPath), { logLabel: "findLiveClaude" });
  } catch {
    return out;
  }
  for (const { path } of children) {
    if (recordingIsGenerating("claude", path) && !claudeSubagentStopped(path)) out.push(path);
  }
  return out;
}

/**
 * External agents detected by PROCESS, not open fd. None of these CLIs hold
 * their recording open between writes (the same append/close pattern the
 * real claude CLI follows — the reason findLiveClaude is pgrep-based), so
 * open-fd probing alone can never see them. Process presence in a cwd that
 * has a recording is a candidate only: live additionally requires that
 * recording to show a generating or tool-executing turn. Binary names
 * mirror the launch registry (src/agents/agent-detect.js SOURCE_AGENTS).
 * grok and vktr are absent (active_sessions.json is a better candidate signal — findLiveGrok);
 * cursor-cloud is absent DELIBERATELY: a cloud agent has no local process
 * to probe, and reporting an imported recording as RUNNING from mere import
 * freshness would be a lie, so cursor-cloud sessions are never live.
 */
const EXTERNAL_AGENT_PROCESS_SPECS = [
  { source: "codex", binary: "codex" },
  { source: "cursor", binary: "cursor-agent" },
  { source: "factory", binary: "droid" },
  { source: "opencode", binary: "opencode" },
  { source: "fx", binary: "fx" },
  { source: "dsh", binary: "dsh" },
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
function pgrepPids(args, facts, logLabel) {
  try {
    const result = runPgrep(args, facts);
    // status 1 is pgrep's honest "matched nothing". A null status means the
    // probe was killed (timeout) or never ran — inconclusive, not negative.
    if (result?.error || result?.status === null || result?.status === undefined) {
      markProbeDegraded();
      return [];
    }
    if (result.status !== 0 || !result.stdout) return [];
    return pidsFromStdout(result.stdout);
  } catch (err) {
    console.error(`${logLabel}: pgrep failed:`, err.message);
    markProbeDegraded();
    return [];
  }
}

/** Every pgrep invocation one detection pass makes (claude's, then each external agent's). */
function passPgrepInvocations(platform) {
  const out = [claudePgrepArgs(platform)];
  for (const spec of EXTERNAL_AGENT_PROCESS_SPECS) out.push(...agentPgrepInvocations(spec.binary, platform));
  return out;
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

/** A path with symlinks resolved (macOS /tmp → /private/tmp), or itself when unresolvable. */
function realPathOr(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** The cwd an fx or dsh recording names: fx session.json workspace_root, dsh's session row. */
function recordedCwd(source, path) {
  if (source === "fx") return readFxSessionMeta(path).workspace_root || null;
  return readDshSessionRow(path).cwd || null;
}

/**
 * Newest discovered fx or dsh session whose recorded cwd is the probed cwd
 * (compared with symlinks resolved: dsh records ACP cwds unresolved). The
 * project label prefilters; a bounded number of reads confirm the cwd.
 */
function recordedCwdSessionForCwd(source, cwd, sessions) {
  const want = realPathOr(cwd);
  const labels = new Set([normalizeProjectFolder(cwd), normalizeProjectFolder(want)]);
  const candidates = sessions
    .filter((s) => s?.source === source && !s.parentSession && !isImportedHostSession(s.path))
    .sort((a, b) => sessionMtimeMs(b) - sessionMtimeMs(a));
  let reads = 0;
  for (const s of candidates) {
    if (s.project && !labels.has(s.project)) continue;
    if (reads++ >= CODEX_CWD_READS_MAX) break;
    const recorded = recordedCwd(source, s.path);
    if (recorded && (recorded === cwd || realPathOr(recorded) === want)) return s.path;
  }
  return null;
}

/** (source, cwd) → that agent's newest recording for the cwd (null when none). */
function agentSessionForCwd(source, cwd, home, sessions) {
  switch (source) {
    case "codex": return codexSessionForCwd(cwd, sessions);
    case "cursor": return cursorSessionForCwd(cwd, home);
    case "factory": return factorySessionForCwd(cwd, home);
    case "opencode": return openCodeSessionForCwd(cwd, sessions);
    case "fx":
    case "dsh": return recordedCwdSessionForCwd(source, cwd, sessions);
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
/**
 * @param {Array<object>} [sessions]
 * @param {ProbeFacts | null} [facts]
 */
export function findLiveAgentSessions(sessions = [], facts = null) {
  const home = homeDir();
  const platform = _findLiveClaudeDeps?.platform ?? process.platform;

  /** @type {Map<string, Set<string>>} pid → sources whose patterns matched it */
  const pidSources = new Map();
  for (const spec of EXTERNAL_AGENT_PROCESS_SPECS) {
    for (const args of agentPgrepInvocations(spec.binary, platform)) {
      for (const pid of pgrepPids(args, facts, "findLiveAgentSessions")) {
        let set = pidSources.get(pid);
        if (!set) { set = new Set(); pidSources.set(pid, set); }
        set.add(spec.source);
      }
    }
  }
  if (!pidSources.size) return [];

  const cwds = facts?.cwds ?? procCwds([...pidSources.keys()], _findLiveClaudeDeps ?? undefined);
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

/**
 * Open-fd probing is extra recall for an agent caught mid-write: a recent
 * codex/cursor/factory recording some process holds open is live when that
 * recording is still generating (a completed jsonl merely held open by an
 * idle-open TUI is not). So the probe asks only about the recordings it could
 * change (fact hlv4): not already live, generating, and local — a recording
 * copied from another machine is never generating on this one.
 * @returns {string[]} paths, in session order
 */
function openFdPending(sessions, now, live) {
  const out = [];
  for (const s of sessions) {
    if (now - sessionMtimeMs(s) > 120_000) continue;
    if (s.source !== "codex" && s.source !== "cursor" && s.source !== "factory") continue;
    if (live.has(s.path) || isImportedHostSession(s.path)) continue;
    if (recordingIsGenerating(s.source, s.path)) out.push(s.path);
  }
  return out;
}

export function detectLiveSessions(sessions) {
  const now = Date.now();
  if (_liveCache !== null && now - _liveCacheTime < 5000) return _liveCache;
  return detectionPass(sessions, now);
}

/** One synchronous detection pass, installed as the memo. */
function detectionPass(sessions, now) {
  const live = processFamiliesLive(sessions, null);
  const pending = openFdPending(sessions, now, live);
  if (pending.length) for (const p of findLiveByOpenFd(pending)) live.add(p);
  return finishPass(live, sessions, now);
}

/**
 * One detection pass (fact hlv3) with its process probes run concurrently
 * instead of one after another: the exact-name pgreps start at once, then
 * the cwd lookup for the pids they match runs alongside the full-argv
 * pgreps (a second lookup only for a pid an argv scan alone matched). The
 * pass then reads those answers exactly as detectLiveSessions reads its own
 * synchronous probes, so the live set is the same; it costs about two pgreps
 * and one cwd lookup, not the sum of all. Always probes (no memo check) and
 * installs the result as the memo, like a synchronous pass. Probe doubles
 * injected by tests answer synchronously, so it delegates.
 */
export async function detectLiveSessionsAsync(sessions) {
  const now = Date.now();
  if (liveProbeDepsInjected()) return detectionPass(sessions, now);
  const pgrep = new Map();
  const run = (args) => spawnText("pgrep", args, { timeout: 2000 }).then((result) => {
    pgrep.set(pgrepKey(args), result);
    return result.status === 0 && result.stdout ? pidsFromStdout(result.stdout) : [];
  });
  const invocations = passPgrepInvocations(process.platform);
  // The exact-name matches run first (about half the time a full-argv scan
  // takes); the cwd lookup for their pids then runs while the argv scans do,
  // and a second lookup covers only pids that an argv scan alone matched.
  const byName = invocations.filter((args) => !args.includes("-f")).map(run);
  const named = new Set(grokFamilyActiveEntries(homeDir()).map(({ entry }) => String(entry.pid)));
  for (const pids of await Promise.all(byName)) for (const pid of pids) named.add(pid);
  const namedCwds = procCwdsAsync(named);
  const byArgv = invocations.filter((args) => args.includes("-f")).map(run);
  const extra = new Set();
  for (const pids of await Promise.all(byArgv)) for (const pid of pids) if (!named.has(pid)) extra.add(pid);
  const [cwds, extraCwds] = await Promise.all([namedCwds, procCwdsAsync(extra)]);
  for (const [pid, cwd] of extraCwds) cwds.set(pid, cwd);
  const live = processFamiliesLive(sessions, { pgrep, cwds });
  const pending = openFdPending(sessions, now, live);
  if (pending.length) for (const p of await openPathsAmongAsync(pending)) live.add(p);
  return finishPass(live, sessions, now);
}

/**
 * The process-backed families of one pass (resets the pass's degraded flag).
 * @param {ProbeFacts | null} facts
 * @returns {Set<string>}
 */
function processFamiliesLive(sessions, facts) {
  _probeDegraded = false;
  const live = new Set();

  // Four detection families, one union (the open-fd family follows the
  // process-backed ones, openFdPending). Each process-backed family still
  // requires a generating turn (idle-open TUIs are not live).
  // cursor-cloud is deliberately absent: no local process exists for a
  // cloud agent, so its imported recordings are never reported live.
  for (const p of findLiveGrok(facts)) live.add(p);
  for (const p of findLiveClaude(facts)) live.add(p);
  for (const p of findLiveAgentSessions(sessions, facts)) live.add(p);
  return live;
}

/** Degraded-pass carry-forward, then install the pass as the memo. */
function finishPass(live, sessions, now) {
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
  const grokFamily = grokFamilySourceForPath(path);
  if (grokFamily) return grokFamily;
  if (path.includes("/.factory/")) return "factory";
  if (path.includes("/.cursor/")) return "cursor";
  if (path.includes("/.claude/")) return "claude";
  if (path.includes("/.fx/sessions/")) return "fx";
  if (path.includes("/.dsh/sessions/")) return "dsh";
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

/** True when tests injected probe doubles (detection must then run on this thread). */
export function liveProbeDepsInjected() {
  return _findLiveClaudeDeps !== null;
}

/** True while the 5s live-session memo still answers detectLiveSessions. */
export function liveSessionsMemoFresh(now = Date.now()) {
  return _liveCache !== null && now - _liveCacheTime < 5000;
}

/**
 * Install a detection pass computed off the main thread (fact hlv1) as the
 * memo, timed from when that pass started, so the next detectLiveSessions
 * call answers from it instead of probing synchronously.
 */
export function installLiveSessionsSnapshot(livePaths, startedAt) {
  _liveCache = [...livePaths];
  _liveCacheTime = startedAt;
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
