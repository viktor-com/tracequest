/**
 * Session-recording LAYOUT — the single source of truth for where each agent
 * writes its recordings under $HOME.
 *
 * Every half of tracequest that touches those paths imports from here:
 *   - discovery (src/sessions/session-discovery.js) — what the index sees;
 *   - live detection (src/sessions/live-sessions.js) — what a running
 *     process's cwd maps to;
 *   - run↔session attribution (src/sessions/run-session-link.js) — what a
 *     launched run's candidate recordings are.
 * Before this module the three disagreed: attribution scanned
 * ~/.cursor/projects/<LEADING-DASH slug>/*.jsonl (a layout the real Cursor
 * CLI has never used) while discovery already modelled the real one
 * (<dashless slug>/agent-transcripts/<uuid>/<uuid>.jsonl), so every real
 * cursor-agent run pended forever with its transcript sitting on disk. One
 * helper set makes that divergence impossible: a layout change lands in one
 * place or in none.
 *
 * Verified against a real machine (2026-08-11): 917 cursor recordings, all
 * at <dashless>/agent-transcripts/<uuid>/<uuid>.jsonl, zero at project-dir
 * root; every ~/.claude/projects dir leading-dash; every ~/.codex/sessions
 * recording a rollout-*.jsonl under sessions/YYYY/MM/DD; every
 * ~/.grok/sessions dir a percent-encoded cwd.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/* ── roots ───────────────────────────────────────────────────────────── */

export function claudeProjectsRoot(home = homedir()) {
  return join(home, ".claude", "projects");
}
export function cursorProjectsRoot(home = homedir()) {
  return join(home, ".cursor", "projects");
}
export function codexSessionsRoot(home = homedir()) {
  return join(home, ".codex", "sessions");
}
export function factorySessionsRoot(home = homedir()) {
  return join(home, ".factory", "sessions");
}
export function grokSessionsRoot(home = homedir()) {
  return join(home, ".grok", "sessions");
}

/* ── claude (and the claude-family cursor-cloud import root) ──────────── */

/** Claude Code truncates a longer sanitized cwd to this many chars and appends "-<hash>". */
const CLAUDE_SLUG_MAX = 200;

/**
 * Claude project-dir slug for a cwd, exactly as Claude Code names it
 * (verified against Claude Code 2.1.289's path sanitizer): every character
 * outside [A-Za-z0-9] — the leading "/" included, and "." / "_" too —
 * becomes "-" (/Users/x/.kandev/my_proj → "-Users-x--kandev-my-proj"); a
 * result over 200 chars keeps its first 200 and gains "-" plus the base-36
 * absolute 32-bit string hash of the raw cwd. Mapping only "/" missed every
 * dotted or underscored cwd (fact clslug).
 */
export function claudeProjectSlug(cwd) {
  const raw = String(cwd);
  const slug = raw.replace(/[^A-Za-z0-9]/g, "-");
  if (slug.length <= CLAUDE_SLUG_MAX) return slug;
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = ((h << 5) - h + raw.charCodeAt(i)) | 0;
  return `${slug.slice(0, CLAUDE_SLUG_MAX)}-${Math.abs(h).toString(36)}`;
}

/**
 * The slug tracequest used before fact clslug: only "/" mapped to "-"
 * (/Users/x/.kandev/my_proj -> "-Users-x-.kandev-my_proj"), no length cap.
 */
function claudeLegacyProjectSlug(cwd) {
  return String(cwd).replace(/\//g, "-");
}

/**
 * ~/.claude/projects/<slug>: the dir holding a cwd's root-level *.jsonl
 * recordings — the dir Claude Code names (claudeProjectSlug), or, when that
 * dir does not exist but the legacy "/"-only slug dir does, the legacy one
 * (fact clslug). `isDir` (default: statSync) is consulted only when the two
 * slugs differ, so a cwd made of letters, digits and "/" costs no stat.
 */
export function claudeProjectDir(home, cwd, isDir = dirExists) {
  const root = claudeProjectsRoot(home);
  const slug = claudeProjectSlug(cwd);
  const current = join(root, slug);
  const legacySlug = claudeLegacyProjectSlug(cwd);
  if (legacySlug === slug) return current;
  if (isDir(current)) return current;
  const legacy = join(root, legacySlug);
  return isDir(legacy) ? legacy : current;
}

function dirExists(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/* ── cursor-agent ─────────────────────────────────────────────────────── */

/**
 * Cursor project-dir slug for a cwd: same "/"→"-" mapping WITHOUT the
 * leading dash (/Users/x/code/y → "Users-x-code-y"). Deliberately different
 * from claudeProjectSlug — that difference is what round 6 got wrong.
 */
export function cursorProjectSlug(cwd) {
  return String(cwd).replace(/^\//, "").replace(/\//g, "-");
}

/** The per-uuid recording subtree name inside a cursor project dir. */
export const CURSOR_TRANSCRIPTS_DIR = "agent-transcripts";

/** ~/.cursor/projects/<slug>/agent-transcripts — the dir of per-session uuid dirs. */
export function cursorTranscriptsDir(home, cwd) {
  return join(cursorProjectsRoot(home), cursorProjectSlug(cwd), CURSOR_TRANSCRIPTS_DIR);
}

/** <transcriptsDir>/<uuid>/<uuid>.jsonl — the MAIN recording of one cursor session. */
export function cursorMainRecording(transcriptsDir, uuid) {
  return join(transcriptsDir, uuid, `${uuid}.jsonl`);
}

/* ── codex ────────────────────────────────────────────────────────────── */

/**
 * Codex writes rollout-<ts>-<uuid>.jsonl into a DATED tree
 * (sessions/YYYY/MM/DD). Only rollout-prefixed files are recordings —
 * discovery ignores anything else there, so attribution must too.
 */
export function isCodexRolloutFile(name) {
  return name.startsWith("rollout-") && name.endsWith(".jsonl");
}

/* ── droid / factory ──────────────────────────────────────────────────── */

/** ~/.factory/sessions workspace dir name ("ws" + cwd with "/"→"-"). */
export function factoryWorkspaceSlug(cwd) {
  return "ws" + String(cwd).replace(/\//g, "-");
}

/** ~/.factory/sessions/ws<slug>: a workspace's root-level *.jsonl recordings. */
export function factoryWorkspaceDir(home, cwd) {
  return join(factorySessionsRoot(home), factoryWorkspaceSlug(cwd));
}

/* ── grok ─────────────────────────────────────────────────────────────── */

/** ~/.grok/sessions workspace dir name (percent-encoded absolute cwd). */
export function grokWorkspaceSlug(cwd) {
  return encodeURIComponent(cwd);
}

/** ~/.grok/sessions/<enc-cwd>: the dir of per-session uuid DIRECTORIES. */
export function grokWorkspaceDir(home, cwd) {
  return join(grokSessionsRoot(home), grokWorkspaceSlug(cwd));
}

/** ~/.grok/sessions/<enc-cwd>/<id> — the grok session path IS this directory. */
export function grokSessionDir(home, cwd, sessionId) {
  return join(grokWorkspaceDir(home, cwd), sessionId);
}

/** The appended file inside a grok session dir (its freshness/probe target). */
export const GROK_CHAT_FILE = "chat_history.jsonl";
