import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { isDisplayableUserText, capContent, parseToolArgs } from "./parse-utils.js";
import { forEachJsonlLineFromFile, parseJsonlLine, parseJsonlLineAt } from "./jsonl-read.js";
import { isGrokChatIndexedLine, isGrokEventsIndexedLine } from "./grok-chat-index.js";
import { errorPattern, normalizeToolName, enrichToolEvent } from "./parse-enrich.js";
import { buildSession } from "./parse-session-build.js";

export function extractUserQuery(text) {
  const trimmed = text.trim();
  const uq = trimmed.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  if (uq) {
    const inner = uq[1].trim();
    // Slash commands: extract the actual user input from <command-args> or <command-message>
    const args = inner.match(/<command-args>([\s\S]*?)<\/command-args>/);
    if (args) return args[1].trim() || null;
    const msg = inner.match(/<command-message>([\s\S]*?)<\/command-message>/);
    if (msg) return msg[1].trim() || null;
    if (inner && !isDisplayableUserText(inner)) return null;
    return inner;
  }
  if (trimmed && !isDisplayableUserText(trimmed)) return null;
  return trimmed;
}

export function parseGrok(sessionDir) {
  const events = [];
  let assistantCount = 0;
  let sessionId = null;
  let cwd = null;
  let model = null;
  let gitBranch = null;

  const ctxPath = join(sessionDir, "prompt_context.json");
  if (existsSync(ctxPath)) {
    try {
      const ctx = JSON.parse(readFileSync(ctxPath, "utf-8"));
      cwd = ctx.working_directory;
      model = ctx.model_id || "grok";
    } catch (err) {
      console.error(`parseGrok: failed to parse ${ctxPath}:`, err.message);
    }
  }

  // Build tool outcome map from events.jsonl keyed by sequential index
  const toolOutcomes = [];
  const turnTimestamps = [];
  const eventsPath = join(sessionDir, "events.jsonl");
  if (existsSync(eventsPath)) {
    forEachJsonlLineFromFile(eventsPath, (text, start, end) => {
      if (!isGrokEventsIndexedLine(text, start, end)) return;
      const line = parseJsonlLineAt(text, start, end);
      if (!line) return;
      if (line.type === "turn_started") {
        sessionId = line.session_id;
        if (line.model_id) model = line.model_id;
        turnTimestamps.push({ start: line.ts, end: null });
      }
      if (line.type === "turn_ended" && turnTimestamps.length) {
        turnTimestamps[turnTimestamps.length - 1].end = line.ts;
      }
      if (line.type === "tool_started") {
        toolOutcomes.push({ ts: line.ts, name: normalizeToolName(line.tool_name), outcome: null, duration: null });
      }
      if (line.type === "tool_completed") {
        const name = normalizeToolName(line.tool_name);
        for (let i = toolOutcomes.length - 1; i >= 0; i--) {
          const t = toolOutcomes[i];
          if (t.name === name && !t.outcome) {
            t.outcome = line.outcome;
            t.duration = line.duration_ms;
            break;
          }
        }
      }
    });
  }

  const firstTs = turnTimestamps.length ? turnTimestamps[0].start : null;
  const lastTs = turnTimestamps.length ? (turnTimestamps[turnTimestamps.length - 1].end || turnTimestamps[turnTimestamps.length - 1].start) : null;

  // Parse chat_history.jsonl (compact indexed walk: skip filler system rows without parse)
  const chatPath = join(sessionDir, "chat_history.jsonl");
  if (existsSync(chatPath)) {
    const indexedObjs = [];
    forEachJsonlLineFromFile(chatPath, (text, start, end) => {
      if (!isGrokChatIndexedLine(text, start, end)) return;
      const obj = parseJsonlLineAt(text, start, end);
      if (obj) indexedObjs.push(obj);
    });
    let turnId = 0;
    let toolOutcomeIdx = 0;

    for (let i = 0; i < indexedObjs.length; i++) {
      const line = indexedObjs[i];

      if (line.type === "user") {
        const content = line.content;
        let text = "";
        if (typeof content === "string") text = content;
        else if (Array.isArray(content)) {
          const textParts = [];
          for (const b of content) {
            if (b.type === "text") textParts.push(b.text);
          }
          text = textParts.join("\n");
        }
        const userText = extractUserQuery(text);
        if (userText) {
          // Always include (truncating long prompts to 500 via safeSlice) for consistency with
          // other 4 parsers and to avoid silent data loss on long Grok user messages.
          events.push({ type: "user", timestamp: firstTs, text: capContent(userText, 500), uuid: `grok-user-${turnId++}` });
        }
      }

      if (line.type === "assistant") {
        const content = line.content || "";
        const text = typeof content === "string" ? content : "";
        if (!model && line.model_id) model = line.model_id;

        // Build tool calls from assistant's tool_calls array (OpenAI-style)
        const assistantToolCalls = (line.tool_calls || []).map((tc) => {
          const args = parseToolArgs(tc.arguments);
          return enrichToolEvent({
            id: tc.id || `grok-tool-${turnId++}`,
            rawName: tc.name,
            input: args,
          });
        });

        // Collect tool results that follow this assistant message
        const toolCalls = assistantToolCalls.length ? [...assistantToolCalls] : [];
        let j = i + 1;
        while (j < indexedObjs.length) {
          const next = indexedObjs[j];
          if (next.type === "tool_result" || next.type === "tool") {
            const callId = next.tool_call_id || `grok-tr-${turnId}`;
            const outcomeInfo = toolOutcomeIdx < toolOutcomes.length ? toolOutcomes[toolOutcomeIdx] : null;
            // If we didn't get tool calls from assistant message, build from outcomes
            if (!assistantToolCalls.length) {
              const toolName = outcomeInfo?.name || "unknown";
              toolCalls.push({ id: callId, name: toolName, input: "" });
            }
            const resultContent = typeof next.content === "string" ? next.content : JSON.stringify(next.content || "");
            const isError = outcomeInfo?.outcome === "error" || errorPattern.test(resultContent);
            events.push({
              type: "tool_result", timestamp: outcomeInfo?.ts || firstTs, toolUseId: callId,
              text: capContent(resultContent, 1000), isError, uuid: `grok-result-${turnId++}`,
            });
            toolOutcomeIdx++;
            j++;
          } else {
            break;
          }
        }

        assistantCount++;
        events.push({
          type: "assistant", timestamp: firstTs, text: capContent(text, 500), toolCalls,
          tokens: { input: 0, output: 0, cacheHit: 0, cacheWrite: 0 },
          stopReason: toolCalls.length ? "tool_use" : "end_turn", uuid: `grok-asst-${turnId++}`,
        });

        i = j - 1;
      }

      if ((line.type === "tool_result" || line.type === "tool") && !events.length) {
        const outcomeInfo = toolOutcomeIdx < toolOutcomes.length ? toolOutcomes[toolOutcomeIdx] : null;
        const resultContent = typeof line.content === "string" ? line.content : JSON.stringify(line.content || "");
        const isError = outcomeInfo?.outcome === "error" || errorPattern.test(resultContent);
        events.push({
          type: "tool_result", timestamp: outcomeInfo?.ts || firstTs, toolUseId: line.tool_call_id || `grok-tr-${turnId}`,
          text: capContent(resultContent, 1000), isError, uuid: `grok-result-${turnId++}`,
        });
        toolOutcomeIdx++;
      }
    }
  }

  // Backfill timestamps from turn boundaries
  if (turnTimestamps.length) {
    let turnIdx = 0;
    let userSeen = 0;
    for (const e of events) {
      if (e.type === "user") userSeen++;
      if (userSeen > 0 && turnIdx < turnTimestamps.length - 1 && e.type === "user" && userSeen > 1) turnIdx++;
      if (!e.timestamp || e.timestamp === firstTs) {
        e.timestamp = turnTimestamps[Math.min(turnIdx, turnTimestamps.length - 1)].start;
      }
    }
  }

  // Read session-level token data from signals.json
  const signalsPath = join(sessionDir, "signals.json");
  if (existsSync(signalsPath)) {
    try {
      const signals = JSON.parse(readFileSync(signalsPath, "utf-8"));
      const contextTokens = signals.contextTokensUsed || 0;
      if (contextTokens > 0) {
        const perTurn = Math.round(contextTokens / (assistantCount || 1));
        for (const e of events) {
          if (e.type === "assistant") {
            e.tokens = { input: perTurn, output: 0, cacheHit: 0, cacheWrite: 0 };
          }
        }
      }
    } catch (err) {
      console.error(`parseGrok: failed to parse ${signalsPath}:`, err.message);
    }
  }

  return buildSession({ sessionId, cwd, model, gitBranch, events, source: "grok" });
}