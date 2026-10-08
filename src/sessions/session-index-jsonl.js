import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isIndexDiskExpectedErr } from "../utils/fs-expected-err.js";
import { errorPattern, normalizeToolName } from "../parse/parse-enrich.js";
import {
  codexIndexedLineKind,
  isCodexDisplayableUserText,
  isCodexIndexSkippableLine,
  isCodexIndexedJsonlLine,
  normalizeCodexUserPromptText,
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

function accumulateTimestamp(line, state, timestampOnlyIfIncludes) {
  if (timestampOnlyIfIncludes && !line.includes('"timestamp"')) return;
  const tsMatch = line.match(/"timestamp":\s*"([^"]+)"/);
  if (!tsMatch) return;
  const ts = tsMatch[1];
  if (!state.firstTs) state.firstTs = ts;
  state.lastTs = ts;
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

function accumulateAssistantTokensAndText(line, state) {
  if (line.includes('"input_tokens"')) {
    const usage = {};
    const tokMatch = line.match(/"input_tokens":\s*(\d+)/);
    const outMatch = line.match(/"output_tokens":\s*(\d+)/);
    const cacheMatch = line.match(/"cache_read_input_tokens":\s*(\d+)/);
    const cacheWriteMatch = line.match(/"cache_creation_input_tokens":\s*(\d+)/);
    if (tokMatch) usage.input_tokens = parseInt(tokMatch[1], 10);
    if (outMatch) usage.output_tokens = parseInt(outMatch[1], 10);
    if (cacheMatch) usage.cache_read_input_tokens = parseInt(cacheMatch[1], 10);
    if (cacheWriteMatch) usage.cache_creation_input_tokens = parseInt(cacheWriteMatch[1], 10);
    const rolled = rollupClaudeUsage(usage);
    state.inputTokens += rolled.input - rolled.cacheHit;
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
 * Shared JSONL scan loop for Claude Code, Factory, and Codex session files.
 * Source-specific behavior is supplied via hooks (lineKind + line handlers).
 */
function indexClaudeFamilyJsonl(filePath, {
  label,
  defaultModel = null,
  isIndexedLine,
  lineKind,
  timestampOnlyIfIncludes = false,
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
    const shouldIndex = (line) => isIndexedLine(line);

    forEachJsonlLineFromFile(filePath, (text, start, end) => {
      if (skipLine?.(text, start, end)) return;
      const line = text.slice(start, end);
      accumulateTimestamp(line, state, timestampOnlyIfIncludes);
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
          if (useClaudeAccumulators) accumulateAssistantTokensAndText(line, state);
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
    skipLine: isClaudeIndexSkippableLine,
    isIndexedLine: isClaudeFallbackSearchLine,
    accumulatorIndexedLine: isClaudeIndexedJsonlLine,
    accumulatorsOnlyOnIndexed: true,
    lineKind: claudeIndexedLineKind,
    timestampOnlyIfIncludes: true,
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
    skipLine: isFactoryIndexSkippableLine,
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

export function indexCodexJsonl(filePath) {
  return indexClaudeFamilyJsonl(filePath, {
    label: "indexCodex",
    defaultModel: "codex",
    useClaudeAccumulators: false,
    skipLine: isCodexIndexSkippableLine,
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
      if (obj.type === "session_meta") state.model = obj.payload?.model_provider || "codex";
      if (obj.type === "turn_context") {
        if (!state.model) state.model = obj.payload?.model || "codex";
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
        accumulateCodexEventMsgPayload(obj.payload, state);
      }
      return obj;
    },
  });
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
      if (!state.firstTs) state.firstTs = ts;
      state.lastTs = ts;
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
