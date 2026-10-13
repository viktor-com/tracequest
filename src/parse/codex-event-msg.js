import { lineRangeBounds, lineRangeIncludes, lineRangeIsStreamChunkType } from "./jsonl-line-range.js";
import { collapseWhitespace, isDisplayableUserText } from "./parse-utils.js";

/** Codex `event_msg.payload` types handled by parseCodex, indexCodexJsonl, and peekCodex. */

/** stream_chunk filler dominates rollout volume; skip before timestamp regex / indexed gate. */
export function isCodexIndexSkippableLine(line, start, end) {
  const { s, e } = lineRangeBounds(line, start, end);
  return lineRangeIsStreamChunkType(line, s, e);
}

/** Parsed Codex JSONL row role for index/peek routing (null when not user/assistant). */
export function codexIndexedLineKind(parsedObj) {
  if (!parsedObj) return null;
  if (parsedObj.type === "event_msg" && parsedObj.payload?.type === "user_message") return "user";
  if (parsedObj.type === "response_item") {
    const role = parsedObj.payload?.role;
    if (role === "user") return "user";
    if (role === "assistant") return "assistant";
  }
  return null;
}

/** Fast pre-parse guard; mirrors sidecar index_codex and Node indexCodexJsonl. */
export function isCodexIndexedJsonlLine(line, start, end) {
  const { s, e } = lineRangeBounds(line, start, end);
  return (
    lineRangeIncludes(line, s, e, '"session_meta"') ||
    lineRangeIncludes(line, s, e, '"turn_context"') ||
    lineRangeIncludes(line, s, e, '"response_item"') ||
    lineRangeIncludes(line, s, e, '"event_msg"')
  );
}

/**
 * Codex injects its instruction context into the FIRST user response_item as
 * plain input_text blocks. Most of them are XML-wrapped (<environment_context>,
 * <recommended_plugins>, <user_instructions>) and fall to the "<" rule, but
 * the AGENTS.md injection is markdown ("# AGENTS.md instructions for <path>",
 * or bare "# AGENTS.md instructions") — verified against all 757 real rollouts
 * on a live machine: 725 injected blocks, every one starting EXACTLY with this
 * prefix, and the true prompt always arriving later (as its own user
 * response_item plus a verbatim event_msg user_message). Treating the
 * injection as user speech made it the firstPrompt everywhere: session titles,
 * search text, transcript user bubbles, and — fatally — run attribution, where
 * promptCorroborates then failed against the launch prompt and the run's own
 * rollout was skipped forever (the r7 dialect-drift defect).
 */
const CODEX_INJECTED_USER_TEXT_PREFIX = "# AGENTS.md instructions";

export function isCodexDisplayableUserText(text) {
  return isDisplayableUserText(text) && !text.startsWith(CODEX_INJECTED_USER_TEXT_PREFIX);
}

export function normalizeCodexUserPromptText(text) {
  return collapseWhitespace(text);
}

export function visitCodexEventMsgPayload(payload, handlers) {
  const p = payload || {};
  const ptype = p.type;
  if (ptype === "user_message") {
    handlers.onUserMessage?.(p);
    return;
  }
  if (ptype === "token_count") {
    if (p.info?.last_token_usage || p.info?.total_token_usage) handlers.onTokenCount?.(p);
    return;
  }
  if (ptype === "patch_apply_end") {
    handlers.onPatchApplyEnd?.(p);
    return;
  }
  if (ptype === "exec_command_end") {
    handlers.onExecCommandEnd?.(p);
    return;
  }
  if (ptype === "web_search_end") {
    handlers.onWebSearchEnd?.(p);
    return;
  }
  if (ptype === "thread_settings_applied") {
    handlers.onThreadSettings?.(p);
    return;
  }
  if (ptype === "item_completed") {
    handlers.onItemCompleted?.(p);
  }
}

/**
 * The item of an event_msg item_completed payload that belongs to another
 * thread than the session's (fact cdxsub): a codex review runs in a sub-thread
 * whose UserMessage and CommandExecution items appear in the parent rollout
 * only as these events. Items of the session's own thread mirror its
 * response_items and are not read (null).
 */
export function codexSubThreadItem(eventPayload, sessionId) {
  if (eventPayload?.type !== "item_completed") return null;
  const threadId = eventPayload.thread_id;
  if (typeof threadId !== "string" || !threadId || !sessionId || threadId === sessionId) return null;
  const item = eventPayload.item;
  return item && typeof item === "object" ? item : null;
}

/** Text of a sub-thread UserMessage / AgentMessage item (its text blocks joined). */
export function codexSubThreadItemText(item) {
  const content = Array.isArray(item?.content) ? item.content : [];
  let text = "";
  for (const b of content) {
    if (typeof b?.text === "string" && b.text) text += (text ? "\n" : "") + b.text;
  }
  return text;
}

/** Command line of a sub-thread CommandExecution item: parsed_cmd cmd, else the last argv element. */
export function codexCommandExecutionCmd(item) {
  const parsed = item?.parsed_cmd?.[0]?.cmd;
  if (typeof parsed === "string" && parsed) return parsed;
  const cmd = item?.command;
  if (Array.isArray(cmd)) return typeof cmd[cmd.length - 1] === "string" ? cmd[cmd.length - 1] : "";
  return typeof cmd === "string" ? cmd : "";
}

function nonEmptyString(v) {
  return typeof v === "string" && v ? v : null;
}

/** Model id an event_msg thread_settings_applied payload names, or null (fact cdxprov). */
export function codexThreadSettingsModel(eventPayload) {
  return eventPayload?.type === "thread_settings_applied" ? nonEmptyString(eventPayload.thread_settings?.model) : null;
}

/** Model id a session_meta payload names in base_instructions.provenance, or null (fact cdxprov). */
export function codexProvenanceModel(metaPayload) {
  return nonEmptyString(metaPayload?.base_instructions?.provenance?.model);
}

/**
 * A codex session's model (facts cdxmodel, cdxprov): the turn_context model id,
 * else the thread_settings_applied model, else the base_instructions provenance
 * model, else the session_meta provider ("openai"), else null.
 */
export function resolveCodexModel({ turnModel, settingsModel, provenanceModel, provider }) {
  return turnModel || settingsModel || provenanceModel || provider || null;
}

/** event_msg payload types visitCodexEventMsgPayload dispatches; every other one is ignored. */
const CODEX_EVENT_MSG_READ_TYPES = new Set(["user_message", "token_count", "patch_apply_end", "exec_command_end", "web_search_end", "thread_settings_applied"]);
/** event_msg payload type read only when its thread_id is not the session's (fact cdxsub). */
const CODEX_ITEM_COMPLETED = "item_completed";
/** Top-level rollout line types parseCodex reads; every other one is ignored. */
const CODEX_READ_LINE_TYPES = new Set(["session_meta", "turn_context", "response_item", "event_msg"]);
/** response_item payload types parseCodex never reads (no handler, no role). */
const CODEX_UNREAD_RESPONSE_ITEM_TYPES = new Set(["reasoning"]);

const B_QUOTE = 0x22;
const HEAD_TS = Buffer.from('{"timestamp":"');
const HEAD_ORDINAL = Buffer.from(',"ordinal":');
const HEAD_TYPE = Buffer.from(',"type":"');
const HEAD_PAYLOAD_TYPE = Buffer.from(',"payload":{"type":"');
const HEAD_THREAD_ID = Buffer.from(',"thread_id":"');

function bytesAt(buf, at, end, bytes) {
  if (at + bytes.length > end) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[at + i] !== bytes[i]) return false;
  return true;
}

/** Index of the closing quote of a short ASCII value starting at `at` (no escapes), or -1. */
function quoteEnd(buf, at, end, max = 64) {
  const stop = Math.min(end, at + max);
  for (let i = at; i < stop; i++) {
    const c = buf[i];
    if (c === B_QUOTE) return i;
    if (c === 0x5c || c < 0x20 || c > 0x7e) return -1;
  }
  return -1;
}

/**
 * Leading fields of a compact rollout line read straight from its bytes:
 * {"timestamp":"<ts>"[,"ordinal":<n>],"type":"<type>"[,"payload":{"type":"<ptype>"]
 * Returns null when the line does not open that way (callers then decode and
 * parse it as before); `ptype` is null when the payload does not lead with its type.
 * For an item_completed payload, `threadId` is the thread_id that follows its
 * type (null when it does not).
 */
export function readCodexLineHead(buf, start, end) {
  if (!bytesAt(buf, start, end, HEAD_TS)) return null;
  const tsStart = start + HEAD_TS.length;
  const tsEnd = quoteEnd(buf, tsStart, end);
  if (tsEnd < 0) return null;
  let at = tsEnd + 1;
  if (bytesAt(buf, at, end, HEAD_ORDINAL)) {
    at += HEAD_ORDINAL.length;
    while (at < end && buf[at] >= 0x30 && buf[at] <= 0x39) at++;
  }
  if (!bytesAt(buf, at, end, HEAD_TYPE)) return null;
  const typeStart = at + HEAD_TYPE.length;
  const typeEnd = quoteEnd(buf, typeStart, end);
  if (typeEnd < 0) return null;
  const head = {
    ts: buf.toString("latin1", tsStart, tsEnd),
    type: buf.toString("latin1", typeStart, typeEnd),
    ptype: null,
    threadId: null,
  };
  at = typeEnd + 1;
  if (bytesAt(buf, at, end, HEAD_PAYLOAD_TYPE)) {
    const pStart = at + HEAD_PAYLOAD_TYPE.length;
    const pEnd = quoteEnd(buf, pStart, end);
    if (pEnd >= 0) {
      head.ptype = buf.toString("latin1", pStart, pEnd);
      if (head.ptype === CODEX_ITEM_COMPLETED && bytesAt(buf, pEnd + 1, end, HEAD_THREAD_ID)) {
        const tStart = pEnd + 1 + HEAD_THREAD_ID.length;
        const tEnd = quoteEnd(buf, tStart, end);
        if (tEnd >= 0) head.threadId = buf.toString("latin1", tStart, tEnd);
      }
    }
  }
  return head;
}

/**
 * True when parseCodex would ignore a line with this head entirely: a top-level
 * type it has no branch for, an event_msg payload type the visitor drops, an
 * item_completed of the session's own thread (`sessionId`; fact cdxsub3), or a
 * response_item payload type with no handler. Unknown shapes are never skipped.
 */
export function isCodexHeadUnread(head, sessionId = null) {
  if (!head) return false;
  if (!CODEX_READ_LINE_TYPES.has(head.type)) return true;
  if (head.ptype === null) return false;
  if (head.type === "event_msg") {
    if (head.ptype === CODEX_ITEM_COMPLETED) return head.threadId !== null && (!sessionId || head.threadId === sessionId);
    return !CODEX_EVENT_MSG_READ_TYPES.has(head.ptype);
  }
  if (head.type === "response_item") return CODEX_UNREAD_RESPONSE_ITEM_TYPES.has(head.ptype);
  return false;
}
