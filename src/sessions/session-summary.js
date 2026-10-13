/**
 * One per-session summary — duration, token totals and the token split cost is
 * estimated from — shared by the session list and the session view, so both
 * show the same duration, tokens and cost for a session.
 *
 * The session index entry is that summary for the list (sessionToApiObject).
 * The view uses the same entry when it is current for the file (for an OpenCode
 * session, for the session's time_updated in its database); otherwise it
 * derives the figures from the parse in the index's conventions: Codex input
 * counts cached tokens (as total_token_usage does), Claude-family input is the
 * remainder after cache reads and writes, and the total is input plus output
 * with every cached token included.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { currentIndexEntry } from "./index-writers.js";
import { GROK_CHAT_FILE } from "./session-layout.js";
import { measuredDurationMs } from "./session-duration.js";
import { indexedWorkedMs } from "./session-index-jsonl.js";
import { indexOpenCode } from "./session-index-opencode.js";

function summaryFromIndexEntry(session, entry) {
  const source = session.source || "claude";
  return {
    model: entry.model || session.model || "",
    source,
    // Bounds of a session without event timestamps are not shown (fact durut).
    durationMs: measuredDurationMs(source, entry.durationMs),
    totalTokens: entry.totalTokens || 0,
    inputTokens: entry.inputTokens || 0,
    outputTokens: entry.outputTokens || 0,
    cacheReadTokens: entry.cacheReadTokens || 0,
  };
}

/**
 * The duration the index will record for the parsed session (facts durac,
 * durac3): its indexer's worked-time read over the recording's own records,
 * never a figure derived from the parsed events (whose times and order are the
 * view's, not the recording's).
 */
function parseWorkedMs(session, source) {
  const path = session.path || "";
  if (source === "opencode" && path.startsWith("opencode://")) {
    return indexOpenCode({ path, title: session.title || null }).durationMs || 0;
  }
  const worked = path && !path.includes("://") ? indexedWorkedMs(path, source) : null;
  return worked ?? session.durationMs ?? 0;
}

function summaryFromParse(session) {
  const source = session.source || "claude";
  const st = session.stats || {};
  const input = st.totalInputTokens || 0;
  const cacheRead = st.totalCacheHit || 0;
  const output = st.totalOutputTokens || 0;
  let cacheWrite = 0;
  for (const e of session.events || []) {
    if (e.type === "assistant" && e.tokens) cacheWrite += e.tokens.cacheWrite || 0;
  }
  return {
    model: session.model || "",
    source,
    durationMs: measuredDurationMs(source, parseWorkedMs(session, source)),
    totalTokens: input + output,
    inputTokens: source === "codex" ? input : Math.max(0, input - cacheRead - cacheWrite),
    outputTokens: output,
    cacheReadTokens: cacheRead,
  };
}

/** The file whose mtime discovery records for a session (a Grok session is a directory; its chat file). */
function indexedFileOf(session) {
  return session.source === "grok" ? join(session.path, GROK_CHAT_FILE) : session.path;
}

/**
 * Summary for a parsed session: its current index entry, else derived from the
 * parse. `indexEntry(path, mtimeMs)` finds the current entry (a session worker
 * passes one that answers from the server's index, fact hps2).
 */
export function sessionSummary(session, indexEntry = currentIndexEntry) {
  let entry = null;
  if (session?.path?.startsWith("opencode://")) {
    // An OpenCode session lives in a database: its entry is current for the
    // session's time_updated, which the parse records (parseOpenCode).
    if (session.sourceMtimeMs) entry = indexEntry(session.path, session.sourceMtimeMs);
  } else if (session?.path && !session.path.includes("://")) {
    try {
      entry = indexEntry(session.path, statSync(indexedFileOf(session)).mtimeMs);
    } catch {
      entry = null;
    }
  }
  return entry ? summaryFromIndexEntry(session, entry) : summaryFromParse(session);
}

/**
 * Splits `target` over integer `weights` in proportion (largest remainder), so
 * the parts are integers that sum to exactly `target`. Equal shares when every
 * weight is zero.
 */
function apportion(target, weights) {
  const n = weights.length;
  let sum = 0;
  for (const w of weights) sum += w;
  const parts = new Array(n);
  const rest = [];
  let given = 0;
  for (let i = 0; i < n; i++) {
    const exact = sum > 0 ? (weights[i] * target) / sum : target / n;
    parts[i] = Math.floor(exact);
    given += parts[i];
    rest.push([exact - parts[i], i]);
  }
  rest.sort((a, b) => b[0] - a[0]);
  for (let k = 0; given < target && k < rest.length; k++, given++) parts[rest[k][1]]++;
  return parts;
}

/**
 * Sources without recorded token usage (Cursor, Factory, Grok output, ...) carry
 * per-turn token estimates the parse makes from text length, and the session
 * index makes its own estimate for the whole session. So the view's turns,
 * chapters and stats show the same totals as the summary, the summary's
 * estimate is spread over the assistant turns in proportion to the parse's
 * per-turn estimates. Recorded (non-estimated) usage is never rescaled.
 */
function alignEstimatedTokens(session, summary) {
  const st = session.stats;
  if (!st?.tokensEstimated || !Array.isArray(session.events)) return;
  const turns = session.events.filter((e) => e.type === "assistant" && e.tokens);
  if (!turns.length) return;
  const targetOut = summary.outputTokens;
  const targetIn = Math.max(0, summary.totalTokens - summary.outputTokens);
  if (targetIn === (st.totalInputTokens || 0) && targetOut === (st.totalOutputTokens || 0)) return;
  const outWeights = turns.map((e) => e.tokens.output || 0);
  const inWeights = turns.map((e) => e.tokens.input || 0);
  const outs = apportion(targetOut, outWeights);
  // A parse with no input estimate at all spreads input like the output.
  const ins = apportion(targetIn, inWeights.some((w) => w > 0) ? inWeights : outWeights);
  turns.forEach((e, i) => {
    e.tokens.output = outs[i];
    e.tokens.input = ins[i];
  });
  st.totalInputTokens = targetIn;
  st.totalOutputTokens = targetOut;
}

/**
 * Attaches the per-session summary every page shows (session.summary) and
 * aligns estimated per-turn tokens with it, so the view header, chapter rows,
 * charts, compare and markdown all show the session list's figures.
 */
export function attachSessionSummary(session, indexEntry = currentIndexEntry) {
  const summary = sessionSummary(session, indexEntry);
  session.summary = summary;
  alignEstimatedTokens(session, summary);
  return session;
}
