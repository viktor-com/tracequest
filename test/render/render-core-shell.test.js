import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { chapterFileKeys } from '../../src/chapters/chapter-keys.js';
import { CORE_SHELL_JS } from '../../src/render/render-core-shell.js';

const CHAPTER_FILE_KEYS_SRC = chapterFileKeys.toString().replace(/^export /, '');

function mockCanvasCtx() {
  const calls = [];
  const ctx = {
    calls,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: '',
    setTransform() { calls.push('setTransform'); },
    scale() { calls.push('scale'); },
    fillRect() { calls.push('fillRect'); },
    fillText() { calls.push('fillText'); },
    stroke() { calls.push('stroke'); },
    beginPath() { calls.push('beginPath'); },
    moveTo() {},
    lineTo() {},
    fill() { calls.push('fill'); },
    rect() { calls.push('rect'); },
    roundRect() { calls.push('roundRect'); },
    save() { calls.push('save'); },
    restore() { calls.push('restore'); },
    setLineDash() {},
    createLinearGradient: () => ({ addColorStop() {} }),
  };
  return ctx;
}

function runShell(body, sandbox = {}) {
  const hiDpiLog = [];
  const script = new Script(`
    let expandedSet = new Set();
    var searchQuery = '';
    var activeToolFilters = new Set();
    function setupHiDpiCanvas(canvas, w, h) {
      __hiDpiLog.push({ w: w, h: h, canvas: canvas.tagName || 'canvas' });
      const ctx = canvas.getContext('2d');
      if (ctx.setTransform) ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (ctx.scale) ctx.scale(1, 1);
      return ctx;
    }
    function h(tag, attrs, ...kids) {
      const attrStore = {};
      const el = {
        tagName: tag,
        className: attrs?.className || '',
        style: attrs?.style || {},
        href: attrs?.href,
        title: attrs?.title,
        id: attrs?.id,
        role: attrs?.role,
        attributes: attrStore,
        children: kids.flat().filter((c) => c != null),
        appendChild(c) { this.children.push(c); },
        addEventListener() {},
        setAttribute(k, v) { attrStore[k] = String(v); this[k] = String(v); },
        getAttribute(k) { return attrStore[k]; },
      };
      if (attrs) {
        for (const k in attrs) {
          if (k !== 'className' && k !== 'style' && k !== 'href' && k !== 'title' && Object.prototype.hasOwnProperty.call(attrs, k)) {
            el.setAttribute(k, attrs[k]);
          }
        }
      }
      return el;
    }
    function formatDuration(ms) { return ms + 'ms'; }
    function fmtTokens(n) { return String(n); }
    function fmtCost(n) { return n ? '$' + n.toFixed(2) : ''; }
    function estimateParsedStatsCost() { return 0.42; }
    function expandAllChapterDetails() {}
    function getChapters() { return chapters || []; }
    ${CHAPTER_FILE_KEYS_SRC}
    ${CORE_SHELL_JS}
    ${body}
  `);
  const ctx = {
    __result: undefined,
    __hiDpiLog: hiDpiLog,
    Object,
    Array,
    String,
    Math,
    Date,
    Set,
    URL,
    URLSearchParams,
    history: { replaceState: () => {} },
    requestAnimationFrame: (fn) => fn(),
    document: {
      getElementById: () => null,
      createElement: (tag) => {
        const handlers = {};
        if (tag === 'canvas') {
          const canvasCtx = mockCanvasCtx();
          return {
            tagName: 'canvas',
            className: '',
            tabIndex: -1,
            attributes: {},
            style: {},
            parentElement: { clientWidth: 400 },
            getContext: () => canvasCtx,
            _ctx: canvasCtx,
            addEventListener(ev, fn) { handlers[ev] = fn; },
            _handlers: handlers,
            setAttribute(k, v) { this.attributes[k] = String(v); },
            getAttribute(k) { return this.attributes[k]; },
            getBoundingClientRect: () => ({ left: 0, width: 400 }),
          };
        }
        return {
          tagName: tag,
          className: '',
          attributes: {},
          style: {},
          parentElement: { clientWidth: 400 },
          getContext: () => mockCanvasCtx(),
          addEventListener(ev, fn) { handlers[ev] = fn; },
          _handlers: handlers,
          setAttribute(k, v) { this.attributes[k] = String(v); },
          getAttribute(k) { return this.attributes[k]; },
          getBoundingClientRect: () => ({ left: 0, width: 400 }),
        };
      },
      createElementNS: () => ({
        setAttribute() {},
        innerHTML: '',
      }),
      createTextNode: (t) => ({ nodeType: 3, textContent: t }),
      body: { style: { fontFamily: 'monospace' } },
    },
    getComputedStyle: () => ({ getPropertyValue: () => "'Mono', monospace" }),
    window: {
      location: {
        pathname: '/trace',
        search: '?path=sess.json&source=claude',
        hash: '',
        origin: 'http://localhost',
      },
      addEventListener() {},
      print() {},
      devicePixelRatio: 2,
    },
    session: {
      sessionId: 'abcd1234efgh5678',
      source: 'claude',
      model: 'test-model',
      cwd: '/proj',
      gitBranch: 'main',
      durationMs: 120000,
      startTime: '2026-01-01T00:00:00.000Z',
      eventCount: 5,
      stats: {
        toolCounts: { Bash: 10, Read: 5 },
        totalInputTokens: 50000,
        totalOutputTokens: 5000,
        totalCacheHit: 40000,
        errors: 1,
        userMessages: 3,
        assistantTurns: 3,
        tokensEstimated: false,
      },
    },
    events: [],
    chapters: [],
    ...sandbox,
  };
  ctx.window = ctx.window;
  script.runInNewContext(ctx);
  return { result: ctx.__result, hiDpiLog, vm: ctx };
}

function run(body, sandbox) {
  return runShell(body, sandbox).result;
}

describe('render-core-shell URL helpers', () => {
  test('buildFilterSearchParams preserves path/source and adds tool/q', () => {
    const params = run(`
      activeToolFilters.add('Bash');
      activeToolFilters.add('Read');
      searchQuery = 'grep foo';
      __result = buildFilterSearchParams().toString();
    `);
    assert.ok(params.includes('path=sess.json'));
    assert.ok(params.includes('source=claude'));
    assert.ok(params.includes('tool=Bash%2CRead') || params.includes('tool=Bash,Read'));
    assert.ok(params.includes('q=grep+foo') || params.includes('q=grep%20foo'));
  });

  test('preserves id handles across rendered-session URL helpers', () => {
    const idWindow = {
      location: {
        pathname: '/view',
        search: '?id=abc123ef&source=codex',
        hash: '#chapter-1',
        origin: 'http://localhost',
      },
      addEventListener() {},
      devicePixelRatio: 1,
    };

    const params = run(
      `
      activeToolFilters.add('Bash');
      searchQuery = 'needle';
      __result = buildFilterSearchParams().toString();
    `,
      { window: idWindow }
    );
    assert.ok(params.includes('id=abc123ef'));
    assert.ok(params.includes('source=codex'));
    assert.ok(!params.includes('path='));
    assert.ok(params.includes('tool=Bash'));
    assert.ok(params.includes('q=needle'));

    const permalink = run(
      `
      activeToolFilters.add('Read');
      searchQuery = 'trace';
      __result = getPermalink(3);
    `,
      { window: idWindow }
    );
    assert.ok(permalink.includes('/view?'));
    assert.ok(permalink.includes('id=abc123ef'));
    assert.ok(permalink.includes('source=codex'));
    assert.ok(permalink.includes('tool=Read'));
    assert.ok(permalink.includes('q=trace'));
    assert.ok(permalink.endsWith('#chapter-3'));

    const updated = { url: null };
    run(
      `
      activeToolFilters.add('Grep');
      searchQuery = 'route';
      updateUrl();
    `,
      {
        window: idWindow,
        history: { replaceState: (_, __, u) => { updated.url = u; } },
      }
    );
    assert.ok(updated.url.includes('/view?'));
    assert.ok(updated.url.includes('id=abc123ef'));
    assert.ok(updated.url.includes('source=codex'));
    assert.ok(updated.url.includes('tool=Grep'));
    assert.ok(updated.url.includes('q=route'));
    assert.ok(updated.url.endsWith('#chapter-1'));

    const hashed = { url: null };
    run(
      'setChapterHash(4);',
      {
        window: idWindow,
        history: { replaceState: (_, __, u) => { hashed.url = u; } },
      }
    );
    assert.ok(hashed.url.includes('id=abc123ef'));
    assert.ok(hashed.url.includes('source=codex'));
    assert.ok(hashed.url.endsWith('#chapter-4'));

    const header = run('__result = renderHeader();', { window: idWindow });
    const actions = header.children
      .find((c) => c.className === 'header-top')
      .children.find((c) => c.className === 'header-actions');
    const exportBtn = actions.children.find((c) => c.className === 'export-btn');
    const mdBtn = actions.children.find((c) => c.className === 'md-btn');
    assert.equal(exportBtn.href, '/export?id=abc123ef&source=codex');
    assert.equal(mdBtn.href, '/markdown?id=abc123ef&source=codex');
  });

  test('buildFilterSearchParams omits empty tool and q params', () => {
    const params = run('__result = buildFilterSearchParams().toString();');
    assert.ok(params.includes('path=sess.json'));
    assert.ok(!params.includes('tool='));
    assert.ok(!params.includes('q='));
  });

  test('getPermalink includes chapter hash and current filters', () => {
    const link = run(`
      activeToolFilters.add('Edit');
      searchQuery = 'bar';
      __result = getPermalink(2);
    `);
    assert.ok(link.includes('#chapter-2'));
    assert.ok(link.includes('tool='));
    assert.ok(link.includes('q='));
  });

  test('updateUrl writes pathname query and preserves hash', () => {
    const captured = { url: null };
    run(
      `
      searchQuery = 'needle';
      activeToolFilters.add('Grep');
      updateUrl();
    `,
      {
        window: {
          location: {
            pathname: '/trace',
            search: '?path=sess.json&source=claude',
            hash: '#chapter-4',
            origin: 'http://localhost',
          },
          addEventListener() {},
          devicePixelRatio: 1,
        },
        history: {
          replaceState: (_, __, u) => {
            captured.url = u;
          },
        },
      }
    );
    assert.ok(captured.url.includes('/trace?'));
    assert.ok(captured.url.includes('path=sess.json'));
    assert.ok(captured.url.includes('q=needle') || captured.url.includes('q=needle'));
    assert.ok(captured.url.endsWith('#chapter-4'));
  });

  test('setChapterHash sets chapter fragment via replaceState', () => {
    const captured = { url: null };
    run('setChapterHash(7);', {
      history: { replaceState: (_, __, u) => { captured.url = u; } },
    });
    assert.ok(captured.url.endsWith('#chapter-7'));
    assert.ok(captured.url.includes('path=sess.json'));
  });

  test('clearChapterHash removes hash while keeping query', () => {
    const captured = { url: null };
    run('clearChapterHash();', {
      window: {
        location: {
          pathname: '/trace',
          search: '?path=sess.json',
          hash: '#chapter-2',
          origin: 'http://localhost',
        },
        addEventListener() {},
        devicePixelRatio: 1,
      },
      history: { replaceState: (_, __, u) => { captured.url = u; } },
    });
    assert.ok(!captured.url.includes('#'));
    assert.ok(captured.url.includes('path=sess.json'));
  });

  test('readUrlState loads tool filters and search query from URL', () => {
    const out = run(
      `
      readUrlState();
      __result = { tools: Array.from(activeToolFilters), q: searchQuery };
    `,
      {
        window: {
          location: {
            pathname: '/trace',
            search: '?tool=Bash,Grep&q=needle',
            hash: '',
            origin: 'http://localhost',
          },
          addEventListener() {},
          devicePixelRatio: 1,
        },
      }
    );
    assert.deepEqual(out.tools, ['Bash', 'Grep']);
    assert.equal(out.q, 'needle');
  });

  test('readUrlState expands chapter from hash', () => {
    const expanded = run(
      `
      readUrlState();
      __result = Array.from(expandedSet);
    `,
      {
        window: {
          location: {
            pathname: '/trace',
            search: '',
            hash: '#chapter-3',
            origin: 'http://localhost',
          },
          addEventListener() {},
          devicePixelRatio: 1,
        },
      }
    );
    assert.deepEqual(expanded, ['ch3']);
  });

  test('readUrlState ignores malformed or non-chapter hashes', () => {
    for (const hash of ['#chapter-abc', '#chapter-', '#other', '#chapter--1']) {
      const expanded = run(
        `
        readUrlState();
        __result = Array.from(expandedSet);
      `,
        {
          window: {
            location: { pathname: '/trace', search: '', hash, origin: 'http://localhost' },
            addEventListener() {},
            devicePixelRatio: 1,
          },
        }
      );
      assert.deepEqual(expanded, [], `hash ${hash} should not expand`);
    }
  });

  test('readUrlState trims tool tokens and skips empty segments', () => {
    const out = run(
      `
      readUrlState();
      __result = Array.from(activeToolFilters);
    `,
      {
        window: {
          location: {
            pathname: '/trace',
            search: '?tool=%20Bash%20,,Grep,',
            hash: '',
            origin: 'http://localhost',
          },
          addEventListener() {},
          devicePixelRatio: 1,
        },
      }
    );
    assert.deepEqual(out, ['Bash', 'Grep']);
  });

  test('readUrlState expands chapter-0 and scrolls target when present', () => {
    const scrollCalls = [];
    const out = run(
      `
      readUrlState();
      __result = Array.from(expandedSet);
    `,
      {
        window: {
          location: {
            pathname: '/trace',
            search: '',
            hash: '#chapter-0',
            origin: 'http://localhost',
          },
          addEventListener() {},
          devicePixelRatio: 1,
        },
        document: {
          getElementById(id) {
            if (id === 'chapter-0') {
              return { scrollIntoView(opts) { scrollCalls.push(opts); } };
            }
            return null;
          },
          createElement: () => ({ addEventListener() {} }),
          createElementNS: () => ({ setAttribute() {}, innerHTML: '' }),
          createTextNode: (t) => ({ textContent: t }),
          body: { style: { fontFamily: 'monospace' } },
        },
      }
    );
    assert.deepEqual(out, ['ch0']);
    assert.equal(scrollCalls.length, 1);
    assert.equal(scrollCalls[0].behavior, 'smooth');
    assert.equal(scrollCalls[0].block, 'start');
  });

  test('readUrlState hydrates hash and filter query together', () => {
    const out = run(
      `
      readUrlState();
      __result = {
        tools: Array.from(activeToolFilters),
        q: searchQuery,
        expanded: Array.from(expandedSet),
      };
    `,
      {
        window: {
          location: {
            pathname: '/trace',
            search: '?tool=Edit&q=refactor',
            hash: '#chapter-5',
            origin: 'http://localhost',
          },
          addEventListener() {},
          devicePixelRatio: 1,
        },
      }
    );
    assert.deepEqual(out.tools, ['Edit']);
    assert.equal(out.q, 'refactor');
    assert.deepEqual(out.expanded, ['ch5']);
  });

  test('readUrlState leaves defaults when search and hash are empty', () => {
    const out = run(
      `
      readUrlState();
      __result = {
        tools: Array.from(activeToolFilters),
        q: searchQuery,
        expanded: Array.from(expandedSet),
      };
    `,
      {
        window: {
          location: { pathname: '/trace', search: '', hash: '', origin: 'http://localhost' },
          addEventListener() {},
          devicePixelRatio: 1,
        },
      }
    );
    assert.deepEqual(out.tools, []);
    assert.equal(out.q, '');
    assert.deepEqual(out.expanded, []);
  });

  test('updateUrl after readUrlState writes filters and keeps chapter hash', () => {
    const captured = { url: null };
    run(
      `
      readUrlState();
      updateUrl();
    `,
      {
        window: {
          location: {
            pathname: '/trace',
            search: '?path=sess.json&tool=Read&q=needle',
            hash: '#chapter-2',
            origin: 'http://localhost',
          },
          addEventListener() {},
          devicePixelRatio: 1,
        },
        history: { replaceState: (_, __, u) => { captured.url = u; } },
      }
    );
    assert.ok(captured.url.includes('path=sess.json'));
    assert.ok(captured.url.includes('tool=Read'));
    assert.ok(captured.url.includes('q=needle') || captured.url.includes('q=needle'));
    assert.ok(captured.url.endsWith('#chapter-2'));
  });

  test('updateUrl omits tool and q after filters cleared post-hydration', () => {
    const captured = { url: null };
    run(
      `
      readUrlState();
      activeToolFilters.clear();
      searchQuery = '';
      updateUrl();
    `,
      {
        window: {
          location: {
            pathname: '/trace',
            search: '?path=sess.json&tool=Bash&q=old',
            hash: '',
            origin: 'http://localhost',
          },
          addEventListener() {},
          devicePixelRatio: 1,
        },
        history: { replaceState: (_, __, u) => { captured.url = u; } },
      }
    );
    assert.ok(captured.url.includes('path=sess.json'));
    assert.ok(!captured.url.includes('tool='));
    assert.ok(!captured.url.includes('q='));
  });

  test('setChapterHash after readUrlState keeps hydrated filters in URL', () => {
    const captured = { url: null };
    run(
      `
      readUrlState();
      setChapterHash(9);
    `,
      {
        window: {
          location: {
            pathname: '/trace',
            search: '?path=sess.json&tool=Grep&q=pattern',
            hash: '',
            origin: 'http://localhost',
          },
          addEventListener() {},
          devicePixelRatio: 1,
        },
        history: { replaceState: (_, __, u) => { captured.url = u; } },
      }
    );
    assert.ok(captured.url.endsWith('#chapter-9'));
    assert.ok(captured.url.includes('tool=Grep'));
    assert.ok(captured.url.includes('q=pattern') || captured.url.includes('q=pattern'));
  });

  test('clearChapterHash after readUrlState retains filter query without hash', () => {
    const captured = { url: null };
    run(
      `
      readUrlState();
      clearChapterHash();
    `,
      {
        window: {
          location: {
            pathname: '/trace',
            search: '?path=sess.json&tool=Write&q=docs',
            hash: '#chapter-1',
            origin: 'http://localhost',
          },
          addEventListener() {},
          devicePixelRatio: 1,
        },
        history: { replaceState: (_, __, u) => { captured.url = u; } },
      }
    );
    assert.ok(!captured.url.includes('#'));
    assert.ok(captured.url.includes('tool=Write'));
    assert.ok(captured.url.includes('q=docs') || captured.url.includes('q=docs'));
  });
});

describe('render-core-shell sumToolCounts', () => {
  test('sums toolCounts via for-in without Object.values', () => {
    assert.equal(run('__result = sumToolCounts({ Bash: 10, Read: 5, Grep: 2 });'), 17);
  });

  test('returns 0 for empty or missing counts', () => {
    assert.equal(run('__result = sumToolCounts({});'), 0);
    assert.equal(run('__result = sumToolCounts(undefined);'), 0);
  });

  test('ignores inherited properties on toolCounts', () => {
    const sum = run(`
      const counts = { Bash: 4 };
      Object.prototype.polluted = 99;
      __result = sumToolCounts(counts);
      delete Object.prototype.polluted;
    `);
    assert.equal(sum, 4);
  });
});

describe('render-core-shell computeSessionGrade', () => {
  test('returns null for empty chapters', () => {
    const grade = run('__result = computeSessionGrade([]);');
    assert.equal(grade, null);
  });

  test('grades clean multi-chapter session highly', () => {
    const grade = run(`
      const chapters = [
        { outcome: 'clean', errors: 0, retries: 0, selfCorrections: 0, gitOps: [], files: {} },
        { outcome: 'clean', errors: 0, retries: 0, selfCorrections: 0, gitOps: [], files: {} },
      ];
      __result = computeSessionGrade(chapters);
    `);
    assert.ok(grade.score >= 80);
    assert.match(grade.letter, /[AB]/);
    assert.equal(grade.factors.length, 5);
  });

  test('penalizes high error and retry ratios', () => {
    const grade = run(`
      session.stats.toolCounts = { Bash: 4 };
      session.stats.totalInputTokens = 1000;
      session.stats.totalCacheHit = 0;
      const chapters = [
        { outcome: 'struggling', errors: 3, retries: 2, selfCorrections: 0, gitOps: [], files: {} },
        { outcome: 'struggling', errors: 2, retries: 1, selfCorrections: 0, gitOps: [], files: {} },
      ];
      __result = computeSessionGrade(chapters);
    `);
    assert.ok(grade.score < 70);
    assert.match(grade.letter, /[DEF]/);
  });

  test('single subagent corrected chapter earns partial quality credit', () => {
    const grade = run(`
      session.stats.toolCounts = { Read: 5 };
      session.stats.totalInputTokens = 50000;
      session.stats.totalCacheHit = 40000;
      const chapters = [
        { outcome: 'corrected', errors: 1, retries: 0, selfCorrections: 1, gitOps: [], files: {} },
      ];
      __result = computeSessionGrade(chapters);
    `);
    assert.ok(grade.factors.find((f) => f.name === 'quality').score >= 70);
    assert.ok(grade.score > 0);
  });

  test('uses neutral cache factor when input tokens below 10k', () => {
    const grade = run(`
      session.stats.toolCounts = { Bash: 2 };
      session.stats.totalInputTokens = 2000;
      session.stats.totalCacheHit = 0;
      const chapters = [
        { outcome: 'clean', errors: 0, retries: 0, selfCorrections: 0, gitOps: [], files: {} },
      ];
      __result = computeSessionGrade(chapters);
    `);
    const cacheFactor = grade.factors.find((f) => f.name === 'cache');
    assert.equal(cacheFactor.score, 75);
  });
});

describe('render-core-shell renderHeader and stats', () => {
  test('renderHeader builds header with session id slice', () => {
    const header = run('__result = renderHeader();');
    assert.equal(header.className, 'header');
    const titleBlock = header.children.find((c) => c.className === 'header-top');
    assert.ok(titleBlock);
    const title = titleBlock.children.find((c) => c.className === 'header-title');
    const idSpan = title.children.find((c) => typeof c === 'object' && c.tagName === 'span');
    assert.equal(idSpan.children?.[0] ?? idSpan.children, 'abcd1234');
  });

  test('renderHeader shows source badge for cursor agents', () => {
    const header = run('__result = renderHeader();', {
      session: {
        sessionId: 'xyz',
        source: 'cursor',
        model: 'cursor',
        cwd: '/x',
        gitBranch: null,
        durationMs: 1000,
        startTime: '2026-01-01T00:00:00.000Z',
        eventCount: 1,
        stats: {
          toolCounts: {},
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheHit: 0,
          errors: 0,
          userMessages: 0,
          assistantTurns: 0,
          tokensEstimated: false,
        },
      },
    });
    const title = header.children
      .find((c) => c.className === 'header-top')
      .children.find((c) => c.className === 'header-title');
    const badge = title.children.find((c) => c.tagName === 'span' && c.children?.[0] === 'cursor');
    assert.ok(badge);
  });

  test('renderHeader export link carries current search params', () => {
    const header = run('__result = renderHeader();');
    const actions = header.children
      .find((c) => c.className === 'header-top')
      .children.find((c) => c.className === 'header-actions');
    const exportBtn = actions.children.find((c) => c.className === 'export-btn');
    assert.equal(exportBtn.href, '/export?path=sess.json&source=claude');
  });

  test('renderStats sums tool calls and marks errors red', () => {
    const bar = run('__result = renderStats();');
    assert.equal(bar.className, 'stats-bar');
    const stats = bar.children.filter((c) => c.className === 'stat');
    const toolStat = stats.find((s) => s.children[1]?.children?.[0] === 'tool calls');
    assert.ok(toolStat);
    assert.equal(toolStat.children[0].children[0], '15');
    const errorStat = stats.find((s) => s.children[0].className.includes('red'));
    assert.ok(errorStat);
    assert.equal(errorStat.children[0].children[0], '1');
  });
});

describe('render-core-shell renderStats VM', () => {
  function statsFromBar(bar) {
    return bar.children.filter((c) => c.className === 'stat');
  }

  function statLabelText(statEl) {
    const raw = statEl.children[1]?.children?.[0];
    return typeof raw === 'string' ? raw : raw?.textContent ?? String(raw);
  }

  function statByLabel(bar, label) {
    return statsFromBar(bar).find((s) => statLabelText(s) === label);
  }

  test('renderStats renders seven stats in prompts-through-errors order', () => {
    const bar = run('__result = renderStats();');
    const labels = statsFromBar(bar).map(statLabelText);
    assert.equal(
      labels.join('|'),
      'prompts|turns|tool calls|input tok|output tok|cache hit|errors'
    );
    assert.equal(statByLabel(bar, 'prompts').children[0].children[0], '3');
    assert.equal(statByLabel(bar, 'turns').children[0].children[0], '3');
  });

  test('renderStats shows em dash for token stats when totals are zero', () => {
    const bar = run('__result = renderStats();', {
      session: {
        sessionId: 'zero-tok',
        source: 'claude',
        model: 'm',
        cwd: '/x',
        gitBranch: null,
        durationMs: 0,
        startTime: null,
        eventCount: 0,
        stats: {
          toolCounts: {},
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheHit: 0,
          errors: 0,
          userMessages: 0,
          assistantTurns: 0,
          tokensEstimated: false,
        },
      },
    });
    assert.equal(statByLabel(bar, 'input tok').children[0].children[0], '—');
    assert.equal(statByLabel(bar, 'output tok').children[0].children[0], '—');
    assert.equal(statByLabel(bar, 'cache hit').children[0].children[0], '—');
    assert.equal(statByLabel(bar, 'tool calls').children[0].children[0], '0');
  });

  test('renderStats shows em dash for zero estimated input tokens (fact 776)', () => {
    const bar = run('__result = renderStats();', {
      session: {
        sessionId: 'cursor-est',
        source: 'cursor',
        model: 'cursor',
        cwd: '/x',
        gitBranch: null,
        durationMs: 0,
        startTime: null,
        eventCount: 1,
        stats: {
          toolCounts: {},
          totalInputTokens: 0,
          totalOutputTokens: 4000,
          totalCacheHit: 0,
          errors: 0,
          userMessages: 1,
          assistantTurns: 1,
          tokensEstimated: true,
        },
      },
    });
    assert.equal(statByLabel(bar, 'input tok').children[0].children[0], '—');
    assert.equal(statByLabel(bar, 'output tok').children[0].children[0], '~4000');
  });

  test('renderStats keeps measured zero-input display when tokens not estimated', () => {
    const bar = run('__result = renderStats();', {
      session: {
        sessionId: 'measured-zero-in',
        source: 'claude',
        model: 'm',
        cwd: '/x',
        gitBranch: null,
        durationMs: 0,
        startTime: null,
        eventCount: 1,
        stats: {
          toolCounts: {},
          totalInputTokens: 0,
          totalOutputTokens: 4000,
          totalCacheHit: 0,
          errors: 0,
          userMessages: 1,
          assistantTurns: 1,
          tokensEstimated: false,
        },
      },
    });
    assert.equal(statByLabel(bar, 'input tok').children[0].children[0], '0');
    assert.equal(statByLabel(bar, 'output tok').children[0].children[0], '4000');
  });

  test('renderStats cache hit percent is rounded with green class', () => {
    const bar = run('__result = renderStats();', {
      session: {
        sessionId: 'cache-pct',
        source: 'claude',
        model: 'm',
        cwd: '/x',
        gitBranch: null,
        durationMs: 0,
        startTime: null,
        eventCount: 1,
        stats: {
          toolCounts: {},
          totalInputTokens: 1000,
          totalOutputTokens: 100,
          totalCacheHit: 333,
          errors: 0,
          userMessages: 0,
          assistantTurns: 0,
          tokensEstimated: false,
        },
      },
    });
    const cacheStat = statByLabel(bar, 'cache hit');
    assert.equal(cacheStat.children[0].children[0], '33%');
    assert.ok(cacheStat.children[0].className.includes('green'));
  });

  test('renderStats omits cache percent when cache or input tokens are zero', () => {
    const noCache = run('__result = renderStats();', {
      session: {
        sessionId: 'no-cache',
        source: 'claude',
        model: 'm',
        cwd: '/x',
        gitBranch: null,
        durationMs: 0,
        startTime: null,
        eventCount: 1,
        stats: {
          toolCounts: {},
          totalInputTokens: 1000,
          totalOutputTokens: 50,
          totalCacheHit: 0,
          errors: 0,
          userMessages: 0,
          assistantTurns: 0,
          tokensEstimated: false,
        },
      },
    });
    assert.equal(statByLabel(noCache, 'cache hit').children[0].children[0], '—');

    const noInput = run('__result = renderStats();', {
      session: {
        sessionId: 'no-input',
        source: 'claude',
        model: 'm',
        cwd: '/x',
        gitBranch: null,
        durationMs: 0,
        startTime: null,
        eventCount: 1,
        stats: {
          toolCounts: {},
          totalInputTokens: 0,
          totalOutputTokens: 50,
          totalCacheHit: 500,
          errors: 0,
          userMessages: 0,
          assistantTurns: 0,
          tokensEstimated: false,
        },
      },
    });
    assert.equal(statByLabel(noInput, 'cache hit').children[0].children[0], '—');
    assert.equal(statByLabel(noInput, 'input tok').children[0].children[0], '0');
    assert.equal(statByLabel(noInput, 'output tok').children[0].children[0], '50');
  });

  test('renderStats prefixes estimated tokens and appends stats-note', () => {
    const bar = run('__result = renderStats();', {
      session: {
        sessionId: 'est-tok',
        source: 'claude',
        model: 'm',
        cwd: '/x',
        gitBranch: null,
        durationMs: 0,
        startTime: null,
        eventCount: 1,
        stats: {
          toolCounts: { Read: 2 },
          totalInputTokens: 1200,
          totalOutputTokens: 300,
          totalCacheHit: 0,
          errors: 0,
          userMessages: 1,
          assistantTurns: 1,
          tokensEstimated: true,
        },
      },
    });
    assert.equal(statByLabel(bar, 'input tok').children[0].children[0], '~1200');
    assert.equal(statByLabel(bar, 'output tok').children[0].children[0], '~300');
    const note = bar.children.find((c) => c.className === 'stats-note');
    assert.ok(note);
    assert.equal(
      note.children[0],
      '~ token counts estimated from content length'
    );
  });

  test('renderStats zero errors omits red class on error stat', () => {
    const bar = run('__result = renderStats();', {
      session: {
        sessionId: 'no-err',
        source: 'claude',
        model: 'm',
        cwd: '/x',
        gitBranch: null,
        durationMs: 0,
        startTime: null,
        eventCount: 1,
        stats: {
          toolCounts: { Bash: 4 },
          totalInputTokens: 100,
          totalOutputTokens: 10,
          totalCacheHit: 0,
          errors: 0,
          userMessages: 2,
          assistantTurns: 2,
          tokensEstimated: false,
        },
      },
    });
    const errorStat = statByLabel(bar, 'errors');
    assert.equal(errorStat.children[0].children[0], '0');
    assert.ok(!errorStat.children[0].className.includes('red'));
    assert.equal(statByLabel(bar, 'tool calls').children[0].children[0], '4');
  });
});

describe('render-core-shell drawTimeline via renderActivityTimeline', () => {
  test('renderActivityTimeline returns empty for sparse events', () => {
    const el = run(`
      events = [
        { type: 'user', timestamp: '2026-01-01T00:00:00.000Z' },
        { type: 'assistant', timestamp: '2026-01-01T00:00:05.000Z' },
      ];
      chapters = [];
      const out = renderActivityTimeline();
      __result = { tag: out.tagName, childCount: out.children.length };
    `);
    assert.equal(el.tag, 'div');
    assert.equal(el.childCount, 0);
  });

  test('renderActivityTimeline builds canvas timeline for long sessions', () => {
    const el = run(`
      events = [
        { type: 'user', timestamp: '2026-01-01T00:00:00.000Z' },
        { type: 'assistant', timestamp: '2026-01-01T00:05:00.000Z' },
        { type: 'tool_use', timestamp: '2026-01-01T00:10:00.000Z' },
      ];
      chapters = [
        { timestamp: '2026-01-01T00:00:00.000Z', endTimestamp: '2026-01-01T00:05:00.000Z', errors: 0, retries: 0, selfCorrections: 0, gitOps: [], files: {} },
        { timestamp: '2026-01-01T00:05:00.000Z', endTimestamp: '2026-01-01T00:10:00.000Z', errors: 0, retries: 0, selfCorrections: 0, gitOps: [], files: {} },
      ];
      const wrap = renderActivityTimeline();
      const canvas = wrap.children.find(function(c) { return c.tagName === 'canvas'; });
      __result = {
        className: wrap.className,
        hasCanvas: !!canvas,
        hasLegend: wrap.children.some(function(c) { return c.className === 'activity-timeline-legend'; }),
        hasTimes: wrap.children.some(function(c) { return c.className === 'activity-timeline-times'; }),
      };
    `);
    assert.equal(el.className, 'activity-timeline');
    assert.ok(el.hasCanvas);
    assert.ok(el.hasLegend);
    assert.ok(el.hasTimes);
  });

  test('drawTimeline invokes setupHiDpiCanvas and paints active segments', () => {
    const { result, hiDpiLog } = runShell(`
      events = [
        { type: 'user', timestamp: '2026-01-01T00:00:00.000Z' },
        { type: 'assistant', timestamp: '2026-01-01T00:00:30.000Z' },
        { type: 'tool_use', timestamp: '2026-01-01T00:01:00.000Z' },
        { type: 'assistant', timestamp: '2026-01-01T00:15:00.000Z' },
      ];
      chapters = [];
      const wrap = renderActivityTimeline();
      const canvas = wrap.children.find(function(c) { return c.tagName === 'canvas'; });
      __result = {
        hiDpi: __hiDpiLog.length,
        fillRects: canvas._ctx.calls.filter(function(c) { return c === 'fillRect'; }).length,
        fills: canvas._ctx.calls.filter(function(c) { return c === 'fill'; }).length,
        strokes: canvas._ctx.calls.filter(function(c) { return c === 'stroke'; }).length,
      };
    `);
    assert.ok(result.hiDpi >= 1);
    assert.ok(result.fillRects >= 1);
    assert.ok(result.fills >= 1);
    assert.ok(result.strokes >= 1);
    assert.equal(hiDpiLog[0].w, 400);
    assert.equal(hiDpiLog[0].h, 48);
  });

  test('drawTimeline labels long idle gaps and registers resize handler', () => {
    let resizeHandler = null;
    const { result } = runShell(
      `
      events = [
        { type: 'user', timestamp: '2026-01-01T00:00:00.000Z' },
        { type: 'assistant', timestamp: '2026-01-01T00:01:00.000Z' },
        { type: 'tool_use', timestamp: '2026-01-01T00:15:00.000Z' },
      ];
      chapters = [];
      const wrap = renderActivityTimeline();
      const canvas = wrap.children.find(function(c) { return c.tagName === 'canvas'; });
      const idleLabels = canvas._ctx.calls.filter(function(c) { return c === 'fillText'; }).length;
      const legend = wrap.children.find(function(c) { return c.className === 'activity-timeline-legend'; });
      __result = {
        idleLabels: idleLabels,
        legendItems: legend.children.length,
        hasIdleLegend: legend.children.some(function(c) {
          return (c.children || []).some(function(x) { return x === 'idle over 5 min'; });
        }),
      };
    `,
      {
        window: {
          location: {
            pathname: '/trace',
            search: '',
            hash: '',
            origin: 'http://localhost',
          },
          addEventListener(ev, fn) {
            if (ev === 'resize') resizeHandler = fn;
          },
          devicePixelRatio: 1,
        },
      }
    );
    assert.ok(result.idleLabels >= 1);
    assert.ok(result.hasIdleLegend);
    assert.ok(typeof resizeHandler === 'function');
    resizeHandler();
    assert.ok(result.legendItems >= 3);
  });

  test('activity timeline canvas exposes keyboard diagnostics and chapter activation', () => {
    const { result } = runShell(`
      var jumpedChapter = -1;
      function jumpToChapter(idx) { jumpedChapter = idx; }
      events = [
        { type: 'user', timestamp: '2026-01-01T00:00:00.000Z' },
        { type: 'assistant', timestamp: '2026-01-01T00:01:00.000Z' },
        { type: 'tool_use', timestamp: '2026-01-01T00:15:00.000Z' },
      ];
      chapters = [
        { timestamp: '2026-01-01T00:00:00.000Z', endTimestamp: '2026-01-01T00:01:00.000Z', errors: 0, retries: 0, selfCorrections: 0, gitOps: [], files: {} },
        { timestamp: '2026-01-01T00:15:00.000Z', endTimestamp: '2026-01-01T00:15:00.000Z', errors: 0, retries: 0, selfCorrections: 0, gitOps: [], files: {} },
      ];
      const wrap = renderActivityTimeline();
      const canvas = wrap.children.find(function(c) { return c.tagName === 'canvas'; });
      const tooltip = wrap.children.find(function(c) { return c.className === 'activity-timeline-tooltip'; });
      const prevented = [];
      canvas._handlers.focus();
      const focusText = tooltip.textContent;
      canvas._handlers.keydown({ key: 'ArrowRight', preventDefault: function() { prevented.push('right1'); } });
      canvas._handlers.keydown({ key: 'ArrowRight', preventDefault: function() { prevented.push('right2'); } });
      const idleText = tooltip.textContent;
      canvas._handlers.keydown({ key: 'End', preventDefault: function() { prevented.push('end'); } });
      const endText = tooltip.textContent;
      canvas._handlers.keydown({ key: 'Enter', preventDefault: function() { prevented.push('enter'); } });
      __result = {
        tabIndex: canvas.tabIndex,
        role: canvas.getAttribute('role'),
        label: canvas.getAttribute('aria-label'),
        describedBy: canvas.getAttribute('aria-describedby'),
        tooltipId: tooltip.getAttribute('id'),
        tooltipRole: tooltip.getAttribute('role'),
        focusText: focusText,
        idleText: idleText,
        endText: endText,
        jumpedChapter: jumpedChapter,
        prevented: prevented,
      };
    `);
    assert.equal(result.tabIndex, 0);
    assert.equal(result.role, 'button');
    assert.match(result.label, /Activity timeline/);
    assert.equal(result.describedBy, 'activity-timeline-tooltip');
    assert.equal(result.tooltipId, 'activity-timeline-tooltip');
    assert.equal(result.tooltipRole, 'status');
    assert.match(result.focusText, /ch 1/);
    assert.match(result.idleText, /idle gap \(14m\)/);
    assert.match(result.endText, /ch 2/);
    assert.equal(result.jumpedChapter, 1);
    assert.deepEqual(Array.from(result.prevented), ['right1', 'right2', 'end', 'enter']);
  });

  test('renderSessionSummary prepends grade block for graded chapters', () => {
    const summary = run(`
      chapters = [
        { outcome: 'clean', errors: 0, retries: 0, selfCorrections: 0, gitOps: [], files: {} },
        { outcome: 'clean', errors: 0, retries: 0, selfCorrections: 0, gitOps: [], files: {} },
      ];
      __result = renderSessionSummary();
    `);
    assert.equal(summary.className, 'session-summary');
    const grade = summary.children.find((c) => c.className === 'session-grade');
    assert.ok(grade);
    const letter = grade.children.find((c) => c.className?.includes('session-grade-letter'));
    assert.ok(letter);
    assert.match(letter.children[0], /[A-F]/);
  });
});
