import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import {
  buildRenderScript,
  buildChaptersHelpersScript,
  RENDER_BUNDLE_PARTS,
  RENDER_BUNDLE_FUNCTION_NAMES,
  UI_BUNDLE_PARTS,
  CHAPTERS_BUNDLE_FUNCTION_NAMES,
  RENDER_JS,
  UI_JS,
  CHAPTERS_HELPERS_JS,
} from '../../src/render/render-assemble.js';
import { joinBundleParts } from '../../src/render/join-bundle.js';
import { renderHTML } from '../../src/render.js';

const VM_CTX = { Object, Array, String, Math, Date, Set, Uint32Array, URL };

/** Count top-level `function name` declarations in a script string. */
function countFunctionDef(src, name) {
  const re = new RegExp(`function ${name}\\b`, 'g');
  return (src.match(re) || []).length;
}

function bundleThroughPartId(parts, id) {
  const idx = parts.findIndex((p) => p.id === id);
  assert.ok(idx >= 0, `missing bundle part id ${id}`);
  return joinBundleParts(parts.slice(0, idx + 1));
}

function probeTypes(bundle, names, ctx = VM_CTX) {
  const props = names.map((n) => `${n}: typeof ${n}`).join(', ');
  const opensIife = bundle.trimStart().startsWith('(function() {');
  const body = opensIife
    ? `${bundle}\nreturn ({ ${props} });\n})();`
    : `${bundle}\n({ ${props} })`;
  return new Script(body).runInNewContext(ctx);
}

function makeInteractiveNode(tag, text) {
  const listeners = {};
  const node = {
    tagName: text ? '#TEXT' : (tag || '').toUpperCase(),
    type: '',
    checked: false,
    value: '',
    disabled: false,
    className: '',
    style: {},
    childNodes: [],
    attributes: {},
    parentNode: null,
    nodeValue: text,
    textContent: text != null ? String(text) : '',
    appendChild(child) {
      this.childNodes.push(child);
      child.parentNode = this;
      if (child.nodeValue != null) {
        this.textContent = (this.textContent || '') + child.textContent;
      }
      return child;
    },
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    dispatchEvent(type) {
      const ev = { target: this, type };
      for (const fn of listeners[type] || []) fn(ev);
    },
    setAttribute(k, v) {
      this.attributes[k] = v;
      if (k === 'type') this.type = v;
    },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this.attributes, k)
        ? this.attributes[k]
        : null;
    },
    classList: {
      add() {},
      remove() {},
    },
    scrollIntoView() {},
    getContext() {
      return { setTransform() {}, scale() {}, fillRect() {}, clearRect() {} };
    },
  };
  return node;
}

function mockViewerCtx() {
  function makeNode(tag, text) {
    return makeInteractiveNode(tag, text);
  }
  const app = makeNode('div');
  return {
    ...VM_CTX,
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
      addEventListener() {},
      removeEventListener() {},
    },
    window: {
      devicePixelRatio: 1,
      location: { search: '', hash: '' },
      history: { replaceState() {} },
      addEventListener() {},
      removeEventListener() {},
    },
    SESSION: {
      sessionId: 'sess-test',
      startTime: '2026-01-01T00:00:00.000Z',
      events: [
        { type: 'user', text: 'hello', timestamp: '2026-01-01T00:00:00.000Z' },
      ],
    },
  };
}

function shareBundle() {
  return bundleThroughPartId(RENDER_BUNDLE_PARTS, 'share');
}

async function runShareVmAsync(body, ctx = {}) {
  const bundle = shareBundle();
  const script = `${bundle}\nreturn (async () => { ${body} })();\n})();`;
  return new Script(script).runInNewContext({ ...VM_CTX, ...mockViewerCtx(), ...ctx });
}

function shareModalCtx() {
  const storage = {};
  const body = makeInteractiveNode('body');
  return {
    ...mockViewerCtx(),
    session: {
      sessionId: 'modal-share-test',
      source: 'claude',
      events: [{ type: 'user', text: 'hello', timestamp: '2026-01-01T00:00:00.000Z' }],
    },
    localStorage: {
      getItem(key) {
        return storage[key] ?? null;
      },
      setItem(key, value) {
        storage[key] = String(value);
      },
    },
    body,
    document: {
      ...mockViewerCtx().document,
      body,
      appendChild(node) {
        return body.appendChild(node);
      },
      createElement(tag) {
        return makeInteractiveNode(tag);
      },
      createTextNode(text) {
        return makeInteractiveNode(null, text);
      },
      querySelector() {
        return null;
      },
      getElementsByTagName() {
        return [];
      },
      addEventListener() {},
      removeEventListener() {},
    },
  };
}

describe('render-assemble bundle contract', () => {
  test('buildRenderScript is deterministic and matches exported RENDER_JS', () => {
    const a = buildRenderScript();
    const b = buildRenderScript();
    assert.equal(a, b, 'repeated buildRenderScript should be deterministic');
    assert.equal(a, RENDER_JS, 'RENDER_JS should match buildRenderScript()');
    assert.ok(RENDER_JS.length > 5000, 'assembled bundle should be substantial');
  });

  test('RENDER_JS parses as an IIFE with bootstrap tail', () => {
    assert.doesNotThrow(() => new Script(RENDER_JS), 'RENDER_JS should parse as plain script');
    assert.ok(RENDER_JS.startsWith('\n(function() {'), 'bundle should open IIFE');
    assert.ok(RENDER_JS.trimEnd().endsWith('})();'), 'bundle should close IIFE');
    const closeIdx = RENDER_JS.lastIndexOf('})();');
    const tail = RENDER_JS.slice(Math.max(0, closeIdx - 120), closeIdx);
    const readPos = tail.indexOf('readUrlState();');
    const renderPos = tail.indexOf('render();');
    assert.ok(readPos >= 0 && renderPos >= 0, 'bootstrap should call readUrlState and render');
    assert.ok(readPos < renderPos, 'readUrlState(); should precede render(); in bootstrap tail');
  });

  test('RENDER_JS is browser-safe (no ESM export tokens)', () => {
    assert.ok(!RENDER_JS.includes('export function'), 'browser bundle must not contain export function');
    assert.ok(!RENDER_JS.includes('export const'), 'browser bundle must not contain export const');
  });

  test('RENDER_JS does not contain a literal </script> sequence (HTML parser trap)', () => {
    assert.ok(!/<\/script>/i.test(RENDER_JS), 'embedded bundle must not terminate the HTML script tag early');
    assert.ok(RENDER_JS.includes("</scr' + 'ipt>"), 'clientRenderHTML should build closing script tag safely');
  });

  test('renderHTML viewer script block contains bootstrap and no premature </script>', () => {
    const session = {
      sessionId: 'script-integrity',
      startTime: '2026-01-01T00:00:00.000Z',
      events: [{ type: 'user', text: 'ping', timestamp: '2026-01-01T00:00:00.000Z' }],
    };
    const html = renderHTML(session);
    const scriptOpen = html.indexOf('<script>\nconst SESSION');
    assert.ok(scriptOpen >= 0, 'viewer HTML should contain embedded script');
    const scriptBodyStart = html.indexOf('\n', scriptOpen) + 1;
    const scriptClose = html.lastIndexOf('</script>');
    const scriptBody = html.slice(scriptBodyStart, scriptClose);
    assert.ok(scriptBody.includes('readUrlState();'));
    assert.ok(scriptBody.includes('render();'));
    assert.ok(!/<\/script>/i.test(scriptBody));
    assert.equal((html.match(/<\/script>/gi) || []).length, 1);
  });

  test('clientRenderHTML output contains valid closing script before body end', () => {
    const bundle = shareBundle();
    const styleNode = { textContent: 'body { color: red; }' };
    const scriptNode = { textContent: `const SESSION = {};\n${RENDER_JS}` };
    const ctx = {
      ...mockViewerCtx(),
      document: {
        ...mockViewerCtx().document,
        querySelector(sel) {
          if (sel === 'style') return styleNode;
          return mockViewerCtx().document.querySelector(sel);
        },
        getElementsByTagName(tag) {
          if (tag === 'script') return [scriptNode];
          return [];
        },
      },
    };
    const opensIife = bundle.trimStart().startsWith('(function() {');
    const body = opensIife
      ? `${bundle}\nreturn clientRenderHTML({ sessionId: '"><img onerror=1>', events: [] });\n})();`
      : `${bundle}\nclientRenderHTML({ sessionId: '"><img onerror=1>', events: [] })`;
    const html = new Script(body).runInNewContext(ctx);
    const scriptClose = html.lastIndexOf('</script>');
    const bodyClose = html.lastIndexOf('</body>');
    assert.ok(scriptClose >= 0 && bodyClose > scriptClose);
    assert.ok(html.includes('&quot;&gt;&lt;img o'), 'title session id prefix should be HTML-escaped');
    const innerScriptOpen = html.indexOf('<script>\nconst SESSION');
    const innerBody = html.slice(html.indexOf('\n', innerScriptOpen) + 1, scriptClose);
    assert.ok(!/<\/script>/i.test(innerBody));
    assert.ok(innerBody.includes('readUrlState();'), 'browser-share HTML should preserve bootstrap readUrlState');
    assert.ok(innerBody.includes('render();'), 'browser-share HTML should preserve bootstrap render');
  });

  test('share bundle isAllowedShareUrl rejects lookalike hosts and non-https', async () => {
    const result = await runShareVmAsync(`
      return {
        allow: [
          isAllowedShareUrl('https://gisthost.github.io/?abc'),
          isAllowedShareUrl('https://gist.github.com/user/abc'),
          isAllowedShareUrl('https://user.gist.github.com/abc'),
          isAllowedShareUrl('https://huggingface.co/datasets/u/r'),
        ],
        reject: [
          isAllowedShareUrl('https://gist.github.com.evil.example/abc'),
          isAllowedShareUrl('http://gist.github.com/user/abc'),
          isAllowedShareUrl('javascript:alert(1)'),
          isAllowedShareUrl('not-a-url'),
        ],
      };
    `);
    assert.equal(result.allow.length, 4);
    assert.ok(result.allow.every((v) => v === true));
    assert.equal(result.reject.length, 4);
    assert.ok(result.reject.every((v) => v === false));
  });

  test('share bundle buildGistHostPreviewUrl matches Node adapter parity', async () => {
    const result = await runShareVmAsync(`
      return {
        withFile: buildGistHostPreviewUrl('id1', 'tracequest-claude-abcdef12.html'),
        index: buildGistHostPreviewUrl('id1', 'index.html'),
        bare: buildGistHostPreviewUrl('id1'),
        falsy: buildGistHostPreviewUrl(null),
      };
    `);
    assert.equal(result.withFile, 'https://gisthost.github.io/?id1/tracequest-claude-abcdef12.html');
    assert.equal(result.index, 'https://gisthost.github.io/?id1');
    assert.equal(result.bare, 'https://gisthost.github.io/?id1');
    assert.equal(result.falsy, null);
  });

  test('share bundle shareGist returns previewUrl and gistUrl with mock fetch', async () => {
    const calls = [];
    const result = await runShareVmAsync(`
      return await shareGist('<html></html>', {
        sessionId: 'abcdef12-3456-7890-abcd-ef1234567890',
        source: 'claude',
        firstPrompt: 'hello',
        model: 'm',
        durationFormatted: '1s',
      }, 'tok', false);
    `, {
      fetch: async (url, opts) => {
        calls.push({ url, body: JSON.parse(opts.body) });
        return {
          ok: true,
          json: async () => ({ html_url: 'https://gist.github.com/vm/99', id: '99' }),
        };
      },
    });
    assert.equal(result.previewUrl, 'https://gisthost.github.io/?99/tracequest-claude-abcdef12.html');
    assert.equal(result.gistUrl, 'https://gist.github.com/vm/99');
    assert.ok(calls[0].url.endsWith('/gists'));
  });

  test('share bundle shareGist rejects response missing id', async () => {
    await assert.rejects(
      () => runShareVmAsync(`
        return await shareGist('<html></html>', {
          sessionId: 'abcdef12',
          source: 'claude',
          firstPrompt: 'hello',
          model: 'm',
          durationFormatted: '1s',
        }, 'tok', false);
      `, {
        fetch: async () => ({
          ok: true,
          json: async () => ({ html_url: 'https://gist.github.com/vm/no-id' }),
        }),
      }),
      /response missing id/,
    );
  });

  test('share bundle showShareSuccess handles null and disallowed URLs', async () => {
    const result = await runShareVmAsync(`
      function makeStatus() {
        return {
          className: '',
          textContent: '',
          childNodes: [],
          appendChild(child) { this.childNodes.push(child); return child; },
        };
      }
      var nullEl = makeStatus();
      showShareSuccess(nullEl, null);
      var badEl = makeStatus();
      showShareSuccess(badEl, 'javascript:alert(1)');
      var goodEl = makeStatus();
      showShareSuccess(goodEl, 'https://gisthost.github.io/?abc', 'https://gist.github.com/user/abc');
      return {
        nullClass: nullEl.className,
        nullText: nullEl.textContent,
        badChildCount: badEl.childNodes.length,
        badHasAnchor: badEl.childNodes.some(function(n) { return n.tagName === 'A'; }),
        goodHasAnchor: goodEl.childNodes.some(function(n) { return n.tagName === 'A'; }),
        goodHasSecondary: goodEl.childNodes.some(function(n) { return n.textContent === 'raw gist'; }),
      };
    `);
    assert.equal(result.nullClass, 'hf-modal-status hf-error');
    assert.match(result.nullText, /no preview URL/);
    assert.equal(result.badHasAnchor, false);
    assert.ok(result.badChildCount >= 1);
    assert.equal(result.goodHasAnchor, true);
    assert.equal(result.goodHasSecondary, true);
  });

  test('share bundle openShareModal shows private gist hint when private+gist selected', async () => {
    const result = await runShareVmAsync(`
      openShareModal();
      function nodeText(node) {
        if (node.nodeValue != null) return String(node.nodeValue);
        return String(node.textContent || '');
      }
      function findHint(node) {
        if (nodeText(node).indexOf('Secret gists:') >= 0) return node;
        for (var i = 0; i < (node.childNodes || []).length; i++) {
          var found = findHint(node.childNodes[i]);
          if (found) return found.tagName === '#TEXT' ? node : found;
        }
        return null;
      }
      function collectInputs(node, out) {
        if (node.tagName === 'INPUT' && node.type === 'checkbox') out.push(node);
        for (var i = 0; i < (node.childNodes || []).length; i++) collectInputs(node.childNodes[i], out);
      }
      var inputs = [];
      collectInputs(shareModalEl, inputs);
      var privateChk = inputs[0];
      var hint = findHint(shareModalEl);
      if (!hint || !privateChk) return { error: 'missing-hint-or-checkbox' };
      var hidden = hint.style.display;
      privateChk.checked = true;
      privateChk.dispatchEvent('change');
      var shown = hint.style.display;
      return { hidden: hidden, shown: shown };
    `, shareModalCtx());
    assert.notEqual(result.error, 'missing-hint-or-checkbox');
    assert.notEqual(result.shown, 'none');
    assert.equal(result.shown, 'block');
  });

  test('RENDER_BUNDLE_PARTS segment ids are unique (no duplicate join segments)', () => {
    const ids = RENDER_BUNDLE_PARTS.map((p) => p.id);
    assert.equal(ids.length, new Set(ids).size, 'each bundle part id should appear once');
  });

  test('critical functions appear exactly once in RENDER_JS (no duplicate join bugs)', () => {
    const onceOnly = [
      ...RENDER_BUNDLE_FUNCTION_NAMES,
      ...CHAPTERS_BUNDLE_FUNCTION_NAMES,
      'renderErrorSummary',
      'attachChapterTooltips',
    ];
    for (const name of onceOnly) {
      assert.equal(
        countFunctionDef(RENDER_JS, name),
        1,
        `function ${name} should be defined exactly once in RENDER_JS`,
      );
    }
  });

  test('cumulative format segments expose filter helpers in VM', () => {
    const bundle = bundleThroughPartId(RENDER_BUNDLE_PARTS, 'fmtMcpName');
    const vm = probeTypes(bundle, [
      'includesLower',
      'getModelRates',
      'estimateParsedStatsCost',
      'estimateChapterTokenCost',
      'fmtTokens',
      'fmtCost',
      'fmtPct',
      'formatDuration',
      'fmtMcpName',
    ]);
    for (const name of Object.keys(vm)) {
      assert.equal(vm[name], 'function', `${name} should be defined after format segments`);
    }
  });

  test('cumulative UI bundle exposes helpers only after their segments load', () => {
    const ctx = mockViewerCtx();
    const throughCore = bundleThroughPartId(RENDER_BUNDLE_PARTS, 'core');
    const beforeUi = probeTypes(throughCore, ['renderErrorSummary', 'buildChapters', 'buildChapterDetail'], ctx);
    assert.equal(beforeUi.renderErrorSummary, 'undefined', 'error UI should not exist before ui-errors');
    assert.equal(beforeUi.buildChapters, 'undefined', 'chapter builder should not exist before chapters segment');
    assert.equal(beforeUi.buildChapterDetail, 'undefined', 'detail UI should not exist before ui-detail');

    const throughErrors = bundleThroughPartId(RENDER_BUNDLE_PARTS, 'ui-errors');
    const afterErrors = probeTypes(throughErrors, ['renderErrorSummary', 'buildChapters'], ctx);
    assert.equal(afterErrors.renderErrorSummary, 'function', 'ui-errors segment should define renderErrorSummary');
    assert.equal(afterErrors.buildChapters, 'undefined', 'buildChapters should still be absent before chapters');

    const throughChapters = bundleThroughPartId(RENDER_BUNDLE_PARTS, 'chapters');
    const afterChapters = probeTypes(throughChapters, ['buildChapters', 'getChapters', 'renderChapters'], ctx);
    assert.equal(afterChapters.buildChapters, 'function');
    assert.equal(afterChapters.getChapters, 'function');
    assert.equal(afterChapters.renderChapters, 'undefined', 'chapter list UI should load after ui-chapters segment');

    const throughUiChapters = bundleThroughPartId(RENDER_BUNDLE_PARTS, 'ui-chapters');
    const afterUiChapters = probeTypes(throughUiChapters, ['renderChapters', 'renderFilterBar'], ctx);
    assert.equal(afterUiChapters.renderChapters, 'function');
    assert.equal(afterUiChapters.renderFilterBar, 'function');

    const throughDetail = bundleThroughPartId(RENDER_BUNDLE_PARTS, 'ui-detail');
    const afterDetail = probeTypes(throughDetail, ['buildChapterDetail', 'renderToolFlow'], ctx);
    assert.equal(afterDetail.buildChapterDetail, 'function');
    assert.equal(afterDetail.renderToolFlow, 'undefined', 'analytics should load after detail UI');

    const throughAnalytics = bundleThroughPartId(RENDER_BUNDLE_PARTS, 'analytics');
    const afterAnalytics = probeTypes(throughAnalytics, ['renderToolFlow', 'render'], ctx);
    assert.equal(afterAnalytics.renderToolFlow, 'function');
    assert.equal(afterAnalytics.render, 'undefined', 'main render() should load after analytics');

    const throughMain = bundleThroughPartId(RENDER_BUNDLE_PARTS, 'main');
    const afterMain = probeTypes(throughMain, ['render', 'renderHeader'], ctx);
    assert.equal(afterMain.render, 'function');
    assert.equal(afterMain.renderHeader, 'function');

    const throughInteractions = bundleThroughPartId(RENDER_BUNDLE_PARTS, 'interactions');
    const afterInteractions = probeTypes(throughInteractions, ['attachExpandToggles', 'jumpToChapter'], ctx);
    assert.equal(afterInteractions.attachExpandToggles, 'function');
    assert.equal(afterInteractions.jumpToChapter, 'function');
  });

  test('UI_BUNDLE_PARTS loads ui-errors before chapter modules become available', () => {
    const ctx = mockViewerCtx();
    const throughErrors = bundleThroughPartId(UI_BUNDLE_PARTS, 'ui-errors');
    const mid = probeTypes(throughErrors, ['renderErrorSummary', 'buildChapters'], ctx);
    assert.equal(mid.renderErrorSummary, 'function');
    assert.equal(mid.buildChapters, 'undefined');

    const throughChapters = bundleThroughPartId(UI_BUNDLE_PARTS, 'chapters');
    const end = probeTypes(throughChapters, ['renderErrorSummary', 'buildChapters'], ctx);
    assert.equal(end.renderErrorSummary, 'function');
    assert.equal(end.buildChapters, 'function');
  });

  test('UI_JS and CHAPTERS_HELPERS_JS are stable and chapter helpers are not double-joined', () => {
    assert.equal(buildChaptersHelpersScript(), CHAPTERS_HELPERS_JS);
    assert.equal(
      countFunctionDef(RENDER_JS, 'enrichChaptersForRender'),
      1,
      'chapter helpers should not be joined twice into RENDER_JS',
    );
    assert.ok(UI_JS.length > 1000, 'composed UI_JS should be substantial');
    const uiProbe = probeTypes(UI_JS, ['renderErrorSummary', 'buildChapters', 'renderChapters'], mockViewerCtx());
    assert.equal(uiProbe.renderErrorSummary, 'function');
    assert.equal(uiProbe.buildChapters, 'function');
    assert.equal(uiProbe.renderChapters, 'function');
  });

  test('share segment runs scanSessionForSecrets in VM without ReferenceError', () => {
    const bundle = bundleThroughPartId(RENDER_BUNDLE_PARTS, 'share');
    const ctx = mockViewerCtx();
    ctx.SESSION = {
      sessionId: 'share-vm-test',
      events: [{ type: 'user', text: 'key sk-fake1234567890abcdef', timestamp: '2026-01-01T00:00:00.000Z' }],
    };
    const opensIife = bundle.trimStart().startsWith('(function() {');
    const body = opensIife
      ? `${bundle}\nreturn scanSessionForSecrets(session, SECRET_RULES).length;\n})();`
      : `${bundle}\nscanSessionForSecrets(session, SECRET_RULES).length`;
    const count = new Script(body).runInNewContext(ctx);
    assert.ok(count >= 1, 'share bundle should scan embedded session for secrets');
    const types = probeTypes(bundle, ['scanSessionForSecrets', 'redactSession', 'openShareModal', 'shareGist', 'shareHf'], ctx);
    assert.equal(types.scanSessionForSecrets, 'function');
    assert.equal(types.redactSession, 'function');
    assert.equal(types.openShareModal, 'function');
    assert.equal(types.shareGist, 'function');
    assert.equal(types.shareHf, 'function');
  });

  test('renderHTML embeds pre-assembled RENDER_JS without rebuilding bundle parts', () => {
    const session = {
      sessionId: 'embed-check',
      startTime: '2026-01-01T00:00:00.000Z',
      events: [{ type: 'user', text: 'ping', timestamp: '2026-01-01T00:00:00.000Z' }],
    };
    const html = renderHTML(session);
    assert.ok(!html.includes('RENDER_BUNDLE_PARTS'), 'viewer HTML should not rebuild bundle parts at runtime');
    assert.ok(!html.includes('joinBundleParts'), 'viewer HTML should not join bundle segments at runtime');
  });
});