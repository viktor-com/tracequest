/**
 * A session's worked time (fact durac): the one computation behind its indexed
 * duration and insights agent time (fact insac), over the recording's own
 * timestamped records. The gaps between consecutive records add up, except
 * that a long gap counts only while the agent was the one waiting:
 *
 * - a command, sub-agent or other long-running tool ran (the gap ends at that
 *   tool's result), up to MAX_STALL_MS;
 * - the model answered a tool result (an assistant record right after one),
 *   up to MAX_MODEL_WAIT_MS.
 *
 * Any other long gap is a person away: a session resumed days later, a
 * question or permission prompt waiting for an answer (the result of a quick
 * tool such as a file edit or AskUserQuestion), and counts nothing.
 *
 * The indexers classify records by the same substring tests as the sidecar
 * (sidecar/src/indexer.rs ActiveSpan), so JS and sidecar index entries agree.
 */
import { normalizeToolName } from "../parse/parse-enrich.js";

/** A gap this long with no event is a stall (agent waiting) or idle (human away). */
export const STALL_MS = 5 * 60 * 1000;
/** Longer than this is never one command running: the session was left and resumed. */
export const MAX_STALL_MS = 6 * 60 * 60 * 1000;
/** A model turn slower than this is a rate-limit pause or a suspended machine. */
export const MAX_MODEL_WAIT_MS = 30 * 60 * 1000;

/** Sources whose transcripts carry event times: their indexed duration is worked time. */
export const ACTIVE_TIME_SOURCES = new Set(["claude", "codex", "factory", "grok", "opencode"]);

/** Record kinds; OTHER is a timestamped line that is no message (metadata, notices). */
export const OTHER = 0;
export const USER = 1;
export const ASSISTANT = 2;
/** The result of a quick tool (a file read or edit, a question to the user). */
export const TOOL_RESULT = 3;
/**
 * An OpenCode assistant step that follows a prompt or a step without tools:
 * the gap before it is the model answering.
 */
export const MODEL_STEP = 4;
/** The result of a long-running tool (isLongRunningTool): the gap before it is the agent's wait. */
export const TOOL_WAIT = 5;

const SHELL_TOOL_RE = /^(?:bash|shell|exec|exec_command|run_terminal_cmd|run_command|execute|local_shell|terminal|monitor)$/i;
/**
 * Tools whose call keeps the agent waiting for work that runs meanwhile: a
 * sub-agent, a mission's workers, a background command polled for its output,
 * a fetch. Matched on normalized names (normalizeToolName): Grok's
 * get_command_or_subagent_output and spawn_subagent are "Agent".
 */
const LONG_RUNNING_TOOL_RE = /^(?:agent|task|subagent|spawn_agent|wait_agent|taskoutput|bashoutput|startmissionrun|skill|webfetch|web_fetch|websearch|web_search|wait|write_stdin)$/i;

export function isShellTool(name) {
  return SHELL_TOOL_RE.test(String(name ?? ""));
}

/** Tools that can legitimately run for minutes: commands, sub-agents, fetches, MCP. */
export function isLongRunningTool(name) {
  const n = String(name ?? "");
  return isShellTool(n) || LONG_RUNNING_TOOL_RE.test(n) || n.startsWith("mcp__");
}

/**
 * Active-time accumulator over records in file order: activeMs over every
 * record, atMessageMs up to the last message record (null before one).
 * `waits` maps a tool call id to whether that tool keeps the agent waiting.
 */
export function createActiveSpan() {
  return { prevMs: NaN, prevKind: OTHER, activeMs: 0, atMessageMs: null, waits: new Map() };
}

/** True when a gap of `gap` ms that ends at a `kind` record counts as worked time. */
function gapCounts(gap, kind, prevKind) {
  if (gap <= STALL_MS) return true;
  if (kind === TOOL_WAIT) return gap <= MAX_STALL_MS;
  if (kind === MODEL_STEP) return gap <= MAX_MODEL_WAIT_MS;
  return kind === ASSISTANT && (prevKind === TOOL_RESULT || prevKind === TOOL_WAIT) && gap <= MAX_MODEL_WAIT_MS;
}

/** Add one record at `ms` (epoch ms; NaN is ignored). */
export function addActiveRecord(span, ms, kind) {
  if (!Number.isFinite(ms)) return;
  if (Number.isFinite(span.prevMs)) {
    const gap = ms - span.prevMs;
    if (gap > 0 && gapCounts(gap, kind, span.prevKind)) span.activeMs += gap;
  }
  // Harnesses that merge parallel work log records out of order; measuring
  // gaps from the latest time seen keeps them from being counted twice.
  if (!(ms < span.prevMs)) span.prevMs = ms;
  if (kind !== OTHER) {
    span.prevKind = kind;
    span.atMessageMs = span.activeMs;
  }
}

/** A span's worked time: up to its last message record when the source's duration ends there (fact durcl). */
export function workedMsOfSpan(span, endsAtMessage) {
  return endsAtMessage && span.atMessageMs !== null ? span.atMessageMs : span.activeMs;
}

/** Record a tool call by id and (raw) name, so its result's record knows what it waited for. */
export function noteToolCall(span, id, name) {
  if (id) span.waits.set(id, isLongRunningTool(normalizeToolName(name)));
}

/** TOOL_WAIT when any of the call ids a result line answers is a long-running tool, else TOOL_RESULT. */
function resultKind(span, line, idRe) {
  idRe.lastIndex = 0;
  for (let m = idRe.exec(line); m; m = idRe.exec(line)) {
    if (span.waits.get(m[1])) return TOOL_WAIT;
  }
  return TOOL_RESULT;
}

function hasType(line, type) {
  return line.includes(`"type":"${type}"`) || line.includes(`"type": "${type}"`);
}

function hasRole(line, role) {
  return line.includes(`"role":"${role}"`) || line.includes(`"role": "${role}"`);
}

/** A Claude Code / Factory tool_use block's id and name (both write type, id, name in that order). */
const TOOL_USE_ID_NAME_RE = /"type":\s*"tool_use",\s*"id":\s*"([^"]+)",\s*"name":\s*"([^"]+)"/g;
const TOOL_USE_ID_RE = /"tool_use_id":\s*"([^"]+)"/g;
const CODEX_CALL_ID_RE = /"call_id":\s*"([^"]+)"/g;
const CODEX_CALL_NAME_RE = /"name":\s*"([^"]+)"/;

function noteToolUseBlocks(span, line) {
  if (!line.includes('"tool_use"')) return;
  TOOL_USE_ID_NAME_RE.lastIndex = 0;
  for (let m = TOOL_USE_ID_NAME_RE.exec(line); m; m = TOOL_USE_ID_NAME_RE.exec(line)) noteToolCall(span, m[1], m[2]);
}

/** Claude Code JSONL line kind (the substring tests index_claude routes lines with). */
export function claudeRecordKind(line, span) {
  if (hasType(line, "assistant")) {
    noteToolUseBlocks(span, line);
    return ASSISTANT;
  }
  if (hasType(line, "user")) return line.includes('"tool_result"') ? resultKind(span, line, TOOL_USE_ID_RE) : USER;
  return OTHER;
}

/** Codex rollout line kind: response items are the conversation; event_msg, turn_context, session_meta are not. */
export function codexRecordKind(line, span) {
  if (!hasType(line, "response_item")) return OTHER;
  if (hasType(line, "function_call_output") || hasType(line, "custom_tool_call_output")) {
    return resultKind(span, line, CODEX_CALL_ID_RE);
  }
  if (hasType(line, "function_call") || hasType(line, "custom_tool_call")) {
    CODEX_CALL_ID_RE.lastIndex = 0;
    const id = CODEX_CALL_ID_RE.exec(line);
    const name = CODEX_CALL_NAME_RE.exec(line);
    if (id && name) noteToolCall(span, id[1], name[1]);
    return ASSISTANT;
  }
  if (hasRole(line, "user")) return USER;
  if (hasRole(line, "developer") || hasRole(line, "system")) return OTHER;
  return ASSISTANT;
}

/** Factory JSONL line kind. */
export function factoryRecordKind(line, span) {
  if (!hasType(line, "message")) return OTHER;
  if (hasRole(line, "assistant")) {
    noteToolUseBlocks(span, line);
    return ASSISTANT;
  }
  if (hasRole(line, "user")) return line.includes('"tool_result"') ? resultKind(span, line, TOOL_USE_ID_RE) : USER;
  return OTHER;
}

/**
 * Grok events.jsonl event kind: a turn starts at a prompt, a tool completes
 * (naming its tool), the model's first token.
 */
export function grokEventKind(type, toolName) {
  if (type === "turn_started") return USER;
  if (type === "tool_completed") return isLongRunningTool(normalizeToolName(toolName)) ? TOOL_WAIT : TOOL_RESULT;
  if (type === "first_token") return ASSISTANT;
  return OTHER;
}

/**
 * OpenCode messages in time order: a message's record is its time_created, an
 * assistant message is one agent step whose tools ran inside it, so the gap
 * before step N+1 is step N's work. It counts like the wait for step N's tool
 * results (TOOL_WAIT when one is long-running, TOOL_RESULT when all were quick,
 * such as a question to the user) or, after a prompt or a step without tools,
 * like the model answering (MODEL_STEP).
 */
export function createOpenCodeSteps() {
  return { id: null, role: null, tools: false, wait: false };
}

/** Add one OpenCode message/part join row (fields as forEachOpenCodeMessagePart and the sidecar read them). */
export function addOpenCodeRow(span, steps, messageId, role, timeMs, toolName) {
  if (messageId !== steps.id) {
    let kind = USER;
    if (role === "assistant") {
      if (steps.role === "assistant" && steps.wait) kind = TOOL_WAIT;
      else if (steps.role === "assistant" && steps.tools) kind = TOOL_RESULT;
      else kind = MODEL_STEP;
    }
    addActiveRecord(span, timeMs, kind);
    steps.id = messageId;
    steps.role = role;
    steps.tools = false;
    steps.wait = false;
  }
  if (toolName != null) {
    steps.tools = true;
    if (isLongRunningTool(normalizeToolName(toolName))) steps.wait = true;
  }
}

const NAIVE_SQL_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * Epoch ms of an OpenCode message time_created as the sidecar reads it
 * (parse_opencode_timestamp): integer milliseconds (or seconds below 1e12),
 * RFC 3339, or a zone-less SQL time taken as UTC.
 */
export function openCodeTimeMs(tc) {
  if (tc == null || tc === "") return NaN;
  const n = typeof tc === "number" ? tc : /^-?\d+$/.test(tc) ? Number(tc) : NaN;
  if (Number.isFinite(n)) return n > 1_000_000_000_000 ? n : n * 1000;
  return Date.parse(NAIVE_SQL_TIME.test(tc) ? `${tc.replace(" ", "T")}Z` : tc);
}
