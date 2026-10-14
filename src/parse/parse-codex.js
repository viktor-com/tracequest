import { billingTokenUsage, addTokenUsage } from "./token-accounting.js";
import { readFileSync, openSync, readSync, closeSync, fstatSync } from "node:fs";
import { normalizeProjectFolder } from "../server/server-session-path.js";
import { safeSlice, capContent, parseToolArgs, stripKandevContext } from "./parse-utils.js";
import { forEachJsonlLineFromFile, parseJsonlLine } from "./jsonl-read.js";
import { normalizeToolName, enrichToolEvent, extractToolResultText } from "./parse-enrich.js";
import {
  isCodexDisplayableUserText,
  isCodexHeadUnread,
  isCodexIndexSkippableLine,
  isCodexIndexedJsonlLine,
  codexCommandExecutionCmd,
  codexProvenanceModel,
  codexSubThreadItem,
  codexSubThreadItemText,
  codexThreadSettingsModel,
  readCodexLineHead,
  resolveCodexModel,
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
  let provider = null;
  let settingsModel = null;
  let provenanceModel = null;
  let gitBranch = null;
  let turnId = 0;
  let lastUserFormat = null;
  let lastUserEvent = null;
  let lastUserText = null;
  const toolCallsById = new Set();
  const resultsById = new Set();
  let pendingTokens = null;
  let runningTotal = null;

  function userMessage(text, timestamp, format) {
    text = stripKandevContext(text);
    if (!isCodexDisplayableUserText(text)) return;
    const previous = events[events.length - 1];
    const capped = capContent(text, 500);
    // Only adjacent copies in different dialects are mirrors. A later
    // response-only prompt must survive an earlier event_msg prompt.
    if (previous === lastUserEvent && lastUserText === text && lastUserFormat && lastUserFormat !== format) {
      lastUserFormat = null;
      return;
    }
    events.push({ type: "user", timestamp, text: capped, uuid: `codex-user-${turnId++}` });
    lastUserFormat = format;
    lastUserEvent = events[events.length - 1];
    lastUserText = text;
  }

  function toolCall(tc, timestamp) {
    if (tc.id && toolCallsById.has(tc.id)) return;
    const event = {
      type: "assistant", timestamp, text: "", toolCalls: [tc],
      tokens: { input: 0, output: 0, cacheHit: 0, cacheWrite: 0 },
      stopReason: "tool_use", uuid: `codex-asst-${turnId++}`,
    };
    events.push(event);
    if (tc.id) toolCallsById.add(tc.id);
  }

  function toolResult(id, output, isError, timestamp) {
    if (id && resultsById.has(id)) return;
    const event = { type: "tool_result", timestamp, toolUseId: id, text: capContent(output, 1000), isError, errorConfirmed: isError, uuid: `codex-result-${turnId++}` };
    events.push(event);
    if (id) resultsById.add(id);
  }

  function completedTool(te, timestamp) {
    toolCall({ id: te.id, name: te.name, input: te.input }, timestamp);
    toolResult(te.id, te.output, te.isError, timestamp);
  }

  // Most rollout bytes are lines parseCodex never reads (event_msg
  // item_completed mirrors of the session's own thread, compacted history,
  // usage records): decide from the line's leading bytes and skip those
  // without decoding or JSON.parse (fact cdxsub3).
  const keepLine = (buf, start, end) => !isCodexHeadUnread(readCodexLineHead(buf, start, end), sessionId);

  forEachJsonlLineFromFile(filePath, (rawLine) => {
    if (isCodexIndexSkippableLine(rawLine)) return;
    if (!isCodexIndexedJsonlLine(rawLine)) return;
    const line = parseJsonlLine(rawLine);
    if (!line) return;
    if (line.type === "session_meta") {
      const p = line.payload || {};
      sessionId = p.id;
      cwd = p.cwd;
      provider = p.model_provider || "codex";
      if (!provenanceModel) provenanceModel = codexProvenanceModel(p);
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
        onThreadSettings(p) {
          if (!settingsModel) settingsModel = codexThreadSettingsModel(p);
        },
        // A review sub-thread's items exist in this rollout only as
        // item_completed events: its prompt, commands and replies (fact cdxsub).
        onItemCompleted(p) {
          const item = codexSubThreadItem(p, sessionId);
          if (!item) return;
          if (item.type === "UserMessage") {
            const text = codexSubThreadItemText(item);
            if (isCodexDisplayableUserText(text)) {
              events.push({ type: "user", timestamp: line.timestamp, text: capContent(text, 500), uuid: `codex-user-${turnId++}` });
            }
          } else if (item.type === "AgentMessage") {
            const text = codexSubThreadItemText(item);
            if (text) {
              events.push({
                type: "assistant", timestamp: line.timestamp, text: capContent(text, 500), toolCalls: [],
                tokens: { input: 0, output: 0, cacheHit: 0, cacheWrite: 0 }, stopReason: "end_turn", uuid: `codex-asst-${turnId++}`,
              });
            }
          } else if (item.type === "CommandExecution") {
            const id = item.id || `codex-exec-${turnId}`;
            const isError = isCodexToolPayloadError(item);
            events.push({
              type: "assistant", timestamp: line.timestamp, text: "", toolCalls: [{ id, name: "Bash", input: codexCommandExecutionCmd(item) }],
              tokens: { input: 0, output: 0, cacheHit: 0, cacheWrite: 0 }, stopReason: "tool_use", uuid: `codex-asst-${turnId++}`,
            });
            const output = item.aggregated_output || item.stdout || item.stderr || "";
            events.push({ type: "tool_result", timestamp: line.timestamp, toolUseId: id, text: capContent(output, 1000), isError, errorConfirmed: isError, uuid: `codex-result-${turnId++}` });
          }
        },
        onUserMessage(p) {
          userMessage(p.message || "", line.timestamp, "event");
        },
        onTokenCount(p) {
          // Every request since the previous assistant message counts: take the
          // growth of the running total (repeated token_count rows add nothing),
          // or the per-request usage when the rollout carries no running total.
          const total = p.info.total_token_usage;
          let used = p.info.last_token_usage;
          if (total) {
            const grew = !runningTotal || (
              (total.input_tokens || 0) >= (runningTotal.input_tokens || 0)
              && (total.output_tokens || 0) >= (runningTotal.output_tokens || 0)
              && (total.cached_input_tokens || 0) >= (runningTotal.cached_input_tokens || 0));
            if (grew) {
              used = {
                input_tokens: (total.input_tokens || 0) - (runningTotal?.input_tokens || 0),
                output_tokens: (total.output_tokens || 0) - (runningTotal?.output_tokens || 0),
                cached_input_tokens: (total.cached_input_tokens || 0) - (runningTotal?.cached_input_tokens || 0),
              };
            }
            runningTotal = total;
          }
          if (!used) return;
          if (!pendingTokens) pendingTokens = { input: 0, output: 0, cacheHit: 0, cacheWrite: 0 };
          pendingTokens.input += used.input_tokens || 0;
          pendingTokens.output += used.output_tokens || 0;
          pendingTokens.cacheHit += used.cached_input_tokens || 0;
          pendingTokens.billingTokens = addTokenUsage(pendingTokens.billingTokens || {}, billingTokenUsage({
            input: used.input_tokens || 0, output: used.output_tokens || 0,
            cacheHit: used.cached_input_tokens || 0, cacheWrite: used.cache_write_input_tokens || 0,
          }, model || settingsModel || provenanceModel));
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
          completedTool({ name: "Edit", id: p.call_id, input: summary, isError: isCodexToolPayloadError(p), output: p.stdout || p.stderr || "" }, line.timestamp);
        },
        onExecCommandEnd(p) {
          const cmd = (p.parsed_cmd?.[0]?.cmd) || (p.command || []).slice(-1)[0] || "";
          const output = capContent(p.aggregated_output || p.stdout || p.stderr || "", 500);
          const isError = isCodexToolPayloadError(p);
          completedTool({ name: "Bash", id: p.call_id, input: cmd, isError, output }, line.timestamp);
        },
        onTaskComplete(p) {
          if (p.error) toolResult(null, extractToolResultText(p.error.message || p.error), true, line.timestamp);
        },
        onWebSearchEnd(p) {
          completedTool({ name: "WebSearch", id: p.call_id, input: p.query || "", isError: false, output: "" }, line.timestamp);
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
          toolCall(enrichToolEvent({ id: p.call_id, rawName: p.name, input: args }), line.timestamp);
        },
        onFunctionCallOutput(p) {
          const output = extractToolResultText(p.output);
          toolResult(p.call_id, output, isCodexToolPayloadError(p), line.timestamp);
        },
        onCustomToolCall(p) {
          const name = normalizeToolName(p.name);
          const input = p.input || "";
          toolCall({ id: p.call_id, name, input: safeSlice(input, 150) }, line.timestamp);
        },
        onCustomToolCallOutput(p) {
          const output = extractToolResultText(p.output);
          toolResult(p.call_id, output, isCodexToolPayloadError(p), line.timestamp);
        },
        onWebSearchCall(p) {
          const url = p.action?.url || "";
          toolCall({ id: p.id || `codex-ws-${turnId++}`, name: "WebSearch", input: url }, line.timestamp);
        },
      });

      // Legacy content-block function_call_output (user role)
      if (role === "user") {
        if (ptype === "message") {
          const text = content.filter((b) => b?.type === "input_text" && isCodexDisplayableUserText(b.text || "")).map((b) => b.text).join("\n");
          userMessage(text, line.timestamp, "response");
        }
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
        for (const b of content) {
          if (b?.type === "output_text") textBlocks.push(b.text || "");
          else if (b?.type === "function_call") {
            const args = parseToolArgs(b.arguments ?? "{}");
            const tc = enrichToolEvent({ id: b.call_id, rawName: b.name, input: args });
            if (!tc.id || !toolCallsById.has(tc.id)) toolCalls.push(tc);
          }
        }

        if (textBlocks.length || toolCalls.length) {
          const tokens = pendingTokens || { input: 0, output: 0, cacheHit: 0, cacheWrite: 0 };
          pendingTokens = null;
          events.push({
            type: "assistant", timestamp: line.timestamp, text: capContent(textBlocks.join("\n"), 500), toolCalls,
            tokens,
            stopReason: toolCalls.length ? "tool_use" : "end_turn", uuid: `codex-asst-${turnId++}`,
          });
          for (const tc of toolCalls) if (tc.id) toolCallsById.add(tc.id);
        }
      }
    }
  }, { keep: keepLine });

  const sessionEvents = events;

  // Usage reported after the last assistant message still belongs to the
  // session: credit it to that message so the totals match the rollout's.
  if (pendingTokens) {
    for (let i = sessionEvents.length - 1; i >= 0; i--) {
      if (sessionEvents[i].type !== "assistant") continue;
      const t = sessionEvents[i].tokens;
      t.input += pendingTokens.input;
      t.output += pendingTokens.output;
      t.cacheHit += pendingTokens.cacheHit;
      if (pendingTokens.billingTokens) t.billingTokens = addTokenUsage(t.billingTokens || {}, pendingTokens.billingTokens);
      break;
    }
  }

  // The model id comes from turn_context, else thread_settings_applied or the
  // base_instructions provenance; model_provider ("openai") only names the vendor (facts cdxmodel, cdxprov).
  return buildSession({ sessionId, cwd, model: resolveCodexModel({ turnModel: model, settingsModel, provenanceModel, provider }), gitBranch, events: sessionEvents, source: "codex" });
}