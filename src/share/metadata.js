import { buildSessionChapters } from "../chapters/session-chapters.js";
import { sessionHash } from "../sessions/session-hash.js";
import { enrichChaptersForRender } from "../chapters/chapter-render-enrich.js";
import { chapterFileKeys } from "../chapters/chapter-keys.js";
import { FIRST_PROMPT_MAX_LEN, safeSlice, sumToolCounts } from "../parse/parse-utils.js";
import { formatDuration, estimateParsedStatsCost } from "../filter/filter-formats.js";
import { normalizeProjectFolder } from "../server/server-session-path.js";
import { peekSession } from "../sessions.js";
import { getSessionMeta } from "../server/server-helpers.js";

function aggregateChapterMetrics(chapters) {
  let totalErrors = 0;
  let totalRetries = 0;
  let totalSelfCorrections = 0;
  let cleanCount = 0;
  let correctedCount = 0;
  for (const ch of chapters) {
    totalErrors += ch.errors || 0;
    totalRetries += ch.retries || 0;
    totalSelfCorrections += ch.selfCorrections || 0;
    if (ch.outcome === "clean") cleanCount++;
    else if (ch.outcome === "corrected") correctedCount++;
  }
  return { totalErrors, totalRetries, totalSelfCorrections, cleanCount, correctedCount };
}

/** Match rendered HTML session grade (render-core-shell computeSessionGrade). */
export function computeSessionGradeForShare(session, chapters) {
  const s = session.stats || {};
  const totalChapters = chapters.length;
  if (totalChapters === 0) return null;

  const m = aggregateChapterMetrics(chapters);
  const totalToolCalls = sumToolCounts(s.toolCounts || {});
  const totalErrors = m.totalErrors;
  const totalRetries = m.totalRetries;
  const totalSelfCorrections = m.totalSelfCorrections;
  const cleanCount = m.cleanCount;
  const correctedCount = m.correctedCount;
  const isSubagent = totalChapters === 1;

  const errorRatio = totalToolCalls > 0 ? totalErrors / totalToolCalls : 0;
  const errorScore = Math.max(0, 100 - errorRatio * 250);

  const qualityNumerator = cleanCount + correctedCount * (isSubagent ? 0.8 : 0.6);
  const qualityRatio = qualityNumerator / totalChapters;
  const qualityScore = Math.min(100, qualityRatio * 100);

  const retryRatio = totalToolCalls > 0 ? totalRetries / totalToolCalls : 0;
  const retryScore = retryRatio <= 0.20 ? 100 : Math.max(0, 100 - (retryRatio - 0.20) * 333);

  const correctionScore = totalErrors === 0 ? 100
    : Math.min(100, (totalSelfCorrections / totalErrors) * 100);

  const cacheHit = s.totalCacheHit || 0;
  const totalInput = s.totalInputTokens || 0;
  const cacheRatio = totalInput > 0 ? cacheHit / totalInput : 0;
  const cacheScore = totalInput < 10000 ? 75 : Math.min(100, cacheRatio * 125);

  const score = Math.round(
    errorScore * 0.35 +
    qualityScore * 0.20 +
    retryScore * 0.10 +
    correctionScore * 0.15 +
    cacheScore * 0.20,
  );

  const clampedScore = Math.max(0, Math.min(100, score));
  let letter;
  if (clampedScore >= 90) letter = "A";
  else if (clampedScore >= 80) letter = "B";
  else if (clampedScore >= 70) letter = "C";
  else if (clampedScore >= 60) letter = "D";
  else letter = "F";

  return { score: clampedScore, letter };
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
  const grade = computeSessionGradeForShare(session, chapters);
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
