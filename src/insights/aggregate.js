/**
 * Cross-host aggregation for the insights view (facts insag, insex): turns
 * analysed session rows into the handful of answers the page shows. Pure —
 * `rows` are session API objects joined with their analysis record.
 */
import { errorClassLabel, TRAPS } from "./classify.js";
import { estimateCost } from "../filter/filter-formats.js";
import { redactText } from "./redact.js";

import { LOCAL_HOST_ID } from "../hub/pull-state.js";
import { measuredDurationMs } from "../sessions/session-duration.js";

const EXAMPLES = 5;
const PROMPT_LEN = 110;

/**
 * Per-record and per-row derivations, computed once per object: analysis
 * records and session rows are reused across requests while they are unchanged
 * (fact inslm), so re-aggregating does not re-allocate them every time.
 */
const _recordFacts = new WeakMap();
const _rowCosts = new WeakMap();

/** The numbers aggregation reads from one analysis record, in one fixed shape. */
class RecordFacts {
  constructor(a) {
    this.calls = a.calls;
    this.errors = a.errors;
    this.suspect = a.suspect || 0;
    this.activeMs = a.activeMs;
    this.retries = a.retries;
    this.loops = a.loops;
    this.loopCalls = a.loopCalls;
    this.stalls = a.stalls;
    this.stallMs = a.stallMs;
    this.longestStallMs = a.longestStall ? a.longestStall.ms : null;
    this.area = a.area;
    this.entries = Object.entries(a.classes || {});
    this.trapCounts = TRAPS.map((trap) => a.traps?.[trap.id]?.count || 0);
    this.trapMs = TRAPS.map((trap) => a.traps?.[trap.id]?.ms || 0);
  }
}

function recordFacts(a) {
  let f = _recordFacts.get(a);
  if (!f) {
    f = new RecordFacts(a);
    _recordFacts.set(a, f);
  }
  return f;
}

function rowCost(row) {
  let cost = _rowCosts.get(row);
  if (cost === undefined) {
    cost = estimateCost(row);
    _rowCosts.set(row, cost);
  }
  return cost;
}

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

/**
 * An error class example's note: the session's count for the whole class, how
 * many of those carry the shown message, then the message (fact insexn).
 */
function classNote(n, sameMessage, message) {
  const head = n === 1 ? "1 error of this class" : `${n} errors of this class`;
  const same = n > 1 && sameMessage > 0 ? `, ${sameMessage === n ? "all" : sameMessage} with this message` : "";
  return `${head}${same}; e.g. ${message || ""}`;
}

function topClasses(classCounts, n = 3) {
  return Object.entries(classCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([id, count]) => ({ id, label: errorClassLabel(id), count }));
}

/**
 * Keep the k items with the largest key, in the order a stable descending sort
 * would leave them: an item goes after every kept item whose key is not smaller
 * (all of which came earlier). Same answer as `sort(desc).slice(0, k)` without
 * collecting and sorting every candidate.
 */
function offerTop(list, k, item, key) {
  const v = key(item);
  let i = list.length;
  while (i > 0 && key(list[i - 1]) < v) i -= 1;
  if (i >= k) return;
  list.splice(i, 0, item);
  if (list.length > k) list.pop();
}

/**
 * A row's agent time (fact insac): the session's indexed duration, the one
 * worked-time computation the session list, its overview total and the view
 * show (fact durac). Only a row without one (no index entry) falls back to
 * its analysis record. A source without event timestamps has none (fact insut).
 */
function rowWorkedMs(row, a) {
  return measuredDurationMs(row.source, typeof row.durationMs === "number" ? row.durationMs : a?.activeMs || 0);
}

/**
 * Agent time over every row in scope, analysed or not (fact durins): it is the
 * rows' indexed duration, so a session the insights refresh has not reached yet
 * still counts, as it does in the session list's total.
 */
export function workedTimeOf(rows) {
  let activeMs = 0;
  const values = [];
  for (const row of rows) {
    const ms = rowWorkedMs(row, row.analysis ? recordFacts(row.analysis) : null);
    activeMs += ms;
    if (ms > 0) values.push(ms);
  }
  // Typed arrays sort numerically without a comparator call per comparison.
  const sorted = Float64Array.from(values).sort();
  return {
    activeMs,
    medianActiveMs: quantile(sorted, 0.5),
    p90ActiveMs: quantile(sorted, 0.9),
    histogram: histogram(
      sorted,
      [5 * MIN, 15 * MIN, 60 * MIN, 240 * MIN],
      ["under 5 min", "5–15 min", "15–60 min", "1–4 h", "over 4 h"],
    ),
  };
}

const byErrors = (row) => row.analysis.errors;
const byCost = (p) => p.cost;
const byCount = (x) => x.n;
const byRetries = (row) => row.analysis.retries;
const byLoopCalls = (row) => row.analysis.loopCalls;
const byLongestStall = (row) => row.analysis.longestStall.ms;

/** Running group for breakdown(): calls, errors, classes and the worst rows. */
function groupOf(groups, key) {
  let g = groups.get(key);
  if (!g) {
    g = { key, sessions: 0, errorSessions: 0, calls: 0, errors: 0, classCounts: {}, worst: [] };
    groups.set(key, g);
  }
  return g;
}

function addToGroup(g, row, a, entries) {
  g.sessions += 1;
  g.calls += a.calls;
  g.errors += a.errors;
  if (a.errors > 0) {
    g.errorSessions += 1;
    offerTop(g.worst, EXAMPLES, row, byErrors);
  }
  for (const [id, n] of entries) g.classCounts[id] = (g.classCounts[id] || 0) + n;
}

/** Report each group's calls, errors, error rate and top classes, most calls first. */
function breakdown(groups, limit = 12) {
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
      examples: g.worst.map((row) => sessionRef(row, { note: `${row.analysis.errors} errors in ${row.analysis.calls} calls` })),
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
 *
 * One pass over the analysed rows (fact inslm): every ranking keeps only its
 * top entries as it goes, in the order a stable sort would give them.
 */
export function aggregateInsights(rows) {
  const all = Array.isArray(rows) ? rows : [];
  const done = all.filter((r) => r.analysis);

  let calls = 0;
  let errors = 0;
  let errorSessions = 0;
  let suspect = 0;
  let tokens = 0;
  let cost = 0;
  const hosts = new Set();
  const classCounts = {};
  const classSessions = {};
  const classExamples = {};
  const byHarness = new Map();
  const byArea = new Map();
  const byHost = new Map();
  const retryAcc = { retries: 0, sessions: 0, loops: 0, loopCalls: 0, loopSessions: 0, topLoops: [], topRetries: [] };
  const tokenValues = [];
  const stallAcc = { count: 0, sessions: 0, ms: 0, top: [] };
  /** The ten priciest rows, each priced once (sorting used to re-price them n log n times). */
  const priced = [];
  const trapAcc = TRAPS.map((trap) => ({ trap, sessions: 0, events: 0, ms: 0, top: [], key: (r) => r.analysis.traps[trap.id].count }));

  for (const row of done) {
    const a = recordFacts(row.analysis);
    const entries = a.entries;
    const host = row.host || LOCAL_HOST_ID;
    calls += a.calls;
    errors += a.errors;
    suspect += a.suspect || 0;
    if (a.errors > 0) errorSessions += 1;
    const rowTokens = row.totalTokens || 0;
    tokens += rowTokens;
    const price = rowCost(row);
    if (price > 0) offerTop(priced, 10, { row, cost: price }, byCost);
    cost += price;
    hosts.add(host);
    for (const [id, n] of entries) {
      classCounts[id] = (classCounts[id] || 0) + n;
      classSessions[id] = (classSessions[id] || 0) + 1;
      offerTop((classExamples[id] ||= []), EXAMPLES, { row, n }, byCount);
    }

    if (row.source) addToGroup(groupOf(byHarness, row.source), row, a, entries);
    if (a.area) addToGroup(groupOf(byArea, a.area), row, a, entries);
    addToGroup(groupOf(byHost, host), row, a, entries);

    if (a.retries > 0) {
      retryAcc.retries += a.retries;
      retryAcc.sessions += 1;
      offerTop(retryAcc.topRetries, EXAMPLES, row, byRetries);
    }
    if (a.loops > 0) {
      retryAcc.loops += a.loops;
      retryAcc.loopCalls += a.loopCalls;
      retryAcc.loopSessions += 1;
      offerTop(retryAcc.topLoops, EXAMPLES, row, byLoopCalls);
    }

    if (rowTokens > 0) tokenValues.push(rowTokens);

    if (a.stalls > 0) {
      stallAcc.count += a.stalls;
      stallAcc.sessions += 1;
      stallAcc.ms += a.stallMs;
      if (a.longestStallMs !== null) offerTop(stallAcc.top, EXAMPLES, row, byLongestStall);
    }

    for (let t = 0; t < trapAcc.length; t++) {
      const count = a.trapCounts[t];
      if (!(count > 0)) continue;
      const acc = trapAcc[t];
      acc.sessions += 1;
      acc.events += count;
      acc.ms += a.trapMs[t];
      offerTop(acc.top, EXAMPLES, row, acc.key);
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
        .map(({ row, n }) => sessionRef(row, { note: classNote(n, row.analysis.exampleCounts?.[id], row.analysis.examples[id]) })),
    }));

  const retries = {
    retries: retryAcc.retries,
    sessions: retryAcc.sessions,
    loops: retryAcc.loops,
    loopCalls: retryAcc.loopCalls,
    loopSessions: retryAcc.loopSessions,
    examples: [...new Set([...retryAcc.topLoops, ...retryAcc.topRetries])].slice(0, EXAMPLES).map((row) => sessionRef(row, {
      note: `${row.analysis.retries} retries, ${row.analysis.loops} loops`
        + (row.analysis.loopExample ? ` — ${row.analysis.loopExample}` : ""),
    })),
  };

  const worked = workedTimeOf(all);
  const tokenSorted = Float64Array.from(tokenValues).sort();
  const time = {
    activeMs: worked.activeMs,
    medianActiveMs: worked.medianActiveMs,
    p90ActiveMs: worked.p90ActiveMs,
    medianTokens: quantile(tokenSorted, 0.5),
    p90Tokens: quantile(tokenSorted, 0.9),
    histogram: worked.histogram,
  };

  const stalls = {
    count: stallAcc.count,
    sessions: stallAcc.sessions,
    ms: stallAcc.ms,
    examples: stallAcc.top.map((row) => sessionRef(row, {
      note: `${fmtWait(row.analysis.longestStall.ms)} waiting after ${row.analysis.longestStall.after}`,
    })),
  };

  const expensive = priced.map(({ row, cost: rowCostValue }) => sessionRef(row, {
    cost: rowCostValue,
    tokens: row.totalTokens || 0,
    activeMs: rowWorkedMs(row, recordFacts(row.analysis)),
    errors: row.analysis.errors,
    model: row.model || "",
  }));

  const traps = trapAcc.map(({ trap, sessions, events, ms, top }) => ({
    id: trap.id,
    label: trap.label,
    hint: trap.hint,
    sessions,
    events,
    ms,
    examples: top.map((row) => sessionRef(row, {
      note: `${row.analysis.traps[trap.id].count}× — ${row.analysis.traps[trap.id].example}`,
    })),
  }));

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
      activeMs: worked.activeMs,
      tokens,
      cost,
    },
    classes,
    byHarness: breakdown(byHarness),
    byArea: breakdown(byArea, 8),
    byHost: breakdown(byHost),
    retries,
    time,
    stalls,
    expensive,
    traps,
  };
}
