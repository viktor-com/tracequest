import { collapseWhitespace, isDisplayableUserText, capContent, visitToolUseTextBlocks } from "./parse-utils.js";
import { lineRangeBounds, lineRangeIsJsonObject, lineRangeStartsWith } from "./jsonl-line-range.js";
import { forEachJsonlLineFromFile, parseJsonlLine } from "./jsonl-read.js";
import { errorPattern, extractToolResultText, enrichToolEvent } from "./parse-enrich.js";
import { buildSession } from "./parse-session-build.js";

/** Non-message filler rows (standalone tool_result etc.) — no index/scan contribution. */
export function isFactoryScanSkippableLine(line, start, end) {
  const { s, e } = lineRangeBounds(line, start, end);
  if (!lineRangeIsJsonObject(line, s, e)) return false;
  return !(
    lineRangeStartsWith(line, s, e, '{"type":"message"') ||
    lineRangeStartsWith(line, s, e, '{"type": "message"')
  );
}

/** Parity with sidecar is_factory_index_skippable_line; alias for index hot path. */
export const isFactoryIndexSkippableLine = isFactoryScanSkippableLine;

/** Parsed Factory JSONL row role for index/peek routing (null when not user/assistant). */
export function factoryIndexedLineKind(parsedObj) {
  if (parsedObj?.type !== "message") return null;
  if (parsedObj.message?.role === "user") return "user";
  if (parsedObj.message?.role === "assistant") return "assistant";
  return null;
}

/** Visit factory user text blocks for index/peek prompt accumulation. */
export function visitFactoryUserTextBlocks(content, onText) {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block?.type !== "text") continue;
    const t = block.text || "";
    if (!isDisplayableUserText(t)) continue;
    const clean = collapseWhitespace(t);
    if (clean) onText(clean);
  }
}

/** Visit factory assistant blocks for index/peek tool and text accumulation. */
export function visitFactoryAssistantBlocks(content, hooks = {}) {
  visitToolUseTextBlocks(content, hooks);
}

/** Skip JSON.parse on standalone tool_result filler rows (indexing-only noise). */
function isFactoryParsedLine(rawLine) {
  return (
    rawLine.includes('"type":"message"') ||
    rawLine.includes('"type": "message"') ||
    rawLine.includes('"type":"session_start"') ||
    rawLine.includes('"type": "session_start"') ||
    rawLine.includes('"type":"heartbeat"') ||
    rawLine.includes('"type": "heartbeat"')
  );
}

export function parseFactory(filePath) {
  const events = [];
  let sessionId = null;
  let cwd = null;
  let model = null;
  let gitBranch = null;
  let turnId = 0;

  forEachJsonlLineFromFile(filePath, (rawLine) => {
    if (!isFactoryParsedLine(rawLine)) return;
    const line = parseJsonlLine(rawLine);
    if (!line) return;

    if (!gitBranch && line.gitBranch) gitBranch = line.gitBranch;

    if (line.type === "session_start") {
      sessionId = line.id;
      cwd = line.cwd;
      if (line.model) model = line.model;
      if (line.gitBranch) gitBranch = line.gitBranch;
    }

    if (line.type === "message") {
      const msg = line.message || {};
      const role = msg.role;
      if (!model && msg.model) model = msg.model;
      const content = msg.content || [];
      const ts = line.timestamp;

      if (role === "user") {
        if (Array.isArray(content)) {
          let userText = "";
          for (const block of content) {
            if (block?.type === "text") {
              const t = block.text || "";
              if (isDisplayableUserText(t)) userText += t + "\n";
            }
            if (block?.type === "tool_result") {
              const resultText = extractToolResultText(block.content);
              const isError = block.is_error === true || errorPattern.test(resultText);
              events.push({ type: "tool_result", timestamp: ts, toolUseId: block.tool_use_id, text: capContent(resultText, 1000), isError, uuid: `factory-result-${turnId++}` });
            }
          }
          userText = userText.trim();
          if (isDisplayableUserText(userText)) {
            events.push({ type: "user", timestamp: ts, text: capContent(userText, 500), uuid: line.id || `factory-user-${turnId++}` });
          }
        }
      }

      if (role === "assistant") {
        if (Array.isArray(content)) {
          const textBlocks = [];
          const toolCalls = [];
          for (const b of content) {
            if (b?.type === "text") textBlocks.push(b.text || "");
            else if (b?.type === "tool_use") {
              toolCalls.push(enrichToolEvent({ id: b.id, rawName: b.name, input: b.input }));
            }
          }
          events.push({
            type: "assistant", timestamp: ts, text: capContent(textBlocks.join("\n"), 500), toolCalls,
            tokens: { input: 0, output: 0, cacheHit: 0, cacheWrite: 0 },
            stopReason: toolCalls.length ? "tool_use" : "end_turn", uuid: line.id || `factory-asst-${turnId++}`,
          });
        }
      }
    }
  });

  return buildSession({ sessionId, cwd, model: model || "claude (factory)", gitBranch, events, source: "factory" });
}