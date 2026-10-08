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
  }
}