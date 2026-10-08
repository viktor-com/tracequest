import { sumToolCounts } from "../parse/parse-utils.js";
import {
  estimateParsedStatsCost,
  shortModel,
  fmtMcpName,
  fmtTokens,
  fmtCost,
  formatDuration,
  fmtCacheHitPct,
} from "../filter/filter-formats.js";
import { esc } from "../server/server-html-helpers.js";
import { sessionHash } from "../sessions/session-hash.js";
import { buildSessionChapters } from "./session-chapters.js";
import { summarizeChapterQuality } from "./chapter-quality.js";

const SOURCE_COLORS = {
  claude: "#a78bfa",
  codex: "#59d4a0",
  cursor: "#c4e86b",
  "cursor-cloud": "#4dd0e1",
  factory: "#e0c45e",
  opencode: "#6ba4e8",
  grok: "#f07070",
};

const TOOL_COLORS_CMP = {
  Bash: "#59d4a0",
  Edit: "#e0c45e",
  Write: "#d89660",
  Read: "#6ba4e8",
  Agent: "#a78bfa",
  Grep: "#7a7a85",
  Glob: "#7a7a85",
  Skill: "#c88abd",
  WebFetch: "#6ba4e8",
  WebSearch: "#6ba4e8",
  ToolSearch: "#7a7a85",
  SemanticSearch: "#7a7a85",
  Delete: "#f07070",
  Await: "#8b8b92",
  Ask: "#6ba4e8",
  CallMcpTool: "#5dadec",
};

/** @typedef {[string, string, string, "lower"|"higher"|"none", number?, number?]} CompareMetricRow */
/** @typedef {ReturnType<summarizeCompareSession>} CompareSummary */

const GRADE_QUALITY_KEYS = /** @type {const} */ (["clean", "corrected", "struggling"]);

/**
 * Session-level compare rows (label is the single source for COMPARE_METRIC_LABELS head).
 * @type {ReadonlyArray<{ label: string, build: (a: CompareSummary, b: CompareSummary, fmt: CompareRowFmt) => CompareMetricRow }>}
 */
const SESSION_COMPARE_SPECS = [
  {
    label: "Model",
    build(a, b, { displayModel }) {
      return ["Model", displayModel(a.model), displayModel(b.model), "none"];
    },
  },
  {
    label: "Duration",
    build(a, b, { fmtDur, noDataCell }) {
      const [va, ra] = noDataCell(a.durationMs, fmtDur, a.timesEstimated);
      const [vb, rb] = noDataCell(b.durationMs, fmtDur, b.timesEstimated);
      return ["Duration", va, vb, "lower", ra, rb];
    },
  },
  {
    label: "Chapters",
    build(a, b) {
      return ["Chapters", String(a.chapters), String(b.chapters), "none", a.chapters, b.chapters];
    },
  },
  {
    label: "Turns",
    build(a, b) {
      return ["Turns", String(a.turns), String(b.turns), "lower", a.turns, b.turns];
    },
  },
  {
    label: "Tool calls",
    build(a, b) {
      return [
        "Tool calls",
        String(a.totalToolCalls),
        String(b.totalToolCalls),
        "none",
        a.totalToolCalls,
        b.totalToolCalls,
      ];
    },
  },
  {
    label: "Cost",
    build(a, b, { fmtCostCmp, noDataCell }) {
      // fmtCostCmp already renders the universal "~$" estimate prefix, so no
      // extra "~" is added here even when tokensEstimated is set.
      const [va, ra] = noDataCell(a.cost, fmtCostCmp, false);
      const [vb, rb] = noDataCell(b.cost, fmtCostCmp, false);
      return ["Cost", va, vb, "lower", ra, rb];
    },
  },
  {
    label: "Input tokens",
    build(a, b, { fmtTok, noDataCell }) {
      const [va, ra] = noDataCell(a.inputTokens, fmtTok, a.tokensEstimated);
      const [vb, rb] = noDataCell(b.inputTokens, fmtTok, b.tokensEstimated);
      return ["Input tokens", va, vb, "lower", ra, rb];
    },
  },
  {
    label: "Output tokens",
    build(a, b, { fmtTok, noDataCell }) {
      const [va, ra] = noDataCell(a.outputTokens, fmtTok, a.tokensEstimated);
      const [vb, rb] = noDataCell(b.outputTokens, fmtTok, b.tokensEstimated);
      return ["Output tokens", va, vb, "none", ra, rb];
    },
  },
  {
    label: "Cache hit",
    build(a, b) {
      return [
        "Cache hit",
        fmtCacheHitPct(a.cacheHit, a.inputTokens),
        fmtCacheHitPct(b.cacheHit, b.inputTokens),
        "higher",
        a.cacheHit / Math.max(1, a.inputTokens),
        b.cacheHit / Math.max(1, b.inputTokens),
      ];
    },
  },
  {
    label: "Errors",
    build(a, b) {
      return ["Errors", String(a.errors), String(b.errors), "lower", a.errors, b.errors];
    },
  },
];

/**
 * Compare-table rows for fields returned by summarizeChapterQuality (except chapter count).
 * @type {ReadonlyArray<{ label: string, key: keyof import("./chapter-quality.js").ChapterQualitySummary, pref: "lower"|"higher"|"none" }>}
 */
const QUALITY_METRIC_SPECS = [
  { label: "Retries", key: "retries", pref: "lower" },
  { label: "Files touched", key: "files", pref: "none" },
  { label: "Commits", key: "commits", pref: "none" },
  { label: "Clean chapters", key: "clean", pref: "higher" },
  { label: "Corrected chapters", key: "corrected", pref: "lower" },
  { label: "Struggling chapters", key: "struggling", pref: "lower" },
];

/** All metric row labels rendered in the compare table (session + chapter-quality). */
export const COMPARE_METRIC_LABELS = [
  ...SESSION_COMPARE_SPECS.map((s) => s.label),
  ...QUALITY_METRIC_SPECS.map((s) => s.label),
];

/** Outcome grade columns sourced from {@link summarizeChapterQuality}. */
export const GRADE_COLUMN_LABELS = QUALITY_METRIC_SPECS.filter((s) =>
  GRADE_QUALITY_KEYS.includes(s.key),
).map((s) => s.label);

/** @typedef {{ fmtTok: (n: number) => string, fmtDur: (ms: number) => string, fmtCostCmp: (c: number) => string, displayModel: (m: string) => string, noDataCell: (raw: number, fmtFn: (n: number) => string, estimated?: boolean) => [string, number|null] }} CompareRowFmt */

/**
 * Duration/token/cost cells treat zero as no-data: render an em dash and a
 * null raw slot so buildMetricTableHtml never awards a winner against a
 * side that simply has no measurement. Nonzero estimated values get a '~'
 * prefix so estimated metrics are never presented as measured.
 * @returns {[string, number|null]} [display, raw-or-null]
 */
function compareNoDataCell(raw, fmtFn, estimated) {
  if (!raw) return ["—", null];
  const formatted = fmtFn(raw);
  if (formatted === "—") return [formatted, raw];
  return [(estimated ? "~" : "") + formatted, raw];
}

export function summarizeCompareSession(session) {
  const s = session.stats;
  const toolCounts = s.toolCounts || {};
  const totalToolCalls = sumToolCounts(toolCounts);
  const totalCost = estimateParsedStatsCost(session.model, s);
  const chapters = buildSessionChapters(session);
  const quality = summarizeChapterQuality(chapters);

  return {
    id: session.sessionHash || (session.path ? sessionHash(session.path) : "") || session.sessionId?.slice(0, 8) || "session",
    source: session.source || "claude",
    model: session.model || "",
    durationMs: session.durationMs || 0,
    turns: s.assistantTurns || 0,
    totalToolCalls,
    toolCounts,
    inputTokens: s.totalInputTokens || 0,
    outputTokens: s.totalOutputTokens || 0,
    cacheHit: s.totalCacheHit || 0,
    totalTokens: (s.totalInputTokens || 0) + (s.totalOutputTokens || 0),
    errors: s.errors || 0,
    cost: totalCost,
    tokensEstimated: !!s.tokensEstimated,
    timesEstimated: !!session.timesEstimated,
    quality,
    cwd: session.cwd || "",
    prompt: chapters._comparePrompt ?? "",
    ...quality,
  };
}

export function buildCompareMetricRows(a, b) {
  /** @type {CompareRowFmt} */
  const fmt = {
    fmtTok: (n) => fmtTokens(n, { zeroLabel: "0" }),
    fmtDur: (ms) => formatDuration(ms, { zeroLabel: "—" }),
    fmtCostCmp: (c) => fmtCost(c, { min: 0.001, zeroLabel: "—" }),
    displayModel: (m) => shortModel(m) || "—",
    noDataCell: compareNoDataCell,
  };

  const rows = SESSION_COMPARE_SPECS.map((spec) => spec.build(a, b, fmt));

  for (const { label, key, pref } of QUALITY_METRIC_SPECS) {
    const rawA = a.quality[key];
    const rawB = b.quality[key];
    rows.push([label, String(rawA), String(rawB), pref, rawA, rawB]);
  }

  return rows;
}

export function buildCompareToolRows(a, b) {
  const allTools = new Set();
  for (const k of Object.keys(a.toolCounts)) allTools.add(k);
  for (const k of Object.keys(b.toolCounts)) allTools.add(k);
  const toolRows = [];
  for (const t of allTools) {
    toolRows.push([t, a.toolCounts[t] || 0, b.toolCounts[t] || 0]);
  }
  toolRows.sort((x, y) => y[1] + y[2] - (x[1] + x[2]));
  return toolRows;
}

/**
 * Differences under 5% of the larger side are noise (95% vs 96% cache hit):
 * they keep neutral colour so red and green only mark gaps worth reading.
 */
function isNoiseDelta(rawA, rawB) {
  if (rawA === 0 || rawB === 0) return false;
  const hi = Math.max(Math.abs(rawA), Math.abs(rawB));
  return Math.abs(rawA - rawB) / hi < 0.05;
}

/** Rows whose B-vs-A ratio reads naturally ("2.1×", "−40%"). */
const DELTA_LABELS = new Set(["Duration", "Turns", "Tool calls", "Cost", "Input tokens", "Output tokens"]);

/** How B differs from A, shown after B's value; empty when it would mislead. */
function deltaChipHtml(label, rawA, rawB) {
  if (!DELTA_LABELS.has(label) || !rawA || !rawB || rawA === rawB) return "";
  const ratio = rawB / rawA;
  let text;
  if (ratio >= 1.95) text = (Math.round(ratio * 10) / 10) + "×";
  else if (ratio <= 1 / 1.95) text = "÷" + (Math.round((1 / ratio) * 10) / 10);
  else {
    const pct = Math.round((ratio - 1) * 100);
    if (pct === 0) return "";
    text = (pct > 0 ? "+" : "−") + Math.abs(pct) + "%";
  }
  return ' <span class="cmp-delta" title="B relative to A">' + esc(text) + "</span>";
}

/**
 * One plain sentence above the worksheet: which run was faster, cheaper and
 * cleaner, so the reader knows the answer before scanning sixteen rows.
 */
export function buildCompareVerdictHtml(a, b) {
  const parts = [];
  const ratioPhrase = (x, y, more, less) => {
    if (!x || !y || isNoiseDelta(x, y)) return null;
    const r = y / x;
    return r > 1
      ? (r >= 1.95 ? (Math.round(r * 10) / 10) + "× " + more : Math.round((r - 1) * 100) + "% " + more)
      : (1 / r >= 1.95 ? (Math.round((1 / r) * 10) / 10) + "× " + less : Math.round((1 - r) * 100) + "% " + less);
  };
  const dur = ratioPhrase(a.durationMs, b.durationMs, "longer", "shorter");
  if (dur) parts.push("ran " + dur);
  const cost = ratioPhrase(a.cost, b.cost, "more expensive", "cheaper");
  if (cost) parts.push("was " + cost);
  if (a.errors !== b.errors) parts.push("hit " + b.errors + " error" + (b.errors === 1 ? "" : "s") + " vs " + a.errors);
  if (!parts.length) {
    return '<p class="cmp-verdict">These runs are within 5% on time and cost and had the same number of errors.</p>';
  }
  const list = parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1] : parts[0];
  return (
    '<p class="cmp-verdict"><span class="cmp-verdict-side b">' + esc(b.id) + "</span> " + esc(list) +
    ' than <span class="cmp-verdict-side a">' + esc(a.id) + "</span>.</p>"
  );
}

export function buildMetricTableHtml(rows) {
  let html = "";
  for (const row of rows) {
    const [label, valA, valB, pref, rawA, rawB] = row;
    let aClass = "";
    let bClass = "";
    if (pref !== "none" && rawA != null && rawB != null && rawA !== rawB && !isNoiseDelta(rawA, rawB)) {
      const aWins = pref === "lower" ? rawA < rawB : rawA > rawB;
      aClass = aWins ? "delta-good" : "delta-bad";
      bClass = aWins ? "delta-bad" : "delta-good";
    }
    html +=
      "<tr>" +
      '<td class="cmp-val ' +
      aClass +
      '">' +
      esc(valA) +
      "</td>" +
      '<td class="cmp-label">' +
      esc(label) +
      "</td>" +
      '<td class="cmp-val ' +
      bClass +
      '">' +
      esc(valB) +
      deltaChipHtml(label, rawA, rawB) +
      "</td>" +
      "</tr>";
  }
  return html;
}

export function buildToolComparisonHtml(toolRows, limit = 12) {
  let html = "";
  const n = toolRows.length < limit ? toolRows.length : limit;
  for (let i = 0; i < n; i++) {
    const [tool, ca, cb] = toolRows[i];
    const maxVal = Math.max(ca, cb, 1);
    const pctA = ((ca / maxVal) * 100) | 0;
    const pctB = ((cb / maxVal) * 100) | 0;
    const color = TOOL_COLORS_CMP[tool] || (tool.startsWith("mcp__") ? "#5dadec" : "#7a7a85");
    const toolDisplay = tool.startsWith("mcp__") ? fmtMcpName(tool) : tool;
    html +=
      '<div class="tool-cmp-row">' +
      '<div class="tool-cmp-bar-wrap tool-cmp-left"><div class="tool-cmp-bar" style="width:' +
      pctA +
      "%;background:" +
      color +
      '"></div><span class="tool-cmp-count">' +
      ca +
      "</span></div>" +
      '<div class="tool-cmp-name" style="color:' +
      color +
      '">' +
      esc(toolDisplay) +
      "</div>" +
      '<div class="tool-cmp-bar-wrap tool-cmp-right"><div class="tool-cmp-bar" style="width:' +
      pctB +
      "%;background:" +
      color +
      '"></div><span class="tool-cmp-count">' +
      cb +
      "</span></div>" +
      "</div>";
  }
  return html;
}

export function buildOutcomeSideHtml(side) {
  const q = side.quality;
  const bar =
    q.chapters > 0
      ? '<div class="cmp-outcome-seg clean" style="width:' +
        ((q.clean / q.chapters) * 100 | 0) +
        '%"></div><div class="cmp-outcome-seg corrected" style="width:' +
        ((q.corrected / q.chapters) * 100 | 0) +
        '%"></div><div class="cmp-outcome-seg struggling" style="width:' +
        ((q.struggling / q.chapters) * 100 | 0) +
        '%"></div>'
      : "";

  return (
    '<div class="cmp-outcome-side">' +
    '<div style="font-size:11px;font-family:var(--mono);color:var(--fg3);margin-bottom:4px">' +
    esc(side.id) +
    " (" +
    q.chapters +
    " chapters)</div>" +
    '<div class="cmp-outcome-bar">' +
    bar +
    "</div>" +
    '<div class="cmp-outcome-legend">' +
    '<span class="cmp-outcome-legend-item"><span class="cmp-outcome-dot clean"></span>' +
    q.clean +
    " clean</span>" +
    '<span class="cmp-outcome-legend-item"><span class="cmp-outcome-dot corrected"></span>' +
    q.corrected +
    " corrected</span>" +
    '<span class="cmp-outcome-legend-item"><span class="cmp-outcome-dot struggling"></span>' +
    q.struggling +
    " struggling</span>" +
    "</div>" +
    "</div>"
  );
}

export function compareViewUrl(session, summary) {
  const handle = session.sessionHash || session._path || "";
  const key = session.sessionHash ? "id" : "path";
  return (
    "/view?" +
    key +
    "=" +
    encodeURIComponent(handle) +
    (summary.source !== "claude" ? "&source=" + summary.source : "")
  );
}

export function buildSessionCardHtml(summary, _session, viewUrl, sessionClass) {
  const displayModel = shortModel(summary.model) || "—";
  const badgeColor = SOURCE_COLORS[summary.source] || "#888";
  return (
    '<div class="cmp-session ' +
    sessionClass +
    '">' +
    '<div class="cmp-session-label">' +
    (sessionClass === "session-a" ? "session A" : "session B") +
    "</div>" +
    '<div class="cmp-session-id">' +
    esc(summary.id) +
    '<span class="cmp-source-badge" style="background:' +
    badgeColor +
    '">' +
    esc(summary.source) +
    "</span></div>" +
    '<div class="cmp-session-model">' +
    esc(displayModel) +
    "</div>" +
    '<div class="cmp-session-prompt">' +
    esc(summary.prompt) +
    "</div>" +
    '<a class="cmp-session-link" href="' +
    viewUrl +
    '">view full session &rarr;</a>' +
    "</div>"
  );
}

export function buildColHeadersHtml(idA, idB) {
  return (
    '<div class="cmp-col-headers">' +
    '<div class="cmp-col-a">' +
    esc(idA) +
    "</div>" +
    '<div class="cmp-col-label"></div>' +
    '<div class="cmp-col-b">' +
    esc(idB) +
    "</div>" +
    "</div>"
  );
}
