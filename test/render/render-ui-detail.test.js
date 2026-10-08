import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { chapterFileKeys } from '../../src/chapters/chapter-keys.js';
import { UI_DETAIL_JS } from '../../src/render/render-ui-detail.js';
import { fmtTokens, fmtCost, estimateChapterTokenCost, getModelRates } from '../../src/filter/filter-formats.js';
import {
  INDEX_OF_LOWER_JS,
  includesLower,
  countWords,
  countWordsInStrings,
  safeSlice,
  joinFirstLines,
} from '../../src/parse/parse-utils.js';
import { renderHTML } from '../../src/render.js';

const FMT_TOKENS_SRC = fmtTokens.toString().replace(/^export /, '');
const FMT_COST_SRC = fmtCost.toString().replace(/^export /, '');
const ESTIMATE_CHAPTER_TOKEN_COST_SRC = estimateChapterTokenCost.toString().replace(/^export /, '');
const INCLUDES_LOWER_SRC = `${INDEX_OF_LOWER_JS}\n${includesLower.toString().replace(/^export /, '')}`;
const GET_MODEL_RATES_SRC = getModelRates.toString().replace(/^export /, '');
const COUNT_WORDS_SRC = countWords.toString().replace(/^export /, '');
const COUNT_WORDS_IN_STRINGS_SRC = countWordsInStrings.toString().replace(/^export /, '');
const SAFE_SLICE_SRC = safeSlice.toString().replace(/^export /, '');
const JOIN_FIRST_LINES_SRC = joinFirstLines.toString().replace(/^export /, '');
const CHAPTER_FILE_KEYS_SRC = chapterFileKeys.toString().replace(/^export /, '');

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

const DETAIL_VM_PREAMBLE = `
  const session = { model: 'claude-3-5-sonnet-20241022' };
  ${INCLUDES_LOWER_SRC}
  ${GET_MODEL_RATES_SRC}
  ${FMT_TOKENS_SRC}
  ${FMT_COST_SRC}
  ${ESTIMATE_CHAPTER_TOKEN_COST_SRC}
  ${COUNT_WORDS_SRC}
  ${COUNT_WORDS_IN_STRINGS_SRC}
  ${SAFE_SLICE_SRC}
  ${JOIN_FIRST_LINES_SRC}
  ${CHAPTER_FILE_KEYS_SRC}
  ${H_HELPER_SRC}
  ${UI_DETAIL_JS}
`;

function createMockDocument(registry = new Map()) {
  function makeNode(tag, text) {
    const node = {
      tagName: text ? '#TEXT' : (tag || '').toUpperCase(),
      className: '',
      style: {},
      childNodes: [],
      attributes: {},
      parentNode: null,
      nodeValue: text,
      get textContent() {
        if (text != null) return String(text);
        return this.childNodes.map((c) => c.textContent).join('');
      },
      appendChild(child) {
        this.childNodes.push(child);
        child.parentNode = this;
        return child;
      },
      addEventListener() {},
      setAttribute(k, v) {
        if (k === 'class') this.className = v;
        else this.attributes[k] = v;
      },
      querySelector(sel) {
        const cls = sel.startsWith('.') ? sel.slice(1) : null;
        const walk = (n) => {
          if (cls && n.className && n.className.split(' ').includes(cls)) return n;
          for (const c of n.childNodes) {
            const hit = walk(c);
            if (hit) return hit;
          }
          return null;
        };
        return walk(this);
      },
    };
    return node;
  }

  return {
    createElement: (tag) => makeNode(tag),
    createTextNode: (t) => makeNode(null, t),
    getElementById: (id) => registry.get(id) || null,
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

function mockWindow() {
  const listeners = {};
  return {
    addEventListener(type, fn) {
      listeners[type] = listeners[type] || [];
      listeners[type].push(fn);
    },
    listeners,
  };
}

function runDetailVm(body, sandbox = {}) {
  const document = sandbox.document || createMockDocument(sandbox.registry);
  const window = sandbox.window || mockWindow();
  const script = new Script(`${DETAIL_VM_PREAMBLE}\n${body}`);
  const ctx = {
    Object,
    Array,
    String,
    Math,
    document,
    window,
    __result: undefined,
    ...sandbox,
  };
  script.runInNewContext(ctx);
  return ctx;
}

function runBuildChapterDetail(ch, idx = 0, sandbox = {}) {
  const ctx = runDetailVm(`
    var detail = h('div', { className: 'chapter-detail' });
    buildChapterDetail(ch, idx, detail);
    __result = detail;
  `, { ch, idx, ...sandbox });
  return ctx.__result;
}

function richChapterFixture() {
  return {
    outcome: 'corrected',
    retries: 2,
    selfCorrections: 1,
    retryGroups: [{ tool: 'Bash', count: 2, input: 'npm test' }],
    deps: {
      fixesFrom: [0],
      continuesFrom: [],
      sharedFiles: { 0: ['src/a.js', 'src/b.js'] },
    },
    efficiency: {
      isWasteful: true,
      score: 35,
      tokPerFile: 600000,
      tokPerCommit: 1200000,
      errorTokens: 5000,
      wasteTokens: 8000,
      wasteReasons: ['high read volume'],
    },
    files: { 'src/foo.js': { ops: ['Read', 'Edit'], output: 'read output' } },
    gitOps: [{ type: 'commit', hash: 'abc1234', message: 'fix things' }],
    agents: [{
      description: 'explore codebase',
      prompt: 'find patterns',
      subagentType: 'explore',
      toolName: 'Agent',
      completed: true,
      isError: false,
      result: 'done\\nline2',
    }],
    diffs: [{
      name: 'Edit',
      path: 'src/foo.js',
      diffInfo: { oldStr: 'old', newStr: 'new', content: '' },
    }],
    searches: [{ query: 'pattern', matches: 3, ok: true, output: 'line1\\nline2' }],
    webOps: [{
      type: 'fetch',
      ok: true,
      url: 'https://example.com/doc',
      pageTitle: 'Example',
      prompt: 'summarize',
      preview: 'preview text',
    }],
    mcpOps: [{
      server: 'my_server',
      tool: 'run_tool',
      ok: true,
      params: { path: '/tmp/x' },
      output: 'mcp ok',
    }],
    commands: [{ cmd: 'npm test', ok: true, output: 'ok\\nall passed' }],
    tokens: { input: 12000, output: 3000, cacheHit: 4000, cacheWrite: 0 },
    thinking: ['first thought block', 'second block'],
    lastAssistantText: 'Summary response for the chapter.',
  };
}

function emptyChapter(overrides = {}) {
  return {
    outcome: 'clean',
    retries: 0,
    selfCorrections: 0,
    retryGroups: [],
    files: {},
    gitOps: [],
    agents: [],
    diffs: [],
    searches: [],
    webOps: [],
    mcpOps: [],
    commands: [],
    tokens: { input: 0, output: 0, cacheHit: 0, cacheWrite: 0 },
    thinking: [],
    lastAssistantText: '',
    ...overrides,
  };
}

describe('render-ui-detail VM', () => {
  test('buildChapterDetail formats file op counts from cached _fileKeys', () => {
    const detail = runBuildChapterDetail(emptyChapter({
      _fileKeys: ['src/foo.js'],
      files: { 'src/foo.js': { ops: ['Read', 'Read', 'Edit'] } },
    }));
    const ops = findByClass(detail, 'chapter-file-ops')[0];
    assert.ok(ops);
    assert.equal(ops.textContent, 'read \u00d72, edit');
  });

  test('UI_DETAIL_JS exposes buildChapterDetail and expandAllChapterDetails in VM', () => {
    const ctx = runDetailVm('__result = { build: typeof buildChapterDetail, expand: typeof expandAllChapterDetails };');
    assert.equal(ctx.__result.build, 'function');
    assert.equal(ctx.__result.expand, 'function');
  });

  test('related chapter links are accessible native buttons', () => {
    const detail = runBuildChapterDetail(emptyChapter({
      deps: {
        fixesFrom: [0],
        continuesFrom: [1],
        sharedFiles: { 0: ['src/a.js'], 1: ['src/b.js'] },
      },
    }));
    const links = findByClass(detail, 'chapter-dep-link');
    assert.equal(links.length, 2);
    assert.equal(links[0].tagName, 'BUTTON');
    assert.equal(links[0].attributes.type, 'button');
    assert.equal(links[0].attributes['aria-label'], 'Jump to chapter 1 fixed by this chapter');
    assert.equal(links[1].tagName, 'BUTTON');
    assert.equal(links[1].attributes.type, 'button');
    assert.equal(links[1].attributes['aria-label'], 'Jump to chapter 2 continued by this chapter');
  });

  test('buildChapterDetail renders quality, deps, efficiency, files, git, agents, diffs, searches, web, mcp, commands, tokens, thinking, and response sections', () => {
    const detail = runBuildChapterDetail(richChapterFixture(), 1);
    const classes = collectClassNames(detail);
    const expected = [
      'chapter-quality',
      'chapter-dep-section',
      'chapter-efficiency',
      'chapter-files',
      'chapter-git-ops',
      'chapter-agents',
      'chapter-diffs',
      'chapter-commands',
      'chapter-web',
      'chapter-mcp',
      'chapter-token-detail',
      'chapter-thinking',
      'chapter-response',
    ];
    for (const cls of expected) {
      assert.ok(classes.includes(cls), 'missing section class: ' + cls);
    }
    assert.ok(detail.textContent.includes('self-corrected'));
    assert.ok(detail.textContent.includes('fixes ch 1'));
    assert.ok(detail.textContent.includes('src/foo.js'));
    assert.ok(detail.textContent.includes('integrations'));
    assert.ok(detail.textContent.includes('Summary response'));
  });

  test('buildChapterDetail omits optional sections for a minimal clean chapter', () => {
    const detail = runBuildChapterDetail(emptyChapter());
    assert.equal(detail.childNodes.length, 0, 'minimal chapter should leave detail container empty');
  });

  test('struggling outcome uses struggling label and outcome class', () => {
    const detail = runBuildChapterDetail(emptyChapter({
      outcome: 'struggling',
      retries: 3,
      retryGroups: [{ tool: 'Read', count: 3, input: '' }],
    }));
    const label = findByClass(detail, 'chapter-quality-label')[0];
    assert.ok(label);
    assert.equal(label.textContent, 'struggling');
    assert.ok(label.className.includes('struggling'));
  });

  test('continuesFrom dependency renders continues-ch link with shared files', () => {
    const detail = runBuildChapterDetail(emptyChapter({
      deps: {
        fixesFrom: [],
        continuesFrom: [2],
        sharedFiles: { 2: ['lib/x.ts', 'lib/y.ts', 'lib/z.ts', 'lib/w.ts'] },
      },
    }));
    assert.ok(detail.textContent.includes('continues ch 3'));
    assert.ok(detail.textContent.includes('lib/x.ts, lib/y.ts, lib/z.ts +1'));
    assert.equal(findByClass(detail, 'chapter-dep-section').length, 1);
  });

  test('skips efficiency section when score is high and chapter is not wasteful', () => {
    const detail = runBuildChapterDetail(emptyChapter({
      efficiency: {
        isWasteful: false,
        score: 85,
        tokPerFile: 0,
        tokPerCommit: 0,
        errorTokens: 0,
        wasteTokens: 0,
        wasteReasons: [],
      },
    }));
    assert.equal(findByClass(detail, 'chapter-efficiency').length, 0);
  });

  test('moderate efficiency score uses eff-ok bar class and moderate label', () => {
    const detail = runBuildChapterDetail(emptyChapter({
      efficiency: {
        isWasteful: false,
        score: 55,
        tokPerFile: 1000,
        tokPerCommit: 0,
        errorTokens: 0,
        wasteTokens: 0,
        wasteReasons: [],
      },
    }));
    assert.ok(detail.textContent.includes('low efficiency'));
    const bar = findByClass(detail, 'chapter-efficiency-bar')[0];
    assert.ok(bar.className.includes('eff-ok'));
    assert.equal(bar.style.width, '55%');
  });

  test('git push op renders remote and branch in description', () => {
    const detail = runBuildChapterDetail(emptyChapter({
      gitOps: [{ type: 'push', remote: 'origin', branch: 'main', tags: true }],
    }));
    assert.ok(detail.textContent.includes('push origin main --tags'));
    const icon = findByClass(detail, 'chapter-git-op-icon')[0];
    assert.ok(icon.className.includes('push'));
  });

  test('failed agent uses fail status class and error icon', () => {
    const detail = runBuildChapterDetail(emptyChapter({
      agents: [{
        description: 'broken subagent',
        completed: false,
        isError: true,
        toolName: 'Agent',
      }],
    }));
    const status = findByClass(detail, 'chapter-agent-status')[0];
    assert.ok(status.className.includes('fail'));
    assert.equal(status.textContent, '\u2717');
  });

  test('web search op renders query, result count, and result links', () => {
    const detail = runBuildChapterDetail(emptyChapter({
      webOps: [{
        type: 'search',
        ok: true,
        query: 'tracequest patterns',
        resultCount: 2,
        results: [
          { title: 'Result A', url: 'https://example.com/a' },
          { title: 'Result B', url: 'https://example.com/b' },
        ],
      }],
    }));
    assert.ok(detail.textContent.includes('tracequest patterns'));
    assert.ok(detail.textContent.includes('2 results'));
    assert.ok(detail.textContent.includes('Result A'));
    assert.equal(findByClass(detail, 'chapter-web-result').length, 2);
  });

  test('failed MCP op adds mcp-error class on the card', () => {
    const detail = runBuildChapterDetail(emptyChapter({
      mcpOps: [{
        server: 'bad_srv',
        tool: 'fail_call',
        ok: false,
        params: {},
        output: 'boom',
      }],
    }));
    const card = findByClass(detail, 'chapter-mcp-op')[0];
    assert.ok(card.className.includes('mcp-error'));
    assert.ok(detail.textContent.includes('bad srv'));
  });

  test('more than six diffs appends truncated more-changes footer', () => {
    const diffs = [];
    for (let i = 0; i < 8; i++) {
      diffs.push({
        name: 'Edit',
        path: 'src/f' + i + '.js',
        diffInfo: { oldStr: 'a', newStr: 'b', content: '' },
      });
    }
    const detail = runBuildChapterDetail(emptyChapter({ diffs }));
    assert.ok(detail.textContent.includes('2 more changes'));
    assert.equal(findByClass(detail, 'chapter-diff-header').length, 7);
  });

  test('token breakdown includes cache read and estimated cost', () => {
    const detail = runBuildChapterDetail(emptyChapter({
      tokens: { input: 5000, output: 2000, cacheHit: 9000, cacheWrite: 1000 },
    }));
    assert.ok(detail.textContent.includes('cache read:'));
    assert.ok(detail.textContent.includes('cache write:'));
    assert.equal(findByClass(detail, 'chapter-token-cost').length, 1);
  });

  test('thinking section truncates beyond three blocks with more footer', () => {
    const detail = runBuildChapterDetail(emptyChapter({
      thinking: ['one', 'two', 'three', 'four', 'five'],
    }));
    assert.equal(findByClass(detail, 'chapter-thinking-block').length, 3);
    assert.ok(detail.textContent.includes('2 more thinking blocks'));
    assert.ok(detail.textContent.includes('5 blocks'));
  });

  test('expandAllChapterDetails populates lazy chapter-detail nodes and calls attachExpandToggles', () => {
    const registry = new Map();
    const document = createMockDocument(registry);
    const chapterEl = document.createElement('div');
    chapterEl.id = 'chapter-0';
    const detail = document.createElement('div');
    detail.className = 'chapter-detail';
    chapterEl.appendChild(detail);
    registry.set('chapter-0', chapterEl);

    const ctx = runDetailVm(`
      function getChapters() { return [ch]; }
      function attachExpandToggles() { calls.n++; }
      expandAllChapterDetails();
      __result = [detail.childNodes.length, calls.n];
    `, {
      ch: richChapterFixture(),
      detail,
      calls: { n: 0 },
      document,
      registry,
    });

    const [populated, toggleCalls] = ctx.__result;
    assert.ok(populated > 0, 'expandAllChapterDetails should populate empty .chapter-detail');
    assert.equal(toggleCalls, 1, 'expandAllChapterDetails should invoke attachExpandToggles once');
  });

  test('beforeprint listener expands empty chapter details', () => {
    const registry = new Map();
    const document = createMockDocument(registry);
    const chapterEl = document.createElement('div');
    chapterEl.id = 'chapter-0';
    const detail = document.createElement('div');
    detail.className = 'chapter-detail';
    chapterEl.appendChild(detail);
    registry.set('chapter-0', chapterEl);
    const window = mockWindow();

    runDetailVm(`
      function getChapters() { return [ch]; }
      function attachExpandToggles() {}
    `, { ch: richChapterFixture(), document, registry, window });

    assert.equal(window.listeners.beforeprint?.length, 1);
    window.listeners.beforeprint[0]();
    assert.ok(detail.childNodes.length > 0, 'beforeprint should populate chapter detail');
  });

  test('renderHTML viewer bundle defines chapter detail helpers once', () => {
    const session = {
      sessionId: 'detail-split-test',
      source: 'claude',
      cwd: '/tmp',
      model: 'claude-3-5-sonnet',
      startTime: '2026-01-01T00:00:00.000Z',
      endTime: '2026-01-01T00:01:00.000Z',
      durationMs: 60000,
      eventCount: 2,
      events: [
        { type: 'user', text: 'hello', timestamp: '2026-01-01T00:00:00.000Z' },
        { type: 'assistant', text: 'hi', timestamp: '2026-01-01T00:00:30.000Z' },
      ],
      stats: {
        toolCounts: {},
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheHit: 0,
        errors: 0,
        userMessages: 1,
        assistantTurns: 1,
        tokensEstimated: false,
      },
    };
    const html = renderHTML(session);
    const scriptBody = html.match(/<script>([\s\S]*)<\/script>/);
    assert.ok(scriptBody);
    const viewerJs = scriptBody[1];
    assert.equal((viewerJs.match(/function buildChapterDetail\b/g) || []).length, 1);
    assert.equal((viewerJs.match(/function expandAllChapterDetails\b/g) || []).length, 1);
    assert.match(viewerJs, /chapter-efficiency-bar/);
  });
});
