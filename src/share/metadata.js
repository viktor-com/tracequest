import { sessionGrade } from "../sessions/session-grade.js";
import { buildSessionChapters } from "../chapters/session-chapters.js";
import { sessionHash } from "../sessions/session-hash.js";
import { enrichChaptersForRender } from "../chapters/chapter-render-enrich.js";
import { chapterFileKeys } from "../chapters/chapter-keys.js";
import { FIRST_PROMPT_MAX_LEN, safeSlice } from "../parse/parse-utils.js";
import { formatDuration, estimateParsedStatsCost } from "../filter/filter-formats.js";
import { normalizeProjectFolder } from "../server/server-session-path.js";
import { peekSession } from "../sessions.js";
import { getSessionMeta } from "../server/server-helpers.js";

/** Match Runs, chat and rendered reports using the indexed grade definition. */
export function computeSessionGradeForShare(session) {
  const grade = sessionGrade(session);
  return grade.letter === "-" ? null : { score: grade.score, letter: grade.letter };
}

function firstPromptFromSession(session, indexMeta) {
  if (indexMeta?.firstPrompt) return safeSlice(indexMeta.firstPrompt, FIRST_PROMPT_MAX_LEN);
  for (const e of session.events || []) {
    if (e.type === "user" && e.text) return safeSlice(e.text, FIRST_PROMPT_MAX_LEN);
  }
  return session.title ? safeSlice(session.title, FIRST_PROMPT_MAX_LEN) : "";
}

/**
 * Build share metadata from parsed session + index/discovery sources.
 * @param {object} session Parsed session
 * @param {object} [opts]
 * @param {object} [opts.discovery] Session discovery row (path, project, source)
 */
export function buildShareMetadata(session, opts = {}) {
  const discovery = opts.discovery || null;
  let indexMeta = opts.indexMeta || null;

  if (!indexMeta && discovery?.path) {
    indexMeta = getSessionMeta(new Map(), discovery, peekSession);
  }

  const chapters = buildSessionChapters(session);
  enrichChaptersForRender(chapters);
  const grade = computeSessionGradeForShare(session);
  const stats = session.stats || {};
  const firstPrompt = firstPromptFromSession(session, indexMeta);
  const projectRaw = discovery?.project || session.project || session.cwd || "";
  const project = normalizeProjectFolder(projectRaw);

  const filePaths = [];
  for (const ch of chapters) {
    for (const f of chapterFileKeys(ch)) {
      if (!filePaths.includes(f)) filePaths.push(f);
    }
  }

  const meta = {
    sessionId: session.sessionId || "",
    sessionHash: session.sessionHash || (session.path || discovery?.path ? sessionHash(session.path || discovery.path) : ""),
    source: session.source || discovery?.source || "claude",
    model: session.model || indexMeta?.model || "",
    project,
    firstPrompt,
    duration: session.durationMs || indexMeta?.durationMs || 0,
    durationFormatted: formatDuration(session.durationMs || indexMeta?.durationMs || 0),
    inputTokens: stats.totalInputTokens || indexMeta?.inputTokens || 0,
    outputTokens: stats.totalOutputTokens || indexMeta?.outputTokens || 0,
    cacheTokens: stats.totalCacheHit || indexMeta?.cacheReadTokens || 0,
    toolCounts: stats.toolCounts || indexMeta?.toolCounts || {},
    chapterCount: chapters.length,
    grade,
    timestamp: session.startTime || null,
    eventCount: session.eventCount || (session.events?.length || 0),
    errorCount: stats.errors || indexMeta?.errors || 0,
    tools: Object.keys(stats.toolCounts || indexMeta?.toolCounts || {}),
    filePaths,
    gitBranch: session.gitBranch || null,
    costEstimate: estimateParsedStatsCost(session.model, stats),
    tokensEstimated: !!stats.tokensEstimated,
    timesEstimated: !!session.timesEstimated,
  };

  return meta;
}

/** Public findings shape (no raw secret). */
export function publicFindings(findings) {
  return findings.map(({ ruleId, description, match, location }) => ({
    ruleId,
    description,
    match,
    location: {
      chapterIndex: location.chapterIndex,
      eventIndex: location.eventIndex,
      eventType: location.eventType,
      toolName: location.toolName,
      field: location.field,
    },
  }));
}
