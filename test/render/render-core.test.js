import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { CORE_JS } from '../../src/render/render-core.js';

function mockCoreCtx() {
  function makeNode(tag, text) {
    const node = {
      tagName: text ? '#TEXT' : (tag || '').toUpperCase(),
      className: '',
      attributes: {},
      childNodes: [],
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
        this.attributes[k] = v;
      },
      classList: { add() {}, remove() {} },
      scrollIntoView() {},
      offsetWidth: 0,
    };
    return node;
  }
  const app = makeNode('div');
  return {
    Object,
    Array,
    String,
    Math,
    Date,
    Set,
    document: {
      getElementById(id) {
        if (id === 'app') return app;
        return makeNode('div');
      },
      createElement(tag) {
        return makeNode(tag);
      },
      createTextNode(text) {
        return makeNode(null, text);
      },
    },
    window: { devicePixelRatio: 1 },
    SESSION: { events: [] },
    expandedSet: new Set(),
  };
}

describe('render-core VM', () => {
  test('h() applies attrs via for-in and renders children', () => {
    const ctx = mockCoreCtx();
    const result = new Script(`
      ${CORE_JS}
      var el = h('span', { className: 'chip', id: 'x' }, 'ok', null, '!');
      ({
        tag: el.tagName,
        cls: el.className,
        id: el.attributes.id,
        text: el.textContent,
        jump: typeof jumpToChapter,
        esc: esc('&<>"'),
      });
    `).runInNewContext(ctx);
    assert.equal(result.tag, 'SPAN');
    assert.equal(result.cls, 'chip');
    assert.equal(result.id, 'x');
    assert.equal(result.text, 'ok!');
    assert.equal(result.jump, 'function');
    assert.equal(result.esc, '&amp;&lt;&gt;&quot;');
  });
});