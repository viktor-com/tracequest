/**
 * Dynamic init block prepended per browserClientScript(data) call.
 * @param {string} data JSON init payload (already serialized)
 * @returns {string}
 */
export function buildBrowserClientScriptHead(data) {
  return `var _INIT_DATA = ${data};
var ALL = _INIT_DATA.sessions;
var SERVER_TOTAL = _INIT_DATA.total;
var SERVER_STATS = _INIT_DATA.stats || {};
var QF_STATS = JSON.parse(JSON.stringify(SERVER_STATS));
var _liveSessions = _INIT_DATA.liveSessions || [];
var _livePaths = new Set(_liveSessions.filter(function(s){return s.live === true}).map(function(s){return s.path}));
`;
}

export const BROWSER_CLIENT_DASHBOARD_JS = `var dashboardCollapsed = true;
var dashboardEl = document.getElementById('dashboard');
var paginationEl = document.getElementById('pagination');
var PAGE_SIZE = 50;
var currentPage = 1;
// Read initial page from URL
(function() {
  var params = new URLSearchParams(window.location.search);
  var p = parseInt(params.get('page'), 10);
  if (p > 0) currentPage = p;
  var ps = parseInt(params.get('pageSize'), 10);
  if (ps > 0 && [25, 50, 100, 200].indexOf(ps) !== -1) PAGE_SIZE = ps;
})();

function renderDashboard() {
  if (!SERVER_TOTAL) {
    dashboardEl.style.display = 'none';
    return;
  }
  dashboardEl.style.display = '';

  // Use server-provided stats
  var totalSessions = SERVER_STATS.totalSessions || SERVER_TOTAL;
  var totalInputTok = SERVER_STATS.totalInputTokens || 0;
  var totalOutputTok = SERVER_STATS.totalOutputTokens || 0;
  var totalCacheRead = SERVER_STATS.totalCacheReadTokens || 0;
  var totalDuration = SERVER_STATS.totalDurationMs || 0;
  var totalErrors = SERVER_STATS.totalErrors || 0;
  var totalCommits = SERVER_STATS.totalCommits || 0;
  var totalFiles = SERVER_STATS.totalFiles || 0;
  var totalChapters = SERVER_STATS.totalChapters || 0;
  var toolAgg = SERVER_STATS.toolAgg || {};

  var totalCost = SERVER_STATS.totalCost || 0;

  // Cache hit rate
  var totalInput = totalInputTok + totalCacheRead;
  var cacheHitPct = totalInput > 0 ? ((totalCacheRead / totalInput) * 100) : 0;

  var growthData = {};

  function growthBadge(key, invert) {
    var pct = growthData[key];
    if (pct === undefined || (pct > -5 && pct < 5)) return '';
    var isUp = pct > 0;
    var arrow = isUp ? '↑' : '↓';
    var cls = (isUp !== (!!invert)) ? 'up' : 'down';
    return ' <span class="dashboard-stat-growth ' + cls + '">' + arrow + fmtPct(Math.abs(pct)) + '</span>';
  }

  // Top tools (sorted by frequency across sessions)
  var toolEntries = [];
  for (var tk in toolAgg) {
    if (toolAgg.hasOwnProperty(tk)) toolEntries.push([tk, toolAgg[tk]]);
  }
  toolEntries.sort(function(a, b) { return b[1] - a[1]; });
  var topTools = toolEntries.slice(0, 10);

  // Format helpers
  var fmtCostVal = totalCost >= 1000 ? '$' + Math.round(totalCost).toLocaleString('en-US') : fmtCost(totalCost, { prefix: '$', zeroLabel: '$0' });
  var totalTokFmt = fmtTokens(totalInputTok + totalOutputTok + totalCacheRead);
  var durFmt = fmtDuration(totalDuration);

  var collapseClass = dashboardCollapsed ? ' collapsed' : '';
  var toggleLabel = dashboardCollapsed ? 'tools' : 'hide tools';
  var toggleExpanded = dashboardCollapsed ? 'false' : 'true';
  var toggleAria = dashboardCollapsed ? 'Show tool inventory' : 'Hide tool inventory';

  var html = '<div class="dashboard-header">'
    + '<span class="dashboard-title">Overview</span>'
    + (currentFilterExpr
      ? '<span class="dashboard-scope">' + totalSessions + ' run' + (totalSessions !== 1 ? 's' : '') + ' (filtered)</span>'
      : '')
    + '</div>';

  html += '<div class="dashboard-stats">';
  function group(n) { return typeof n === 'number' ? n.toLocaleString('en-US') : n; }
  function dashStat(val, label, growth) {
    val = group(val);
    return '<span class="dashboard-stat"><span class="dashboard-stat-val">' + val + '</span><span class="dashboard-stat-label">' + label + ' ' + (growth || '') + '</span></span>';
  }
  // ONE origin-agnostic running count (liveNow: generating launched runs via
  // runIsLive, never tmux status running alone, plus external live sessions,
  // deduped by recording path) — the same definition the list's pinned rows
  // and the run-page shell counter use. The chrome word is running, not live.
  var liveN = liveNow();
  if (liveN) html += dashStat('<span class="dash-live-n" style="color:var(--ok)">' + liveN + '</span>', 'running');
  html += dashStat(totalSessions, 'runs');
  html += dashStat(fmtCostVal, 'cost', growthBadge('cost'));
  html += dashStat(totalTokFmt || '--', 'tokens', growthBadge('tokens'));
  html += dashStat(fmtPct(cacheHitPct, { hideZero: true }), 'cache', growthBadge('cache'));
  html += dashStat(durFmt || '--', 'duration', growthBadge('duration'));
  html += dashStat(totalErrors, 'errors', growthBadge('errors', true));
  html += dashStat(totalCommits, 'commits', growthBadge('commits'));
  html += dashStat(totalFiles, 'files', growthBadge('files'));
  html += dashStat(totalChapters, 'chapters', growthBadge('chapters'));
  html += '</div>';

  if (topTools.length) {
    html += '<button class="dashboard-toggle" id="dashToggle" aria-expanded="' + toggleExpanded + '" aria-label="' + toggleAria + '">' + toggleLabel + '</button>';
    html += '<div class="dashboard-tools">';
    html += '<div class="dashboard-tools-title">most-used tools (runs using)</div>';
    html += '<div class="dashboard-tools-list">';
    for (var ti = 0; ti < topTools.length; ti++) {
      var tName = topTools[ti][0];
      var tCount = topTools[ti][1];
      var tColor = getToolClr(tName);
      var tLabel = fmtMcpName(tName);
      html += '<span class="dashboard-tool-chip" style="color:' + tColor + '">' + escH(tLabel) + ' <span class="dashboard-tool-count">' + tCount + '</span></span>';
    }
    html += '</div></div>';
  }

  dashboardEl.innerHTML = html;
  dashboardEl.className = 'dashboard' + collapseClass;

  var toggleBtn = document.getElementById('dashToggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', function() {
      dashboardCollapsed = !dashboardCollapsed;
      dashboardEl.classList.toggle('collapsed', dashboardCollapsed);
      toggleBtn.innerHTML = dashboardCollapsed ? 'tools' : 'hide tools';
      toggleBtn.setAttribute('aria-expanded', dashboardCollapsed ? 'false' : 'true');
      toggleBtn.setAttribute('aria-label', dashboardCollapsed ? 'Show tool inventory' : 'Hide tool inventory');
    });
  }
}`;
