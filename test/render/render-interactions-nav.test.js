import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { chapterFileKeys, chapterToolKeys } from '../../src/chapters/chapter-keys.js';
import { INTERACTIONS_NAV_JS } from '../../src/render/render-interactions-nav.js';
import { INTERACTIONS_JS } from '../../src/render/render-interactions.js';
import { buildRenderScript } from '../../src/render/render-assemble.js';
import { formatDuration, fmtTokens, fmtMcpName } from '../../src/filter/filter-formats.js';
import { shortToolPath } from '../../src/parse/parse-utils.js';

const FORMAT_DURATION_SRC = formatDuration.toString().replace(/^export /, '');
const FMT_TOKENS_SRC = fmtTokens.toString().replace(/^export /, '');
const FMT_MCP_NAME_SRC = fmtMcpName.toString().replace(/^export /, '');
const SHORT_TOOL_PATH_SRC = shortToolPath.toString().replace(/^export /, '');

function makeChapter(overrides = {}) {
  return {
    prompt: 'Fix auth module\nextra context',
    toolCounts: { Bash: 3, Read: 2 },
    errors: 0,
    files: {},
    mcpOps: [],
    timestamp: '2026-01-01T00:00:00.000Z',
    endTimestamp: '2026-01-01T00:05:00.000Z',
    tokens: { input: 1000, output: 500 },
    deps: { fixesFrom: [], continuesFrom: [] },
    outcome: 'clean',
    efficiency: null,
    ...overrides,
  };
}

function makeClassList(owner) {
  const parts = () => new Set(owner.className.split(/\s+/).filter(Boolean));
  return {
    add(cls) {
      const s = parts();
      s.add(cls);
      owner.className = [...s].join(' ');
    },
    remove(cls) {
      const s = parts();
      s.delete(cls);
      owner.className = [...s].join(' ');
    },
    contains(cls) {
      return parts().has(cls);
    },
  };
}

function createNavDom(opts = {}) {
  const {
    chapterCount = 3,
    hiddenIndices = [],
    windowSize = { w: 1024, h: 768 },
    anchorRect = { left: 100, right: 200, top: 50, bottom: 80, width: 100 },
  } = opts;

  const registry = new Map();
  const chapterEls = [];
  const listeners = { keydown: [], scroll: [] };
  const pendingTimeouts = [];
  let tooltipNode = null;

  function makeEl(id, extra = {}) {
    const el = {
      _id: id || '',
      tagName: extra.tagName || 'DIV',
      className: extra.className || '',
      style: { left: '', top: '' },
      innerHTML: '',
      offsetHeight: extra.offsetHeight ?? 140,
      scrollIntoViewCalls: 0,
      _handlers: {},
      _attrs: {},
      hidden: false,
      type: extra.type,
      get id() {
        return this._id;
      },
      set id(v) {
        if (this._id) registry.delete(this._id);
        this._id = String(v || '');
        if (this._id) registry.set(this._id, this);
      },
      scrollIntoView() {
        this.scrollIntoViewCalls++;
      },
      addEventListener(type, fn) {
        if (!this._handlers[type]) {
          const list = [];
          const call = function (...args) {
            for (const f of list) f.apply(this, args);
          };
          call._list = list;
          this._handlers[type] = call;
        }
        const holder = this._handlers[type];
        if (holder._list) holder._list.push(fn);
      },
      getAttribute(name) {
        if (name === 'type' && this.type != null) return this.type;
        if (name === 'id') return this.id || null;
        if (name === 'hidden') return this.hidden ? '' : null;
        return this._attrs[name] ?? null;
      },
      setAttribute(name, value) {
        this._attrs[name] = String(value);
        if (name === 'type') this.type = String(value);
        if (name === 'id') this.id = value;
        if (name === 'hidden') this.hidden = true;
      },
      hasAttribute(name) {
        if (name === 'hidden') return !!this.hidden;
        if (name === 'id') return !!this.id;
        if (name === 'type') return this.type != null;
        return Object.prototype.hasOwnProperty.call(this._attrs, name);
      },
      click() {
        if (typeof this._handlers.click === 'function') this._handlers.click({ type: 'click', target: this, preventDefault() {} });
      },
      getBoundingClientRect: () => ({ ...anchorRect }),
      blur() {
        this._blurred = true;
      },
      focus() {
        this._focused = true;
      },
      ...extra,
    };
    el.classList = makeClassList(el);
    if (id) {
      el._id = id;
      registry.set(id, el);
    }
    return el;
  }

  for (let i = 0; i < chapterCount; i++) {
    const cls = ['chapter', hiddenIndices.includes(i) ? 'filter-hidden' : ''].filter(Boolean).join(' ');
    const el = makeEl('chapter-' + i, { className: cls });
    chapterEls.push(el);
  }

  const searchInput = makeEl('', { className: 'filter-search', tagName: 'INPUT', type: 'text', value: '' });
  const bodyChildren = [];
  const body = {
    tagName: 'BODY',
    className: '',
    appendChild(node) {
      bodyChildren.push(node);
      return node;
    },
  };
  body.classList = makeClassList(body);

  const document = {
    __keydownListeners: listeners.keydown,
    body,
    activeElement: null,
    getElementById: (id) => registry.get(id) || null,
    querySelector(sel) {
      if (sel === '.filter-search') return searchInput;
      if (sel && sel.startsWith('#') && registry.has(sel.slice(1))) return registry.get(sel.slice(1));
      if (sel && sel.startsWith('[data-hotkey-scope=')) return null;
      if (sel === '[data-hotkey]') {
        const out = [];
        if (searchInput.hasAttribute('data-hotkey')) out.push(searchInput);
        for (const n of bodyChildren) if (n && typeof n.hasAttribute === 'function' && n.hasAttribute('data-hotkey')) out.push(n);
        return out[0] || null;
      }
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '.chapter') return chapterEls;
      if (sel === '[data-hotkey]') {
        const out = [];
        if (searchInput.hasAttribute('data-hotkey')) out.push(searchInput);
        for (const n of bodyChildren) if (n && typeof n.hasAttribute === 'function' && n.hasAttribute('data-hotkey')) out.push(n);
        return out;
      }
      return [];
    },
    createElement(tag) {
      const el = makeEl('', {
        tagName: tag.toUpperCase(),
        className: tag.toLowerCase() === 'div' ? 'chapter-tooltip' : '',
        offsetHeight: 150,
      });
      if (tag === 'div') tooltipNode = el;
      return el;
    },
    addEventListener(type, fn) {
      if (type === 'keydown') listeners.keydown.push(fn);
    },
  };

  const window = {
    innerWidth: windowSize.w,
    innerHeight: windowSize.h,
    __scrollListeners: listeners.scroll,
    addEventListener(type, fn) {
      if (type === 'scroll') listeners.scroll.push(fn);
    },
  };

  return {
    registry,
    chapterEls,
    searchInput,
    listeners,
    pendingTimeouts,
    get tooltip() {
      return tooltipNode || bodyChildren.find((n) => n.className.includes('chapter-tooltip')) || null;
    },
    dispatchKeydown(key, extra = {}) {
      const ev = {
        key,
        target: extra.target || document.activeElement || body,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        _prevented: false,
        _stopped: false,
        _immediate: false,
        get defaultPrevented() {
          return this._prevented;
        },
        preventDefault() {
          this._prevented = true;
        },
        stopPropagation() {
          this._stopped = true;
        },
        stopImmediatePropagation() {
          this._stopped = true;
          this._immediate = true;
        },
        ...extra,
      };
      if (ev.target == null) ev.target = body;
      for (const fn of listeners.keydown) {
        fn(ev);
        if (ev._stopped || ev._immediate) break;
      }
      return ev;
    },
    dispatchScroll() {
      for (const fn of listeners.scroll) fn();
    },
    flushTooltipTimer() {
      for (const fn of pendingTimeouts.splice(0)) fn();
    },
    document,
    window,
  };
}

function runNav(body, sandbox = {}) {
  const dom = sandbox.__dom || createNavDom(sandbox.__domOpts || {});
  const chapters = sandbox.chapters ?? [makeChapter(), makeChapter(), makeChapter()];
  const script = new Script(`
    let expandedSet = new Set();
    var searchQuery = '';
    var renderCalls = 0;
    var applyFiltersCalls = 0;
    function render() { renderCalls++; }
    function applyFilters() { applyFiltersCalls++; }
    function getChapters() { return chapters; }
    function setChapterHash(i) { __hash = 'chapter-' + i; }
    function clearChapterHash() { __hash = ''; }
    function esc(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    ${FMT_TOKENS_SRC}
    ${FMT_MCP_NAME_SRC}
    ${FORMAT_DURATION_SRC}
    ${SHORT_TOOL_PATH_SRC}
    ${chapterFileKeys.toString().replace(/^export /, '')}
    ${chapterToolKeys.toString().replace(/^export /, '')}
    ${INTERACTIONS_NAV_JS}
    ${body}
  `);

  const ctx = {
    Object,
    Array,
    String,
    Math,
    Date,
    Set,
    chapters,
    document: dom.document,
    window: dom.window,
    requestAnimationFrame: (fn) => fn(),
    setTimeout(fn, ms) {
      if (ms === 300) {
        dom.pendingTimeouts.push(fn);
        return dom.pendingTimeouts.length;
      }
      fn();
      return 0;
    },
    clearTimeout() {},
    __result: undefined,
    __hash: '',
    __dom: dom,
    ...sandbox,
  };
  ctx.document.activeElement = ctx.document.activeElement ?? null;
  script.runInNewContext(ctx);
  return { ...ctx, dom };
}

describe('render-interactions-nav VM', () => {
  test('getTooltipEl reuses a single chapter-tooltip on document.body', () => {
    const ctx = runNav(`
      const a = getTooltipEl();
      const b = getTooltipEl();
      __result = a === b && a.className === 'chapter-tooltip';
    `);
    assert.ok(ctx.__result);
    assert.ok(ctx.dom.tooltip);
  });

  test('showChapterTooltip renders prompt, tools, errors, and outcome', () => {
    const chapters = [
      makeChapter({
        prompt: 'Long prompt line that should truncate after eighty characters in the tooltip preview area',
        toolCounts: { Bash: 5, Read: 1, Grep: 2 },
        errors: 2,
        files: { '/proj/src/a.js': true, '/proj/src/b.js': true },
        outcome: 'retry',
      }),
    ];
    const { dom } = runNav('showChapterTooltip(0, document.getElementById("chapter-0"));', {
      chapters,
      __domOpts: { chapterCount: 1 },
    });
    const html = dom.tooltip.innerHTML;
    assert.ok(html.includes('chapter-tooltip-prompt'));
    assert.ok(html.includes('Long prompt'));
    assert.ok(html.includes('chapter-tooltip-tools'));
    assert.ok(html.includes('chapter-tooltip-label">errors'));
    assert.ok(html.includes('retry'));
    assert.ok(html.includes('2 file'));
  });

  test('showChapterTooltip includes MCP summary, duration, tokens, and fixes', () => {
    const chapters = [
      makeChapter({
        mcpOps: [{ server: 'playwright' }, { server: 'playwright' }, { server: 'git' }],
        deps: { fixesFrom: [0, 2], continuesFrom: [] },
        efficiency: { isWasteful: true, score: 42 },
      }),
    ];
    const { dom } = runNav(
      'showChapterTooltip(0, document.getElementById("chapter-0"));',
      { chapters, __domOpts: { chapterCount: 1 } }
    );
    const html = dom.tooltip.innerHTML;
    assert.ok(html.includes('chapter-tooltip-label">MCP'));
    assert.ok(html.includes('playwright'));
    assert.ok(html.includes('chapter-tooltip-label">duration'));
    assert.ok(html.includes('chapter-tooltip-label">tokens'));
    assert.ok(html.includes('chapter-tooltip-label">fixes'));
    assert.ok(html.includes('ch 1, 3'));
    assert.ok(html.includes('efficiency'));
    assert.ok(html.includes('42/100'));
  });

  test('showChapterTooltip flips above anchor when below viewport', () => {
    const { dom } = runNav(
      'showChapterTooltip(0, document.getElementById("chapter-0"));',
      {
        chapters: [makeChapter()],
        __domOpts: {
          chapterCount: 1,
          windowSize: { w: 400, h: 200 },
          anchorRect: { left: 10, right: 110, top: 150, bottom: 180, width: 100 },
        },
      }
    );
    const top = parseInt(dom.tooltip.style.top, 10);
    assert.ok(top < 150, `expected tooltip above anchor, got top=${top}`);
    assert.ok(dom.tooltip.classList.contains('visible'));
  });

  test('showChapterTooltip clamps horizontal position inside viewport', () => {
    const { dom } = runNav(
      'showChapterTooltip(0, document.getElementById("chapter-0"));',
      {
        chapters: [makeChapter()],
        __domOpts: {
          chapterCount: 1,
          windowSize: { w: 320, h: 600 },
          anchorRect: { left: 280, right: 310, top: 40, bottom: 70, width: 30 },
        },
      }
    );
    const left = parseInt(dom.tooltip.style.left, 10);
    assert.equal(left, 8, 'clamps from anchor+40 to minimum 8px inset');
  });

  test('hideChapterTooltip clears visible state and pending timer', () => {
    const ctx = runNav(`
      showChapterTooltip(0, document.getElementById('chapter-0'));
      hideChapterTooltip();
      __result = !tooltipVisible && !getTooltipEl().classList.contains('visible');
    `, { chapters: [makeChapter()], __domOpts: { chapterCount: 1 } });
    assert.ok(ctx.__result);
  });

  test('attachChapterTooltips shows tooltip after hover delay when not expanded', () => {
    const { dom } = runNav(`
      attachChapterTooltips();
      const el = document.getElementById('chapter-0');
      el._handlers.mouseenter();
    `, { chapters: [makeChapter()], __domOpts: { chapterCount: 1 } });
    assert.ok(!dom.tooltip?.classList.contains('visible'));
    dom.flushTooltipTimer();
    assert.ok(dom.tooltip.classList.contains('visible'));
  });

  test('attachChapterTooltips skips tooltip for expanded chapters', () => {
    const ctx = runNav(`
      const el = document.getElementById('chapter-0');
      el.classList.add('expanded');
      attachChapterTooltips();
      el._handlers.mouseenter();
    `, { chapters: [makeChapter()], __domOpts: { chapterCount: 1 } });
    ctx.dom.flushTooltipTimer();
    assert.ok(!ctx.dom.tooltip?.classList.contains('visible'));
  });

  test('scroll listener hides tooltip when visible', () => {
    const ctx = runNav(`
      showChapterTooltip(0, document.getElementById('chapter-0'));
      const before = tooltipVisible;
      for (const fn of window.__scrollListeners) fn();
      __result = { before, after: tooltipVisible };
    `, { chapters: [makeChapter()], __domOpts: { chapterCount: 1 } });
    assert.equal(ctx.__result.before, true);
    assert.equal(ctx.__result.after, false);
  });

  test('getVisibleChapterIndices skips filter-hidden chapters', () => {
    const visible = runNav('__result = getVisibleChapterIndices();', {
      chapters: [makeChapter(), makeChapter(), makeChapter()],
      __domOpts: { chapterCount: 3, hiddenIndices: [1] },
    }).__result;
    assert.deepEqual([...visible], [0, 2]);
  });

  test('setFocusedChapter toggles kb-focused and scrolls target', () => {
    const ctx = runNav(`
      setFocusedChapter(1);
      const focused1 = document.getElementById('chapter-1').classList.contains('kb-focused');
      setFocusedChapter(2);
      __result = {
        focused1,
        unfocused1: !document.getElementById('chapter-1').classList.contains('kb-focused'),
        focused2: document.getElementById('chapter-2').classList.contains('kb-focused'),
      };
    `, { __domOpts: { chapterCount: 3 } });
    assert.ok(ctx.__result.focused1);
    assert.ok(ctx.__result.unfocused1);
    assert.ok(ctx.__result.focused2);
    assert.equal(ctx.dom.chapterEls[1].scrollIntoViewCalls, 1);
    assert.equal(ctx.dom.chapterEls[2].scrollIntoViewCalls, 1);
  });

  test('clearFocus removes keyboard focus state', () => {
    const ctx = runNav(`
      setFocusedChapter(0);
      clearFocus();
      __result = !document.getElementById('chapter-0').classList.contains('kb-focused');
    `, { __domOpts: { chapterCount: 2 } });
    assert.ok(ctx.__result);
  });

  test("keydown 'j' focuses first visible chapter", () => {
    const { dom } = runNav('', { __domOpts: { chapterCount: 3 } });
    const ev = dom.dispatchKeydown('j');
    assert.ok(ev._prevented);
    assert.ok(dom.chapterEls[0].classList.contains('kb-focused'));
  });

  test("keydown 'k' focuses last visible chapter when starting unfocused", () => {
    const { dom } = runNav('', { __domOpts: { chapterCount: 3, hiddenIndices: [1] } });
    dom.dispatchKeydown('k');
    assert.ok(dom.chapterEls[2].classList.contains('kb-focused'));
  });

  test("keydown 'j' and 'k' walk visible chapters", () => {
    const { dom } = runNav('', { __domOpts: { chapterCount: 3 } });
    dom.dispatchKeydown('j');
    dom.dispatchKeydown('j');
    assert.ok(dom.chapterEls[1].classList.contains('kb-focused'));
    dom.dispatchKeydown('k');
    assert.ok(dom.chapterEls[0].classList.contains('kb-focused'));
  });

  test("keydown Enter expands focused chapter and sets hash", () => {
    const ctx = runNav(`
      function fireKey(key) {
        const ev = { key, target: document.body, preventDefault() {} };
        for (const fn of document.__keydownListeners) fn(ev);
      }
      fireKey('j');
      fireKey('Enter');
      __result = {
        expanded: expandedSet.has('ch0'),
        hash: __hash,
        renderCalls,
      };
    `, { __domOpts: { chapterCount: 2 } });
    assert.ok(ctx.__result.expanded);
    assert.equal(ctx.__result.hash, 'chapter-0');
    assert.equal(ctx.__result.renderCalls, 1);
  });

  test("keydown 'o' collapses expanded focused chapter", () => {
    const ctx = runNav(`
      function fireKey(key) {
        const ev = { key, target: document.body, preventDefault() {} };
        for (const fn of document.__keydownListeners) fn(ev);
      }
      expandedSet.add('ch0');
      fireKey('j');
      fireKey('o');
      __result = { expanded: expandedSet.has('ch0'), hash: __hash };
    `, { __domOpts: { chapterCount: 2 } });
    assert.ok(!ctx.__result.expanded);
    assert.equal(ctx.__result.hash, '');
  });

  test("keydown '/' focuses filter search input", () => {
    const { dom } = runNav('', { __domOpts: { chapterCount: 1 } });
    const ev = dom.dispatchKeydown('/');
    assert.ok(ev._prevented);
    assert.ok(dom.searchInput._focused);
  });

  test('keydown Escape in search clears query and blurs input', () => {
    const ctx = runNav(`
      searchQuery = 'needle';
      const searchInput = document.querySelector('.filter-search');
      searchInput.value = 'needle';
      document.activeElement = searchInput;
      const ev = { key: 'Escape', _prevented: false, preventDefault() { this._prevented = true; } };
      for (const fn of document.__keydownListeners) fn(ev);
      __result = {
        searchQuery,
        value: searchInput.value,
        blurred: searchInput._blurred,
        applyFiltersCalls,
        prevented: ev._prevented,
      };
    `, { __domOpts: { chapterCount: 1 } });
    assert.ok(ctx.__result.blurred);
    assert.equal(ctx.__result.searchQuery, '');
    assert.equal(ctx.__result.value, '');
    assert.ok(ctx.__result.applyFiltersCalls >= 1);
    assert.ok(!ctx.__result.prevented);
  });

  test('keydown ignored while search focused except Escape', () => {
    const { dom } = runNav('', { __domOpts: { chapterCount: 2 } });
    dom.document.activeElement = dom.searchInput;
    const ev = dom.dispatchKeydown('j');
    assert.ok(!ev._prevented);
    assert.ok(!dom.chapterEls[0].classList.contains('kb-focused'));
  });

  test("keydown ignored while a generic input is focused — typing /ojkg?x inserts those characters into the field", () => {
    const field = {
      tagName: 'INPUT',
      type: 'text',
      value: '',
      isContentEditable: false,
      getAttribute(name) {
        return name === 'type' ? this.type : null;
      },
    };
    const ctx = runNav(`
      for (const fn of document.__keydownListeners) fn({ key: 'j', target: document.body, preventDefault() { this._prevented = true; } });
      const field = __field;
      document.activeElement = field;
      const typed = '/ojkg?x';
      const prevented = [];
      for (const key of typed) {
        const ev = { key, target: field, _prevented: false, preventDefault() { this._prevented = true; } };
        for (const fn of document.__keydownListeners) fn(ev);
        if (ev._prevented) prevented.push(key);
        else field.value += key;
      }
      __result = {
        value: field.value,
        prevented,
        expanded: expandedSet.has('ch0'),
        searchFocused: document.querySelector('.filter-search')._focused,
        ch0: document.getElementById('chapter-0').classList.contains('kb-focused'),
        ch1: document.getElementById('chapter-1').classList.contains('kb-focused'),
      };
    `, { __domOpts: { chapterCount: 3 }, __field: field });
    assert.equal(String(ctx.__result.prevented || []), '');
    assert.equal(ctx.__result.value, '/ojkg?x');
    assert.ok(!ctx.__result.expanded, 'o/Enter must not toggle the focused chapter');
    assert.ok(!ctx.__result.searchFocused, '/ must not steal focus to chapter search');
    assert.ok(ctx.__result.ch0, 'j/k must not move chapter focus');
    assert.ok(!ctx.__result.ch1);
  });

  test('chapter j/k/o/Enter and slash-to-search do not run when a textarea, select, or contenteditable is focused', () => {
    const { dom } = runNav('', { __domOpts: { chapterCount: 3 } });
    dom.dispatchKeydown('j');
    const fields = [
      { tagName: 'TEXTAREA', value: '', type: '', isContentEditable: false },
      { tagName: 'SELECT', value: '', type: '', isContentEditable: false },
      { tagName: 'DIV', value: '', type: '', isContentEditable: true, textContent: '' },
    ];
    for (const field of fields) {
      field.getAttribute = function getAttribute(name) {
        return name === 'type' ? this.type : null;
      };
      field.value = '';
      if (field.isContentEditable) field.textContent = '';
      dom.document.activeElement = field;
      for (const key of '/ojkg?x') {
        const ev = dom.dispatchKeydown(key, { target: field });
        assert.ok(!ev._prevented, `${field.tagName} must keep '${key}'`);
        if (field.isContentEditable) field.textContent += key;
        else field.value += key;
      }
      const got = field.isContentEditable ? field.textContent : field.value;
      assert.equal(got, '/ojkg?x', `${field.tagName} value`);
    }
    assert.ok(!dom.searchInput._focused);
    assert.ok(dom.chapterEls[0].classList.contains('kb-focused'), 'form field must not walk chapters');
    assert.ok(!dom.chapterEls[1].classList.contains('kb-focused'));
  });

  test('idle / on a rendered session focuses .filter-search even if every chapter is hidden', () => {
    const { dom } = runNav('', { __domOpts: { chapterCount: 3, hiddenIndices: [0, 1, 2] } });
    const ev = dom.dispatchKeydown('/');
    assert.ok(ev._prevented);
    assert.ok(dom.searchInput._focused);
    const cmdSlash = dom.dispatchKeydown('/', { metaKey: true });
    assert.ok(!cmdSlash._prevented, 'Cmd+/ must not steal as slash-to-search');
  });

  test('idle j/k on a rendered session move chapter kb-focused', () => {
    const { dom } = runNav('', { __domOpts: { chapterCount: 3 } });
    dom.dispatchKeydown('j');
    assert.ok(dom.chapterEls[0].classList.contains('kb-focused'));
    dom.dispatchKeydown('j');
    assert.ok(dom.chapterEls[1].classList.contains('kb-focused'));
    assert.ok(!dom.chapterEls[0].classList.contains('kb-focused'));
    dom.dispatchKeydown('K');
    assert.ok(dom.chapterEls[0].classList.contains('kb-focused'));
    assert.ok(!dom.chapterEls[1].classList.contains('kb-focused'));
  });

  test('idle o or Enter toggles the kb-focused chapter', () => {
    const ctx = runNav(`
      function fireKey(key) {
        const ev = { key, target: document.body, preventDefault() {} };
        for (const fn of document.__keydownListeners) fn(ev);
      }
      fireKey('j');
      fireKey('o');
      const afterO = expandedSet.has('ch0');
      fireKey('Enter');
      const afterEnter = expandedSet.has('ch0');
      fireKey('O');
      __result = { afterO, afterEnter, afterO2: expandedSet.has('ch0') };
    `, { __domOpts: { chapterCount: 2 } });
    assert.equal(ctx.__result.afterO, true, 'o expands');
    assert.equal(ctx.__result.afterEnter, false, 'Enter collapses');
    assert.equal(ctx.__result.afterO2, true, 'O expands again');
  });

  test('idle Escape clears chapter kb-focused; Escape in chapter search still clears and unfocuses', () => {
    const { dom } = runNav('', { __domOpts: { chapterCount: 2 } });
    dom.dispatchKeydown('j');
    assert.ok(dom.chapterEls[0].classList.contains('kb-focused'));
    dom.dispatchKeydown('Escape');
    assert.ok(!dom.chapterEls[0].classList.contains('kb-focused'));

    const ctx = runNav(`
      searchQuery = 'needle';
      const searchInput = document.querySelector('.filter-search');
      searchInput.value = 'needle';
      document.activeElement = searchInput;
      for (const fn of document.__keydownListeners) fn({ key: 'Escape', target: searchInput, preventDefault() {} });
      __result = {
        searchQuery,
        value: searchInput.value,
        blurred: searchInput._blurred,
        applyFiltersCalls,
      };
    `, { __domOpts: { chapterCount: 1 } });
    assert.ok(ctx.__result.blurred);
    assert.equal(ctx.__result.searchQuery, '');
    assert.equal(ctx.__result.value, '');
    assert.ok(ctx.__result.applyFiltersCalls >= 1);
  });

  test('idle shortcuts fire when a button, link, or checkbox is focused — those are not text form fields', () => {
    const { dom } = runNav('', { __domOpts: { chapterCount: 3 } });
    const button = {
      tagName: 'BUTTON',
      type: 'button',
      isContentEditable: false,
      getAttribute(name) {
        if (name === 'type') return this.type;
        if (name === 'role') return 'button';
        return null;
      },
    };
    const link = {
      tagName: 'A',
      type: '',
      isContentEditable: false,
      getAttribute() { return null; },
    };
    const checkbox = {
      tagName: 'INPUT',
      type: 'checkbox',
      isContentEditable: false,
      getAttribute(name) { return name === 'type' ? this.type : null; },
    };

    for (const control of [button, link, checkbox]) {
      dom.document.activeElement = control;
      dom.dispatchKeydown('Escape', { target: control });
      for (const el of dom.chapterEls) el.classList.remove('kb-focused');
      dom.searchInput._focused = false;
      const slash = dom.dispatchKeydown('/', { target: control });
      assert.ok(slash._prevented, `${control.tagName} / should focus search`);
      assert.ok(dom.searchInput._focused, `${control.tagName} / focused .filter-search`);
      dom.searchInput._focused = false;

      const j = dom.dispatchKeydown('j', { target: control });
      assert.ok(j._prevented, `${control.tagName} j should walk chapters`);
      assert.ok(dom.chapterEls[0].classList.contains('kb-focused'), `${control.tagName} j focused chapter 0`);
    }

    const enterOnButton = dom.dispatchKeydown('Enter', { target: button });
    assert.ok(!enterOnButton._prevented, 'Enter on a button must not steal native activation');
    const oOnButton = dom.dispatchKeydown('o', { target: button });
    assert.ok(oOnButton._prevented, 'o on a button still toggles the kb-focused chapter');
  });

  test('keydown ignored while CommandPalette is open', () => {
    const { dom } = runNav('', { __domOpts: { chapterCount: 3 } });
    const cmdkInput = {
      id: 'cmdkInput',
      tagName: 'INPUT',
      value: '',
      focus() { this._focused = true; },
    };
    dom.document.activeElement = cmdkInput;
    dom.document.body.classList.add('cmdk-open');

    for (const key of ['/', 'o', 'j', 'k', 'g', '?', 'x']) {
      const ev = dom.dispatchKeydown(key, { target: cmdkInput });
      assert.ok(!ev._prevented, `chapter nav must not preventDefault '${key}' while cmdk-open`);
    }
    assert.ok(!dom.searchInput._focused, '/ must not steal focus to chapter search');
    assert.ok(!dom.chapterEls[0].classList.contains('kb-focused'), 'j/k must not walk chapters');
    assert.ok(!dom.chapterEls[2].classList.contains('kb-focused'), 'k must not focus last chapter');
  });
});

describe('render-interactions-nav bundle contract', () => {
  test('nav module exposes tooltip and keyboard helpers in VM', () => {
    const ctx = runNav(
      '__result = { tt: typeof attachChapterTooltips, show: typeof showChapterTooltip, focus: typeof setFocusedChapter };',
      { __domOpts: { chapterCount: 1 } },
    );
    assert.equal(ctx.__result.tt, 'function');
    assert.equal(ctx.__result.show, 'function');
    assert.equal(ctx.__result.focus, 'function');
  });

  test('showChapterTooltip uses cached chapter keys instead of Object.keys on toolCounts/files', () => {
    const chapters = [
      makeChapter({
        _toolKeys: ['Bash', 'Read'],
        toolCounts: { Bash: 2, Read: 1 },
        _fileKeys: ['src/a.js'],
        files: { 'src/a.js': true },
        mcpOps: [{ server: 'playwright' }],
      }),
    ];
    const { dom } = runNav('showChapterTooltip(0, document.getElementById("chapter-0"));', {
      chapters,
      __domOpts: { chapterCount: 1 },
    });
    assert.ok(dom.tooltip.innerHTML.includes('Bash'));
    assert.ok(dom.tooltip.innerHTML.includes('playwright'));
  });

  test('INTERACTIONS_JS composes expand toggles with nav helpers in VM', () => {
    const script = new Script(`
      ${INTERACTIONS_JS}
      ({
        expand: typeof attachExpandToggles,
        tooltip: typeof attachChapterTooltips,
        focus: typeof setFocusedChapter,
      });
    `);
    const ctx = {
      Object,
      Array,
      String,
      Math,
      Set,
      document: {
        body: { appendChild() {} },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        getElementById() { return null; },
        createElement() {
          return {
            setAttribute() {},
            getAttribute() { return null; },
            addEventListener() {},
          };
        },
        addEventListener() {},
      },
      window: {
        innerWidth: 1024,
        innerHeight: 768,
        addEventListener() {},
      },
      chapters: [],
      expandedSet: new Set(),
      searchQuery: '',
      hiddenChapters: new Set(),
      renderCalls: 0,
      applyFiltersCalls: 0,
    };
    const result = script.runInNewContext(ctx);
    assert.equal(result.expand, 'function');
    assert.equal(result.tooltip, 'function');
    assert.equal(result.focus, 'function');
  });

  test('assembled RENDER bundle defines interaction helpers exactly once', () => {
    const bundle = buildRenderScript();
    for (const name of ['attachExpandToggles', 'attachChapterTooltips', 'setFocusedChapter']) {
      const count = (bundle.match(new RegExp(`function ${name}\\b`, 'g')) || []).length;
      assert.equal(count, 1, `${name} should appear once in RENDER bundle`);
    }
  });
});