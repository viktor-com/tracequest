/**
 * DeepSeek Harness (dsh) sessions:
 * ~/.dsh/sessions/<cwd slug>/session-<uuid>/session.v4.jsonl.zstd, JSONL
 * appended one zstd frame per write (an uncompressed session.v4.jsonl reads
 * the same way). The first row is {type:"session", id, createdAt, cwd}; the
 * rest are {type, seq, time, data} with type user/message, assistant/message,
 * tool/call, tool/result, turn/start, turn/end and bookkeeping rows.
 */
import { readFileSync } from "node:fs";
import { capContent, parseToolArgs } from "./parse-utils.js";
import { forEachJsonlLine, parseJsonlLine } from "./jsonl-read.js";
import { enrichToolEvent } from "./parse-enrich.js";
import { buildSession } from "./parse-session-build.js";
import { readZstdFrames } from "./zstd-frames.js";

/** dsh tool names the shared normalizer does not know, mapped to the names it does. */
const DSH_TOOL_ALIASES = { subagent: "agent", subagent_fork: "agent" };

/** A shell result's trailing "[exit code: N]" marker with N nonzero. */
const DSH_FAILED_EXIT_RE = /\[exit code: [1-9]\d*\]\s*$/;

/** The decoded JSONL text of a dsh recording, or of its first `maxFrames` writes ("" when unreadable). */
export function readDshText(filePath, maxFrames = Infinity) {
  try {
    return filePath.endsWith(".zstd") ? readZstdFrames(filePath, maxFrames) : readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

/** Every row of a dsh recording, in order. */
export function forEachDshRow(filePath, onRow) {
  forEachJsonlLine(readDshText(filePath), (rawLine) => {
    const row = parseJsonlLine(rawLine);
    if (row && typeof row.type === "string") onRow(row);
  });
}

/** Conversation row types a search scan reads; bookkeeping, system prompts and tool schemas are skipped. */
const DSH_SCAN_ROW_PREFIXES = ['{"type":"assistant/message"', '{"type":"tool/call"', '{"type":"tool/result"'];

/** True for a dsh JSONL line a search scan should read: a prompt, an assistant message, a tool call or result. */
export function isDshScanLine(line) {
  if (line.startsWith('{"type":"user/message"')) return line.includes('"source":{"kind":"user"}');
  return DSH_SCAN_ROW_PREFIXES.some((p) => line.startsWith(p));
}

/** The session row (id, createdAt, cwd) a dsh recording starts with — its first write — or {}. */
export function readDshSessionRow(filePath) {
  let head = {};
  const text = readDshText(filePath, 1);
  const nl = text.indexOf("\n");
  const row = parseJsonlLine(nl < 0 ? text : text.slice(0, nl));
  if (row?.type === "session") head = row;
  return head;
}

/** Joined text parts of a dsh message content array. */
export function dshContentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string") out += (out ? "\n" : "") + part.text;
  }
  return out;
}

/** True for a user/message row the person typed (not injected runtime context or skill catalogs). */
export function isDshPromptRow(row) {
  return row.type === "user/message" && row.data?.source?.kind === "user";
}

/** The tool name and argument object dsh recorded, mapped onto the shared tool vocabulary. */
export function dshToolCall(name, argumentsJson) {
  const args = parseToolArgs(argumentsJson);
  const rawName = DSH_TOOL_ALIASES[name] || name;
  if (rawName === "agent" && args && !args.prompt) {
    const task = args.task || args.message || args.description || "";
    return { rawName, input: { ...args, prompt: task, description: args.description || String(task).split("\n")[0] } };
  }
  return { rawName, input: args };
}

/** A dsh tool/result row's text and whether it failed. */
export function dshToolResult(row) {
  const msg = row.data?.message || {};
  const text = dshContentText(msg.content);
  return { id: msg.toolCallId || msg.source?.callId || null, text, isError: msg.isError === true || DSH_FAILED_EXIT_RE.test(text) };
}

/** Parse a dsh recording (.jsonl.zstd or .jsonl). */
export function parseDsh(filePath) {
  const events = [];
  let sessionId = null;
  let cwd = null;
  let model = null;
  let n = 0;
  const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);

  forEachDshRow(filePath, (row) => {
    const data = row.data || {};
    switch (row.type) {
      case "session":
        sessionId = row.id || null;
        cwd = row.cwd || null;
        break;
      case "user/message": {
        if (!isDshPromptRow(row)) break;
        const text = dshContentText(data.content).trim();
        if (text) events.push({ type: "user", timestamp: iso(row.time), text: capContent(text, 500), uuid: data.id || `dsh-user-${n++}` });
        break;
      }
      case "assistant/message": {
        const msg = data.message || {};
        if (msg.source?.model) model = msg.source.model;
        const texts = [];
        const thinking = [];
        const toolCalls = [];
        for (const part of Array.isArray(msg.content) ? msg.content : []) {
          if (part?.type === "text" && part.text) texts.push(part.text);
          else if (part?.type === "reasoning" && part.text) thinking.push(capContent(part.text, 2000));
          else if (part?.type === "tool-call") {
            const { rawName, input } = dshToolCall(part.name, part.arguments);
            toolCalls.push(enrichToolEvent({ id: part.id, rawName, input }));
          }
        }
        // Event input counts cache reads and writes too, as Claude's do (rollupClaudeUsage);
        // dsh's inputTokens is the uncached part.
        const u = data.usage || {};
        const cacheHit = u.cacheReadTokens || 0;
        const cacheWrite = u.cacheWriteTokens || 0;
        const ev = {
          type: "assistant", timestamp: iso(row.time), text: capContent(texts.join("\n"), 500), toolCalls,
          tokens: { input: (u.inputTokens || 0) + cacheHit + cacheWrite, output: u.outputTokens || 0, cacheHit, cacheWrite },
          stopReason: toolCalls.length ? "tool_use" : "end_turn", uuid: msg.id || `dsh-asst-${n++}`,
        };
        if (thinking.length) ev.thinking = thinking;
        events.push(ev);
        break;
      }
      case "tool/result": {
        const { id, text, isError } = dshToolResult(row);
        events.push({
          type: "tool_result", timestamp: iso(row.time), toolUseId: id, text: capContent(text, 1000),
          isError, errorConfirmed: isError, uuid: data.message?.id || `dsh-result-${n++}`,
        });
        break;
      }
      case "turn/end": {
        const reason = data.reason || {};
        if (reason.kind === "error") {
          const message = reason.error?.message || reason.error?.code || "turn failed";
          events.push({
            type: "tool_result", timestamp: iso(row.time), toolUseId: null, text: capContent(`Error: ${message}`, 1000),
            isError: true, errorConfirmed: true, uuid: `dsh-turn-error-${n++}`,
          });
        }
        break;
      }
      default:
        break;
    }
  });

  return buildSession({ sessionId, cwd, model: model || "dsh", gitBranch: null, events, source: "dsh" });
}
