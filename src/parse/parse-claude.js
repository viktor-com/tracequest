import { basename } from "node:path";
import { isDisplayableUserText, capContent, rollupClaudeUsage } from "./parse-utils.js";
import { forEachJsonlLineFromFile, parseJsonlLine } from "./jsonl-read.js";
import { errorPattern, extractToolResultText, enrichToolEvent, joinTextContentBlocks } from "./parse-enrich.js";
import { buildSession } from "./parse-session-build.js";
import {
  isClaudeIndexedJsonlLine,
  isCursorIndexedJsonlLine,
  isCursorCloudMetaLine,
  isCursorTurnEndedErrorLine,
  cursorFileTimeBounds,
} from "./claude-jsonl-index.js";
import { extractPrompt } from "../sessions/extract-prompt.js";
import { cursorModelFromStateDb } from "../sessions/cursor-state-db.js";

export function parseClaude(filePath, source = "claude") {
  const events = [];
  let sessionId = null;
  let cwd = null;
  let model = null;
  let gitBranch = null;

  forEachJsonlLineFromFile(filePath, (rawLine) => {
    if (!isClaudeIndexedJsonlLine(rawLine)) return;
    const line = parseJsonlLine(rawLine);
    if (!line) return;

    if (!sessionId && line.sessionId) sessionId = line.sessionId;
    if (!cwd && line.cwd) cwd = line.cwd;
    if (!gitBranch && line.gitBranch) gitBranch = line.gitBranch;

    if (line.type === "user" && !line.isMeta) {
      const content = line.message?.content;
      let text = "";
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        text = joinTextContentBlocks(content);
      }
      if (isDisplayableUserText(text)) {
        events.push({ type: "user", timestamp: line.timestamp, text: capContent(text, 500), uuid: line.uuid });
      }
    }

    if (line.type === "assistant") {
      const msg = line.message || {};
      if (!model && msg.model) model = msg.model;
      const content = Array.isArray(msg.content) ? msg.content : [];
      const textBlocks = [];
      const thinkingBlocks = [];
      const toolCalls = [];
      for (const b of content) {
        if (b.type === "text") textBlocks.push(b.text);
        else if (b.type === "thinking" && b.thinking) thinkingBlocks.push(b.thinking);
        else if (b.type === "tool_use") {
          toolCalls.push(enrichToolEvent({ id: b.id, rawName: b.name, input: b.input }));
        }
      }
      const tokens = rollupClaudeUsage(msg.usage);
      const ev = {
        type: "assistant", timestamp: line.timestamp, text: capContent(textBlocks.join("\n"), 500), toolCalls,
        tokens,
        stopReason: msg.stop_reason, uuid: line.uuid,
      };
      if (thinkingBlocks.length > 0) {
        ev.thinking = thinkingBlocks.map(t => capContent(t, 2000));
      }
      events.push(ev);
    }

    if (line.type === "user") {
      const content = line.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_result") {
            const resultText = extractToolResultText(block.content);
            const isError = block.is_error === true || errorPattern.test(resultText);
            events.push({ type: "tool_result", timestamp: line.timestamp, toolUseId: block.tool_use_id, text: capContent(resultText, 1000), isError, uuid: line.uuid });
          }
        }
      }
    }
  });

  return buildSession({ sessionId, cwd, model, gitBranch, events, source });
}

/**
 * Shared Cursor-family transcript walk (local cursor and imported cursor-cloud
 * message rows have identical shape — fact ccmr). The optional onSessionMeta
 * hook captures a cursor-cloud session_meta first line.
 */
function walkCursorTranscript(filePath, { onSessionMeta } = {}) {
  const events = [];
  // cwd/gitBranch are absent from cursor transcripts; derive them from tool inputs.
  const cwdCounts = new Map(); // working_directory -> { count, order }
  let gitBranch = null;
  let model = null;

  forEachJsonlLineFromFile(filePath, (rawLine) => {
    if (onSessionMeta && isCursorCloudMetaLine(rawLine)) {
      const metaLine = parseJsonlLine(rawLine);
      if (metaLine) onSessionMeta(metaLine);
      return;
    }
    if (!isCursorIndexedJsonlLine(rawLine) && !isCursorTurnEndedErrorLine(rawLine)) return;
    const line = parseJsonlLine(rawLine);
    if (!line) return;

    if (line.type === "turn_ended" && line.status === "error") {
      const errText = typeof line.error === "string" && line.error ? line.error : "Turn ended with error";
      events.push({ type: "tool_result", timestamp: null, toolUseId: null, text: capContent(errText, 1000), isError: true });
      return;
    }

    if (line.role === "user") {
      const text = extractPrompt(line.message?.content);
      if (text) {
        events.push({ type: "user", timestamp: null, text: capContent(text, 500) });
      }
    }

    if (!model && line.model) model = line.model;

    if (line.role === "assistant") {
      const content = Array.isArray(line.message?.content) ? line.message.content : [];
      const textBlocks = [];
      const thinkingBlocks = [];
      const toolCalls = [];
      for (const b of content) {
        if (b.type === "text") textBlocks.push(b.text);
        else if (b.type === "thinking" && b.thinking) thinkingBlocks.push(b.thinking);
        else if (b.type === "tool_use") {
          if (b.name === "Shell") {
            const wd = b.input?.working_directory;
            if (typeof wd === "string" && wd) {
              const entry = cwdCounts.get(wd);
              if (entry) entry.count += 1;
              else cwdCounts.set(wd, { count: 1, order: cwdCounts.size });
            }
          } else if (b.name === "SetActiveBranch" && gitBranch === null) {
            const branch = b.input?.branchName;
            if (typeof branch === "string" && branch) gitBranch = branch;
          }
          toolCalls.push(enrichToolEvent({ id: null, rawName: b.name, input: b.input }));
        }
      }
      const ev = {
        type: "assistant",
        timestamp: null,
        text: capContent(textBlocks.join("\n"), 500),
        toolCalls,
        tokens: { input: 0, output: 0, cacheHit: 0 },
      };
      if (thinkingBlocks.length > 0) {
        ev.thinking = thinkingBlocks.map(t => capContent(t, 2000));
      }
      events.push(ev);
    }
  });

  // Most frequent working_directory wins; ties broken by first occurrence.
  let cwd = null;
  let best = null;
  for (const [wd, { count, order }] of cwdCounts) {
    if (!best || count > best.count || (count === best.count && order < best.order)) {
      best = { count, order };
      cwd = wd;
    }
  }

  return { events, cwd, gitBranch, model };
}

/**
 * No event timestamps in Cursor JSONL → estimate session bounds from file
 * metadata (fact tln): birthtime → startTime, mtime → endTime.
 */
function applyCursorFileTimeFallback(session, filePath) {
  if (session.startTime !== null) return;
  const bounds = cursorFileTimeBounds(filePath);
  if (bounds) {
    session.startTime = new Date(bounds.startMs).toISOString();
    session.endTime = new Date(bounds.endMs).toISOString();
    session.durationMs = bounds.durationMs;
    session.timesEstimated = true;
  }
}

export function parseCursor(filePath) {
  const { events, cwd, gitBranch, model } = walkCursorTranscript(filePath);

  // Cursor transcripts carry no sessionId; the file basename is the session UUID.
  const session = buildSession({
    sessionId: basename(filePath, ".jsonl") || null,
    cwd,
    model: model || cursorModelFromStateDb(filePath) || "cursor",
    gitBranch,
    events,
    source: "cursor",
  });

  applyCursorFileTimeFallback(session, filePath);
  return session;
}

/**
 * Imported Cursor cloud-agent session (fact ccpp): local-cursor event semantics,
 * sessionId from the <agentId>.jsonl basename, startTime/endTime measured from the
 * session_meta createdAt/updatedAt (timesEstimated: false — file birthtime/mtime is
 * meaningless for downloaded artefacts). A file whose first line is not session_meta
 * degrades to the local-cursor file-time fallback.
 */
export function parseCursorCloud(filePath) {
  let meta = null;
  const { events, cwd, gitBranch, model } = walkCursorTranscript(filePath, {
    onSessionMeta(line) {
      meta = line;
    },
  });

  const session = buildSession({
    sessionId: basename(filePath, ".jsonl") || null,
    cwd,
    // session_meta.model before the "cursor-cloud" literal; never the local
    // cursor state.vscdb (fact ccmf).
    model: model || meta?.model || "cursor-cloud",
    gitBranch,
    events,
    source: "cursor-cloud",
  });

  const createdMs = meta?.createdAt ? Date.parse(meta.createdAt) : NaN;
  if (Number.isFinite(createdMs)) {
    const updatedMs = meta?.updatedAt ? Date.parse(meta.updatedAt) : NaN;
    const endMs = Number.isFinite(updatedMs) ? Math.max(createdMs, updatedMs) : createdMs;
    session.startTime = new Date(createdMs).toISOString();
    session.endTime = new Date(endMs).toISOString();
    session.durationMs = endMs - createdMs;
    session.timesEstimated = false;
  } else {
    applyCursorFileTimeFallback(session, filePath);
  }
  return session;
}
