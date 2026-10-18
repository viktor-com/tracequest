/**
 * Index entries for fx and DeepSeek Harness (dsh) recordings: the same
 * fields the other indexers store, read with the parsers' own helpers so the
 * list row and the session view agree. Rust twins: index_fx and index_dsh in
 * sidecar/src/indexer.rs.
 *
 * Worked time: fx stamps every row of a turn with the turn's end, but records
 * each turn's turn_duration_ms, so an fx session's duration is their sum. dsh
 * stamps every row, so its duration is the active span over those rows.
 */
import { normalizeToolName } from "../parse/parse-enrich.js";
import { foldNewlines, stripKandevContext, truncateFirstPrompt } from "../parse/parse-utils.js";
import { forEachFxEvent, fxToolCall, fxToolResultText, readFxSessionMeta } from "../parse/parse-fx.js";
import { dshContentText, dshToolCall, dshToolResult, forEachDshRow, isDshPromptRow } from "../parse/parse-dsh.js";
import { isIndexDiskExpectedErr } from "../utils/fs-expected-err.js";
import { buildIndexMetaFromState, createIndexState, emptyIndexMeta, pushIndexSearchChunk, trackIndexTool } from "./session-meta.js";
import { addActiveRecord, ASSISTANT, noteToolCall, OTHER, TOOL_RESULT, TOOL_WAIT, USER } from "./active-time.js";

const GIT_COMMIT_RE = /\bgit\b.*\bcommit\b/i;

function addPrompt(state, text) {
  const clean = foldNewlines(stripKandevContext(String(text).trim())).trim();
  if (!clean) return;
  if (!state.firstPrompt) state.firstPrompt = truncateFirstPrompt(clean);
  state.chapters++;
  pushIndexSearchChunk(state, clean);
}

/** Count one tool call: its normalized name, the file it names, a git commit. */
function addToolCall(state, rawName, input) {
  const name = normalizeToolName(rawName);
  trackIndexTool(state, name);
  state.toolCounts[name] = (state.toolCounts[name] || 0) + 1;
  const fp = input?.file_path || input?.path;
  if (typeof fp === "string" && fp) state.files.add(fp);
  if (name === "Bash" && GIT_COMMIT_RE.test(input?.command || "")) state.commits++;
}

function finish(state) {
  return buildIndexMetaFromState(state, {
    durationMs: state.workedMs ?? undefined,
    tokens: {
      totalTokens: state.inputTokens + state.cacheReadTokens + state.outputTokens,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      cacheReadTokens: state.cacheReadTokens,
    },
  });
}

/** Index an fx session (its events.jsonl). */
export function indexFx(eventsPath) {
  try {
    const state = createIndexState();
    state.workedMs = 0;
    const meta = readFxSessionMeta(eventsPath);
    if (typeof meta.model === "string") state.model = meta.model;
    forEachFxEvent(eventsPath, (kind, ev) => {
      if (kind === "user") {
        addPrompt(state, ev.text || "");
      } else if (kind === "assistant") {
        if (ev.provider_replay?.source?.model) state.model = ev.provider_replay.source.model;
        if (ev.text) pushIndexSearchChunk(state, foldNewlines(ev.text));
      } else if (kind === "tool_call") {
        const { rawName, input } = fxToolCall(ev.tool_name, ev.arguments_json);
        addToolCall(state, rawName, input);
      } else if (kind === "tool_result") {
        if (fxToolResultText(ev).isError) state.errors++;
      } else if (kind === "turn_completed" || kind === "interrupted") {
        const s = ev.turn_summary;
        if (Number.isFinite(s?.turn_duration_ms)) state.workedMs += s.turn_duration_ms;
        const tp = s?.token_progress;
        if (tp) {
          state.inputTokens += tp.input_tokens || 0;
          state.outputTokens += tp.output_tokens || 0;
        }
      }
    });
    if (!state.model) state.model = "fx";
    return finish(state);
  } catch (err) {
    if (!isIndexDiskExpectedErr(err)) console.error(`indexFx: failed to index ${eventsPath}:`, err.message);
    return emptyIndexMeta();
  }
}

/** Index a dsh recording (session.v<N>.jsonl.zstd or .jsonl). */
export function indexDsh(filePath) {
  try {
    const state = createIndexState();
    const span = state.activeSpan;
    forEachDshRow(filePath, (row) => {
      const data = row.data || {};
      let kind = OTHER;
      if (row.type === "user/message") {
        if (isDshPromptRow(row)) {
          kind = USER;
          addPrompt(state, dshContentText(data.content));
        }
      } else if (row.type === "assistant/message") {
        kind = ASSISTANT;
        const msg = data.message || {};
        if (msg.source?.model) state.model = msg.source.model;
        for (const part of Array.isArray(msg.content) ? msg.content : []) {
          if (part?.type === "text" && part.text) pushIndexSearchChunk(state, foldNewlines(part.text));
          else if (part?.type === "tool-call") {
            const { rawName, input } = dshToolCall(part.name, part.arguments);
            addToolCall(state, rawName, input);
            noteToolCall(span, part.id, rawName);
          }
        }
        const u = data.usage || {};
        state.inputTokens += u.inputTokens || 0;
        state.outputTokens += u.outputTokens || 0;
        state.cacheReadTokens += u.cacheReadTokens || 0;
      } else if (row.type === "tool/result") {
        const { id, isError } = dshToolResult(row);
        if (isError) state.errors++;
        kind = span.waits.get(id) ? TOOL_WAIT : TOOL_RESULT;
      } else if (row.type === "turn/end" && data.reason?.kind === "error") {
        state.errors++;
      }
      addActiveRecord(span, row.type === "session" ? row.createdAt : row.time, kind);
    });
    if (!state.model) state.model = "dsh";
    return finish(state);
  } catch (err) {
    if (!isIndexDiskExpectedErr(err)) console.error(`indexDsh: failed to index ${filePath}:`, err.message);
    return emptyIndexMeta();
  }
}
