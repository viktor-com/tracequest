import { normalizeToolName } from "../parse/parse-enrich.js";
import { collapseWhitespace, isDisplayableUserText, truncateFirstPrompt } from "../parse/parse-utils.js";
import { emptyIndexMeta, buildIndexMeta } from "./session-meta.js";
import { accumulateTermFreqs, TOKENIZER_INPUT_CAP } from "./search-tokenizer.js";
import { openOpenCodeDbAtPath, parseOpenCodeUri, resolveOpenCodeDbForUri, withOpenCodeDb } from "./session-discovery-paths.js";

/** Part types whose body is tokenized for BM25 search (text + reasoning). */
export const OPENCODE_TERM_INDEX_PART_TYPES = Object.freeze(["text", "reasoning"]);

/** SQLite IN-list derived from {@link OPENCODE_TERM_INDEX_PART_TYPES}. */
export const OPENCODE_TERM_INDEX_PART_TYPES_SQL =
  OPENCODE_TERM_INDEX_PART_TYPES.map((t) => `'${t}'`).join(", ");

export function isOpenCodeTermIndexPartType(partType) {
  return OPENCODE_TERM_INDEX_PART_TYPES.includes(partType);
}

const OPENCODE_MESSAGE_PARTS_SQL = `
  SELECT m.id AS message_id, m.time_created, m.data AS msg_data, p.data AS part_data
  FROM message m
  LEFT JOIN part p ON p.message_id = m.id
  WHERE m.session_id = ?
  ORDER BY m.time_created
`;

/**
 * Walk OpenCode SQLite message/part join rows in time order.
 * Message JSON is parsed once per message_id; part is null when the LEFT JOIN has no part row.
 */
export function forEachOpenCodeMessagePart(db, sessionId, visit) {
  const rows = db.prepare(OPENCODE_MESSAGE_PARTS_SQL).all(sessionId);
  const msgById = new Map();
  for (const row of rows) {
    let message = msgById.get(row.message_id);
    if (!message) {
      message = JSON.parse(row.msg_data);
      msgById.set(row.message_id, message);
    }
    visit({
      messageId: row.message_id,
      timeCreated: row.time_created,
      message,
      part: row.part_data ? JSON.parse(row.part_data) : null,
    });
  }
}

export function accumulateOpenCodeMessages(db, sessionId) {
  let firstPrompt = null;
  let model = null;
  let chapters = 0;
  const seenUserMessages = new Set();
  const tools = new Set();
  const toolCounts = {};
  let errors = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let firstTs = null;
  let lastTs = null;
  /** @type {Map<string,number>} */
  const termFreqs = new Map();
  const tfBudget = [TOKENIZER_INPUT_CAP];

  forEachOpenCodeMessagePart(db, sessionId, ({ messageId, timeCreated, message, part }) => {
    const tc = timeCreated;
    if (tc != null && tc !== "") {
      if (firstTs == null || tc < firstTs) firstTs = tc;
      if (lastTs == null || tc > lastTs) lastTs = tc;
    }
    if (!model && message.modelID) model = message.modelID;
    if (message.role === "user" && !seenUserMessages.has(messageId)) {
      seenUserMessages.add(messageId);
      chapters++;
    }
    if (!part) return;

    if (part.status === "error") errors++;

    if (part.type === "step-finish" && part.tokens) {
      inputTokens += part.tokens.input || 0;
      outputTokens += part.tokens.output || 0;
      if (part.tokens.cache) {
        cacheReadTokens += part.tokens.cache.read || 0;
        inputTokens += (part.tokens.cache?.read || 0) + (part.tokens.cache?.write || 0);
      }
      return;
    }

    if (part.type === "tool") {
      if (part.tool) {
        const tn = normalizeToolName(part.tool);
        tools.add(tn);
        toolCounts[tn] = (toolCounts[tn] || 0) + 1;
      }
      return;
    }

    if (!isOpenCodeTermIndexPartType(part.type)) return;

    const t = part.text || part.content || "";
    if (isDisplayableUserText(t)) {
      const clean = collapseWhitespace(t);
      if (part.type === "text" && message.role === "user" && !firstPrompt) firstPrompt = truncateFirstPrompt(clean);
      accumulateTermFreqs(clean, termFreqs, tfBudget);
    }
  });

  let durationMs = 0;
  if (firstTs != null && lastTs != null) {
    durationMs = new Date(lastTs).getTime() - new Date(firstTs).getTime();
  }

  return {
    firstPrompt,
    model,
    chapters,
    tools: [...tools],
    toolCounts,
    errors,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    totalTokens: inputTokens + outputTokens,
    durationMs,
    termFreqs: termFreqs.size ? termFreqs : null,
  };
}

export function indexOpenCode(session, db = null) {
  try {
    const parsed = parseOpenCodeUri(session.path || "");
    const sessionId = session.file || parsed.sessionId;
    const build = (database) => {
      const { termFreqs, ...fields } = accumulateOpenCodeMessages(database, sessionId);
      const meta = buildIndexMeta({
        ...fields,
        firstPrompt: fields.firstPrompt || session.title,
      });
      if (termFreqs) meta.termFreqs = termFreqs;
      return meta;
    };
    if (db) return build(db);
    if (parsed.host) {
      const { db: hostDb } = openOpenCodeDbAtPath(resolveOpenCodeDbForUri(session.path));
      try {
        return build(hostDb);
      } finally {
        hostDb.close();
      }
    }
    return withOpenCodeDb(build);
  } catch (err) {
    console.error(`indexOpenCode: failed to index ${session.file}:`, err.message);
    return emptyIndexMeta({ firstPrompt: session.title || null });
  }
}
