import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { ANALYTICS_CHARTS_JS } from '../../src/render/render-analytics-charts.js';
import { ANALYTICS_JS } from '../../src/render/render-analytics-compose.js';

function runChartsScript(body, sandbox = {}, scriptSource = ANALYTICS_CHARTS_JS) {
  const script = new Script(`
    ${scriptSource}
    ${body}
  `);
  const ctx = {
    Object,
    Array,
    String,
    Math,
    Date,
    Set,
    document: {
      body: { style: { fontFamily: 'monospace' } },
      getElementById: () => null,
      querySelectorAll: () => [],
      createElement: (tag) => ({
        tagName: tag,
        className: '',
        type: '',
        style: {},
        dataset: {},
        attrs: {},
        appendChild() {},
        addEventListener() {},
        setAttribute(k, v) { this.attrs[k] = String(v); },
        innerHTML: '',
        children: [],
        getBoundingClientRect: () => ({ left: 0, width: 400 }),
      }),
    },
    getComputedStyle: () => ({ fontFamily: 'monospace' }),
    setTimeout: (fn) => fn(),
    window: { devicePixelRatio: 2, addEventListener() {} },
    events: [],
    session: { model: 'claude-3-sonnet' },
    activeToolPerfFilter: null,
    activeToolFilters: { clear() {}, add() {} },
    applyFilters() {},
    jumpToChapter() {},
    TOOL_COLORS: { _error: '#f07070', _user: '#0af' },
    getToolColor: (t) => (t === 'Bash' ? '#abc' : '#def'),
    formatDuration: (ms) => ms + 'ms',
    formatTime: (ts) => String(ts),
    fmtPct: (n) => n.toFixed(0) + '%',
    fmtMcpName: (n) => n,
    fmtCost: (n, opts) => (opts?.prefix || '') + n.toFixed(3),
    fmtTokens: (n) => String(n),
    getChapters: () => [],
    estimateChapterTokenCost: () => 0,
    h(tag, attrs, ...kids) {
      const el = {
        tagName: tag,
        className: attrs?.className || '',
        style: attrs?.style || {},
        type: attrs?.type,
        attrs: {},
        dataset: {},
        children: kids.flat().filter((c) => c != null),
        appendChild(c) {
          this.children.push(c);
        },
        addEventListener(type, fn) {
          if (type === 'click') this._click = fn;
        },
        setAttribute(k, v) { this.attrs[k] = String(v); },
        getAttribute(k) { return this.attrs[k]; },
      };
      if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
          if (k !== 'className' && k !== 'style' && !k.startsWith('on')) el.attrs[k] = String(v);
        }
      }
      return el;
    },
    ...sandbox,
  };
  ctx.window = { devicePixelRatio: 2, addEventListener() {}, ...ctx.window };
  return script.runInNewContext(ctx);
}

function runAnalyticsScript(body, sandbox = {}) {
  return runChartsScript(body, sandbox, ANALYTICS_JS);
}

function mockCanvas(width = 400, parent = null) {
  const calls = [];
  const ctx = {
    calls,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    textAlign: '',
    shadowColor: '',
    shadowBlur: 0,
    setTransform() {
      calls.push(['setTransform', arguments]);
    },
    scale() {
      calls.push(['scale', arguments]);
    },
    fillRect() {
      calls.push(['fillRect', arguments]);
    },
    stroke() {
      calls.push(['stroke']);
    },
    beginPath() {
      calls.push(['beginPath']);
    },
    moveTo() {},
    lineTo() {},
    closePath() {},
    fill() {
      calls.push(['fill']);
    },
    arc() {
      calls.push(['arc']);
    },
    fillText() {
      calls.push(['fillText', arguments]);
    },
    setLineDash() {},
    createLinearGradient() {
      return { addColorStop() {} };
    },
  };
  const canvas = {
    width: 0,
    height: 0,
    className: '',
    tabIndex: undefined,
    attrs: {},
    _handlers: {},
    style: { height: '' },
    offsetLeft: 0,
    offsetTop: 0,
    parentElement: parent ?? { clientWidth: width },
    getContext: () => ctx,
    _ctx: ctx,
    addEventListener(type, fn) {
      this._handlers[type] = fn;
      if (type === 'click') this._click = fn;
    },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    getBoundingClientRect: () => ({ left: 0, width }),
  };
  return canvas;
}

function keyEvent(key) {
  return {
    key,
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
}

function setupHiDpiStub() {
  return function setupHiDpiCanvas(c, w, h) {
    c.width = w * 2;
    c.height = h * 2;
    c.style.height = h + 'px';
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(2, 2);
    return ctx;
  };
}

describe('render-analytics-charts', () => {
  test('ANALYTICS_JS includes chart module before orchestration', () => {
    const idxCharts = ANALYTICS_JS.indexOf('function drawWaveform');
    const idxFlow = ANALYTICS_JS.indexOf('function renderToolFlow');
    assert.ok(idxCharts >= 0);
    assert.ok(idxFlow > idxCharts);
  });

  test('renderToolFlow exposes sequence cell labels without title-only text', () => {
    const el = runAnalyticsScript('renderToolFlow();', {
      events: [
        { type: 'user', text: 'one' },
        {
          type: 'assistant',
          toolCalls: [{ name: 'Read' }, { name: 'Bash' }, { name: 'Edit' }],
        },
        { type: 'user', text: 'two' },
        {
          type: 'assistant',
          toolCalls: [{ name: 'Read' }],
        },
      ],
      getChapters: () => [{}, {}],
    });
    const seq = el.children.find((c) => c.className === 'tool-flow-sequence');
    assert.equal(seq.attrs.role, 'list');
    assert.equal(seq.attrs['aria-label'], 'Tool usage sequence by chapter');
    const cells = seq.children.filter((c) => c.className === 'tool-flow-cell');
    assert.equal(cells.length, 4);
    assert.equal(cells[0].attrs.role, 'listitem');
    assert.equal(cells[0].attrs['aria-label'], 'Read in chapter 1');
    assert.equal(cells[0].attrs.title, 'Read (ch 1)');
    assert.equal(cells[3].attrs['aria-label'], 'Read in chapter 2');
    const divider = seq.children.find((c) => c.className === 'tool-flow-divider');
    assert.equal(divider.attrs['aria-hidden'], 'true');
  });

  test('sortToolPerfEntries sorts by errors then usage', () => {
    const entries = [
      ['Read', { total: 10, errors: 0, retries: 0, chapters: 2 }],
      ['Bash', { total: 5, errors: 3, retries: 0, chapters: 1 }],
      ['Grep', { total: 8, errors: 1, retries: 0, chapters: 2 }],
    ];
    const byErrors = runChartsScript('sortToolPerfEntries(entries, "errors");', { entries });
    assert.deepEqual(
      byErrors.map((e) => e[0]),
      ['Bash', 'Grep', 'Read']
    );
  });

  test('sortToolPerfEntries usage mode sorts by total calls', () => {
    const entries = [
      ['Read', { total: 10, errors: 0, retries: 0, chapters: 2 }],
      ['Bash', { total: 5, errors: 3, retries: 0, chapters: 1 }],
      ['Grep', { total: 8, errors: 1, retries: 0, chapters: 2 }],
    ];
    const byUsage = runChartsScript('sortToolPerfEntries(entries, "usage");', { entries });
    assert.deepEqual(
      byUsage.map((e) => e[0]),
      ['Read', 'Grep', 'Bash']
    );
  });

  test('drawWaveform configures hi-dpi canvas and returns width', () => {
    const canvas = mockCanvas(320);
    const turns = [
      { output: 100, input: 50, cacheRatio: 0.5, tool: 'Bash', hasError: false },
      { output: 80, input: 40, cacheRatio: 0.2, tool: 'Read', hasError: true },
    ];
    const W = runChartsScript(
      'drawWaveform(canvas, turns, [], [{ idx: 1 }], 100, 50, 200);',
      { canvas, turns, setupHiDpiCanvas: setupHiDpiStub() }
    );
    assert.equal(W, 320);
    assert.equal(canvas.width, 640);
    assert.equal(canvas.height, 400);
    assert.ok(canvas._ctx.calls.some((c) => c[0] === 'setTransform'));
    assert.ok(canvas._ctx.calls.some((c) => c[0] === 'fillRect'));
  });

  test('drawWaveform labels gaps with formatDuration', () => {
    const canvas = mockCanvas(300);
    const turns = [
      { output: 10, input: 5, cacheRatio: 0, tool: 'Read', hasError: false },
      { output: 20, input: 10, cacheRatio: 0, tool: 'Read', hasError: false },
    ];
    runChartsScript('drawWaveform(canvas, turns, [{ idx: 1, delta: 45000 }], [], 20, 10, 100);', {
      canvas,
      turns,
      setupHiDpiCanvas: (c) => c.getContext('2d'),
    });
    const gapLabel = canvas._ctx.calls.find((c) => c[0] === 'fillText');
    assert.ok(gapLabel);
    assert.equal(gapLabel[1][0], '45000ms');
  });

  test('drawWaveform draws user message diamond markers', () => {
    const canvas = mockCanvas(240);
    const turns = [
      { output: 50, input: 25, cacheRatio: 0.5, tool: 'Bash', hasError: false },
      { output: 60, input: 30, cacheRatio: 0.5, tool: 'Bash', hasError: false },
    ];
    runChartsScript('drawWaveform(canvas, turns, [], [{ idx: 0 }, { idx: 1 }], 60, 30, 80);', {
      canvas,
      turns,
      setupHiDpiCanvas: (c) => c.getContext('2d'),
    });
    const fills = canvas._ctx.calls.filter((c) => c[0] === 'fill');
    assert.ok(fills.length >= 2);
    assert.ok(canvas._ctx.calls.some((c) => c[0] === 'stroke'));
  });

  test('drawWaveform error turn draws glow bar and bottom arc', () => {
    const canvas = mockCanvas(200);
    const turns = [{ output: 100, input: 50, cacheRatio: 0, tool: 'Bash', hasError: true }];
    runChartsScript('drawWaveform(canvas, turns, [], [], 100, 50, 120);', {
      canvas,
      turns,
      setupHiDpiCanvas: (c) => c.getContext('2d'),
    });
    assert.ok(canvas._ctx.calls.some((c) => c[0] === 'arc'));
    const errFills = canvas._ctx.calls.filter((c) => c[0] === 'fillRect');
    assert.ok(errFills.length >= 2);
  });

  test('drawWaveform uses 800px fallback without parent width', () => {
    const canvas = mockCanvas(400);
    canvas.parentElement = null;
    const turns = [{ output: 10, input: 5, cacheRatio: 1, tool: '_text', hasError: false }];
    const W = runChartsScript('drawWaveform(canvas, turns, [], [], 10, 5, 50);', {
      canvas,
      turns,
      setupHiDpiCanvas: (c, w) => {
        c._lastW = w;
        return c.getContext('2d');
      },
    });
    assert.equal(W, 800);
    assert.equal(canvas._lastW, 800);
  });

  test('drawChart draws cumulative cost area and axis labels', () => {
    const canvas = mockCanvas(200);
    const chapterCosts = [
      { cost: 0.01, cumulative: 0.01 },
      { cost: 0.02, cumulative: 0.03 },
      { cost: 0.01, cumulative: 0.04 },
    ];
    const W = runChartsScript('drawChart(canvas, chapterCosts, 0.04, 0.02, 100);', {
      canvas,
      chapterCosts,
      setupHiDpiCanvas: (c) => c.getContext('2d'),
    });
    assert.equal(W, 200);
    const fills = canvas._ctx.calls.filter((c) => c[0] === 'fill');
    assert.ok(fills.length >= 2);
    const labels = canvas._ctx.calls.filter((c) => c[0] === 'fillText');
    assert.equal(labels.length, 2);
    assert.equal(labels[0][1][0], '$0.040');
    assert.equal(labels[1][1][0], '$0');
  });

  test('drawChart omits per-chapter bars when maxSingle is zero', () => {
    const canvas = mockCanvas(160);
    const chapterCosts = [
      { cost: 0, cumulative: 0.02 },
      { cost: 0, cumulative: 0.04 },
    ];
    runChartsScript('drawChart(canvas, chapterCosts, 0.04, 0, 80);', {
      canvas,
      chapterCosts,
      setupHiDpiCanvas: (c) => c.getContext('2d'),
    });
    const barFills = canvas._ctx.calls.filter(
      (c) => c[0] === 'fillRect' && c[1][3] < 40
    );
    assert.equal(barFills.length, 0);
    assert.ok(canvas._ctx.calls.some((c) => c[0] === 'stroke'));
  });

  test('buildToolPerfRow exposes tool name on dataset', () => {
    const row = runChartsScript(
      "buildToolPerfRow('mcp__srv__tool', { total: 4, errors: 1, retries: 2, chapters: 2 });"
    );
    assert.equal(row.tagName, 'button');
    assert.equal(row.type, 'button');
    assert.equal(row.dataset.tool, 'mcp__srv__tool');
    assert.equal(row.attrs['aria-pressed'], 'false');
    assert.equal(row.attrs['aria-label'], 'Filter chapters using mcp__srv__tool');
    assert.ok(row.className.includes('tool-perf-row'));
    const calls = row.children.find((c) => c.className === 'tool-perf-calls');
    assert.equal(calls.children[0], '4');
  });

  test('buildToolPerfRow applies perfect rate class at 100% success', () => {
    const row = runChartsScript(
      "buildToolPerfRow('Read', { total: 5, errors: 0, retries: 0, chapters: 1 });"
    );
    const rate = row.children.find((c) => c.className.includes('tool-perf-rate'));
    assert.ok(rate.className.includes('perfect'));
    const errSpan = row.children.find((c) => c.className === 'tool-perf-errs');
    assert.equal(errSpan.children[0], '');
  });

  test('buildToolPerfRow applies warn class and error bar slice', () => {
    const row = runChartsScript(
      "buildToolPerfRow('Bash', { total: 10, errors: 2, retries: 0, chapters: 1 });"
    );
    const rate = row.children.find((c) => c.className.includes('tool-perf-rate'));
    assert.ok(rate.className.includes('warn'));
    const barWrap = row.children.find((c) => c.className === 'tool-perf-bar-wrap');
    assert.equal(barWrap.children.length, 2);
    assert.ok(barWrap.children.some((c) => c.className === 'tool-perf-bar-err'));
  });

  test('buildToolPerfRow appends retry strip when retries present', () => {
    const row = runChartsScript(
      "buildToolPerfRow('Grep', { total: 3, errors: 0, retries: 2, chapters: 3 });"
    );
    const retry = row.children.find((c) => c.className === 'tool-perf-retries');
    assert.ok(retry);
    assert.match(String(retry.children[0]), /2 retr/);
  });

  test('buildToolPerfRow click toggles active filter and applyFilters', () => {
    let filtered = 0;
    const cleared = { n: 0 };
    const added = [];
    const row = runChartsScript(
      "buildToolPerfRow('Read', { total: 2, errors: 0, retries: 0, chapters: 1 });",
      {
        applyFilters() {
          filtered += 1;
        },
        activeToolFilters: {
          clear() {
            cleared.n += 1;
          },
          add(t) {
            added.push(t);
          },
        },
        document: {
          querySelectorAll() {
            return [{
              classList: { toggle() {} },
              dataset: { tool: 'Read' },
              attrs: {},
              setAttribute(k, v) { this.attrs[k] = String(v); },
            }];
          },
        },
      }
    );
    row._click({ stopPropagation() {} });
    assert.equal(filtered, 1);
    assert.deepEqual(added, ['Read']);
    assert.equal(cleared.n, 1);
    row._click({ stopPropagation() {} });
    assert.equal(filtered, 2);
    assert.equal(cleared.n, 2);
    assert.equal(added.length, 1);
  });

  test('rebuildToolPerfTable repopulates #tool-perf-table', () => {
    const appended = [];
    const table = {
      innerHTML: 'old',
      appendChild(row) {
        appended.push(row);
      },
    };
    runChartsScript(
      `rebuildToolPerfTable([
        ['A', { total: 1, errors: 0, retries: 0, chapters: 1 }],
        ['B', { total: 2, errors: 1, retries: 0, chapters: 1 }],
      ]);`,
      {
        document: {
          getElementById(id) {
            return id === 'tool-perf-table' ? table : null;
          },
        },
      }
    );
    assert.equal(table.innerHTML, '');
    assert.equal(appended.length, 2);
    assert.deepEqual(
      appended.map((r) => r.dataset.tool),
      ['A', 'B']
    );
  });

  test('rebuildToolPerfTable no-op when table element missing', () => {
    const result = runChartsScript(
      `rebuildToolPerfTable([['Z', { total: 1, errors: 0, retries: 0, chapters: 1 }]]); 'ok';`
    );
    assert.equal(result, 'ok');
  });

  test('renderWaveform returns empty div without assistant token turns', () => {
    const el = runChartsScript('renderWaveform();', {
      events: [{ type: 'user', text: 'hi' }],
    });
    assert.equal(el.tagName, 'div');
    assert.equal(el.children.length, 0);
  });

  test('renderWaveform builds canvas tooltip legend from events', () => {
    const created = [];
    const el = runChartsScript('renderWaveform();', {
      events: [
        { type: 'user', timestamp: '2026-01-01T00:00:00.000Z', text: 'go' },
        {
          type: 'assistant',
          timestamp: '2026-01-01T00:00:01.000Z',
          tokens: { output: 120, input: 60, cacheHit: 10 },
          toolCalls: [{ name: 'Read', id: 'u1' }],
          text: 'ok',
        },
        { type: 'user', timestamp: '2026-01-01T00:00:02.000Z', text: 'more' },
        {
          type: 'assistant',
          timestamp: '2026-01-01T00:00:03.000Z',
          tokens: { output: 80, input: 40, cacheHit: 5 },
          toolCalls: [{ name: 'Bash', id: 'u2' }],
          text: 'done',
        },
      ],
      document: {
        body: { style: { fontFamily: 'monospace' } },
        getElementById: () => null,
        querySelectorAll: () => [],
        createElement(tag) {
          created.push(tag);
          if (tag === 'canvas') return mockCanvas(360);
          return {
            tagName: tag,
            className: '',
            style: {},
            dataset: {},
            children: [],
            appendChild(c) {
              this.children.push(c);
            },
            addEventListener() {},
            getBoundingClientRect: () => ({ left: 0, width: 400 }),
          };
        },
      },
      setupHiDpiCanvas: (c) => c.getContext('2d'),
    });
    assert.ok(el.className.includes('waveform-wrap'));
    assert.ok(created.includes('canvas'));
    const legend = el.children.find((c) => c.className === 'waveform-legend');
    assert.ok(legend);
    assert.ok(legend.children.length >= 2);
  });

  test('renderWaveform canvas exposes keyboard chapter jump alternative', () => {
    let canvas;
    let jumped = -1;
    runChartsScript('renderWaveform();', {
      events: [
        { type: 'user', timestamp: '2026-01-01T00:00:00.000Z', text: 'one' },
        {
          type: 'assistant',
          timestamp: '2026-01-01T00:00:01.000Z',
          tokens: { output: 120, input: 60, cacheHit: 10 },
          toolCalls: [{ name: 'Read', id: 'u1' }],
          text: 'ok',
        },
        { type: 'user', timestamp: '2026-01-01T00:00:02.000Z', text: 'two' },
        {
          type: 'assistant',
          timestamp: '2026-01-01T00:00:03.000Z',
          tokens: { output: 80, input: 40, cacheHit: 5 },
          toolCalls: [{ name: 'Bash', id: 'u2' }],
          text: 'done',
        },
        { type: 'user', timestamp: '2026-01-01T00:00:04.000Z', text: 'three' },
        {
          type: 'assistant',
          timestamp: '2026-01-01T00:00:05.000Z',
          tokens: { output: 40, input: 20, cacheHit: 0 },
          toolCalls: [],
          text: 'final',
        },
      ],
      jumpToChapter(idx) {
        jumped = idx;
      },
      document: {
        body: { style: { fontFamily: 'monospace' } },
        getElementById: () => null,
        querySelectorAll: () => [],
        createElement(tag) {
          if (tag === 'canvas') {
            canvas = mockCanvas(360);
            return canvas;
          }
          return {
            tagName: tag,
            className: '',
            style: {},
            dataset: {},
            children: [],
            appendChild(c) {
              this.children.push(c);
            },
            addEventListener() {},
            setAttribute(k, v) { this[k] = String(v); },
            getBoundingClientRect: () => ({ left: 0, width: 360 }),
          };
        },
      },
      setupHiDpiCanvas: (c) => c.getContext('2d'),
    });

    assert.equal(canvas.tabIndex, 0);
    assert.equal(canvas.attrs.role, 'button');
    assert.match(canvas.attrs['aria-label'], /Use Left and Right arrows/);
    const move = keyEvent('ArrowRight');
    canvas._handlers.keydown(move);
    assert.equal(move.prevented, true);
    const activate = keyEvent('Enter');
    canvas._handlers.keydown(activate);
    assert.equal(activate.prevented, true);
    assert.equal(jumped, 1);
    canvas._handlers.keydown(keyEvent('End'));
    canvas._handlers.keydown(keyEvent(' '));
    assert.equal(jumped, 2);
  });

  test('computeWaveformChapters maps by ordinal when timestamps are absent', () => {
    const evts = [
      { type: 'user', timestamp: null, text: 'first prompt' },
      { type: 'assistant', timestamp: null, tokens: { output: 10, input: 0, cacheHit: 0 }, text: 'a' },
      { type: 'user', timestamp: null, text: 'second prompt' },
      { type: 'assistant', timestamp: null, tokens: { output: 20, input: 0, cacheHit: 0 }, text: 'b' },
      { type: 'assistant', timestamp: null, tokens: { output: 30, input: 0, cacheHit: 0 }, text: 'c' },
    ];
    const res = runChartsScript('computeWaveformChapters(evts);', { evts });
    assert.deepEqual(Array.from(res.turnToChapter), [0, 1, 1]);
    assert.deepEqual(Array.from(res.userMsgs, (m) => m.idx), [0, 1]);
  });

  test('computeWaveformChapters skips non-token assistant and tool_result events', () => {
    const evts = [
      { type: 'user', timestamp: null, text: 'go' },
      { type: 'assistant', timestamp: null, text: 'no tokens' },
      { type: 'tool_result', timestamp: null, text: 'out', isError: false },
      { type: 'assistant', timestamp: null, tokens: { output: 5, input: 0, cacheHit: 0 }, text: 'a' },
    ];
    const res = runChartsScript('computeWaveformChapters(evts);', { evts });
    assert.deepEqual(Array.from(res.turnToChapter), [0]);
    assert.deepEqual(Array.from(res.userMsgs, (m) => m.idx), [0]);
  });

  test('computeWaveformChapters ordinal mapping equals timestamp mapping on chronological events', () => {
    // Claude-shaped fixture: chronological timestamps, a leading assistant turn
    // (subagent-style), multi-turn chapters.
    const evts = [
      { type: 'assistant', timestamp: '2026-01-01T00:00:00.000Z', tokens: { output: 5, input: 100, cacheHit: 50 }, text: 'lead' },
      { type: 'user', timestamp: '2026-01-01T00:00:01.000Z', text: 'one' },
      { type: 'assistant', timestamp: '2026-01-01T00:00:02.000Z', tokens: { output: 10, input: 100, cacheHit: 50 }, text: 'a' },
      { type: 'assistant', timestamp: '2026-01-01T00:00:03.000Z', tokens: { output: 20, input: 100, cacheHit: 50 }, text: 'b' },
      { type: 'user', timestamp: '2026-01-01T00:00:04.000Z', text: 'two' },
      { type: 'assistant', timestamp: '2026-01-01T00:00:05.000Z', tokens: { output: 30, input: 100, cacheHit: 50 }, text: 'c' },
      { type: 'user', timestamp: '2026-01-01T00:00:06.000Z', text: 'three' },
      { type: 'assistant', timestamp: '2026-01-01T00:00:07.000Z', tokens: { output: 40, input: 100, cacheHit: 50 }, text: 'd' },
    ];
    const res = runChartsScript('computeWaveformChapters(evts);', { evts });

    // Reference: the previous timestamp-based mapping.
    const turnMs = evts
      .filter((e) => e.type === 'assistant' && e.tokens)
      .map((e) => new Date(e.timestamp).getTime());
    const refUserMsgs = [];
    for (const e of evts) {
      if (e.type !== 'user' || !e.timestamp) continue;
      const ts = new Date(e.timestamp).getTime();
      let idx = 0;
      for (let i = 0; i < turnMs.length; i++) {
        if (turnMs[i] >= ts) { idx = i; break; }
        idx = i + 1;
      }
      refUserMsgs.push(idx);
    }
    const refTurnToChapter = new Array(turnMs.length).fill(0);
    for (let c = 0; c < refUserMsgs.length; c++) {
      const start = refUserMsgs[c];
      const end = c + 1 < refUserMsgs.length ? refUserMsgs[c + 1] : turnMs.length;
      for (let t = start; t < end; t++) refTurnToChapter[t] = c;
    }

    assert.deepEqual(Array.from(res.userMsgs, (m) => m.idx), refUserMsgs);
    assert.deepEqual(Array.from(res.turnToChapter), refTurnToChapter);
  });

  test('renderWaveform jumps to actual chapter for events without timestamps', () => {
    let canvas;
    let jumped = -1;
    runChartsScript('renderWaveform();', {
      events: [
        { type: 'user', timestamp: null, text: 'one' },
        {
          type: 'assistant',
          timestamp: null,
          tokens: { output: 120, input: 0, cacheHit: 0 },
          toolCalls: [{ name: 'Read', id: 'u1' }],
          text: 'ok',
        },
        { type: 'user', timestamp: null, text: 'two' },
        {
          type: 'assistant',
          timestamp: null,
          tokens: { output: 80, input: 0, cacheHit: 0 },
          toolCalls: [{ name: 'Bash', id: 'u2' }],
          text: 'done',
        },
        {
          type: 'assistant',
          timestamp: null,
          tokens: { output: 40, input: 0, cacheHit: 0 },
          toolCalls: [],
          text: 'final',
        },
      ],
      jumpToChapter(idx) {
        jumped = idx;
      },
      document: {
        body: { style: { fontFamily: 'monospace' } },
        getElementById: () => null,
        querySelectorAll: () => [],
        createElement(tag) {
          if (tag === 'canvas') {
            canvas = mockCanvas(360);
            return canvas;
          }
          return {
            tagName: tag,
            className: '',
            style: {},
            dataset: {},
            children: [],
            appendChild(c) {
              this.children.push(c);
            },
            addEventListener() {},
            setAttribute(k, v) { this[k] = String(v); },
            getBoundingClientRect: () => ({ left: 0, width: 360 }),
          };
        },
      },
      setupHiDpiCanvas: (c) => c.getContext('2d'),
    });

    canvas._handlers.keydown(keyEvent('End'));
    canvas._handlers.keydown(keyEvent('Enter'));
    assert.equal(jumped, 1);
    canvas._handlers.keydown(keyEvent('Home'));
    canvas._handlers.keydown(keyEvent('Enter'));
    assert.equal(jumped, 0);
  });

  test('renderWaveform tooltip omits time row for null timestamps and shows it when present', () => {
    let canvas;
    let wrap;
    const makeDoc = () => ({
      body: { style: { fontFamily: 'monospace' } },
      getElementById: () => null,
      querySelectorAll: () => [],
      createElement(tag) {
        if (tag === 'canvas') {
          canvas = mockCanvas(360);
          return canvas;
        }
        return {
          tagName: tag,
          className: '',
          style: {},
          dataset: {},
          children: [],
          appendChild(c) {
            this.children.push(c);
          },
          addEventListener() {},
          setAttribute(k, v) { this[k] = String(v); },
          getBoundingClientRect: () => ({ left: 0, width: 360 }),
        };
      },
    });

    wrap = runChartsScript('renderWaveform();', {
      events: [
        { type: 'user', timestamp: null, text: 'one' },
        {
          type: 'assistant',
          timestamp: null,
          tokens: { output: 120, input: 0, cacheHit: 0 },
          toolCalls: [{ name: 'Read', id: 'u1' }],
          text: 'ok',
        },
      ],
      formatTime: () => 'EPOCH_TIME',
      document: makeDoc(),
      setupHiDpiCanvas: (c) => c.getContext('2d'),
    });
    const tooltip = wrap.children.find((c) => c.className === 'waveform-tooltip');
    canvas._handlers.mousemove({ clientX: 10 });
    assert.ok(!tooltip.innerHTML.includes('EPOCH_TIME'));
    assert.match(tooltip.innerHTML, /chapter 1/);
    // Neutral cache ratio for input === 0 → cold shows 50%.
    assert.match(tooltip.innerHTML, /cold: 50%/);

    wrap = runChartsScript('renderWaveform();', {
      events: [
        { type: 'user', timestamp: '2026-01-01T00:00:00.000Z', text: 'one' },
        {
          type: 'assistant',
          timestamp: '2026-01-01T00:00:01.000Z',
          tokens: { output: 120, input: 60, cacheHit: 10 },
          toolCalls: [{ name: 'Read', id: 'u1' }],
          text: 'ok',
        },
      ],
      formatTime: () => 'REAL_TIME',
      document: makeDoc(),
      setupHiDpiCanvas: (c) => c.getContext('2d'),
    });
    const tooltip2 = wrap.children.find((c) => c.className === 'waveform-tooltip');
    canvas._handlers.mousemove({ clientX: 10 });
    assert.ok(tooltip2.innerHTML.includes('REAL_TIME'));
  });

  test('drawWaveform renders neutral mid alpha for cacheRatio 0.5 turns', () => {
    const canvas = mockCanvas(200);
    const alphas = [];
    const baseFillRect = canvas._ctx.fillRect;
    canvas._ctx.fillRect = function () {
      alphas.push(this.globalAlpha);
      baseFillRect.apply(this, arguments);
    };
    const turns = [{ output: 100, input: 0, cacheRatio: 0.5, tool: 'Bash', hasError: false }];
    runChartsScript('drawWaveform(canvas, turns, [], [], 100, 1, 120);', {
      canvas,
      turns,
      setupHiDpiCanvas: (c) => c.getContext('2d'),
    });
    // alpha = 0.35 + 0.65 * (1 - 0.5) = 0.675 — midpoint of the [0.35, 1] range.
    assert.ok(alphas.some((a) => Math.abs(a - 0.675) < 1e-9));
    assert.ok(!alphas.some((a) => Math.abs(a - 0.35) < 1e-9));
  });

  test('waveform source keeps tooltip timestamp guard and neutral cacheRatio fallback', () => {
    assert.ok(ANALYTICS_CHARTS_JS.includes('e.tokens.cacheHit / e.tokens.input : 0.5'));
  });

  test('renderCostChart returns empty when fewer than two chapters', () => {
    const el = runChartsScript('renderCostChart();', {
      getChapters: () => [{ tokens: { input: 1, output: 1, cacheHit: 0 } }],
      estimateChapterTokenCost: () => 0.01,
    });
    assert.equal(el.children.length, 0);
  });

  test('renderCostChart returns empty when estimated cost is negligible', () => {
    const el = runChartsScript('renderCostChart();', {
      getChapters: () => [
        { tokens: { input: 0, output: 0, cacheHit: 0 } },
        { tokens: { input: 0, output: 0, cacheHit: 0 } },
      ],
      estimateChapterTokenCost: () => 0,
    });
    assert.equal(el.children.length, 0);
  });

  test('renderCostChart builds header canvas axis and jump on click', () => {
    let jumped = -1;
    let canvasClick;
    const el = runChartsScript('renderCostChart();', {
      getChapters: () => [
        { tokens: { input: 1000, output: 200, cacheHit: 0 } },
        { tokens: { input: 2000, output: 400, cacheHit: 100 } },
        { tokens: { input: 500, output: 100, cacheHit: 0 } },
      ],
      estimateChapterTokenCost: (_m, tok) => (tok.input + tok.output) / 1e5,
      jumpToChapter(idx) {
        jumped = idx;
      },
      document: {
        body: { style: { fontFamily: 'monospace' } },
        getElementById: () => null,
        querySelectorAll: () => [],
        createElement(tag) {
          if (tag === 'canvas') {
            const canvas = mockCanvas(300);
            canvas.addEventListener = (type, fn) => {
              if (type === 'click') canvasClick = fn;
            };
            return canvas;
          }
          return {
            tagName: tag,
            className: '',
            style: {},
            children: [],
            appendChild(c) {
              this.children.push(c);
            },
            addEventListener() {},
            getBoundingClientRect: () => ({ left: 0, width: 300 }),
          };
        },
      },
      setupHiDpiCanvas: (c) => c.getContext('2d'),
    });
    assert.ok(el.className.includes('cost-chart'));
    const header = el.children.find((c) => c.className === 'cost-chart-header');
    assert.ok(header);
    const axis = el.children.find((c) => c.className === 'cost-chart-axis');
    assert.ok(axis);
    assert.equal(axis.children[axis.children.length - 1].children[0], 'ch 3');
    canvasClick({ clientX: 250 });
    assert.equal(jumped, 2);
  });

  test('renderCostChart canvas exposes keyboard chapter jump alternative', () => {
    let jumped = -1;
    let canvas;
    runChartsScript('renderCostChart();', {
      getChapters: () => [
        { tokens: { input: 1000, output: 200, cacheHit: 0 } },
        { tokens: { input: 2000, output: 400, cacheHit: 100 } },
        { tokens: { input: 500, output: 100, cacheHit: 0 } },
      ],
      estimateChapterTokenCost: (_m, tok) => (tok.input + tok.output) / 1e5,
      jumpToChapter(idx) {
        jumped = idx;
      },
      document: {
        body: { style: { fontFamily: 'monospace' } },
        getElementById: () => null,
        querySelectorAll: () => [],
        createElement(tag) {
          if (tag === 'canvas') {
            canvas = mockCanvas(300);
            return canvas;
          }
          return {
            tagName: tag,
            className: '',
            style: {},
            children: [],
            appendChild(c) {
              this.children.push(c);
            },
            addEventListener() {},
            getBoundingClientRect: () => ({ left: 0, width: 300 }),
          };
        },
      },
      setupHiDpiCanvas: (c) => c.getContext('2d'),
    });

    assert.equal(canvas.tabIndex, 0);
    assert.equal(canvas.attrs.role, 'button');
    assert.match(canvas.attrs['aria-label'], /Cost progression chart/);
    canvas._handlers.keydown(keyEvent('ArrowRight'));
    const activate = keyEvent(' ');
    canvas._handlers.keydown(activate);
    assert.equal(activate.prevented, true);
    assert.equal(jumped, 1);
    canvas._handlers.keydown(keyEvent('End'));
    canvas._handlers.keydown(keyEvent('Enter'));
    assert.equal(jumped, 2);
  });
});
