import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { INTERACTIONS_JS } from '../../src/render/render-interactions.js';
import { INTERACTIONS_NAV_JS } from '../../src/render/render-interactions-nav.js';

const EXPAND_TOGGLES_JS = INTERACTIONS_JS.slice(0, INTERACTIONS_JS.length - INTERACTIONS_NAV_JS.length);

const STANDALONE_SELECTOR =
  '.chapter-output, .chapter-agent-prompt, .chapter-thinking-block, .chapter-mcp-output';

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

function makeBlock(className, opts = {}) {
  const {
    scrollHeight = 200,
    clientHeight = 80,
    nextSibling = null,
    children = [],
  } = opts;
  const parentChildren = [];
  const block = {
    className,
    scrollHeight,
    clientHeight,
    nextElementSibling: nextSibling,
    parentNode: {
      children: parentChildren,
      insertBefore(node, ref) {
        const at =
          ref == null
            ? parentChildren.length
            : Math.max(0, parentChildren.indexOf(ref));
        parentChildren.splice(at, 0, node);
        node.parentNode = this;
        if (at > 0) {
          const prev = parentChildren[at - 1];
          prev.nextElementSibling = node;
        }
        if (at + 1 < parentChildren.length) {
          node.nextElementSibling = parentChildren[at + 1];
        } else {
          node.nextElementSibling = null;
        }
      },
    },
    _handlers: {},
    addEventListener(type, fn) {
      this._handlers[type] = fn;
    },
    querySelectorAll(sel) {
      if (sel === '.chapter-diff-del, .chapter-diff-add') return children;
      return [];
    },
  };
  block.classList = makeClassList(block);
  for (const child of children) {
    child.parentNode = block;
  }
  parentChildren.push(block);
  return block;
}

function makeToggle(existing = false) {
  const toggle = {
    className: 'expand-toggle',
    textContent: '',
    attributes: {},
    _handlers: {},
    addEventListener(type, fn) {
      this._handlers[type] = fn;
    },
    setAttribute(k, v) {
      this.attributes[k] = v;
    },
  };
  toggle.classList = makeClassList(toggle);
  if (existing) toggle.classList.add('expand-toggle');
  return toggle;
}

function makeDiffChild(opts = {}) {
  const child = makeBlock(opts.className || 'chapter-diff-del', opts);
  return child;
}

function createExpandDom(blocks = []) {
  const app = {
    _blocks: blocks,
    querySelectorAll(sel) {
      if (sel === STANDALONE_SELECTOR) {
        return blocks.filter((b) =>
          ['chapter-output', 'chapter-agent-prompt', 'chapter-thinking-block', 'chapter-mcp-output'].some(
            (cls) => b.className.includes(cls)
          )
        );
      }
      if (sel === '.chapter-diff-block') {
        return blocks.filter((b) => b.className.includes('chapter-diff-block'));
      }
      return [];
    },
  };

  const document = {
    createElement(tag) {
      assert.equal(tag, 'button');
      return makeToggle();
    },
  };

  return { app, document, blocks };
}

function runExpand(body, domOpts = {}) {
  const dom = domOpts.dom || createExpandDom(domOpts.blocks || []);
  const script = new Script(`
    ${EXPAND_TOGGLES_JS}
    ${body}
  `);

  const ctx = {
    Object,
    Array,
    String,
    Math,
    app: dom.app,
    document: dom.document,
    __result: undefined,
    __dom: dom,
    ...domOpts.ctxExtra,
  };
  script.runInNewContext(ctx);
  return { ...ctx, dom };
}

function findToggles(dom) {
  const toggles = [];
  for (const block of dom.blocks) {
    const parent = block.parentNode.children;
    for (const node of parent) {
      if (node.classList?.contains('expand-toggle') && !toggles.includes(node)) {
        toggles.push(node);
      }
    }
  }
  return toggles;
}

function clickToggle(toggle, extra = {}) {
  const ev = {
    _stopped: false,
    stopPropagation() {
      this._stopped = true;
    },
    ...extra,
  };
  toggle._handlers.click(ev);
  return ev;
}

describe('render-interactions VM (expand toggles)', () => {
  test('attachExpandToggles is defined without nav tooltip helpers in VM', () => {
    const { __result } = runExpand(
      '__result = { expand: typeof attachExpandToggles, tooltip: typeof attachChapterTooltips, focus: typeof setFocusedChapter };',
      { blocks: [] },
    );
    assert.equal(__result.expand, 'function');
    assert.equal(__result.tooltip, 'undefined');
    assert.equal(__result.focus, 'undefined');
  });

  test('adds expand toggle after truncated standalone chapter-output', () => {
    const block = makeBlock('chapter-output', { scrollHeight: 300, clientHeight: 100 });
    const { dom } = runExpand('attachExpandToggles();', { blocks: [block] });
    const toggle = block.nextElementSibling;
    assert.ok(toggle);
    assert.ok(toggle.classList.contains('expand-toggle'));
    assert.equal(toggle.type, 'button');
    assert.equal(toggle.textContent, '\u25b8 show more');
    assert.equal(toggle.attributes['aria-expanded'], 'false');
    assert.equal(toggle.attributes['aria-label'], 'Expand truncated content');
    assert.equal(findToggles(dom).length, 1);
  });

  test('skips standalone blocks that fit without truncation', () => {
    const block = makeBlock('chapter-output', { scrollHeight: 80, clientHeight: 80 });
    runExpand('attachExpandToggles();', { blocks: [block] });
    assert.equal(block.nextElementSibling, null);
  });

  test('skips standalone block when expand-toggle already follows', () => {
    const existing = makeToggle(true);
    const block = makeBlock('chapter-output', {
      scrollHeight: 300,
      clientHeight: 100,
      nextSibling: existing,
    });
    runExpand('attachExpandToggles();', { blocks: [block] });
    assert.equal(block.nextElementSibling, existing);
    assert.equal(existing.textContent, '');
  });

  test('standalone toggle click expands block and flips label', () => {
    const block = makeBlock('chapter-output', { scrollHeight: 300, clientHeight: 100 });
    runExpand('attachExpandToggles();', { blocks: [block] });
    const toggle = block.nextElementSibling;
    clickToggle(toggle);
    assert.ok(block.classList.contains('expanded'));
    assert.equal(toggle.textContent, '\u25be show less');
    assert.equal(toggle.attributes['aria-expanded'], 'true');
    assert.equal(toggle.attributes['aria-label'], 'Collapse truncated content');
    clickToggle(toggle);
    assert.ok(!block.classList.contains('expanded'));
    assert.equal(toggle.textContent, '\u25b8 show more');
    assert.equal(toggle.attributes['aria-expanded'], 'false');
    assert.equal(toggle.attributes['aria-label'], 'Expand truncated content');
  });

  test('standalone toggle click stops propagation', () => {
    const block = makeBlock('chapter-output', { scrollHeight: 300, clientHeight: 100 });
    runExpand('attachExpandToggles();', { blocks: [block] });
    const ev = clickToggle(block.nextElementSibling);
    assert.ok(ev._stopped);
  });

  for (const cls of ['chapter-agent-prompt', 'chapter-thinking-block', 'chapter-mcp-output']) {
    test(`adds toggle for truncated ${cls}`, () => {
      const block = makeBlock(cls, { scrollHeight: 250, clientHeight: 90 });
      runExpand('attachExpandToggles();', { blocks: [block] });
      assert.ok(block.nextElementSibling?.classList.contains('expand-toggle'));
    });
  }

  test('treats scrollHeight within 2px of clientHeight as not truncated', () => {
    const block = makeBlock('chapter-output', { scrollHeight: 82, clientHeight: 80 });
    runExpand('attachExpandToggles();', { blocks: [block] });
    assert.equal(block.nextElementSibling, null);
  });

  test('adds in-diff toggle when any diff child is truncated', () => {
    const del = makeDiffChild({ scrollHeight: 400, clientHeight: 100 });
    const add = makeDiffChild({ className: 'chapter-diff-add', scrollHeight: 50, clientHeight: 50 });
    const diff = makeBlock('chapter-diff-block', { children: [del, add] });
    runExpand('attachExpandToggles();', { blocks: [diff] });
    const toggle = diff.nextElementSibling;
    assert.ok(toggle);
    assert.ok(toggle.classList.contains('expand-toggle'));
    assert.ok(toggle.classList.contains('in-diff'));
    assert.equal(toggle.type, 'button');
    assert.equal(toggle.attributes['aria-expanded'], 'false');
    assert.equal(toggle.attributes['aria-label'], 'Expand truncated diff');
  });

  test('skips diff block when no children are truncated', () => {
    const del = makeDiffChild({ scrollHeight: 60, clientHeight: 60 });
    const add = makeDiffChild({ className: 'chapter-diff-add', scrollHeight: 60, clientHeight: 60 });
    const diff = makeBlock('chapter-diff-block', { children: [del, add] });
    runExpand('attachExpandToggles();', { blocks: [diff] });
    assert.equal(diff.nextElementSibling, null);
  });

  test('skips diff block when expand-toggle already follows', () => {
    const existing = makeToggle(true);
    existing.classList.add('in-diff');
    const del = makeDiffChild({ scrollHeight: 400, clientHeight: 100 });
    const diff = makeBlock('chapter-diff-block', {
      children: [del],
      nextSibling: existing,
    });
    runExpand('attachExpandToggles();', { blocks: [diff] });
    assert.equal(diff.nextElementSibling, existing);
  });

  test('diff toggle expands and collapses all del/add children together', () => {
    const del = makeDiffChild({ scrollHeight: 400, clientHeight: 100 });
    const add = makeDiffChild({ className: 'chapter-diff-add', scrollHeight: 350, clientHeight: 100 });
    const diff = makeBlock('chapter-diff-block', { children: [del, add] });
    runExpand('attachExpandToggles();', { blocks: [diff] });
    const toggle = diff.nextElementSibling;
    clickToggle(toggle);
    assert.ok(del.classList.contains('expanded'));
    assert.ok(add.classList.contains('expanded'));
    assert.equal(toggle.textContent, '\u25be show less');
    assert.equal(toggle.attributes['aria-expanded'], 'true');
    assert.equal(toggle.attributes['aria-label'], 'Collapse truncated diff');
    clickToggle(toggle);
    assert.ok(!del.classList.contains('expanded'));
    assert.ok(!add.classList.contains('expanded'));
    assert.equal(toggle.textContent, '\u25b8 show more');
    assert.equal(toggle.attributes['aria-expanded'], 'false');
    assert.equal(toggle.attributes['aria-label'], 'Expand truncated diff');
  });

  test('diff toggle uses first child expanded state to decide collapse', () => {
    const del = makeDiffChild({ scrollHeight: 400, clientHeight: 100 });
    del.classList.add('expanded');
    const add = makeDiffChild({ className: 'chapter-diff-add', scrollHeight: 350, clientHeight: 100 });
    const diff = makeBlock('chapter-diff-block', { children: [del, add] });
    runExpand('attachExpandToggles();', { blocks: [diff] });
    clickToggle(diff.nextElementSibling);
    assert.ok(!del.classList.contains('expanded'));
    assert.ok(!add.classList.contains('expanded'));
  });

  test('multiple truncated standalone blocks each receive a toggle', () => {
    const a = makeBlock('chapter-output', { scrollHeight: 300, clientHeight: 100 });
    const b = makeBlock('chapter-thinking-block', { scrollHeight: 280, clientHeight: 90 });
    const { dom } = runExpand('attachExpandToggles();', { blocks: [a, b] });
    assert.ok(a.nextElementSibling?.classList.contains('expand-toggle'));
    assert.ok(b.nextElementSibling?.classList.contains('expand-toggle'));
    assert.equal(findToggles(dom).length, 2);
  });

  test('insertBefore places toggle immediately after its block', () => {
    const block = makeBlock('chapter-output', { scrollHeight: 300, clientHeight: 100 });
    runExpand('attachExpandToggles();', { blocks: [block] });
    const parent = block.parentNode.children;
    const blockIdx = parent.indexOf(block);
    assert.equal(parent[blockIdx + 1], block.nextElementSibling);
    assert.ok(block.nextElementSibling.classList.contains('expand-toggle'));
  });

  test('diff child truncation uses scrollHeight > clientHeight + 2 threshold', () => {
    const borderline = makeDiffChild({ scrollHeight: 82, clientHeight: 80 });
    const diff = makeBlock('chapter-diff-block', { children: [borderline] });
    runExpand('attachExpandToggles();', { blocks: [diff] });
    assert.equal(diff.nextElementSibling, null);
  });
});
