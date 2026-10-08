import { statSync } from "node:fs";
import {
  lineRangeBounds,
  lineRangeIncludes,
  lineRangeIsJsonObject,
  lineRangeStartsWith,
} from "./jsonl-line-range.js";
import { visitToolUseTextBlocks } from "./parse-utils.js";
import { extractPrompt } from "../sessions/extract-prompt.js";

/** Progress stream rows — no index state; safe to skip entirely in indexClaudeJsonl. */
export function isClaudeProgressFillerLine(line, start, end) {
  const { s, e } = lineRangeBounds(line, start, end);
  if (!lineRangeIsJsonObject(line, s, e)) return false;
  return (
    lineRangeStartsWith(line, s, e, '{"type":"progress"') ||
    lineRangeStartsWith(line, s, e, '{"type": "progress"')
  );
}

/**
 * Rows with no indexClaudeJsonl contribution (system, queue, …).
 * Keeps user/assistant/session metadata and standalone tool_result rows.
 */
export function isClaudeIndexSkippableLine(line, start, end) {
  const { s, e } = lineRangeBounds(line, start, end);
  if (!lineRangeIsJsonObject(line, s, e)) return false;
  if (isClaudeProgressFillerLine(line, s, e)) return true;
  // Plain system/queue rows dominate filler volume; reject before indexed/tool scans.
  if (
    (lineRangeStartsWith(line, s, e, '{"type":"system"') ||
      lineRangeStartsWith(line, s, e, '{"type": "system"') ||
      lineRangeStartsWith(line, s, e, '{"type":"queue"') ||
      lineRangeStartsWith(line, s, e, '{"type": "queue"')) &&
    !lineRangeIncludes(line, s, e, '"sessionId"') &&
    !lineRangeIncludes(line, s, e, '"cwd"') &&
    !lineRangeIncludes(line, s, e, '"gitBranch"')
  ) {
    return true;
  }
  if (isClaudeIndexedJsonlLine(line, s, e)) return false;
  if (
    lineRangeIncludes(line, s, e, '"type":"tool_result"') ||
    lineRangeIncludes(line, s, e, '"type": "tool_result"')
  ) {
    return !isClaudeToolResultStderrLine(line, s, e);
  }
  return true;
}

/** Standalone tool_result rows with stderr (indexed via separate accumulator path). */
export function isClaudeToolResultStderrLine(line, start, end) {
  const { s, e } = lineRangeBounds(line, start, end);
  if (!lineRangeIsJsonObject(line, s, e)) return false;
  if (!lineRangeIncludes(line, s, e, '"tool_result"')) return false;
  return lineRangeIncludes(line, s, e, '"stderr"');
}

/** Lines eligible for fallback text extraction during indexClaudeJsonl. */
export function isClaudeFallbackSearchLine(line, start, end) {
  return isClaudeIndexedJsonlLine(line, start, end) || isClaudeToolResultStderrLine(line, start, end);
}

/** Parsed Claude JSONL row role for index/peek routing (null when not user/assistant). */
export function claudeIndexedLineKind(parsedObj) {
  if (parsedObj?.type === "user" && !parsedObj.isMeta) return "user";
  if (parsedObj?.type === "assistant") return "assistant";
  return null;
}

/** Shared Claude user prompt extraction for index and peek walks. */
export function visitClaudeUserPrompt(content, hooks = {}) {
  const clean = extractPrompt(content);
  if (clean) hooks.onPrompt?.(clean);
}

/** Shared Claude assistant content block walk for index and peek. */
export function visitClaudeAssistantBlocks(content, hooks = {}) {
  visitToolUseTextBlocks(content, hooks);
}

/** Lines that can affect Cursor JSONL parsing/indexing. */
export function isCursorIndexedJsonlLine(line, start, end) {
  const { s, e } = lineRangeBounds(line, start, end);
  if (!lineRangeIsJsonObject(line, s, e)) return false;
  return (
    lineRangeStartsWith(line, s, e, '{"role":"user"') ||
    lineRangeStartsWith(line, s, e, '{"role": "user"') ||
    lineRangeStartsWith(line, s, e, '{"role":"assistant"') ||
    lineRangeStartsWith(line, s, e, '{"role": "assistant"')
  );
}

/** Parsed Cursor JSONL row role for index/peek routing. */
export function cursorIndexedLineKind(parsedObj) {
  if (!parsedObj?.message) return null;
  if (parsedObj.role === "user") return "user";
  if (parsedObj.role === "assistant") return "assistant";
  return null;
}

/**
 * The cursor-cloud session_meta first line written by `tracequest import cursor-cloud`
 * ({"type":"session_meta","bcId",...} — fact ccml). Message rows keep the local-cursor
 * shape, so everything else routes through the Cursor helpers above.
 */
export function isCursorCloudMetaLine(line, start, end) {
  const { s, e } = lineRangeBounds(line, start, end);
  if (!lineRangeIsJsonObject(line, s, e)) return false;
  return (
    lineRangeStartsWith(line, s, e, '{"type":"session_meta"') ||
    lineRangeStartsWith(line, s, e, '{"type": "session_meta"')
  );
}

/** Cursor turn_ended rows with status "error" (counted toward session errors). */
export function isCursorTurnEndedErrorLine(line, start, end) {
  const { s, e } = lineRangeBounds(line, start, end);
  if (!lineRangeIsJsonObject(line, s, e)) return false;
  if (
    !lineRangeStartsWith(line, s, e, '{"type":"turn_ended"') &&
    !lineRangeStartsWith(line, s, e, '{"type": "turn_ended"')
  ) {
    return false;
  }
  return (
    lineRangeIncludes(line, s, e, '"status":"error"') ||
    lineRangeIncludes(line, s, e, '"status": "error"')
  );
}

/** Rows that should be skipped during Cursor indexing (turn_ended, unknown shapes). */
export function isCursorIndexSkippableLine(line, start, end) {
  const { s, e } = lineRangeBounds(line, start, end);
  if (!lineRangeIsJsonObject(line, s, e)) return false;
  if (isCursorIndexedJsonlLine(line, s, e)) return false;
  return true;
}

/**
 * Cursor transcripts carry no event timestamps; derive session bounds from file
 * metadata (birthtime → start, mtime → end). BigInt ns → ms truncation mirrors
 * the Rust sidecar's SystemTime as_millis so JS/Rust index durationMs agree.
 * Birthtime missing (0/non-finite) or later than mtime clamps to
 * { startMs: mtime, endMs: mtime, durationMs: 0 }. Returns null when stat fails.
 */
export function cursorFileTimeBounds(filePath) {
  try {
    const stats = statSync(filePath, { bigint: true });
    const mtimeMs = Number(stats.mtimeNs / 1000000n);
    const birthtimeMs = Number(stats.birthtimeNs / 1000000n);
    if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return null;
    if (Number.isFinite(birthtimeMs) && birthtimeMs > 0 && birthtimeMs <= mtimeMs) {
      return { startMs: birthtimeMs, endMs: mtimeMs, durationMs: mtimeMs - birthtimeMs };
    }
    return { startMs: mtimeMs, endMs: mtimeMs, durationMs: 0 };
  } catch {
    return null;
  }
}

/** Shared Cursor user prompt extraction for index and peek walks. */
export function visitCursorUserPrompt(content, hooks = {}) {
  // Cursor user messages have content as array of {type:"text", text:"..."} blocks
  // Same inner structure as Claude, so reuse extractPrompt
  const clean = extractPrompt(content);
  if (clean) hooks.onPrompt?.(clean);
}

/** Shared Cursor assistant content block walk for index and peek. */
export function visitCursorAssistantBlocks(content, hooks = {}) {
  // Cursor assistant content blocks have same inner structure: {type:"text",...} and {type:"tool_use",...}
  visitToolUseTextBlocks(content, hooks);
}

/** Lines that can affect Claude/Cursor JSONL parsing/indexing (skip parse on filler rows). */
export function isClaudeIndexedJsonlLine(line, start, end) {
  const { s, e } = lineRangeBounds(line, start, end);
  if (!lineRangeIsJsonObject(line, s, e)) return false;
  return (
    lineRangeIncludes(line, s, e, '"type":"user"') ||
    lineRangeIncludes(line, s, e, '"type": "user"') ||
    lineRangeIncludes(line, s, e, '"type":"assistant"') ||
    lineRangeIncludes(line, s, e, '"type": "assistant"') ||
    lineRangeIncludes(line, s, e, '"sessionId"') ||
    lineRangeIncludes(line, s, e, '"cwd"') ||
    lineRangeIncludes(line, s, e, '"gitBranch"')
  );
}