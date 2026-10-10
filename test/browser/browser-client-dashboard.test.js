import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BROWSER_CLIENT_DASHBOARD_JS,
  buildBrowserClientScriptHead,
} from '../../src/browser/browser-client-dashboard.js';
import {
  browserClientScript,
  BROWSER_CLIENT_BUNDLE_PARTS,
  BROWSER_CLIENT_SCRIPT_TAIL,
  buildBrowserClientTail,
} from '../../src/browser/browser-client.js';
import { withLiveReload } from '../../src/server/server-html-helpers.js';
import { sessionMtimeMs } from '../../src/sessions/session-list.js';
import { includesLower, sumToolCounts } from '../../src/parse/parse-utils.js';
import { computeStats } from '../../src/server/server-helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const INIT_EMPTY = '{"sessions":[],"total":0,"stats":{}}';

/** deepStrictEqual across vm.runInNewContext boundaries rejects equal plain objects. */
function assertVmDeepEqual(actual, expected, message) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
}

/** indexOfLower block injected before getSuggestions in the client bundle. */
function extractIndexOfLowerBlock(script) {
  const start = script.indexOf('var LOWER_NATIVE_THRESHOLD');
  assert.ok(start >= 0, 'LOWER_NATIVE_THRESHOLD should exist in client script');
  const end = script.indexOf('function getSuggestions');
  assert.ok(end > start, 'getSuggestions should follow indexOfLower helpers');
  return script.slice(start, end).trim();
}

/** Extract a top-level `function name(...) { ... }` block from generated client script. */
function extractFunction(script, name) {
  const marker = `function ${name}(`;
  const start = script.indexOf(marker);
  assert.ok(start >= 0, `${name} should exist in client script`);
  const brace = script.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < script.length; i++) {
    if (script[i] === '{') depth++;
    else if (script[i] === '}') {
      depth--;
      if (depth === 0) return script.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

function autocompleteContext(script) {
  return `
var FILTER_KEYS = ['project', 'source', 'tool', 'model', 'grade', 'errors', 'size', 'age', 'live'];
var KEY_COLORS = {
  project: '#a78bfa', source: '#59d4a0', tool: '#e0c45e',
  model: '#6ba4e8', grade: '#59d4a0', errors: '#f07070',
  size: '#7a7a85', age: '#7a7a85', live: '#4ade80', text: '#8b8b92'
};
var projectCounts = new Map([['my-app', 12], ['demo', 3], ['other', 1]]);
var sourceCounts = new Map([['claude', 8], ['codex', 2]]);
var toolCounts = new Map([['Bash', 5], ['Read', 2]]);
var modelCounts = new Map([['sonnet', 4]]);
${extractIndexOfLowerBlock(script)}
${extractFunction(script, 'getLastToken')}
${extractFunction(script, 'getSuggestions')}
`;
}

function runGetSuggestions(script, text) {
  return vm.runInNewContext(
    `${autocompleteContext(script)}; getSuggestions(${JSON.stringify(text)});`,
  );
}

function runGetLastToken(script, text) {
  return vm.runInNewContext(
    `${extractFunction(script, 'getLastToken')}; getLastToken(${JSON.stringify(text)});`,
  );
}

function autocompleteApplyContext(script) {
  return `${autocompleteContext(script)}
${extractFunction(script, 'replaceLastToken')}
${extractFunction(script, 'acceptSuggestion')}
function renderSuggestions(items) { renderCalls.push(items); }
function closeSuggestions() { closeCalls++; }
function commitFilter() { commitCalls++; }`;
}

function runReplaceLastToken(script, initial, replacement) {
  const sandbox = {
    filterInput: { value: initial },
    renderCalls: [],
    closeCalls: 0,
    commitCalls: 0,
    focusCalls: 0,
  };
  vm.runInContext(
    `${autocompleteApplyContext(script)}
replaceLastToken(${JSON.stringify(replacement)});`,
    vm.createContext(sandbox),
  );
  return sandbox.filterInput.value;
}

function runAcceptSuggestion(script, opts) {
  const sandbox = {
    filterInput: {
      value: opts.initial ?? '',
      focus() { sandbox.focusCalls++; },
    },
    currentSugs: opts.currentSugs ?? [],
    renderCalls: [],
    closeCalls: 0,
    commitCalls: 0,
    focusCalls: 0,
  };
  vm.runInContext(
    `${autocompleteApplyContext(script)}
currentSugs = ${JSON.stringify(opts.currentSugs ?? [])};
acceptSuggestion(${opts.idx});`,
    vm.createContext(sandbox),
  );
  return {
    value: sandbox.filterInput.value,
    renderCalls: sandbox.renderCalls,
    closeCalls: sandbox.closeCalls,
    commitCalls: sandbox.commitCalls,
    focusCalls: sandbox.focusCalls,
  };
}

function assertLastToken(actual, expected) {
  if (expected === null) {
    assert.equal(actual, null);
    return;
  }
  assert.equal(actual.token, expected.token);
  assert.equal(actual.start, expected.start);
}

function runSortSessions(script, sort, sessions) {
  const block = extractFunction(script, 'sortSessions');
  const normalizeSortKey = extractFunction(script, 'normalizeSortKey');
  const sortSessionList = extractFunction(script, 'sortSessionList');
  const mtimeHelper = sessionMtimeMs.toString();
  return vm.runInNewContext(
    `${mtimeHelper}
${normalizeSortKey}
${sortSessionList}
var currentSort = ${JSON.stringify(sort)};
${block}
sortSessions(sessions);
sessions;`,
    { sessions },
  );
}

const URL_PAGE_BOOTSTRAP = BROWSER_CLIENT_DASHBOARD_JS.match(
  /\/\/ Read initial page from URL[\s\S]*?\}\)\(\);/,
)?.[0];

function extractPaginationFns(script, names) {
  return names.map((n) => extractFunction(script, n)).join('\n');
}

function runPaginationMath(script, { serverTotal, pageSize = 50, currentPage = 1 }) {
  return vm.runInNewContext(
    `var PAGE_SIZE = ${pageSize};
var currentPage = ${currentPage};
var SERVER_TOTAL = ${serverTotal};
${extractPaginationFns(script, ['totalPages', 'pageStart', 'pageEnd'])}
({ tp: totalPages(), start: pageStart(), end: pageEnd() });`,
  );
}

function runUrlPaginationBootstrap(search) {
  return vm.runInNewContext(
    `var PAGE_SIZE = 50;
var currentPage = 1;
var window = { location: { search: ${JSON.stringify(search)} } };
${URL_PAGE_BOOTSTRAP}
({ PAGE_SIZE, currentPage });`,
    { URLSearchParams },
  );
}

function createPaginationEl() {
  const el = {
    innerHTML: '',
    className: '',
    _classes: new Set(),
    classList: {
      add(c) { el._classes.add(c); },
      remove(c) { el._classes.delete(c); },
    },
  };
  return el;
}

function runRenderPagination(script, { serverTotal, pageSize = 50, currentPage = 1 }) {
  const el = createPaginationEl();
  vm.runInNewContext(
    `var PAGE_SIZE = ${pageSize};
var currentPage = ${currentPage};
var SERVER_TOTAL = ${serverTotal};
var paginationEl = el;
${extractPaginationFns(script, ['totalPages', 'pageStart', 'pageEnd', 'renderPagination'])}
renderPagination();
el;`,
    { el },
  );
  return el;
}

function runUpdatePageUrl(script, opts) {
  const captured = { url: null };
  const sandbox = {
    PAGE_SIZE: opts.pageSize,
    currentPage: opts.currentPage,
    currentSort: opts.currentSort ?? 'recent',
    filterInput: { value: opts.filterExpr ?? '' },
    _peekSession: opts.peekSession ?? null,
    window: {
      location: {
        pathname: '/',
        search: opts.initialSearch ?? '',
      },
    },
    history: {
      replaceState(_a, _b, url) { captured.url = url; },
    },
    URLSearchParams,
  };
  vm.runInContext(
    `${extractFunction(script, 'updatePageUrl')}
updatePageUrl();`,
    vm.createContext(sandbox),
  );
  return captured.url;
}

function runGoToPage(script, { serverTotal, pageSize = 50, currentPage, target }) {
  const sandbox = {
    PAGE_SIZE: pageSize,
    currentPage,
    SERVER_TOTAL: serverTotal,
    fetchCalls: 0,
    renderCalls: 0,
    document: {
      getElementById() {
        return { scrollIntoView() {} };
      },
    },
  };
  vm.runInContext(
    `function fetchSessions(cb) { fetchCalls++; if (cb) cb(); }
function render() { renderCalls++; }
${extractPaginationFns(script, ['totalPages', 'goToPage'])}
goToPage(${target});
({ currentPage, fetchCalls, renderCalls });`,
    vm.createContext(sandbox),
  );
  return {
    currentPage: sandbox.currentPage,
    fetchCalls: sandbox.fetchCalls,
    renderCalls: sandbox.renderCalls,
  };
}

/** Run dynamic init head in a VM and return wired globals. */
function runInitHeadVm(dataObj) {
  const data = JSON.stringify(dataObj);
  return vm.runInNewContext(`${buildBrowserClientScriptHead(data)}
({
  ALL_len: ALL.length,
  SERVER_TOTAL,
  SERVER_STATS,
  QF_STATS,
  livePathSize: _livePaths.size,
  livePaths: Array.from(_livePaths),
});`);
}

const PREP_FOR_DASHBOARD_VM = BROWSER_CLIENT_BUNDLE_PARTS
  .find((p) => p.id === 'prep-and-formats')
  .source;

const REST_ESC_H = BROWSER_CLIENT_BUNDLE_PARTS
  .find((p) => p.id === 'pagination-and-rest')
  .source.match(/function escH\(s\) \{[\s\S]*?\n\}/)?.[0];

function runRenderDashboardVm(script, opts) {
  const el = {
    innerHTML: '',
    style: { display: 'block' },
    className: '',
    classList: { toggle() {} },
  };
  const toggleBtn = { innerHTML: '', addEventListener() {} };
  const document = {
    getElementById(id) {
      return id === 'dashToggle' ? toggleBtn : null;
    },
  };
  vm.runInNewContext(
    `var SERVER_TOTAL = ${opts.serverTotal};
var SERVER_STATS = ${JSON.stringify(opts.serverStats ?? {})};
var currentFilterExpr = ${opts.filterExpr == null ? 'null' : JSON.stringify(opts.filterExpr)};
var dashboardCollapsed = false;
var _liveSessions = ${JSON.stringify(opts.liveSessions ?? [])};
var _runs = ${JSON.stringify(opts.runs ?? [])};
var dashboardEl = el;
${PREP_FOR_DASHBOARD_VM}
${REST_ESC_H}
${extractFunction(script, 'runIsLive')}
${extractFunction(script, 'liveNow')}
${extractFunction(script, 'renderDashboard')}
renderDashboard();`,
    vm.createContext({ el, document }),
  );
  return el;
}

/** The one origin-agnostic live counter (generating launched runs + external live sessions). */
function runLiveNowVm(script, { runs = [], liveSessions = [] } = {}) {
  return vm.runInNewContext(
    `var _runs = ${JSON.stringify(runs)};
var _liveSessions = ${JSON.stringify(liveSessions)};
${extractFunction(script, 'runIsLive')}
${extractFunction(script, 'liveNow')}
liveNow();`,
  );
}

/** Render one external live session as its unified first-class live row. */
function runExternalLiveRowVm(script, session) {
  return vm.runInNewContext(
    `${sumToolCounts.toString().replace(/^export /, '')}
${includesLower.toString().replace(/^export /, '')}
${PREP_FOR_DASHBOARD_VM}
${REST_ESC_H}
${extractFunction(script, 'sessionStatChipsHtml')}
${extractFunction(script, 'sessionStatsHtml')}
${extractFunction(script, 'liveAgentRowHtml')}
${extractFunction(script, 'externalLiveRowHtml')}
externalLiveRowHtml(s);`,
    vm.createContext({ s: session }),
  );
}

/** The external (non-run-linked) live sessions render() pins on page 1. */
function runExternalLiveSessionsVm(script, liveSessions, runs = []) {
  return vm.runInNewContext(
    `var _liveSessions = ${JSON.stringify(liveSessions)};
var _runs = ${JSON.stringify(runs)};
var _runsBySession = {};
for (var _i = 0; _i < _runs.length; _i++) {
  if (_runs[_i].sessionPath) _runsBySession[_runs[_i].sessionPath] = _runs[_i];
}
${extractFunction(script, 'externalLiveSessions')}
externalLiveSessions();`,
  );
}

/** Continue-affordance context: no agents info fetched → no Continue controls. */
const CONTINUE_VM_PRELUDE = `var _agentsInfo = { mux: false, resumable: {} };
var SOURCE_AGENTS = { claude: 'claude', cursor: 'cursor-agent', codex: 'codex', grok: 'grok', opencode: 'opencode', factory: 'droid' };
`;

function runRenderRowVmWithContinue(script, session, livePaths = []) {
  return vm.runInNewContext(
    `var _livePaths = new Set(${JSON.stringify(livePaths)});
${PREP_FOR_DASHBOARD_VM}
${REST_ESC_H}
var _agentsInfo = { mux: true, resumable: { claude: true } };
var SOURCE_AGENTS = { claude: 'claude', cursor: 'cursor-agent', codex: 'codex', grok: 'grok', opencode: 'opencode', factory: 'droid' };
${extractFunction(script, 'continueAgentForSource')}
${extractFunction(script, 'continueBtnHtml')}
${extractFunction(script, 'sessionStatChipsHtml')}
${extractFunction(script, 'sessionStatsHtml')}
${extractFunction(script, 'renderRow')}
renderRow(s, 0);`,
    vm.createContext({ s: session }),
  );
}

function runRenderRowVm(script, session, livePaths = []) {
  return vm.runInNewContext(
    `var _livePaths = new Set(${JSON.stringify(livePaths)});
${PREP_FOR_DASHBOARD_VM}
${REST_ESC_H}
${CONTINUE_VM_PRELUDE}
${extractFunction(script, 'continueAgentForSource')}
${extractFunction(script, 'continueBtnHtml')}
${extractFunction(script, 'sessionStatChipsHtml')}
${extractFunction(script, 'sessionStatsHtml')}
${extractFunction(script, 'renderRow')}
renderRow(s, 0);`,
    vm.createContext({ s: session }),
  );
}

/**
 * Run the real dashboard render() against a page-1 snapshot (ALL + liveSessions).
 * This is the user-visible path: generating sessions are stripped from ALL and
 * painted through externalLiveRowHtml; idle inventory rows go through renderRow.
 */
function runDashboardListHtml(script, { sessions = [], liveSessions = [], runs = [] } = {}) {
  const collected = [];
  const sentinel = {
    style: { display: '' },
    insertAdjacentHTML(_pos, html) { collected.push(html); },
  };
  const sessionsEl = {
    innerHTML: '',
    insertAdjacentHTML(_pos, html) { collected.push(html); },
    appendChild() {},
  };
  const countEl = { textContent: '' };
  const appLiveEl = { hidden: true, textContent: '' };
  const dashboardEl = {
    innerHTML: '',
    style: { display: 'block' },
    className: '',
    classList: { toggle() {} },
  };
  const ctx = {
    ALL: sessions.map((s) => ({ ...s })),
    SERVER_TOTAL: sessions.length,
    SERVER_STATS: { totalSessions: sessions.length },
    _liveSessions: liveSessions.map((s) => ({ ...s })),
    _livePaths: new Set(liveSessions.filter((s) => s.live === true).map((s) => s.path)),
    _runs: runs,
    _runsBySession: Object.fromEntries(runs.filter((r) => r.sessionPath).map((r) => [r.sessionPath, r])),
    currentPage: 1,
    currentFilterExpr: null,
    dashboardCollapsed: false,
    dashboardEl,
    _fetchError: null,
    filtered: [],
    renderedCount: 0,
    sessionsEl,
    sentinel,
    collected,
    countEl,
    appLiveEl,
    document: {
      getElementById(id) {
        if (id === 'count') return countEl;
        if (id === 'appLive') return appLiveEl;
        return null;
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(
    `${PREP_FOR_DASHBOARD_VM}
${REST_ESC_H}
${CONTINUE_VM_PRELUDE}
${extractFunction(script, 'continueAgentForSource')}
${extractFunction(script, 'continueBtnHtml')}
${extractFunction(script, 'sessionStatChipsHtml')}
${extractFunction(script, 'sessionStatsHtml')}
${extractFunction(script, 'runIsLive')}
${extractFunction(script, 'liveNow')}
${extractFunction(script, 'indexedSessionForRun')}
${extractFunction(script, 'liveInfoForRun')}
${extractFunction(script, 'liveAgentRowHtml')}
${extractFunction(script, 'runSessionRowHtml')}
${extractFunction(script, 'externalLiveRowHtml')}
${extractFunction(script, 'externalLiveSessions')}
${extractFunction(script, 'renderRow')}
${extractFunction(script, 'renderPageBatch')}
${extractFunction(script, 'renderDashboard')}
function buildQfBar() {}
function renderPagination() {}
function updatePageUrl() {}
function restoreContinueForm() {}
${extractFunction(script, 'render')}
render();
listHtml = collected.join('');
liveN = liveNow();
dashboardHtml = dashboardEl.innerHTML;`,
    ctx,
  );
  return {
    html: ctx.listHtml,
    count: countEl.textContent,
    appLive: appLiveEl,
    dashboardHtml: ctx.dashboardHtml,
    liveN: ctx.liveN,
  };
}

/** Render one launched run as its first-class session-list row. */
function runRunRowVm(script, run, { allSessions = [], liveSessions = [] } = {}) {
  return vm.runInNewContext(
    `var ALL = ${JSON.stringify(allSessions)};
var _liveSessions = ${JSON.stringify(liveSessions)};
${sumToolCounts.toString().replace(/^export /, '')}
${includesLower.toString().replace(/^export /, '')}
${PREP_FOR_DASHBOARD_VM}
${REST_ESC_H}
${CONTINUE_VM_PRELUDE}
${extractFunction(script, 'continueBtnHtml')}
${extractFunction(script, 'indexedSessionForRun')}
${extractFunction(script, 'liveInfoForRun')}
${extractFunction(script, 'sessionStatChipsHtml')}
${extractFunction(script, 'sessionStatsHtml')}
${extractFunction(script, 'runIsLive')}
${extractFunction(script, 'liveAgentRowHtml')}
${extractFunction(script, 'runSessionRowHtml')}
runSessionRowHtml(r);`,
    vm.createContext({ r: run }),
  );
}

/** Simulate fetchSessions JSON handler stats/live refresh (QF_STATS is init-only). */
function runFetchPayloadRefreshVm(headDataObj, fetchPayload) {
  const head = buildBrowserClientScriptHead(JSON.stringify(headDataObj));
  return vm.runInNewContext(
    `${head}
var data = ${JSON.stringify(fetchPayload)};
ALL = data.sessions || ALL;
SERVER_TOTAL = data.total;
if (data.stats) SERVER_STATS = data.stats;
_liveSessions = data.liveSessions || [];
_livePaths = new Set(_liveSessions.filter(function(s) { return s.live === true; }).map(function(s) { return s.path; }));
({ SERVER_TOTAL, SERVER_STATS, QF_STATS, livePaths: Array.from(_livePaths) });`,
  );
}

function runFetchSessionsQuery(script, opts) {
  const sandbox = {
    PAGE_SIZE: opts.pageSize,
    currentPage: opts.currentPage,
    currentSort: opts.sort ?? 'recent',
    filterInput: { value: opts.expr ?? '' },
    paramsStr: null,
    URLSearchParams,
  };
  vm.runInContext(
    `var params = new URLSearchParams();
if (currentPage > 1) params.set('page', currentPage);
if (PAGE_SIZE !== 50) params.set('pageSize', PAGE_SIZE);
if (currentSort && currentSort !== 'recent') params.set('sort', currentSort);
var expr = filterInput.value.trim();
if (expr) params.set('expr', expr);
paramsStr = params.toString();`,
    vm.createContext(sandbox),
  );
  return sandbox.paramsStr;
}

describe('browser-client-dashboard module', () => {
  test('dashboard module is 100+ lines (head builder + overview UI)', () => {
    const src = readFileSync(join(__dirname, '../../src/browser/browser-client-dashboard.js'), 'utf8');
    const lineCount = src.split('\n').length;
    assert.ok(lineCount >= 100, `expected browser-client-dashboard.js >= 100 lines, got ${lineCount}`);
    assert.ok(BROWSER_CLIENT_DASHBOARD_JS.split('\n').length >= 100,
      'dashboard JS segment should be 100+ lines');
  });

  test('buildBrowserClientScriptHead builds init payload wiring', () => {
    const data = '{"sessions":[{"id":"x"}],"total":1,"stats":{"totalSessions":1}}';
    const head = buildBrowserClientScriptHead(data);
    assert.ok(head.includes(`var _INIT_DATA = ${data}`));
    assert.ok(head.includes('var ALL = _INIT_DATA.sessions'));
    assert.ok(head.includes('_livePaths = new Set'));
  });

  test('dashboard module defines overview renderer and state', () => {
    assert.ok(BROWSER_CLIENT_DASHBOARD_JS.includes('function renderDashboard'));
    assert.ok(BROWSER_CLIENT_DASHBOARD_JS.includes('dashboardCollapsed'));
    assert.ok(BROWSER_CLIENT_DASHBOARD_JS.includes('dashboard-stat-growth'));
    assert.ok(BROWSER_CLIENT_DASHBOARD_JS.includes('growthBadge'));
    assert.ok(BROWSER_CLIENT_DASHBOARD_JS.includes('fmtPct(Math.abs(pct))'));
  });

  test('browser-client.js composes dashboard module; no inline renderDashboard', () => {
    const src = readFileSync(join(__dirname, '../../src/browser/browser-client.js'), 'utf8');
    assert.ok(src.includes('browser-client-dashboard.js'), 'should import dashboard module');
    assert.ok(!src.includes('function renderDashboard()'),
      'renderDashboard should live in dashboard module');
    assert.ok(BROWSER_CLIENT_SCRIPT_TAIL.includes('function renderDashboard'),
      'assembled tail should still include spliced dashboard');
  });

  test('BROWSER_CLIENT_BUNDLE_PARTS lists prep, dashboard, rest, and launcher in order', () => {
    const ids = BROWSER_CLIENT_BUNDLE_PARTS.map((p) => p.id);
    assert.deepEqual(ids, ['prep-and-formats', 'dashboard', 'pagination-and-rest', 'launcher', 'command-palette']);
  });

  test('assembled browserClientScript still includes dashboard and shared format helpers', () => {
    const data = '{"sessions":[],"total":0,"stats":{}}';
    const script = browserClientScript(data);
    assert.equal(buildBrowserClientTail(), BROWSER_CLIENT_SCRIPT_TAIL);
    assert.ok(script.includes('function renderDashboard'));
    assert.ok(script.includes('function fmtTokens'));
    assert.ok(!script.includes('prepSessions'));
    assert.ok(script.includes('var compareSet = new Set()'));
  });
});

describe('browser-client-dashboard embed init', () => {
  test('init head wires ALL, SERVER_TOTAL, stats, and live path set from payload', () => {
    const stats = {
      totalSessions: 3,
      totalInputTokens: 100,
      projectCounts: { alpha: 2 },
    };
    const out = runInitHeadVm({
      sessions: [{ id: 'a' }, { id: 'b' }],
      total: 9,
      stats,
      liveSessions: [
        { path: '/live/x', live: true },
        { path: '/live/y', live: true },
        { path: '/live/leak', live: false },
      ],
    });
    assert.equal(out.ALL_len, 2);
    assert.equal(out.SERVER_TOTAL, 9);
    assertVmDeepEqual(out.SERVER_STATS, stats);
    assert.equal(out.livePathSize, 2);
    assert.equal(JSON.stringify(out.livePaths), JSON.stringify(['/live/x', '/live/y']));
  });

  test('QF_STATS is a deep snapshot: mutating SERVER_STATS does not change QF_STATS', () => {
    const out = runInitHeadVm({
      sessions: [],
      total: 2,
      stats: { toolAgg: { Bash: 4 }, gradeDist: { A: 1, B: 0, C: 0, D: 0, F: 0 } },
    });
    out.SERVER_STATS.toolAgg.Read = 99;
    out.SERVER_STATS.gradeDist.A = 0;
    assertVmDeepEqual(out.QF_STATS, { toolAgg: { Bash: 4 }, gradeDist: { A: 1, B: 0, C: 0, D: 0, F: 0 } });
  });

  test('init defaults stats and liveSessions when keys are absent', () => {
    const out = runInitHeadVm({ sessions: [], total: 0 });
    assertVmDeepEqual(out.SERVER_STATS, {});
    assertVmDeepEqual(out.QF_STATS, {});
    assert.equal(out.livePathSize, 0);
  });

  test('embedded init stats align with computeStats-shaped server rollup fields', () => {
    const apiRows = [
      {
        project: 'p1',
        source: 'claude',
        model: 'claude-sonnet',
        totalTokens: 200,
        inputTokens: 120,
        outputTokens: 80,
        cacheReadTokens: 40,
        durationMs: 60000,
        errors: 2,
        files: 3,
        commits: 1,
        chapters: 4,
        tools: ['Bash', 'Read'],
      },
    ];
    const stats = computeStats(apiRows);
    const head = buildBrowserClientScriptHead(
      JSON.stringify({ sessions: apiRows, total: 1, stats }),
    );
    assert.ok(head.includes('"totalInputTokens":120'));
    assert.ok(head.includes('"toolAgg":{"Bash":1,"Read":1}'));
    const wired = vm.runInNewContext(`${head}
SERVER_STATS.totalChapters;`);
    assert.equal(wired, 4);
  });
});

describe('browser-client-dashboard stats refresh contract', () => {
  const script = browserClientScript(INIT_EMPTY);

  test('fetchSessions replaces SERVER_STATS only when API payload includes stats', () => {
    const rest = BROWSER_CLIENT_BUNDLE_PARTS.find((p) => p.id === 'pagination-and-rest').source;
    assert.match(rest, /if \(data\.stats\) SERVER_STATS = data\.stats/);
    assert.doesNotMatch(rest, /QF_STATS\s*=/);
  });

  test('simulated fetch refresh updates SERVER_STATS and live paths but leaves QF_STATS', () => {
    const initialStats = {
      totalSessions: 5,
      totalCost: 1.5,
      modelCounts: { sonnet: 3 },
      gradeDist: { A: 2, B: 1, C: 0, D: 0, F: 0 },
    };
    const out = runFetchPayloadRefreshVm(
      { sessions: [], total: 5, stats: initialStats, liveSessions: [] },
      {
        sessions: [{ id: 'z' }],
        total: 1,
        stats: { totalSessions: 1, totalCost: 9.99, modelCounts: { opus: 1 } },
        liveSessions: [{ path: '/new-live', live: true }, { path: '/leak', live: false }],
      },
    );
    assert.equal(out.SERVER_TOTAL, 1);
    assert.equal(out.SERVER_STATS.totalCost, 9.99);
    assertVmDeepEqual(out.QF_STATS, initialStats);
    assert.equal(JSON.stringify(out.livePaths), JSON.stringify(['/new-live']));
  });

  test('fetch without stats leaves SERVER_STATS from init embed', () => {
    const initialStats = { totalSessions: 4, totalErrors: 7 };
    const out = runFetchPayloadRefreshVm(
      { sessions: [], total: 4, stats: initialStats },
      { sessions: [], total: 2 },
    );
    assert.equal(out.SERVER_TOTAL, 2);
    assertVmDeepEqual(out.SERVER_STATS, initialStats);
    assertVmDeepEqual(out.QF_STATS, initialStats);
  });

  test('renderDashboard hides overview when SERVER_TOTAL is zero', () => {
    const el = runRenderDashboardVm(script, {
      serverTotal: 0,
      serverStats: { totalSessions: 0 },
    });
    assert.equal(el.style.display, 'none');
    assert.equal(el.innerHTML, '');
  });

  test('renderDashboard reads SERVER_STATS totals and filtered scope label', () => {
    const el = runRenderDashboardVm(script, {
      serverTotal: 12,
      serverStats: {
        totalSessions: 12,
        totalInputTokens: 1000,
        totalOutputTokens: 500,
        totalCacheReadTokens: 250,
        totalDurationMs: 120000,
        totalErrors: 3,
        totalCommits: 2,
        totalFiles: 4,
        totalChapters: 6,
        totalCost: 1.23,
        toolAgg: { Bash: 5, Read: 2 },
      },
      filterExpr: 'source:claude',
    });
    assert.equal(el.style.display, '');
    assert.match(el.innerHTML, /12 runs/);
    assert.match(el.innerHTML, /\(filtered\)/);
    assert.match(el.innerHTML, /3<\/span><span class="dashboard-stat-label">errors/);
    assert.match(el.innerHTML, /dashboard-tool-chip[^>]*>Bash/);
  });

  test('renderDashboard reflects SERVER_STATS after simulated API refresh', () => {
    const el = runRenderDashboardVm(script, {
      serverTotal: 2,
      serverStats: { totalSessions: 2, totalErrors: 1, totalCost: 0.5 },
    });
    assert.match(el.innerHTML, /1<\/span><span class="dashboard-stat-label">errors/);

    const refreshed = runRenderDashboardVm(script, {
      serverTotal: 2,
      serverStats: { totalSessions: 2, totalErrors: 9, totalCost: 4.2 },
    });
    assert.doesNotMatch(el.innerHTML, /9<\/span><span class="dashboard-stat-label">errors/);
    assert.match(refreshed.innerHTML, /9<\/span><span class="dashboard-stat-label">errors/);
  });

  test('external live sessions render as the SAME first-class live row runs get, leading to the live chat', () => {
    const html = runExternalLiveRowVm(script, {
      source: 'codex',
      id: 'abc123ef',
      project: 'tracequest',
      model: 'gpt-5-codex',
      prompt: 'Fix <live> gap',
      path: '/tmp/live.jsonl',
      mtime: Date.now() - 60000,
      activity: 'Running npm test',
      live: true,
    });
    // Identical row chrome + the ONE status vocabulary: running.
    assert.match(html, /class="session-row run-row" role="link" tabindex="0" data-live-session="abc123ef" data-run-status="running" data-run-origin="external" data-href="\/run\?session=abc123ef"/);
    assert.match(html, /class="run-state-badge" data-status="running">running</);
    assert.match(html, /<span class="session-source"[^>]*>codex<\/span>/);
    assert.match(html, /<span class="session-id">abc123ef<\/span>/);
    assert.match(html, /<span class="session-project">tracequest<\/span>/);
    assert.match(html, /gpt-5-codex/);
    assert.match(html, /Fix &lt;live&gt; gap/);
    // Origin is honest but subtle — a muted chip, not a second product.
    assert.match(html, /<span class="run-origin"[^>]*>external<\/span>/);
    // IDENTICAL live anatomy: the server-derived activity line with the
    // same pulsing dot a running run row carries.
    assert.match(html, /class="run-activity" data-status="running"/);
    assert.match(html, /run-activity-dot/);
    assert.match(html, /Running npm test/);
    // Only the genuinely impossible control is absent: there is no run
    // window to kill for an externally driven session.
    assert.doesNotMatch(html, /run-dismiss/);
    // The single click target is the read-only live chat, never /view.
    assert.doesNotMatch(html, /\/view\?/);
    assert.match(html, /aria-label="Watch running session abc123ef"/,
      "D1: external row ariaLabel uses running, not live");
    assert.doesNotMatch(html, /Watch live session/,
      "D1: dashboard ariaLabel does not say Watch live session");
    assert.doesNotMatch(html, /Detected live session/,
      "D1: dashboard origin chip title does not say Detected live session");
  });

  test('D1: dashboard external row ariaLabel is Watch running session, not Watch live session', () => {
    const html = runExternalLiveRowVm(script, {
      source: 'codex',
      id: 'abc123ef',
      project: 'tracequest',
      path: '/tmp/live.jsonl',
      live: true,
    });
    assert.match(html, /aria-label="Watch running session abc123ef"/,
      "D1: generating external row ariaLabel is Watch running session");
    assert.doesNotMatch(html, /Watch live session/,
      "D1: dashboard ariaLabel does not say Watch live session");
    assert.match(html, /title="This session was started outside tracequest — its own terminal drives it; open for a watch-only chat"/,
      "D1: origin chip title explains started-outside, not Detected live session");
    assert.doesNotMatch(html, /Detected live session/,
      "D1: dashboard origin chip title does not say Detected live session");
    const idle = runExternalLiveRowVm(script, {
      source: 'codex',
      id: 'idlehash',
      project: 'tracequest',
      path: '/tmp/idle.jsonl',
      live: false,
    });
    assert.match(idle, /aria-label="Watch idle session idlehash"/,
      "D1: idle external row ariaLabel uses idle, not live");
    assert.doesNotMatch(idle, /Watch live session/);
    assert.doesNotMatch(idle, /Detected live session/,
      "D1: idle origin chip title does not say Detected live session");
  });

  test('external live rows carry the full live anatomy: honest fallback activity, grade chip, stat row', () => {
    const html = runExternalLiveRowVm(script, {
      source: 'codex',
      id: 'abc123ef',
      project: 'tracequest',
      model: 'gpt-5-codex',
      prompt: 'Fix the gap',
      path: '/tmp/live.jsonl',
      mtime: Date.now() - 60000,
      activity: null,
      durationMs: 27000,
      chapters: 3,
      totalTokens: 164,
      files: 1,
      errors: 0,
      commits: 1,
      live: true,
    });
    // No activity yet → the same honest "Working…" line a linked run shows.
    assert.match(html, /class="run-activity" data-status="running"/);
    assert.match(html, /Working…/);
    // Grade chip from the same computeGrade path run rows use.
    assert.match(html, /class="session-grade-badge /);
    // Full stat row, not a stripped-down variant.
    assert.match(html, /class="session-stats"/);
    assert.match(html, /3 ch/);
    assert.match(html, /164 tok/);
    assert.match(html, /1 files/);
    assert.match(html, /1 commit/);
  });

  test('runs and external live sessions share ONE row builder — anatomy can never fork by origin', () => {
    // The builder is literally shared: both row functions delegate to
    // liveAgentRowHtml, so the anatomy (badge, chips, activity, stats)
    // exists exactly once.
    const runSrc = extractFunction(script, 'runSessionRowHtml');
    const extSrc = extractFunction(script, 'externalLiveRowHtml');
    assert.match(runSrc, /return liveAgentRowHtml\(\{/);
    assert.match(extSrc, /return liveAgentRowHtml\(\{/);
    assert.doesNotMatch(runSrc, /session-row-wrap|run-state-badge|run-activity/, 'run row builds no anatomy of its own');
    assert.doesNotMatch(extSrc, /session-row-wrap|run-state-badge|run-activity/, 'external row builds no anatomy of its own');
  });

  test('liveNow is the ONE origin-agnostic live count: generating launched runs + external live sessions, deduped by path', () => {
    const runs = [
      { id: '@1', status: 'running', sessionPath: '/tmp/linked.jsonl' },
      { id: '@2', status: 'running', sessionPath: null },
      { id: '@3', status: 'exited', sessionPath: '/tmp/done.jsonl' },
    ];
    const liveSessions = [
      { path: '/tmp/linked.jsonl', live: true },
      { path: '/tmp/external.jsonl', live: true },
    ];
    // @1 (deduped with its own generating recording) + @2 (pending) + external = 3.
    assert.equal(runLiveNowVm(script, { runs, liveSessions }), 3);
    assert.equal(runLiveNowVm(script, { runs: [], liveSessions }), 2);
    assert.equal(runLiveNowVm(script, { runs, liveSessions: [] }), 2,
      'D1: status running is the generating word — no second _liveSessions snapshot required');
    assert.equal(runLiveNowVm(script, {}), 0);
    assert.equal(
      runLiveNowVm(script, {
        runs: [],
        liveSessions: [
          { path: '/tmp/g1-idle.jsonl', live: false },
          { path: '/tmp/g2-gen.jsonl', live: true },
        ],
      }),
      1,
      'live:false leak does not increment liveNow',
    );
    assert.equal(
      runLiveNowVm(script, {
        runs: [{ id: '@idle', status: 'idle', sessionPath: '/tmp/g1-idle.jsonl' }],
        liveSessions: [{ path: '/tmp/g1-idle.jsonl', live: false }],
      }),
      0,
      'idle launched window (status idle, recording settled) does not increment liveNow',
    );
    assert.equal(
      runLiveNowVm(script, {
        runs: [{ id: '@gen', status: 'running', sessionPath: '/tmp/g2-gen.jsonl' }],
        liveSessions: [{ path: '/tmp/g2-gen.jsonl', live: true }],
      }),
      1,
      'generating launched window (tmux running, recording in detectLiveSessions) is 1',
    );
  });

  test('D1: the overview LIVE counter counts launched AND external live agents through liveNow', () => {
    const el = runRenderDashboardVm(script, {
      serverTotal: 3,
      serverStats: { totalSessions: 3 },
      runs: [{ id: '@1', status: 'running', sessionPath: '/tmp/a.jsonl' }],
      liveSessions: [{ path: '/tmp/a.jsonl', live: true }, { path: '/tmp/ext.jsonl', live: true }],
    });
    assert.match(el.innerHTML, />2<\/span><\/span><span class="dashboard-stat-label">running/);
    assert.doesNotMatch(el.innerHTML, /dashboard-stat-label">live/);

    // A pending run (tmux running, no recording yet) still counts — first-token
    // generating. An idle launched window with a settled recording does not.
    const runOnly = runRenderDashboardVm(script, {
      serverTotal: 3,
      serverStats: { totalSessions: 3 },
      runs: [{ id: '@1', status: 'running', sessionPath: null }],
      liveSessions: [],
    });
    assert.match(runOnly.innerHTML, />1<\/span><\/span><span class="dashboard-stat-label">running/);
    assert.doesNotMatch(runOnly.innerHTML, /dashboard-stat-label">live/);

    const idleLaunched = runRenderDashboardVm(script, {
      serverTotal: 3,
      serverStats: { totalSessions: 3 },
      runs: [{ id: '@idle', status: 'idle', sessionPath: '/tmp/g1-idle.jsonl' }],
      liveSessions: [{ path: '/tmp/g1-idle.jsonl', live: false }],
    });
    assert.doesNotMatch(
      idleLaunched.innerHTML,
      /dashboard-stat-label">(?:live|running)/,
      'idle launched window does not paint the overview running stat',
    );

    const none = runRenderDashboardVm(script, {
      serverTotal: 3,
      serverStats: { totalSessions: 3 },
      runs: [{ id: '@9', status: 'exited', sessionPath: '/tmp/x.jsonl' }],
      liveSessions: [],
    });
    assert.doesNotMatch(none.innerHTML, /dashboard-stat-label">(?:live|running)/);

    const leaked = runRenderDashboardVm(script, {
      serverTotal: 3,
      serverStats: { totalSessions: 3 },
      runs: [],
      liveSessions: [{ path: '/tmp/g1-idle.jsonl', live: false }],
    });
    assert.doesNotMatch(
      leaked.innerHTML,
      /dashboard-stat-label">(?:live|running)/,
      'live:false leak does not paint the overview running stat',
    );
  });

  test('externalLiveSessions excludes run-linked recordings and answers [] with no live sessions', () => {
    const runs = [
      { id: '@7', agent: 'claude', cwd: '/x', startedAt: new Date().toISOString(), status: 'running', sessionPath: '/tmp/linked.jsonl' },
    ];
    const liveSessions = [
      { source: 'claude', id: 'linked01', project: 'p', path: '/tmp/linked.jsonl', live: true },
      { source: 'codex', id: 'extern01', project: 'q', path: '/tmp/external.jsonl', live: true },
    ];
    const external = runExternalLiveSessionsVm(script, liveSessions, runs);
    assert.equal(external.length, 1, 'run-linked live session is the run row, never a second live row');
    assert.equal(external[0].id, 'extern01');
    assert.equal(runExternalLiveSessionsVm(script, [], runs).length, 0);
  });

  test('renderRow displays live badge from s.live === true only', () => {
    const base = {
      path: '/tmp/session.jsonl',
      id: 'session-a',
      source: 'claude',
      project: 'tracequest',
      model: 'claude-sonnet',
      mtime: Date.now(),
      sizeKB: 1,
      prompt: 'hello',
      tools: [],
      toolCounts: {},
      errors: 0,
      commits: 0,
      totalTokens: 0,
      durationMs: 0,
      chapters: 0,
      files: 0,
    };

    assert.match(runRenderRowVm(script, { ...base, live: true }), /class="live-indicator">running<\/span>/);
    assert.doesNotMatch(
      runRenderRowVm(script, { ...base, path: '/tmp/live-from-set.jsonl' }, ['/tmp/live-from-set.jsonl']),
      /class="live-indicator">running/,
      '_livePaths membership is not a second RUNNING driver',
    );
    assert.doesNotMatch(runRenderRowVm(script, { ...base, live: false }, []), /class="live-indicator">running/);
  });

  test('D1: list-row RUNNING is the detectLiveSessions bit, not chat-page 4s quiet-window mtime', () => {
    const justFinished = {
      path: '/tmp/idle-completed.jsonl',
      id: 'g1-idle',
      source: 'grok',
      project: 'sample-app',
      model: 'grok',
      mtime: Date.now(),
      sizeKB: 12,
      prompt: 'Send a follow-up',
      tools: [],
      toolCounts: {},
      errors: 0,
      commits: 0,
      totalTokens: 0,
      durationMs: 4000,
      chapters: 1,
      files: 0,
      live: false,
    };
    assert.doesNotMatch(
      runRenderRowVm(script, justFinished, []),
      /class="live-indicator">running/,
      'idle completed turn with mtime inside the 4s quiet window is not a list-row RUNNING badge',
    );
    assert.match(
      runRenderRowVm(script, { ...justFinished, path: '/tmp/g2-gen.jsonl', id: 'g2-gen', live: true }),
      /class="live-indicator">running<\/span>/,
      'G2 generating (live:true) still gets the running badge',
    );
    assert.doesNotMatch(
      runRenderRowVm(script, { ...justFinished, path: '/tmp/cc.jsonl', id: 'cc', source: 'cursor-cloud', live: false }, []),
      /class="live-indicator">running/,
      'cursor-cloud never-live stays not-live on the list row',
    );
    assert.doesNotMatch(
      runExternalLiveRowVm(script, { ...justFinished, live: false, id: 'g1-idle' }),
      /class="run-state-badge" data-status="running">running/,
      'externalLiveRowHtml does not hardcode running when s.live is false',
    );
    assert.match(
      runExternalLiveRowVm(script, { ...justFinished, path: '/tmp/g2-gen.jsonl', id: 'g2-gen', live: true }),
      /class="run-state-badge" data-status="running">running/,
      'G2 generating (live:true) still gets the external run-state-badge',
    );
  });

  test('D1: page-1 render drives live-indicator and run-state-badge from s.live === true', () => {
    const g1 = {
      path: '/tmp/g1-idle.jsonl',
      id: 'g1-idle',
      source: 'grok',
      project: 'sample-app',
      model: 'grok',
      mtime: Date.now(),
      sizeKB: 12,
      prompt: 'Send a follow-up',
      tools: [],
      toolCounts: {},
      errors: 0,
      commits: 0,
      totalTokens: 0,
      durationMs: 4000,
      chapters: 1,
      files: 0,
      live: false,
    };
    const g2 = {
      ...g1,
      path: '/tmp/g2-gen.jsonl',
      id: 'g2-gen',
      prompt: 'generating now',
      live: true,
    };
    const { html, appLive, dashboardHtml, liveN } = runDashboardListHtml(script, {
      sessions: [g1, g2],
      liveSessions: [g2],
    });
    assert.equal(liveN, 1, 'same G1/G2 snapshot: liveNow() is 1');
    assert.match(script, /liveN \+ ' running'/, 'dashboard #appLive prints N running');
    assert.match(script, /dashStat\('<span class="dash-live-n"[^']*>' \+ liveN \+ '<\/span>', 'running'\)/, 'dashboard Overview dashStat label is running');
    assert.doesNotMatch(script, /liveN \+ ' live'/, 'dashboard #appLive does not print N live');
    assert.doesNotMatch(script, /dashStat\('<span class="dash-live-n"[^']*>' \+ liveN \+ '<\/span>', 'live'\)/, 'dashboard Overview dashStat label is not live');
    assert.equal(appLive.hidden, false);
    assert.match(appLive.textContent, /1 running/, 'same snapshot: #appLive is 1 running');
    assert.doesNotMatch(appLive.textContent, /\d+ live\b/, 'same snapshot: #appLive does not say N live');
    assert.match(
      dashboardHtml,
      />1<\/span><\/span><span class="dashboard-stat-label">running/,
      'same snapshot: overview running stat is 1',
    );
    assert.doesNotMatch(dashboardHtml, /dashboard-stat-label">live/, 'same snapshot: overview does not say live');
    assert.match(
      html,
      /data-live-session="g2-gen"[\s\S]*class="run-state-badge" data-status="running">running/,
      'G2 generating is the pinned external row with run-state-badge running',
    );
    assert.doesNotMatch(
      html,
      /data-session-id="g2-gen"[\s\S]*class="live-indicator">running/,
      'G2 is absorbed into the external live row, not an inventory live-indicator',
    );
    assert.match(html, /data-session-id="g1-idle"/, 'G1 idle-open stays an inventory row');
    assert.doesNotMatch(
      html,
      /data-live-session="g1-idle"/,
      'G1 is not promoted to an external live row',
    );
    assert.doesNotMatch(
      html,
      /data-session-id="g1-idle"[\s\S]*class="live-indicator">running/,
      'G1 inventory row has no live-indicator',
    );
    assert.doesNotMatch(
      html,
      /data-session-id="g1-idle"[\s\S]*class="run-state-badge" data-status="running">running/,
      'G1 inventory row has no run-state-badge running',
    );

    const leaked = runDashboardListHtml(script, {
      sessions: [g1],
      liveSessions: [{ ...g1, live: false }],
    });
    assert.doesNotMatch(
      leaked.html,
      /class="run-state-badge" data-status="running">running/,
      'a liveSessions entry with live:false cannot hardcode a running badge',
    );
    assert.doesNotMatch(leaked.html, /class="live-indicator">running/);
    assert.equal(leaked.liveN, 0, 'live:false leak does not increment liveNow');
    assert.equal(leaked.appLive.hidden, true);
    assert.doesNotMatch(leaked.dashboardHtml, /dashboard-stat-label">(?:live|running)/);

    const withExited = runDashboardListHtml(script, {
      sessions: [g1, g2],
      liveSessions: [g2],
      runs: [{
        id: '@done',
        status: 'exited',
        sessionPath: g2.path,
        agent: 'grok',
        cwd: '/tmp/sample-app',
        startedAt: new Date().toISOString(),
        prompt: 'was generating',
      }],
    });
    assert.equal(withExited.liveN, 1, 'exited-run-linked G2: liveNow is 1');
    assert.equal(withExited.appLive.hidden, false);
    assert.match(withExited.appLive.textContent, /1 running/);
    assert.doesNotMatch(withExited.appLive.textContent, /\d+ live\b/);
  });

  test('D1: _livePaths is built only from liveSessions with s.live === true', () => {
    const out = runInitHeadVm({
      sessions: [],
      total: 0,
      liveSessions: [
        { path: '/g2', live: true },
        { path: '/g1-leak', live: false },
        { path: '/no-bit' },
      ],
    });
    assert.equal(JSON.stringify(out.livePaths), JSON.stringify(['/g2']));
    assert.match(
      buildBrowserClientScriptHead('{"liveSessions":[]}'),
      /_livePaths = new Set\(_liveSessions\.filter\(function\(s\)\{return s\.live === true\}\)\.map\(function\(s\)\{return s\.path\}\)\)/,
    );
    assert.match(
      script,
      /_livePaths = new Set\(_liveSessions\.filter\(function\(s\) \{ return s\.live === true; \}\)\.map\(function\(s\) \{ return s\.path; \}\)/,
    );
  });

  test('D1: chat-page quiet-window heuristic is absent from the dashboard client', () => {
    assert.ok(!script.includes('QUIET_MS'), 'QUIET_MS is watch-page chrome, not the list row');
    assert.ok(!script.includes('recordingGrewRecently'), 'growth heuristic must not drive list-row RUNNING');
    assert.ok(!script.includes('deriveWatchLive'), 'watch-page deriveWatchLive must not drive list-row RUNNING');
    assert.match(extractFunction(script, 'renderRow'), /var live = s\.live === true;/);
    assert.doesNotMatch(extractFunction(script, 'renderRow'), /_livePaths\.has/);
    assert.match(extractFunction(script, 'externalLiveRowHtml'), /s\.live === true/);
    assert.doesNotMatch(extractFunction(script, 'externalLiveRowHtml'), /status: 'running'/);
  });

  test('imported host session omits Continue', () => {
    const local = runRenderRowVmWithContinue(script, {
      path: '/tmp/session.jsonl',
      id: 'session-a',
      source: 'claude',
      project: 'tracequest',
      model: 'claude-sonnet',
      mtime: Date.now(),
      sizeKB: 12,
      prompt: 'local session',
      tools: [],
      toolCounts: {},
    });
    assert.match(local, /class="session-continue"/);
    const imported = runRenderRowVmWithContinue(script, {
      path: '/tmp/hosts/gpu/.claude/projects/p/a.jsonl',
      id: 'session-b',
      source: 'claude',
      host: 'gpu',
      project: 'tracequest',
      model: 'claude-sonnet',
      mtime: Date.now(),
      sizeKB: 12,
      prompt: 'imported session',
      tools: [],
      toolCounts: {},
    });
    assert.doesNotMatch(imported, /class="session-continue"/);
  });

  test('runs-home: session rows are table-aligned inventory rows with a primary Run/prompt column', () => {
    const html = runRenderRowVm(script, {
      path: '/tmp/session.jsonl',
      id: 'session-a',
      source: 'claude',
      project: 'tracequest',
      model: 'claude-sonnet',
      mtime: Date.now(),
      sizeKB: 12,
      prompt: 'Document the Runs home inventory',
      tools: ['Read'],
      toolCounts: { Read: 2 },
      errors: 0,
      commits: 0,
      totalTokens: 400,
      durationMs: 5000,
      chapters: 1,
      files: 2,
    });
    assert.match(html, /class="session-row-wrap"/);
    assert.match(html, /class="session-primary"/);
    assert.match(html, /class="session-prompt">Document the Runs home inventory</);
    assert.match(html, /href="\/view\?id=session-a"/);
    assert.match(html, /data-session-id="session-a"/);
    assert.match(html, /data-session-source="claude"/);
    assert.match(html, /class="session-source"/);
    assert.match(html, /class="session-id">session-a</);
    assert.match(html, /class="session-time"/);
    assert.match(html, /class="session-stats"/);
    assert.match(html, /class="session-actions"/);
    assert.doesNotMatch(html, /class="session-top"/);
  });

  test('run rows render launched runs as first-class session-list rows with live state and activity line', () => {
    const running = {
      id: '@7',
      agent: 'claude',
      cwd: '/home/dev/my-project',
      prompt: 'Fix the bug',
      startedAt: new Date(Date.now() - 120000).toISOString(),
      status: 'running',
      sessionPath: '/tmp/linked.jsonl',
      activity: 'Running npm test',
    };
    const liveSessions = [
      { source: 'claude', id: 'linked01', project: 'my-project', model: 'claude-sonnet-4', prompt: 'Fix the bug', path: '/tmp/linked.jsonl', live: true },
    ];
    const html = runRunRowVm(script, running, { liveSessions });
    // One row, one click target: the chat.
    assert.match(html, /class="session-row run-row" role="link" tabindex="0" data-run-id="@7" data-run-status="running" data-href="\/run\?id=%407"/);
    assert.match(html, /class="run-state-badge" data-status="running">running</);
    assert.match(html, /<span class="session-source"[^>]*>claude<\/span>/);
    assert.match(html, /<span class="session-id">linked01<\/span>/, 'linked session id is the row identity');
    assert.match(html, /<span class="session-model">sonnet-4<\/span>/);
    assert.match(html, /my-project/, 'row shows the cwd basename');
    assert.match(html, /Fix the bug/, 'launch prompt renders once');
    // The live "what it's doing now" line.
    assert.match(html, /class="run-activity" data-status="running"/);
    assert.match(html, /run-activity-dot/);
    assert.match(html, /Running npm test/);
    // Kill control on the row itself.
    assert.match(html, /class="run-dismiss"[^>]*data-run-id="@7"/);
    // No second entry vocabulary: no strip row, no chat badge, no view link.
    assert.doesNotMatch(html, /run-chat-badge|live-run-row|\/view\?/);
  });

  test('run rows carry pending and exited states (identity before any recording, outcome after)', () => {
    const pending = runRunRowVm(script, {
      id: '@3',
      agent: 'claude',
      cwd: '/srv/thing',
      prompt: 'do the thing',
      startedAt: new Date().toISOString(),
      status: 'running',
      sessionPath: null,
      activity: null,
    });
    assert.match(pending, /data-run-status="running"/);
    assert.match(pending, /do the thing/, 'pending run still shows its launch prompt');
    assert.match(pending, /Waiting for the agent session/);

    const exited = runRunRowVm(script, {
      id: '@9',
      agent: 'codex',
      cwd: '/srv/other',
      prompt: null,
      startedAt: new Date(Date.now() - 3600000).toISOString(),
      status: 'exited',
      sessionPath: '/tmp/done.jsonl',
      activity: 'Done. Fonts preload in the head.',
    });
    assert.match(exited, /class="run-state-badge" data-status="exited">exited</);
    assert.match(exited, /class="run-activity" data-status="exited"/);
    assert.match(exited, /Done\. Fonts preload in the head\./, 'outcome line without opening the chat');
    assert.doesNotMatch(exited, /run-activity-dot/, 'no pulsing dot after exit');
  });

  test('D1: idle launched run (status idle, recording settled) is not RUNNING; generating launched run is', () => {
    assert.doesNotMatch(
      extractFunction(script, 'runIsLive'),
      /_liveSessions/,
      'D1: runIsLive consumes r.status === running, not a second _liveSessions snapshot',
    );
    const idleRun = {
      id: '@idle',
      agent: 'grok',
      cwd: '/tmp/sample-app',
      prompt: 'Send a follow-up',
      startedAt: new Date().toISOString(),
      status: 'idle',
      sessionPath: '/tmp/g1-idle.jsonl',
      activity: null,
    };
    const genRun = {
      ...idleRun,
      id: '@gen',
      status: 'running',
      prompt: 'generating now',
      sessionPath: '/tmp/g2-gen.jsonl',
      activity: 'Working…',
    };
    const idleHtml = runRunRowVm(script, idleRun, {
      liveSessions: [{ path: '/tmp/g1-idle.jsonl', live: false, id: 'g1-idle', source: 'grok' }],
    });
    assert.match(idleHtml, /data-run-status="idle"/);
    assert.match(idleHtml, /class="run-state-badge" data-status="idle">idle</);
    assert.doesNotMatch(
      idleHtml,
      /class="run-state-badge" data-status="running">running/,
      'idle launched window does not paint run-state-badge running',
    );
    assert.doesNotMatch(idleHtml, /run-activity-dot/, 'idle launched window has no pulsing activity dot');
    assert.match(idleHtml, /Kill run/, 'tmux-alive idle window is still killable');

    const genHtml = runRunRowVm(script, genRun, { liveSessions: [] });
    assert.match(genHtml, /data-run-status="running"/);
    assert.match(genHtml, /class="run-state-badge" data-status="running">running</);
    assert.match(genHtml, /run-activity-dot/);
    assert.match(
      runRunRowVm(script, genRun, { liveSessions: [] }),
      /class="run-state-badge" data-status="running">running/,
      'D1: status running is enough — no matching _liveSessions row required',
    );

    const idleShot = runDashboardListHtml(script, {
      sessions: [{
        path: '/tmp/g1-idle.jsonl',
        id: 'g1-idle',
        source: 'grok',
        project: 'sample-app',
        live: false,
        mtime: Date.now(),
        prompt: 'Send a follow-up',
        tools: [],
        toolCounts: {},
        errors: 0,
        commits: 0,
        totalTokens: 0,
        durationMs: 4000,
        chapters: 1,
        files: 0,
        sizeKB: 12,
        model: 'grok',
      }],
      liveSessions: [{ path: '/tmp/g1-idle.jsonl', live: false, id: 'g1-idle', source: 'grok' }],
      runs: [idleRun],
    });
    assert.equal(idleShot.liveN, 0, 'idle launched: liveNow is 0');
    assert.equal(idleShot.appLive.hidden, true);
    assert.doesNotMatch(idleShot.html, /class="run-state-badge" data-status="running">running/);
    assert.doesNotMatch(idleShot.dashboardHtml, /dashboard-stat-label">(?:live|running)/);

    const genShot = runDashboardListHtml(script, {
      sessions: [{
        path: '/tmp/g2-gen.jsonl',
        id: 'g2-gen',
        source: 'grok',
        project: 'sample-app',
        live: true,
        mtime: Date.now(),
        prompt: 'generating now',
        tools: [],
        toolCounts: {},
        errors: 0,
        commits: 0,
        totalTokens: 0,
        durationMs: 4000,
        chapters: 1,
        files: 0,
        sizeKB: 12,
        model: 'grok',
      }],
      liveSessions: [{ path: '/tmp/g2-gen.jsonl', live: true, id: 'g2-gen', source: 'grok', prompt: 'generating now' }],
      runs: [genRun],
    });
    assert.equal(genShot.liveN, 1, 'generating launched: liveNow is 1');
    assert.equal(genShot.appLive.hidden, false);
    assert.match(genShot.appLive.textContent, /1 running/);
    assert.doesNotMatch(genShot.appLive.textContent, /\d+ live\b/);
    assert.match(genShot.html, /data-run-id="@gen"[\s\S]*class="run-state-badge" data-status="running">running/);
  });

  test('run rows absorb the linked indexed session row (grade + stats, no duplicate object)', () => {
    const indexed = {
      path: '/tmp/linked.jsonl',
      id: 'linked01',
      source: 'claude',
      project: 'tracequest',
      model: 'claude-sonnet-4',
      mtime: Date.now(),
      sizeKB: 12,
      prompt: 'Fix the bug',
      tools: ['Bash'],
      toolCounts: { Bash: 3 },
      errors: 0,
      commits: 1,
      totalTokens: 1000,
      inputTokens: 600,
      outputTokens: 400,
      durationMs: 65000,
      chapters: 2,
      files: 3,
      // /api/sessions rows arrive with the server-computed cost cache.
      _costCache: 0.0129,
    };
    const run = { id: '@4', agent: 'claude', cwd: '/x', prompt: null, startedAt: new Date().toISOString(), status: 'running', sessionPath: '/tmp/linked.jsonl', activity: null };
    const html = runRunRowVm(script, run, { allSessions: [indexed] });
    assert.match(html, /<span class="session-id">linked01<\/span>/);
    assert.match(html, /session-grade-badge/, 'grade badge absorbed from the indexed row');
    assert.match(html, /session-stats/, 'stats line absorbed from the indexed row');
    assert.match(html, /3 files/);
    // render() drops the absorbed session row from the main list.
    const renderSrc = extractFunction(script, 'render');
    assert.match(renderSrc, /filtered = ALL\.filter\(function\(s\) \{ return !_runsBySession\[s\.path\] && !pinnedLivePaths\[s\.path\]; \}\)/);
    assert.match(renderSrc, /runSessionRowHtml/, 'render pins run rows into the session list');
    // renderRow no longer emits a second "chat" entry point.
    assert.doesNotMatch(extractFunction(script, 'renderRow'), /run-chat-badge|_runsBySession/);
  });

  test('render pins external live rows next to run rows with ONE vocabulary — no separate Live strip', () => {
    const renderSrc = extractFunction(script, 'render');
    assert.match(renderSrc, /externalLiveSessions\(\)/, 'render derives external live sessions');
    assert.match(renderSrc, /externalLiveRowHtml\(externalLive\[li\]\)/, 'external live rows render through the same pinned block as runs');
    assert.doesNotMatch(renderSrc, /renderLiveBar/, 'the separate Live strip is gone');
    assert.doesNotMatch(script, /live-bar-header|live-bar-row/, 'no live-strip markup anywhere in the client');
    // Absorption: a pinned external live session never appears twice.
    assert.match(renderSrc, /pinnedLivePaths\[externalLive\[pl\]\.path\] = true/);
  });

  test('run rows polling wiring: fetchRuns hits /api/runs on a 3s interval and on _refreshData', () => {
    const script2 = browserClientScript(INIT_EMPTY);
    assert.ok(script2.includes("fetch('/api/runs')"), 'fetchRuns polls GET /api/runs');
    assert.ok(script2.includes('setInterval(fetchRuns, 3000)'), '~3s cadence');
    assert.match(script2, /_refreshTimer = null;\s*fetchSessions\(function\(\) \{ render\(\); \}, \{ preserveStaleOnError: true \}\);\s*fetchRuns\(\);/, 'fs-watch refresh also refreshes runs');
    assert.ok(script2.includes("fetch('/api/runs/kill'"), 'row kill control POSTs /api/runs/kill');
    assert.match(script2, /r\.id \+ '\|' \+ r\.status \+ '\|' \+ \(r\.sessionPath \|\| ''\) \+ '\|' \+ \(r\.activity \|\| ''\)/, 'poll signature includes the activity line so new activity repaints');
  });
});

describe('browser-client-dashboard filter autocomplete', () => {
  const script = browserClientScript(INIT_EMPTY);

  test('getLastToken captures trailing filter token for partial expressions', () => {
    assertLastToken(runGetLastToken(script, 'project:my-app'), {
      token: 'project:my-app',
      start: 0,
    });
    assertLastToken(runGetLastToken(script, 'source:claude AND'), {
      token: 'AND',
      start: 14,
    });
    assertLastToken(runGetLastToken(script, 'tool:Bash'), {
      token: 'tool:Bash',
      start: 0,
    });
    assert.equal(runGetLastToken(script, 'tool:Bash '), null);
  });

  test('getLastToken keeps quoted values and partial quotes as one trailing token', () => {
    assertLastToken(runGetLastToken(script, 'project:"my app"'), {
      token: 'project:"my app"',
      start: 0,
    });
    assertLastToken(runGetLastToken(script, 'project:"my ap'), {
      token: 'project:"my ap',
      start: 0,
    });
    assertLastToken(runGetLastToken(script, 'source:claude AND project:"my'), {
      token: 'project:"my',
      start: 18,
    });
    assertLastToken(runGetLastToken(script, '"exact phrase"'), {
      token: '"exact phrase"',
      start: 0,
    });
    assertLastToken(runGetLastToken(script, '"exact phr'), {
      token: '"exact phr',
      start: 0,
    });
    assertLastToken(runGetLastToken(script, "project:'my app'"), {
      token: "project:'my app'",
      start: 0,
    });
    assertLastToken(runGetLastToken(script, 'foo AND "bar'), {
      token: '"bar',
      start: 8,
    });
  });

  test('getLastToken treats backslash-escaped spaces in paths as part of the token', () => {
    assertLastToken(runGetLastToken(script, 'project:foo\\ bar'), {
      token: 'project:foo\\ bar',
      start: 0,
    });
    assertLastToken(runGetLastToken(script, 'source:claude AND project:my\\ app'), {
      token: 'project:my\\ app',
      start: 18,
    });
    assertLastToken(runGetLastToken(script, 'C:\\Users\\me\\ session'), {
      token: 'C:\\Users\\me\\ session',
      start: 0,
    });
    assert.equal(runGetLastToken(script, 'project:foo\\ '), null);
  });

  test('getSuggestions lists all filter keys when input has no trailing token', () => {
    const sugs = runGetSuggestions(script, '');
    assert.equal(sugs.length, 9);
    assert.ok(sugs.every((s) => s.isKey && s.insert.endsWith(':')));
    assert.equal(
      JSON.stringify(sugs.map((s) => s.display)),
      JSON.stringify(['project:', 'source:', 'tool:', 'model:', 'grade:', 'errors:', 'size:', 'age:', 'live:']),
    );
  });

  test('getSuggestions matches key prefixes before colon', () => {
    const sugs = runGetSuggestions(script, 'proj');
    assert.ok(sugs.length >= 1);
    assert.ok(sugs.every((s) => s.isKey));
    assert.ok(sugs.some((s) => s.insert === 'project:'));
  });

  test('getSuggestions returns empty for boolean operator prefixes', () => {
    assert.equal(runGetSuggestions(script, 'foo AND').length, 0);
    assert.equal(runGetSuggestions(script, 'x OR').length, 0);
    assert.equal(runGetSuggestions(script, 'NOT').length, 0);
  });

  test('getSuggestions ranks project values by session count descending', () => {
    const sugs = runGetSuggestions(script, 'project:');
    assert.ok(sugs.length >= 2);
    assert.equal(sugs[0].display, 'my-app');
    assert.equal(sugs[0].count, 12);
    assert.ok(sugs[0].count >= sugs[1].count);
  });

  test('getSuggestions offers size presets for size: key', () => {
    const sugs = runGetSuggestions(script, 'size:');
    assert.equal(JSON.stringify(sugs.map((s) => s.display)), JSON.stringify(['>100', '>500', '<50']));
    assert.ok(sugs.every((s) => s.insert.startsWith('size:')));
  });

  test('getSuggestions offers grade, errors, and live value presets', () => {
    const grade = runGetSuggestions(script, 'grade:');
    assert.equal(JSON.stringify(grade.map((s) => s.insert)), JSON.stringify([
      'grade:A', 'grade:B', 'grade:C', 'grade:D', 'grade:F',
    ]));

    const errors = runGetSuggestions(script, 'errors:');
    assert.equal(JSON.stringify(errors.map((s) => s.insert)), JSON.stringify([
      'errors:>0', 'errors:>2', 'errors:<1',
    ]));

    const live = runGetSuggestions(script, 'live:');
    assert.equal(JSON.stringify(live.map((s) => s.insert)), JSON.stringify(['live:true']));
  });

  test('getSuggestions wires replaceLastToken and suggestion DOM helpers in bundle', () => {
    assert.ok(script.includes('function replaceLastToken'));
    assert.ok(script.includes('function acceptSuggestion'));
    assert.ok(script.includes('function renderSuggestions'));
    assert.ok(script.includes('filterInput.addEventListener'));
    assert.doesNotMatch(script, /FILTER_KEYS\s*\n\s*\.filter\(/);
  });
});

describe('browser-client-dashboard filter autocomplete apply (vm)', () => {
  const script = browserClientScript(INIT_EMPTY);

  test('replaceLastToken swaps trailing partial key for full insert', () => {
    assert.equal(runReplaceLastToken(script, 'proj', 'project:'), 'project:');
  });

  test('replaceLastToken keeps expression prefix when replacing token after AND', () => {
    assert.equal(
      runReplaceLastToken(script, 'source:claude AND tool:B', 'tool:Bash'),
      'source:claude AND tool:Bash',
    );
  });

  test('replaceLastToken replaces entire input when trailing whitespace ends the token', () => {
    assert.equal(runReplaceLastToken(script, 'project:my-app ', 'source:codex'), 'source:codex');
  });

  test('replaceLastToken preserves quoted prefix when completing a partial value', () => {
    assert.equal(
      runReplaceLastToken(script, 'project:"my ap', 'project:"my app"'),
      'project:"my app"',
    );
  });

  test('acceptSuggestion on filter key reopens suggestions without committing', () => {
    const out = runAcceptSuggestion(script, {
      initial: 'proj',
      idx: 0,
      currentSugs: [{ isKey: true, insert: 'project:', display: 'project:' }],
    });
    assert.equal(out.value, 'project:');
    assert.equal(out.commitCalls, 0);
    assert.equal(out.closeCalls, 0);
    assert.equal(out.focusCalls, 1);
    assert.equal(out.renderCalls.length, 1);
    assert.ok(out.renderCalls[0].some((s) => s.insert === 'project:my-app'));
  });

  test('acceptSuggestion on value inserts trailing space and commits filter', () => {
    const out = runAcceptSuggestion(script, {
      initial: 'project:my',
      idx: 0,
      currentSugs: [{ isKey: false, insert: 'project:my-app', display: 'my-app' }],
    });
    assert.equal(out.value, 'project:my-app ');
    assert.equal(out.commitCalls, 1);
    assert.equal(out.closeCalls, 1);
    assert.equal(out.focusCalls, 1);
    assert.equal(out.renderCalls.length, 0);
  });

  test('acceptSuggestion ignores out-of-range index', () => {
    const out = runAcceptSuggestion(script, {
      initial: 'tool:Bash',
      idx: 3,
      currentSugs: [{ isKey: false, insert: 'tool:Bash', display: 'Bash' }],
    });
    assert.equal(out.value, 'tool:Bash');
    assert.equal(out.commitCalls, 0);
    assert.equal(out.closeCalls, 0);
    assert.equal(out.focusCalls, 0);
  });

  test('acceptSuggestion negative index is a no-op', () => {
    const out = runAcceptSuggestion(script, {
      initial: 'source:claude',
      idx: -1,
      currentSugs: [{ isKey: true, insert: 'source:', display: 'source:' }],
    });
    assert.equal(out.value, 'source:claude');
    assert.equal(out.commitCalls, 0);
  });
});

describe('browser-client-dashboard live reload hook', () => {
  const script = browserClientScript(INIT_EMPTY);

  test('assembled client exposes window._refreshData for SSE data-update', () => {
    assert.match(script, /window\._refreshData\s*=\s*function\s*\(\)/);
    assert.ok(script.includes('var _refreshTimer = null'));
    assert.ok(script.includes('fetchSessions(function() { render(); })'));
    assert.ok(script.includes('}, 2000)'));
  });

  test('_refreshData debounces while a refresh timer is pending', () => {
    const refreshBlock = script.slice(
      script.indexOf('var _refreshTimer = null'),
      script.indexOf('};', script.indexOf('window._refreshData = function()')) + 2,
    );
    const sandbox = { setTimeout, clearTimeout, fetchCalls: 0 };
    vm.createContext(sandbox);
    vm.runInContext(
      `var window = {};
${refreshBlock}
function fetchSessions() { fetchCalls++; }
function render() {}
_refreshTimer = 1;
window._refreshData();
window._refreshData();`,
      sandbox,
    );
    assert.equal(sandbox.fetchCalls, 0);
  });

  test('withLiveReload script calls window._refreshData on data-update', () => {
    const html = withLiveReload('<html><body></body></html>');
    assert.match(html, /data-update/);
    assert.match(html, /window\._refreshData/);
    assert.match(html, /EventSource\("\/__livereload"\)/);
  });

  test('browser page HTML includes live-reload hook via withLiveReload wrapper', async () => {
    const { browserPage } = await import('../../src/browser/browser-page.js');
    const html = browserPage([], 0, '');
    assert.match(html, /window\._refreshData/);
    assert.match(html, /function renderDashboard/);
  });

  test('fetchSessions refresh path updates live session paths from API payload', () => {
    assert.ok(script.includes('_liveSessions = data.liveSessions || []'));
    assert.match(
      script,
      /_livePaths = new Set\(_liveSessions\.filter\(function\(s\) \{ return s\.live === true/,
      'fetchSessions live-path set is filtered by s.live === true',
    );
    assert.match(
      buildBrowserClientScriptHead('{"liveSessions":[{"path":"/a","live":true}]}'),
      /_livePaths = new Set\(_liveSessions\.filter\(function\(s\)\{return s\.live === true\}/,
    );
  });

  test('assembled client does not reset _liveSessions after _INIT_DATA init', () => {
    const data =
      '{"sessions":[],"total":0,"page":1,"pageSize":50,"stats":{},"liveSessions":[{"path":"/live-a"}]}';
    const assembled = browserClientScript(data);
    assert.equal(
      assembled.indexOf('var _liveSessions = []'),
      -1,
      'prep bundle must not wipe server-embedded liveSessions before first render',
    );
    assert.ok(assembled.includes('var _liveSessions = _INIT_DATA.liveSessions'));
  });

});

describe('browser-client-dashboard session table sort', () => {
  const script = browserClientScript(INIT_EMPTY);

  test('sortSessions delegates to inlined sortSessionList via currentSort', () => {
    const sessions = [
      { mtime: 1, durationMs: 100, totalTokens: 10, errors: 0, files: 0, commits: 0, chapters: 0 },
      { mtime: 3, durationMs: 50, totalTokens: 5, errors: 0, files: 0, commits: 0, chapters: 0 },
      { mtime: 2, durationMs: 200, totalTokens: 1, errors: 0, files: 0, commits: 0, chapters: 0 },
    ];
    const byRecent = runSortSessions(script, 'recent', [...sessions]);
    assert.equal(JSON.stringify(byRecent.map((s) => s.mtime)), JSON.stringify([3, 2, 1]));
    const byDuration = runSortSessions(script, 'duration', [...sessions]);
    assert.equal(JSON.stringify(byDuration.map((s) => s.durationMs)), JSON.stringify([200, 100, 50]));
  });

  test('fetchSessions appends sort query when currentSort is not recent', () => {
    assert.match(script, /if \(currentSort && currentSort !== 'recent'\) params\.set\('sort', currentSort\)/);
  });

  test('sortBar click handler updates currentSort, resets page, and refetches', () => {
    assert.ok(script.includes("document.getElementById('sortBar').addEventListener('click'"));
    assert.match(script, /var sort = btn\.dataset\.sort/);
    assert.match(script, /currentSort = sort[\s\S]*currentPage = 1[\s\S]*fetchSessions\(function\(\) \{ render\(\); \}\)/);
  });

  test('updatePageUrl persists sort in location when not default recent', () => {
    assert.match(script, /if \(currentSort && currentSort !== 'recent'\) params\.set\('sort', currentSort\)/);
    assert.match(script, /else params\.delete\('sort'\)/);
  });

  test('initial URLSearchParams restores active sort button from ?sort=', () => {
    assert.match(script, /var sort = params\.get\('sort'\)/);
    assert.match(script, /\.sort-btn\[data-sort="/);
  });

  test('dashboard top tools table sorts toolAgg by frequency descending', () => {
    assert.match(
      BROWSER_CLIENT_DASHBOARD_JS,
      /toolEntries\.sort\(function\(a, b\) \{ return b\[1\] - a\[1\]; \}\)/,
    );
    assert.ok(BROWSER_CLIENT_DASHBOARD_JS.includes('topTools = toolEntries.slice(0, 10)'));
  });
});

describe('browser-client-dashboard PAGE_SIZE pagination (vm)', () => {
  const script = browserClientScript(INIT_EMPTY);

  test('totalPages is at least 1 when SERVER_TOTAL is zero', () => {
    const { tp } = runPaginationMath(script, { serverTotal: 0 });
    assert.equal(tp, 1);
  });

  test('totalPages ceil-divides SERVER_TOTAL by PAGE_SIZE', () => {
    const { tp } = runPaginationMath(script, { serverTotal: 120, pageSize: 50 });
    assert.equal(tp, 3);
  });

  test('pageStart and pageEnd bound the active slice (page 2, PAGE_SIZE 25)', () => {
    const { start, end } = runPaginationMath(script, {
      serverTotal: 80,
      pageSize: 25,
      currentPage: 2,
    });
    assert.equal(start, 25);
    assert.equal(end, 50);
  });

  test('URL bootstrap restores currentPage and PAGE_SIZE from query string', () => {
    assert.ok(URL_PAGE_BOOTSTRAP, 'dashboard should include page bootstrap IIFE');
    const { currentPage, PAGE_SIZE } = runUrlPaginationBootstrap('?page=3&pageSize=100');
    assert.equal(currentPage, 3);
    assert.equal(PAGE_SIZE, 100);
  });

  test('URL bootstrap ignores pageSize values outside allowed set', () => {
    const { PAGE_SIZE } = runUrlPaginationBootstrap('?pageSize=30');
    assert.equal(PAGE_SIZE, 50);
  });

  test('renderPagination hides controls when only one page exists', () => {
    const el = runRenderPagination(script, { serverTotal: 40, pageSize: 50 });
    assert.ok(el._classes.has('hidden'));
    assert.equal(el.innerHTML, '');
  });

  test('renderPagination shows 1-based range for page 2 of 120 at PAGE_SIZE 50', () => {
    const el = runRenderPagination(script, { serverTotal: 120, pageSize: 50, currentPage: 2 });
    assert.ok(!el._classes.has('hidden'));
    assert.match(el.innerHTML, /<strong>51<\/strong>&ndash;<strong>100<\/strong>/);
    assert.match(el.innerHTML, /of <strong>120<\/strong>/);
  });

  test('renderPagination disables Prev on first page and Next on last page', () => {
    const first = runRenderPagination(script, { serverTotal: 120, pageSize: 50, currentPage: 1 });
    assert.match(first.innerHTML, /data-page="prev"[^>]*disabled/);
    assert.doesNotMatch(first.innerHTML, /data-page="next"[^>]*disabled/);

    const last = runRenderPagination(script, { serverTotal: 120, pageSize: 50, currentPage: 3 });
    assert.doesNotMatch(last.innerHTML, /data-page="prev"[^>]*disabled/);
    assert.match(last.innerHTML, /data-page="next"[^>]*disabled/);
  });

  test('updatePageUrl omits default page and pageSize but keeps non-defaults', () => {
    assert.equal(runUpdatePageUrl(script, { pageSize: 50, currentPage: 1 }), '/');
    assert.equal(
      runUpdatePageUrl(script, { pageSize: 100, currentPage: 2 }),
      '/?page=2&pageSize=100',
    );
    assert.equal(
      runUpdatePageUrl(script, { pageSize: 50, currentPage: 1, peekSession: { id: 'abc123ef', source: 'claude' } }),
      '/?session=abc123ef',
    );
  });

  test('goToPage clamps to valid range and skips fetch when page unchanged', () => {
    const noop = runGoToPage(script, { serverTotal: 120, currentPage: 2, target: 2 });
    assert.equal(noop.fetchCalls, 0);
    assert.equal(noop.currentPage, 2);

    const high = runGoToPage(script, { serverTotal: 120, pageSize: 50, currentPage: 1, target: 99 });
    assert.equal(high.currentPage, 3);
    assert.equal(high.fetchCalls, 1);

    const low = runGoToPage(script, { serverTotal: 120, pageSize: 50, currentPage: 2, target: 0 });
    assert.equal(low.currentPage, 1);
    assert.equal(low.fetchCalls, 1);
  });

  test('fetchSessions query adds page and pageSize when not defaults', () => {
    assert.equal(runFetchSessionsQuery(script, { pageSize: 50, currentPage: 1 }), '');
    assert.equal(
      runFetchSessionsQuery(script, { pageSize: 25, currentPage: 3 }),
      'page=3&pageSize=25',
    );
  });
});

describe('browser-client-dashboard fetch error handling', () => {
  const script = browserClientScript(INIT_EMPTY);

  test('fetchSessions checks response ok before parsing JSON', () => {
    assert.match(script, /if \(!r\.ok\)/);
    assert.match(script, /throw new Error\(msg\)/);
    assert.match(script, /_fetchError = null/);
  });

  test('fetchSessions sets _fetchError and invokes callback on HTTP failure', async () => {
    const ctx = {
      PAGE_SIZE: 50,
      currentPage: 1,
      currentSort: 'recent',
      filterInput: { value: '' },
      ALL: [],
      SERVER_TOTAL: 0,
      SERVER_STATS: {},
      _liveSessions: [],
      _livePaths: new Set(),
      _fetchController: null,
      _fetching: false,
      _fetchError: null,
      _staleRefreshError: null,
      AbortController,
      URLSearchParams,
      callbackFired: false,
      statusUpdates: [],
      fetch() {
        return Promise.resolve({
          ok: false,
          status: 503,
          text: () => Promise.resolve('sidecar unavailable'),
        });
      },
    };
    ctx.setRefreshStatus = (state, message, detail) => {
      ctx.statusUpdates.push({ state, message, detail });
    };
    vm.createContext(ctx);
    vm.runInContext(
      `${extractFunction(script, 'fetchSessions')}
fetchSessions(function() { callbackFired = true; });`,
      ctx,
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(ctx._fetchError, 'HTTP 503: sidecar unavailable');
    assert.equal(ctx._staleRefreshError, null);
    assert.equal(ctx.callbackFired, true);
    assert.equal(ctx._fetching, false);
    assert.deepEqual(ctx.statusUpdates.at(-1), {
      state: 'error',
      message: 'load failed',
      detail: 'HTTP 503: sidecar unavailable',
    });
  });

  test('refresh failure with existing rows keeps stale rows available and marks stale status', async () => {
    const ctx = {
      PAGE_SIZE: 50,
      currentPage: 1,
      currentSort: 'recent',
      filterInput: { value: '' },
      ALL: [{ id: 'old', path: '/old' }],
      SERVER_TOTAL: 1,
      SERVER_STATS: {},
      _liveSessions: [],
      _livePaths: new Set(),
      _fetchController: null,
      _fetching: false,
      _fetchError: null,
      _staleRefreshError: null,
      AbortController,
      URLSearchParams,
      callbackFired: false,
      statusUpdates: [],
      fetch() {
        return Promise.resolve({
          ok: false,
          status: 502,
          text: () => Promise.resolve('index refresh failed'),
        });
      },
      console: { error() {} },
    };
    ctx.setRefreshStatus = (state, message, detail) => {
      ctx.statusUpdates.push({ state, message, detail });
    };
    vm.createContext(ctx);
    vm.runInContext(
      `${extractFunction(script, 'fetchSessions')}
fetchSessions(function() { callbackFired = true; }, { preserveStaleOnError: true });`,
      ctx,
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(ctx._fetchError, null);
    assert.equal(ctx._staleRefreshError, 'HTTP 502: index refresh failed');
    assert.equal(ctx.ALL[0].id, 'old');
    assert.equal(ctx.callbackFired, true);
    assert.equal(ctx._fetching, false);
    assert.deepEqual(ctx.statusUpdates.at(-1), {
      state: 'stale',
      message: 'stale data',
      detail: 'Last refresh failed: HTTP 502: index refresh failed',
    });
  });

  test('render shows fetch-error banner and em dash count when _fetchError is set', () => {
    const sessionsEl = {
      innerHTML: '',
      bannerHtml: '',
      insertAdjacentHTML(_pos, html) {
        this.bannerHtml = html;
      },
      appendChild() {},
    };
    const countEl = { textContent: '12 sessions' };
    const ctx = {
      ALL: [{ id: 'stale' }],
      SERVER_TOTAL: 12,
      filtered: [],
      renderedCount: 0,
      currentPage: 1,
      _runs: [],
      _runsBySession: {},
      _liveSessions: [],
      _fetchError: 'HTTP 500: index build failed',
      sessionsEl,
      sentinel: { style: {} },
      document: {
        getElementById(id) {
          if (id === 'count') return countEl;
          return null;
        },
      },
    };
    vm.createContext(ctx);
    vm.runInContext(
      `${extractFunction(script, 'externalLiveSessions')}
function renderDashboard() {}
function buildQfBar() {}
function renderPagination() {}
function updatePageUrl() {}
function restoreContinueForm() {}
${REST_ESC_H}
${extractFunction(script, 'render')}
render();`,
      ctx,
    );
    assert.match(sessionsEl.bannerHtml, /class="fetch-error"/);
    assert.match(sessionsEl.bannerHtml, /HTTP 500: index build failed/);
    assert.equal(countEl.textContent, '—');
  });

  test('render keeps stale rows visible when refresh failure is tracked outside _fetchError', () => {
    const sessionsEl = {
      innerHTML: '',
      bannerHtml: '',
      appended: false,
      insertAdjacentHTML(_pos, html) {
        this.bannerHtml = html;
      },
      appendChild() {
        this.appended = true;
      },
    };
    const countEl = { textContent: '' };
    const ctx = {
      ALL: [{ id: 'stale' }],
      SERVER_TOTAL: 1,
      filtered: [],
      renderedCount: 0,
      currentPage: 1,
      _runs: [],
      _runsBySession: {},
      _liveSessions: [],
      _fetchError: null,
      _staleRefreshError: 'HTTP 502: index refresh failed',
      sessionsEl,
      sentinel: { style: {} },
      renderedBatch: false,
      document: {
        getElementById(id) {
          if (id === 'count') return countEl;
          return null;
        },
      },
    };
    vm.createContext(ctx);
    vm.runInContext(
      `function renderPageBatch() { renderedBatch = true; }
${extractFunction(script, 'externalLiveSessions')}
function renderDashboard() {}
function buildQfBar() {}
function renderPagination() {}
function updatePageUrl() {}
function restoreContinueForm() {}
${REST_ESC_H}
${extractFunction(script, 'render')}
render();`,
      ctx,
    );
    assert.equal(sessionsEl.bannerHtml, '');
    assert.equal(sessionsEl.appended, true);
    assert.equal(ctx.renderedBatch, true);
    assert.equal(countEl.textContent, '1 run');
  });
});

describe('filters-stats toolbar and applied chips', () => {
  const script = browserClientScript(INIT_EMPTY);

  function runAppliedChips(state) {
    return vm.runInNewContext(
      `var qfState = ${JSON.stringify(state)};
var AGE_OPTIONS = { '': 'All time', '<1d': 'Past 24 hours', '<7d': 'Past 7 days', '<30d': 'Past 30 days' };
${extractFunction(script, 'escH')}
${extractFunction(script, 'ageLabel')}
${extractFunction(script, 'appliedChipHtml')}
${extractFunction(script, 'appliedChipsHtml')}
appliedChipsHtml();`,
    );
  }

  function runSyncFromExpr(expr) {
    return vm.runInNewContext(
      `var filterInput = { value: ${JSON.stringify(expr)} };
var qfState = { grade: null, model: null, source: null, errorsOnly: false, age: null };
${extractFunction(script, 'qfTermFromExpr')}
${extractFunction(script, 'syncQfStateFromExpr')}
syncQfStateFromExpr();
qfState;`,
    );
  }

  function runSetFilterTerm(initial, key, value) {
    const sandbox = { filterInput: { value: initial }, currentFilterExpr: null };
    vm.runInContext(
      `${extractFunction(script, 'setQfFilterTerm')}
setQfFilterTerm(${JSON.stringify(key)}, ${JSON.stringify(value)});`,
      vm.createContext(sandbox),
    );
    return sandbox.filterInput.value;
  }

  test('filters-stats: dashboard collapse keeps .dashboard-stats in the overview strip', () => {
    const el = runRenderDashboardVm(script, {
      serverTotal: 8,
      serverStats: {
        totalSessions: 8,
        totalErrors: 2,
        totalCost: 1.1,
        toolAgg: { Bash: 3 },
      },
    });
    assert.match(el.innerHTML, /class="dashboard-stats"/);
    assert.match(el.innerHTML, /dashboard-stat-label">errors/);
    assert.match(el.className, /dashboard/);
    assert.match(script, /dashboardCollapsed \? 'tools' : 'hide tools'/);
    assert.match(script, /Show tool inventory/);
    assert.match(BROWSER_CLIENT_DASHBOARD_JS, /aria-label="' \+ toggleAria/);
  });

  test('filters-stats applied filter chips: key is value dismissible chips for age/source/grade', () => {
    const html = runAppliedChips({
      age: '<1d',
      source: 'claude',
      grade: 'A',
      model: null,
      errorsOnly: true,
    });
    assert.match(html, /id="appliedChips"/);
    assert.match(html, /class="chip-key">Age</);
    assert.match(html, /class="chip-op">is</);
    assert.match(html, /class="chip-value">Past 24 hours</);
    assert.match(html, /class="chip-key">Source</);
    assert.match(html, /class="chip-value">claude</);
    assert.match(html, /class="chip-key">Grade</);
    assert.match(html, /class="chip-value">A</);
    assert.match(html, /class="chip-key">Errors</);
    assert.match(html, /aria-label="Remove Source filter"/);
    assert.match(html, /Match all filters/);
    assert.equal(runAppliedChips({
      age: null, source: null, grade: null, model: null, errorsOnly: false,
    }), '');
  });

  test('filters-stats time-range control writes age: into the shared filter expression', () => {
    assert.equal(runSetFilterTerm('', 'age', '<1d'), 'age:<1d');
    assert.equal(runSetFilterTerm('source:claude', 'age', '<7d'), 'source:claude age:<7d');
    assert.equal(runSetFilterTerm('source:claude age:<1d', 'age', null), 'source:claude');
    const synced = runSyncFromExpr('project:tracequest age:<30d');
    assert.equal(synced.age, '<30d');
    assert.match(script, /function setAgeFilter/);
    assert.match(script, /setQfFilterTerm\('age'/);
    assert.match(script, /Past 24 hours/);
  });

  test('filters-stats source control writes source: into the shared filter expression', () => {
    assert.equal(runSetFilterTerm('', 'source', 'grok'), 'source:grok');
    assert.equal(runSetFilterTerm('age:<1d', 'source', 'claude'), 'age:<1d source:claude');
    assert.equal(runSetFilterTerm('age:<1d source:grok', 'source', null), 'age:<1d');
    const synced = runSyncFromExpr('source:codex grade:A');
    assert.equal(synced.source, 'codex');
    assert.equal(synced.grade, 'A');
    assert.match(script, /function setSourceFilter/);
    assert.match(script, /setQfFilterTerm\('source'/);
    assert.match(script, /getElementById\('sourceBtn'\)/);
  });
});
