import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { UI_CHAPTERS_JS } from '../src/render/render-ui-chapters.js';
import { UI_JS, RENDER_JS } from '../src/render/render-assemble.js';
import { CHAPTERS_JS } from '../src/render/render-chapters.js';
import { renderHTML } from '../src/render.js';
import {
  fmtTokens,
  fmtPct,
  formatDuration,
  fmtMcpName,
} from '../src/filter/filter-formats.js';
import { chapterToolKeys } from '../src/chapters/chapter-keys.js';
import { countGitOpsOfType } from '../src/chapters/chapter-quality.js';
import { countWords, countWordsInStrings } from '../src/parse/parse-utils.js';

function countFunctionDef(src, name) {
  const re = new RegExp(`function ${name}\\b`, 'g');
  return (src.match(re) || []).length;
}

function probeUiChapterFns(bundle, ctx) {
  const body = `${bundle}\n({ renderFilterBar: typeof renderFilterBar, applyFilters: typeof applyFilters, renderChapters: typeof renderChapters })`;
  return new Script(body).runInNewContext(ctx);
}

const FMT_TOKENS_SRC = fmtTokens.toString().replace(/^export /, '');
const FMT_PCT_SRC = fmtPct.toString().replace(/^export /, '');
const FORMAT_DURATION_SRC = formatDuration.toString().replace(/^export /, '');
const FMT_MCP_NAME_SRC = fmtMcpName.toString().replace(/^export /, '');
const COUNT_GIT_OPS_OF_TYPE_SRC = countGitOpsOfType.toString().replace(/^export /, '');
const COUNT_WORDS_SRC = countWords.toString().replace(/^export /, '');
const COUNT_WORDS_IN_STRINGS_SRC = countWordsInStrings.toString().replace(/^export /, '');
const CHAPTER_TOOL_KEYS_SRC = chapterToolKeys.toString().replace(/^export /, '');

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

const FORMAT_TIME_STUB = `
  function formatTime(iso) {
    return new Date(iso).toISOString().slice(11, 16);
  }
`;

function createMockDocument(registry = new Map()) {
  function makeNode(tag, text) {
    const node = {
      tagName: text ? '#TEXT' : (tag || '').toUpperCase(),
      className: '',
      style: {},
      childNodes: [],
      attributes: {},
      dataset: {},
      parentNode: null,
      nodeValue: text,
      value: '',
      _text: text != null ? String(text) : '',
      get textContent() {
        if (text != null) return String(text);
        if (this._text) return this._text;
        return this.childNodes.map((c) => c.textContent).join('');
      },
      set textContent(v) {
        this._text = String(v);
      },
      appendChild(child) {
        this.childNodes.push(child);
        child.parentNode = this;
        return child;
      },
      addEventListener() {},
      classList: {
        _owner: null,
        add(cls) {
          const parts = new Set(this._owner.className.split(/\\s+/).filter(Boolean));
          parts.add(cls);
          this._owner.className = [...parts].join(' ');
        },
        remove(cls) {
          const parts = new Set(this._owner.className.split(/\\s+/).filter(Boolean));
          parts.delete(cls);
          this._owner.className = [...parts].join(' ');
        },
        toggle(cls, force) {
          const has = this._owner.className.split(/\\s+/).includes(cls);
          if (force === true || (force === undefined && !has)) this.add(cls);
          else this.remove(cls);
        },
      },
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
      querySelectorAll(sel) {
        const cls = sel.startsWith('.') ? sel.slice(1) : null;
        const hits = [];
        const walk = (n) => {
          if (cls && n.className && n.className.split(' ').includes(cls)) hits.push(n);
          for (const c of n.childNodes) walk(c);
        };
        walk(this);
        return hits;
      },
      scrollIntoView() {},
    };
    node.classList._owner = node;
    return node;
  }

  const body = makeNode('body');
  return {
    body,
    createElement: (tag) => makeNode(tag),
    createTextNode: (t) => makeNode(null, t),
    getElementById: (id) => registry.get(id) || null,
    querySelectorAll(sel) {
      return body.querySelectorAll(sel);
    },
  };
}

function collectClassNames(node) {
  const names = [];
  if (node.className) names.push(...node.className.split(/\s+/).filter(Boolean));
  for (const c of node.childNodes) names.push(...collectClassNames(c));
  return names;
}

function findByClass(node, cls) {
  if (!node) return [];
  const hits = [];
  if (node.className && node.className.split(/\s+/).includes(cls)) hits.push(node);
  for (const c of node.childNodes || []) hits.push(...findByClass(c, cls));
  return hits;
}

function listChapterFixture() {
  return {
    prompt: 'Fix the chapter list UI',
    outcome: 'corrected',
    timestamp: '2026-01-01T00:00:00.000Z',
    endTimestamp: '2026-01-01T00:05:00.000Z',
    turns: 3,
    toolCounts: { Read: 2, Bash: 1 },
    _toolKeys: ['Read', 'Bash'],
    _fileKeys: [],
    retries: 1,
    selfCorrections: 1,
    efficiency: { isWasteful: true, wasteTokens: 5000 },
    deps: { fixesFrom: [0], continuesFrom: [], sharedFiles: {} },
    gitOps: [{ type: 'commit' }],
    mcpOps: [{ server: 'my_server', tool: 'run' }],
    tokens: { input: 1000, output: 200, cacheHit: 500 },
    thinking: ['one two three'],
    commands: [],
    searches: [],
    agents: [],
    diffs: [],
    webOps: [],
    _promptLower: 'fix the chapter list ui',
    _lastAssistantTextLower: '',
    _fileKeysLower: [],
    _charBits: new Uint32Array(8),
    _tokenBigrams: new Set(),
    _extraChars: new Set(),
  };
}

function runRenderChapters(chapters, expandedKeys = []) {
  const document = createMockDocument();
  const script = new Script(`
    let expandedSet = new Set(${JSON.stringify(expandedKeys)});
    ${FMT_TOKENS_SRC}
    ${FMT_PCT_SRC}
    ${FORMAT_DURATION_SRC}
    ${FMT_MCP_NAME_SRC}
    ${COUNT_GIT_OPS_OF_TYPE_SRC}
    ${COUNT_WORDS_SRC}
    ${COUNT_WORDS_IN_STRINGS_SRC}
    ${FORMAT_TIME_STUB}
    ${H_HELPER_SRC}
    ${CHAPTER_TOOL_KEYS_SRC}
    function getChapters() { return chapters; }
    function buildChapterDetail() {}
    function clearChapterHash() {}
    function setChapterHash() {}
    function getPermalink(i) { return 'https://example.com#ch' + i; }
    function render() {}
    ${UI_CHAPTERS_JS}
    renderChapters();
  `);
  return script.runInNewContext({
    chapters,
    document,
    navigator: { clipboard: null },
    Object,
    Array,
    String,
    Math,
    Date,
    Set,
  });
}

function runRenderFilterBar(chapters, opts = {}) {
  const document = createMockDocument();
  const script = new Script(`
    let activeToolFilters = new Set();
    let searchQuery = '';
    let wasteFilterActive = false;
    let activeToolPerfFilter = null;
    let applyFiltersCalls = 0;
    function applyFilters() { applyFiltersCalls++; }
    ${FMT_MCP_NAME_SRC}
    ${H_HELPER_SRC}
    ${CHAPTER_TOOL_KEYS_SRC}
    function getChapters() { return chapters; }
    ${UI_CHAPTERS_JS}
    const bar = renderFilterBar();
    [bar, applyFiltersCalls];
  `);
  return script.runInNewContext({
    chapters,
    document,
    Object,
    Array,
    String,
    Set,
  });
}

function runApplyFilters(chapters, filterState) {
  const registry = new Map();
  const document = createMockDocument(registry);
  for (let i = 0; i < chapters.length; i++) {
    const el = document.createElement('div');
    el.id = 'chapter-' + i;
    registry.set('chapter-' + i, el);
  }
  const countEl = document.createElement('span');
  countEl.id = 'filter-count';
  registry.set('filter-count', countEl);

  const script = new Script(`
    ${CHAPTER_TOOL_KEYS_SRC}
    ${CHAPTERS_JS}
    activeToolFilters = new Set(${JSON.stringify([...filterState.toolFilters])});
    searchQuery = ${JSON.stringify(filterState.searchQuery || '')};
    wasteFilterActive = ${!!filterState.wasteFilterActive};
    let updateUrlCalls = 0;
    function updateUrl() { updateUrlCalls++; }
    function getChapters() { return chapters; }
    ${UI_CHAPTERS_JS}
    applyFilters();
    [registry.get('chapter-0').className, registry.get('chapter-1').className, countEl.textContent, updateUrlCalls];
  `);
  return script.runInNewContext({
    chapters,
    registry,
    countEl,
    document,
    Object,
    Array,
    String,
    Set,
    Uint32Array,
  });
}

describe('render-ui-chapters module', () => {
  test('UI_CHAPTERS_JS VM exposes chapter list UI builders', () => {
    const ctx = {
      Object,
      Array,
      String,
      Set,
      document: { getElementById: () => null, querySelectorAll: () => [] },
      getChapters: () => [],
      updateUrl() {},
      applyFilters() {},
      activeToolFilters: new Set(),
      searchQuery: '',
      wasteFilterActive: false,
      activeToolPerfFilter: null,
      expandedSet: new Set(),
      h() {},
      fmtMcpName: (n) => n,
      formatTime: () => '',
      chapterMatchesFilter: () => true,
      render() {},
      clearChapterHash() {},
      setChapterHash() {},
      getPermalink: () => '',
    };
    const probe = probeUiChapterFns(UI_CHAPTERS_JS, ctx);
    assert.equal(probe.renderFilterBar, 'function');
    assert.equal(probe.applyFilters, 'function');
    assert.equal(probe.renderChapters, 'function');
  });

  test('UI_JS and RENDER_JS define chapter list UI exactly once', () => {
    for (const name of ['renderFilterBar', 'applyFilters', 'renderChapters']) {
      assert.equal(countFunctionDef(UI_JS, name), 1, `${name} should appear once in UI_JS`);
      assert.equal(countFunctionDef(RENDER_JS, name), 1, `${name} should appear once in RENDER_JS`);
    }
  });

  test('renderFilterBar builds tool chips, wasteful chip, and search input', () => {
    const chapters = [
      { toolCounts: { Read: 2, Bash: 1 }, _toolKeys: ['Read', 'Bash'], efficiency: { isWasteful: true } },
      { toolCounts: { Grep: 1 }, _toolKeys: ['Grep'], efficiency: { isWasteful: false } },
    ];
    const [bar] = runRenderFilterBar(chapters);
    const classes = collectClassNames(bar);
    assert.ok(classes.includes('filter-bar'));
    assert.ok(classes.includes('filter-tools'));
    assert.ok(classes.includes('filter-chip'));
    assert.ok(classes.includes('filter-search'));
    assert.ok(bar.textContent.includes('wasteful 1'));
    assert.ok(bar.textContent.includes('Read'));
  });

  test('renderFilterBar uses accessible button chips and a labelled search input', () => {
    const chapters = [
      { toolCounts: { Read: 2, Bash: 1 }, _toolKeys: ['Read', 'Bash'], efficiency: { isWasteful: true } },
    ];
    const [bar] = runRenderFilterBar(chapters);
    const chips = findByClass(bar, 'filter-chip');
    assert.ok(chips.length >= 3);
    for (const chip of chips) {
      assert.equal(chip.tagName, 'BUTTON');
      assert.equal(chip.attributes.type, 'button');
      assert.equal(chip.attributes['aria-pressed'], 'false');
      assert.ok(chip.attributes['aria-label']);
    }
    const search = findByClass(bar, 'filter-search')[0];
    assert.equal(search.tagName, 'INPUT');
    assert.equal(search.attributes['aria-label'], 'Search chapters');
    assert.equal(search.attributes['aria-describedby'], 'filter-count');
    const count = findByClass(bar, 'filter-count')[0];
    assert.equal(count.attributes.role, 'status');
    assert.equal(count.attributes['aria-live'], 'polite');
  });

  test('renderChapters orders tool chips by descending toolCounts', () => {
    const ch = listChapterFixture();
    ch.toolCounts = { Read: 1, Bash: 5, Grep: 2 };
    ch._toolKeys = ['Read', 'Bash', 'Grep'];
    const wrap = runRenderChapters([ch]);
    const text = wrap.textContent;
    const bashPos = text.indexOf('Bash 5');
    const grepPos = text.indexOf('Grep 2');
    const readPos = text.indexOf('Read 1');
    assert.ok(bashPos >= 0 && grepPos >= 0 && readPos >= 0);
    assert.ok(bashPos < grepPos && grepPos < readPos, 'tool chips should sort by count descending');
  });

  test('renderFilterBar lists non-priority tools by descending aggregate count', () => {
    const chapters = [
      { toolCounts: { CustomA: 1, CustomB: 9 }, _toolKeys: ['CustomA', 'CustomB'], efficiency: null },
      { toolCounts: { CustomA: 2 }, _toolKeys: ['CustomA'], efficiency: null },
    ];
    const [bar] = runRenderFilterBar(chapters);
    const text = bar.textContent;
    const bPos = text.indexOf('CustomB');
    const aPos = text.indexOf('CustomA');
    assert.ok(bPos >= 0 && aPos >= 0);
    assert.ok(bPos < aPos, 'non-priority filter chips should sort by aggregate count descending');
  });

  test('renderChapters builds chapter cards with tool chips and pattern badges', () => {
    const wrap = runRenderChapters([listChapterFixture()]);
    const classes = collectClassNames(wrap);
    assert.ok(classes.includes('chapters'));
    assert.ok(classes.includes('chapter'));
    assert.ok(classes.includes('chapter-tools'));
    assert.ok(classes.includes('ch-tool'));
    assert.ok(classes.includes('chapter-pattern-badge'));
    assert.ok(classes.includes('chapter-waste-badge'));
    assert.ok(classes.includes('chapter-dep-badge'));
    assert.ok(wrap.textContent.includes('Fix the chapter list UI'));
    assert.ok(wrap.textContent.includes('Read 2'));
    assert.ok(wrap.textContent.includes('fixes ch 1'));
  });

  test('renderChapters uses button semantics for jump and permalink controls', () => {
    const wrap = runRenderChapters([listChapterFixture()]);
    const depBadge = findByClass(wrap, 'chapter-dep-badge')[0];
    assert.equal(depBadge.tagName, 'BUTTON');
    assert.equal(depBadge.attributes.type, 'button');
    assert.equal(depBadge.attributes['aria-label'], 'Jump to chapter 1 fixed by this chapter');
    const permalink = findByClass(wrap, 'chapter-permalink')[0];
    assert.equal(permalink.tagName, 'BUTTON');
    assert.equal(permalink.attributes.type, 'button');
    assert.equal(permalink.attributes['aria-label'], 'Copy link to chapter 1');
  });

  test('applyFilters toggles filter-hidden and updates filter-count', () => {
    const ch0 = {
      toolCounts: { Read: 1 },
      _toolKeys: ['Read'],
      efficiency: { isWasteful: false },
      _promptLower: 'alpha',
      _lastAssistantTextLower: '',
      _fileKeysLower: [],
      _charBits: new Uint32Array(8),
    _tokenBigrams: new Set(),
    _extraChars: new Set(),
      commands: [],
      searches: [],
      agents: [],
      diffs: [],
    };
    const ch1 = { ...ch0, toolCounts: { Bash: 1 }, _toolKeys: ['Bash'], _promptLower: 'beta' };
    const [cls0, cls1, countText, urlCalls] = runApplyFilters(
      [ch0, ch1],
      { toolFilters: ['Read'], searchQuery: '', wasteFilterActive: false }
    );
    assert.ok(!cls0.includes('filter-hidden'), 'Read chapter should stay visible');
    assert.ok(cls1.includes('filter-hidden'), 'non-matching chapter should hide');
    assert.equal(countText, '1/2');
    assert.equal(urlCalls, 1);
  });

  test('renderHTML splices pre-assembled RENDER_JS with chapter list UI', () => {
    const session = {
      sessionId: 'chapters-split-test',
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
    assert.ok(!html.includes('joinBundleParts'), 'viewer HTML should not join bundle segments at runtime');
  });
});
