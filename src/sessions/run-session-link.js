/**
 * Run ↔ session-file linking — connects a Run (a tmux window created via
 * POST /api/runs) to the session recording its agent process writes under
 * the agent's own data dir, so serve can present the run as a live,
 * chat-shaped unified Session instead of a TTY capture.
 *
 * Attribution is identity-first, heuristics last:
 *   0. spawn identity — a run launched with a tracequest-generated session
 *      UUID (claude/grok --session-id, persisted as @tq_session_id) has a
 *      DETERMINED recording path before the first byte is written: the
 *      agent names its recording after the uuid (<uuid>.jsonl, resp. the
 *      <uuid>/ session dir). Such a run links exactly that path the moment
 *      it exists and NOTHING ELSE ever — no fd evidence needed (the real
 *      claude CLI appends open/write/close and never holds its recording
 *      open), no heuristics allowed, pending until its own recording
 *      appears. Persisted as attr "sid", sticky forever.
 *   1. candidates — for runs WITHOUT spawn identity: session files under
 *      the launched agent's session root, IN THE AGENT'S REAL ON-DISK
 *      LAYOUT (src/sessions/session-layout.js — the same helpers discovery
 *      uses, so the two halves of tracequest can never disagree about
 *      where an agent's recordings live), whose CREATION time (birthtime,
 *      mtime fallback) is at/after the run's tq_started (a fresh run
 *      always creates a fresh recording; the user's own long-running
 *      session in the same cwd predates the run and is filtered out).
 *      Both the literal tq_cwd and its realpath slug spellings are tried
 *      (macOS /tmp → /private/tmp). Paths determined for spawn-identified
 *      runs are excluded — a fallback run can never steal an identified
 *      run's recording, even before that recording exists.
 *   2. pid identity — every run window's pane pid roots a process tree
 *      (descendantPids); a candidate held open by a pid inside THIS run's
 *      tree is pid-CONFIRMED ours, one held open by a RIVAL run's tree is
 *      foreign and can never be linked here. Only pid-confirmed links are
 *      persisted as identity (attr "pid") and stay sticky forever.
 *   2.5 prompt corroboration — content identity for runs without spawn or
 *      fd evidence: every launched-with-a-prompt run persists its prompt
 *      (@tq_prompt), and a recording embeds its first user message. A
 *      candidate whose first user message matches a DIFFERENT run's prompt
 *      (live, exited, or tombstoned) is FOREIGN here — killing that rival
 *      can never launder its transcript into this run. A candidate that
 *      matches THIS run's prompt and nobody else's is CORROBORATED and may
 *      link even while contested (attr "prompt") — two prompted runs in
 *      one cwd disambiguate while both live. A rival whose prompt provably
 *      MISMATCHES the recording's first user message cannot own it, so its
 *      contest is lifted.
 *   3. heuristics — a candidate no process tree vouches for may still link,
 *      but ONLY while it is the SOLE eligible candidate (no rival run could
 *      equally claim it, and no SECOND eligible recording exists — two
 *      unvouched files born after the run start are indistinguishable, so
 *      birth order selects nothing; a rival is another run window of the
 *      same agent competing for the same candidate space whose birth gate
 *      also admits the file; spawn-identified runs never compete — their
 *      claim is settled by construction). Such a heuristic link is
 *      persisted as a GUESS (attr "heur") only after it has served its
 *      PROBATION (GUESS_PROBATION_MS of the run's own lifetime — the
 *      round-7 rule that keeps a foreign file from being served during the
 *      seconds before the run's own recording lands, and keeps a run that
 *      died before writing anything from finalizing one at all). It is
 *      re-validated on every poll
 *      while the run lives — it is dropped the moment the file turns out
 *      foreign, claimed, or contested, and DEMOTED to pending the moment a
 *      second eligible candidate appears (the r5 fix: the equal-prompt rule
 *      applied to the guess tier — prefer pending over wrong).
 *
 * EXIT boundary: the first poll that observes a run's death stamps
 * tq_ended (detection time — at/after the real death, so the window only
 * widens: pending beats wrong). A dead process writes nothing, so a dead
 * run's candidate space is bounded by [started-slack, ended+slack]: a
 * guess that was UNIQUE for the whole live window AND matured there (born
 * at least GUESS_PROBATION_MS before the exit) stays the final answer
 * forever — a candidate born after the exit can neither link
 * nor demote it — while a guess that was AMBIGUOUS at death (a second
 * eligible candidate born before the boundary) is never finalized: it is
 * demoted to pending on the first poll that sees the ambiguity, dead or
 * alive.
 *
 * RESUMED runs (tq_resumed_from) never link by bare birth-time guessing
 * at all — their recording is, by construction, either a FORK opening
 * with the source conversation or the SOURCE recording itself, so an
 * unrelated fresh file can never honestly be theirs. They link through:
 * (a) content identity against tq_fork_prompt — the SOURCE session's
 *     first user message, persisted at resume time — which recognizes a
 *     fork recording (attr "prompt" when unique, equal-prompt collision
 *     rules apply: two forks of one source stay pending); and
 * (b) the SOURCE fallback — tq_resumed_path whose freshness file moved
 *     at/after the run start (within the run's lifetime for dead runs)
 *     links as a guess (attr "heur"): serving the source conversation for
 *     a run that continues exactly that session can never be the wrong
 *     transcript.
 *
 * Dismissed runs leave TOMBSTONES: POST /api/runs/kill records the dying
 * run's attribution facts (agent, cwd, started, prompt, claimed path) in
 * the tq_tombstones SESSION-level tmux option BEFORE the window dies, so a
 * run's claim on its recording outlives its window and survives serve
 * restarts. A tombstone's claimed path stays excluded forever, and the
 * tombstone keeps contesting candidates born within its lifetime
 * [started-slack, killed+slack] — killing a contested rival can never
 * promote its recording into the survivor's chat.
 *
 * Tombstone RETENTION is by relevance, never recency: compactTombstones
 * drops only stones that provably cannot change any still-unsettled run's
 * attribution, merges same-space claimless stones, and folds overflow into
 * COARSE per-space stones (interval-only, prompt unknown) that contest
 * everything in their window and DEGRADE prompt corroboration there —
 * a unique match for a live run's prompt still serves, but only as a
 * re-validated guess (attr "heur"), never as settled content identity —
 * so a flood of routine dismissals can never evict the one stone keeping
 * an older contest honest, and can never sentence an honest run's
 * uniquely-corroborable recording to pending-forever either.
 *
 * Windows that vanish WITHOUT passing through the kill API (tmux
 * kill-window, prefix-&, kill-session) still leave tombstones: every poll
 * syncRunLedger persists a ledger of live run windows (tq_run_ledger
 * session option) and diffs it against the actual window list — a ledger
 * entry whose window is gone and untombstoned gets a SYNTHESIZED tombstone
 * carrying its last-known claim and lifetime.
 *
 * The persisted @tq_session/@tq_session_attr pair lives in tmux window
 * user options so links survive tracequest serve restarts — tmux stays
 * the only run table.
 */
import { readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { descendantPids, openPathHolders } from "./proc-probe.js";
import { available, getSessionOption, setSessionOption, setWindowOption } from "../mux/tmux.js";
import { isSessionPath } from "../server/server-session-path.js";
import { isIndexDiskExpectedErr, isProcRaceErr } from "../utils/fs-expected-err.js";
import { collapseWhitespace } from "../parse/parse-utils.js";
import { peekSession } from "./session-peek.js";
import { resolveOpenCodeDbPath } from "./session-discovery-paths.js";
import {
  GROK_CHAT_FILE,
  claudeProjectDir,
  codexSessionsRoot,
  cursorMainRecording,
  cursorTranscriptsDir,
  factorySessionsRoot,
  grokSessionDir,
  grokWorkspaceDir,
  isCodexRolloutFile,
} from "./session-layout.js";

// claudeProjectSlug is defined ONCE, in the shared layout module; re-exported
// here because attribution has always exposed it.
export { claudeProjectSlug } from "./session-layout.js";

/**
 * Clock slack for the creation-time gate. tq_started is recorded BEFORE the
 * agent command spawns, on the same host clock as the filesystem, so the
 * slack only absorbs sub-second timestamp truncation.
 */
export const CANDIDATE_SLACK_MS = 2000;

/**
 * Agents whose candidate space is scoped to the run cwd (project-slug or
 * URL-encoded cwd dirs). For the rest (codex/droid dated dirs) every run of
 * the same agent competes for the same recursive candidate space, so
 * rivalry ignores cwd.
 */
const CWD_SCOPED_AGENTS = new Set(["claude", "cursor-agent", "grok"]);

function pick(deps, name, fallback) {
  return deps?.[name] ?? fallback;
}

/** Creation time with mtime fallback when birthtime is missing or after mtime. */
function bornMsOf(st) {
  const birth = st.birthtimeMs;
  const mtime = st.mtimeMs;
  if (Number.isFinite(birth) && birth > 0 && birth <= mtime) return birth;
  return mtime;
}

function quietStat(path, deps) {
  const stat = pick(deps, "statSync", statSync);
  try {
    return stat(path);
  } catch (err) {
    if (!isIndexDiskExpectedErr(err) && !isProcRaceErr(err)) {
      console.error(`run-session-link: stat failed for ${path}:`, err.message);
    }
    return null;
  }
}

function quietReaddir(dir, deps, withTypes = false) {
  const readdir = pick(deps, "readdirSync", readdirSync);
  try {
    return withTypes ? readdir(dir, { withFileTypes: true }) : readdir(dir);
  } catch (err) {
    if (!isIndexDiskExpectedErr(err) && !isProcRaceErr(err)) {
      console.error(`run-session-link: failed to read ${dir}:`, err.message);
    }
    return [];
  }
}

/** The literal cwd plus its realpath (deduped) — both slug spellings matter. */
function cwdSpellings(cwd, deps) {
  const realpath = pick(deps, "realpathSync", realpathSync);
  const spellings = [cwd];
  try {
    const real = realpath(cwd);
    if (real && real !== cwd) spellings.push(real);
  } catch {
    // cwd vanished — the literal spelling is all we have
  }
  return spellings;
}

/** Root-level .jsonl files of `dir` as candidates (optionally name-filtered). */
function jsonlCandidatesIn(dir, deps, out, seen, accept = null) {
  for (const f of quietReaddir(dir, deps)) {
    if (!f.endsWith(".jsonl")) continue;
    if (accept && !accept(f)) continue;
    const full = join(dir, f);
    if (seen.has(full)) continue;
    const st = quietStat(full, deps);
    if (!st || !st.isFile()) continue;
    seen.add(full);
    out.push({ path: full, bornMs: bornMsOf(st), probePath: full });
  }
}

/** Claude layout: <root>/<claudeProjectSlug(cwd)>/*.jsonl for each cwd spelling. */
function claudeCandidates(home, cwd, deps) {
  const out = [];
  const seen = new Set();
  for (const spelling of cwdSpellings(cwd, deps)) {
    jsonlCandidatesIn(claudeProjectDir(home, spelling), deps, out, seen);
  }
  return out;
}

/**
 * Cursor layout (the REAL one, shared with findCursorSessions):
 * <root>/<cursorProjectSlug(cwd)>/agent-transcripts/<uuid>/<uuid>.jsonl —
 * a DASHLESS project slug and one nested dir per session. Round 6 scanned
 * root-level *.jsonl under a leading-dash slug, a layout the CLI never
 * writes, so every real cursor-agent run had an empty candidate set and
 * pended forever; the layout now comes from session-layout.js, which
 * discovery reads too. Subagent transcripts (<uuid>/subagents/*.jsonl) are
 * deliberately NOT candidates: they are a session's children, never the
 * run's own recording.
 */
function cursorCandidates(home, cwd, deps) {
  const out = [];
  const seen = new Set();
  for (const spelling of cwdSpellings(cwd, deps)) {
    const transcriptsDir = cursorTranscriptsDir(home, spelling);
    for (const uuid of quietReaddir(transcriptsDir, deps)) {
      const full = cursorMainRecording(transcriptsDir, uuid);
      if (seen.has(full)) continue;
      const st = quietStat(full, deps);
      if (!st || !st.isFile()) continue;
      seen.add(full);
      out.push({ path: full, bornMs: bornMsOf(st), probePath: full });
    }
  }
  return out;
}

/**
 * Codex layout: rollout-*.jsonl inside the DATED tree sessions/YYYY/MM/DD.
 * The scan is recursive (a run's cwd is not in the path — codex records the
 * cwd inside the file's session_meta line, so every codex run of the host
 * competes for the same space) but only rollout-prefixed files count:
 * findCodexSessions indexes exactly those, and a candidate discovery would
 * never surface can never be served.
 */
function codexCandidates(home, deps) {
  const out = [];
  const seen = new Set();
  const walk = (dir, depth) => {
    jsonlCandidatesIn(dir, deps, out, seen, isCodexRolloutFile);
    if (depth >= 4) return;
    for (const entry of quietReaddir(dir, deps, true)) {
      if (entry.isDirectory?.()) walk(join(dir, entry.name), depth + 1);
    }
  };
  walk(codexSessionsRoot(home), 0);
  return out;
}

/**
 * Factory/droid layout: <root>/ws<slug>/*.jsonl — root-level recordings one
 * level below the sessions root, exactly what findFactorySessions indexes
 * (round 6 walked 3 levels deep and would have admitted files discovery
 * never surfaces). The scan covers EVERY workspace dir rather than the run
 * cwd's own ws<slug>: the cwd→workspace mapping is asserted by live
 * detection but unverified against a real droid install, and a cwd-scoped
 * scan that guessed the slug wrong would reproduce the very bug this round
 * fixes (empty candidate set → pending forever). A superset can only ever
 * cost precision, which the rivalry/contest tiers already handle.
 */
function factoryCandidates(home, deps) {
  const out = [];
  const seen = new Set();
  const root = factorySessionsRoot(home);
  for (const entry of quietReaddir(root, deps, true)) {
    if (!entry.isDirectory?.()) continue;
    jsonlCandidatesIn(join(root, entry.name), deps, out, seen);
  }
  return out;
}

/** Grok layout: <root>/<enc(cwd)>/<id>/chat_history.jsonl — the session path is the DIRECTORY. */
function grokCandidates(home, cwd, deps) {
  const out = [];
  const seen = new Set();
  for (const spelling of cwdSpellings(cwd, deps)) {
    const dir = grokWorkspaceDir(home, spelling);
    for (const sub of quietReaddir(dir, deps)) {
      const sessionDir = grokSessionDir(home, spelling, sub);
      if (seen.has(sessionDir)) continue;
      const chat = join(sessionDir, GROK_CHAT_FILE);
      const st = quietStat(chat, deps);
      if (!st || !st.isFile()) continue;
      seen.add(sessionDir);
      out.push({ path: sessionDir, bornMs: bornMsOf(st), probePath: chat });
    }
  }
  return out;
}

/**
 * Session-recording candidates for a run of `agent` in `cwd` under `home` —
 * every layout comes from the SHARED session-layout.js module discovery
 * uses, so an agent's recordings can never be visible to one half of
 * tracequest and invisible to the other.
 *
 * opencode answers [] deliberately, not by omission: its "recording" is a
 * set of rows in ONE shared SQLite file, which has no per-session birth
 * time and whose single fd is held by the opencode process for EVERY
 * session at once — birth-gating and pid-confirmation would both fire for
 * unrelated sessions. Such a run stays pending (a RESUMED opencode run
 * still links its source through the fact-clrs fallback). gemini writes no
 * followable recording at all.
 *
 * @returns {Array<{path: string, bornMs: number, probePath: string}>}
 */
export function runSessionCandidates({ agent, cwd, home = homedir() }, deps = {}) {
  switch (agent) {
    case "claude":
      return claudeCandidates(home, cwd, deps);
    case "cursor-agent":
      return cursorCandidates(home, cwd, deps);
    case "codex":
      return codexCandidates(home, deps);
    case "droid":
      return factoryCandidates(home, deps);
    case "grok":
      return grokCandidates(home, cwd, deps);
    default:
      return [];
  }
}

/**
 * The recording paths a spawn-identified run's agent WILL write, derived
 * purely from launch-time facts (agent, cwd, uuid) — deterministic before
 * the recording exists. One path per cwd spelling (literal + realpath).
 * Agents without a session-id launch flag answer [] (they can never carry
 * a tq_session_id, and a uuid without a known layout must not deadlock a
 * run into pending — it simply falls back to the probe/heuristic tiers).
 */
export function expectedSessionPaths({ agent, cwd, sessionId, home = homedir() }, deps = {}) {
  if (!sessionId || typeof cwd !== "string" || cwd.length === 0) return [];
  const out = new Set();
  switch (agent) {
    case "claude":
      for (const spelling of cwdSpellings(cwd, deps)) {
        out.add(join(claudeProjectDir(home, spelling), `${sessionId}.jsonl`));
      }
      break;
    case "grok":
      // The grok session path is the DIRECTORY named by the uuid; freshness
      // and probing go through chat_history.jsonl inside it.
      for (const spelling of cwdSpellings(cwd, deps)) {
        out.add(grokSessionDir(home, spelling, sessionId));
      }
      break;
    default:
      break;
  }
  return [...out];
}

/**
 * The one existing recording of a spawn-identified run, or null while the
 * agent has not written it yet. Existence of the freshness file (the .jsonl
 * itself, chat_history.jsonl for grok dirs) IS the whole test — the uuid was
 * generated for this run alone, so a file bearing it needs no further proof.
 */
export function spawnIdentitySessionPath(params, deps = {}) {
  for (const path of expectedSessionPaths(params, deps)) {
    const st = quietStat(sessionFreshnessPath(path), deps);
    if (st && st.isFile()) return path;
  }
  return null;
}

/**
 * Peek source per launchable agent — which recording dialect the agent's
 * session root holds, for extracting a candidate's first user message.
 * Agents without a followable recording never reach the prompt tier.
 */
const AGENT_PEEK_SOURCE = {
  claude: "claude",
  "cursor-agent": "cursor",
  codex: "codex",
  droid: "factory",
  grok: "grok",
};

/**
 * Does a recording's first user message corroborate a run's persisted
 * launch prompt? Both sides are whitespace-collapsed; a clipped @tq_prompt
 * (the launcher stores a single 140-char display line ending in "…")
 * matches by prefix, an unclipped one must match the first message EXACTLY
 * — near-miss "similarity" is not evidence. Empty on either side never
 * matches: a bare launch has no content identity to corroborate.
 */
export function promptCorroborates(recordingFirst, runPrompt) {
  const first = collapseWhitespace(String(recordingFirst ?? ""));
  const prompt = collapseWhitespace(String(runPrompt ?? ""));
  if (!first || !prompt) return false;
  const clipped = prompt.endsWith("…");
  const core = clipped ? prompt.slice(0, -1) : prompt;
  if (!core) return false;
  return clipped ? first.startsWith(core) : first === prompt;
}

/**
 * First-user-message memo: a recording's first user message never changes
 * once written, so a non-null answer is cached forever; a null answer (no
 * user line yet) is retried only when the file's mtime/size signature
 * moves. Bounded prefix read (forEachPartialJsonlLine) — never a full
 * parse of a grown recording.
 */
const _firstPromptMemo = new Map();
const FIRST_PROMPT_MEMO_MAX = 128;

/** Reset the first-user-message memo (tests only). */
export function clearFirstPromptMemo() {
  _firstPromptMemo.clear();
}

/**
 * The first user message of candidate recording `c` (as written by
 * `agent`'s dialect), or null while it has none / cannot be read. The
 * grok candidate path is the session DIRECTORY — peekGrok expects exactly
 * that; every other dialect peeks the .jsonl itself.
 */
function recordingFirstPrompt(c, agent, deps) {
  const source = AGENT_PEEK_SOURCE[agent];
  if (!source) return null;
  const st = quietStat(c.probePath, deps);
  if (!st) return null;
  const sig = `${st.mtimeMs}-${st.size}`;
  const hit = _firstPromptMemo.get(c.probePath);
  if (hit && (hit.value != null || hit.sig === sig)) return hit.value;
  const peek = pick(deps, "peekSession", peekSession);
  let value = null;
  try {
    value = peek({ path: c.path, size: null, source })?.firstPrompt ?? null;
    // Dialect tolerance: claude-family session roots have carried both
    // {"role":...} and {"type":...} line shapes across CLI versions.
    if (value == null && source === "cursor") {
      value = peek({ path: c.path, size: null, source: "claude" })?.firstPrompt ?? null;
    }
  } catch {
    value = null;
  }
  _firstPromptMemo.delete(c.probePath);
  _firstPromptMemo.set(c.probePath, { sig, value });
  if (_firstPromptMemo.size > FIRST_PROMPT_MEMO_MAX) {
    _firstPromptMemo.delete(_firstPromptMemo.keys().next().value);
  }
  return value;
}

/**
 * Tombstones — dismissed runs' attribution facts, persisted in the
 * tq_tombstones SESSION-level tmux user option (base64 of UTF-8 JSON, so
 * the value is locale-proof printable ASCII and can never be mangled by a
 * C-locale tmux client or misread as tmux format syntax). Capped at
 * TOMBSTONE_MAX entries by RELEVANCE (compactTombstones), never recency;
 * scoped to the tracequest tmux session, so they die exactly when every
 * run does.
 */
export const TOMBSTONE_OPTION = "tq_tombstones";
export const TOMBSTONE_MAX = 32;

/**
 * Run LEDGER — the last-seen attribution facts of every live run window,
 * persisted in the tq_run_ledger SESSION-level tmux option (same base64
 * JSON encoding as tombstones). Its one job: when a run window vanishes
 * WITHOUT passing through POST /api/runs/kill (killed directly in tmux —
 * kill-window, the default prefix-& binding, kill-session), the ledger
 * diff is the only remaining evidence the run ever existed, and it carries
 * everything a synthesized tombstone needs. Survives serve restarts like
 * every other piece of run state — tmux stays the only run table.
 */
export const RUN_LEDGER_OPTION = "tq_run_ledger";

/**
 * Read the persisted tombstone list; [] when tmux/session/option is absent
 * or unparsable. Route handlers call this once per request and hand the
 * list to linkRunSession — the linker itself never talks to tmux beyond
 * persisting links.
 */
export function readRunTombstones(deps = {}) {
  const get = pick(deps, "getSessionOption", getSessionOption);
  const availableImpl = pick(deps, "muxAvailable", available);
  try {
    if (!deps.getSessionOption && !availableImpl()) return [];
    const raw = get(TOMBSTONE_OPTION);
    if (!raw) return [];
    const parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t) => t && typeof t === "object" && typeof t.agent === "string");
  } catch {
    return [];
  }
}

/** Serialize and persist the tombstone list (base64 UTF-8 JSON). */
function writeTombstones(list, deps) {
  const set = pick(deps, "setSessionOption", setSessionOption);
  set(TOMBSTONE_OPTION, Buffer.from(JSON.stringify(list), "utf8").toString("base64"));
}

/** Every window id a (possibly merged) tombstone answers for. */
function tombstoneIds(t) {
  return Array.isArray(t.ids) ? [t.id, ...t.ids] : [t.id];
}

/** Merged stones keep at most this many absorbed window ids (dedup memory only). */
const TOMBSTONE_MERGED_IDS_MAX = 16;

/** Widen `into`'s lifetime to also cover `t`'s (union of intervals). */
function widenTombstone(into, t) {
  const s1 = Date.parse(into.started ?? "");
  const s2 = Date.parse(t.started ?? "");
  if (!Number.isFinite(s1) || (Number.isFinite(s2) && s2 < s1)) into.started = t.started ?? "";
  const k1 = Date.parse(into.killed ?? "");
  const k2 = Date.parse(t.killed ?? "");
  if (!Number.isFinite(k1) || (Number.isFinite(k2) && k2 > k1)) into.killed = t.killed ?? "";
}

/** The rivalry-space cwd key: the cwd for cwd-scoped agents, "" otherwise. */
function rivalryCwdKey(agent, cwd) {
  return CWD_SCOPED_AGENTS.has(agent) ? String(cwd ?? "") : "";
}

/** cwd compatibility under the agent's rivalry scoping (spellings-aware). */
function cwdCompatible(agent, cwdA, cwdB, deps) {
  if (!CWD_SCOPED_AGENTS.has(agent)) return true;
  const a = new Set(cwdSpellings(cwdA ?? "", deps));
  return cwdSpellings(cwdB ?? "", deps).some((c) => a.has(c));
}

/**
 * Windows whose attribution question is still OPEN — the runs a tombstone
 * can still protect. A spawn-identified run is settled by construction, a
 * pid link is sticky identity, and a dead run's persisted claim is its
 * final answer; everything else (pending, heur, and prompt — both
 * re-validated while the run lives, and a dead-but-pending run still
 * attributes) can still (re)link, so tombstones covering their candidate
 * space are load-bearing.
 */
function unsettledWindows(windows) {
  return (windows ?? []).filter((w) => {
    const o = w?.options;
    if (!o?.tq_agent) return false;
    if (o.tq_session_id) return false;
    if (o.tq_session && o.tq_session_attr === "pid") return false;
    if (w.dead && o.tq_session) return false;
    return true;
  });
}

/**
 * Can tombstone `t` still change any unsettled run's attribution? A stone
 * covers files born within its run's lifetime (nothing later — a dead
 * process writes nothing), and an unsettled run's candidate gate admits
 * only files born at/after its own start. So a stone is INERT — safely
 * droppable — exactly when every unsettled same-space window started too
 * late (beyond slack margins) to ever admit a file the dead run could have
 * written. Anything unparsable stays relevant: keep beats wrong.
 */
function tombstoneRelevant(t, unsettled, deps) {
  const killedMs = Date.parse(t.killed ?? "");
  if (!Number.isFinite(killedMs)) return true;
  for (const w of unsettled) {
    if (w.options.tq_agent !== t.agent) continue;
    if (!cwdCompatible(t.agent, w.options.tq_cwd, t.cwd, deps)) continue;
    const startedMs = Date.parse(w.options.tq_started ?? "");
    if (!Number.isFinite(startedMs)) return true;
    if (startedMs - CANDIDATE_SLACK_MS <= killedMs + 2 * CANDIDATE_SLACK_MS) return true;
  }
  return false;
}

/** Fold a stone into its space's COARSE stone (interval-only, prompt unknown). */
function foldCoarse(coarseByKey, t) {
  const key = `${t.agent} ${rivalryCwdKey(t.agent, t.cwd)}`;
  const prior = coarseByKey.get(key);
  if (prior) {
    widenTombstone(prior, t);
    return;
  }
  coarseByKey.set(key, {
    id: "",
    coarse: true,
    agent: t.agent,
    cwd: rivalryCwdKey(t.agent, t.cwd),
    started: t.started ?? "",
    killed: t.killed ?? "",
    prompt: "",
    sessionId: "",
    session: "",
    attr: "",
  });
}

/**
 * Cap the tombstone list by RELEVANCE, never recency — the r4 fix: a flood
 * of routine dismissals must never evict the stone keeping an older
 * contest honest. Three tiers, all of them conservative (a stone loses
 * precision before it loses coverage, and coverage only when provably
 * inert):
 * 1. drop stones no unsettled run's candidate space overlaps (inert by
 *    the birth-gate arithmetic — see tombstoneRelevant);
 * 2. merge claimless stones of the same rivalry space AND prompt into one
 *    entry covering the union of their lifetimes (32 routine dismissals
 *    of same-space runs collapse into one stone instead of pushing 32);
 * 3. on overflow, fold the oldest-killed stones into a COARSE per-space
 *    stone — interval-only, prompt UNKNOWN — which contests every
 *    candidate born in its window and DEGRADES prompt corroboration there
 *    to guess-grade (the folded stone might have carried the same prompt,
 *    so a unique match links only as re-validated attr "heur" — an
 *    equal-prompt collider, e.g. the laundering run's own recording
 *    appearing with the same first message, demotes it again), so
 *    laundering stays non-final at any flood size; only precision (claim
 *    exclusion, prompt-mismatch lifting, settled corroboration) is lost.
 * Stones whose window still lives (a failed kill) are kept verbatim and
 * never merged — the window speaks for itself. Without a window list
 * (callers with no tmux access) compaction degrades to the plain newest-N
 * cap.
 */
export function compactTombstones(list, windows, deps = {}) {
  if (!Array.isArray(windows)) return list.slice(-TOMBSTONE_MAX);
  const liveIds = new Set(windows.map((w) => w?.id).filter(Boolean));
  const unsettled = unsettledWindows(windows);
  const precise = [];
  const coarseByKey = new Map();
  const mergedByKey = new Map();
  for (const t of list) {
    if (liveIds.has(t.id)) {
      precise.push(t); // failed kill: inert while the window lives, never merged
      continue;
    }
    if (!tombstoneRelevant(t, unsettled, deps)) continue;
    if (t.coarse) {
      foldCoarse(coarseByKey, t);
      continue;
    }
    if (!t.session && !t.sessionId) {
      const key = `${t.agent} ${rivalryCwdKey(t.agent, t.cwd)} ${t.prompt ?? ""}`;
      const prior = mergedByKey.get(key);
      if (prior) {
        widenTombstone(prior, t);
        prior.ids = [...new Set([...tombstoneIds(prior).slice(1), ...tombstoneIds(t)])]
          .filter((id) => id && id !== prior.id)
          .slice(-TOMBSTONE_MERGED_IDS_MAX);
        continue;
      }
      mergedByKey.set(key, t);
    }
    precise.push(t);
  }
  // Overflow never forgets: fold the oldest-killed dead-window stones into
  // their space's coarse stone until the list fits.
  // PROMPT-PROTECTED stones are never folded to coarse: a stone carrying
  // the same content prompt as a still-unsettled run is the only evidence
  // keeping that run's equal-prompt honesty — fold it away and the
  // dismissed twin's recording would resurface as the survivor's own
  // "unique" match under the prompt-unknown coarse stone (the r4 launder
  // through the r5 relaxation). Same-prompt floods MERGE (tier 2), so
  // protection can never blow the cap by itself.
  const promptProtected = (t) =>
    Boolean(t.prompt) &&
    unsettled.some(
      (w) =>
        w.options.tq_agent === t.agent &&
        cwdCompatible(t.agent, w.options.tq_cwd, t.cwd, deps) &&
        contentPromptOf(w.options) === t.prompt,
    );
  while (precise.length + coarseByKey.size > TOMBSTONE_MAX && precise.length) {
    let idx = -1;
    let oldest = Infinity;
    for (let i = 0; i < precise.length; i++) {
      if (liveIds.has(precise[i].id)) continue;
      if (promptProtected(precise[i])) continue;
      const k = Date.parse(precise[i].killed ?? "");
      const at = Number.isFinite(k) ? k : -Infinity;
      if (at < oldest) {
        oldest = at;
        idx = i;
      }
    }
    if (idx < 0) break; // only live-window/prompt-protected stones left — nothing foldable
    foldCoarse(coarseByKey, precise.splice(idx, 1)[0]);
  }
  // Hard ceiling (unreachable in practice: coarse stones are bounded by
  // distinct rivalry spaces, live-window stones by open windows, protected
  // stones by distinct unsettled-run prompts after same-prompt merging).
  return [...precise, ...coarseByKey.values()].slice(-TOMBSTONE_MAX * 2);
}

/** A tombstone entry from a window id + its tq_* options. */
function tombstoneOf(id, opts, killedIso) {
  return {
    id,
    agent: opts.tq_agent,
    cwd: opts.tq_cwd || "",
    started: opts.tq_started || "",
    killed: killedIso,
    // Content identity only — for resumed runs the SOURCE conversation's
    // first message (tq_fork_prompt), never the follow-up prompt.
    prompt: contentPromptOf(opts),
    sessionId: opts.tq_session_id || "",
    session: opts.tq_session || "",
    attr: opts.tq_session_attr || "",
  };
}

/**
 * Record a tombstone for run window `win` BEFORE it is killed: its birth
 * gate (started), death time, prompt, spawn identity, and claimed path —
 * everything a surviving rival's linker needs to keep this run's recording
 * out of its chat once the window (the only other evidence) is gone.
 * Re-tombstoning the same window id replaces the older entry. `windows`
 * (the current window list) feeds relevance-based compaction; without it
 * the plain newest-N cap applies.
 */
export function recordRunTombstone(win, deps = {}, { windows = null } = {}) {
  const opts = win?.options;
  if (!opts?.tq_agent) return;
  const list = readRunTombstones(deps).filter((t) => t.id !== win.id);
  // A dismissed already-exited run died at its stamped exit boundary, not
  // at dismissal time — the tighter killed keeps its stone from contesting
  // recordings born between the exit and the (possibly much later) kill.
  const killedIso = (win.dead && opts.tq_ended) || new Date().toISOString();
  list.push(tombstoneOf(win.id, opts, killedIso));
  writeTombstones(compactTombstones(list, windows, deps), deps);
}

/**
 * Read the persisted run ledger; [] when tmux/session/option is absent or
 * unparsable (same degradation contract as readRunTombstones).
 */
export function readRunLedger(deps = {}) {
  const get = pick(deps, "getSessionOption", getSessionOption);
  const availableImpl = pick(deps, "muxAvailable", available);
  try {
    if (!deps.getSessionOption && !availableImpl()) return [];
    const raw = get(RUN_LEDGER_OPTION);
    if (!raw) return [];
    const parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e) => e && typeof e === "object" && typeof e.id === "string" && typeof e.agent === "string");
  } catch {
    return [];
  }
}

/** The ledger entry for one run window — a tombstone-in-waiting. */
function ledgerEntryOf(win) {
  const o = win.options;
  return {
    id: win.id,
    agent: o.tq_agent,
    cwd: o.tq_cwd || "",
    started: o.tq_started || "",
    // The stamped exit boundary of an already-dead window: its synthesized
    // tombstone should die at the exit, not at the (later) vanish time.
    ended: o.tq_ended || "",
    prompt: contentPromptOf(o),
    sessionId: o.tq_session_id || "",
    session: o.tq_session || "",
    attr: o.tq_session_attr || "",
  };
}

/**
 * Reconcile the persisted run ledger against the ACTUAL window list — the
 * r4 fix for windows killed directly in tmux (kill-window / prefix-& in
 * the very session users are invited to attach to), which never pass
 * through POST /api/runs/kill and so never tombstone themselves:
 * 1. every ledger entry whose window is GONE and not already tombstoned
 *    gets a SYNTHESIZED tombstone carrying its last-known claim, prompt
 *    and lifetime (killed = detection time — later than the real death,
 *    which only widens the contested window: pending beats wrong);
 * 2. the ledger is rewritten to mirror the current run windows (only when
 *    it actually changed — an idle poll costs one option read).
 * API-killed runs are naturally skipped: their tombstone (recorded before
 * kill-window) already carries their id. Callers hand in the window list
 * they already fetched; any tmux failure degrades to a no-op.
 */
export function syncRunLedger(windows, deps = {}) {
  const availableImpl = pick(deps, "muxAvailable", available);
  if (!deps.getSessionOption && !deps.setSessionOption && !availableImpl()) return;
  const ledger = readRunLedger(deps);
  const runWins = (windows ?? []).filter((w) => w?.id && w?.options?.tq_agent);
  const ids = new Set(runWins.map((w) => w.id));
  const vanished = ledger.filter((e) => !ids.has(e.id));
  if (vanished.length) {
    const stones = readRunTombstones(deps);
    const known = new Set(stones.flatMap(tombstoneIds));
    const now = new Date().toISOString();
    let added = false;
    for (const e of vanished) {
      if (known.has(e.id)) continue;
      stones.push({
        id: e.id,
        agent: e.agent,
        cwd: e.cwd || "",
        started: e.started || "",
        killed: e.ended || now,
        prompt: e.prompt || "",
        sessionId: e.sessionId || "",
        session: e.session || "",
        attr: e.attr || "",
      });
      added = true;
    }
    if (added) writeTombstones(compactTombstones(stones, windows, deps), deps);
  }
  const next = runWins.map(ledgerEntryOf);
  if (JSON.stringify(next) !== JSON.stringify(ledger)) {
    const set = pick(deps, "setSessionOption", setSessionOption);
    set(RUN_LEDGER_OPTION, Buffer.from(JSON.stringify(next), "utf8").toString("base64"));
  }
}

/** The empty attribution answer (no candidates, or unanswerable input). */
function emptyAttribution() {
  return {
    confirmed: null,
    corroborated: null,
    heuristic: null,
    heuristicContent: false,
    eligible: new Set(),
    foreign: new Set(),
  };
}

/**
 * PROBATION for a BARE guess — the round-7 honesty rule.
 *
 * A bare guess (a sole eligible candidate with NO affirmative evidence: no
 * fd holder in this run's tree, no prompt corroboration, not a resumed
 * run's own source) is the weakest thing tracequest ever serves. Its whole
 * justification is uniqueness, and uniqueness needs TIME to be meaningful:
 * the second candidate that would refute it (the run's OWN recording,
 * landing while a foreign file was briefly alone) simply has not been
 * written yet during agent startup.
 *
 * So a bare guess only counts once its candidate has existed, unrefuted,
 * for GUESS_PROBATION_MS of the run's OWN lifetime:
 *   - live run: born + probation <= now;
 *   - dead run: born + probation <= tq_ended — the guess must have matured
 *     WHILE THE RUN RAN. A run that crashed before writing anything can
 *     therefore never finalize the user's session that happened to be born
 *     in its window: it ends "pending", honestly, forever.
 * The window is measured from the candidate's BIRTH (a filesystem fact) and
 * not from first observation, so the verdict is identical across polls,
 * serve restarts, and serve downtime — the same input always yields the
 * same answer.
 *
 * The cost is bounded and lands only on bare guesses: spawn identity (sid),
 * fd identity (pid), prompt corroboration, unique-soft content matches and
 * a resumed run's source fallback all still link on the FIRST poll that
 * sees their evidence.
 */
export const GUESS_PROBATION_MS = 3000;

/**
 * Attribute session-recording candidates to a run — the identity core.
 *
 * @param {object} params
 * @param {string} params.agent       registry id (tq_agent)
 * @param {string} params.cwd         run cwd (tq_cwd)
 * @param {string} params.startedAt   run start (tq_started, ISO)
 * @param {string} [params.prompt]    THIS run's persisted launch prompt (tq_prompt)
 * @param {string} [params.endedAt]   run exit boundary (tq_ended, ISO) — a
 *        dead process writes nothing, so candidates born after ended+slack
 *        are out of a dead run's candidate space entirely
 * @param {boolean} [params.guessAllowed]  false for resumed runs: their
 *        recording is a fork or the source by construction, so a plain
 *        (uncorroborated) candidate may never link as a guess
 * @param {string} [params.home]
 * @param {Set<string>} [params.exclude]  paths pid-claimed by other runs
 * @param {string|number|null} [params.panePid]  THIS run's live pane pid
 * @param {Array<{startedMs: number, endedMs?: number|null, panePid?: string|number, dead?: boolean, prompt?: string, promptUnknown?: boolean}>} [params.rivals]
 *        other run windows (and dismissed-run tombstones) competing for the
 *        same candidate space; endedMs bounds a tombstone's ownable window
 *        (a dead process writes no recordings), prompt is its content
 *        identity
 * @returns {{
 *   confirmed: string|null,     // earliest candidate held open by THIS run's process tree
 *   corroborated: string|null,  // candidate whose first user message matches THIS run's prompt and nobody else's, uncontested by any prompt-unknown (coarse) stone
 *   heuristic: string|null,     // the guess: the SOLE eligible candidate once it has served its PROBATION (or the unique prompt-match under a coarse stone — content-picked, but only guess-grade)
 *   heuristicContent: boolean,  // true when the guess was CONTENT-picked (unique soft prompt match) rather than bare — bare guesses alone serve probation
 *   eligible: Set<string>,      // every candidate the run could honestly own (two of them = ambiguity, no guess)
 *   foreign: Set<string>,       // candidates owned by a RIVAL (fd-held by its tree, or first-message-matched to its prompt)
 * }}
 */
export function attributeRunSession(
  { agent, cwd, startedAt, prompt = "", endedAt = null, guessAllowed = true, home = homedir(), exclude, panePid, rivals = [] },
  deps = {},
) {
  if (typeof cwd !== "string" || cwd.length === 0) return emptyAttribution();
  const startedMs = Date.parse(startedAt ?? "");
  if (!Number.isFinite(startedMs)) return emptyAttribution();
  const gate = startedMs - CANDIDATE_SLACK_MS;
  const endedMs = Date.parse(endedAt ?? "");

  let candidates = runSessionCandidates({ agent, cwd, home }, deps)
    .filter((c) => c.bornMs >= gate && (!Number.isFinite(endedMs) || c.bornMs <= endedMs + CANDIDATE_SLACK_MS));
  if (exclude && exclude.size) candidates = candidates.filter((c) => !exclude.has(c.path));
  if (candidates.length === 0) return emptyAttribution();
  // Earliest-created after the run start first: the recording born soonest
  // after tq_started most plausibly belongs to THIS run.
  candidates.sort((a, b) => a.bornMs - b.bornMs);

  // pid-keyed probe: WHO holds each candidate open, and whose pane process
  // tree do they belong to. Skipped only when it could not change the
  // answer (single candidate, no identity to confirm, nobody competing).
  const wantProbe = Boolean(panePid) || rivals.length > 0 || candidates.length > 1;
  const holdersOf = pick(deps, "openPathHolders", openPathHolders);
  const treeOf = pick(deps, "descendantPids", descendantPids);
  const holders = wantProbe
    ? holdersOf(candidates.map((c) => c.probePath), deps.probeDeps)
    : new Map();
  const myTree = panePid ? treeOf(panePid, deps.probeDeps) : new Set();
  const rivalTree = new Set();
  for (const rival of rivals) {
    if (!rival.panePid || rival.dead) continue;
    for (const pid of treeOf(rival.panePid, deps.probeDeps)) {
      if (!myTree.has(pid)) rivalTree.add(pid);
    }
  }

  const firstOf = pick(deps, "firstUserPrompt", (c) => recordingFirstPrompt(c, agent, deps));
  const out = emptyAttribution();
  const heuristicRanked = [];
  for (const c of candidates) {
    const held = holders.get(c.probePath) ?? new Set();
    let mine = false;
    let others = false;
    for (const pid of held) {
      if (myTree.has(pid)) mine = true;
      else if (rivalTree.has(pid)) others = true;
    }
    if (mine) {
      // Identity: this run's own process tree holds the recording open.
      if (!out.confirmed) out.confirmed = c.path;
      continue;
    }
    if (others) {
      // Identity, inverted: ANOTHER run's tree owns it — never ours.
      out.foreign.add(c.path);
      continue;
    }
    // Ownability: rivals whose birth gate admits this file AND (for
    // tombstones) whose lifetime contains its creation — a dismissed run's
    // dead process cannot have written a file born after its death.
    const owners = rivals.filter(
      (r) =>
        Number.isFinite(r.startedMs) &&
        r.startedMs - CANDIDATE_SLACK_MS <= c.bornMs &&
        (r.endedMs == null || c.bornMs <= r.endedMs + CANDIDATE_SLACK_MS),
    );
    // Content identity: compare the recording's first user message against
    // every party's persisted launch prompt. Extracted only when some
    // prompt evidence exists to weigh it against.
    let isMatch = false;
    let isHard = false;
    const first = (prompt || owners.some((r) => r.prompt)) ? firstOf(c) : null;
    if (first) {
      const matchesMine = promptCorroborates(first, prompt);
      const matchedOwners = owners.filter((r) => promptCorroborates(first, r.prompt));
      if (matchedOwners.length && !matchesMine) {
        // The recording opens with a DIFFERENT run's prompt — it is that
        // run's conversation, alive or dismissed. Never linkable here.
        out.foreign.add(c.path);
        continue;
      }
      // Matching my prompt and nobody else's is content identity FOR me.
      // Matching mine and a rival's (identical prompts) proves nothing.
      // An owner whose prompt is UNKNOWN (a coarse tombstone: the
      // dismissed run's prompt was folded away) might have carried the
      // same text, so under one a unique match is only HALF identity: it
      // may be served — a coarse stone carries no prompt to contradict
      // affirmative content evidence — but only as a re-validated GUESS
      // (attr "heur"), never as settled content identity (attr "prompt").
      isMatch = matchesMine && matchedOwners.length === 0;
      isHard = isMatch && !owners.some((r) => r.promptUnknown);
      // Self-recognition, inverted: MY recording opens with MY prompt, so
      // a prompted run never links a recording whose known first message
      // says otherwise — even uncontested, even when no rival claims it
      // (the rival may be gone without a tombstone). Not marked foreign
      // (nobody else proved ownership either); just never OURS.
      if (prompt && !matchesMine) continue;
    }
    // A rival owner makes the file CONTESTED — unless its persisted prompt
    // provably MISMATCHES the recording's first user message (its own
    // recording would open with its prompt) or the file is a prompt match
    // for me and nobody else. An unknown-prompt owner (coarse tombstone)
    // contests everything EXCEPT a unique match for my prompt. Contested
    // files need identity evidence; a guess never decides.
    const contested =
      !isMatch &&
      owners.some((r) => r.promptUnknown || !(first && r.prompt && !promptCorroborates(first, r.prompt)));
    if (contested) continue;
    out.eligible.add(c.path);
    heuristicRanked.push({ path: c.path, bornMs: c.bornMs, matched: isMatch, hard: isHard });
  }
  // Equal-prompt COLLISION: the same first user message exists in TWO (or
  // more) candidate recordings — e.g. the user's own session opens with
  // the exact text the run was launched with. Prompt equality is
  // corroboration, not identity: with two matching recordings it selects
  // nothing, so NONE of them may link on content — or be served as a
  // guess — until another tier disambiguates (or a collider disappears).
  // Prefer pending over wrong.
  const matched = heuristicRanked.filter((h) => h.matched);
  if (matched.length > 1) {
    for (const h of matched) out.eligible.delete(h.path);
  }
  const unique = matched.length === 1 ? matched[0] : null;
  // HARD unique match (no coarse stone in sight) is content identity; a
  // SOFT one (unique match under a prompt-unknown coarse stone) is served
  // as guess-grade evidence only.
  out.corroborated = unique && unique.hard ? unique.path : null;
  // The guess tier selects ONLY a sole candidate: two unvouched recordings
  // born after the run start are indistinguishable, so birth order (or an
  // anonymous fd holder) selects nothing — the r5 ambiguity rule. A unique
  // soft match is content-picked and beats plain candidates.
  const plain = heuristicRanked.filter((h) => !h.matched);
  if (unique) {
    // Content-picked: served immediately (affirmative evidence), guess-grade
    // only because a coarse stone might have hidden a same-prompt rival.
    out.heuristic = unique.hard ? null : unique.path;
    out.heuristicContent = !unique.hard;
    return out;
  }
  // BARE guess: uniqueness is its only evidence, so it must have held for
  // GUESS_PROBATION_MS of the run's own lifetime (see the constant's docs).
  // For a dead run the clock stops at the exit boundary — a guess that had
  // not matured while the run RAN is never finalized.
  const now = pick(deps, "now", Date.now)();
  const matureBy = Number.isFinite(endedMs) ? endedMs : now;
  const sole = guessAllowed && plain.length === 1 ? plain[0] : null;
  out.heuristic = sole && sole.bornMs + GUESS_PROBATION_MS <= matureBy ? sole.path : null;
  return out;
}

/**
 * Resolve THE session path for a run, or null while none is attributable.
 * Thin wrapper over attributeRunSession: pid-confirmed identity first,
 * prompt-corroborated content identity second, uncontested heuristic last.
 */
export function resolveRunSessionPath(params, deps = {}) {
  const att = attributeRunSession(params, deps);
  return att.confirmed ?? att.corroborated ?? att.heuristic ?? null;
}

/**
 * The file whose stat answers "did this session change?" — the session
 * path itself for .jsonl recordings, chat_history.jsonl inside a Grok
 * session directory (appends never touch the directory mtime), and the
 * opencode database file for opencode:// virtual sessions (the recording
 * IS a set of db rows; the db file's mtime moves when they grow — without
 * this mapping the live endpoint would 404 every opencode session).
 */
export function sessionFreshnessPath(sessionPath) {
  if (sessionPath.startsWith("opencode://")) return resolveOpenCodeDbPath(homedir());
  return sessionPath.endsWith(".jsonl") ? sessionPath : join(sessionPath, GROK_CHAT_FILE);
}

/** attrs that settle a persisted claim as identity (never re-guessed, bars the path elsewhere). */
const SETTLED_ATTRS = new Set(["pid", "sid", "prompt"]);

/**
 * A run's prompt usable as CONTENT identity. For resumed runs the
 * follow-up tq_prompt is NOT it — a fork recording begins with the SOURCE
 * conversation's first message, not the follow-up — but tq_fork_prompt
 * (the source session's first user message, persisted at resume time) IS:
 * it recognizes the run's own fork recording and disowns it from rivals.
 * A resumed run without a persisted fork prompt has no content identity.
 */
function contentPromptOf(opts) {
  if (!opts) return "";
  if (opts.tq_resumed_from) return opts.tq_fork_prompt || "";
  return opts.tq_prompt || "";
}

/**
 * Other run windows competing with `win` for the same candidate space: same
 * agent, cwd-compatible (for cwd-scoped agents), and NOT settled — a
 * spawn-identified run (tq_session_id) can only ever own its determined
 * uuid path, and a pid-confirmed or prompt-corroborated persisted link is
 * identity; none of those competes for anything else. A LIVING heuristic
 * claim is still a guess and keeps contesting, but an EXITED run's valid
 * claim is its final answer (dead runs never re-link) — it competes for
 * nothing else either; its claimed path is barred via the exclusion set
 * instead. Each rival carries its persisted prompt — its content identity
 * for the corroboration tier (blank for resumed runs, whose recordings
 * don't open with their prompt).
 */
function rivalRuns(win, allWindows, deps) {
  const agent = win?.options?.tq_agent;
  if (!agent) return [];
  const scoped = CWD_SCOPED_AGENTS.has(agent);
  const myCwds = new Set(cwdSpellings(win?.options?.tq_cwd ?? "", deps));
  const rivals = [];
  for (const other of allWindows) {
    if (other === win || other?.id === win?.id) continue;
    const opts = other?.options;
    if (!opts?.tq_agent || opts.tq_agent !== agent) continue;
    if (opts.tq_session_id) continue;
    if (opts.tq_session && (SETTLED_ATTRS.has(opts.tq_session_attr) || other.dead)) continue;
    if (scoped && !cwdSpellings(opts.tq_cwd ?? "", deps).some((c) => myCwds.has(c))) continue;
    const endedMs = other.dead ? Date.parse(opts.tq_ended ?? "") : NaN;
    rivals.push({
      startedMs: Date.parse(opts.tq_started ?? ""),
      // A dead rival window wrote nothing after its stamped exit boundary —
      // bound its contests like a tombstone's (unbounded when unstamped:
      // conservative, pending beats wrong).
      endedMs: Number.isFinite(endedMs) ? endedMs : null,
      panePid: other.panePid,
      dead: !!other.dead,
      prompt: contentPromptOf(opts),
    });
  }
  return rivals;
}

/**
 * Dismissed-run tombstones competing with `win`: same agent, cwd-compatible
 * (for cwd-scoped agents), and not `win` itself (the caller has already
 * dropped tombstones whose window still lives — a tombstone written by a
 * kill that then FAILED must not haunt its own living run). A tombstone
 * that died with ANY claim (a sid uuid, or a linked path of any attr) only
 * bars its claimed paths — a dead run never re-links, so its final answer
 * was the only file it could ever own; a tombstone that died PENDING
 * keeps contesting candidates born within its lifetime, carrying its
 * prompt as content identity (blank for resumed runs).
 */
function tombstoneRivals(win, tombstones, deps) {
  const agent = win?.options?.tq_agent;
  if (!agent || !tombstones?.length) return [];
  const scoped = CWD_SCOPED_AGENTS.has(agent);
  const myCwds = new Set(cwdSpellings(win?.options?.tq_cwd ?? "", deps));
  const rivals = [];
  for (const t of tombstones) {
    if (t.agent !== agent || t.id === win?.id) continue;
    if (t.sessionId || t.session) continue;
    if (scoped && !cwdSpellings(t.cwd ?? "", deps).some((c) => myCwds.has(c))) continue;
    const startedMs = Date.parse(t.started ?? "");
    if (!Number.isFinite(startedMs)) continue;
    const killedMs = Date.parse(t.killed ?? "");
    rivals.push({
      startedMs,
      // The dead process wrote nothing after the kill: bound the ownable
      // window so a tombstone can never contest recordings born later.
      endedMs: Number.isFinite(killedMs) ? killedMs : startedMs,
      panePid: null,
      dead: true,
      prompt: t.prompt || "",
      // A COARSE stone folded away its runs' prompts: candidates it can
      // own stay contested and can never be prompt-corroborated (the
      // folded prompt might have been the same text).
      promptUnknown: !!t.coarse,
    });
  }
  return rivals;
}

/**
 * Link a run window to its session recording.
 *
 * Persistence contract (@tq_session + @tq_session_attr window options):
 * - attr "sid"    — spawn-assigned identity (the run's own tq_session_id
 *                   named the recording); sticky forever, like "pid".
 * - attr "pid"    — pid-CONFIRMED identity; sticky forever, wins every
 *                   poll and every serve restart without re-resolution.
 * - attr "prompt" — content-corroborated identity (the recording's first
 *                   user message IS this run's persisted prompt and NO
 *                   other party's); served and RE-VALIDATED every poll
 *                   while the run lives (upgradable to "pid", downgraded
 *                   to a plain guess if corroboration ever stops holding),
 *                   final on an exited run. Settled for rivalry purposes:
 *                   it bars the path from other runs and stops contesting.
 * - attr "heur"   — a guess (the sole eligible candidate that has served its
 *                   GUESS_PROBATION_MS, a unique prompt match under a
 *                   coarse stone, or a resumed run's fresh source
 *                   recording); served, but RE-VALIDATED on every
 *                   poll: upgraded to "pid" ("prompt") the moment stronger
 *                   evidence appears, dropped the moment the file turns
 *                   out foreign, claimed, or contested, and DEMOTED to
 *                   pending the moment a SECOND eligible candidate exists.
 *                   On an exited run it is the final answer ONLY when it
 *                   was unambiguous at death: the exit boundary (tq_ended,
 *                   stamped at the first poll that observes the death)
 *                   closes the run's candidate space, so later-born files
 *                   never demote a settled guess — but a guess that was
 *                   ambiguous within [started, ended] is cleared, never
 *                   finalized, and a BARE guess that never served its
 *                   probation inside the run's own lifetime is never
 *                   finalized either (a promptless run that crashes before
 *                   writing anything ends pending: binding the user's
 *                   session born in its window would be zero-evidence
 *                   attribution).
 * - a spawn-identified run (tq_session_id set, layout known) NEVER carries
 *   a pid or heur link: its recording is determined, so anything else —
 *   including a stale pre-upgrade guess — is dropped and cleared, and the
 *   run stays pending until its OWN recording exists.
 * - a link that would bind another run's recording is never persisted:
 *   contested candidates need identity evidence (pid or prompt), foreign
 *   ones are barred, spawn-determined paths are excluded from every other
 *   run, and DISMISSED runs keep their claims through tombstones
 *   (opts.tombstones / readRunTombstones): their claimed paths stay
 *   excluded and their birth-to-death window keeps contesting — killing a
 *   rival can never launder its recording into this run.
 *
 * @returns {{ path: string|null, link: "linked"|"pending", attribution: "sid"|"pid"|"prompt"|"heuristic"|null }}
 */
export function linkRunSession(
  win,
  allWindows = [],
  { home = homedir(), persist = true, deps = {}, tombstones } = {},
) {
  const validate = pick(deps, "isSessionPath", isSessionPath);
  const persisted = win?.options?.tq_session;
  const persistedAttr = win?.options?.tq_session_attr || "";
  const persistedValid = Boolean(persisted && validate(persisted));

  const persistLink = (path, attr) => {
    if (!persist) return;
    const persistOption = pick(deps, "setWindowOption", setWindowOption);
    try {
      persistOption(win.id, "tq_session", path);
      persistOption(win.id, "tq_session_attr", attr);
    } catch (err) {
      console.error(`run-session-link: failed to persist tq_session for ${win.id}:`, err.message);
    }
  };

  // EXIT boundary: the first poll that observes the death stamps tq_ended
  // (detection time — at/after the real death, so the ownable window only
  // widens: pending beats wrong). Once stamped it is frozen: candidates
  // born after it can neither link to this run nor demote its settled
  // guess; candidates born before it still count for ambiguity-at-death.
  let endedAt = null;
  if (win?.dead && win.options) {
    endedAt = win.options.tq_ended || new Date().toISOString();
    if (!win.options.tq_ended && persist) {
      const persistOption = pick(deps, "setWindowOption", setWindowOption);
      try {
        persistOption(win.id, "tq_ended", endedAt);
        win.options.tq_ended = endedAt;
      } catch (err) {
        console.error(`run-session-link: failed to persist tq_ended for ${win.id}:`, err.message);
      }
    }
  }

  // Tier 0 — spawn identity: the launcher generated this run's session
  // uuid, so the recording path set is determined by construction. Only
  // that recording may ever be served here; everything below (fd probes,
  // birth-time heuristics) is unreachable for such a run.
  const spawnParams = {
    agent: win?.options?.tq_agent,
    cwd: win?.options?.tq_cwd,
    sessionId: win?.options?.tq_session_id || "",
    home,
  };
  const expected = expectedSessionPaths(spawnParams, deps);
  if (expected.length) {
    if (persistedValid && persistedAttr === "sid" && expected.includes(persisted)) {
      return { path: persisted, link: "linked", attribution: "sid" };
    }
    const own = spawnIdentitySessionPath(spawnParams, deps);
    if (own) {
      if (own !== persisted || persistedAttr !== "sid") persistLink(own, "sid");
      return { path: own, link: "linked", attribution: "sid" };
    }
    // No recording of OURS yet. A leftover claim (a pre-upgrade heuristic
    // guess — possibly the USER's own session) must not be served for even
    // one more poll: clear it and answer pending until our uuid file lands.
    if (persisted) persistLink("", "");
    return { path: null, link: "pending", attribution: null };
  }

  // pid-confirmed identity is settled — never re-guessed. (A persisted
  // "sid" without a computable expected set — cwd vanished from tmux — is
  // still identity: serve it rather than degrade to guessing.)
  if (persistedValid && (persistedAttr === "pid" || persistedAttr === "sid")) {
    return { path: persisted, link: "linked", attribution: persistedAttr === "sid" ? "sid" : "pid" };
  }
  // A prompt-corroborated link on an EXITED run is settled content
  // identity — final. A HEURISTIC link on an exited run is only final when
  // it was unambiguous at death, so it falls through to the bounded
  // re-validation below instead of short-circuiting.
  if (persistedValid && win?.dead && persistedAttr === "prompt") {
    return { path: persisted, link: "linked", attribution: "prompt" };
  }

  // Dismissed runs' claims outlive their windows: tombstones recorded at
  // kill time keep excluding their claimed paths and keep contesting their
  // lifetime's candidate space. A tombstone whose window somehow still
  // lives (kill failed mid-request) is ignored — the window speaks for
  // itself.
  const liveIds = new Set(allWindows.map((w) => w?.id).filter(Boolean));
  const stones = (tombstones ?? (deps.readRunTombstones ? deps.readRunTombstones() : []))
    .filter((t) => !liveIds.has(t.id));

  // Identity claims bar a path from other runs' candidate sets: persisted
  // pid/sid/prompt links, EXITED runs' final claims (a dead run's link is
  // served forever, so its file may never double as a survivor's chat),
  // AND the determined (possibly not-yet-written) recording paths of every
  // spawn-identified run — window or tombstone. A DISMISSED run's claim is
  // barred whatever its attr: the file a killed run was served as its chat
  // may never resurface as a survivor's. Only a LIVING heuristic claim
  // does not exclude — that guess is still re-validated and must not be
  // able to starve the true owner.
  const exclude = new Set();
  for (const other of allWindows) {
    if (other === win || other?.id === win?.id) continue;
    const opts = other?.options;
    if (!opts) continue;
    if (opts.tq_session && (SETTLED_ATTRS.has(opts.tq_session_attr) || other.dead)) {
      exclude.add(opts.tq_session);
    }
    if (opts.tq_session_id && opts.tq_agent) {
      for (const p of expectedSessionPaths(
        { agent: opts.tq_agent, cwd: opts.tq_cwd, sessionId: opts.tq_session_id, home },
        deps,
      )) {
        exclude.add(p);
      }
    }
  }
  for (const t of stones) {
    if (t.id === win?.id) continue;
    if (t.session) exclude.add(t.session);
    if (t.sessionId && t.agent) {
      for (const p of expectedSessionPaths(
        { agent: t.agent, cwd: t.cwd, sessionId: t.sessionId, home },
        deps,
      )) {
        exclude.add(p);
      }
    }
  }

  const resumed = Boolean(win?.options?.tq_resumed_from);
  const att = attributeRunSession(
    {
      agent: win?.options?.tq_agent,
      cwd: win?.options?.tq_cwd,
      startedAt: win?.options?.tq_started,
      // A resumed run's content identity is its SOURCE conversation's
      // first user message (tq_fork_prompt) — its fork recording opens
      // with exactly that; the follow-up tq_prompt is never used.
      prompt: contentPromptOf(win?.options),
      endedAt,
      // A resumed run's recording is a fork or the source by construction:
      // an unrelated fresh file may never link to it as a bare guess.
      guessAllowed: !resumed,
      home,
      exclude,
      panePid: win?.dead ? null : win?.panePid,
      rivals: [...rivalRuns(win, allWindows, deps), ...tombstoneRivals(win, stones, deps)],
    },
    deps,
  );

  if (att.confirmed) {
    if (att.confirmed !== persisted || persistedAttr !== "pid") persistLink(att.confirmed, "pid");
    return { path: att.confirmed, link: "linked", attribution: "pid" };
  }

  // Content identity: the recording opening with THIS run's prompt (and no
  // other party's) beats every birth-time guess — including a differing
  // persisted one.
  if (att.corroborated) {
    if (att.corroborated !== persisted || persistedAttr !== "prompt") {
      persistLink(att.corroborated, "prompt");
    }
    return { path: att.corroborated, link: "linked", attribution: "prompt" };
  }

  // Resumed-run SOURCE fallback: serving the very session the run resumes
  // is never the wrong conversation, so a source recording whose freshness
  // moved at/after the run start (within the run's lifetime, for dead
  // runs) is an honest guess when no fork recording corroborates.
  const resumedSrc =
    resumed && win?.options?.tq_resumed_path && validate(win.options.tq_resumed_path)
      ? win.options.tq_resumed_path
      : null;
  const fallback =
    resumedSrc && !exclude.has(resumedSrc) && resumedSourceFresh(resumedSrc, win?.options, endedAt, deps)
      ? resumedSrc
      : null;

  // EXIT finalization for a persisted guess: unique-for-its-whole-life
  // stays the final answer (the tq_ended boundary keeps later-born files
  // out entirely); ambiguous at death is cleared, never finalized. A dead
  // resumed run's established source claim is always final — the source
  // conversation can never be the wrong transcript.
  if (persistedValid && win?.dead) {
    const ambiguous = persisted !== resumedSrc && [...att.eligible].some((p) => p !== persisted);
    if (!ambiguous) {
      return { path: persisted, link: "linked", attribution: "heuristic" };
    }
    // Ambiguous at death: fall through — the tail either links what the
    // evidence still picks (a sole guess, the source fallback) or clears
    // the never-finalizable claim and answers pending.
  }

  // Re-validated guess: evidence-deterministic on every poll. The guess is
  // served only while it is what the evidence would pick RIGHT NOW — a
  // second eligible candidate makes att.heuristic null and DEMOTES a
  // persisted guess to pending (cleared from tmux); a persisted "prompt"
  // link that degraded to a soft match keeps serving under the honest
  // guess label instead of claiming content identity.
  const guess = att.heuristic ?? fallback;
  if (guess) {
    if (guess !== persisted || persistedAttr !== "heur") persistLink(guess, "heur");
    return { path: guess, link: "linked", attribution: "heuristic" };
  }
  if (persistedValid) persistLink("", "");
  return { path: null, link: "pending", attribution: null };
}

/**
 * Has the resumed run's SOURCE recording moved at/after the run start —
 * i.e. is someone (most plausibly the resumed agent continuing in place)
 * appending to the conversation this run continues? For dead runs the
 * move must fall within the run's lifetime: activity after the exit
 * boundary is somebody else's.
 */
function resumedSourceFresh(src, opts, endedAt, deps) {
  const startedMs = Date.parse(opts?.tq_started ?? "");
  if (!Number.isFinite(startedMs)) return false;
  const st = quietStat(sessionFreshnessPath(src), deps);
  if (!st) return false;
  if (st.mtimeMs < startedMs - CANDIDATE_SLACK_MS) return false;
  const endedMs = Date.parse(endedAt ?? "");
  if (Number.isFinite(endedMs) && st.mtimeMs > endedMs + CANDIDATE_SLACK_MS) return false;
  return true;
}
