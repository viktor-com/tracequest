/**
 * fx (vercel-labs/fx) sessions: ~/.fx/sessions/<id>/{session.json,events.jsonl}.
 *
 * events.jsonl rows are {schema_version, seq, timestamp_ms, event} where the
 * event object has one key naming its kind: user, assistant, tool_call,
 * tool_result, turn_completed, interrupted. fx writes a turn's rows together
 * when the turn ends, so every row of a turn carries the same timestamp_ms;
 * the turn's real bounds are turn_completed.turn_summary.started_at_ms and
 * completed_at_ms. While a turn runs, the directory holds owner.live and
 * recovery.json (checkpoint.user.text is the prompt being worked on).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { capContent, parseToolArgs, stripKandevContext } from "./parse-utils.js";
import { forEachJsonlLineFromFile, parseJsonlLine } from "./jsonl-read.js";
import { enrichToolEvent } from "./parse-enrich.js";
import { buildSession } from "./parse-session-build.js";
import { FX_EVENTS_FILE, FX_LIVE_MARKER } from "../sessions/session-layout.js";

/** fx tool names the shared normalizer does not know, mapped to the names it does. */
const FX_TOOL_ALIASES = { glob_files: "glob", grep_files: "grep", subagent: "agent" };

/** session.json of the fx session holding `eventsPath` ({} when unreadable). */
export function readFxSessionMeta(eventsPath) {
  try {
    return JSON.parse(readFileSync(join(dirname(eventsPath), "session.json"), "utf-8")) || {};
  } catch {
    return {};
  }
}

/** Parent session id of an fx subagent child (subagent/owner.json), or null. */
export function readFxParentId(sessionDir) {
  try {
    const owner = JSON.parse(readFileSync(join(sessionDir, "subagent", "owner.json"), "utf-8"));
    return typeof owner?.parent_id === "string" && owner.parent_id ? owner.parent_id : null;
  } catch {
    return null;
  }
}

/** The tool name and argument object fx recorded, mapped onto the shared tool vocabulary. */
export function fxToolCall(toolName, argumentsJson) {
  const args = parseToolArgs(argumentsJson);
  const rawName = FX_TOOL_ALIASES[toolName] || toolName;
  if (toolName === "subagent") {
    const task = args?.request?.task || args?.task || "";
    return { rawName, input: { prompt: task, description: task.split("\n")[0] } };
  }
  return { rawName, input: args };
}

/**
 * A tool result's display text and whether it failed. Shell results are a
 * JSON status object: its output plus a nonzero exit code. `fullText`, when given,
 * is the stored artifact (the preview can be cut short).
 */
export function fxToolResultText(result, fullText = null) {
  const raw = fullText ?? result?.preview ?? "";
  let text = raw;
  let exitCode = null;
  if (result?.tool_name === "shell" && raw.startsWith("{")) {
    const obj = parseJsonlLine(raw);
    if (obj && typeof obj === "object") {
      exitCode = Number.isInteger(obj.exit_code) ? obj.exit_code : null;
      const out = [obj.output_delta, obj.output, obj.error].filter((s) => typeof s === "string" && s).join("\n");
      text = out.replace(/\n$/, "");
      if (exitCode) text += `${text ? "\n" : ""}[exit code: ${exitCode}]`;
    }
  }
  const isError = (result?.status && result.status !== "success") || (exitCode !== null && exitCode !== 0);
  return { text, isError: Boolean(isError) };
}

/** Reasoning text fx keeps in an assistant row's provider replay, or "". */
function fxReasoning(assistant) {
  const parts = assistant?.provider_replay?.parts_json;
  if (typeof parts !== "string" || !parts.includes('"reasoning"')) return "";
  const obj = parseJsonlLine(parts);
  return typeof obj?.reasoning === "string" ? obj.reasoning : "";
}

/** Every events.jsonl row of an fx session in file order. */
export function forEachFxEvent(eventsPath, onRow) {
  forEachJsonlLineFromFile(eventsPath, (rawLine) => {
    const row = parseJsonlLine(rawLine);
    if (!row || typeof row.event !== "object" || !row.event) return;
    const kind = Object.keys(row.event)[0];
    if (kind) onRow(kind, row.event[kind], row);
  });
}

/**
 * True while an fx turn runs: owner.live exists and is no older than
 * events.jsonl. The age check matters for imported copies, which keep a
 * marker the next turn end removed remotely (import ssh never deletes).
 */
export function fxTurnRunning(sessionDir) {
  let marker;
  try {
    marker = statSync(join(sessionDir, FX_LIVE_MARKER));
  } catch {
    return false;
  }
  try {
    return marker.mtimeMs >= statSync(join(sessionDir, FX_EVENTS_FILE)).mtimeMs;
  } catch {
    return true;
  }
}

/** The in-flight prompt of a running fx turn (fxTurnRunning), or null. */
export function fxInFlightPrompt(sessionDir) {
  if (!fxTurnRunning(sessionDir)) return null;
  const recoveryPath = join(sessionDir, "recovery.json");
  try {
    const recovery = JSON.parse(readFileSync(recoveryPath, "utf-8"));
    const text = recovery?.checkpoint?.user?.text;
    if (typeof text !== "string" || !text.trim()) return null;
    return { text, timestamp: statSync(recoveryPath).mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Parse an fx session. `filePath` is its events.jsonl. `opts.artifacts`
 * (default true) reads each tool result's stored artifact for its full text.
 */
export function parseFx(filePath, opts = {}) {
  const readArtifacts = opts.artifacts !== false;
  const sessionDir = dirname(filePath);
  const meta = readFxSessionMeta(filePath);
  const events = [];
  let model = typeof meta.model === "string" ? meta.model : null;
  let n = 0;

  /** Events of the turn being read; their timestamps are set when it ends. */
  let turn = [];
  let assistant = null;

  const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);
  const closeTurn = (startMs, endMs, tokens) => {
    for (const e of turn) e.timestamp = iso(e.type === "user" ? startMs : endMs);
    if (tokens) {
      for (let i = turn.length - 1; i >= 0; i--) {
        if (turn[i].type === "assistant") {
          turn[i].tokens = tokens;
          break;
        }
      }
    }
    events.push(...turn);
    turn = [];
    assistant = null;
  };

  if (existsSync(filePath)) {
    forEachFxEvent(filePath, (kind, ev, row) => {
      if (kind === "user") {
        assistant = null;
        // Kandev puts its <kandev-system> preamble ahead of the first prompt.
        const text = typeof ev.text === "string" ? stripKandevContext(ev.text.trim()).trim() : "";
        if (text) turn.push({ type: "user", timestamp: null, text: capContent(text, 500), uuid: `fx-user-${n++}`, _ms: row.timestamp_ms });
      } else if (kind === "assistant") {
        const m = ev.provider_replay?.source?.model;
        if (m) model = m;
        assistant = {
          type: "assistant", timestamp: null, text: capContent(ev.text || "", 500), toolCalls: [],
          tokens: { input: 0, output: 0, cacheHit: 0, cacheWrite: 0 }, stopReason: "end_turn", uuid: `fx-asst-${n++}`,
        };
        const reasoning = fxReasoning(ev);
        if (reasoning) assistant.thinking = [capContent(reasoning, 2000)];
        turn.push(assistant);
      } else if (kind === "tool_call") {
        if (!assistant) {
          assistant = {
            type: "assistant", timestamp: null, text: "", toolCalls: [],
            tokens: { input: 0, output: 0, cacheHit: 0, cacheWrite: 0 }, stopReason: "tool_use", uuid: `fx-asst-${n++}`,
          };
          turn.push(assistant);
        }
        const { rawName, input } = fxToolCall(ev.tool_name, ev.arguments_json);
        assistant.toolCalls.push(enrichToolEvent({ id: ev.call_id, rawName, input }));
        assistant.stopReason = "tool_use";
      } else if (kind === "tool_result") {
        assistant = null;
        let full = null;
        if (readArtifacts && ev.artifact_ref && ev.stored_bytes > (ev.preview || "").length) {
          try {
            full = readFileSync(join(sessionDir, "tool-results", ev.artifact_ref), "utf-8");
          } catch {
            full = null;
          }
        }
        const { text, isError } = fxToolResultText(ev, full);
        turn.push({
          type: "tool_result", timestamp: null, toolUseId: ev.call_id, text: capContent(text, 1000),
          isError, errorConfirmed: isError, uuid: `fx-result-${n++}`,
        });
      } else if (kind === "turn_completed") {
        const s = ev.turn_summary || {};
        const tp = s.token_progress;
        const tokens = tp ? { input: tp.input_tokens || 0, output: tp.output_tokens || 0, cacheHit: 0, cacheWrite: 0 } : null;
        closeTurn(s.started_at_ms ?? row.timestamp_ms, s.completed_at_ms ?? row.timestamp_ms, tokens);
      } else if (kind === "interrupted") {
        if (ev.partial_text) {
          turn.push({
            type: "assistant", timestamp: null, text: capContent(ev.partial_text, 500), toolCalls: [],
            tokens: { input: 0, output: 0, cacheHit: 0, cacheWrite: 0 }, stopReason: "interrupted", uuid: `fx-asst-${n++}`,
          });
        }
        const s = ev.turn_summary || {};
        closeTurn(s.started_at_ms ?? row.timestamp_ms, s.completed_at_ms ?? row.timestamp_ms, null);
      }
    });
  }
  // Rows after the last turn end (none in a well-formed file) keep their row time.
  if (turn.length) closeTurn(turn[0]._ms, turn[turn.length - 1]._ms, null);
  for (const e of events) delete e._ms;

  const inFlight = fxInFlightPrompt(sessionDir);
  if (inFlight) {
    events.push({ type: "user", timestamp: iso(inFlight.timestamp), text: capContent(inFlight.text.trim(), 500), uuid: `fx-user-${n++}` });
  }

  return buildSession({
    sessionId: meta.id || null,
    cwd: meta.workspace_root || meta.origin_workspace_root || null,
    model: model || "fx",
    gitBranch: null,
    events,
    source: "fx",
  });
}
