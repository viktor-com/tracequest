import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { UI_ERRORS_JS } from '../../src/render/render-ui-errors.js';
import { renderHTML } from '../../src/render.js';
import { fmtMcpName } from '../../src/filter/filter-formats.js';

const FMT_MCP_NAME_SRC = fmtMcpName.toString().replace(/^export /, '');

const H_HELPER_SRC = `
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) Object.entries(attrs).forEach(([k, v]) => {
      if (k === 'className') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v);
    });
    children.flat().forEach(c => {
      if (c == null) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }
`;

function createMockDocument() {
  function makeNode(tag, text) {
    const node = {
      tagName: text ? '#TEXT' : (tag || '').toUpperCase(),
      className: '',
      style: {},
      childNodes: [],
      attributes: {},
      parentNode: null,
      nodeValue: text,
      _clickHandler: null,
      get textContent() {
        if (text != null) return String(text);
        return this.childNodes.map((c) => c.textContent).join('');
      },
      appendChild(child) {
        this.childNodes.push(child);
        child.parentNode = this;
        return child;
      },
      addEventListener(type, fn) {
        if (type === 'click') this._clickHandler = fn;
      },
      setAttribute(k, v) {
        this.attributes[k] = v;
      },
    };
    if (text != null) return node;
    node.classList = {
      _owner: node,
      add(cls) {
        const parts = new Set(this._owner.className.split(/\s+/).filter(Boolean));
        parts.add(cls);
        this._owner.className = [...parts].join(' ');
      },
    };
    return node;
  }
  return {
    createElement(tag) {
      return makeNode(tag);
    },
    createTextNode(text) {
      return makeNode(null, text);
    },
  };
}

function collectClassNames(node, out = []) {
  if (!node) return out;
  if (node.className) {
    for (const c of node.className.split(/\s+/)) {
      if (c) out.push(c);
    }
  }
  for (const ch of node.childNodes || []) collectClassNames(ch, out);
  return out;
}

function findByClass(node, cls) {
  if (!node) return [];
  const hits = [];
  if (node.className && node.className.split(/\s+/).includes(cls)) hits.push(node);
  for (const ch of node.childNodes || []) hits.push(...findByClass(ch, cls));
  return hits;
}

function runErrorVm(body, sandbox = {}) {
  const document = createMockDocument();
  const script = new Script(`
    ${FMT_MCP_NAME_SRC}
    ${H_HELPER_SRC}
    function getChapters() { return chapters; }
    function jumpToChapter(idx) { jumpTarget = idx; }
    ${UI_ERRORS_JS}
    ${body}
  `);
  const ctx = {
    chapters: [],
    document,
    Object,
    Array,
    String,
    Set,
    Math,
    jumpTarget: null,
    __result: undefined,
    ...sandbox,
  };
  script.runInNewContext(ctx);
  return ctx;
}

function renderSummary(chapters) {
  const ctx = runErrorVm('__result = renderErrorSummary();', { chapters });
  return ctx.__result;
}

describe('render-ui-errors VM', () => {
  test('renderErrorSummary aggregates tool errors via for-in in VM', () => {
    const wrap = renderSummary([
      { errors: 1, errorTools: { Alpha: 1 } },
      { errors: 5, errorTools: { Zulu: 5, Bravo: 3 } },
    ]);
    const chips = findByClass(wrap, 'error-tool-chip');
    assert.equal(chips.map((c) => c.textContent).join(','), 'Zulu 5,Bravo 3,Alpha 1');
    const ctx = runErrorVm('__result = typeof renderErrorSummary;');
    assert.equal(ctx.__result, 'function');
  });

  test('renderErrorSummary returns bare div when every chapter has zero errors', () => {
    const el = renderSummary([
      { errors: 0, errorTools: {} },
      { errors: 0, errorTools: {} },
    ]);
    assert.equal(el.tagName, 'DIV');
    assert.equal(el.className, '');
    assert.equal(el.childNodes.length, 0);
  });

  test('header uses singular copy for one error in one chapter', () => {
    const wrap = renderSummary([{ errors: 1, errorTools: { Read: 1 } }]);
    const countLine = findByClass(wrap, 'error-summary-count')[0];
    assert.ok(countLine);
    assert.equal(countLine.textContent, '1 error across 1 chapter');
  });

  test('header pluralizes errors and chapters in the count line', () => {
    const wrap = renderSummary([
      { errors: 2, errorTools: { Bash: 2 } },
      { errors: 1, errorTools: { Read: 1 } },
    ]);
    assert.equal(wrap.textContent.includes('3 errors across 2 chapters'), true);
  });

  test('toolErrors aggregates counts for the same tool across chapters', () => {
    const wrap = renderSummary([
      { errors: 1, errorTools: { Bash: 2 } },
      { errors: 2, errorTools: { Bash: 1, Grep: 2 } },
    ]);
    assert.ok(wrap.textContent.includes('Bash 3'));
    assert.ok(wrap.textContent.includes('Grep 2'));
  });

  test('tool chips are sorted by descending error count', () => {
    const wrap = renderSummary([
      { errors: 1, errorTools: { Alpha: 1 } },
      { errors: 5, errorTools: { Zulu: 5, Bravo: 3 } },
    ]);
    const chips = findByClass(wrap, 'error-tool-chip');
    assert.equal(chips.length, 3);
    const labels = chips.map((c) => c.textContent);
    assert.deepEqual(labels, ['Zulu 5', 'Bravo 3', 'Alpha 1']);
  });

  test('tool chip list is capped at six tools even when more exist', () => {
    const errorTools = {};
    for (let i = 0; i < 9; i++) errorTools['Tool' + i] = 9 - i;
    const wrap = renderSummary([{ errors: 45, errorTools }]);
    assert.equal(findByClass(wrap, 'error-tool-chip').length, 6);
    assert.ok(wrap.textContent.includes('Tool0 9'));
    assert.ok(!wrap.textContent.includes('Tool8'));
  });

  test('MCP tool names pass through fmtMcpName on chips', () => {
    const wrap = renderSummary([
      { errors: 2, errorTools: { mcp__my_server__do_thing: 2 } },
    ]);
    assert.ok(wrap.textContent.includes('my server: do thing 2'));
  });

  test('isolated single error chapter does not produce a streak badge', () => {
    const wrap = renderSummary([
      { errors: 0, errorTools: {} },
      { errors: 1, errorTools: { Bash: 1 } },
      { errors: 0, errorTools: {} },
    ]);
    assert.equal(findByClass(wrap, 'error-streak-badge').length, 0);
    const classes = collectClassNames(wrap);
    assert.ok(classes.includes('has-error'));
    assert.ok(!classes.includes('streak'));
  });

  test('two consecutive error chapters produce one streak badge', () => {
    const wrap = renderSummary([
      { errors: 1, errorTools: { Bash: 1 } },
      { errors: 1, errorTools: { Bash: 1 } },
      { errors: 0, errorTools: {} },
    ]);
    assert.equal(wrap.textContent.includes('streak: ch 1-2 (2 chapters)'), true);
    const badges = findByClass(wrap, 'error-streak-badge');
    assert.equal(badges.length, 1);
    assert.equal(badges[0].tagName, 'BUTTON');
    assert.equal(badges[0].attributes.type, 'button');
    assert.equal(badges[0].attributes['aria-label'], 'Jump to error streak from chapter 1 to chapter 2');
  });

  test('error streak running through the final chapter is still detected', () => {
    const wrap = renderSummary([
      { errors: 0, errorTools: {} },
      { errors: 1, errorTools: { Read: 1 } },
      { errors: 2, errorTools: { Read: 2 } },
      { errors: 1, errorTools: { Bash: 1 } },
    ]);
    assert.equal(wrap.textContent.includes('streak: ch 2-4 (3 chapters)'), true);
  });

  test('multiple disjoint streaks each get their own badge', () => {
    const wrap = renderSummary([
      { errors: 1, errorTools: { A: 1 } },
      { errors: 1, errorTools: { A: 1 } },
      { errors: 0, errorTools: {} },
      { errors: 2, errorTools: { B: 2 } },
      { errors: 1, errorTools: { B: 1 } },
    ]);
    const badges = findByClass(wrap, 'error-streak-badge');
    assert.equal(badges.length, 2);
    assert.ok(wrap.textContent.includes('streak: ch 1-2 (2 chapters)'));
    assert.ok(wrap.textContent.includes('streak: ch 4-5 (2 chapters)'));
  });

  test('timeline renders one dot per chapter with has-error and no-error classes', () => {
    const wrap = renderSummary([
      { errors: 0, errorTools: {} },
      { errors: 2, errorTools: { Bash: 2 } },
      { errors: 0, errorTools: {} },
    ]);
    const dots = findByClass(wrap, 'error-dot');
    assert.equal(dots.length, 3);
    assert.equal(dots[0].className, 'error-dot no-error');
    assert.equal(dots[1].className, 'error-dot has-error');
    assert.equal(dots[2].className, 'error-dot no-error');
    assert.ok(dots.every((dot) => dot.tagName === 'BUTTON'));
    assert.ok(dots.every((dot) => dot.attributes.type === 'button'));
    assert.equal(dots[0].attributes['aria-label'], 'Jump to chapter 1 with no errors');
    assert.equal(dots[1].attributes['aria-label'], 'Jump to chapter 2 with 2 errors');
  });

  test('dots inside a streak use the streak class instead of has-error alone', () => {
    const wrap = renderSummary([
      { errors: 1, errorTools: { Bash: 1 } },
      { errors: 1, errorTools: { Bash: 1 } },
    ]);
    const dots = findByClass(wrap, 'error-dot');
    assert.equal(dots[0].className, 'error-dot streak');
    assert.equal(dots[1].className, 'error-dot streak');
  });

  test('multi-error dots scale size up to 14px and single-error dots stay default', () => {
    const wrap = renderSummary([
      { errors: 1, errorTools: { A: 1 } },
      { errors: 10, errorTools: { B: 10 } },
    ]);
    const dots = findByClass(wrap, 'error-dot');
    assert.equal(dots[0].style.width, undefined);
    assert.equal(dots[1].style.width, '14px');
    assert.equal(dots[1].style.height, '14px');
  });

  test('timeline dot title uses singular error copy for one failure', () => {
    const wrap = renderSummary([{ errors: 1, errorTools: { Read: 1 } }]);
    const dot = findByClass(wrap, 'error-dot')[0];
    assert.equal(dot.attributes.title, 'Ch 1: 1 error');
  });

  test('streak badge click jumps to the streak start chapter', () => {
    const chapters = [
      { errors: 0, errorTools: {} },
      { errors: 1, errorTools: { Bash: 1 } },
      { errors: 1, errorTools: { Bash: 1 } },
    ];
    const ctx = runErrorVm(`
      const wrap = renderErrorSummary();
      const badge = (function find(node) {
        if (node.className && node.className.includes('error-streak-badge')) return node;
        for (const ch of node.childNodes) {
          const f = find(ch);
          if (f) return f;
        }
        return null;
      })(wrap);
      badge._clickHandler({ stopPropagation() {} });
    `, { chapters });
    assert.equal(ctx.jumpTarget, 1);
  });

  test('timeline dot click jumps to that chapter index', () => {
    const chapters = [
      { errors: 0, errorTools: {} },
      { errors: 3, errorTools: { Grep: 3 } },
    ];
    const ctx = runErrorVm(`
      const wrap = renderErrorSummary();
      const dots = (function collect(node, out) {
        if (node.className && node.className.split(/\\s+/).includes('error-dot')) out.push(node);
        for (const ch of node.childNodes) collect(ch, out);
        return out;
      })(wrap, []);
      dots[1]._clickHandler({ stopPropagation() {} });
    `, { chapters });
    assert.equal(ctx.jumpTarget, 1);
  });

  test('renderHTML viewer bundle renders error summary for failing chapters', () => {
    const html = renderHTML({
      sessionId: 'errors-vm',
      source: 'claude',
      cwd: '/tmp',
      model: 'claude-3-5-sonnet',
      startTime: '2026-01-01T00:00:00.000Z',
      endTime: '2026-01-01T00:01:00.000Z',
      durationMs: 60000,
      eventCount: 2,
      events: [
        { type: 'user', text: 'ping', timestamp: '2026-01-01T00:00:00.000Z' },
        { type: 'tool_error', tool: 'Bash', text: 'fail', timestamp: '2026-01-01T00:00:30.000Z' },
      ],
      stats: {
        toolCounts: { Bash: 1 },
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheHit: 0,
        errors: 1,
        userMessages: 1,
        assistantTurns: 0,
        tokensEstimated: false,
      },
      chapters: [
        { errors: 1, errorTools: { Bash: 1 } },
      ],
    });
    assert.match(html, /error-summary/);
    assert.match(html, /error-timeline/);
    assert.match(html, /function renderErrorSummary\b/);
  });
});
