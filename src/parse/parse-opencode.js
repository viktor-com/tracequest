import { existsSync } from "node:fs";
import { parseJsonlLine } from "./jsonl-read.js";
import { isDisplayableUserText, capContent } from "./parse-utils.js";
import { openOpenCodeDbAtPath, parseOpenCodeUri, resolveOpenCodeDbForUri } from "../sessions/session-discovery-paths.js";
import { errorPattern, enrichToolEvent } from "./parse-enrich.js";
import { buildSession } from "./parse-session-build.js";
import { isIndexDiskExpectedErr } from "../utils/fs-expected-err.js";

function emptyOpenCodeSession(sessionId) {
  return buildSession({
    sessionId,
    cwd: null,
    model: null,
    gitBranch: null,
    events: [],
    source: "opencode",
  });
}

export function parseOpenCode(uri) {
  const { sessionId } = parseOpenCodeUri(uri);
  const dbPath = resolveOpenCodeDbForUri(uri);
  if (!existsSync(dbPath)) return emptyOpenCodeSession(sessionId);

  let db;
  try {
    ({ db } = openOpenCodeDbAtPath(dbPath));
  } catch (err) {
    if (!isIndexDiskExpectedErr(err)) {
      console.error(`parseOpenCode: failed to open ${dbPath}:`, err.message);
    }
    return emptyOpenCodeSession(sessionId);
  }

  const sessionRow = db.prepare("SELECT * FROM session WHERE id = ?").get(sessionId);
  const cwd = sessionRow?.directory || null;
  const title = sessionRow?.title || null;

  const rows = db
    .prepare(
      `
      SELECT m.id as message_id, m.data as msg_data, p.data as part_data
      FROM message m
      LEFT JOIN part p ON p.message_id = m.id
      WHERE m.session_id = ?
      ORDER BY m.time_created, p.time_created, p.rowid
    `
    )
    .all(sessionId);

  const events = [];
  let model = null;
  let turnId = 0;

  function processMessage(messageId, data, partDataRows) {
    if (!model && data.modelID) model = data.modelID;
    const ts = data.time?.created ? new Date(data.time.created).toISOString() : null;

    if (data.role === "user") {
      let userText = "";
      for (let pi = 0; pi < partDataRows.length; pi++) {
        const pd = parseJsonlLine(partDataRows[pi]);
        if (!pd) continue;
        if (pd.type === "text") {
          const t = pd.text || pd.content || "";
          if (t) userText += t + "\n";
        }
      }
      userText = userText.trim();
      if (isDisplayableUserText(userText)) {
        events.push({ type: "user", timestamp: ts, text: capContent(userText, 500), uuid: messageId });
      }
    }

    if (data.role === "assistant") {
      const toolCalls = [];
      let assistantText = "";
      let inputTokens = 0, outputTokens = 0, cacheHit = 0, cacheWrite = 0;

      for (let pi = 0; pi < partDataRows.length; pi++) {
        const pd = parseJsonlLine(partDataRows[pi]);
        if (!pd) continue;

        if (pd.type === "text") {
          const t = pd.text || pd.content || "";
          if (t) assistantText += t + "\n";
        }

        if (pd.type === "tool") {
          const state = pd.state || {};
          const input = state.input || {};
          toolCalls.push(enrichToolEvent({ id: pd.callID, rawName: pd.tool, input }));

          const isError = state.status === "error" || errorPattern.test(state.output || "");
          events.push({
            type: "tool_result", timestamp: ts, toolUseId: pd.callID,
            text: capContent(state.output || "", 1000), isError, uuid: `oc-result-${turnId++}`,
          });
        }

        if (pd.type === "step-finish" && pd.tokens) {
          inputTokens += pd.tokens.input || 0;
          outputTokens += pd.tokens.output || 0;
          if (pd.tokens.cache) {
            cacheHit += pd.tokens.cache.read || 0;
            cacheWrite += pd.tokens.cache.write || 0;
          }
          inputTokens += (pd.tokens.cache?.read || 0) + (pd.tokens.cache?.write || 0);
        }
      }

      events.push({
        type: "assistant", timestamp: ts, text: capContent(assistantText.trim(), 500), toolCalls,
        tokens: { input: inputTokens, output: outputTokens, cacheHit, cacheWrite },
        stopReason: toolCalls.length ? "tool_use" : "end_turn", uuid: messageId,
      });
    }
  }

  let currentMessageId = null;
  let currentData = null;
  let currentParts = null;
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri];
    if (row.message_id !== currentMessageId) {
      if (currentMessageId !== null && currentData) {
        processMessage(currentMessageId, currentData, currentParts);
      }
      currentMessageId = row.message_id;
      currentParts = [];
      currentData = parseJsonlLine(row.msg_data);
    }
    if (row.part_data) currentParts.push(row.part_data);
  }
  if (currentMessageId !== null && currentData) {
    processMessage(currentMessageId, currentData, currentParts);
  }

  try {
    return buildSession({ sessionId, cwd, model, gitBranch: null, events, source: "opencode" });
  } finally {
    db.close();
  }
}