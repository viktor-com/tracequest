import { normalizeSortKey, sortSessionList, computeGrade, estimateCost, getModelRates, shortModel, fmtTokens, fmtCost, formatDuration, fmtMcpName, fmtPct } from "../filter/filter-formats.js";

const NORMALIZE_SORT_KEY_SRC = normalizeSortKey.toString().replace(/^export /, "");
const SORT_SESSION_LIST_SRC = sortSessionList.toString().replace(/^export /, "");
const FMT_MCP_NAME_SRC = fmtMcpName.toString().replace(/^export /, "");
const GET_MODEL_RATES_SRC = getModelRates.toString();
const ESTIMATE_COST_SRC = estimateCost.toString();
const COMPUTE_GRADE_SRC = computeGrade.toString();
const SHORT_MODEL_SRC = shortModel.toString().replace(/^export /, "");
const FMT_TOKENS_SRC = fmtTokens.toString().replace(/^export /, "");
const FORMAT_DURATION_SRC = formatDuration.toString().replace(/^export /, "");
const FMT_COST_SRC = fmtCost.toString().replace(/^export /, "");
const FMT_PCT_SRC = fmtPct.toString().replace(/^export /, "");
import {
  BROWSER_CLIENT_DASHBOARD_JS,
  buildBrowserClientScriptHead,
} from "./browser-client-dashboard.js";
import { LAUNCHER_CLIENT_JS } from "./launch-page.js";
import { COMMAND_PALETTE_CLIENT_JS } from "./command-palette.js";
import { SESSION_STAT_CHIPS_HTML_SRC, SESSION_STATS_HTML_SRC, LIVE_NOW_SRC, USAGE_LIMITS_CLIENT_SRC, APP_SHELL_JS } from "./app-chrome.js";
import { joinBundleParts } from "../render/join-bundle.js";
import { includesLower, INDEX_OF_LOWER_JS, sumToolCounts } from "../parse/parse-utils.js";
import { FORM_FIELD_GUARD_SRC } from "./is-form-field.js";
import { OVERLAY_FOCUS_SRC } from "./overlay-focus.js";

// computeGrade/getModelRates free variables. Page items arrive from the
// server with _gradeCache/_costCache already stamped (computeStats runs
// both server-side), which masked these — but liveSessions objects carry
// no caches, so client-side grading/costing of a live row needs the real
// helpers in the bundle.
const SUM_TOOL_COUNTS_SRC = sumToolCounts.toString().replace(/^export /, "");
const INCLUDES_LOWER_SRC = includesLower.toString().replace(/^export /, "");

const BROWSER_CLIENT_PREP_AND_FORMATS_JS = `var _fetchController = null;

var TOOL_COLORS = {
  Bash: 'var(--hue-bash)', Edit: 'var(--hue-edit)', Write: 'var(--hue-edit)', Read: 'var(--hue-read)',
  Agent: 'var(--hue-agent)', Grep: 'var(--hue-grep)', Glob: 'var(--hue-grep)', Skill: 'var(--hue-agent)',
  WebFetch: 'var(--hue-web)', WebSearch: 'var(--hue-web)', ToolSearch: 'var(--hue-grep)',
  SemanticSearch: 'var(--hue-grep)', Delete: 'var(--bad)', Await: 'var(--hue-other)',
  Ask: 'var(--hue-web)', CallMcpTool: 'var(--hue-web)'
};
function getToolClr(name) {
  if (TOOL_COLORS[name]) return TOOL_COLORS[name];
  if (typeof name === 'string' && name.startsWith('mcp__')) return 'var(--hue-web)';
  return 'var(--hue-other)';
}
var SOURCE_COLORS = {
  claude: 'var(--hue-claude)', codex: 'var(--hue-codex)', factory: 'var(--hue-factory)',
  cursor: 'var(--hue-cursor)', 'cursor-cloud': 'var(--hue-cursor-cloud)', opencode: 'var(--hue-opencode)', grok: 'var(--hue-grok)'
};
var KEY_COLORS = {
  project: 'var(--text-2)', source: 'var(--text-2)', host: 'var(--text-2)', tool: 'var(--text-2)',
  model: 'var(--text-2)', grade: 'var(--text-2)', errors: 'var(--bad)',
  size: 'var(--text-3)', age: 'var(--text-3)', live: 'var(--ok)', text: 'var(--text-3)'
};
var FILTER_KEYS = ['project', 'source', 'host', 'tool', 'model', 'grade', 'errors', 'size', 'age', 'live'];

function timeAgo(ms) {
  var s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  var m = s / 60;
  if (m < 60) return (m | 0) + 'm ago';
  var h = m / 60;
  if (h < 24) return (h | 0) + 'h ago';
  var d = h / 24;
  if (d < 30) return (d | 0) + 'd ago';
  return new Date(ms).toISOString().slice(0, 10);
}
${SHORT_MODEL_SRC}
${FMT_MCP_NAME_SRC}
${FMT_TOKENS_SRC}
${FORMAT_DURATION_SRC}
${FMT_COST_SRC}
${FMT_PCT_SRC}
function fmtDuration(ms) {
  return formatDuration(ms, { subSecondLabel: '' });
}
${SUM_TOOL_COUNTS_SRC}
${INCLUDES_LOWER_SRC}
${GET_MODEL_RATES_SRC}
${ESTIMATE_COST_SRC}
${COMPUTE_GRADE_SRC}

/**
 * Display-only project label. Agent logs often key projects by an encoded
 * directory ("-Users-me--kandev-tasks-<uuid>-<uuid>"); that stays the filter
 * value, but the list shows it without the home prefix, without a code/
 * folder, and with 8-character UUIDs.
 */
function prettyProject(p) {
  if (!p) return '';
  var out = String(p).replace(/^-(Users|home)-[^-]+-/, '').replace(/^-+/, '').replace(/^code-(?=.)/, '');
  out = out.replace(/([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '$1');
  return out || String(p);
}
/** Project chip: readable label, raw value in the title only when it differs. */
function projectSpanHtml(raw, title) {
  var label = prettyProject(raw);
  var tip = title || (label !== raw ? raw : '');
  return '<span class="session-project"' + (tip ? ' title="' + escH(tip) + '"' : '') + '>' + escH(label) + '</span>';
}
/** Grade chip that explains itself: letter, score and what drives it. */
function gradeBadgeHtml(s) {
  var g = computeGrade(s);
  if (!g.cls) return '<span class="session-grade-badge" hidden></span>';
  var why = 'Grade ' + g.letter + ' \\u00b7 ' + g.score + '/100 \\u2014 from tool-call error rate, errors per chapter and cache hit rate';
  return '<span class="session-grade-badge ' + g.cls + '" title="' + escH(why) + '">' + g.letter + '</span>';
}
/** Agent identity: a small hue square and the agent name (plus @host). */
function sourceChipHtml(source, host) {
  return '<span class="session-source" style="--hue:' + (SOURCE_COLORS[source] || 'var(--hue-other)') + '">' + escH(source) + (host ? '@' + escH(host) : '') + '</span>';
}
/** Tool mix as one thin stacked bar; the breakdown lives in the title. */
function toolSparkHtml(tc) {
  var total = 0, entries = [];
  for (var k in tc) { if (tc.hasOwnProperty(k)) { total += tc[k]; entries.push([k, tc[k]]); } }
  if (!total) return '';
  entries.sort(function(a, b) { return b[1] - a[1]; });
  var tip = entries.slice(0, 6).map(function(e) { return fmtMcpName(e[0]) + ' ' + e[1]; }).join(' \\u00b7 ');
  var html = '<span class="tool-sparkline" title="' + escH(tip) + '">';
  for (var i = 0; i < entries.length; i++) {
    var pct = (entries[i][1] / total * 100).toFixed(1);
    html += '<span class="tool-spark-seg" style="width:' + pct + '%;background:' + getToolClr(entries[i][0]) + '"></span>';
  }
  return html + '</span>';
}
var currentSort = 'recent';
var compareSet = new Set(); // stores session paths (stable across sort/filter)
`;
const BROWSER_CLIENT_REST_JS = `
${FORM_FIELD_GUARD_SRC}
${OVERLAY_FOCUS_SRC}

var _peekSession = (function() {
  var params = new URLSearchParams(window.location.search);
  var id = params.get('session');
  if (!id) return null;
  return { id: id, source: params.get('sessionSource') || 'claude' };
})();

/* --- pagination --- */
function totalPages() {
  return Math.max(1, Math.ceil(SERVER_TOTAL / PAGE_SIZE));
}

function pageStart() {
  return (currentPage - 1) * PAGE_SIZE;
}

function pageEnd() {
  return Math.min(currentPage * PAGE_SIZE, SERVER_TOTAL);
}

function updatePageUrl() {
  var params = new URLSearchParams(window.location.search);

  if (currentPage > 1) params.set('page', currentPage);
  else params.delete('page');

  if (PAGE_SIZE !== 50) params.set('pageSize', PAGE_SIZE);
  else params.delete('pageSize');

  if (currentSort && currentSort !== 'recent') params.set('sort', currentSort);
  else params.delete('sort');

  var expr = filterInput.value.trim();
  if (expr) params.set('expr', expr);
  else params.delete('expr');

  if (typeof _peekSession !== 'undefined' && _peekSession && _peekSession.id) {
    params.set('session', _peekSession.id);
    if (_peekSession.source && _peekSession.source !== 'claude') params.set('sessionSource', _peekSession.source);
    else params.delete('sessionSource');
  } else {
    params.delete('session');
    params.delete('sessionSource');
  }

  var qs = params.toString();
  var newUrl = window.location.pathname + (qs ? '?' + qs : '');
  history.replaceState(null, '', newUrl);
}

function goToPage(page) {
  var tp = totalPages();
  page = Math.max(1, Math.min(page, tp));
  if (page === currentPage) return;
  currentPage = page;
  fetchSessions(function() {
    render();
    var inv = document.querySelector ? document.querySelector('.runs-inventory') : null;
    if (!inv) inv = document.getElementById('sessions');
    if (inv && inv.scrollIntoView) inv.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function renderPagination() {
  var tp = totalPages();
  if (tp <= 1) {
    paginationEl.classList.add('hidden');
    return;
  }
  paginationEl.classList.remove('hidden');
  var start = pageStart() + 1;
  var end = pageEnd();
  var html = '';

  html += '<span class="page-info"><strong>' + start + '</strong>&ndash;<strong>' + end + '</strong> of <strong>' + SERVER_TOTAL + '</strong></span>';
  html += '<span class="page-nav">';
  html += '<button class="page-btn" data-page="prev" aria-label="Previous page"' + (currentPage <= 1 ? ' disabled' : '') + '>&larr;</button>';

  var pages = [];
  if (tp <= 7) {
    for (var i = 1; i <= tp; i++) pages.push(i);
  } else {
    pages.push(1);
    if (currentPage > 3) pages.push(-1);
    var lo = Math.max(2, currentPage - 1);
    var hi = Math.min(tp - 1, currentPage + 1);
    if (currentPage <= 3) hi = Math.max(hi, 4);
    if (currentPage >= tp - 2) lo = Math.min(lo, tp - 3);
    for (var j = lo; j <= hi; j++) pages.push(j);
    if (currentPage < tp - 2) pages.push(-1);
    pages.push(tp);
  }

  for (var pi = 0; pi < pages.length; pi++) {
    var pg = pages[pi];
    if (pg === -1) {
      html += '<span class="page-info">&hellip;</span>';
    } else {
      html += '<button class="page-btn' + (pg === currentPage ? ' active' : '') + '" data-page="' + pg + '" aria-label="Page ' + pg + '"' + (pg === currentPage ? ' aria-current="page"' : '') + '>' + pg + '</button>';
    }
  }

  html += '<button class="page-btn" data-page="next" aria-label="Next page"' + (currentPage >= tp ? ' disabled' : '') + '>&rarr;</button>';
  html += '</span>';

  html += '<span class="page-size-wrap">'
    + '<label for="pageSizeSelect">Per page</label>'
    + '<select class="page-size-select" id="pageSizeSelect">';
  var sizes = [25, 50, 100, 200];
  for (var si = 0; si < sizes.length; si++) {
    html += '<option value="' + sizes[si] + '"' + (sizes[si] === PAGE_SIZE ? ' selected' : '') + '>' + sizes[si] + '</option>';
  }
  html += '</select></span>';

  paginationEl.innerHTML = html;
}

paginationEl.addEventListener('click', function(e) {
  var btn = e.target.closest('.page-btn');
  if (!btn || btn.disabled) return;
  var pg = btn.dataset.page;
  if (pg === 'prev') goToPage(currentPage - 1);
  else if (pg === 'next') goToPage(currentPage + 1);
  else goToPage(parseInt(pg, 10));
});

paginationEl.addEventListener('change', function(e) {
  if (e.target.id === 'pageSizeSelect') {
    PAGE_SIZE = parseInt(e.target.value, 10);
    currentPage = 1;
    updatePageUrl();
    fetchSessions(function() { render(); });
  }
});

function escH(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* --- precompute suggestion indices from server stats --- */
var projectCounts = new Map();
var sourceCounts = new Map();
var toolCounts = new Map();
var modelCounts = new Map();
(function() {
  var pc = SERVER_STATS.projectCounts || {};
  for (var k in pc) { if (pc.hasOwnProperty(k)) projectCounts.set(k, pc[k]); }
  var sc = SERVER_STATS.sourceCounts || {};
  for (var k in sc) { if (sc.hasOwnProperty(k)) sourceCounts.set(k, sc[k]); }
  var tc = SERVER_STATS.toolAgg || {};
  for (var k in tc) { if (tc.hasOwnProperty(k)) toolCounts.set(k, tc[k]); }
  var mc = SERVER_STATS.modelCounts || {};
  for (var k in mc) { if (mc.hasOwnProperty(k)) modelCounts.set(k, mc[k]); }
})();

/* --- token parsing --- */

var currentFilterExpr = null;

/* --- filter state --- */
var filterInput = document.getElementById('filterInput');
var filterBar = document.getElementById('filterBar');
var suggestionsEl = document.getElementById('suggestions');
var sessionsEl = document.getElementById('sessions');
var refreshStatusEl = document.getElementById('refreshStatus');

function setRefreshStatus(state, message, detail) {
  if (!refreshStatusEl) return;
  refreshStatusEl.dataset.state = state || 'idle';
  refreshStatusEl.textContent = message || '';
  refreshStatusEl.title = detail || '';
  refreshStatusEl.hidden = !message;
}

function commitFilter() {
  currentFilterExpr = filterInput.value.trim() ? true : null;
  syncQfStateFromExpr();
  currentPage = 1;
  fetchSessions(function() { render(); });
}
function clearAll() {
  filterInput.value = '';
  currentFilterExpr = null;
  qfState.grade = null;
  qfState.model = null;
  qfState.source = null;
  qfState.errorsOnly = false;
  qfState.age = null;
  currentPage = 1;
  fetchSessions(function() { render(); });
  closeSuggestions();
}

/* --- suggestions --- */
${INDEX_OF_LOWER_JS}
var hlIdx = -1;
var currentSugs = [];

function getLastToken(text) {
  if (!text || /[\\s\\t]$/.test(text)) return null;
  var end = text.length;
  var inQuote = false;
  var q = null;
  for (var k = 0; k < end; k++) {
    var c = text.charAt(k);
    if (c === '"' || c === "'") {
      if (!inQuote) { inQuote = true; q = c; }
      else if (c === q) { inQuote = false; q = null; }
    }
  }
  var i = end - 1;
  while (i >= 0) {
    var ch = text.charAt(i);
    if (ch === '"' || ch === "'") {
      if (inQuote && ch === q) { inQuote = false; q = null; }
      else if (!inQuote) { inQuote = true; q = ch; }
    } else if (!inQuote && (ch === ' ' || ch === '\\t') && (i === 0 || text.charAt(i - 1) !== '\\\\')) {
      break;
    }
    i--;
  }
  return { token: text.slice(i + 1, end), start: i + 1 };
}

function getSuggestions(text) {
  var last = getLastToken(text);
  var str = last ? last.token : '';
  if (!str) {
    return FILTER_KEYS.map(function(k) {
      return { display: k + ':', insert: k + ':', count: null, color: KEY_COLORS[k], isKey: true };
    });
  }
  var upper = str.toUpperCase();
  if (upper === 'AN' || upper === 'AND' || upper === 'O' || upper === 'OR' || upper === 'NO' || upper === 'NOT') return [];
  var colon = str.indexOf(':');
  if (colon > 0) {
    var raw = str.slice(0, colon);
    var key = (raw.charAt(0) === '-' ? raw.slice(1) : raw).toLowerCase();
    var partial = str.slice(colon + 1).trim().toLowerCase();
    var prefix = str.slice(0, colon + 1);
    var map = null;
    if (key === 'project') map = projectCounts;
    else if (key === 'source') map = sourceCounts;
    else if (key === 'tool') map = toolCounts;
    else if (key === 'model') map = modelCounts;
    else if (key === 'size') return [
      { display: '>100', insert: prefix + '>100', count: null, color: KEY_COLORS.size },
      { display: '>500', insert: prefix + '>500', count: null, color: KEY_COLORS.size },
      { display: '<50', insert: prefix + '<50', count: null, color: KEY_COLORS.size }
    ];
    else if (key === 'grade') return [
      { display: 'A', insert: prefix + 'A', count: null, color: KEY_COLORS.grade },
      { display: 'B', insert: prefix + 'B', count: null, color: KEY_COLORS.grade },
      { display: 'C', insert: prefix + 'C', count: null, color: KEY_COLORS.grade },
      { display: 'D', insert: prefix + 'D', count: null, color: KEY_COLORS.grade },
      { display: 'F', insert: prefix + 'F', count: null, color: KEY_COLORS.grade }
    ];
    else if (key === 'errors') return [
      { display: '>0', insert: prefix + '>0', count: null, color: KEY_COLORS.errors },
      { display: '>2', insert: prefix + '>2', count: null, color: KEY_COLORS.errors },
      { display: '<1', insert: prefix + '<1', count: null, color: KEY_COLORS.errors }
    ];
    else if (key === 'age') return [
      { display: '<1h', insert: prefix + '<1h', count: null, color: KEY_COLORS.age },
      { display: '<1d', insert: prefix + '<1d', count: null, color: KEY_COLORS.age },
      { display: '<7d', insert: prefix + '<7d', count: null, color: KEY_COLORS.age },
      { display: '<30d', insert: prefix + '<30d', count: null, color: KEY_COLORS.age }
    ];
    else if (key === 'live') return [
      { display: 'true', insert: prefix + 'true', count: null, color: KEY_COLORS.live }
    ];
    if (!map) return [];
    var results = [];
    map.forEach(function(count, val) {
      if (indexOfLower(val, partial) !== -1) {
        results.push({ display: val, insert: prefix + val, count: count, color: KEY_COLORS[key] });
      }
    });
    results.sort(function(a, b) { return b.count - a.count; });
    return results.slice(0, 8);
  }
  var lower = (str.charAt(0) === '-' ? str.slice(1) : str).toLowerCase();
  var pre = str.charAt(0) === '-' ? '-' : '';
  var keySugs = [];
  for (var ki = 0; ki < FILTER_KEYS.length; ki++) {
    var fk = FILTER_KEYS[ki];
    if (fk.indexOf(lower) === 0 && fk !== lower) {
      keySugs.push({ display: pre + fk + ':', insert: pre + fk + ':', count: null, color: KEY_COLORS[fk], isKey: true });
      if (keySugs.length >= 8) break;
    }
  }
  return keySugs;
}

function renderSuggestions(items) {
  if (!items.length) { closeSuggestions(); return; }
  currentSugs = items;
  hlIdx = -1;
  var html = '';
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    html += '<div class="suggestion-item" data-idx="' + i + '" role="option" aria-selected="false">'
      + '<span class="suggestion-dot" style="background:' + (it.color || '#7a7a85') + '"></span>'
      + '<span class="suggestion-label">' + escH(it.display) + '</span>'
      + (it.count != null ? '<span class="suggestion-count">' + it.count + '</span>' : '')
      + '</div>';
  }
  suggestionsEl.innerHTML = html;
  suggestionsEl.classList.add('open');
}
function closeSuggestions() {
  suggestionsEl.classList.remove('open');
  hlIdx = -1;
  currentSugs = [];
}
function highlightSuggestion(idx) {
  var items = suggestionsEl.querySelectorAll('.suggestion-item');
  items.forEach(function(el) { el.classList.remove('hl'); el.setAttribute('aria-selected', 'false'); });
  if (idx >= 0 && idx < items.length) {
    items[idx].classList.add('hl');
    items[idx].setAttribute('aria-selected', 'true');
    items[idx].scrollIntoView({ block: 'nearest' });
    hlIdx = idx;
  } else { hlIdx = -1; }
}
function replaceLastToken(replacement) {
  var text = filterInput.value;
  var last = getLastToken(text);
  if (last) {
    filterInput.value = text.slice(0, last.start) + replacement;
  } else {
    filterInput.value = replacement;
  }
}

function acceptSuggestion(idx) {
  if (idx < 0 || idx >= currentSugs.length) return;
  var sug = currentSugs[idx];
  if (sug.isKey) {
    replaceLastToken(sug.insert);
    renderSuggestions(getSuggestions(filterInput.value));
  } else {
    replaceLastToken(sug.insert + ' ');
    commitFilter();
    closeSuggestions();
  }
  filterInput.focus();
}

/* --- progressive render --- */
var filtered = [];
var renderedCount = 0;
var sentinel = document.createElement('div');
sentinel.id = 'load-more';

${NORMALIZE_SORT_KEY_SRC}
${SORT_SESSION_LIST_SRC}
function sortSessions(arr) {
  return sortSessionList(arr, currentSort);
}
var _preservePage = true; // true for initial load — reads page from URL
var _fetching = false;
var _fetchError = null;
var _staleRefreshError = null;

function fetchSessions(callback, options) {
  options = options || {};
  var preserveStaleOnError = options.preserveStaleOnError === true;
  if (_fetchController) { try { _fetchController.abort(); } catch (_e) { /* already aborted */ } }
  _fetchController = new AbortController();
  var params = new URLSearchParams();
  if (currentPage > 1) params.set('page', currentPage);
  if (PAGE_SIZE !== 50) params.set('pageSize', PAGE_SIZE);
  if (currentSort && currentSort !== 'recent') params.set('sort', currentSort);
  var expr = filterInput.value.trim();
  if (expr) params.set('expr', expr);
  _fetching = true;
  _fetchError = null;
  _staleRefreshError = null;
  setRefreshStatus('pending', 'refreshing');
  if (!preserveStaleOnError && typeof document !== 'undefined' && document.body) document.body.classList.add('runs-loading');
  fetch('/api/sessions?' + params.toString(), { signal: _fetchController.signal })
    .then(function(r) {
      if (!r.ok) {
        return r.text().then(function(body) {
          var msg = 'HTTP ' + r.status;
          if (body) msg += ': ' + body.slice(0, 120);
          throw new Error(msg);
        });
      }
      return r.json();
    })
    .then(function(data) {
      _fetching = false;
      if (typeof document !== 'undefined' && document.body) document.body.classList.remove('runs-loading');
      _fetchError = null;
      _staleRefreshError = null;
      setRefreshStatus(null, '');
      ALL = data.sessions;
      SERVER_TOTAL = data.total;
      if (data.stats) SERVER_STATS = data.stats;
      _liveSessions = data.liveSessions || [];
      _livePaths = new Set(_liveSessions.filter(function(s) { return s.live === true; }).map(function(s) { return s.path; }));
      currentPage = data.page;
      if (callback) callback();
    })
    .catch(function(err) {
      _fetching = false;
      if (typeof document !== 'undefined' && document.body) document.body.classList.remove('runs-loading');
      if (err.name === 'AbortError') return;
      var message = err.message || String(err);
      if (preserveStaleOnError && ALL && ALL.length) {
        _fetchError = null;
        _staleRefreshError = message;
        setRefreshStatus('stale', 'stale data', 'Last refresh failed: ' + message);
      } else {
        _fetchError = message;
        _staleRefreshError = null;
        setRefreshStatus('error', 'load failed', message);
      }
      console.error('fetchSessions error:', err);
      if (callback) callback();
    });
}

/* --- launched runs: ONE first-class row per run in the main session list --- */
var _runs = [];
var _runsBySession = {};
var _runsSig = null;

/**
 * The ONE origin-agnostic is-live definition, shared by every live counter
 * (dashboard #appLive / Overview running stat, chat-page #appLive / rail
 * overview): runIsLive + s.live === true. Origin never decides whether an
 * agent counts; tmux status running is never sufficient; filters never
 * change the sum.
 */
${LIVE_NOW_SRC}

/* --- Continue affordances: which sessions can be resumed as a NEW run ---
   Gated on /api/agents: mux available + the session's mapped agent detected
   WITH a verified resume mechanism (agents without one never show Continue
   — honest absence). SOURCE_AGENTS mirrors the server-side map. */
var SOURCE_AGENTS = {
  claude: 'claude', cursor: 'cursor-agent', codex: 'codex',
  grok: 'grok', opencode: 'opencode', factory: 'droid'
};
var _agentsInfo = { mux: false, resumable: {} };
fetch('/api/agents')
  .then(function(r) { return r.ok ? r.json() : null; })
  .then(function(data) {
    if (!data) return;
    _agentsInfo.mux = !!(data.mux && data.mux.available);
    var agents = data.agents || [];
    for (var i = 0; i < agents.length; i++) {
      if (agents[i].resume) _agentsInfo.resumable[agents[i].id] = true;
    }
    render();
  })
  .catch(function() { /* no Continue affordances without agent info */ });

${USAGE_LIMITS_CLIENT_SRC}
startUsageLimitsPolling(60000);
${APP_SHELL_JS}

function continueAgentForSource(source, host) {
  if (host) return null;
  if (!_agentsInfo.mux) return null;
  var agent = SOURCE_AGENTS[source];
  return agent && _agentsInfo.resumable[agent] ? agent : null;
}

/** The Continue control markup for a session/run row (empty when not offered). */
function continueBtnHtml(sessionPath, agent, label) {
  return '<button class="session-continue" type="button" data-continue-session="' + escH(sessionPath) + '"'
    + (agent ? ' data-continue-agent="' + escH(agent) + '"' : '')
    + ' title="Continue this conversation as a new tracequest run — type your follow-up right here (' + escH(agent || '') + ' resumes the session in tmux)"'
    + ' aria-label="Continue session as a new run">' + (label || 'Continue') + '</button>';
}

/* --- Inline continue composer: typing IS the continue ---
   Clicking a row's Continue control opens a one-line composer IN the row;
   submit POSTs {resumeSession, prompt} and lands in the NEW run's chat with
   the follow-up already delivered (empty submit continues without a
   message). A needs:"cwd" 400 flips the input into directory-entry mode
   (vanished-cwd recovery). The draft survives the dashboard's periodic
   re-renders. */
var _contDraft = null;

function continueFormHtml(d) {
  return '<form class="session-continue-form" data-continue-session="' + escH(d.path) + '"'
    + (d.agent ? ' data-continue-agent="' + escH(d.agent) + '"' : '')
    + (d.cwdMode ? ' data-mode="cwd"' : '')
    + '><div class="session-continue-msg"' + (d.msg ? '' : ' hidden') + '>' + escH(d.msg || '') + '</div>'
    + '<div class="session-continue-row">'
    + '<span class="session-continue-glyph">&#8635;&#xFE0E;</span>'
    + '<input class="session-continue-input" type="text" autocomplete="off" spellcheck="false" placeholder="'
    + (d.cwdMode ? 'directory for the new run (the recorded one is gone)' : 'Send a follow-up — continues as a new run (Esc closes)')
    + '" aria-label="Follow-up message — continues this session as a new run">'
    + '<button class="session-continue-send" type="submit" title="Continue (Enter) — an empty submit continues without a message" aria-label="Continue session as a new run">continue &#8594;</button>'
    + '</div></form>';
}

function findContinueBtn(path) {
  var btns = sessionsEl.querySelectorAll('.session-continue');
  for (var i = 0; i < btns.length; i++) {
    if (btns[i].getAttribute('data-continue-session') === path) return btns[i];
  }
  return null;
}

function closeContinueForm() {
  var forms = sessionsEl.querySelectorAll('.session-continue-form');
  for (var i = 0; i < forms.length; i++) forms[i].parentNode.removeChild(forms[i]);
  _contDraft = null;
}

function paintContinueForm(focus) {
  if (!_contDraft) return;
  var btn = findContinueBtn(_contDraft.path);
  var wrap = btn && btn.closest('.session-row-wrap');
  if (!wrap) return;
  var old = wrap.querySelector('.session-continue-form');
  if (old) old.parentNode.removeChild(old);
  wrap.insertAdjacentHTML('beforeend', continueFormHtml(_contDraft));
  var input = wrap.querySelector('.session-continue-input');
  input.value = _contDraft.cwdMode ? (_contDraft.cwdText || '') : (_contDraft.text || '');
  if (focus) input.focus();
}

/** Re-attach the open continue composer after a full list re-render. */
function restoreContinueForm() {
  if (!_contDraft) return;
  paintContinueForm(document.activeElement === document.body || document.activeElement === null);
}

function openContinueForm(btn) {
  var wrap = btn.closest('.session-row-wrap');
  if (!wrap) return;
  var existing = wrap.querySelector('.session-continue-form');
  if (existing) { existing.querySelector('.session-continue-input').focus(); return; }
  closeContinueForm();
  _contDraft = {
    path: btn.getAttribute('data-continue-session'),
    agent: btn.getAttribute('data-continue-agent') || '',
    text: '', cwdMode: false, cwdText: '', msg: ''
  };
  paintContinueForm(true);
}

function submitContinueForm(form) {
  if (!_contDraft || form.getAttribute('data-continue-session') !== _contDraft.path) return;
  var input = form.querySelector('.session-continue-input');
  var send = form.querySelector('.session-continue-send');
  if (send.disabled) return;
  var body = { resumeSession: _contDraft.path };
  if (_contDraft.agent) body.agent = _contDraft.agent;
  if (_contDraft.cwdMode) {
    if (!input.value) {
      _contDraft.msg = 'enter an existing directory for the new run';
      paintContinueForm(true);
      return;
    }
    body.cwd = input.value;
    if (_contDraft.text) body.prompt = _contDraft.text;
  } else if (input.value) {
    body.prompt = input.value;
  }
  send.disabled = true;
  fetch('/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(function(r) {
    return r.json().then(function(d) { return { ok: r.ok, d: d }; });
  }).then(function(out) {
    if (out.ok && out.d.id) {
      if (body.prompt) {
        try { sessionStorage.setItem('tq-followup:' + out.d.id, body.prompt); } catch (e) {}
      }
      window.location.href = '/run?id=' + encodeURIComponent(out.d.id);
      return;
    }
    if (out.d && out.d.needs === 'cwd') {
      // Vanished-cwd recovery: keep the typed follow-up, ask for a directory.
      if (!_contDraft.cwdMode) _contDraft.text = input.value;
      _contDraft.cwdMode = true;
      _contDraft.msg = (out.d && out.d.error) || 'pick a directory for the new run';
      paintContinueForm(true);
      return;
    }
    _contDraft.msg = (out.d && out.d.error) || 'continue failed';
    paintContinueForm(true);
  }).catch(function(err) {
    if (_contDraft) { _contDraft.msg = String(err); paintContinueForm(true); }
  });
}

function fetchRuns() {
  fetch('/api/runs')
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) {
      if (!data || !Array.isArray(data.runs)) return;
      var runs = data.runs;
      var sig = runs.map(function(r) { return r.id + '|' + r.status + '|' + (r.sessionPath || '') + '|' + (r.activity || ''); }).join(';');
      if (sig === _runsSig) return;
      _runsSig = sig;
      _runs = runs;
      _runsBySession = {};
      for (var i = 0; i < runs.length; i++) {
        if (runs[i].sessionPath) _runsBySession[runs[i].sessionPath] = runs[i];
      }
      // Run set or activity changed (started/exited/linked/killed/new
      // activity line): repaint so run rows stay truthful.
      render();
    })
    .catch(function() { /* transient — next poll retries */ });
}
setInterval(fetchRuns, 3000);

/** The run's recording as an indexed session row (stats/grade), if listed. */
function indexedSessionForRun(r) {
  if (!r.sessionPath) return null;
  for (var i = 0; i < ALL.length; i++) {
    if (ALL[i].path === r.sessionPath) return ALL[i];
  }
  return null;
}

/** The run's recording as a live-detected session (model/prompt before indexing). */
function liveInfoForRun(r) {
  if (!r.sessionPath) return null;
  for (var i = 0; i < _liveSessions.length; i++) {
    if (_liveSessions[i].path === r.sessionPath) return _liveSessions[i];
  }
  return null;
}

/**
 * The ONE live-agent row anatomy. Every agent row — launched run or
 * externally detected live session — renders through this single builder,
 * so origin can NEVER split the card: same state badge, identity chips
 * (source, id, model, project), prompt line, live "what it's doing now"
 * activity line, grade chip and stat row. Origin differences are DATA on
 * the spec (an origin chip, the click target, which controls are genuinely
 * possible — there is no window to kill for an external agent), never a
 * second anatomy.
 */
function liveAgentRowHtml(o) {
  var running = o.status === 'running';
  var listId = o.sessionId || o.runId || o.liveId || o.idLabel || '';
  var html = '<div class="session-row-wrap run-row-wrap"'
    + (listId ? ' data-session-id="' + escH(listId) + '"' : '')
    + (o.runId ? ' data-run-id="' + escH(o.runId) + '"' : '')
    + (o.liveId ? ' data-live-session="' + escH(o.liveId) + '"' : '')
    + '>'
    + '<span class="runs-col-check"></span>'
    + '<div class="session-row run-row" role="link" tabindex="0" ' + o.keyAttrs
    + ' data-run-status="' + escH(o.status) + '"'
    + (o.origin ? ' data-run-origin="' + escH(o.origin) + '"' : '')
    + ' data-href="' + o.href + '" aria-label="' + o.ariaLabel + '">'
    + '<span class="run-state-badge" data-status="' + escH(o.status) + '">' + escH(o.status) + '</span>'
    + '<span class="session-main">'
    + '<span class="session-primary">'
    + '<span class="session-prompt">' + (o.prompt ? escH(o.prompt) : '') + '</span>';
  var activity = o.activity;
  if (!activity && running) {
    activity = o.hasRecording ? 'Working…' : 'Waiting for the agent session…';
  }
  if (activity) {
    html += '<span class="run-activity" data-status="' + escH(o.status) + '">'
      + (running ? '<span class="run-activity-dot"></span>' : '')
      + '<span class="run-activity-text">' + escH(activity) + '</span></span>';
  }
  html += '</span>'
    + '<span class="session-meta">'
    + sourceChipHtml(o.source)
    + projectSpanHtml(o.project, o.projectTitle)
    + (o.model ? '<span class="session-model">' + escH(o.model) + '</span>' : '<span class="session-model" hidden></span>')
    + '<span class="session-id">' + escH(o.idLabel) + '</span>'
    + (o.chips || '')
    + '</span>'
    + '</span>'
    + (o.timeMs ? '<span class="session-time">' + escH(timeAgo(o.timeMs)) + '</span>' : '<span class="session-time"></span>')
    + (o.stats ? sessionStatsHtml(o.stats) : '<div class="session-stats"></div>');
  html += o.graded ? gradeBadgeHtml(o.graded) : '<span class="session-grade-badge" hidden></span>';
  html += '<span class="session-tools">' + (o.stats && o.stats.toolCounts ? toolSparkHtml(o.stats.toolCounts) : '') + '</span>'
    + '<span class="session-actions">' + (o.controls || '') + '</span>'
    + '</div></div>';
  return html;
}

/**
 * A run rendered as ONE first-class session-list row: live state badge,
 * identity (agent, session id once linked, cwd), the launch prompt, a live
 * "what it's doing now" activity line, absorbed stats/grade from the linked
 * session row, a kill/dismiss control — and a single click target: the chat.
 */
function runSessionRowHtml(r) {
  var indexed = indexedSessionForRun(r);
  var live = liveInfoForRun(r);
  var generating = runIsLive(r);
  var attached = r.status !== 'exited' && r.status !== 'gone';
  var status = generating ? 'running' : (attached ? 'idle' : r.status);
  var cwdBase = String(r.cwd || '').split('/').filter(Boolean).pop() || r.cwd || '';
  var started = Date.parse(r.startedAt);
  var controls = '';
  // Kill vs Continue follows the pane, not generating: an idle open
  // window can still be killed; Continue is for an exited linked run.
  if (!attached && r.sessionPath && _agentsInfo.mux && _agentsInfo.resumable[r.agent]) {
    controls += continueBtnHtml(r.sessionPath, r.agent);
  }
  controls += '<button class="run-dismiss" type="button" data-run-id="' + escH(r.id) + '" title="' + (attached ? 'Kill run' : 'Dismiss run') + '" aria-label="' + (attached ? 'Kill' : 'Dismiss') + ' run ' + escH(r.id) + '">&times;</button>';
  return liveAgentRowHtml({
    keyAttrs: 'data-run-id="' + escH(r.id) + '"',
    runId: r.id,
    sessionId: (indexed && indexed.id) || (live && live.id) || '',
    status: status,
    origin: null,
    href: '/run?id=' + encodeURIComponent(r.id),
    ariaLabel: 'Open run ' + escH(r.id) + ' chat',
    source: r.agent,
    idLabel: (indexed && indexed.id) || (live && live.id) || r.id,
    model: shortModel((indexed && indexed.model) || (live && live.model) || ''),
    project: cwdBase,
    projectTitle: r.cwd || '',
    chips: r.resumedFrom ? '<span class="run-origin" title="This run continues session ' + escH(r.resumedFrom) + '">&#8635;&#xFE0E; continued</span>' : '',
    graded: indexed,
    timeMs: isNaN(started) ? null : started,
    controls: controls,
    prompt: (indexed && indexed.prompt) || (live && live.prompt) || r.prompt || '',
    activity: r.activity,
    hasRecording: !!r.sessionPath,
    stats: indexed,
  });
}

/**
 * An EXTERNAL live session (detected running, not launched by tracequest)
 * rendered through the SAME row builder a run uses — identical anatomy:
 * "running" badge, identity chips, prompt, the server-derived activity
 * line, grade chip and stat row. Origin is communicated honestly by a
 * muted "external" chip, and the only omissions are the controls that are
 * genuinely impossible for a process tracequest does not drive (no window
 * to kill, nothing to dismiss). Single click target: the read-only live
 * chat at /run?session=<hash>.
 */
function externalLiveRowHtml(s) {
  var status = s.live === true ? 'running' : 'idle';
  return liveAgentRowHtml({
    keyAttrs: 'data-live-session="' + escH(s.id) + '"',
    liveId: s.id,
    sessionId: s.id,
    status: status,
    origin: 'external',
    href: '/run?session=' + encodeURIComponent(s.id),
    ariaLabel: 'Watch ' + status + ' session ' + escH(s.id),
    source: s.source,
    idLabel: s.id,
    model: shortModel(s.model || ''),
    project: s.project,
    projectTitle: null,
    chips: '<span class="run-origin" title="This session was started outside tracequest — its own terminal drives it; open for a watch-only chat">external</span>',
    graded: s,
    timeMs: s.mtime || null,
    controls: '',
    prompt: s.prompt || '',
    activity: s.activity,
    hasRecording: true,
    stats: s,
  });
}

/** Live sessions that are nobody's run recording — the externally started ones. */
function externalLiveSessions() {
  return _liveSessions.filter(function(s) { return s.live === true && !_runsBySession[s.path]; });
}

function render() {
  // ANY live session is ONE object with one vocabulary: a run's recording
  // is absorbed into its run row, and an external live session is absorbed
  // into its own live row — both pinned at the top of the list (page 1)
  // with the same row treatment, each leading to its live chat.
  var externalLive = currentPage === 1 ? externalLiveSessions() : [];
  var pinnedLivePaths = {};
  for (var pl = 0; pl < externalLive.length; pl++) pinnedLivePaths[externalLive[pl].path] = true;
  filtered = ALL.filter(function(s) { return !_runsBySession[s.path] && !pinnedLivePaths[s.path]; });
  renderedCount = 0;
  sessionsEl.innerHTML = '';
  if (_fetchError) {
    sessionsEl.insertAdjacentHTML('afterbegin', '<div class="fetch-error" role="alert"><div class="ui-empty"><div class="ui-empty-title">Couldn\u2019t load runs</div><div class="ui-empty-body">Failed to load runs: ' + escH(_fetchError) + '</div><div class="ui-empty-actions"><button type="button" class="ui-btn ui-btn--primary" data-empty-action="retry">Try again</button></div></div></div>');
    document.getElementById('count').textContent = '—';
    renderDashboard();
    buildQfBar();
    renderPagination();
    updatePageUrl();
    return;
  }
  sessionsEl.appendChild(sentinel);
  var runsHtml = '';
  if (currentPage === 1) {
    for (var ri = 0; ri < _runs.length; ri++) runsHtml += runSessionRowHtml(_runs[ri]);
    for (var li = 0; li < externalLive.length; li++) runsHtml += externalLiveRowHtml(externalLive[li]);
  }
  if (runsHtml) sentinel.insertAdjacentHTML('beforebegin', runsHtml);
  renderPageBatch();
  document.getElementById('count').textContent = SERVER_TOTAL + ' run' + (SERVER_TOTAL !== 1 ? 's' : '');
  // The same origin-agnostic running counter the chat pages' app bar shows.
  var appLiveEl = document.getElementById('appLive');
  if (appLiveEl) {
    var liveN = liveNow();
    appLiveEl.hidden = !liveN;
    appLiveEl.textContent = liveN + ' running';
  }
  if (!filtered.length && !runsHtml) sessionsEl.insertAdjacentHTML('afterbegin', emptyStateHtml());
  renderDashboard();
  buildQfBar();
  renderPagination();
  updatePageUrl();
  restoreContinueForm();
  if (typeof markSelectedRow === 'function') markSelectedRow();
  if (typeof updatePeekNav === 'function') updatePeekNav();
}


/* Shared with the chat header (app-chrome.js): the ONE stat-chip builder,
   so the list card's stat line and the chat header's stat line never drift. */
${SESSION_STAT_CHIPS_HTML_SRC}
${SESSION_STATS_HTML_SRC}

/**
 * Empty list: say why it is empty and the one action that fixes it. A
 * filter that matches nothing offers to clear it; a machine with no
 * recordings yet says where tracequest looks and offers a new run.
 */
function emptyStateHtml() {
  var expr = filterInput.value.trim();
  var filteredOut = expr || qfState.grade || qfState.model || qfState.source || qfState.errorsOnly || qfState.age;
  var search = '<circle cx="7" cy="7" r="4.25"/><path d="m10.25 10.25 3 3"/>';
  var inbox = '<path d="M2.5 9 4 3.5h8L13.5 9v3.5h-11z"/><path d="M2.5 9h3l1 1.5h3l1-1.5h3"/>';
  function mark(paths) {
    return '<div class="ui-empty-mark"><svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg></div>';
  }
  if (filteredOut) {
    return '<div class="empty ui-empty">' + mark(search)
      + '<div class="ui-empty-title">No runs match' + (expr ? ' <code>' + escH(expr) + '</code>' : ' these filters') + '</div>'
      + '<div class="ui-empty-body">Filters combine with AND. Try a shorter word, drop a filter, or widen the time range.</div>'
      + '<div class="ui-empty-actions"><button type="button" class="ui-btn ui-btn--primary" data-empty-action="clear">Clear filters</button></div>'
      + '</div>';
  }
  return '<div class="empty ui-empty">' + mark(inbox)
    + '<div class="ui-empty-title">No runs recorded yet</div>'
    + '<div class="ui-empty-body">tracequest reads sessions from Claude Code, Codex CLI, Cursor, Droid, OpenCode and Grok CLI on this machine. Run any of them, or start one here.</div>'
    + '<div class="ui-empty-actions"><button type="button" class="ui-btn ui-btn--primary" data-empty-action="new-run">New run</button></div>'
    + '</div>';
}
sessionsEl.addEventListener('click', function(e) {
  var btn = e.target && e.target.closest ? e.target.closest('[data-empty-action]') : null;
  if (!btn) return;
  var act = btn.getAttribute('data-empty-action');
  if (act === 'clear') { clearAll(); filterInput.focus(); }
  else if (act === 'retry') { fetchSessions(function() { render(); }); }
  else { var nr = document.getElementById('newRunBtn'); if (nr) nr.click(); }
});

function renderRow(s, idx) {
  var model = shortModel(s.model);
  var viewUrl = '/view?id=' + encodeURIComponent(s.id) + (s.source !== 'claude' ? '&source=' + s.source : '');
  var rowClasses = 'session-row';
  if (s.errors > 2) rowClasses += ' has-errors';
  else if (s.commits > 0) rowClasses += ' has-commits';
  else if (s.totalTokens > 2000000) rowClasses += ' expensive';
  var checked = compareSet.has(s.path) ? ' checked' : '';
  // List-row RUNNING is the stamped detectLiveSessions bit (s.live),
  // never _livePaths membership or watch-page growth chrome.
  var live = s.live === true;
  var html = '<div class="session-row-wrap" data-idx="' + idx + '" data-session-id="' + escH(s.id) + '" data-session-source="' + escH(s.source) + '">'
    + '<input type="checkbox" class="compare-cb" data-idx="' + idx + '" data-path="' + escH(s.path) + '"' + checked + ' title="Select for comparison" aria-label="Select run ' + escH(s.id) + ' for comparison">'
    + '<a class="' + rowClasses + '" href="' + viewUrl + '">'
    + (live ? '<span class="live-indicator">running</span>' : '<span class="run-state-slot" aria-hidden="true"></span>')
    + '<span class="session-main">'
    + '<span class="session-primary"><span class="session-prompt">' + (s.prompt ? escH(s.prompt) : '') + '</span></span>'
    + '<span class="session-meta">'
    + sourceChipHtml(s.source, s.host)
    + projectSpanHtml(s.project)
    + (model ? '<span class="session-model">' + escH(model) + '</span>' : '<span class="session-model" hidden></span>')
    + '<span class="session-id">' + escH(s.id) + '</span>';
  if (s.errors > 0) html += '<span class="session-badge error-badge">' + s.errors + ' error' + (s.errors !== 1 ? 's' : '') + '</span>';
  if (s.commits > 0) html += '<span class="session-badge commit-badge">' + s.commits + ' commit' + (s.commits !== 1 ? 's' : '') + '</span>';
  html += '</span></span>'
    + '<span class="session-time" title="' + escH(new Date(s.mtime).toLocaleString()) + '">' + timeAgo(s.mtime) + '</span>'
    + '<span class="session-size">' + s.sizeKB + ' KB</span>';
  html += sessionStatsHtml(s);
  html += gradeBadgeHtml(s);
  html += '<span class="session-tools">' + (s.tools && s.tools.length ? toolSparkHtml(s.toolCounts || {}) : '') + '</span>';
  html += '<span class="session-actions">';
  var contAgent = continueAgentForSource(s.source, s.host);
  if (contAgent) html += continueBtnHtml(s.path, contAgent);
  return html + '</span></a></div>';
}

function renderPageBatch() {
  var html = '';
  for (var i = 0; i < filtered.length; i++) html += renderRow(filtered[i], i);
  sentinel.insertAdjacentHTML('beforebegin', html);
  renderedCount = filtered.length;
  sentinel.style.display = 'none';
}

/* --- event listeners --- */
filterInput.addEventListener('input', function() {
  var text = filterInput.value;
  var sugs = getSuggestions(text);
  if (text.trim()) renderSuggestions(sugs);
  else { closeSuggestions(); commitFilter(); }
});

filterInput.addEventListener('keydown', function(e) {
  var isOpen = suggestionsEl.classList.contains('open');
  var sugCount = suggestionsEl.querySelectorAll('.suggestion-item').length;

  if (e.key === 'ArrowDown' && isOpen) {
    e.preventDefault();
    highlightSuggestion(hlIdx < sugCount - 1 ? hlIdx + 1 : 0);
    return;
  }
  if (e.key === 'ArrowUp' && isOpen) {
    e.preventDefault();
    highlightSuggestion(hlIdx > 0 ? hlIdx - 1 : sugCount - 1);
    return;
  }
  if ((e.key === 'Enter' || e.key === 'Tab') && isOpen && hlIdx >= 0) {
    e.preventDefault();
    acceptSuggestion(hlIdx);
    return;
  }
  if (e.key === 'Enter' && filterInput.value.trim()) {
    e.preventDefault();
    commitFilter();
    closeSuggestions();
    return;
  }
  if (e.key === 'Tab' && filterInput.value.trim()) {
    var sugs = getSuggestions(filterInput.value);
    if (sugs.length === 1) {
      e.preventDefault();
      if (sugs[0].isKey) {
        replaceLastToken(sugs[0].insert);
        renderSuggestions(getSuggestions(filterInput.value));
      } else { acceptSuggestion(0); }
      return;
    }
  }
  if (e.key === 'Escape') {
    if (isOpen) { closeSuggestions(); e.preventDefault(); return; }
    if (filterInput.value) { clearAll(); e.preventDefault(); return; }
    filterInput.blur();
    return;
  }
});

filterBar.addEventListener('click', function(e) {
  filterInput.focus();
});

suggestionsEl.addEventListener('mousedown', function(e) {
  e.preventDefault();
  var item = e.target.closest('.suggestion-item');
  if (item) acceptSuggestion(parseInt(item.dataset.idx, 10));
});

function bindPeekHotkeys() {
  installPageHotkey('tqHotkeyPeekNext', 'j,J,ArrowDown', function() {
    if (_peekSession) { peekStep(1); return; }
    stepSessionList(1);
  });
  installPageHotkey('tqHotkeyPeekPrev', 'k,K,ArrowUp', function() {
    if (_peekSession) { peekStep(-1); return; }
    stepSessionList(-1);
  });
  installPageHotkey('tqHotkeyListOpen', 'o,O', function() {
    if (_peekSession) return;
    openSelectedListItem();
  });
}
bindPeekHotkeys();

function onSessionsListEscape(e) {
  if (document.body.classList.contains('cmdk-open')) return;
  if (e.key !== 'Escape') return;
  if (isFormField(e.target)) return;
  if (typeof overlayStackBusy === 'function' && overlayStackBusy()) return;
  if (document.getElementById('launchOverlay') && !document.getElementById('launchOverlay').hidden) return;
  if (document.getElementById('cmdkOverlay') && !document.getElementById('cmdkOverlay').hidden) return;
  // Peek owns Escape first (Linear overlay-then-clear); then unfocus the J/K cursor.
  if (_peekSession) {
    e.preventDefault();
    closeSessionFlyout();
    return;
  }
  if (clearSessionListCursor()) e.preventDefault();
}
document.addEventListener('keydown', onSessionsListEscape);

/**
 * VS Code list.select (Enter) under WorkbenchListFocusContextKey — not a
 * page-wide GitHub data-hotkey leaf. Native Enter on #newRunBtn / other
 * action controls must still activate; BODY with .is-selected or the
 * focused row is listFocus.
 */
function onSessionsListEnter(e) {
  if (e.key !== 'Enter') return;
  if (e.defaultPrevented) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.body.classList.contains('cmdk-open')) return;
  if (typeof isFormField === 'function' && isFormField(e.target)) return;
  if (typeof overlayStackBusy === 'function' && overlayStackBusy()) return;
  if (document.getElementById('launchOverlay') && !document.getElementById('launchOverlay').hidden) return;
  if (document.getElementById('cmdkOverlay') && !document.getElementById('cmdkOverlay').hidden) return;
  if (_peekSession) return;
  if (!listOwnsKeyboard()) return;
  e.preventDefault();
  openSelectedListItem();
}
document.addEventListener('keydown', onSessionsListEnter);

document.addEventListener('click', function(e) {
  if (!e.target.closest('.filter-wrap')) closeSuggestions();
  if (!e.target.closest('.runs-toolbar-actions') && !e.target.closest('#qfBar')) {
    closeToolbarMenus();
    if (filtersOpen) {
      filtersOpen = false;
      buildQfBar();
    }
  }
});

document.getElementById('sortBar').addEventListener('click', function(e) {
  var btn = e.target.closest('.sort-btn');
  if (!btn) return;
  var sort = btn.dataset.sort;
  if (sort === currentSort) return;
  currentSort = sort;
  document.querySelectorAll('.sort-btn').forEach(function(b) { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
  btn.classList.add('active');
  btn.setAttribute('aria-pressed', 'true');
  closeToolbarMenus();
  currentPage = 1;
  fetchSessions(function() { render(); });
});


filterInput.addEventListener('paste', function() {
  setTimeout(function() { commitFilter(); }, 0);
});

/* --- Quick Filter Bar --- */
var qfBarEl = document.getElementById('qfBar');
var qfState = { grade: null, model: null, source: null, errorsOnly: false, age: null };
var filtersOpen = false;
var AGE_OPTIONS = { '': 'All time', '<1d': 'Past 24 hours', '<7d': 'Past 7 days', '<30d': 'Past 30 days' };

function qfTermFromExpr(expr, key) {
  var m = String(expr || '').match(new RegExp('\\\\b' + key + ':(?:"([^"]*)"|(\\\\S+))', 'i'));
  return m ? (m[1] || m[2] || '') : null;
}

function syncQfStateFromExpr() {
  var expr = filterInput.value || '';
  qfState.grade = qfTermFromExpr(expr, 'grade');
  qfState.source = qfTermFromExpr(expr, 'source');
  qfState.model = qfTermFromExpr(expr, 'model');
  qfState.errorsOnly = qfTermFromExpr(expr, 'errors') === '>0';
  qfState.age = qfTermFromExpr(expr, 'age');
}

function ageLabel(value) {
  return AGE_OPTIONS[value || ''] || 'All time';
}

function appliedChipHtml(key, op, value, removeKey) {
  return '<span class="chip" data-chip="' + removeKey + '">'
    + '<span class="chip-key">' + escH(key) + '</span>'
    + '<span class="chip-op">' + escH(op) + '</span>'
    + '<span class="chip-value">' + escH(value) + '</span>'
    + '<button type="button" class="chip-remove" data-remove="' + removeKey + '" aria-label="Remove ' + escH(key) + ' filter">&times;</button>'
    + '</span>';
}

function appliedChipsHtml() {
  var chips = '';
  if (qfState.age) chips += appliedChipHtml('Age', 'is', ageLabel(qfState.age), 'age');
  if (qfState.source) chips += appliedChipHtml('Source', 'is', qfState.source, 'source');
  if (qfState.grade) chips += appliedChipHtml('Grade', 'is', qfState.grade, 'grade');
  if (qfState.model) chips += appliedChipHtml('Model', 'is', qfState.model, 'model');
  if (qfState.errorsOnly) chips += appliedChipHtml('Errors', '>', '0', 'errors');
  if (!chips) return '';
  return '<div class="applied-chips" id="appliedChips">' + chips
    + '<span class="applied-match">Match all filters</span>'
    + '<button class="qf-clear qf-visible" id="qfClear">Clear</button>'
    + '</div>';
}

function closeToolbarMenus(except) {
  closeToolbarMenuOverlays(except);
}

function setAgeFilter(value) {
  qfState.age = value || null;
  setQfFilterTerm('age', qfState.age);
  applyQfFilters();
}

function setSourceFilter(value) {
  qfState.source = value || null;
  setQfFilterTerm('source', qfState.source);
  applyQfFilters();
}

function syncToolbarLabels() {
  var ageBtn = document.getElementById('ageBtn');
  if (ageBtn) {
    ageBtn.textContent = ageLabel(qfState.age);
    ageBtn.classList.toggle('has-value', !!qfState.age);
    ageBtn.classList.toggle('active', !!qfState.age);
  }
  document.querySelectorAll('#ageMenu .toolbar-option').forEach(function(opt) {
    var on = (opt.getAttribute('data-age') || '') === (qfState.age || '');
    opt.classList.toggle('active', on);
    opt.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  var sourceBtn = document.getElementById('sourceBtn');
  if (sourceBtn) {
    sourceBtn.textContent = qfState.source || 'Source';
    sourceBtn.classList.toggle('has-value', !!qfState.source);
    sourceBtn.classList.toggle('active', !!qfState.source);
  }
  var filtersToggle = document.getElementById('filtersToggle');
  if (filtersToggle) {
    filtersToggle.classList.toggle('active', !!(filtersOpen || qfHasAny()));
    filtersToggle.setAttribute('aria-expanded', filtersOpen ? 'true' : 'false');
  }
}

function renderSourceMenu() {
  var menu = document.getElementById('sourceMenu');
  if (!menu) return;
  var sourceSet = QF_STATS.sourceCounts || {};
  var entries = [];
  for (var k in sourceSet) {
    if (sourceSet.hasOwnProperty(k)) entries.push([k, sourceSet[k]]);
  }
  entries.sort(function(a, b) { return b[1] - a[1]; });
  var html = '<button type="button" class="toolbar-option' + (!qfState.source ? ' active' : '') + '" data-source="" role="option" aria-selected="' + (!qfState.source ? 'true' : 'false') + '">All sources</button>';
  for (var i = 0; i < entries.length; i++) {
    var sn = entries[i][0];
    var sc = entries[i][1];
    var active = qfState.source === sn;
    html += '<button type="button" class="toolbar-option' + (active ? ' active' : '') + '" data-source="' + escH(sn) + '" role="option" aria-selected="' + (active ? 'true' : 'false') + '">'
      + escH(sn) + '<span class="toolbar-option-count">' + sc + '</span></button>';
  }
  menu.innerHTML = html;
}

function buildQfBar() {
  var modelSet = QF_STATS.modelCounts || {};
  var sourceSet = QF_STATS.sourceCounts || {};
  var gradeDist = QF_STATS.gradeDist || { A: 0, B: 0, C: 0, D: 0, F: 0 };
  var errCount = QF_STATS.errorSessionCount || 0;

  var html = appliedChipsHtml();

  html += '<div class="qf-pickers" id="qfPickers"' + (filtersOpen ? '' : ' hidden') + '>';
  html += '<div class="qf-row">';
  html += '<span class="qf-section">';
  html += '<span class="qf-section-label">grade</span>';
  var grades = ['A', 'B', 'C', 'D', 'F'];
  for (var gi = 0; gi < grades.length; gi++) {
    var gl = grades[gi].toLowerCase();
    var gc = gradeDist[grades[gi]] || 0;
    var disabledCls = gc === 0 ? ' qf-disabled' : '';
    html += '<button class="qf-grade qf-g-' + gl + disabledCls + '" data-grade="' + grades[gi] + '" aria-label="Filter grade ' + grades[gi] + '" aria-pressed="false" title="' + gc + ' run' + (gc !== 1 ? 's' : '') + ' with grade ' + grades[gi] + '"' + (gc === 0 ? ' disabled' : '') + '>' + grades[gi] + '</button>';
  }
  html += '</span>';
  html += '<button class="qf-error-toggle" id="qfErrorToggle" aria-pressed="false" title="Show only runs with errors">' + errCount + ' with errors</button>';
  if (!qfHasAny()) html += '<button class="qf-clear" id="qfClear">clear filters</button>';
  html += '</div>';

  var sourceEntries = [];
  for (var sk in sourceSet) {
    if (sourceSet.hasOwnProperty(sk)) sourceEntries.push([sk, sourceSet[sk]]);
  }
  sourceEntries.sort(function(a, b) { return b[1] - a[1]; });
  if (sourceEntries.length > 1) {
    html += '<div class="qf-row">';
    html += '<span class="qf-section">';
    html += '<span class="qf-section-label">source</span>';
    for (var si = 0; si < sourceEntries.length; si++) {
      var sn = sourceEntries[si][0];
      var sc = sourceEntries[si][1];
      html += '<button class="qf-chip qf-chip--source" data-source="' + escH(sn) + '" aria-pressed="false" style="--hue:' + (SOURCE_COLORS[sn] || 'var(--hue-other)') + '">' + escH(sn) + ' <span class="qf-chip-count">' + sc + '</span></button>';
    }
    html += '</span>';
    html += '</div>';
  }

  var modelEntries = [];
  for (var mk in modelSet) {
    if (modelSet.hasOwnProperty(mk)) modelEntries.push([mk, modelSet[mk]]);
  }
  modelEntries.sort(function(a, b) { return b[1] - a[1]; });
  if (modelEntries.length > 0) {
    html += '<div class="qf-row">';
    html += '<span class="qf-section">';
    html += '<span class="qf-section-label">model</span>';
    var maxModels = Math.min(modelEntries.length, 6);
    for (var mi = 0; mi < maxModels; mi++) {
      var mn = modelEntries[mi][0];
      var mc = modelEntries[mi][1];
      html += '<button class="qf-chip" data-model="' + escH(mn) + '" aria-pressed="false">' + escH(mn) + ' <span class="qf-chip-count">' + mc + '</span></button>';
    }
    html += '</span>';
    html += '</div>';
  }
  html += '</div>';

  qfBarEl.innerHTML = html;
  qfBarEl.hidden = !filtersOpen && !qfHasAny();
  renderSourceMenu();
  syncToolbarLabels();
  attachQfListeners();
}

function attachQfListeners() {
  var clearEl = document.getElementById('qfClear');
  var errorToggle = document.getElementById('qfErrorToggle');
  function setQfPressed(btn, pressed) {
    if (btn) btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  }

  qfBarEl.querySelectorAll('.qf-grade').forEach(function(btn) {
    btn.addEventListener('click', function() {
      if (btn.classList.contains('qf-disabled')) return;
      var g = btn.dataset.grade;
      if (qfState.grade === g) {
        qfState.grade = null;
        btn.classList.remove('qf-active');
        setQfPressed(btn, false);
        setQfFilterTerm('grade', null);
      } else {
        qfBarEl.querySelectorAll('.qf-grade').forEach(function(b) { b.classList.remove('qf-active'); setQfPressed(b, false); });
        qfState.grade = g;
        btn.classList.add('qf-active');
        setQfPressed(btn, true);
        setQfFilterTerm('grade', g);
      }
      applyQfFilters();
    });
  });

  qfBarEl.querySelectorAll('.qf-chip[data-source]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var src = btn.dataset.source;
      if (qfState.source === src) {
        qfState.source = null;
        btn.classList.remove('qf-active');
        setQfPressed(btn, false);
        setQfFilterTerm('source', null);
      } else {
        qfBarEl.querySelectorAll('.qf-chip[data-source]').forEach(function(b) { b.classList.remove('qf-active'); setQfPressed(b, false); });
        qfState.source = src;
        btn.classList.add('qf-active');
        setQfPressed(btn, true);
        setQfFilterTerm('source', src);
      }
      applyQfFilters();
    });
  });

  qfBarEl.querySelectorAll('.qf-chip[data-model]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var mod = btn.dataset.model;
      if (qfState.model === mod) {
        qfState.model = null;
        btn.classList.remove('qf-active');
        setQfPressed(btn, false);
        setQfFilterTerm('model', null);
      } else {
        qfBarEl.querySelectorAll('.qf-chip[data-model]').forEach(function(b) { b.classList.remove('qf-active'); setQfPressed(b, false); });
        qfState.model = mod;
        btn.classList.add('qf-active');
        setQfPressed(btn, true);
        setQfFilterTerm('model', mod);
      }
      applyQfFilters();
    });
  });

  if (errorToggle) errorToggle.addEventListener('click', function() {
    qfState.errorsOnly = !qfState.errorsOnly;
    errorToggle.classList.toggle('qf-active', qfState.errorsOnly);
    setQfPressed(errorToggle, qfState.errorsOnly);
    setQfFilterTerm('errors', qfState.errorsOnly ? '>0' : null);
    applyQfFilters();
  });

  if (clearEl) clearEl.addEventListener('click', function() {
    qfState.grade = null;
    qfState.model = null;
    qfState.source = null;
    qfState.errorsOnly = false;
    qfState.age = null;
    qfBarEl.querySelectorAll('.qf-active').forEach(function(el) { el.classList.remove('qf-active'); setQfPressed(el, false); });
    var cur = (filterInput.value || '').trim();
    cur = cur.replace(/\\b(grade|source|model|errors|age):(?:"[^"]*"|\\S+)/gi, '').replace(/\\s+/g, ' ').trim();
    if (filterInput.value !== cur) {
      filterInput.value = cur;
    }
    currentFilterExpr = filterInput.value.trim() ? true : null;
    applyQfFilters();
  });

  qfBarEl.querySelectorAll('.chip-remove').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var key = btn.getAttribute('data-remove');
      if (key === 'age') qfState.age = null;
      else if (key === 'source') qfState.source = null;
      else if (key === 'grade') qfState.grade = null;
      else if (key === 'model') qfState.model = null;
      else if (key === 'errors') qfState.errorsOnly = false;
      setQfFilterTerm(key === 'errors' ? 'errors' : key, key === 'errors' ? null : qfState[key]);
      applyQfFilters();
    });
  });

  // Restore active states from qfState after every rebuild (so badges stay lit across fetches/sorts/pagination)
  qfBarEl.querySelectorAll('.qf-grade').forEach(function(b) {
    var active = !!(qfState.grade && b.dataset.grade === qfState.grade);
    b.classList.toggle('qf-active', active);
    setQfPressed(b, active);
  });
  qfBarEl.querySelectorAll('.qf-chip[data-source]').forEach(function(b) {
    var active = !!(qfState.source && b.dataset.source === qfState.source);
    b.classList.toggle('qf-active', active);
    setQfPressed(b, active);
  });
  qfBarEl.querySelectorAll('.qf-chip[data-model]').forEach(function(b) {
    var active = !!(qfState.model && b.dataset.model === qfState.model);
    b.classList.toggle('qf-active', active);
    setQfPressed(b, active);
  });
  var errToggle = document.getElementById('qfErrorToggle');
  if (errToggle) {
    errToggle.classList.toggle('qf-active', !!qfState.errorsOnly);
    setQfPressed(errToggle, !!qfState.errorsOnly);
  }
}

function qfHasAny() {
  return qfState.grade || qfState.model || qfState.source || qfState.errorsOnly || qfState.age;
}

function setQfFilterTerm(key, value) {
  // Update main filter input so badge application is visible/editable in the primary field.
  // Replaces any prior same-key term, preserves the rest of the user's expr.
  var current = (filterInput.value || '').trim();
  var re = new RegExp('\\\\b' + key + ':(?:"[^"]*"|\\\\S+)', 'gi');
  current = current.replace(re, '').replace(/\\s+/g, ' ').trim();
  if (value) {
    var needsQuote = value.indexOf(' ') >= 0 || value.indexOf(':') >= 0;
    var term = key + ':' + (needsQuote ? '"' + value + '"' : value);
    current = current ? current + ' ' + term : term;
  }
  filterInput.value = current;
  currentFilterExpr = filterInput.value.trim() ? true : null;
  // Do not commit here — the caller (badge click) will call applyQfFilters which does the fetch
  // and reads the freshly updated filterInput.value, sending it as expr.
}

function applyQfFilters() {
  var clearEl = document.getElementById('qfClear');
  if (clearEl) clearEl.classList.toggle('qf-visible', qfHasAny());
  syncToolbarLabels();
  currentPage = 1;
  fetchSessions(function() { render(); });
}

(function() {
  var params = new URLSearchParams(window.location.search);
  var sort = params.get('sort');
  if (sort) {
    currentSort = sort;
    document.querySelectorAll('.sort-btn').forEach(function(b) { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
    var sortBtn = document.querySelector('.sort-btn[data-sort="' + sort + '"]');
    if (sortBtn) { sortBtn.classList.add('active'); sortBtn.setAttribute('aria-pressed', 'true'); }
  }
  var expr = params.get('expr');
  if (expr) filterInput.value = expr;
  var grade = params.get('grade');
  if (grade) { qfState.grade = grade; setQfFilterTerm('grade', grade); }
  if (params.get('errorsOnly') === '1') { qfState.errorsOnly = true; setQfFilterTerm('errors', '>0'); }
  var source = params.get('source');
  if (source) { qfState.source = source; setQfFilterTerm('source', source); }
  var model = params.get('model');
  if (model) { qfState.model = model; setQfFilterTerm('model', model); }
  var age = params.get('age');
  if (age) { qfState.age = age; setQfFilterTerm('age', age); }
  syncQfStateFromExpr();
})();
(function bindRunsToolbar() {
  var ageBtn = document.getElementById('ageBtn');
  var ageMenu = document.getElementById('ageMenu');
  var sourceBtn = document.getElementById('sourceBtn');
  var sourceMenu = document.getElementById('sourceMenu');
  var filtersToggle = document.getElementById('filtersToggle');
  var displayToggle = document.getElementById('displayToggle');
  var sortBar = document.getElementById('sortBar');
  if (ageBtn && ageMenu) {
    ageBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      var open = ageMenu.hidden;
      if (open) {
        closeToolbarMenus('ageMenu');
        openToolbarMenuOverlay(ageMenu);
      } else {
        closeToolbarMenus();
      }
    });
    ageMenu.addEventListener('click', function(e) {
      var opt = e.target.closest('.toolbar-option');
      if (!opt) return;
      setAgeFilter(opt.getAttribute('data-age') || '');
      closeToolbarMenus();
    });
  }
  if (sourceBtn && sourceMenu) {
    sourceBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      var open = sourceMenu.hidden;
      if (open) {
        closeToolbarMenus('sourceMenu');
        openToolbarMenuOverlay(sourceMenu);
      } else {
        closeToolbarMenus();
      }
    });
    sourceMenu.addEventListener('click', function(e) {
      var opt = e.target.closest('.toolbar-option');
      if (!opt) return;
      setSourceFilter(opt.getAttribute('data-source') || '');
      closeToolbarMenus();
    });
  }
  if (filtersToggle) {
    filtersToggle.addEventListener('click', function(e) {
      e.stopPropagation();
      closeToolbarMenus();
      filtersOpen = !filtersOpen;
      buildQfBar();
    });
  }
  if (displayToggle && sortBar) {
    displayToggle.addEventListener('click', function(e) {
      e.stopPropagation();
      var open = sortBar.hidden;
      if (open) {
        closeToolbarMenus('sortBar');
        openToolbarMenuOverlay(sortBar);
      } else {
        closeToolbarMenus();
      }
    });
  }
  bindToolbarMenuOverlayKeys();
})();
buildQfBar();
if (filterInput.value.trim()) currentFilterExpr = true;
// If any URL state was restored, fetch with those params instead of using inlined data
if (currentSort !== 'recent' || filterInput.value.trim()) {
  fetchSessions(function() { render(); restoreSessionFlyoutFromUrl(); });
} else {
  render();
}

/* --- session analytics flyout --- */
function sessionViewUrl(s, embed) {
  var url = '/view?id=' + encodeURIComponent(s.id);
  if (s.source && s.source !== 'claude') url += '&source=' + encodeURIComponent(s.source);
  if (embed) url += '&embed=1';
  return url;
}

var _listCursorId = null;
var _listCursorWrap = null;
var _listCursorFocus = false;

function listRowWraps() {
  if (!sessionsEl) return [];
  return sessionsEl.querySelectorAll('.session-row-wrap');
}

function selectedListIndex() {
  var wraps = listRowWraps();
  var i;
  if (_peekSession && _peekSession.id) {
    for (i = 0; i < wraps.length; i++) {
      if (wraps[i].getAttribute('data-session-id') === _peekSession.id) return i;
    }
  }
  if (_listCursorWrap) {
    for (i = 0; i < wraps.length; i++) {
      if (wraps[i] === _listCursorWrap) return i;
    }
  }
  if (_listCursorId) {
    for (i = 0; i < wraps.length; i++) {
      if (wraps[i].getAttribute('data-session-id') === _listCursorId) return i;
    }
  }
  var active = document.activeElement;
  if (active && active.closest) {
    var focused = active.closest('.session-row-wrap');
    if (focused) {
      for (i = 0; i < wraps.length; i++) {
        if (wraps[i] === focused) return i;
      }
    }
  }
  for (i = 0; i < wraps.length; i++) {
    if (wraps[i].classList.contains('is-selected')) return i;
  }
  return -1;
}

function markSelectedRow() {
  if (!sessionsEl) return;
  var wraps = listRowWraps();
  var i;
  var match = null;
  if (_peekSession && _peekSession.id) {
    for (i = 0; i < wraps.length; i++) {
      if (wraps[i].getAttribute('data-session-id') === _peekSession.id) match = wraps[i];
    }
  } else if (_listCursorWrap) {
    for (i = 0; i < wraps.length; i++) {
      if (wraps[i] === _listCursorWrap) { match = wraps[i]; break; }
    }
    if (!match && _listCursorId) {
      for (i = 0; i < wraps.length; i++) {
        if (wraps[i].getAttribute('data-session-id') === _listCursorId) match = wraps[i];
      }
    }
  } else if (_listCursorId) {
    for (i = 0; i < wraps.length; i++) {
      if (wraps[i].getAttribute('data-session-id') === _listCursorId) match = wraps[i];
    }
  }
  for (i = 0; i < wraps.length; i++) {
    wraps[i].classList.remove('is-selected');
    var link = wraps[i].querySelector('.session-row');
    if (link) link.removeAttribute('aria-current');
  }
  if (!match) return;
  match.classList.add('is-selected');
  _listCursorWrap = match;
  if (match.getAttribute('data-session-id')) _listCursorId = match.getAttribute('data-session-id');
  var selected = match.querySelector('.session-row');
  if (selected) selected.setAttribute('aria-current', 'true');
  restoreListCursorFocus();
}

function listCursorRow() {
  if (_listCursorWrap && _listCursorWrap.querySelector) {
    return _listCursorWrap.querySelector('.session-row');
  }
  if (!sessionsEl || typeof sessionsEl.querySelector !== 'function') return null;
  return sessionsEl.querySelector('.session-row-wrap.is-selected .session-row');
}

function nodeIsConnected(el) {
  if (!el) return false;
  if (typeof el.isConnected === 'boolean') return el.isConnected;
  try {
    var doc = el.ownerDocument || document;
    if (doc && typeof doc.contains === 'function') return doc.contains(el);
  } catch (e0) {}
  var n = el;
  while (n && n.parentNode) n = n.parentNode;
  return n === document || n === (document && document.documentElement);
}

/** VS Code listFocus: J/K owns the row until Escape, a field, or an overlay. */
function listCursorShouldOwnFocus() {
  if (!_listCursorFocus) return false;
  if (_peekSession) return false;
  if (document.body && document.body.classList.contains('cmdk-open')) return false;
  if (typeof overlayStackBusy === 'function' && overlayStackBusy()) return false;
  var active = document.activeElement;
  if (typeof isFormField === 'function' && isFormField(active)) return false;
  return true;
}

function focusListCursorRow() {
  var row = listCursorRow();
  if (!row || typeof row.focus !== 'function') return;
  if (document.activeElement === row) return;
  try { row.focus({ preventScroll: true }); } catch (e0) { row.focus(); }
}

/**
 * Live /api/runs polls call render() which wipes #sessions innerHTML.
 * That would leave BODY focused on a running div.session-row.run-row,
 * so Linear/GitHub Enter-to-open dies. Restore onto the new row node
 * when the list still owns the keyboard.
 */
function restoreListCursorFocus() {
  if (!listCursorShouldOwnFocus()) return;
  var active = document.activeElement;
  var selected = listCursorRow();
  if (active && active !== document.body && active !== document.documentElement) {
    var hotkeyBtn = active.id && String(active.id).indexOf('tqHotkey') === 0;
    if (!hotkeyBtn && nodeIsConnected(active) && active !== selected) return;
  }
  focusListCursorRow();
}

/** Linear idle J/K: highlight the current list when peek is closed. */
function stepSessionList(dir) {
  var wraps = listRowWraps();
  if (!wraps.length) return;
  var idx = selectedListIndex();
  var next;
  if (idx < 0) next = dir > 0 ? 0 : wraps.length - 1;
  else next = idx + dir;
  if (next < 0) next = 0;
  if (next >= wraps.length) next = wraps.length - 1;
  var wrap = wraps[next];
  if (!wrap) return;
  _listCursorWrap = wrap;
  _listCursorId = wrap.getAttribute('data-session-id') || null;
  _listCursorFocus = true;
  markSelectedRow();
  var row = wrap.querySelector('.session-row');
  if (row && typeof row.scrollIntoView === 'function') {
    try { row.scrollIntoView({ block: 'nearest' }); } catch (e0) { row.scrollIntoView(); }
  }
  // Hidden data-hotkey buttons click() after this returns; re-assert list focus
  // so a running div.session-row.run-row stays the Enter host.
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(function() { restoreListCursorFocus(); });
  } else if (typeof setTimeout === 'function') {
    setTimeout(restoreListCursorFocus, 0);
  }
}

/**
 * VS Code WorkbenchListFocusContextKey analog: the list owns Enter when
 * a J/K cursor exists AND focus is BODY/html (idle cursor) or the
 * selected row. A focused #newRunBtn / other chrome control is not
 * listFocus — native Enter must activate it.
 */
function listOwnsKeyboard() {
  if (_peekSession) return false;
  if (document.body && document.body.classList.contains('cmdk-open')) return false;
  if (typeof overlayStackBusy === 'function' && overlayStackBusy()) return false;
  var active = document.activeElement;
  if (typeof isFormField === 'function' && isFormField(active)) return false;
  var selected = listCursorRow();
  if (!selected) return false;
  if (!active || active === document.body || active === document.documentElement) return true;
  if (active === selected) return true;
  if (active.closest && active.closest('.session-row-wrap.is-selected')) return true;
  return false;
}

/**
 * Linear 2021 overlay / GitHub issue lists: O is an unscoped character
 * key on the J/K cursor. Enter is list.select (listOwnsKeyboard), not
 * a page-wide data-hotkey leaf. DOM focus may be BODY as long as
 * .session-row-wrap.is-selected is set.
 */
function openSelectedListItem() {
  if (_peekSession) return;
  var wraps = listRowWraps();
  if (!wraps.length) return;
  var idx = selectedListIndex();
  var wrap = idx >= 0 ? wraps[idx] : null;
  if (!wrap) {
    var active = document.activeElement;
    if (active && active.closest) wrap = active.closest('.session-row-wrap');
  }
  if (!wrap) return;
  var row = wrap.querySelector('.session-row');
  var isRun = (row && row.classList && row.classList.contains('run-row'))
    || (wrap.classList && wrap.classList.contains('run-row-wrap'));
  if (isRun) {
    var href = (row && (row.getAttribute('data-href') || row.getAttribute('href'))) || '';
    if (href) window.location.href = href;
    return;
  }
  var id = wrap.getAttribute('data-session-id');
  if (!id) return;
  var promptEl = row && row.querySelector('.session-prompt');
  openSessionFlyout({
    id: id,
    source: wrap.getAttribute('data-session-source') || 'claude',
    prompt: promptEl ? promptEl.textContent : '',
  });
}

/** Linear Esc-to-clear / VS Code list.clear: drop the idle J/K list cursor. */
function clearSessionListCursor() {
  var wraps = listRowWraps();
  var i;
  var changed = false;
  var active = document.activeElement;
  if (_listCursorId || _listCursorWrap || _listCursorFocus) changed = true;
  _listCursorId = null;
  _listCursorWrap = null;
  _listCursorFocus = false;
  for (i = 0; i < wraps.length; i++) {
    if (wraps[i].classList.contains('is-selected')) changed = true;
    wraps[i].classList.remove('is-selected');
    var link = wraps[i].querySelector('.session-row');
    if (link) {
      if (typeof link.getAttribute === 'function' && link.getAttribute('aria-current')) changed = true;
      if (typeof link.removeAttribute === 'function') link.removeAttribute('aria-current');
      if (active === link && typeof link.blur === 'function') {
        try { link.blur(); } catch (e0) {}
        changed = true;
      }
    }
  }
  if (active && active.closest && active.closest('.session-row-wrap') && typeof active.blur === 'function') {
    try { active.blur(); } catch (e1) {}
    changed = true;
  }
  return changed;
}

function peekIndex() {
  if (!_peekSession || !filtered) return -1;
  for (var i = 0; i < filtered.length; i++) {
    if (filtered[i].id === _peekSession.id) return i;
  }
  return -1;
}

function updatePeekNav() {
  var prev = document.getElementById('sessionFlyoutPrev');
  var next = document.getElementById('sessionFlyoutNext');
  if (!prev || !next) return;
  var idx = peekIndex();
  prev.disabled = !_peekSession || idx <= 0;
  next.disabled = !_peekSession || idx < 0 || idx >= filtered.length - 1;
}

function peekStep(dir) {
  var idx = peekIndex();
  if (idx < 0) return;
  var next = filtered[idx + dir];
  if (next) openSessionFlyout(next);
}

function openSessionFlyout(s) {
  if (!s || !s.id) return;
  var flyout = document.getElementById('sessionFlyout');
  var frame = document.getElementById('sessionFlyoutFrame');
  var title = document.getElementById('sessionFlyoutTitle');
  var sub = document.getElementById('sessionFlyoutSub');
  var openLink = document.getElementById('sessionFlyoutOpen');
  var status = document.getElementById('sessionFlyoutStatus');
  if (!flyout || !frame) return;
  var wasHidden = !!flyout.hidden;
  if (wasHidden) {
    flyout._tqPrevFocus = overlayPrevFocus(flyout);
    if (!flyout._tqPrevFocus) flyout._tqPrevFocus = document.activeElement;
  }
  var same = _peekSession && _peekSession.id === s.id && frame.getAttribute('src');
  _peekSession = { id: s.id, source: s.source || 'claude', prompt: s.prompt || '' };
  document.body.classList.add('session-peek-open');
  flyout.hidden = false;
  flyout.setAttribute('aria-hidden', 'false');
  if (title) title.textContent = s.id;
  if (sub) sub.textContent = s.prompt || '';
  if (openLink) openLink.href = sessionViewUrl(_peekSession, false);
  if (!same) {
    if (status) {
      status.hidden = false;
      status.textContent = 'Loading analytics…';
    }
    frame.hidden = true;
    frame.src = sessionViewUrl(_peekSession, true);
  }
  markSelectedRow();
  updatePeekNav();
  updatePageUrl();
  pushOverlay(flyout);
  if (wasHidden) {
    focusOverlay(flyout, openLink || document.getElementById('sessionFlyoutClose'));
  }
}

function closeSessionFlyout() {
  var flyout = document.getElementById('sessionFlyout');
  var wasOpen = !!(flyout && !flyout.hidden);
  _peekSession = null;
  document.body.classList.remove('session-peek-open');
  var frame = document.getElementById('sessionFlyoutFrame');
  var status = document.getElementById('sessionFlyoutStatus');
  if (flyout) {
    flyout.hidden = true;
    flyout.setAttribute('aria-hidden', 'true');
  }
  if (frame) {
    frame.hidden = true;
    frame.removeAttribute('src');
  }
  if (status) status.hidden = true;
  markSelectedRow();
  updatePeekNav();
  updatePageUrl();
  if (wasOpen) {
    popOverlay(flyout);
    restoreOverlayFocus(flyout._tqPrevFocus, flyout);
    flyout._tqPrevFocus = null;
  }
}

function restoreSessionFlyoutFromUrl() {
  if (!_peekSession) return;
  var match = null;
  for (var i = 0; i < ALL.length; i++) {
    if (ALL[i].id === _peekSession.id) { match = ALL[i]; break; }
  }
  openSessionFlyout(match || _peekSession);
}

(function bindSessionFlyout() {
  var closeBtn = document.getElementById('sessionFlyoutClose');
  if (closeBtn) closeBtn.addEventListener('click', function() { closeSessionFlyout(); });
  var prev = document.getElementById('sessionFlyoutPrev');
  if (prev) {
    if (typeof prev.setAttribute === 'function' && !prev.getAttribute('data-hotkey')) {
      prev.setAttribute('data-hotkey', 'k,K,ArrowUp');
    }
    prev.addEventListener('click', function() { peekStep(-1); });
    if (typeof install === 'function') install(prev);
  }
  var next = document.getElementById('sessionFlyoutNext');
  if (next) {
    if (typeof next.setAttribute === 'function' && !next.getAttribute('data-hotkey')) {
      next.setAttribute('data-hotkey', 'j,J,ArrowDown');
    }
    next.addEventListener('click', function() { peekStep(1); });
    if (typeof install === 'function') install(next);
  }
  var frame = document.getElementById('sessionFlyoutFrame');
  var flyoutEl = document.getElementById('sessionFlyout');
  if (frame) {
    frame.addEventListener('load', function() {
      if (!_peekSession) return;
      var status = document.getElementById('sessionFlyoutStatus');
      if (status) status.hidden = true;
      frame.hidden = false;
    });
    bindOverlayNestedFrameKeys(flyoutEl, frame, closeSessionFlyout);
  }
  window.addEventListener('message', function(e) {
    if (e.origin !== location.origin) return;
    if (!e.data || e.data.type !== 'tq-flyout') return;
    if (e.data.action === 'close') closeSessionFlyout();
    else if (e.data.action === 'next') peekStep(1);
    else if (e.data.action === 'prev') peekStep(-1);
    else if (e.data.action === 'cmdk' && window.TracequestPalette && typeof window.TracequestPalette.toggle === 'function') {
      window.TracequestPalette.toggle();
    }
  });
  document.addEventListener('keydown', function(event) {
    var flyout = document.getElementById('sessionFlyout');
    if (!flyout || flyout.hidden || !isTopOverlay(flyout)) return;
    if (event.key === 'Tab') {
      trapOverlayTab(event, flyout);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
      closeSessionFlyout();
    }
  }, true);
  restoreSessionFlyoutFromUrl();
})();

/* --- compare selection --- */
var compareBarEl = document.getElementById('compareBar');
var compareInfoEl = document.getElementById('compareInfo');
var compareBtnEl = document.getElementById('compareBtn');
var compareClearEl = document.getElementById('compareClear');

function findSessionByPath(path) {
  for (var i = 0; i < ALL.length; i++) {
    if (ALL[i].path === path) return ALL[i];
  }
  return null;
}

function updateCompareBar() {
  var n = compareSet.size;
  if (n === 0) {
    compareBarEl.classList.remove('visible');
    compareBtnEl.disabled = true;
    return;
  }
  compareBarEl.classList.add('visible');
  if (n === 1) {
    var path1 = Array.from(compareSet)[0];
    var s1 = findSessionByPath(path1);
    compareInfoEl.innerHTML = '<strong>' + escH(s1 ? s1.id : '?') + '</strong> selected — pick one more';
    compareBtnEl.disabled = true;
  } else {
    var pathArr = Array.from(compareSet);
    var sa = findSessionByPath(pathArr[0]);
    var sb = findSessionByPath(pathArr[1]);
    if (!sa || !sb) {
      compareInfoEl.innerHTML = '2 selected — clear and reselect visible runs';
      compareBtnEl.disabled = true;
      return;
    }
    compareInfoEl.innerHTML = '<strong>' + escH(sa.id) + '</strong> vs <strong>' + escH(sb.id) + '</strong>';
    compareBtnEl.disabled = false;
  }
}

sessionsEl.addEventListener('change', function(e) {
  var cb = e.target.closest('.compare-cb');
  if (!cb) return;
  var path = cb.dataset.path;
  if (cb.checked) {
    if (compareSet.size >= 2) {
      var oldest = Array.from(compareSet)[0];
      compareSet.delete(oldest);
      var oldCb = sessionsEl.querySelector('.compare-cb[data-path="' + CSS.escape(oldest) + '"]');
      if (oldCb) oldCb.checked = false;
    }
    compareSet.add(path);
  } else {
    compareSet.delete(path);
  }
  updateCompareBar();
});

/* run-row activation + kill/dismiss (delegated so re-renders keep working) */
sessionsEl.addEventListener('click', function(e) {
  if (e.target.closest('.compare-cb')) {
    e.stopPropagation();
    return;
  }
  var dismiss = e.target.closest('.run-dismiss');
  if (dismiss) {
    e.preventDefault();
    e.stopPropagation();
    fetch('/api/runs/kill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: dismiss.getAttribute('data-run-id') }),
    }).then(function() { _runsSig = null; fetchRuns(); }).catch(function() {});
    return;
  }
  var cont = e.target.closest('.session-continue');
  if (cont) {
    // Continue: open the row's inline composer — typing IS the continue.
    e.preventDefault();
    e.stopPropagation();
    openContinueForm(cont);
    return;
  }
  if (e.target.closest('.session-continue-form')) {
    // Clicks inside the composer never activate the row link behind it.
    e.stopPropagation();
    return;
  }
  var sessionLink = e.target.closest('a.session-row');
  if (sessionLink) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    var wrap = sessionLink.closest('.session-row-wrap');
    var id = wrap && wrap.getAttribute('data-session-id');
    if (!id) return;
    var promptEl = sessionLink.querySelector('.session-prompt');
    openSessionFlyout({
      id: id,
      source: (wrap && wrap.getAttribute('data-session-source')) || 'claude',
      prompt: promptEl ? promptEl.textContent : '',
    });
    return;
  }
  var row = e.target.closest('.run-row');
  if (row) window.location.href = row.getAttribute('data-href');
});
sessionsEl.addEventListener('submit', function(e) {
  var form = e.target.closest ? e.target.closest('.session-continue-form') : null;
  if (!form) return;
  e.preventDefault();
  submitContinueForm(form);
});
sessionsEl.addEventListener('input', function(e) {
  var input = e.target.closest ? e.target.closest('.session-continue-input') : null;
  if (!input || !_contDraft) return;
  if (_contDraft.cwdMode) _contDraft.cwdText = input.value;
  else _contDraft.text = input.value;
});
sessionsEl.addEventListener('keydown', function(e) {
  if (e.key !== 'Escape') return;
  if (e.target.closest && e.target.closest('.session-continue-form')) closeContinueForm();
});
sessionsEl.addEventListener('keydown', function(e) {
  if (e.key !== 'Enter') return;
  if (document.body.classList.contains('cmdk-open')) return;
  if (isFormField(e.target)) return;
  if (e.target && e.target.closest && e.target.closest('.session-continue-form')) return;
  var row = e.target && e.target.closest ? e.target.closest('.run-row') : null;
  if (row) {
    var href = row.getAttribute('data-href') || row.getAttribute('href');
    if (href) {
      e.preventDefault();
      window.location.href = href;
    }
  }
});

compareBtnEl.addEventListener('click', function() {
  if (compareSet.size !== 2) return;
  var pathArr = Array.from(compareSet);
  var a = findSessionByPath(pathArr[0]);
  var b = findSessionByPath(pathArr[1]);
  if (!a || !b) return;
  var url = '/compare?a=' + encodeURIComponent(a.id)
    + (a.source !== 'claude' ? '&sa=' + a.source : '')
    + '&b=' + encodeURIComponent(b.id)
    + (b.source !== 'claude' ? '&sb=' + b.source : '');
  window.location.href = url;
});

compareClearEl.addEventListener('click', function() {
  compareSet.clear();
  sessionsEl.querySelectorAll('.compare-cb:checked').forEach(function(cb) { cb.checked = false; });
  updateCompareBar();
});

var _refreshTimer = null;
window._refreshData = function() {
  if (_refreshTimer) return;
  _refreshTimer = setTimeout(function() {
    _refreshTimer = null;
    fetchSessions(function() { render(); }, { preserveStaleOnError: true });
    fetchRuns();
  }, 2000);
};

// Launched runs pop into the session list right after load, not on the
// first 3s tick.
fetchRuns();

`;

/** Named segments of the session list client script (order matters). */
export const BROWSER_CLIENT_BUNDLE_PARTS = [
  { id: "prep-and-formats", source: BROWSER_CLIENT_PREP_AND_FORMATS_JS },
  { id: "dashboard", source: BROWSER_CLIENT_DASHBOARD_JS },
  { id: "pagination-and-rest", source: BROWSER_CLIENT_REST_JS },
  { id: "launcher", source: LAUNCHER_CLIENT_JS },
  { id: "command-palette", source: COMMAND_PALETTE_CLIENT_JS },
];

/**
 * Join static bundle parts into the shared script tail (init head is per-call).
 * @returns {string}
 */
export function buildBrowserClientTail() {
  return joinBundleParts(BROWSER_CLIENT_BUNDLE_PARTS, { spaced: false });
}

/** Module-scope constant tail reused across browserClientScript calls. */
export const BROWSER_CLIENT_SCRIPT_TAIL = buildBrowserClientTail();

export function browserClientScript(data) {
  return buildBrowserClientScriptHead(data) + BROWSER_CLIENT_SCRIPT_TAIL;
}
