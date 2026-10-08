import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  codexIndexedLineKind,
  isCodexDisplayableUserText,
  isCodexIndexSkippableLine,
  isCodexIndexedJsonlLine,
  normalizeCodexUserPromptText,
  visitCodexEventMsgPayload,
} from "../parse/codex-event-msg.js";
import {
  claudeIndexedLineKind,
  isClaudeIndexedJsonlLine,
  visitClaudeAssistantBlocks,
  visitClaudeUserPrompt,
  isCursorIndexedJsonlLine,
  isCursorCloudMetaLine,
  cursorIndexedLineKind,
  visitCursorUserPrompt,
  visitCursorAssistantBlocks,
} from "../parse/claude-jsonl-index.js";
import {
  isGrokChatIndexedLine,
  isGrokEventsIndexedLine,
  visitGrokChatHistoryLine,
  visitGrokEventsObj,
} from "../parse/grok-chat-index.js";
import { normalizeToolName } from "../parse/parse-enrich.js";
import {
  factoryIndexedLineKind,
  isFactoryIndexSkippableLine,
  visitFactoryAssistantBlocks,
  visitFactoryUserTextBlocks,
} from "../parse/parse-factory.js";
import { collapseWhitespace, isDisplayableUserText, truncateFirstPrompt } from "../parse/parse-utils.js";
import { parseJsonlLine, forEachPartialJsonlLine } from "../parse/jsonl-read.js";
import { accumulateTermFreqs, TOKENIZER_INPUT_CAP } from "./search-tokenizer.js";
import { withOpenCodeDb } from "./session-discovery-paths.js";
import { forEachOpenCodeMessagePart, isOpenCodeTermIndexPartType } from "./session-index-opencode.js";
import { cursorModelFromStateDb } from "./cursor-state-db.js";

function emptyPeekResult() {
  return { firstPrompt: null, model: null, termFreqs: null, tools: [] };
}

function makeTfState() {
  return { termFreqs: new Map(), budget: [TOKENIZER_INPUT_CAP] };
}

function accumulate(tfState, text) {
  if (!text) return;
  accumulateTermFreqs(text, tfState.termFreqs, tfState.budget);
}

function finalizeTf(tfState) {
  return tfState.termFreqs.size ? tfState.termFreqs : null;
}

export function peekSession(session) {
  const filePath = session.path;
  const fileSize = session.size;
  const source = session.source || "claude";

  if (source === "opencode") return peekOpenCode(session);
  if (source === "grok") return peekGrok(filePath);
  if (source === "codex") return peekCodex(filePath, fileSize);
  if (source === "cursor") return peekCursor(filePath, fileSize);
  if (source === "cursor-cloud") return peekCursorCloud(filePath, fileSize);
  if (source === "factory") return peekFactory(filePath, fileSize);
  return peekClaude(filePath, fileSize);
}

export function peekCursor(filePath, fileSize) {
  try {
    let firstPrompt = null;
    let model = null;
    const tools = new Set();
    const tf = makeTfState();

    forEachPartialJsonlLine(filePath, fileSize, (rawLine) => {
      if (!isCursorIndexedJsonlLine(rawLine, 0, rawLine.length)) return;
      const line = parseJsonlLine(rawLine);
      if (!line) return;
      if (!model && line.model) model = line.model;
      const kind = cursorIndexedLineKind(line);
      if (kind === "user") {
        visitCursorUserPrompt(line.message?.content, {
          onPrompt(clean) {
            if (!firstPrompt) firstPrompt = truncateFirstPrompt(clean);
            accumulate(tf, clean);
          },
        });
      }
      if (kind === "assistant") {
        visitCursorAssistantBlocks(line.message?.content, {
          onToolUse(name) {
            tools.add(normalizeToolName(name));
          },
          onText(t) {
            accumulate(tf, t);
          },
        });
      }
    });
    return { firstPrompt, model: model || cursorModelFromStateDb(filePath) || "cursor", termFreqs: finalizeTf(tf), tools: [...tools] };
  } catch (err) {
    console.error(`peekCursor: failed to peek ${filePath}:`, err.message);
    return emptyPeekResult();
  }
}

/**
 * Imported cursor-cloud sessions: reuses peekCursor's row handling for message
 * lines and additionally consumes the session_meta first line — its name feeds
 * termFreqs and is the firstPrompt fallback, its model seeds the model field,
 * and the model fallback is the "cursor-cloud" literal, never the local cursor
 * state.vscdb (facts ccpk, ccmf).
 */
export function peekCursorCloud(filePath, fileSize) {
  try {
    let firstPrompt = null;
    let model = null;
    let metaName = null;
    const tools = new Set();
    const tf = makeTfState();

    forEachPartialJsonlLine(filePath, fileSize, (rawLine) => {
      if (isCursorCloudMetaLine(rawLine, 0, rawLine.length)) {
        const line = parseJsonlLine(rawLine);
        if (!line) return;
        if (!model && typeof line.model === "string" && line.model) model = line.model;
        if (!metaName && typeof line.name === "string" && line.name) {
          metaName = line.name;
          accumulate(tf, metaName);
        }
        return;
      }
      if (!isCursorIndexedJsonlLine(rawLine, 0, rawLine.length)) return;
      const line = parseJsonlLine(rawLine);
      if (!line) return;
      if (!model && line.model) model = line.model;
      const kind = cursorIndexedLineKind(line);
      if (kind === "user") {
        visitCursorUserPrompt(line.message?.content, {
          onPrompt(clean) {
            if (!firstPrompt) firstPrompt = truncateFirstPrompt(clean);
            accumulate(tf, clean);
          },
        });
      }
      if (kind === "assistant") {
        visitCursorAssistantBlocks(line.message?.content, {
          onToolUse(name) {
            tools.add(normalizeToolName(name));
          },
          onText(t) {
            accumulate(tf, t);
          },
        });
      }
    });
    return {
      firstPrompt: firstPrompt || (metaName ? truncateFirstPrompt(metaName) : null),
      model: model || "cursor-cloud",
      termFreqs: finalizeTf(tf),
      tools: [...tools],
    };
  } catch (err) {
    console.error(`peekCursorCloud: failed to peek ${filePath}:`, err.message);
    return emptyPeekResult();
  }
}

export function peekClaude(filePath, fileSize) {
  try {
    let firstPrompt = null;
    let model = null;
    const tools = new Set();
    const tf = makeTfState();

    forEachPartialJsonlLine(filePath, fileSize, (rawLine) => {
      if (!isClaudeIndexedJsonlLine(rawLine, 0, rawLine.length)) return;
      const line = parseJsonlLine(rawLine);
      if (!line) return;
      if (!model && line.message?.model) model = line.message.model;
      const kind = claudeIndexedLineKind(line);
      if (kind === "user") {
        visitClaudeUserPrompt(line.message?.content, {
          onPrompt(clean) {
            if (!firstPrompt) firstPrompt = truncateFirstPrompt(clean);
            accumulate(tf, clean);
          },
        });
      }
      if (kind === "assistant") {
        visitClaudeAssistantBlocks(line.message?.content, {
          onToolUse(name) {
            tools.add(normalizeToolName(name));
          },
          onText(t) {
            accumulate(tf, t);
          },
        });
      }
    });
    return { firstPrompt, model, termFreqs: finalizeTf(tf), tools: [...tools] };
  } catch (err) {
    console.error(`peekClaude: failed to peek ${filePath}:`, err.message);
    return emptyPeekResult();
  }
}

export function peekCodex(filePath, fileSize) {
  try {
    let firstPrompt = null;
    let model = null;
    const tools = new Set();
    const tf = makeTfState();

    forEachPartialJsonlLine(filePath, fileSize, (rawLine) => {
      if (isCodexIndexSkippableLine(rawLine)) return;
      if (!isCodexIndexedJsonlLine(rawLine)) return;
      const line = parseJsonlLine(rawLine);
      if (!line) return;
      if (line.type === "session_meta") {
        model = line.payload?.model_provider || "codex";
      }
      if (line.type === "turn_context") {
        if (!model) model = line.payload?.model || "codex";
      }
      const kind = codexIndexedLineKind(line);
      if (kind === "assistant" && line.type === "response_item") {
        const p = line.payload || {};
        const content = p.content || [];
        for (const block of content) {
          if (block?.type === "function_call" && block.name) tools.add(normalizeToolName(block.name));
          if (block?.type === "output_text" && block.text) {
            const t = collapseWhitespace(block.text);
            if (t) accumulate(tf, t);
          }
        }
      }
      if (kind === "user") {
        if (line.type === "response_item") {
          const p = line.payload || {};
          for (const block of p.content || []) {
            if (block?.type === "input_text") {
              const t = block.text || "";
              if (isCodexDisplayableUserText(t)) {
                const clean = normalizeCodexUserPromptText(t);
                if (!firstPrompt) firstPrompt = truncateFirstPrompt(clean);
                accumulate(tf, clean);
              }
            }
          }
        }
        if (line.type === "event_msg") {
          visitCodexEventMsgPayload(line.payload, {
            onUserMessage(p) {
              const t = p.message || "";
              if (isCodexDisplayableUserText(t)) {
                const clean = normalizeCodexUserPromptText(t);
                if (!firstPrompt) firstPrompt = truncateFirstPrompt(clean);
                accumulate(tf, clean);
              }
            },
          });
        }
      }
      if (line.type === "response_item") {
        const p = line.payload || {};
        if (p.type === "function_call" && p.name) tools.add(normalizeToolName(p.name));
        if (p.type === "custom_tool_call" && p.name) tools.add(normalizeToolName(p.name));
        if (p.type === "web_search_call") tools.add("WebSearch");
      }
      if (line.type === "event_msg") {
        visitCodexEventMsgPayload(line.payload, {
          onPatchApplyEnd: () => tools.add("Edit"),
          onExecCommandEnd: () => tools.add("Bash"),
          onWebSearchEnd: () => tools.add("WebSearch"),
        });
      }
    });
    return { firstPrompt, model, termFreqs: finalizeTf(tf), tools: [...tools] };
  } catch (err) {
    console.error(`peekCodex: failed to peek ${filePath}:`, err.message);
    return emptyPeekResult();
  }
}

export function peekFactory(filePath, fileSize) {
  try {
    let firstPrompt = null;
    let model = null;
    const tools = new Set();
    const tf = makeTfState();

    forEachPartialJsonlLine(filePath, fileSize, (rawLine) => {
      if (isFactoryIndexSkippableLine(rawLine, 0, rawLine.length)) return;
      const line = parseJsonlLine(rawLine);
      if (!line) return;
      const kind = factoryIndexedLineKind(line);
      if (kind === "assistant") {
        visitFactoryAssistantBlocks(line.message.content, {
          onToolUse(name) {
            tools.add(normalizeToolName(name));
          },
          onText(t) {
            accumulate(tf, t);
          },
        });
      }
      if (kind === "user") {
        visitFactoryUserTextBlocks(line.message.content, (clean) => {
          if (!firstPrompt) firstPrompt = truncateFirstPrompt(clean);
          accumulate(tf, clean);
        });
      }
    });
    return { firstPrompt, model: model || "claude (factory)", termFreqs: finalizeTf(tf), tools: [...tools] };
  } catch (err) {
    console.error(`peekFactory: failed to peek ${filePath}:`, err.message);
    return emptyPeekResult();
  }
}

export function peekGrok(sessionDir) {
  try {
    let model = null;
    let firstPrompt = null;
    const tools = new Set();
    const tf = makeTfState();

    const ctxPath = join(sessionDir, "prompt_context.json");
    if (existsSync(ctxPath)) {
      const ctx = JSON.parse(readFileSync(ctxPath, "utf-8"));
      model = ctx.model_id || "grok";
    }

    const eventsPath = join(sessionDir, "events.jsonl");
    if (existsSync(eventsPath)) {
      forEachPartialJsonlLine(eventsPath, null, (rawLine) => {
        if (!isGrokEventsIndexedLine(rawLine, 0, rawLine.length)) return;
        const obj = parseJsonlLine(rawLine);
        visitGrokEventsObj(obj, {
          onModel(modelId) {
            model = modelId;
          },
          onToolStarted(toolName) {
            tools.add(normalizeToolName(toolName));
          },
        });
      }, 131072);
    }

    const chatPath = join(sessionDir, "chat_history.jsonl");
    if (existsSync(chatPath)) {
      forEachPartialJsonlLine(chatPath, null, (rawLine) => {
        if (!isGrokChatIndexedLine(rawLine, 0, rawLine.length)) return;
        const line = parseJsonlLine(rawLine);
        if (!line) return;
        visitGrokChatHistoryLine(line, {
          onUserPrompt(clean) {
            if (!firstPrompt) firstPrompt = truncateFirstPrompt(clean);
            accumulate(tf, clean);
          },
          onAssistantString(t) {
            const clean = collapseWhitespace(t);
            if (clean) accumulate(tf, clean);
          },
          onAssistantBlockText(text) {
            const clean = collapseWhitespace(text);
            if (clean) accumulate(tf, clean);
          },
        });
      });
    }
    return { firstPrompt, model, termFreqs: finalizeTf(tf), tools: [...tools] };
  } catch (err) {
    console.error(`peekGrok: failed to peek ${sessionDir}:`, err.message);
    return emptyPeekResult();
  }
}

/** Row matches indexable user/assistant parts (text, reasoning, or message-only row). */
function peekOpenCodePromptRow(role, partType) {
  if (role !== "user" && role !== "assistant") return false;
  return partType == null || isOpenCodeTermIndexPartType(partType);
}

export function peekOpenCode(session) {
  try {
    const sessionId = session.file;
    return withOpenCodeDb((db) => {
      let firstPrompt = null;
      let model = null;
      const tools = new Set();
      const tf = makeTfState();
      if (session.title) accumulate(tf, session.title);

      let promptRows = 0;
      forEachOpenCodeMessagePart(db, sessionId, ({ message, part }) => {
        const role = message.role;
        if (!model && message.modelID) model = message.modelID;
        const partType = part?.type ?? null;
        if (partType === "tool" && part.tool) {
          tools.add(normalizeToolName(part.tool));
        }

        if (peekOpenCodePromptRow(role, partType)) {
          if (promptRows < 20 && isOpenCodeTermIndexPartType(partType)) {
            const t = part.text || part.content || "";
            if (isDisplayableUserText(t)) {
              const clean = collapseWhitespace(t);
              if (role === "user" && partType === "text" && !firstPrompt) {
                firstPrompt = truncateFirstPrompt(clean);
              }
              accumulate(tf, clean);
            }
          }
          promptRows++;
        }
      });

      return {
        firstPrompt: firstPrompt || session.title,
        model,
        termFreqs: finalizeTf(tf),
        tools: [...tools],
      };
    });
  } catch (err) {
    console.error(`peekOpenCode: failed to peek ${session.file}:`, err.message);
    return { firstPrompt: session.title || null, model: null, termFreqs: null, tools: [] };
  }
}
