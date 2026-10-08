import { readFileSync, openSync, readSync, closeSync, fstatSync } from "node:fs";
import { normalizeProjectFolder } from "../server/server-session-path.js";
import { safeSlice, capContent, parseToolArgs } from "./parse-utils.js";
import { forEachJsonlLineFromFile, parseJsonlLine } from "./jsonl-read.js";
import { normalizeToolName, enrichToolEvent, extractToolResultText } from "./parse-enrich.js";
import {
  isCodexDisplayableUserText,
  isCodexIndexSkippableLine,
  isCodexIndexedJsonlLine,
  visitCodexEventMsgPayload,
} from "./codex-event-msg.js";
import { isCodexToolPayloadError, visitCodexResponseItemPayload } from "./codex-response-item.js";
import { buildSession } from "./parse-session-build.js";
import { isIndexDiskExpectedErr } from "../utils/fs-expected-err.js";

/** Read through the first newline from an open fd (session_meta can exceed a small fixed buffer). */
function readFirstJsonlLineFromFd(fd, maxBytes = 1024 * 1024) {
  let offset = 0;
  let acc = "";
  const buf = Buffer.alloc(65536);
  while (offset < maxBytes) {
    const n = readSync(fd, buf, 0, Math.min(buf.length, maxBytes - offset), offset);
    if (n <= 0) break;
    offset += n;
    acc += buf.toString("utf-8", 0, n);
    const nl = acc.indexOf("\n");
    if (nl >= 0) return acc.slice(0, nl);
  }
  return acc;
}

/** Read through the first newline (session_meta can exceed a small fixed buffer). */
function readFirstJsonlLine(filePath, maxBytes = 1024 * 1024) {
  const fd = openSync(filePath, "r");
  try {
    return readFirstJsonlLineFromFd(fd, maxBytes);
  } finally {
    closeSync(fd);
  }
}

function projectFromCodexFirstLine(firstLine) {
  const obj = parseJsonlLine(firstLine);
  if (obj?.type === "session_meta") {
    if (obj.payload?.cwd) {
      return normalizeProjectFolder(obj.payload.cwd);
    }
    return "(unknown)";
  }
  return "codex";
}

/**
 * Discovery metadata for a Codex rollout file (one open: first line + fstat).
 * @returns {{ project: string, size: number, mtime: Date }}
 */
export function discoverCodexSessionMeta(filePath) {
  let fd;
  try {
    fd = openSync(filePath, "r");
    const st = fstatSync(fd);
    const project = projectFromCodexFirstLine(readFirstJsonlLineFromFd(fd));
    return { project, size: st.size, mtime: st.mtime };
  } catch (err) {
    if (!isIndexDiskExpectedErr(err)) {
      console.error(`extractCodexProject: failed to read ${filePath}:`, err.message);
    }
    return { project: "codex", size: 0, mtime: new Date(0) };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** First-line session_meta cwd → short project label for discovery/indexing. */
export function extractCodexProject(filePath) {
  return discoverCodexSessionMeta(filePath).project;
}

/**
 * The VERBATIM session_meta cwd from a rollout file's first line (null when
 * the file is unreadable or its first line is not session_meta). Live
 * detection matches a running codex process's probed cwd against this exact
 * path — the normalized project label of discoverCodexSessionMeta is too
 * lossy for that (two directories can share a basename).
 */
export function codexSessionMetaCwd(filePath) {
  try {
    const obj = parseJsonlLine(readFirstJsonlLine(filePath));
    if (obj?.type !== "session_meta") return null;
    const cwd = obj.payload?.cwd;
    return typeof cwd === "string" && cwd ? cwd : null;
  } catch (err) {
    if (!isIndexDiskExpectedErr(err)) {
      console.error(`codexSessionMetaCwd: failed to read ${filePath}:`, err.message);
    }
    return null;
  }
}

export function parseCodex(filePath) {
  const events = [];
  let sessionId = null;
  let cwd = null;
  let model = null;
  let gitBranch = null;
  let turnId = 0;

  const toolEvents = [];
  let pendingTokens = null;
  const pendingToolCalls = [];
  const pendingToolResults = [];

  forEachJsonlLineFromFile(filePath, (rawLine) => {
    if (isCodexIndexSkippableLine(rawLine)) return;
    if (!isCodexIndexedJsonlLine(rawLine)) return;
    const line = parseJsonlLine(rawLine);
    if (!line) return;
    if (line.type === "session_meta") {
      const p = line.payload || {};
      sessionId = p.id;
      cwd = p.cwd;
      model = p.model_provider || "codex";
      if (p.git?.branch) gitBranch = p.git.branch;
    }

    if (line.type === "turn_context") {
      const p = line.payload || {};
      if (!model && p.model) model = p.model;
      if (!cwd && p.cwd) cwd = p.cwd;
      if (!gitBranch && p.git_branch) gitBranch = p.git_branch;
    }

    if (line.type === "event_msg") {
      visitCodexEventMsgPayload(line.payload, {
        onUserMessage(p) {
          const text = p.message || "";
          if (isCodexDisplayableUserText(text)) {
            events.push({ type: "user", timestamp: line.timestamp, text: capContent(text, 500), uuid: `codex-user-${turnId++}` });
          }
        },
        onTokenCount(p) {
          const u = p.info.last_token_usage;
          pendingTokens = {
            input: u.input_tokens || 0,
            output: u.output_tokens || 0,
            cacheHit: u.cached_input_tokens || 0,
            cacheWrite: 0,
          };
        },
        onPatchApplyEnd(p) {
          let summary = "";
          const changes = p.changes;
          if (changes) {
            let first = true;
            for (const f in changes) {
              const slash = f.lastIndexOf("/");
              const base = slash >= 0 ? f.slice(slash + 1) : f;
              summary += (first ? "" : ", ") + base;
              first = false;
            }
          }
          toolEvents.push({ ts: line.timestamp, name: "Edit", id: p.call_id, input: summary, isError: isCodexToolPayloadError(p), output: capContent(p.stdout || p.stderr || "", 500) });
        },
        onExecCommandEnd(p) {
          const cmd = (p.parsed_cmd?.[0]?.cmd) || (p.command || []).slice(-1)[0] || "";
          const output = capContent(p.aggregated_output || p.stdout || p.stderr || "", 500);
          const isError = isCodexToolPayloadError(p);
          toolEvents.push({ ts: line.timestamp, name: "Bash", id: p.call_id, input: cmd, isError, output });
        },
        onWebSearchEnd(p) {
          toolEvents.push({ ts: line.timestamp, name: "WebSearch", id: p.call_id, input: p.query || "", isError: false, output: "" });
        },
      });
    }

    if (line.type === "response_item") {
      const payload = line.payload || {};
      const role = payload.role;
      const ptype = payload.type;
      const content = payload.content || [];

      visitCodexResponseItemPayload(payload, {
        onFunctionCall(p) {
          const args = parseToolArgs(p.arguments);
          const ptc = { ...enrichToolEvent({ id: p.call_id, rawName: p.name, input: args }), ts: line.timestamp };
          pendingToolCalls.push(ptc);
        },
        onFunctionCallOutput(p) {
          const output = extractToolResultText(p.output);
          pendingToolResults.push({
            callId: p.call_id,
            output,
            isError: isCodexToolPayloadError(p),
            ts: line.timestamp,
          });
        },
        onCustomToolCall(p) {
          const name = normalizeToolName(p.name);
          const input = p.input || "";
          pendingToolCalls.push({ id: p.call_id, name, input: safeSlice(input, 150), ts: line.timestamp });
        },
        onCustomToolCallOutput(p) {
          const output = extractToolResultText(p.output);
          pendingToolResults.push({
            callId: p.call_id,
            output,
            isError: isCodexToolPayloadError(p),
            ts: line.timestamp,
          });
        },
        onWebSearchCall(p) {
          const url = p.action?.url || "";
          pendingToolCalls.push({ id: p.id || `codex-ws-${turnId++}`, name: "WebSearch", input: url, ts: line.timestamp });
        },
      });

      // Legacy content-block function_call_output (user role)
      if (role === "user") {
        for (const block of content) {
          if (block?.type === "function_call_output") {
            const output = extractToolResultText(block.output);
            const isError = isCodexToolPayloadError(block);
            events.push({ type: "tool_result", timestamp: line.timestamp, toolUseId: block.call_id, text: capContent(output, 1000), isError, errorConfirmed: isError, uuid: `codex-result-${turnId++}` });
          }
        }
      }

      if (role === "assistant") {
        const textBlocks = [];
        const toolCalls = [];
        const toolCallIds = new Set();
        for (const b of content) {
          if (b?.type === "output_text") textBlocks.push(b.text || "");
          else if (b?.type === "function_call") {
            const args = parseToolArgs(b.arguments ?? "{}");
            const tc = enrichToolEvent({ id: b.call_id, rawName: b.name, input: args });
            toolCalls.push(tc);
            toolCallIds.add(tc.id);
          }
        }

        while (pendingToolCalls.length) {
          const tc = pendingToolCalls.shift();
          toolCalls.push({ id: tc.id, name: tc.name, input: tc.input });
          toolCallIds.add(tc.id);
        }
        for (const tr of pendingToolResults.splice(0)) {
          events.push({ type: "tool_result", timestamp: tr.ts, toolUseId: tr.callId, text: capContent(tr.output, 1000), isError: tr.isError, errorConfirmed: tr.isError, uuid: `codex-result-${turnId++}` });
        }

        // Attach any pending event_msg tool calls to this assistant turn
        while (toolEvents.length) {
          const te = toolEvents.shift();
          if (!toolCallIds.has(te.id)) {
            toolCalls.push({ id: te.id, name: te.name, input: te.input });
            toolCallIds.add(te.id);
          }
          events.push({ type: "tool_result", timestamp: te.ts, toolUseId: te.id, text: capContent(te.output, 1000), isError: te.isError, errorConfirmed: te.isError, uuid: `codex-result-${turnId++}` });
        }

        const tokens = pendingTokens || { input: 0, output: 0, cacheHit: 0, cacheWrite: 0 };
        pendingTokens = null;

        if (textBlocks.length || toolCalls.length) {
          events.push({
            type: "assistant", timestamp: line.timestamp, text: capContent(textBlocks.join("\n"), 500), toolCalls,
            tokens,
            stopReason: toolCalls.length ? "tool_use" : "end_turn", uuid: `codex-asst-${turnId++}`,
          });
        }
      }
    }
  });

  // Flush any remaining pending tool calls/results as a standalone assistant turn
  if (pendingToolCalls.length || toolEvents.length) {
    const toolCalls = [];
    while (pendingToolCalls.length) {
      const tc = pendingToolCalls.shift();
      toolCalls.push({ id: tc.id, name: tc.name, input: tc.input });
    }
    for (const tr of pendingToolResults.splice(0)) {
      events.push({ type: "tool_result", timestamp: tr.ts, toolUseId: tr.callId, text: capContent(tr.output, 1000), isError: tr.isError, errorConfirmed: tr.isError, uuid: `codex-result-${turnId++}` });
    }
    while (toolEvents.length) {
      const te = toolEvents.shift();
      toolCalls.push({ id: te.id, name: te.name, input: te.input });
      events.push({ type: "tool_result", timestamp: te.ts, toolUseId: te.id, text: capContent(te.output, 1000), isError: te.isError, errorConfirmed: te.isError, uuid: `codex-result-${turnId++}` });
    }
    if (toolCalls.length) {
      const ts = toolCalls[0]?.ts || events[events.length - 1]?.timestamp;
      events.push({
        type: "assistant", timestamp: ts, text: "", toolCalls,
        tokens: pendingTokens || { input: 0, output: 0, cacheHit: 0, cacheWrite: 0 },
        stopReason: "tool_use", uuid: `codex-asst-${turnId++}`,
      });
    }
  }

  return buildSession({ sessionId, cwd, model, gitBranch, events, source: "codex" });
}