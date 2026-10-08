import '../helpers/skip-lr-watch-env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { browserPageHTML } from '../../src/browser/browser-page-build.js';
import { browserPage } from '../../src/browser/browser-page.js';
import { STANDALONE_BASE_CSS } from '../../src/render/render-css.js';
import { hotModules } from '../../src/server/server-state.js';
import { handleSessions } from '../../src/routes/route-handlers-pages.js';
import { mock } from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD_SRC = readFileSync(join(__dirname, '../../src/browser/browser-page-build.js'), 'utf8');
const STATE_SRC = readFileSync(join(__dirname, '../../src/server/server-state.js'), 'utf8');

const INIT_EMPTY = '{"sessions":[],"total":0,"page":1,"pageSize":50,"stats":{},"liveSessions":[]}';

function shellHtml(filter = '') {
  return browserPageHTML(INIT_EMPTY, filter);
}

describe('browser-page-build HTML shell', () => {
  test('emits valid document skeleton with lang, charset, viewport, title', () => {
    const html = shellHtml();
    assert.match(html, /^<!DOCTYPE html>/);
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<meta charset="utf-8">/);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.match(html, /<title>Runs · tracequest<\/title>/);
    assert.match(html, /<\/html>\s*$/);
  });

  test('single embedded style block between head and body', () => {
    const html = shellHtml();
    assert.equal((html.match(/<style>/g) || []).length, 1);
    assert.equal((html.match(/<\/style>/g) || []).length, 1);
    const headEnd = html.indexOf('</head>');
    const bodyStart = html.indexOf('<body>');
    assert.ok(headEnd > 0 && bodyStart > headEnd);
    assert.ok(html.indexOf('<style>') < headEnd);
    assert.ok(html.indexOf('</style>') < headEnd);
  });

  test('the Runs home wears the shared app bar: wordmark, Runs crumb, live counter', () => {
    const html = shellHtml();
    // Shared chrome (app-chrome.js appTopHtml): one identity across surfaces.
    assert.match(html, /<header class="app-top">[\s\S]*<a class="app-wordmark" href="\/">tracequest<\/a>/);
    assert.match(html, /<span class="app-crumb">Runs<\/span>/,
      'the home crumb names the Runs inventory surface');
    assert.match(html, /<span class="runs-count" id="count"><\/span>/,
      'inventory count sits next to the Runs heading');
    assert.match(html, /<span class="app-live" id="appLive" hidden><\/span>/,
      'the same origin-agnostic live counter the chat app bar shows');
    assert.match(html, /<span class="app-limits" id="appLimits" hidden><\/span>/,
      'usage-limit meters sit next to the live counter');
    assert.match(html, /<div class="refresh-status" id="refreshStatus" aria-live="polite" data-state="idle" hidden><\/div>/);
    // The app bar frames the scrolling list (sticky, outside the container).
    assert.ok(html.indexOf('<header class="app-top">') < html.indexOf('<div class="container runs-home">'));
    assert.match(html, /\.app-top \{ position: sticky; top: 0; z-index: 150; \}/);
  });

  test('main container wraps dashboard, quick filters, sort bar, sessions, pagination', () => {
    const html = shellHtml();
    const containerStart = html.indexOf('<div class="container runs-home">');
    const containerEnd = html.indexOf('</div>\n<div class="compare-bar"');
    assert.ok(containerStart >= 0 && containerEnd > containerStart);
    const container = html.slice(containerStart, containerEnd);
    assert.match(container, /id="dashboard"/);
    assert.match(container, /id="qfBar"/);
    assert.match(container, /id="sortBar"/);
    assert.match(container, /id="sessions"/);
    assert.match(container, /id="pagination"/);
  });

  test('compare bar sits outside container with selection controls', () => {
    const html = shellHtml();
    assert.match(html, /<div class="compare-bar" id="compareBar" role="region" aria-label="Compare selection">/);
    assert.match(html, /id="compareInfo"/);
    assert.match(html, /id="compareInfo" aria-live="polite"/);
    assert.match(html, /id="compareBtn" disabled/);
    assert.match(html, /id="compareClear"/);
    const comparePos = html.indexOf('id="compareBar"');
    const containerClose = html.lastIndexOf('</div>', comparePos);
    assert.ok(comparePos > containerClose, 'compare bar follows main container');
  });

  test('shell contains required DOM ids for browser client', () => {
    const html = shellHtml();
    for (const id of [
      'filterInput', 'filterBar', 'suggestions', 'dashboard', 'qfBar',
      'sortBar', 'sessions', 'pagination', 'compareBar',
      'compareInfo', 'compareBtn', 'compareClear', 'count', 'refreshStatus',
    ]) {
      assert.ok(html.includes(`id="${id}"`), `missing element #${id}`);
    }
    // The separate Live strip is gone — external live sessions render as
    // unified live rows inside #sessions instead (unified-live).
    assert.ok(!html.includes('id="liveBar"'), 'no separate Live strip element');
  });

  test('sort bar exposes all sort modes via data-sort buttons', () => {
    const html = shellHtml();
    for (const sort of ['recent', 'duration', 'cost', 'tokens', 'errors', 'files', 'commits', 'chapters', 'grade']) {
      assert.ok(html.includes(`data-sort="${sort}"`), `missing sort button ${sort}`);
    }
  });

  test('sort buttons expose pressed state for the active sort', () => {
    const html = shellHtml();
    assert.match(html, /class="sort-btn active" data-sort="recent" aria-pressed="true"/);
    assert.match(html, /class="sort-btn" data-sort="duration" aria-pressed="false"/);
  });

  test('status CSS uses shared semantic color tokens', () => {
    const html = shellHtml();
    const styleStart = html.indexOf('<style>') + 7;
    const styleEnd = html.indexOf('</style>');
    const css = html.slice(styleStart, styleEnd);
    assert.match(css, /\.refresh-status\[data-state="stale"\] \{ color: var\(--orange\); \}/);
    assert.match(css, /\.refresh-status\[data-state="error"\] \{ color: var\(--red\); \}/);
    assert.match(css, /\.live-indicator \{[\s\S]*color: var\(--green\);/);
    assert.match(css, /\.fetch-error \{ color: var\(--red\);/);
    assert.match(css, /\.session-stat\.commits \{ color: var\(--green\); \}/);
    assert.match(css, /\.session-badge\.commit-badge \{ color: var\(--green\);/);
  });

  test('run rows are styled as first-class session-list rows (no Agents strip remnants)', () => {
    const html = shellHtml();
    const styleStart = html.indexOf('<style>') + 7;
    const styleEnd = html.indexOf('</style>');
    const css = html.slice(styleStart, styleEnd);
    assert.match(css, /\.session-row\.run-row \{ cursor: pointer; \}/);
    assert.match(css, /\.run-state-badge\[data-status="running"\] \{ color: var\(--green\); \}/);
    assert.match(css, /\.run-activity \{/);
    assert.match(css, /\.run-activity-dot \{/);
    assert.match(css, /\.run-dismiss \{/);
    assert.match(css, /\.run-row-wrap \.runs-col-check \{ width: var\(--runs-check\); \}/,
      'run rows align with checkbox-carrying session rows');
    // The separate run-strip vocabulary is gone for good.
    assert.doesNotMatch(css, /\.live-run-row|\.run-status-pill|\.run-open-chat|run-chat-badge/);
  });

  test('runs-home: / is a Runs inventory, not a landing page or session viewer', () => {
    const html = shellHtml();
    assert.match(html, /<h1 class="runs-title">Runs<\/h1>/);
    assert.match(html, /class="container runs-home"/);
    assert.match(html, /class="runs-inventory"/);
    assert.match(html, /class="runs-table-head"/);
    assert.match(html, /class="runs-col-run">Run</);
    assert.match(html, /class="runs-chrome"/);
    const chromeStart = html.indexOf('class="runs-chrome"');
    const sessionsIdx = html.indexOf('id="sessions"');
    const chrome = html.slice(chromeStart, sessionsIdx);
    assert.match(chrome, /id="filterBar"/);
    assert.match(chrome, /id="dashboard"/);
    assert.match(chrome, /id="qfBar"/);
    assert.match(chrome, /id="sortBar"/);
    assert.ok(html.indexOf('id="usageRow"') < html.indexOf('id="dashboard"'),
      'harness usage row sits above the inventory, outside #dashboard');
    assert.ok(html.indexOf('class="runs-head"') < html.indexOf('id="sessions"'));
    assert.doesNotMatch(html, /id="chapters"|class="chapter-head"/);
  });

  test('session-flyout: Runs shell has a closed RHS #sessionFlyout after the inventory', () => {
    const html = shellHtml();
    assert.match(html, /<aside id="sessionFlyout" class="session-flyout" hidden aria-hidden="true" role="dialog" aria-modal="true" aria-label="Run analytics" tabindex="-1">/);
    assert.match(html, /id="sessionFlyoutTitle"/);
    assert.match(html, /id="sessionFlyoutFrame"/);
    assert.match(html, /id="sessionFlyoutClose"[^>]*aria-label="Close run analytics"/);
    assert.match(html, /id="sessionFlyoutOpen"[^>]*href="\/view"/);
    assert.ok(html.indexOf('id="sessions"') < html.indexOf('id="sessionFlyout"'));
    const styleStart = html.indexOf('<style>') + 7;
    const styleEnd = html.indexOf('</style>');
    const css = html.slice(styleStart, styleEnd);
    assert.match(css, /\.session-flyout \{/);
    assert.match(css, /--session-flyout-width/);
    assert.match(css, /body\.session-peek-open \.container\.runs-home/);
    assert.match(css, /\.session-row-wrap\.is-selected/);
    assert.doesNotMatch(html, /id="chapters"|class="chapter-head"/);
  });
});

describe('filters-stats chrome on the Runs home', () => {
  test('filters-stats: search, time range, source, Filters, and Display compose one #runsToolbar', () => {
    const html = shellHtml();
    const chromeStart = html.indexOf('class="runs-chrome"');
    const sessionsIdx = html.indexOf('id="sessions"');
    const chrome = html.slice(chromeStart, sessionsIdx);
    assert.match(chrome, /id="runsToolbar"/);
    assert.match(chrome, /id="filterBar"/);
    assert.match(chrome, /id="ageBtn"[^>]*aria-label="Time range"/);
    assert.match(chrome, /id="ageMenu"/);
    assert.match(chrome, /Past 24 hours/);
    assert.match(chrome, /id="sourceBtn"[^>]*aria-label="Source"/);
    assert.match(chrome, /id="filtersToggle"[^>]*aria-label="Filters"/);
    assert.match(chrome, /id="displayToggle"[^>]*aria-label="Display"/);
    assert.match(chrome, /id="sortBar"/);
    assert.match(chrome, /id="dashboard"/);
    assert.match(chrome, /id="qfBar"/);
    assert.ok(chrome.indexOf('id="runsToolbar"') < chrome.indexOf('id="dashboard"'));
    assert.ok(chrome.indexOf('id="dashboard"') < chrome.indexOf('id="qfBar"'));
    assert.doesNotMatch(html, /href="\/dashboard"/);
  });

  test('filters-stats: collapsed dashboard CSS hides tools only, not .dashboard-stats', () => {
    const html = shellHtml();
    const styleStart = html.indexOf('<style>') + 7;
    const styleEnd = html.indexOf('</style>');
    const css = html.slice(styleStart, styleEnd);
    assert.match(css, /\.dashboard\.collapsed \.dashboard-tools \{ display: none; \}/);
    assert.doesNotMatch(css, /\.dashboard\.collapsed \.dashboard-stats/);
    assert.match(css, /\.dashboard-stats \{/);
  });
});

describe('browser-page-build filter bar', () => {
  test('filter-wrap nests filter-bar, suggestions, and legend', () => {
    const html = shellHtml();
    const wrapStart = html.indexOf('<div class="filter-wrap">');
    const wrapEnd = html.indexOf('</div>\n  <div class="dashboard"', wrapStart);
    assert.ok(wrapStart >= 0 && wrapEnd > wrapStart);
    const wrap = html.slice(wrapStart, wrapEnd);
    assert.match(wrap, /<div class="filter-bar" id="filterBar">/);
    assert.match(wrap, /<input class="filter-input" id="filterInput"/);
    assert.match(wrap, /<div class="suggestions" id="suggestions" role="listbox" aria-label="Filter suggestions"><\/div>/);
    assert.match(wrap, /<div class="filter-legend">/);
  });

  test('filter input has expression placeholder and is not autofocused', () => {
    const html = shellHtml();
    assert.match(html, /placeholder="Filter — e\.g\. foo AND \(tool:Read OR tool:Edit\)"/);
    assert.match(html, /id="filterInput"[^>]*aria-label="Filter runs"/);
    assert.match(html, /id="filterInput"[^>]*aria-controls="suggestions"/);
    assert.match(html, /id="filterInput"[^>]*aria-autocomplete="list"/);
    assert.doesNotMatch(html, /id="filterInput"[^>]*autofocus/);
    assert.doesNotMatch(html, /\sautofocus[\s>]/);
    assert.match(html, /id="workspaceSearch"/);
  });

  test('embedded CSS defines chip and suggestion autocomplete styling', () => {
    const html = shellHtml();
    const styleStart = html.indexOf('<style>') + 7;
    const styleEnd = html.indexOf('</style>');
    const css = html.slice(styleStart, styleEnd);
    assert.match(css, /\.filter-bar:focus-within/);
    assert.match(css, /\.chip\.negated/);
    assert.match(css, /\.suggestions\.open/);
    assert.match(css, /\.suggestion-item\.hl/);
  });

  test('filter legend documents key prefixes and boolean operators', () => {
    const html = shellHtml();
    assert.match(html, /project:</);
    assert.match(html, /source:</);
    assert.match(html, /host:</);
    assert.match(html, /tool:</);
    assert.match(html, /bare words = AND/);
    assert.match(html, /NOT/);
    assert.match(html, /\(parens\)/);
  });

  test('browserPageHTML splices filterVal into value attribute between head and middle', () => {
    const html = browserPageHTML(INIT_EMPTY, 'proj:demo AND tool:Read');
    assert.match(html, /value="proj:demo AND tool:Read">/);
    assert.doesNotMatch(html, /value="proj:demo AND tool:Read" autofocus>/);
    const middleIdx = BUILD_SRC.indexOf('const HTML_MIDDLE');
    assert.ok(middleIdx > 0, 'HTML_MIDDLE constant exists for split assembly');
  });

  test('browserPageHTML escapes double-quotes in filter value attribute', () => {
    const html = browserPageHTML(INIT_EMPTY, 'foo&quot;bar');
    assert.match(html, /value="foo&quot;bar"/);
    assert.doesNotMatch(html, /value="foo"bar"/);
  });

  test('browserPage pre-fills filter from initialFilter with quote escaping', () => {
    const sessions = [{
      path: '/tmp/a.jsonl', mtime: new Date(), size: 1,
      source: 'claude', project: 'p', file: 'a.jsonl',
    }];
    const index = new Map([[sessions[0].path, { firstPrompt: 'hi', model: '', tools: [] }]]);
    const html = browserPage(sessions, index, 'say "hello"');
    assert.match(html, /value="say &quot;hello&quot;"/);
  });
});

describe('browser-page-build client script injection', () => {
  test('HTML_HEAD embeds standalone base CSS plus page-specific rules', () => {
    const html = shellHtml();
    const styleStart = html.indexOf('<style>') + 7;
    const styleEnd = html.indexOf('</style>');
    const embedded = html.slice(styleStart, styleEnd);
    assert.ok(embedded.includes(STANDALONE_BASE_CSS.slice(0, 80)));
    assert.match(embedded, /\.container\.runs-home \{/);
    assert.doesNotMatch(embedded, /\.container \{ max-width: 720px/);
  });

  test('script block wraps browserClientScript with _INIT_DATA preamble', () => {
    const payload = { sessions: [{ id: 'sess-abc' }], total: 1, page: 1, pageSize: 50, stats: { totalSessions: 1 }, liveSessions: [] };
    const data = JSON.stringify(payload);
    const html = browserPageHTML(data, 'expr');
    const scriptOpen = html.lastIndexOf('<script>');
    const scriptClose = html.lastIndexOf('</script>');
    assert.ok(scriptOpen < scriptClose);
    const scriptBody = html.slice(scriptOpen + 8, scriptClose);
    assert.match(scriptBody, /var _INIT_DATA = /);
    assert.match(scriptBody, /"sess-abc"/);
    assert.match(scriptBody, /function renderDashboard/);
  });

  test('static shell is shared across calls; only filter and init payload vary', () => {
    const filter = 'stable-filter';
    const htmlA = browserPageHTML('{"sessions":[],"total":0}', filter);
    const htmlB = browserPageHTML('{"sessions":[{"id":"z"}],"total":1}', filter);
    const splitA = htmlA.split(filter)[0];
    const splitB = htmlB.split(filter)[0];
    assert.equal(splitA, splitB, 'head through filter value prefix is constant');
    const tailA = htmlA.slice(htmlA.indexOf('</script>'));
    const tailB = htmlB.slice(htmlB.indexOf('</script>'));
    assert.equal(tailA, tailB, 'HTML_TAIL is constant');
  });

});

describe('browser-page-build hotModules wiring', () => {
  test('server-state hotModules reloads browser/browser-page.js', () => {
    assert.match(STATE_SRC, /_hotModuleImporter\.importEntries\(v,/);
    assert.match(STATE_SRC, /"browser\/browser-page\.js"/);
    assert.match(STATE_SRC, /browserPage: bp\.browserPage/);
  });

  test('hotModules() exposes browserPage that renders full index shell', async () => {
    const mods = await hotModules();
    assert.equal(typeof mods.browserPage, 'function');
    const html = mods.browserPage([], new Map(), 'live:true');
    assert.match(html, /id="filterBar"/);
    assert.match(html, /var _INIT_DATA = /);
    assert.match(html, /value="live:true"/);
  });

  test('handleSessions injects hotModules browserPage with filter query param', async () => {
    const mods = await hotModules();
    let status;
    const res = {
      writeHead: mock.fn((s) => { status = s; }),
      end: mock.fn(() => {}),
    };
    await handleSessions({}, res, new URL('http://localhost/sessions?filter=tool:Bash'), mods);
    assert.equal(status, 200);
    const html = res.end.mock.calls[0].arguments[0];
    assert.match(html, /id="filterInput"/);
    assert.match(html, /value="tool:Bash"/);
    assert.match(html, /var _INIT_DATA = /);
  });
});
