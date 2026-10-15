import { statSync } from "node:fs";
import { join } from "node:path";
import { computeGrade } from "../filter/filter-formats.js";
import { buildSessionChapters } from "../chapters/session-chapters.js";
import { currentIndexEntry } from "./index-writers.js";
import { indexSession } from "./session-index-core.js";
import { GROK_CHAT_FILE } from "./session-layout.js";

/**
 * Grade a recording with the same metadata and definition as Runs/filter/sort.
 * Reuse a current index entry; CLI/offline renders index the read-only source
 * when no entry is loaded. Enriched chapter retry/outcome heuristics are not
 * inputs to this grade.
 */
export function sessionGrade(session) {
  let mtime = session.sourceMtimeMs;
  if (session.path && !session.path.includes("://")) {
    const file = session.source === "grok" ? join(session.path, GROK_CHAT_FILE) : session.path;
    try { mtime = statSync(file).mtimeMs; } catch { mtime = null; }
  }
  if (mtime != null || session.path?.startsWith("opencode://")) {
    const entry = mtime != null ? currentIndexEntry(session.path, mtime) : null;
    return computeGrade(entry || indexSession(session));
  }

  // Programmatic renders can supply an in-memory session without a recording.
  const s = session.stats || {};
  const cacheRead = s.totalCacheHit || 0;
  let cacheWrite = 0;
  for (const e of session.events || []) {
    if (e.type === "assistant") cacheWrite += e.tokens?.cacheWrite || 0;
  }
  return computeGrade({
    chapters: buildSessionChapters(session).length,
    errors: s.errors || 0,
    toolCounts: s.toolCounts || {},
    inputTokens: session.source === "codex" ? s.totalInputTokens || 0
      : Math.max(0, (s.totalInputTokens || 0) - cacheRead - cacheWrite),
    cacheReadTokens: cacheRead,
  });
}
