import {
  lineRangeBounds,
  lineRangeIncludes,
  lineRangeIsGrokChatSystemType,
  lineRangeIsJsonObject,
  lineRangeIsStreamChunkType,
} from "./jsonl-line-range.js";
import { extractPrompt } from "../sessions/extract-prompt.js";

/** Lines that can affect Grok events.jsonl parsing/indexing (skip parse on filler rows). */
export function isGrokEventsIndexedLine(line, start, end) {
  const { s, e } = lineRangeBounds(line, start, end);
  if (!lineRangeIsJsonObject(line, s, e)) return false;
  // stream_chunk filler dominates events.jsonl volume; one prefix check beats five scans.
  if (lineRangeIsStreamChunkType(line, s, e)) return false;
  return (
    lineRangeIncludes(line, s, e, '"ts"') ||
    lineRangeIncludes(line, s, e, '"timestamp"') ||
    lineRangeIncludes(line, s, e, '"turn_started"') ||
    lineRangeIncludes(line, s, e, '"tool_started"') ||
    lineRangeIncludes(line, s, e, '"tool_completed"')
  );
}

/** Lines that can affect Grok chat parsing/indexing (skip parse on filler rows). */
export function isGrokChatIndexedLine(line, start, end) {
  const { s, e } = lineRangeBounds(line, start, end);
  if (!lineRangeIsJsonObject(line, s, e)) return false;
  // system filler dominates chat_history volume; one prefix check beats seven scans.
  if (lineRangeIsGrokChatSystemType(line, s, e)) return false;
  return (
    lineRangeIncludes(line, s, e, '"type":"user"') ||
    lineRangeIncludes(line, s, e, '"type": "user"') ||
    lineRangeIncludes(line, s, e, '"type":"assistant"') ||
    lineRangeIncludes(line, s, e, '"type": "assistant"') ||
    lineRangeIncludes(line, s, e, '"type":"tool_result"') ||
    lineRangeIncludes(line, s, e, '"type": "tool_result"') ||
    ((lineRangeIncludes(line, s, e, '"type":"tool"') || lineRangeIncludes(line, s, e, '"type": "tool"')) &&
      !lineRangeIncludes(line, s, e, "tool_result"))
  );
}

/** Shared Grok chat_history user/assistant text walk for index and peek. */
export function visitGrokChatHistoryLine(obj, hooks = {}) {
  if (!obj) return;
  if (obj.type === "user") {
    const clean = extractPrompt(obj.content);
    if (clean) hooks.onUserPrompt?.(clean);
    if (hooks.onUserRawChars) {
      const userText = typeof obj.content === "string" ? obj.content : JSON.stringify(obj.content || "");
      hooks.onUserRawChars(userText.length);
    }
  }
  if (obj.type === "assistant") {
    if (typeof obj.content === "string") {
      const t = obj.content;
      if (t) hooks.onAssistantString?.(t);
    } else if (Array.isArray(obj.content)) {
      for (const b of obj.content) {
        if (b?.type === "text" && b.text) hooks.onAssistantBlockText?.(b.text);
      }
    }
  }
}

/** Shared Grok events.jsonl object visitor for index and peek walks. */
export function visitGrokEventsObj(obj, hooks = {}) {
  if (!obj) return;
  const ts = obj.ts || obj.timestamp;
  if (ts && hooks.onTimestamp) hooks.onTimestamp(ts);
  if (obj.type === "turn_started" && obj.model_id && hooks.onModel) hooks.onModel(obj.model_id);
  if (obj.type === "tool_started" && obj.tool_name && hooks.onToolStarted) {
    hooks.onToolStarted(obj.tool_name);
  }
  if (obj.type === "tool_completed" && obj.outcome === "error" && hooks.onToolError) hooks.onToolError();
}

/** System + other non-indexed chat rows — no scan/index contribution (fast system reject). */
export function isGrokChatScanSkippableLine(line, start, end) {
  const { s, e } = lineRangeBounds(line, start, end);
  if (!lineRangeIsJsonObject(line, s, e)) return false;
  if (lineRangeIsGrokChatSystemType(line, s, e)) return true;
  return !isGrokChatIndexedLine(line, start, end);
}