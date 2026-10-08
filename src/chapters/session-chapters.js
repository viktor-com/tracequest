import { newChapter, buildChapterEventMaps, accumulateAssistantToolCall } from "./chapter-accumulate.js";
import { markUserPromptCorrections } from "./chapter-patterns.js";
import { enrichChaptersQualityCore } from "./chapter-quality.js";
import { safeSlice } from "../parse/parse-utils.js";

/**
 * Build HTML-style chapters from a parsed session (shared by compare + render).
 * Stops before dependency detection; mutates nothing on session.
 */
export function buildSessionChapters(session) {
  const events = session.events || [];
  const chapters = [];
  let current = null;

  const { resultMap, toolNameMap } = buildChapterEventMaps(events);

  let compareUserPrompt = null;
  let compareAssistantPrompt = null;
  for (const e of events) {
    if (!compareUserPrompt && e.type === "user" && e.text) compareUserPrompt = e.text;
    else if (!compareAssistantPrompt && e.type === "assistant" && e.text && e.text.length > 20) {
      compareAssistantPrompt = e.text;
    }
    if (e.type === "user" && e.text) {
      if (current) chapters.push(current);
      current = newChapter(e.text, e.timestamp);
      continue;
    }

    if (!current) {
      if (e.type === "assistant") {
        current = newChapter("(subagent session)", e.timestamp || session.startTime);
      } else {
        continue;
      }
    }

    if (current.prompt === "(subagent session)" && e.type === "assistant" && e.text && e.text.length > 20) {
      current.prompt = e.text;
    }

    if (e.type === "assistant") {
      current.turns++;
      current.endTimestamp = e.timestamp;
      if (e.text) current.lastAssistantText = e.text;
      if (e.tokens) {
        current.tokens.input += e.tokens.input || 0;
        current.tokens.output += e.tokens.output || 0;
        current.tokens.cacheHit += e.tokens.cacheHit || 0;
        current.tokens.cacheWrite += e.tokens.cacheWrite || 0;
      }
      if (e.thinking && current.thinking.length < 20) {
        for (const t of e.thinking) {
          if (t) current.thinking.push(t);
        }
      }
      for (const tc of e.toolCalls || []) {
        accumulateAssistantToolCall(current, tc, resultMap, {
          trackCallSeq: true,
          searchOutput: true,
          agentResult: true,
          webFetchPreview: true,
        });
      }
    }

    if (e.type === "tool_result" && e.isError) {
      current.errors++;
      if (e.toolUseId != null && toolNameMap[e.toolUseId]) {
        current.errorTools[toolNameMap[e.toolUseId]] =
          (current.errorTools[toolNameMap[e.toolUseId]] || 0) + 1;
      } else if (e.toolUseId == null && current.standaloneErrors.length < 5) {
        // Session-level error not tied to any tool call (e.g. Cursor turn_ended errors).
        current.standaloneErrors.push(safeSlice(e.text || "(unknown error)", 300));
      }
    }
  }
  if (current) chapters.push(current);

  markUserPromptCorrections(chapters);

  for (const ch of chapters) {
    ch._fileKeys = Object.keys(ch.files);
    ch._toolKeys = Object.keys(ch.toolCounts);
  }

  enrichChaptersQualityCore(chapters);
  const comparePrompt =
    safeSlice(compareUserPrompt, 120) || safeSlice(compareAssistantPrompt, 120) || "";
  if (comparePrompt) chapters._comparePrompt = comparePrompt;
  return chapters;
}