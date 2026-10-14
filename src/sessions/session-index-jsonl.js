import { claudeUsageDelta, billingTokenUsage, addTokenUsage } from "../parse/token-accounting.js";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { isIndexDiskExpectedErr } from "../utils/fs-expected-err.js";
import { errorPattern, normalizeToolName } from "../parse/parse-enrich.js";
import {
  codexIndexedLineKind,
  codexProvenanceModel,
  codexSubThreadItem,
  codexSubThreadItemText,
  codexThreadSettingsModel,
  isCodexDisplayableUserText,
  isCodexIndexSkippableLine,
  isCodexIndexedJsonlLine,
  normalizeCodexUserPromptText,
  resolveCodexModel,
  visitCodexEventMsgPayload,
} from "../parse/codex-event-msg.js";
import {
  accumulateCodexContentFunctionCall,
  accumulateCodexEventMsgPayload,
  accumulateCodexResponseItemPayload,
} from "./accumulate-codex-payload.js";
import {
  forEachJsonlLine,
  forEachJsonlLineFromFile,
  parseJsonlLine,
  parseJsonlLineAt,
} from "../parse/jsonl-read.js";
import {
  collapseWhitespace,
  foldNewlines,
  parseEscapedJsonString,
  parseToolArgs,
  rollupClaudeUsage,
  safeSlice,
  truncateFirstPrompt,
} from "../parse/parse-utils.js";
import {
  claudeIndexedLineKind,
  isClaudeFallbackSearchLine,
  isClaudeIndexSkippableLine,
  isClaudeIndexedJsonlLine,
  visitClaudeUserPrompt,
  isCursorIndexedJsonlLine,
  isCursorIndexSkippableLine,
  isCursorCloudMetaLine,
  isCursorTurnEndedErrorLine,
  cursorIndexedLineKind,
  visitCursorUserPrompt,
  cursorFileTimeBounds,
} from "../parse/claude-jsonl-index.js";
import {
  isGrokChatIndexedLine,
  isGrokEventsIndexedLine,
  visitGrokChatHistoryLine,
  visitGrokEventsObj,
} from "../parse/grok-chat-index.js";
import {
  factoryIndexedLineKind,
  isFactoryIndexSkippableLine,
  visitFactoryAssistantBlocks,
  visitFactoryUserTextBlocks,
} from "../parse/parse-factory.js";
import { extractPrompt } from "./extract-prompt.js";
import {
  emptyIndexMeta,
  createIndexState,
  buildIndexMetaFromState,
  pushIndexSearchChunk,
  trackIndexTool,
} from "./session-meta.js";
import { cursorModelFromStateDb } from "./cursor-state-db.js";
import {
  addActiveRecord,
  claudeRecordKind,
  codexRecordKind,
  createActiveSpan,
  factoryRecordKind,
  grokEventKind,
  OTHER,
  workedMsOfSpan,
} from "./active-time.js";

export { extractPrompt, emptyIndexMeta };

const MAX_FALLBACK_STRINGS = 100;

function looksLikeCodeOrPath(str) {
  if (/^\s*\/[-._a-zA-Z0-9\/]+\s*$/.test(str)) return true;
  if (/^https?:\/\//.test(str)) return true;
  if (/^[0-9a-f]{32,}$/i.test(str)) return true;
  if (/^[A-Za-z0-9+/]{40,}={0,2}$/.test(str)) return true;
  if (/^\{[\s\S]*\}$/.test(str) || /^\[[\s\S]*\]$/.test(str)) return true;
  const nonWord = str.replace(/[\w\s]/g, "").length;
  if (nonWord / str.length > 0.7) return true;
  return false;
}

const TEXT_KEYS = new Set([
  "content", "text", "thinking", "output", "result", "error", "stderr", "stdout",
  "message", "prompt", "description", "query", "command", "response", "lastPrompt",
]);

/** Gate fallback JSON.parse: only lines that may contain TEXT_KEYS (skip progress/data filler). */
const FALLBACK_TEXT_KEY_RE =
  /"(?:text|content|message|command|thinking|output|result|error|stderr|stdout|prompt|description|query|response|lastPrompt)"/;

function lineMightHaveFallbackText(line) {
  return FALLBACK_TEXT_KEY_RE.test(line);
}

function extractTextFromMessage(obj, texts, depth = 0) {
  if (depth > 8 || texts.size >= MAX_FALLBACK_STRINGS) return;
  if (typeof obj === "string") {
    const trimmed = obj.trim();
    if (trimmed.length >= 30 && !looksLikeCodeOrPath(trimmed)) {
      texts.add(collapseWhitespace(trimmed));
    }
    return;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) extractTextFromMessage(item, texts, depth + 1);
    return;
  }
  if (obj && typeof obj === "object") {
    for (const key of Object.keys(obj)) {
      if (TEXT_KEYS.has(key)) {
        extractTextFromMessage(obj[key], texts, depth + 1);
      }
    }
  }
}

/** Epoch ms of an ISO timestamp, reusing the previous parse for a repeated string. */
function timestampMs(state, ts) {
  if (ts !== state._lastTs) {
    state._lastTs = ts;
    state._lastTsMs = Date.parse(ts);
  }
  return state._lastTsMs;
}

function accumulateTimestamp(line, state, timestampOnlyIfIncludes, recordKind) {
  if (timestampOnlyIfIncludes && !line.includes('"timestamp"')) return;
  const tsMatch = line.match(/"timestamp":\s*"([^"]+)"/);
  if (!tsMatch) return;
  // Every timestamped line is a record of the session's worked time (fact durac).
  addActiveRecord(state.activeSpan, timestampMs(state, tsMatch[1]), recordKind ? recordKind(line, state.activeSpan) : OTHER);
}

function accumulateToolUse(line, state) {
  if (!line.includes('"tool_use"')) return;
  for (const m of line.matchAll(/"type":\s*"tool_use"[^}]*?"name":\s*"([^"]+)"/g)) {
    const tn = normalizeToolName(m[1]);
    trackIndexTool(state, tn);
    state.toolCounts[tn] = (state.toolCounts[tn] || 0) + 1;
  }
  if (line.includes('"file_path"')) {
    for (const m of line.matchAll(/"file_path":\s*"([^"]+)"/g)) {
      state.files.add(m[1]);
    }
  }
  if (line.includes('"command"')) {
    for (const m of line.matchAll(/"command":\s*"((?:[^"\\]|\\.)*)"/g)) {
      const cmd = parseEscapedJsonString(m[1]);
      if (cmd && /\bgit\b.*\bcommit\b/i.test(cmd)) state.commits++;
    }
  }
}

function accumulateErrors(line, state, extractToolResultChunks) {
  if (line.includes('"is_error":true') || line.includes('"is_error": true')) {
    state.errors++;
    return;
  }
  if (!line.includes('"tool_result"')) return;
  for (const m of line.matchAll(/"text":\s*"((?:[^"\\]|\\.)*)"/g)) {
    const text = parseEscapedJsonString(m[1]);
    if (text && errorPattern.test(text)) {
      state.errors++;
      break;
    }
  }
  if (!extractToolResultChunks) return;
  for (const m of line.matchAll(/"text":\s*"((?:[^"\\]|\\.){30,500})"/g)) {
    const text = parseEscapedJsonString(m[1]);
    if (text && text.trim().length >= 30) {
      pushIndexSearchChunk(state, safeSlice(text.trim(), 500));
    }
  }
}

function accumulateAssistantTokensAndText(line, state, parsedObj) {
  if (line.includes('"input_tokens"')) {
    let rolled;
    if (state.claudeUsageSeen) {
      rolled = claudeUsageDelta(parsedObj, state.claudeUsageSeen);
    } else {
      const usage = {};
      const tokMatch = line.match(/"input_tokens":\s*(\d+)/);
      const outMatch = line.match(/"output_tokens":\s*(\d+)/);
      const cacheMatch = line.match(/"cache_read_input_tokens":\s*(\d+)/);
      const cacheWriteMatch = line.match(/"cache_creation_input_tokens":\s*(\d+)/);
      if (tokMatch) usage.input_tokens = parseInt(tokMatch[1], 10);
      if (outMatch) usage.output_tokens = parseInt(outMatch[1], 10);
      if (cacheMatch) usage.cache_read_input_tokens = parseInt(cacheMatch[1], 10);
      if (cacheWriteMatch) usage.cache_creation_input_tokens = parseInt(cacheWriteMatch[1], 10);
      rolled = rollupClaudeUsage(usage);
    }
    if (state.claudeUsageSeen) {
      state.billingTokens = addTokenUsage(state.billingTokens || {}, billingTokenUsage(rolled, parsedObj?.message?.model));
    }
    state.inputTokens += rolled.input - rolled.cacheHit - (state.claudeUsageSeen ? rolled.cacheWrite : 0);
    state.cacheReadTokens += rolled.cacheHit;
    state.outputTokens += rolled.output;
    state.totalTokens += rolled.input + rolled.output;
  }
  for (const m of line.matchAll(/"type":\s*"text",\s*"text":\s*"((?:[^"\\]|\\.)*)"/g)) {
    const text = parseEscapedJsonString(m[1]);
    if (text) pushIndexSearchChunk(state, text);
  }
  if (line.includes('"thinking"')) {
    for (const m of line.matchAll(/"type":\s*"thinking"[^}]*?"thinking":\s*"((?:[^"\\]|\\.)*)"/g)) {
      const thinking = parseEscapedJsonString(m[1]);
      if (thinking) pushIndexSearchChunk(state, thinking);
    }
  }
}

function mergeFallbackChunks(state) {
  for (const t of state.fallbackTexts) {
    pushIndexSearchChunk(state, t);
  }
}

function finalizeIndexState(state, defaultModel, finalizeState) {
  mergeFallbackChunks(state);
  if (finalizeState) return finalizeState(state, { defaultModel });
  return buildIndexMetaFromState(state, { defaultModel });
}

/**
 * How each JSONL source's indexer reads worked time (fact durac): which lines
 * it skips, which carry a record, how a record is classified and whether the
 * duration ends at the last message. indexedWorkedMs reads with the same.
 */
const CLAUDE_WORKED_TIME = Object.freeze({
  skipLine: isClaudeIndexSkippableLine,
  timestampOnlyIfIncludes: true,
  recordKind: claudeRecordKind,
  // The duration ends at the last user/assistant line (fact durcl).
  durationEndsAtMessage: true,
});
const FACTORY_WORKED_TIME = Object.freeze({
  skipLine: isFactoryIndexSkippableLine,
  timestampOnlyIfIncludes: false,
  recordKind: factoryRecordKind,
  durationEndsAtMessage: false,
});
const CODEX_WORKED_TIME = Object.freeze({
  skipLine: isCodexIndexSkippableLine,
  timestampOnlyIfIncludes: false,
  recordKind: codexRecordKind,
  durationEndsAtMessage: false,
});
const WORKED_TIME_BY_SOURCE = { claude: CLAUDE_WORKED_TIME, factory: FACTORY_WORKED_TIME, codex: CODEX_WORKED_TIME };

/** One Grok events.jsonl object's record (fact durac). */
function addGrokEventRecord(state, obj, ts) {
  addActiveRecord(state.activeSpan, timestampMs(state, ts), grokEventKind(obj.type, obj.tool_name));
}

/** One Grok events.jsonl line's record, as indexGrokJsonl reads it. */
function grokWorkedLine(text, start, end, state) {
  if (!isGrokEventsIndexedLine(text, start, end)) return;
  const obj = parseJsonlLineAt(text, start, end);
  const ts = obj?.ts || obj?.timestamp;
  if (ts) addGrokEventRecord(state, obj, ts);
}

/** One JSONL line's record, as the source's indexer reads it (`opts`: its *_WORKED_TIME). */
function jsonlWorkedLine(opts, text, start, end, state) {
  if (opts.skipLine(text, start, end)) return;
  accumulateTimestamp(text.slice(start, end), state, opts.timestampOnlyIfIncludes, opts.recordKind);
}

/**
 * Worked-time reads by file, kept so a recording read again as it grows (a live
 * session's view refreshing) is read only from where the last read stopped.
 */
const _workedReads = new Map();
const MAX_WORKED_READS = 16;
const WORKED_READ_CHUNK = 4 * 1024 * 1024;

function newWorkedRead(key, st) {
  return { key, dev: st.dev, ino: st.ino, offset: 0, state: { activeSpan: createActiveSpan(), _lastTs: null, _lastTsMs: NaN } };
}

/**
 * Feed `read`'s state every complete line of `fd` from `read.offset` on and move
 * the offset past the last newline. Returns the unterminated text after it (a
 * line still being written, or a last line without a newline), or null.
 */
function readNewWorkedLines(fd, size, read, onLine) {
  let pos = read.offset;
  let carry = null;
  while (pos < size) {
    const buf = Buffer.allocUnsafe(Math.min(WORKED_READ_CHUNK, size - pos));
    const n = readSync(fd, buf, 0, buf.length, pos);
    if (n <= 0) break;
    const data = carry ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
    const dataStart = pos - (carry ? carry.length : 0);
    pos += n;
    const lastNl = data.lastIndexOf(0x0a);
    if (lastNl < 0) {
      carry = data;
      continue;
    }
    const text = data.toString("utf8", 0, lastNl);
    let at = 0;
    while (at < text.length) {
      const nl = text.indexOf("\n", at);
      const lineEnd = nl === -1 ? text.length : nl;
      if (lineEnd > at) onLine(text, at, lineEnd, read.state);
      at = nl === -1 ? text.length : nl + 1;
    }
    read.offset = dataStart + lastNl + 1;
    carry = lastNl + 1 < data.length ? data.subarray(lastNl + 1) : null;
  }
  return carry && carry.length ? carry.toString("utf8") : null;
}

/**
 * The durationMs the index records for a Claude Code, Codex, Factory or Grok
 * recording, read from its timestamped records alone (fact durac3): the same
 * lines, classification and rule as its indexer, without the rest of an index
 * pass. A recording read again after it grew is read only from where the last
 * read stopped. Null for another source; 0 when the file cannot be read.
 */
export function indexedWorkedMs(path, source) {
  const opts = WORKED_TIME_BY_SOURCE[source];
  if (source !== "grok" && !opts) return null;
  const file = source === "grok" ? join(path, "events.jsonl") : path;
  const onLine = source === "grok" ? grokWorkedLine : (text, start, end, state) => jsonlWorkedLine(opts, text, start, end, state);
  const key = `${source}\u0000${file}`;
  let fd;
  try {
    fd = openSync(file, "r");
  } catch (err) {
    if (!isIndexDiskExpectedErr(err)) console.error(`indexedWorkedMs: failed to open ${file}:`, err.message);
    return 0;
  }
  try {
    const st = fstatSync(fd);
    let read = _workedReads.get(key);
    // A replaced or truncated file is read again from its start.
    if (!read || read.dev !== st.dev || read.ino !== st.ino || st.size < read.offset) read = newWorkedRead(key, st);
    _workedReads.delete(key);
    const tail = readNewWorkedLines(fd, st.size, read, onLine);
    _workedReads.set(key, read);
    if (_workedReads.size > MAX_WORKED_READS) _workedReads.delete(_workedReads.keys().next().value);
    let state = read.state;
    if (tail) {
      // The unterminated last line counts as the indexer would count it now,
      // on a copy: the next read sees it again once it is complete.
      state = { ...state, activeSpan: { ...state.activeSpan } };
      onLine(tail, 0, tail.length, state);
    }
    return workedMsOfSpan(state.activeSpan, opts?.durationEndsAtMessage === true);
  } catch (err) {
    _workedReads.delete(key);
    if (!isIndexDiskExpectedErr(err)) console.error(`indexedWorkedMs: failed to read ${file}:`, err.message);
    return 0;
  } finally {
    closeSync(fd);
  }
}

/**
 * Shared JSONL scan loop for Claude Code, Factory, and Codex session files.
 * Source-specific behavior is supplied via hooks (lineKind + line handlers).
 */
function indexClaudeFamilyJsonl(filePath, {
  label,
  defaultModel = null,
  isIndexedLine,
  lineKind,
  timestampOnlyIfIncludes = false,
  recordKind,
  durationEndsAtMessage = false,
  extractToolResultChunks = false,
  useClaudeAccumulators = true,
  accumulatorsOnlyOnIndexed = false,
  accumulatorIndexedLine,
  skipLine,
  onUserLine,
  onAssistantLine,
  onIndexedLine,
  finalizeState,
}) {
  try {
    const state = createIndexState();
    state.durationEndsAtMessage = durationEndsAtMessage;
    const shouldIndex = (line) => isIndexedLine(line);

    forEachJsonlLineFromFile(filePath, (text, start, end) => {
      if (skipLine?.(text, start, end)) return;
      const line = text.slice(start, end);
      accumulateTimestamp(line, state, timestampOnlyIfIncludes, recordKind);
      const accLine = accumulatorIndexedLine ?? isIndexedLine;
      const runAccumulators =
        useClaudeAccumulators &&
        (!accumulatorsOnlyOnIndexed || !accLine || accLine(line));
      if (runAccumulators) {
        accumulateToolUse(line, state);
        accumulateErrors(line, state, extractToolResultChunks);
      }

      let parsedObj = null;
      if (shouldIndex(line)) {
        parsedObj = parseJsonlLine(line);
        const kind = lineKind ? lineKind(parsedObj) : null;
        if (kind === "user" && onUserLine) {
          parsedObj = onUserLine(line, state, parsedObj) || parsedObj;
        } else if (kind === "assistant") {
          if (onAssistantLine) {
            parsedObj = onAssistantLine(line, state, parsedObj) || parsedObj;
          }
          if (useClaudeAccumulators) accumulateAssistantTokensAndText(line, state, parsedObj);
        } else if (onIndexedLine) {
          parsedObj = onIndexedLine(line, state, parsedObj) || parsedObj;
        }
      }

      if (
        state.fallbackTexts.size < MAX_FALLBACK_STRINGS &&
        line.length >= 30 &&
        lineMightHaveFallbackText(line) &&
        (!isIndexedLine || isIndexedLine(line))
      ) {
        if (!parsedObj) parsedObj = parseJsonlLine(line);
        if (parsedObj) extractTextFromMessage(parsedObj, state.fallbackTexts);
      }
    });

    return finalizeIndexState(state, defaultModel, finalizeState);
  } catch (err) {
    if (!isIndexDiskExpectedErr(err)) {
      console.error(`${label}: failed to index ${filePath}:`, err.message);
    }
    return emptyIndexMeta();
  }
}

/** Factory/Cursor finalize: no explicit usage in the transcript → estimate tokens as chars/4. */
function finalizeCharEstimateIndexState(state, { defaultModel }) {
  if (state.outputTokens === 0 && state.inputTokens === 0) {
    const estInputTokens = Math.round((state.inputChars || 0) / 4);
    const estOutputTokens = Math.round((state.outputChars || 0) / 4);
    return buildIndexMetaFromState(state, {
      defaultModel,
      tokens: {
        totalTokens: estInputTokens + estOutputTokens,
        inputTokens: estInputTokens,
        outputTokens: estOutputTokens,
        cacheReadTokens: 0,
      },
    });
  }
  return buildIndexMetaFromState(state, { defaultModel });
}

export function indexClaudeJsonl(filePath) {
  return indexClaudeFamilyJsonl(filePath, {
    label: "indexClaude",
    ...CLAUDE_WORKED_TIME,
    isIndexedLine: isClaudeFallbackSearchLine,
    accumulatorIndexedLine: isClaudeIndexedJsonlLine,
    accumulatorsOnlyOnIndexed: true,
    lineKind: claudeIndexedLineKind,
    extractToolResultChunks: true,
    onUserLine(_line, state, parsedObj) {
      state.chapters++;
      visitClaudeUserPrompt(parsedObj?.message?.content, {
        onPrompt(clean) {
          if (!state.firstPrompt) state.firstPrompt = truncateFirstPrompt(clean);
          pushIndexSearchChunk(state, clean);
        },
      });
      return parsedObj;
    },
    onAssistantLine(_line, state, parsedObj) {
      if (!state.claudeUsageSeen) state.claudeUsageSeen = new Map();
      if (!state.model && parsedObj?.message?.model) {
        state.model = parsedObj.message.model;
      }
      return parsedObj;
    },
  });
}

/** Cursor tools whose `path` input names a touched file (Cursor uses `path`, not `file_path`). */
const CURSOR_PATH_TOOLS = new Set(["Read", "Write", "StrReplace", "Delete"]);

/** Shared cursor/cursor-cloud user-row hook (message rows have identical shape — fact ccmr). */
function cursorUserLineHook(_line, state, parsedObj) {
  state.chapters++;
  visitCursorUserPrompt(parsedObj?.message?.content, {
    onPrompt(clean) {
      if (!state.firstPrompt) state.firstPrompt = truncateFirstPrompt(clean);
      pushIndexSearchChunk(state, clean);
      state.inputChars = (state.inputChars || 0) + clean.length;
    },
  });
  return parsedObj;
}

/** Shared cursor/cursor-cloud assistant-row hook. */
function cursorAssistantLineHook(_line, state, parsedObj) {
  if (!state.model && parsedObj?.message?.model) {
    state.model = parsedObj.message.model;
  }
  // Accumulate char counts for token estimation
  // and track touched files via Cursor's `path` tool input.
  const content = parsedObj?.message?.content;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b?.type === "text" && b.text) {
        state.outputChars = (state.outputChars || 0) + b.text.length;
      } else if (b?.type === "tool_use") {
        state.outputChars = (state.outputChars || 0) + (b.name || "").length + 20;
        const p = b.input?.path;
        if (CURSOR_PATH_TOOLS.has(b.name) && typeof p === "string" && p) {
          state.files.add(p);
        }
      }
    }
  }
  return parsedObj;
}

export function indexCursorJsonl(filePath) {
  return indexClaudeFamilyJsonl(filePath, {
    label: "indexCursor",
    defaultModel: cursorModelFromStateDb(filePath) || "cursor",
    skipLine: (line, start, end) =>
      isCursorIndexSkippableLine(line, start, end) && !isCursorTurnEndedErrorLine(line, start, end),
    isIndexedLine: (line) => isCursorIndexedJsonlLine(line) || isCursorTurnEndedErrorLine(line),
    lineKind: cursorIndexedLineKind,
    timestampOnlyIfIncludes: false,
    extractToolResultChunks: false,
    useClaudeAccumulators: true,
    // Cursor rows carry no timestamps; derive durationMs from file
    // birthtime/mtime with the same clamping rules as parseCursor (fact rc8).
    finalizeState(state, opts) {
      const meta = finalizeCharEstimateIndexState(state, opts);
      meta.durationMs = cursorFileTimeBounds(filePath)?.durationMs ?? 0;
      return meta;
    },
    onUserLine: cursorUserLineHook,
    onAssistantLine: cursorAssistantLineHook,
    onIndexedLine(_line, state, parsedObj) {
      if (parsedObj?.type === "turn_ended" && parsedObj.status === "error") state.errors++;
      return parsedObj;
    },
  });
}

/**
 * durationMs from an imported session_meta line: max(0, updatedAt - createdAt),
 * 0 when updatedAt is absent, null when there is no usable meta (fact ccix).
 */
function cursorCloudMetaDurationMs(meta) {
  const created = meta?.createdAt ? Date.parse(meta.createdAt) : NaN;
  if (!Number.isFinite(created)) return meta ? 0 : null;
  const updated = meta.updatedAt ? Date.parse(meta.updatedAt) : NaN;
  if (!Number.isFinite(updated)) return 0;
  return Math.max(0, updated - created);
}

/**
 * Imported Cursor cloud-agent sessions: local-cursor message rows behind a
 * session_meta first line (facts ccix, ccmf, ccpp). Deltas vs indexCursorJsonl:
 * model comes from session_meta.model before the "cursor-cloud" fallback (never
 * the local state.vscdb), durationMs comes from meta createdAt/updatedAt instead
 * of file times, and firstPrompt falls back to session_meta.name. A file without
 * session_meta degrades to the local-cursor file-time behavior.
 */
export function indexCursorCloudJsonl(filePath) {
  let sessionMeta = null;
  return indexClaudeFamilyJsonl(filePath, {
    label: "indexCursorCloud",
    defaultModel: "cursor-cloud",
    skipLine: (line, start, end) =>
      isCursorIndexSkippableLine(line, start, end) &&
      !isCursorTurnEndedErrorLine(line, start, end) &&
      !isCursorCloudMetaLine(line, start, end),
    isIndexedLine: (line) =>
      isCursorIndexedJsonlLine(line) || isCursorTurnEndedErrorLine(line) || isCursorCloudMetaLine(line),
    lineKind: cursorIndexedLineKind,
    timestampOnlyIfIncludes: false,
    extractToolResultChunks: false,
    useClaudeAccumulators: true,
    onUserLine: cursorUserLineHook,
    onAssistantLine: cursorAssistantLineHook,
    onIndexedLine(_line, state, parsedObj) {
      if (parsedObj?.type === "session_meta") {
        sessionMeta = parsedObj;
        if (!state.model && typeof parsedObj.model === "string" && parsedObj.model) {
          state.model = parsedObj.model;
        }
      }
      if (parsedObj?.type === "turn_ended" && parsedObj.status === "error") state.errors++;
      return parsedObj;
    },
    finalizeState(state, opts) {
      if (!state.firstPrompt && sessionMeta?.name) {
        state.firstPrompt = truncateFirstPrompt(sessionMeta.name);
      }
      const meta = finalizeCharEstimateIndexState(state, opts);
      meta.durationMs =
        cursorCloudMetaDurationMs(sessionMeta) ?? (cursorFileTimeBounds(filePath)?.durationMs ?? 0);
      return meta;
    },
  });
}

export function indexFactoryJsonl(filePath) {
  return indexClaudeFamilyJsonl(filePath, {
    label: "indexFactory",
    defaultModel: "claude (factory)",
    ...FACTORY_WORKED_TIME,
    accumulatorsOnlyOnIndexed: true,
    isIndexedLine: (line) =>
      line.includes('"type":"message"') || line.includes('"type": "message"'),
    lineKind: factoryIndexedLineKind,
    extractToolResultChunks: false,
    finalizeState: finalizeCharEstimateIndexState,
    onUserLine(_line, state, parsedObj) {
      if (parsedObj?.type === "message" && parsedObj.message?.role === "user") {
        visitFactoryUserTextBlocks(parsedObj.message.content, (clean) => {
          if (!state.firstPrompt) state.firstPrompt = truncateFirstPrompt(clean);
          state.chapters++;
          pushIndexSearchChunk(state, clean);
          state.inputChars = (state.inputChars || 0) + clean.length;
        });
      }
      return parsedObj;
    },
    onAssistantLine(_line, state, parsedObj) {
      if (parsedObj?.type === "message" && parsedObj.message?.role === "assistant") {
        visitFactoryAssistantBlocks(parsedObj.message.content, {
          onText(text) {
            state.outputChars = (state.outputChars || 0) + text.length;
          },
          onToolUse(name) {
            state.outputChars = (state.outputChars || 0) + (name || "").length + 20;
          },
        });
      }
      return parsedObj;
    },
  });
}

export {
  accumulateCodexEventMsgPayload,
  accumulateCodexResponseItemPayload,
} from "./accumulate-codex-payload.js";

/**
 * The model id an index row of this codex rollout should carry (facts cdxheal,
 * cdxheal3): the first turn_context model id, read from the head of the file
 * and stopping at that line; for a rollout without one, the thread_settings_applied
 * or base_instructions provenance model (fact cdxprov); null when the rollout
 * names no model. Lets a cached index row get its model id without re-parsing
 * the whole recording.
 */
export function codexHealModel(filePath) {
  let fd;
  try {
    fd = openSync(filePath, "r");
  } catch (err) {
    if (!isIndexDiskExpectedErr(err)) console.error(`codexHealModel: open failed for ${filePath}:`, err.message);
    return null;
  }
  try {
    // Byte-level scan: only lines holding "turn_context" are decoded and parsed.
    const chunk = Buffer.allocUnsafe(256 * 1024);
    let buf = Buffer.alloc(0);
    let searchFrom = 0;
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      const eof = n === 0;
      buf = buf.length ? Buffer.concat([buf, chunk.subarray(0, n)]) : Buffer.from(chunk.subarray(0, n));
      let at = buf.indexOf(TURN_CONTEXT_NEEDLE, searchFrom);
      let keepFrom = buf.lastIndexOf(0x0a) + 1;
      while (at >= 0) {
        const lineStart = buf.lastIndexOf(0x0a, at) + 1;
        let lineEnd = buf.indexOf(0x0a, at);
        if (lineEnd < 0) {
          if (!eof) {
            keepFrom = lineStart; // finish this line with the next read
            break;
          }
          lineEnd = buf.length;
        }
        const model = turnContextModel(buf.toString("utf8", lineStart, lineEnd));
        if (model) return model;
        at = buf.indexOf(TURN_CONTEXT_NEEDLE, lineEnd);
      }
      if (eof) return codexModelOutsideTurnContext(filePath);
      // Re-scan only the kept tail a needle could still straddle.
      const kept = buf.length - keepFrom;
      searchFrom = at >= 0 ? at - keepFrom : Math.max(0, kept - TURN_CONTEXT_NEEDLE.length + 1);
      buf = buf.subarray(keepFrom);
    }
  } finally {
    closeSync(fd);
  }
}

const TURN_CONTEXT_NEEDLE = Buffer.from('"turn_context"');

/**
 * thread_settings_applied model, else session_meta provenance model, of a rollout
 * with no turn_context model id (fact cdxprov). Only those few rollouts get this
 * second read; only lines naming either field are parsed.
 */
function codexModelOutsideTurnContext(filePath) {
  let settingsModel = null;
  let provenanceModel = null;
  try {
    forEachJsonlLineFromFile(filePath, (rawLine) => {
      if (!provenanceModel && rawLine.includes('"provenance"') && rawLine.includes('"session_meta"')) {
        const obj = parseJsonlLine(rawLine);
        if (obj?.type === "session_meta") provenanceModel = codexProvenanceModel(obj.payload);
      }
      if (rawLine.includes('"thread_settings_applied"')) {
        const obj = parseJsonlLine(rawLine);
        settingsModel = obj?.type === "event_msg" ? codexThreadSettingsModel(obj.payload) : null;
        if (settingsModel) return false;
      }
    });
  } catch (err) {
    if (!isIndexDiskExpectedErr(err)) console.error(`codexHealModel: read failed for ${filePath}:`, err.message);
  }
  return settingsModel || provenanceModel;
}

function turnContextModel(line) {
  try {
    const obj = JSON.parse(line);
    return obj?.type === "turn_context" && typeof obj.payload?.model === "string" && obj.payload.model ? obj.payload.model : null;
  } catch {
    return null;
  }
}

export function indexCodexJsonl(filePath) {
  return indexClaudeFamilyJsonl(filePath, {
    label: "indexCodex",
    defaultModel: "codex",
    useClaudeAccumulators: false,
    ...CODEX_WORKED_TIME,
    isIndexedLine: isCodexIndexedJsonlLine,
    lineKind: codexIndexedLineKind,
    onUserLine(_line, state, obj) {
      if (!obj) return null;
      if (obj.type === "event_msg") {
        visitCodexEventMsgPayload(obj.payload, {
          onUserMessage(p) {
            const t = p.message || "";
            if (isCodexDisplayableUserText(t)) {
              const clean = normalizeCodexUserPromptText(t);
              if (!state.firstPrompt) state.firstPrompt = truncateFirstPrompt(clean);
              state.chapters++;
              pushIndexSearchChunk(state, clean);
            }
          },
        });
      }
      if (obj.type === "response_item" && obj.payload?.role === "user") {
        for (const b of obj.payload.content || []) {
          if (b?.type === "input_text") {
            const t = b.text || "";
            if (isCodexDisplayableUserText(t)) {
              const clean = normalizeCodexUserPromptText(t);
              if (!state.firstPrompt) {
                state.firstPrompt = truncateFirstPrompt(clean);
                state.chapters++;
              } else state.chapters++;
              pushIndexSearchChunk(state, clean);
            }
          }
        }
        accumulateCodexResponseItemPayload(obj.payload, filePath, state);
      }
      return obj;
    },
    onAssistantLine(_line, state, obj) {
      if (!obj || obj.type !== "response_item" || obj.payload?.role !== "assistant") return obj;
      const p = obj.payload;
      for (const b of p.content || []) {
        accumulateCodexContentFunctionCall(b, filePath, state);
        if (b?.type === "output_text" && b.text) pushIndexSearchChunk(state, foldNewlines(b.text));
      }
      accumulateCodexResponseItemPayload(p, filePath, state);
      return obj;
    },
    onIndexedLine(_line, state, obj) {
      if (!obj) return null;
      // turn_context names the model id, else thread_settings_applied or the
      // base_instructions provenance; model_provider ("openai") is only the fallback (facts cdxmodel, cdxprov).
      if (obj.type === "session_meta") {
        if (!state.codexSessionId) state.codexSessionId = obj.payload?.id || null;
        state.codexProvider = obj.payload?.model_provider || null;
        if (!state.codexProvenanceModel) state.codexProvenanceModel = codexProvenanceModel(obj.payload);
        state.model = codexIndexModel(state);
      }
      if (obj.type === "turn_context") {
        const turnModel = obj.payload?.model;
        if (turnModel && !state.codexTurnModel) state.codexTurnModel = turnModel;
        state.model = codexIndexModel(state);
        if (!state.sawTokenCountTotal) {
          const usage = obj.payload?.last_token_usage;
          if (usage) {
            const inTok = usage.input_tokens || 0;
            const outTok = usage.output_tokens || 0;
            state.totalTokens += inTok + outTok;
            state.inputTokens += inTok;
            state.outputTokens += outTok;
          }
        }
      }
      if (obj.type === "response_item") {
        accumulateCodexResponseItemPayload(obj.payload || {}, filePath, state);
      }
      if (obj.type === "event_msg") {
        const settingsModel = codexThreadSettingsModel(obj.payload);
        if (settingsModel && !state.codexSettingsModel) {
          state.codexSettingsModel = settingsModel;
          state.model = codexIndexModel(state);
        }
        // A review sub-thread's prompt and replies (fact cdxsub); its commands
        // are counted by accumulateCodexEventMsgPayload.
        const item = codexSubThreadItem(obj.payload, state.codexSessionId);
        if (item?.type === "UserMessage") {
          const t = codexSubThreadItemText(item);
          if (isCodexDisplayableUserText(t)) {
            const clean = normalizeCodexUserPromptText(t);
            if (!state.firstPrompt) state.firstPrompt = truncateFirstPrompt(clean);
            state.chapters++;
            pushIndexSearchChunk(state, clean);
          }
        } else if (item?.type === "AgentMessage") {
          const t = codexSubThreadItemText(item);
          if (t) pushIndexSearchChunk(state, foldNewlines(t));
        }
        accumulateCodexEventMsgPayload(obj.payload, state);
      }
      return obj;
    },
  });
}

function codexIndexModel(state) {
  return resolveCodexModel({
    turnModel: state.codexTurnModel,
    settingsModel: state.codexSettingsModel,
    provenanceModel: state.codexProvenanceModel,
    provider: state.codexProvider,
  }) || "codex";
}

function processGrokChatLineObj(obj, sessionDir, state) {
  visitGrokChatHistoryLine(obj, {
    onUserPrompt(clean) {
      if (!state.firstPrompt) state.firstPrompt = truncateFirstPrompt(clean);
      state.chapters++;
      pushIndexSearchChunk(state, clean);
    },
    onUserRawChars(n) {
      state.inputChars = (state.inputChars || 0) + n;
    },
    onAssistantString(t) {
      pushIndexSearchChunk(state, foldNewlines(t));
      state.outputChars = (state.outputChars || 0) + t.length;
    },
    onAssistantBlockText(text) {
      pushIndexSearchChunk(state, foldNewlines(text));
      state.outputChars = (state.outputChars || 0) + text.length;
    },
  });
  if (obj.type === "assistant") {
    for (const tc of obj.tool_calls || []) {
      if (tc.name) {
        const tn = normalizeToolName(tc.name);
        state.outputChars = (state.outputChars || 0) + (tc.name || "").length + 20;
        const args = parseToolArgs(tc.arguments, `indexGrok ${sessionDir}`);
        const fp = args?.file_path || args?.path;
        if (fp) state.files.add(fp);
        if (tn === "Bash" && /\bgit\b.*\bcommit\b/i.test(args?.command || "")) state.commits++;
        state.outputChars =
          (state.outputChars || 0) +
          (typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(args || "")).length;
      }
    }
  }
  if (obj.type === "tool_result" || obj.type === "tool") {
    const resultText = typeof obj.content === "string" ? obj.content : JSON.stringify(obj.content || "");
    state.inputChars = (state.inputChars || 0) + resultText.length;
    if (typeof obj.content === "string" && obj.content.trim().length >= 30) {
      pushIndexSearchChunk(state, foldNewlines(obj.content));
    }
  }
  if (state.fallbackTexts.size < MAX_FALLBACK_STRINGS) {
    extractTextFromMessage(obj, state.fallbackTexts);
  }
}

/**
 * Align toolCounts with parseGrok: chat_history is canonical; events.jsonl supplies outcomes only.
 * @returns {number} next unconsumed index in toolOutcomes
 */
export function applyGrokToolCountsFromChat(chatRaw, toolOutcomes, state) {
  const objs = [];
  forEachJsonlLine(chatRaw, (text, start, end) => {
    if (!isGrokChatIndexedLine(text, start, end)) return;
    const obj = parseJsonlLineAt(text, start, end);
    if (obj) objs.push(obj);
  });
  return walkGrokIndexedChatObjs(objs, toolOutcomes, state, null);
}

/** Walk pre-filtered parsed chat rows (lookahead only across indexed lines). */
function walkGrokIndexedChatObjs(objs, toolOutcomes, state, onLine) {
  let toolOutcomeIdx = 0;
  let sawUserOrAssistant = false;

  const bumpTool = (name) => {
    trackIndexTool(state, name);
    state.toolCounts[name] = (state.toolCounts[name] || 0) + 1;
  };

  for (let i = 0; i < objs.length; i++) {
    const line = objs[i];

    if (onLine) onLine(line);

    if (line.type === "system") continue;

    if (line.type === "user" || line.type === "assistant") sawUserOrAssistant = true;

    if (line.type === "assistant") {
      const assistantToolCalls = line.tool_calls || [];
      if (assistantToolCalls.length) {
        for (const tc of assistantToolCalls) {
          if (tc.name) bumpTool(normalizeToolName(tc.name));
        }
      }
      let j = i + 1;
      while (j < objs.length) {
        const next = objs[j];
        if (next.type === "tool_result" || next.type === "tool") {
          if (onLine) onLine(next);
          if (!assistantToolCalls.length) {
            const outcomeInfo = toolOutcomeIdx < toolOutcomes.length ? toolOutcomes[toolOutcomeIdx] : null;
            bumpTool(outcomeInfo?.name || "unknown");
          }
          toolOutcomeIdx++;
          j++;
        } else {
          break;
        }
      }
      i = j - 1;
    }

    if ((line.type === "tool_result" || line.type === "tool") && !sawUserOrAssistant) {
      const outcomeInfo = toolOutcomeIdx < toolOutcomes.length ? toolOutcomes[toolOutcomeIdx] : null;
      bumpTool(outcomeInfo?.name || "unknown");
      toolOutcomeIdx++;
    }
  }
  return toolOutcomeIdx;
}

export { isGrokChatIndexedLine, isGrokEventsIndexedLine };

function processGrokEventsLine(text, start, end, state, toolOutcomes) {
  if (!isGrokEventsIndexedLine(text, start, end)) return;
  const obj = parseJsonlLineAt(text, start, end);
  visitGrokEventsObj(obj, {
    onTimestamp(ts) {
      addGrokEventRecord(state, obj, ts);
    },
    onModel(modelId) {
      state.model = modelId;
    },
    onToolStarted(toolName) {
      toolOutcomes.push({ name: normalizeToolName(toolName) });
    },
    onToolError() {
      state.errors++;
    },
  });
}

export function indexGrokJsonl(sessionDir) {
  try {
    const state = createIndexState();
    state.inputChars = 0;
    state.outputChars = 0;

    const ctxPath = join(sessionDir, "prompt_context.json");
    if (existsSync(ctxPath)) {
      try {
        const ctx = JSON.parse(readFileSync(ctxPath, "utf-8"));
        state.model = ctx.model_id || "grok";
      } catch (err) {
        if (err instanceof SyntaxError) {
          console.error(`indexGrok: failed to parse ${ctxPath}:`, err.message);
        } else {
          throw err;
        }
      }
    }

    const toolOutcomes = [];
    const eventsPath = join(sessionDir, "events.jsonl");
    if (existsSync(eventsPath)) {
      forEachJsonlLineFromFile(eventsPath, (text, start, end) => {
        processGrokEventsLine(text, start, end, state, toolOutcomes);
      });
    }

    const chatPath = join(sessionDir, "chat_history.jsonl");
    if (existsSync(chatPath)) {
      const indexedObjs = [];
      forEachJsonlLineFromFile(chatPath, (text, start, end) => {
        if (!isGrokChatIndexedLine(text, start, end)) return true;
        const obj = parseJsonlLineAt(text, start, end);
        if (obj) indexedObjs.push(obj);
        return true;
      });
      const consumed = walkGrokIndexedChatObjs(
        indexedObjs,
        toolOutcomes,
        state,
        (line) => processGrokChatLineObj(line, sessionDir, state),
      );
      for (let i = consumed; i < toolOutcomes.length; i++) {
        const name = toolOutcomes[i].name;
        trackIndexTool(state, name);
        state.toolCounts[name] = (state.toolCounts[name] || 0) + 1;
      }
    } else {
      for (const o of toolOutcomes) {
        trackIndexTool(state, o.name);
        state.toolCounts[o.name] = (state.toolCounts[o.name] || 0) + 1;
      }
    }

    mergeFallbackChunks(state);
    const estInputTokens = Math.round((state.inputChars || 0) / 4);
    const estOutputTokens = Math.round((state.outputChars || 0) / 4);
    return buildIndexMetaFromState(state, {
      tokens: {
        totalTokens: estInputTokens + estOutputTokens,
        inputTokens: estInputTokens,
        outputTokens: estOutputTokens,
        cacheReadTokens: 0,
      },
    });
  } catch (err) {
    if (!isIndexDiskExpectedErr(err)) {
      console.error(`indexGrok: failed to index ${sessionDir}:`, err.message);
    }
    return emptyIndexMeta();
  }
}
