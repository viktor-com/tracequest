import { readFileSync, openSync, readSync, closeSync, fstatSync } from "node:fs";
import { normalizeProjectFolder } from "../server/server-session-path.js";
import { safeSlice, capContent, parseToolArgs } from "./parse-utils.js";
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
  // Newer codex rollouts record prompts only as user response_items; older
  // ones also emit event_msg user_message. Count each prompt once (fact cdxprompt).
  let sawUserMessage = false;

  const toolEvents = [];
  let pendingTokens = null;
  let runningTotal = null;
  const pendingToolCalls = [];
  const pendingToolResults = [];

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
          sawUserMessage = true;
          const text = p.message || "";
          if (isCodexDisplayableUserText(text)) {
            events.push({ type: "user", timestamp: line.timestamp, text: capContent(text, 500), uuid: `codex-user-${turnId++}` });
          }
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
        if (ptype === "message") {
          const text = content.filter((b) => b?.type === "input_text" && isCodexDisplayableUserText(b.text || "")).map((b) => b.text).join("\n");
          if (text) events.push({ type: "user", timestamp: line.timestamp, text: capContent(text, 500), uuid: `codex-user-${turnId++}`, fromResponseItem: true });
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

        if (textBlocks.length || toolCalls.length) {
          const tokens = pendingTokens || { input: 0, output: 0, cacheHit: 0, cacheWrite: 0 };
          pendingTokens = null;
          events.push({
            type: "assistant", timestamp: line.timestamp, text: capContent(textBlocks.join("\n"), 500), toolCalls,
            tokens,
            stopReason: toolCalls.length ? "tool_use" : "end_turn", uuid: `codex-asst-${turnId++}`,
          });
        }
      }
    }
  }, { keep: keepLine });

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
      pendingTokens = null;
    }
  }

  const sessionEvents = sawUserMessage ? events.filter((e) => !e.fromResponseItem) : events;
  for (const e of sessionEvents) delete e.fromResponseItem;

  // Usage reported after the last assistant message still belongs to the
  // session: credit it to that message so the totals match the rollout's.
  if (pendingTokens) {
    for (let i = sessionEvents.length - 1; i >= 0; i--) {
      if (sessionEvents[i].type !== "assistant") continue;
      const t = sessionEvents[i].tokens;
      t.input += pendingTokens.input;
      t.output += pendingTokens.output;
      t.cacheHit += pendingTokens.cacheHit;
      break;
    }
  }

  // The model id comes from turn_context, else thread_settings_applied or the
  // base_instructions provenance; model_provider ("openai") only names the vendor (facts cdxmodel, cdxprov).
  return buildSession({ sessionId, cwd, model: resolveCodexModel({ turnModel: model, settingsModel, provenanceModel, provider }), gitBranch, events: sessionEvents, source: "codex" });
}