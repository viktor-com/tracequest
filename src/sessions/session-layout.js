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

/**
 * Claude project-dir slug for a cwd: the absolute path with every "/"
 * replaced by "-", INCLUDING the leading one (/w → "-w").
 */
export function claudeProjectSlug(cwd) {
  return "-" + String(cwd).replace(/^\//, "").replace(/\//g, "-");
}

/** ~/.claude/projects/<slug>: the dir holding a cwd's root-level *.jsonl recordings. */
export function claudeProjectDir(home, cwd) {
  return join(claudeProjectsRoot(home), claudeProjectSlug(cwd));
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
