/**
 * Cross-host aggregation for the insights view (facts insag, insex): turns
 * analysed session rows into the handful of answers the page shows. Pure —
 * `rows` are session API objects joined with their analysis record.
 */
import { errorClassLabel, TRAPS } from "./classify.js";
import { estimateCost } from "../filter/filter-formats.js";
import { redactText } from "./redact.js";

import { LOCAL_HOST_ID } from "../hub/pull-state.js";

const EXAMPLES = 5;
const PROMPT_LEN = 110;

function rate(errors, calls) {
  return calls > 0 ? errors / calls : 0;
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[at];
}

/** The link target and one-line identity of an example session. */
export function sessionRef(row, extra = {}) {
  const prompt = redactText(String(row.prompt || "")).replace(/\s+/g, " ").trim();
  return {
    path: row.path,
    hash: row.sessionHash || row.id || "",
    source: row.source,
    host: row.host || LOCAL_HOST_ID,
    project: row.project || "",
    prompt: prompt.length > PROMPT_LEN ? `${prompt.slice(0, PROMPT_LEN - 1)}…` : prompt,
    mtime: row.mtime || 0,
    ...extra,
  };
}

function topClasses(classCounts, n = 3) {
  return Object.entries(classCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([id, count]) => ({ id, label: errorClassLabel(id), count }));
}

/** Group rows by a key and report calls, errors, error rate and top classes. */
function breakdown(rows, keyOf, limit = 12) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    let g = groups.get(key);
    if (!g) {
      g = { key, sessions: 0, errorSessions: 0, calls: 0, errors: 0, classCounts: {}, worst: [] };
      groups.set(key, g);
    }
    const a = row.analysis;
    g.sessions += 1;
    g.calls += a.calls;
    g.errors += a.errors;
    if (a.errors > 0) {
      g.errorSessions += 1;
      g.worst.push(row);
    }
    for (const [id, n] of Object.entries(a.classes)) g.classCounts[id] = (g.classCounts[id] || 0) + n;
  }
  return [...groups.values()]
    .sort((a, b) => b.calls - a.calls)
    .slice(0, limit)
    .map((g) => ({
      key: g.key,
      sessions: g.sessions,
      errorSessions: g.errorSessions,
      calls: g.calls,
      errors: g.errors,
      errorRate: rate(g.errors, g.calls),
      topClasses: topClasses(g.classCounts),
      examples: g.worst
        .sort((a, b) => b.analysis.errors - a.analysis.errors)
        .slice(0, EXAMPLES)
        .map((row) => sessionRef(row, { note: `${row.analysis.errors} errors in ${row.analysis.calls} calls` })),
    }));
}

function histogram(values, edges, labels) {
  const buckets = labels.map((label) => ({ label, count: 0 }));
  for (const v of values) {
    let i = 0;
    while (i < edges.length && v >= edges[i]) i += 1;
    buckets[i].count += 1;
  }
  return buckets;
}

const MIN = 60 * 1000;

function fmtWait(ms) {
  const m = Math.round(ms / MIN);
  return m >= 90 ? `${(m / 60).toFixed(1)} h` : `${m} min`;
}

/**
 * @param {object[]} rows session API objects, each with `.analysis` (records
 *   without one are counted under `pending` and otherwise ignored)
 */
export function aggregateInsights(rows) {
  const all = Array.isArray(rows) ? rows : [];
  const done = all.filter((r) => r.analysis);

  let calls = 0;
  let errors = 0;
  let errorSessions = 0;
  let suspect = 0;
  let activeMs = 0;
  let tokens = 0;
  let cost = 0;
  const hosts = new Set();
  const classCounts = {};
  const classSessions = {};
  const classExamples = {};

  for (const row of done) {
    const a = row.analysis;
    calls += a.calls;
    errors += a.errors;
    suspect += a.suspect || 0;
    if (a.errors > 0) errorSessions += 1;
    activeMs += a.activeMs;
    tokens += row.totalTokens || 0;
    cost += estimateCost(row);
    hosts.add(row.host || LOCAL_HOST_ID);
    for (const [id, n] of Object.entries(a.classes)) {
      classCounts[id] = (classCounts[id] || 0) + n;
      classSessions[id] = (classSessions[id] || 0) + 1;
      (classExamples[id] ||= []).push({ row, n });
    }
  }

  const classes = Object.entries(classCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => ({
      id,
      label: errorClassLabel(id),
      count,
      sessions: classSessions[id],
      share: rate(count, errors),
      examples: classExamples[id]
        .sort((a, b) => b.n - a.n)
        .slice(0, EXAMPLES)
        .map(({ row, n }) => sessionRef(row, { note: `${n}× — ${row.analysis.examples[id] || ""}` })),
    }));

  const withRetries = done.filter((r) => r.analysis.retries > 0);
  const withLoops = done.filter((r) => r.analysis.loops > 0);
  const retries = {
    retries: withRetries.reduce((n, r) => n + r.analysis.retries, 0),
    sessions: withRetries.length,
    loops: withLoops.reduce((n, r) => n + r.analysis.loops, 0),
    loopCalls: withLoops.reduce((n, r) => n + r.analysis.loopCalls, 0),
    loopSessions: withLoops.length,
    examples: [...new Set([
      ...withLoops.sort((a, b) => b.analysis.loopCalls - a.analysis.loopCalls).slice(0, EXAMPLES),
      ...withRetries.sort((a, b) => b.analysis.retries - a.analysis.retries).slice(0, EXAMPLES),
    ])].slice(0, EXAMPLES).map((row) => sessionRef(row, {
      note: `${row.analysis.retries} retries, ${row.analysis.loops} loops`
        + (row.analysis.loopExample ? ` — ${row.analysis.loopExample}` : ""),
    })),
  };

  const activeSorted = done.map((r) => r.analysis.activeMs).filter((v) => v > 0).sort((a, b) => a - b);
  const tokenSorted = done.map((r) => r.totalTokens || 0).filter((v) => v > 0).sort((a, b) => a - b);
  const time = {
    activeMs,
    medianActiveMs: quantile(activeSorted, 0.5),
    p90ActiveMs: quantile(activeSorted, 0.9),
    medianTokens: quantile(tokenSorted, 0.5),
    p90Tokens: quantile(tokenSorted, 0.9),
    histogram: histogram(
      activeSorted,
      [5 * MIN, 15 * MIN, 60 * MIN, 240 * MIN],
      ["under 5 min", "5–15 min", "15–60 min", "1–4 h", "over 4 h"],
    ),
  };

  const stalled = done.filter((r) => r.analysis.stalls > 0);
  const stalls = {
    count: stalled.reduce((n, r) => n + r.analysis.stalls, 0),
    sessions: stalled.length,
    ms: stalled.reduce((n, r) => n + r.analysis.stallMs, 0),
    examples: stalled
      .filter((r) => r.analysis.longestStall)
      .sort((a, b) => b.analysis.longestStall.ms - a.analysis.longestStall.ms)
      .slice(0, EXAMPLES)
      .map((row) => sessionRef(row, {
        note: `${fmtWait(row.analysis.longestStall.ms)} waiting after ${row.analysis.longestStall.after}`,
      })),
  };

  const expensive = done
    .filter((r) => estimateCost(r) > 0)
    .sort((a, b) => estimateCost(b) - estimateCost(a))
    .slice(0, 10)
    .map((row) => sessionRef(row, {
      cost: estimateCost(row),
      tokens: row.totalTokens || 0,
      activeMs: row.analysis.activeMs,
      errors: row.analysis.errors,
      model: row.model || "",
    }));

  const traps = TRAPS.map((trap) => {
    const hit = done.filter((r) => (r.analysis.traps?.[trap.id]?.count || 0) > 0);
    const ms = hit.reduce((n, r) => n + (r.analysis.traps[trap.id].ms || 0), 0);
    return {
      id: trap.id,
      label: trap.label,
      hint: trap.hint,
      sessions: hit.length,
      events: hit.reduce((n, r) => n + r.analysis.traps[trap.id].count, 0),
      ms,
      examples: hit
        .sort((a, b) => b.analysis.traps[trap.id].count - a.analysis.traps[trap.id].count)
        .slice(0, EXAMPLES)
        .map((row) => sessionRef(row, {
          note: `${row.analysis.traps[trap.id].count}× — ${row.analysis.traps[trap.id].example}`,
        })),
    };
  });

  return {
    totals: {
      sessions: all.length,
      analyzed: done.length,
      pending: all.length - done.length,
      hosts: hosts.size,
      calls,
      errors,
      errorRate: rate(errors, calls),
      errorSessions,
      suspect,
      activeMs,
      tokens,
      cost,
    },
    classes,
    byHarness: breakdown(done, (r) => r.source),
    byArea: breakdown(done, (r) => r.analysis.area, 8),
    byHost: breakdown(done, (r) => r.host || LOCAL_HOST_ID),
    retries,
    time,
    stalls,
    expensive,
    traps,
  };
}
