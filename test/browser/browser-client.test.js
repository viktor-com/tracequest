import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { Script } from 'node:vm';
import { readFileSync } from 'node:fs';
import { fmtCost } from '../../src/filter/filter-formats.js';
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
import { joinBundleParts } from '../../src/render/join-bundle.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_SRC = readFileSync(join(__dirname, '../../src/browser/browser-client.js'), 'utf8');

const INIT_EMPTY = '{"sessions":[],"total":0,"page":1,"pageSize":50,"stats":{},"liveSessions":[]}';

describe('browser-client BROWSER_CLIENT bundle structure', () => {
  test('BROWSER_CLIENT_BUNDLE_PARTS exposes four named segments with non-empty source', () => {
    assert.equal(BROWSER_CLIENT_BUNDLE_PARTS.length, 5);
    for (const part of BROWSER_CLIENT_BUNDLE_PARTS) {
      assert.ok(part.id, 'each part should have an id');
      assert.ok(typeof part.source === 'string' && part.source.length > 100,
        `segment ${part.id} should carry substantial JS`);
    }
  });

  test('bundle part ids are prep-and-formats, dashboard, pagination-and-rest, launcher', () => {
    assert.deepEqual(
      BROWSER_CLIENT_BUNDLE_PARTS.map((p) => p.id),
      ['prep-and-formats', 'dashboard', 'pagination-and-rest', 'launcher', 'command-palette'],
    );
  });

  test('dashboard segment source is the exported BROWSER_CLIENT_DASHBOARD_JS constant', () => {
    const dashPart = BROWSER_CLIENT_BUNDLE_PARTS.find((p) => p.id === 'dashboard');
    assert.ok(dashPart);
    assert.equal(dashPart.source, BROWSER_CLIENT_DASHBOARD_JS);
  });

  test('buildBrowserClientTail joins parts in order without separators', () => {
    const joined = joinBundleParts(BROWSER_CLIENT_BUNDLE_PARTS, { spaced: false });
    assert.equal(buildBrowserClientTail(), joined);
    assert.equal(BROWSER_CLIENT_SCRIPT_TAIL, joined);
  });

  test('prep segment precedes dashboard which precedes pagination/rest in tail', () => {
    const prep = BROWSER_CLIENT_BUNDLE_PARTS[0].source;
    const dash = BROWSER_CLIENT_BUNDLE_PARTS[1].source;
    const rest = BROWSER_CLIENT_BUNDLE_PARTS[2].source;
    const tail = BROWSER_CLIENT_SCRIPT_TAIL;
    const prepIdx = tail.indexOf(prep.slice(0, 40));
    const dashIdx = tail.indexOf(dash.slice(0, 40));
    const restIdx = tail.indexOf(rest.trim().slice(0, 40));
    assert.ok(prepIdx >= 0 && dashIdx > prepIdx && restIdx > dashIdx,
      'tail should concatenate prep → dashboard → rest');
  });

  test('browser-client.js imports dashboard module instead of inlining renderDashboard', () => {
    assert.match(CLIENT_SRC, /from "\.\/browser-client-dashboard\.js"/);
    assert.doesNotMatch(CLIENT_SRC, /function renderDashboard\(/);
    assert.match(CLIENT_SRC, /BROWSER_CLIENT_DASHBOARD_JS/);
  });

  test('SOURCE_COLORS includes cursor', () => {
    assert.match(CLIENT_SRC, /cursor:\s*'var\(--hue-cursor\)'/);
  });

  test('SOURCE_COLORS includes cursor-cloud', () => {
    // Dedicated colour distinct from cursor's lime (fact cccl).
    assert.match(CLIENT_SRC, /'cursor-cloud':\s*'var\(--hue-cursor-cloud\)'/);
  });

  test('FILTER_KEYS and KEY_COLORS include host', () => {
    assert.match(CLIENT_SRC, /FILTER_KEYS = \[[^\]]*'host'/);
    assert.match(CLIENT_SRC, /host:\s*'var\(--text-2\)'/);
    assert.match(CLIENT_SRC, /sourceChipHtml\(s\.source, s\.host\)/);
    assert.match(CLIENT_SRC, /host \? '@' \+ escH\(host\)/);
  });
});

describe('browser-client browserClientScript compose', () => {
  test('browserClientScript is dynamic head plus static module tail', () => {
    const data = '{"sessions":[{"id":"a","path":"/p"}],"total":1,"stats":{}}';
    const script = browserClientScript(data);
    const head = buildBrowserClientScriptHead(data);
    assert.equal(script, head + BROWSER_CLIENT_SCRIPT_TAIL);
  });

  test('composed script embeds init wiring then static tail', () => {
    const script = browserClientScript(INIT_EMPTY);
    assert.ok(script.startsWith('var _INIT_DATA = '));
    assert.ok(script.includes('var ALL = _INIT_DATA.sessions'));
    assert.ok(script.includes('var SERVER_TOTAL = _INIT_DATA.total'));
    const tailPos = script.indexOf('var _fetchController = null');
    const initPos = script.indexOf('var ALL = _INIT_DATA.sessions');
    assert.ok(tailPos > initPos, 'static tail should follow init head');
    assert.ok(!script.includes('prepSessions'));
  });

  test('prep-and-formats has no dead session lowercasing caches', () => {
    const prep = BROWSER_CLIENT_BUNDLE_PARTS.find((p) => p.id === 'prep-and-formats').source;
    assert.ok(!prep.includes('_sourceLower'));
    assert.ok(!prep.includes('_toolsLower'));
    assert.ok(!prep.includes('_qfHaystack'));
    assert.ok(!prep.includes('_promptLower'));
    assert.ok(!prep.includes('_projectLower'));
    assert.ok(!prep.includes('prepSessions'));
  });

  test('prep-and-formats inlines fmtCost with VM outputs matching filter-formats.js', () => {
    const prep = BROWSER_CLIENT_BUNDLE_PARTS.find((p) => p.id === 'prep-and-formats').source;
    const fmtCostStart = prep.indexOf('function fmtCost');
    const fmtPctStart = prep.indexOf('function fmtPct');
    assert.ok(fmtCostStart >= 0 && fmtPctStart > fmtCostStart, 'prep should contain fmtCost before fmtPct');
    const fmtCostSrc = prep.slice(fmtCostStart, fmtPctStart).trim();
    assert.ok(!fmtCostSrc.startsWith('export '), 'inlined fmtCost must not retain export');

    const VM_CTX = { Object, Math, Number };
    const vmOut = new Script(`${fmtCostSrc};
({
  defaultCost: fmtCost(0.0123),
  belowMin: fmtCost(0.005),
  dashboardZero: fmtCost(0, { prefix: '$', zeroLabel: '$0' }),
  dashSmall: fmtCost(0.005, { prefix: '$', zeroLabel: '$0' }),
  nullCost: fmtCost(null, { zeroLabel: 'n/a' }),
  atMin: fmtCost(0.01),
});`).runInNewContext(VM_CTX);

    assert.equal(vmOut.defaultCost, fmtCost(0.0123));
    assert.equal(vmOut.belowMin, fmtCost(0.005));
    assert.equal(vmOut.dashboardZero, fmtCost(0, { prefix: '$', zeroLabel: '$0' }));
    assert.equal(vmOut.dashSmall, fmtCost(0.005, { prefix: '$', zeroLabel: '$0' }));
    assert.equal(vmOut.nullCost, fmtCost(null, { zeroLabel: 'n/a' }));
    assert.equal(vmOut.atMin, fmtCost(0.01));
    assert.ok(prep.includes('var FILTER_KEYS'));
    assert.ok(prep.includes('var compareSet = new Set()'));
  });

  test('pagination-and-rest segment owns fetch/render pipeline and calls renderDashboard', () => {
    const rest = BROWSER_CLIENT_BUNDLE_PARTS.find((p) => p.id === 'pagination-and-rest').source;
    assert.match(rest, /function fetchSessions\(/);
    assert.match(rest, /function render\(\)/);
    assert.match(rest, /renderDashboard\(\)/);
    assert.match(rest, /function totalPages\(/);
    assert.match(rest, /\/api\/sessions\?/);
  });

  test('pagination-and-rest exposes accessibility state for dynamic browser controls', () => {
    const rest = BROWSER_CLIENT_BUNDLE_PARTS.find((p) => p.id === 'pagination-and-rest').source;
    assert.ok(rest.includes('aria-label="Previous page"'));
    assert.ok(rest.includes('aria-current="page"'));
    assert.ok(rest.includes('role="option" aria-selected="false"'));
    assert.ok(rest.includes('aria-label="Select run '));
    assert.ok(rest.includes('aria-pressed="false"'));
    assert.ok(rest.includes("setAttribute('aria-pressed', 'true')"));
  });

  test('pagination-and-rest uses indexOfLower for suggestion value match (includesLower convention)', () => {
    const rest = BROWSER_CLIENT_BUNDLE_PARTS.find((p) => p.id === 'pagination-and-rest').source;
    assert.ok(rest.includes('function indexOfLower'));
    assert.ok(rest.includes('indexOfLower(val, partial)'));
    assert.ok(!rest.includes('val.toLowerCase().indexOf(partial)'));
  });

  test('session-flyout: client intercepts session rows, loads /view?embed=1, and restores ?session=', () => {
    const rest = BROWSER_CLIENT_BUNDLE_PARTS.find((p) => p.id === 'pagination-and-rest').source;
    assert.match(rest, /function openSessionFlyout\(/);
    assert.match(rest, /function closeSessionFlyout\(/);
    assert.match(rest, /function restoreSessionFlyoutFromUrl\(/);
    assert.match(rest, /a\.session-row/);
    assert.match(rest, /embed=1/);
    assert.match(rest, /params\.set\('session'/);
    assert.match(rest, /classList\.add\('is-selected'\)/);
  });
});

function compareSelectionBlockFromBundle() {
  const rest = BROWSER_CLIENT_BUNDLE_PARTS.find((p) => p.id === 'pagination-and-rest').source;
  const start = rest.indexOf('function findSessionByPath(path) {');
  const end = rest.indexOf("sessionsEl.addEventListener('change'", start);
  assert.ok(start >= 0, 'compare selection helpers should exist');
  assert.ok(end > start, 'compare selection helper block should end before event wiring');
  return rest.slice(start, end);
}

function runCompareSelectionVm({ sessions, selectedPaths }) {
  const classes = new Set();
  const context = {
    ALL: sessions,
    compareSet: new Set(selectedPaths),
    compareBarEl: {
      classList: {
        add(name) { classes.add(name); },
        remove(name) { classes.delete(name); },
        contains(name) { return classes.has(name); },
      },
    },
    compareInfoEl: { innerHTML: '' },
    compareBtnEl: { disabled: false },
    escH(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },
  };
  return vm.runInNewContext(`${compareSelectionBlockFromBundle()}
updateCompareBar();
({
  buttonDisabled: compareBtnEl.disabled,
  info: compareInfoEl.innerHTML,
  visible: compareBarEl.classList.contains('visible'),
});`, context);
}

describe('browser-client compare selection state', () => {
  test('compare selection enables compare only when both selected handles resolve', () => {
    const out = runCompareSelectionVm({
      sessions: [
        { id: 'session-a', path: '/tmp/a.jsonl' },
        { id: 'session-b', path: '/tmp/b.jsonl' },
      ],
      selectedPaths: ['/tmp/a.jsonl', '/tmp/b.jsonl'],
    });

    assert.equal(out.visible, true);
    assert.equal(out.buttonDisabled, false);
    assert.match(out.info, /session-a/);
    assert.match(out.info, /session-b/);
  });

  test('compare selection stays disabled when a selected handle is outside the current result set', () => {
    const out = runCompareSelectionVm({
      sessions: [
        { id: 'session-a', path: '/tmp/a.jsonl' },
      ],
      selectedPaths: ['/tmp/a.jsonl', '/tmp/old-page.jsonl'],
    });

    assert.equal(out.visible, true, 'compare bar should remain available for clearing');
    assert.equal(out.buttonDisabled, true);
    assert.equal(out.info, '2 selected — clear and reselect visible runs');
  });
});

describe('browser-client dashboard script in composed output', () => {
  const script = browserClientScript(INIT_EMPTY);

  test('assembled client includes renderDashboard exactly once', () => {
    const matches = script.match(/function renderDashboard/g) || [];
    assert.equal(matches.length, 1);
  });

  test('dashboard segment provides PAGE_SIZE, URL bootstrap, and overview renderer', () => {
    assert.ok(BROWSER_CLIENT_DASHBOARD_JS.includes('var PAGE_SIZE = 50'));
    assert.ok(BROWSER_CLIENT_DASHBOARD_JS.includes("params.get('pageSize')"));
    assert.ok(BROWSER_CLIENT_DASHBOARD_JS.includes('function renderDashboard'));
    assert.ok(BROWSER_CLIENT_DASHBOARD_JS.includes('dashboard-tools-title'));
    assert.ok(script.includes('var dashboardEl = document.getElementById(\'dashboard\')'));
  });

  test('full script wires dashboard collapse toggle and growth badges', () => {
    assert.ok(script.includes('dashboardCollapsed'));
    assert.ok(script.includes('id="dashToggle"') || script.includes("getElementById('dashToggle')"));
    assert.ok(script.includes('aria-expanded'));
    assert.ok(script.includes('growthBadge'));
    assert.ok(script.includes('fmtPct(Math.abs(pct))'));
  });

  test('render() pins live rows into the session list, then dashboard, then qf bar', () => {
    const renderBlock = script.match(/function render\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(renderBlock, 'render() should exist');
    const livePos = renderBlock.indexOf('externalLiveRowHtml');
    const dashPos = renderBlock.lastIndexOf('renderDashboard()');
    const qfPos = renderBlock.lastIndexOf('buildQfBar()');
    assert.ok(livePos >= 0 && dashPos > livePos && qfPos > dashPos,
      'render should pin unified live rows, then dashboard, then quick filters');
    assert.ok(!renderBlock.includes('renderLiveBar'), 'no separate Live strip render');
  });
});

function getLastTokenFromScript(script, text) {
  const block = script.match(/function getLastToken\(text\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(block, 'getLastToken should exist in client script');
  return vm.runInNewContext(`${block}; getLastToken(${JSON.stringify(text)});`);
}

function assertLastToken(actual, expected) {
  if (expected === null) {
    assert.equal(actual, null);
    return;
  }
  assert.equal(actual.token, expected.token);
  assert.equal(actual.start, expected.start);
}

describe('browser-client getLastToken filter autocomplete', () => {
  test('captures trailing non-whitespace token for partial filter expressions', () => {
    const script = browserClientScript('{"sessions":[],"total":0,"stats":{}}');
    assertLastToken(getLastTokenFromScript(script, 'project:my-app'), {
      token: 'project:my-app',
      start: 0,
    });
    assertLastToken(getLastTokenFromScript(script, 'source:claude AND'), {
      token: 'AND',
      start: 14,
    });
    assertLastToken(getLastTokenFromScript(script, 'tool:Bash'), {
      token: 'tool:Bash',
      start: 0,
    });
  });

  test('returns null when input ends with whitespace (no token to complete)', () => {
    const script = browserClientScript('{"sessions":[],"total":0,"stats":{}}');
    assert.equal(getLastTokenFromScript(script, 'project:foo '), null);
  });
});

describe('browser-client browserClientScript head/tail composition', () => {
  test('browserClientScript embeds init payload and static client tail', () => {
    const data = '{"sessions":[{"id":"abc","path":"/p/a"}],"total":1,"page":1,"pageSize":50,"stats":{}}';
    const script = browserClientScript(data);
    assert.ok(script.includes(`var _INIT_DATA = ${data}`), 'should embed provided init JSON');
    assert.ok(script.includes('var ALL = _INIT_DATA.sessions'), 'should wire sessions from init');
    assert.ok(!script.includes('prepSessions'), 'should not include removed prepSessions stub');
    assert.ok(script.includes('function fmtMcpName'), 'should include shared fmtMcpName from filter-formats.js');
    assert.ok(script.includes('function fmtTokens'), 'should include shared fmtTokens from filter-formats.js');
    assert.ok(script.includes('function formatDuration'), 'should include shared formatDuration from filter-formats.js');
    assert.ok(script.includes('function fmtPct'), 'should include shared fmtPct from filter-formats.js');
    assert.ok(script.includes('fmtPct(Math.abs(pct))'), 'growthBadge should format deltas via fmtPct');
    assert.ok(!script.includes('Math.abs(Math.round(pct))'), 'should not duplicate pct formatting in growthBadge');
    assert.ok(script.includes('function getToolClr'), 'should include tail UI helpers');
    assert.ok(script.includes('var compareSet = new Set()'), 'should include tail compare state');
  });

  test('varying init data changes only the head; tail bytes are shared', () => {
    const tailAnchor = 'var _fetchController = null';
    const s1 = browserClientScript('{"sessions":[],"total":0,"stats":{}}');
    const s2 = browserClientScript('{"sessions":[{"id":"x"}],"total":1,"stats":{"totalSessions":1}}');
    const head1 = s1.slice(0, s1.indexOf(tailAnchor));
    const head2 = s2.slice(0, s2.indexOf(tailAnchor));
    assert.notEqual(head1, head2, 'init head should differ with different data');
    assert.equal(s1.slice(s1.indexOf(tailAnchor)), s2.slice(s2.indexOf(tailAnchor)),
      'tail after init head should be identical across calls');
  });

});
