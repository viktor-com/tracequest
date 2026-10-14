import { includesLower, sumToolCounts } from "../parse/parse-utils.js";
import { sessionMtimeMs } from "../sessions/session-list.js";

export function shortModel(m) {
  if (!m) return '';
  return m.replace('claude-', '').replace(/-\d{8}$/, '');
}

/** Human-readable MCP tool name (mcp__server__tool → "server: tool"). */
export function fmtMcpName(name) {
  if (typeof name !== "string" || !name.startsWith("mcp__")) return name;
  const rest = name.slice(5);
  const idx = rest.indexOf("__");
  if (idx < 0) return rest;
  return rest.slice(0, idx).replace(/_/g, " ") + ": " + rest.slice(idx + 2).replace(/_/g, " ");
}

/** Compact token count (e.g. 80.7B, 1.2M, 42K). Falsy → opts.zeroLabel or ''. */
export function fmtTokens(n, opts) {
  const zeroLabel = opts && opts.zeroLabel !== undefined ? opts.zeroLabel : '';
  if (!n) return zeroLabel;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return String(n);
}

/** Percent display (e.g. 42%). Falsy/hideZero → opts.zeroLabel (default '--'). */
export function fmtPct(n, opts = {}) {
  const zeroLabel = opts.zeroLabel !== undefined ? opts.zeroLabel : "--";
  const decimals = opts.decimals !== undefined ? opts.decimals : 0;
  if (n == null || Number.isNaN(n)) return zeroLabel;
  if (opts.hideZero && n <= 0) return zeroLabel;
  return Number(n).toFixed(decimals) + "%";
}

/** Cache-hit % from token counts; no cache read → opts.zeroLabel (default —). */
export function fmtCacheHitPct(cacheHit, inputTokens, opts = {}) {
  const zeroLabel = opts.zeroLabel !== undefined ? opts.zeroLabel : "—";
  if (!cacheHit) return zeroLabel;
  const pct = (cacheHit / Math.max(1, inputTokens)) * 100;
  return fmtPct(pct, { decimals: opts.decimals ?? 0, zeroLabel });
}

/** Format USD cost (e.g. ~$1.23, $0.042). Below opts.min → opts.zeroLabel or ''. */
export function fmtCost(c, opts = {}) {
  const zeroLabel = opts.zeroLabel !== undefined ? opts.zeroLabel : "";
  const min = opts.min !== undefined ? opts.min : 0.01;
  const prefix = opts.prefix !== undefined ? opts.prefix : "~$";
  const tinyMin = opts.tinyMin !== undefined ? opts.tinyMin : 0.001;
  const tinyLabel = opts.tinyLabel;

  if (c == null || Number.isNaN(c)) return zeroLabel;
  if (c < min) {
    if (tinyLabel && c >= tinyMin) return tinyLabel;
    return zeroLabel;
  }
  const dec =
    opts.decimals !== undefined
      ? opts.decimals
      : opts.fine && c < 0.01
        ? 4
        : c >= 1
          ? 2
          : 3;
  if (c >= 1000) return prefix + Number(c).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return prefix + Number(c).toFixed(dec);
}

/** Human-readable duration (e.g. 45s, 12m, 1h 30m). Falsy → opts.zeroLabel or subSecondLabel. */
export function formatDuration(ms, opts = {}) {
  const {
    floorSeconds = false,
    includeSeconds = false,
    alwaysShowMinutes = false,
    subSecondLabel = '',
    zeroLabel,
  } = opts;
  const emptyLabel = zeroLabel !== undefined ? zeroLabel : subSecondLabel;
  if (!ms || ms <= 0) return emptyLabel;
  const s = floorSeconds ? Math.floor(ms / 1000) : Math.round(ms / 1000);
  if (s < 60) {
    if (s === 0) return subSecondLabel || '0s';
    return s + 's';
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return m + 'm' + (includeSeconds && s % 60 > 0 ? ' ' + (s % 60) + 's' : '');
  }
  const h = Math.floor(m / 60);
  const rm = m % 60;
  // Past two days, hours stop being readable ("822h 40m"): show days + hours.
  if (h >= 48) {
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return rh ? d + 'd ' + rh + 'h' : d + 'd';
  }
  if (rm === 0 && !alwaysShowMinutes) return h + 'h';
  return h + 'h ' + rm + 'm';
}

/** Standard USD rates per million tokens, verified 2026-10-14.
 * https://www.anthropic.com/claude-opus-5-5
 * https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5
 * https://developers.openai.com/api/docs/models/gpt-6.1-sol
 * https://developers.openai.com/api/docs/models/gpt-5.6-sol
 */
export function getModelRates(model) {
  const name = (model || '').toLowerCase();
  if (/^(?:claude-)?opus-5-5(?:$|-)/.test(name)) {
    return { inRate: 4, outRate: 20, cacheReadRate: 0.2, cacheWriteRate: 5, cacheWrite1hRate: 8 };
  }
  if (/^gpt-6\.1-sol(?:$|-)/.test(name)) {
    return { inRate: 2, outRate: 10, cacheReadRate: 0.1, cacheWriteRate: 2.5 };
  }
  if (/^gpt-5\.6-sol(?:$|-)/.test(name)) {
    return { inRate: 4, outRate: 20, cacheReadRate: 0.4, cacheWriteRate: 5 };
  }
  const isOpus = includesLower(name, 'opus');
  return {
    inRate: isOpus ? 15 : 3,
    outRate: isOpus ? 75 : 15,
    cacheReadRate: isOpus ? 1.5 : 0.3,
    cacheWriteRate: isOpus ? 18.75 : 3.75,
    cacheWrite1hRate: isOpus ? 30 : 6,
  };
}

/**
 * Display-only project label. Agent logs often key projects by an encoded
 * directory ("-Users-me--kandev-tasks-<uuid>-<uuid>"); that stays the filter
 * value, but the UI shows it without the home prefix or code/ folder, and
 * with short UUIDs.
 */
export function prettyProject(p) {
  if (!p) return '';
  const out = String(p)
    .replace(/^-(Users|home)-[^-]+-/, '')
    .replace(/^-+/, '')
    .replace(/^code-(?=.)/, '')
    .replace(/([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '$1');
  return out || String(p);
}

export function computeGrade(s) {
  if (s._gradeCache !== undefined) return s._gradeCache;
  const chapters = s.chapters || 0;
  if (chapters === 0) {
    s._gradeCache = { score: 0, letter: '-', cls: '' };
    return s._gradeCache;
  }
  const errors = s.errors || 0;
  const inputTok = s.inputTokens || 0;
  const cacheRead = s.cacheReadTokens || 0;
  const tc = s.toolCounts || {};
  const totalToolCalls = sumToolCounts(tc);
  const errorRatio = totalToolCalls > 0 ? errors / totalToolCalls : 0;
  const errorScore = Math.max(0, 100 - errorRatio * 250);
  const errPerCh = errors / chapters;
  const qualityScore = errPerCh === 0 ? 100 : errPerCh < 1 ? 80 : errPerCh < 2 ? 50 : 20;
  const retryScore = 100;
  const correctionScore = errors === 0 ? 100 : 75;
  const totalInput = inputTok + cacheRead;
  const cacheRatio = totalInput > 0 ? cacheRead / totalInput : 0;
  const cacheScore = totalInput < 10000 ? 75 : Math.min(100, cacheRatio * 125);
  const score = Math.max(0, Math.min(100, Math.round(
    errorScore * 0.35 + qualityScore * 0.20 + retryScore * 0.10 + correctionScore * 0.15 + cacheScore * 0.20
  )));
  let letter, cls;
  if (score >= 90) { letter = 'A'; cls = 'grade-a'; }
  else if (score >= 80) { letter = 'B'; cls = 'grade-b'; }
  else if (score >= 70) { letter = 'C'; cls = 'grade-c'; }
  else if (score >= 60) { letter = 'D'; cls = 'grade-d'; }
  else { letter = 'F'; cls = 'grade-f'; }
  s._gradeCache = { score, letter, cls };
  return s._gradeCache;
}

/** Session USD estimate from recorded billing categories, else legacy totals. */
export function estimateCost(s) {
  if (s._costCache !== undefined) return s._costCache;
  const rates = getModelRates(s.model);
  const tokens = s.billingTokens;
  const cacheRead = tokens ? tokens.cacheHit || 0 : s.cacheReadTokens || 0;
  const output = tokens ? tokens.output || 0 : s.outputTokens || 0;
  const writes = tokens ? tokens.cacheWrite || 0 : 0;
  const oneHour = tokens ? tokens.cacheWrite1h || 0 : 0;
  const input = tokens ? tokens.input || 0 : s.totalTokens > 0 ? s.totalTokens - output : (s.inputTokens || 0) + cacheRead;
  const base = Math.max(0, input - cacheRead - writes);
  s._costCache = (base * rates.inRate + cacheRead * rates.cacheReadRate + output * rates.outRate
    + Math.max(0, writes - oneHour) * (rates.cacheWriteRate || rates.inRate)
    + oneHour * (rates.cacheWrite1hRate || rates.cacheWriteRate || rates.inRate)) / 1e6;
  return s._costCache;
}

/** Chapter USD estimate; billingTokens retain each request's pricing weights. */
export function estimateChapterTokenCost(model, tokens) {
  if (!tokens) return 0;
  const rates = getModelRates(model);
  const t = tokens.billingTokens || tokens;
  const cacheRead = t.cacheHit || 0;
  const writes = t.cacheWrite || 0;
  const oneHour = t.cacheWrite1h || 0;
  const base = Math.max(0, (t.input || 0) - cacheRead - writes);
  return (base * rates.inRate + cacheRead * rates.cacheReadRate + (t.output || 0) * rates.outRate
    + Math.max(0, writes - oneHour) * (rates.cacheWriteRate || rates.inRate)
    + oneHour * (rates.cacheWrite1hRate || rates.cacheWriteRate || rates.inRate)) / 1e6;
}

/** Full-session parse stats use the same billing categories as list and chapters. */
export function estimateParsedStatsCost(model, stats) {
  if (!stats) return 0;
  return estimateChapterTokenCost(model, {
    input: stats.totalInputTokens || 0,
    cacheHit: stats.totalCacheHit || 0,
    output: stats.totalOutputTokens || 0,
    billingTokens: stats.billingTokens,
  });
}

/**
 * Duration, tokens and cost of a parsed session as every page shows them: its
 * per-session summary (the session list's figures) when the server attached one,
 * else its parse stats. inputTokens includes cached tokens.
 */
export function sessionFigures(session) {
  const sum = session.summary;
  if (sum) {
    const output = sum.outputTokens || 0;
    const total = sum.totalTokens || 0;
    return {
      model: sum.model || session.model || '',
      durationMs: sum.durationMs || 0,
      totalTokens: total,
      inputTokens: Math.max(0, total - output),
      outputTokens: output,
      cacheReadTokens: sum.cacheReadTokens || 0,
      cost: estimateCost({ ...sum }),
    };
  }
  const st = session.stats || {};
  const input = st.totalInputTokens || 0;
  const output = st.totalOutputTokens || 0;
  return {
    model: session.model || '',
    durationMs: session.durationMs || 0,
    totalTokens: input + output,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: st.totalCacheHit || 0,
    cost: estimateParsedStatsCost(session.model, st),
  };
}

/** Map API/CLI sort keys; `date` is an alias for `recent` (mtime descending). */
export function normalizeSortKey(sort) {
  if (!sort || sort === 'recent' || sort === 'date') return 'recent';
  return sort;
}

export function sortSessionList(arr, sort) {
  switch (normalizeSortKey(sort)) {
    case 'recent': return arr.sort((a, b) => sessionMtimeMs(b) - sessionMtimeMs(a));
    case 'duration': return arr.sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0));
    case 'cost': return arr.sort((a, b) => estimateCost(b) - estimateCost(a));
    case 'tokens': return arr.sort((a, b) => (b.totalTokens || 0) - (a.totalTokens || 0));
    case 'errors': return arr.sort((a, b) => (b.errors || 0) - (a.errors || 0));
    case 'files': return arr.sort((a, b) => (b.files || 0) - (a.files || 0));
    case 'commits': return arr.sort((a, b) => (b.commits || 0) - (a.commits || 0));
    case 'chapters': return arr.sort((a, b) => (b.chapters || 0) - (a.chapters || 0));
    case 'grade': return arr.sort((a, b) => computeGrade(b).score - computeGrade(a).score);
    default: return arr.sort((a, b) => sessionMtimeMs(b) - sessionMtimeMs(a));
  }
}