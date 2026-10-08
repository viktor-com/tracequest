import { closeSync, fstatSync, openSync, readFileSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { forEachJsonlLine, parseJsonlLine } from "../parse/jsonl-read.js";
import { isIndexDiskExpectedErr, isProcRaceErr } from "../utils/fs-expected-err.js";
import { openOpenCodeDbReadOnly } from "./session-discovery-paths.js";

/** Last bytes of a JSONL used to classify generating vs idle. The opening token may have aged out. */
const TAIL_BYTES = 131072;
/** Walk back this far so a last record larger than TAIL_BYTES is still parsed. */
const LAST_RECORD_MAX = 2 * 1024 * 1024;

const GROK_LIVE_PHASE = /^(waiting_for_model|streaming_|tool_execution|permission_prompt)/;
const CLAUDE_IDLE_STOP = new Set(["end_turn", "stop_sequence", "max_tokens"]);

function tryStat(path) {
  try {
    return statSync(path);
  } catch (err) {
    if (isIndexDiskExpectedErr(err) || isProcRaceErr(err)) return null;
    return null;
  }
}

/** Byte offset of the line containing `from`, or -1 if that line exceeds `maxExtra`. */
function findLineStart(fd, from, maxExtra) {
  const CHUNK = 65536;
  let pos = from;
  const limit = Math.max(0, from - maxExtra);
  const buf = Buffer.allocUnsafe(CHUNK);
  while (pos > limit) {
    const readStart = Math.max(limit, pos - CHUNK);
    const n = readSync(fd, buf, 0, pos - readStart, readStart);
    if (n <= 0) break;
    const nl = buf.subarray(0, n).lastIndexOf(0x0a);
    if (nl !== -1) return readStart + nl + 1;
    pos = readStart;
  }
  return limit === 0 ? 0 : -1;
}

/**
 * Last `maxBytes` of a JSONL file. `midWrite` is true when the last non-empty
 * line does not parse — the agent is appending a record (growing jsonl).
 * The last record is included even when it is larger than `maxBytes`.
 */
export function readJsonlTail(filePath, maxBytes = TAIL_BYTES) {
  let fd;
  try {
    fd = openSync(filePath, "r");
    const size = fstatSync(fd).size;
    if (size <= 0) return { objs: [], midWrite: false };
    let start = Math.max(0, size - maxBytes);
    let aligned = start === 0;
    if (start > 0) {
      const lineStart = findLineStart(fd, start, LAST_RECORD_MAX);
      if (lineStart >= 0 && size - lineStart <= LAST_RECORD_MAX) {
        start = lineStart;
        aligned = true;
      }
    }
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    const n = readSync(fd, buf, 0, len, start);
    if (n <= 0) return { objs: [], midWrite: false };
    let text = buf.toString("utf-8", 0, n);
    if (!aligned) {
      const nl = text.indexOf("\n");
      if (nl === -1 || nl === text.length - 1) return { objs: [], midWrite: true };
      text = text.slice(nl + 1);
      if (!text) return { objs: [], midWrite: true };
    }
    const objs = [];
    let lastLine = "";
    forEachJsonlLine(text, (line) => {
      lastLine = line;
      try {
        objs.push(JSON.parse(line));
      } catch {
        /* incomplete last line mid-write, or filler */
      }
    });
    let midWrite = false;
    if (lastLine.trim()) {
      try {
        JSON.parse(lastLine);
      } catch {
        midWrite = true;
      }
    }
    return { objs, midWrite };
  } catch (err) {
    if (!isIndexDiskExpectedErr(err) && !isProcRaceErr(err)) {
      /* missing recordings are idle, not an error */
    }
    return { objs: [], midWrite: false };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Parsed objects from the last `maxBytes` of a JSONL file ([] when missing). */
export function readJsonlTailObjects(filePath, maxBytes = TAIL_BYTES) {
  return readJsonlTail(filePath, maxBytes).objs;
}

function jsonlPathIsGenerating(filePath, classify) {
  const { objs, midWrite } = readJsonlTail(filePath);
  if (midWrite) return true;
  return classify(objs);
}

function contentBlocks(obj) {
  const content = obj?.message?.content ?? obj?.content;
  return Array.isArray(content) ? content : [];
}

function assistantToolIds(obj) {
  const ids = [];
  for (const b of contentBlocks(obj)) {
    if (b?.type === "tool_use") ids.push(b.id || true);
  }
  const calls = obj?.tool_calls;
  if (Array.isArray(calls)) {
    for (const tc of calls) ids.push(tc?.id || true);
  }
  return ids;
}

function consumeToolResults(obj, pending) {
  const id = obj?.tool_call_id || obj?.toolUseId;
  if (id) pending.delete(id);
  for (const b of contentBlocks(obj)) {
    if (b?.type === "tool_result") {
      if (b.tool_use_id) pending.delete(b.tool_use_id);
      else pending.clear();
    }
  }
}

export function grokEventsAreGenerating(objs) {
  let lastBoundary = null;
  let openTools = 0;
  let lastPhaseLive = false;
  for (const o of objs) {
    if (o?.type === "turn_started") {
      lastBoundary = "started";
      lastPhaseLive = false;
    } else if (o?.type === "turn_ended") {
      lastBoundary = "ended";
      lastPhaseLive = false;
    } else if (o?.type === "tool_started") {
      openTools++;
    } else if (o?.type === "tool_completed") {
      openTools = Math.max(0, openTools - 1);
    } else if (o?.type === "phase_changed" && o.phase) {
      lastPhaseLive = GROK_LIVE_PHASE.test(o.phase);
    }
  }
  if (openTools > 0 || lastPhaseLive) return true;
  if (objs.length === 0) return false;
  // Start may have aged out of the tail; live unless a closing boundary is visible.
  return lastBoundary !== "ended";
}

export function grokChatHasUnmatchedTools(objs) {
  const pending = new Set();
  for (const o of objs) {
    if (o?.type === "assistant") {
      for (const id of assistantToolIds(o)) pending.add(id);
    } else if (o?.type === "tool_result" || o?.type === "tool") {
      consumeToolResults(o, pending);
    }
  }
  return pending.size > 0;
}

function assistantContentEmpty(obj) {
  const content = obj?.content;
  if (content == null || content === "") return true;
  if (Array.isArray(content) && content.length === 0) return true;
  return false;
}

/** Chat-history generating: unmatched tools, last user, in-progress reasoning, or empty streaming assistant. */
export function grokChatIsGenerating(objs) {
  if (grokChatHasUnmatchedTools(objs)) return true;
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i];
    if (!o?.type) continue;
    if (o.type === "reasoning") {
      const st = String(o.status || "").toLowerCase();
      return !st || (st !== "completed" && st !== "success");
    }
    if (o.type === "assistant") {
      if (Array.isArray(o.tool_calls) && o.tool_calls.length) return false;
      return assistantContentEmpty(o);
    }
    if (o.type === "user") return true;
    if (o.type === "tool_result" || o.type === "tool") return false;
  }
  return false;
}

function grokUpdatesAreGenerating(objs) {
  for (let i = objs.length - 1; i >= 0; i--) {
    const upd = objs[i]?.params?.update;
    if (!upd) continue;
    const kind = upd.sessionUpdate;
    if (kind === "turn_completed") return false;
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") return true;
    if (kind === "tool_call") {
      const st = String(upd.status || "pending").toLowerCase();
      return st !== "completed" && st !== "success";
    }
    if (kind === "tool_call_update") {
      const st = String(upd.status || "").toLowerCase();
      if (st && st !== "completed" && st !== "success" && st !== "failed") return true;
      continue;
    }
    if (kind === "hook_execution" || kind === "plan" || kind === "subagent_spawned") continue;
  }
  return false;
}

function grokHasRunningSubagent(sessionDir) {
  const dir = join(sessionDir, "subagents");
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (!isIndexDiskExpectedErr(err)) return false;
    return false;
  }
  for (const name of names) {
    try {
      const meta = JSON.parse(readFileSync(join(dir, name, "meta.json"), "utf-8"));
      if (meta?.status === "running") return true;
    } catch {
      /* skip unreadable child */
    }
  }
  return false;
}

function mixedJsonlIsGenerating(objs) {
  return grokEventsAreGenerating(objs)
    || grokChatIsGenerating(objs)
    || claudeJsonlIsGenerating(objs)
    || cursorJsonlIsGenerating(objs)
    || codexJsonlIsGenerating(objs)
    || factoryJsonlIsGenerating(objs);
}

export function grokSessionIsGenerating(sessionDir) {
  const st = tryStat(sessionDir);
  if (!st) return false;
  if (st.isFile()) {
    const tail = readJsonlTail(sessionDir);
    return tail.midWrite || mixedJsonlIsGenerating(tail.objs);
  }
  if (grokHasRunningSubagent(sessionDir)) return true;
  const events = readJsonlTail(join(sessionDir, "events.jsonl"));
  if (events.midWrite || grokEventsAreGenerating(events.objs)) return true;
  const chat = readJsonlTail(join(sessionDir, "chat_history.jsonl"));
  if (chat.midWrite || grokChatIsGenerating(chat.objs)) return true;
  const updates = readJsonlTail(join(sessionDir, "updates.jsonl"));
  if (updates.midWrite || grokUpdatesAreGenerating(updates.objs)) return true;
  return false;
}

export function claudeJsonlIsGenerating(objs) {
  const pending = new Set();
  let lastRole = null;
  let lastStop = null;
  for (const o of objs) {
    if (o?.type === "assistant") {
      lastRole = "assistant";
      lastStop = o.message?.stop_reason ?? o.stop_reason ?? null;
      const ids = assistantToolIds(o);
      if (ids.length) {
        for (const id of ids) pending.add(id);
        if (!lastStop) lastStop = "tool_use";
      }
    } else if (o?.type === "user") {
      lastRole = "user";
      consumeToolResults(o, pending);
    } else if (o?.subtype === "away_summary" || o?.subtype === "turn_duration") {
      if (!lastStop) lastStop = "end_turn";
    }
  }
  if (pending.size > 0) return true;
  if (lastRole === "user") return true;
  if (lastRole === "assistant") {
    if (!lastStop) return true;
    return !CLAUDE_IDLE_STOP.has(lastStop);
  }
  return false;
}

function claudeSidecarStatus(home, pid) {
  if (!home || pid == null || pid === "") return null;
  try {
    const raw = readFileSync(join(home, ".claude", "sessions", `${pid}.json`), "utf-8");
    const obj = parseJsonlLine(raw.trim()) ?? JSON.parse(raw);
    return typeof obj?.status === "string" ? obj.status : null;
  } catch {
    return null;
  }
}

export function claudeSessionIsGenerating(jsonlPath, extra = {}) {
  const status = claudeSidecarStatus(extra.home, extra.pid);
  // Non-idle sidecar is live (first-token gap). Idle is not a veto of generating jsonl.
  if (status && status !== "idle") return true;
  return jsonlPathIsGenerating(jsonlPath, claudeJsonlIsGenerating);
}

export function cursorJsonlIsGenerating(objs) {
  let lastTurnEnded = false;
  let sawTurn = false;
  for (const o of objs) {
    if (o?.type === "turn_ended") {
      lastTurnEnded = true;
      continue;
    }
    if (o?.role === "assistant" || o?.role === "user" || o?.type === "assistant" || o?.type === "user") {
      lastTurnEnded = false;
      sawTurn = true;
    }
  }
  if (lastTurnEnded) return false;
  if (!sawTurn) return mixedPendingTools(objs);
  return true;
}

function mixedPendingTools(objs) {
  return grokChatHasUnmatchedTools(objs) || claudeJsonlIsGenerating(objs) || factoryJsonlIsGenerating(objs);
}

export function codexJsonlIsGenerating(objs) {
  let openTasks = 0;
  let pendingTools = 0;
  let lastBoundary = null;
  let streaming = false;
  for (const o of objs) {
    if (o?.type === "stream_chunk") {
      if (lastBoundary !== "ended") streaming = true;
      continue;
    }
    const ptype = o?.type === "event_msg" ? o.payload?.type : null;
    const rtype = o?.type === "response_item" ? o.payload?.type : null;
    if (ptype === "task_started") {
      openTasks++;
      lastBoundary = "started";
      streaming = true;
    } else if (ptype === "task_complete" || ptype === "task_completed" || ptype === "turn_aborted") {
      openTasks = Math.max(0, openTasks - 1);
      lastBoundary = "ended";
      streaming = false;
    } else if (ptype === "stream_chunk" || ptype === "agent_message") {
      if (lastBoundary !== "ended") streaming = true;
    }
    if (rtype === "custom_tool_call" || rtype === "function_call" || rtype === "web_search_call") {
      const st = o.payload?.status;
      if (st && st !== "completed" && st !== "success") pendingTools++;
      else if (!st) pendingTools++;
    } else if (rtype === "custom_tool_call_output" || rtype === "function_call_output") {
      pendingTools = Math.max(0, pendingTools - 1);
    } else if (rtype === "reasoning" && lastBoundary !== "ended") {
      streaming = true;
    }
  }
  if (openTasks > 0 || pendingTools > 0 || streaming) return true;
  if (objs.length === 0) return false;
  // Start may have aged out of the tail; live unless a closing task_complete is visible.
  return lastBoundary !== "ended";
}

export function factoryJsonlIsGenerating(objs) {
  const pending = new Set();
  let lastRole = null;
  let unmatchedTool = false;
  for (const o of objs) {
    if (o?.type && o.type !== "message") continue;
    const role = o?.message?.role || o?.role;
    if (role === "assistant") {
      lastRole = "assistant";
      const ids = assistantToolIds(o);
      unmatchedTool = ids.length > 0;
      for (const id of ids) pending.add(id);
    } else if (role === "user") {
      lastRole = "user";
      const before = pending.size;
      consumeToolResults(o, pending);
      if (pending.size < before || contentBlocks(o).some((b) => b?.type === "tool_result")) unmatchedTool = false;
    }
  }
  if (pending.size > 0 || unmatchedTool) return true;
  return lastRole === "user";
}

function parseOpenCodePart(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string") return null;
  try {
    const part = JSON.parse(raw);
    return part && typeof part === "object" ? part : null;
  } catch {
    return null;
  }
}

function openCodePartStillOpen(part) {
  const type = part.type;
  if (type !== "text" && type !== "reasoning") return false;
  const t = part.time;
  if (!t || typeof t !== "object") return false;
  return t.end == null && t.completed == null;
}

function openCodePartsPending(parts) {
  let starts = 0;
  let finishes = 0;
  for (const raw of parts) {
    const part = parseOpenCodePart(raw);
    if (!part) continue;
    if (part.type === "tool") {
      const st = String(part.state?.status || part.status || "").toLowerCase();
      if (st && st !== "completed" && st !== "success" && st !== "error") return true;
      if (!st) return true;
    }
    if (part.type === "step-start" || part.type === "step_start") starts++;
    else if (part.type === "step-finish" || part.type === "step_finish") finishes++;
    if (openCodePartStillOpen(part)) return true;
  }
  return starts > finishes;
}

function openCodeMessageFinished(data) {
  if (!data || typeof data !== "object") return false;
  if (data.finish) return true;
  const completed = data.time?.completed ?? data.time?.end;
  return completed != null && completed !== "";
}

export function openCodeSessionIsGenerating(uri, home) {
  const sessionId = String(uri || "").replace(/^opencode:\/\//, "");
  if (!sessionId) return false;
  let db;
  try {
    ({ db } = openOpenCodeDbReadOnly(home));
  } catch {
    return false;
  }
  try {
    let row = null;
    try {
      row = db.prepare(
        "SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created DESC, rowid DESC LIMIT 1",
      ).get(sessionId);
    } catch {
      row = null;
    }
    if (!row) {
      try {
        const rows = db.prepare("SELECT role, content FROM message WHERE session_id = ?").all(sessionId);
        row = rows.length ? rows[rows.length - 1] : null;
      } catch {
        return false;
      }
    }
    if (!row) return false;
    let role = row.role;
    let data = null;
    if (row.data) {
      try { data = JSON.parse(row.data); } catch { data = null; }
      if (!role && data?.role) role = data.role;
    }
    if (role === "user") return true;
    if (role !== "assistant") return false;
    if (!row.id) return false;
    let parts = [];
    try {
      parts = db.prepare("SELECT data FROM part WHERE message_id = ?").all(row.id).map((p) => p.data);
    } catch {
      parts = [];
    }
    if (openCodePartsPending(parts)) return true;
    if (openCodeMessageFinished(data)) return false;
    // Last assistant without time.completed/finish: streaming text or first token.
    return true;
  } catch {
    return false;
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

/** True when the mapped recording currently shows a generating or tool-executing turn. */
export function recordingIsGenerating(source, path, extra = {}) {
  if (!path) return false;
  switch (source) {
    case "grok": return grokSessionIsGenerating(path);
    case "claude": return claudeSessionIsGenerating(path, extra);
    case "cursor": return jsonlPathIsGenerating(path, cursorJsonlIsGenerating);
    case "codex": return jsonlPathIsGenerating(path, codexJsonlIsGenerating);
    case "factory": return jsonlPathIsGenerating(path, factoryJsonlIsGenerating);
    case "opencode": return openCodeSessionIsGenerating(path, extra.home);
    default: return false;
  }
}
