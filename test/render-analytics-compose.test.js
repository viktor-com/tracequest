import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { ANALYTICS_COMPOSE_JS } from '../src/render/render-analytics-compose.js';
import { ANALYTICS_JS } from '../src/render/render-analytics-compose.js';
import { ANALYTICS_CHARTS_JS } from '../src/render/render-analytics-charts.js';
import { chapterFileKeys, chapterToolKeys } from '../src/chapters/chapter-keys.js';
import { countGitOpsOfType } from '../src/chapters/chapter-quality.js';

const COUNT_GIT_OPS_OF_TYPE_SRC = countGitOpsOfType.toString().replace(/^export /, '');

function runComposeScript(body, sandbox = {}) {
  const script = new Script(`
    ${COUNT_GIT_OPS_OF_TYPE_SRC}
    ${chapterFileKeys.toString().replace(/^export /, '')}
    ${chapterToolKeys.toString().replace(/^export /, '')}
    ${ANALYTICS_CHARTS_JS}
    ${ANALYTICS_COMPOSE_JS}
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
        setAttribute(k, v) { this.attrs[k] = String(v); },
        appendChild(c) { this.children.push(c); },
        addEventListener() {},
        removeChild() {},
        parentNode: null,
        innerHTML: '',
        children: [],
      }),
    },
    getComputedStyle: () => ({ fontFamily: 'monospace' }),
    window: {
      innerHeight: 800,
      scrollY: 0,
      addEventListener() {},
      devicePixelRatio: 2,
    },
    requestAnimationFrame(fn) { fn(); },
    events: [],
    activeFileFilter: null,
    activeToolFilters: { clear() {}, add() {} },
    chapterMatchesFilter: () => true,
    applyFilters() {},
    jumpToChapter() {},
    getChapters: () => [],
    h(tag, attrs, ...kids) {
      const el = {
        tagName: tag,
        className: attrs?.className || '',
        style: attrs?.style || {},
        type: attrs?.type,
        attrs: {},
        dataset: {},
        children: kids.flat(),
        appendChild(c) { this.children.push(c); },
        addEventListener(type, fn) { if (type === 'click') this._click = fn; },
        setAttribute(k, v) { this.attrs[k] = String(v); },
        getAttribute(k) { return this.attrs[k]; },
        classList: { add() {}, remove() {}, toggle() {} },
        querySelector() { return null; },
        querySelectorAll() { return []; },
      };
      if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
          if (k !== 'className' && k !== 'style' && !k.startsWith('on')) el.attrs[k] = String(v);
        }
      }
      return el;
    },
    getToolColor: () => '#abc',
    fmtMcpName: (n) => n,
    fmtPct: (n) => String(Math.round(n)) + '%',
    setupHiDpiCanvas: (canvas) => canvas.getContext('2d'),
    TOOL_COLORS: { _error: '#f00', _user: '#0f0' },
    ...sandbox,
  };
  return script.runInNewContext(ctx);
}

describe('render-analytics-compose', () => {
  test('ANALYTICS_JS concatenates charts then compose orchestration', () => {
    const idxCharts = ANALYTICS_JS.indexOf('function drawWaveform');
    const idxFlow = ANALYTICS_JS.indexOf('function renderToolFlow');
    const idxMini = ANALYTICS_JS.indexOf('function renderMiniMap');
    assert.ok(idxCharts >= 0);
    assert.ok(idxFlow > idxCharts);
    assert.ok(idxMini > idxFlow);
    assert.equal(ANALYTICS_JS, ANALYTICS_CHARTS_JS + ANALYTICS_COMPOSE_JS);
  });

  test('renderToolFlow returns empty div when sequence too short', () => {
    const el = runComposeScript(
      `renderToolFlow();`,
      {
        events: [
          { type: 'user', text: 'hi' },
          { type: 'assistant', toolCalls: [{ name: 'Read' }] },
        ],
        getChapters: () => [{ toolCounts: {} }],
      }
    );
    assert.equal(el.tagName, 'div');
    assert.equal(el.children.length, 0);
  });

  test('renderToolFlow builds flow UI for sufficient tool sequence', () => {
    const events = [
      { type: 'user', text: 'a' },
      { type: 'assistant', toolCalls: [{ name: 'Read' }, { name: 'Edit' }] },
      { type: 'user', text: 'b' },
      { type: 'assistant', toolCalls: [{ name: 'Edit' }, { name: 'Write' }] },
      { type: 'user', text: 'c' },
      { type: 'assistant', toolCalls: [{ name: 'Write' }] },
    ];
    const el = runComposeScript(`renderToolFlow();`, {
      events,
      getChapters: () => [
        { toolCounts: { Read: 1, Edit: 2, Write: 1 } },
        { toolCounts: { Edit: 1, Write: 1 } },
        { toolCounts: { Write: 1 } },
      ],
    });
    assert.ok(el.className.includes('tool-flow'));
    assert.ok(el.children.some((c) => c.className === 'tool-flow-sequence'));
  });

  test('renderGitTimeline returns empty div when no git ops', () => {
    const el = runComposeScript(`renderGitTimeline();`, {
      getChapters: () => [{ gitOps: [] }, { gitOps: [] }],
    });
    assert.equal(el.tagName, 'div');
    assert.equal(el.children.length, 0);
  });

  test('renderGitTimeline lists commit operations', () => {
    const el = runComposeScript(`renderGitTimeline();`, {
      getChapters: () => [
        {
          gitOps: [
            { type: 'commit', hash: 'deadbeef', message: 'fix tests' },
          ],
        },
      ],
    });
    assert.ok(el.className.includes('git-timeline'));
    const detail = el.children.find((c) => c.className === 'git-timeline-ops');
    assert.ok(detail);
    assert.ok(detail.children.length >= 1);
    const chapterButton = detail.children[0].children.find((c) => c.className === 'git-op-chapter');
    assert.equal(chapterButton.tagName, 'button');
    assert.equal(chapterButton.type, 'button');
    assert.equal(chapterButton.attrs['aria-label'], 'Jump to chapter 1 for git operation');
  });

  test('renderMiniMap adds commit marker only for commit git ops', () => {
    const created = [];
    const result = runComposeScript(
      `renderMiniMap();
       var commitMarkers = 0;
       for (var i = 0; i < minimapBlocks.length; i++) {
         var kids = minimapBlocks[i].children;
         for (var j = 0; j < kids.length; j++) {
           if (kids[j].className === 'minimap-marker mm-commit') commitMarkers++;
         }
       }
       ({
         blocks: minimapBlocks.length,
         commitMarkers,
         firstTag: minimapBlocks[0].tagName,
         firstType: minimapBlocks[0].type,
         firstLabel: minimapBlocks[0].attrs['aria-label']
       });`,
      {
        getChapters: () => Array.from({ length: 12 }, (_, i) => ({
          tokens: { input: 10, output: 5 },
          turns: 2,
          outcome: 'clean',
          errors: 0,
          gitOps: i === 3
            ? [{ type: 'commit', hash: 'abc' }]
            : i === 5
              ? [{ type: 'push', branch: 'main' }]
              : [],
          prompt: 'chapter ' + i,
        })),
        document: {
          body: { style: { fontFamily: 'monospace' }, appendChild(el) { created.push(el); } },
          getElementById: () => null,
          querySelectorAll: () => [],
          createElement: (tag) => ({
            tagName: tag,
            className: '',
            type: '',
            style: {},
            attrs: {},
            setAttribute(k, v) { this.attrs[k] = String(v); },
            appendChild(c) { this.children = this.children || []; this.children.push(c); },
            addEventListener() {},
            removeChild() {},
            parentNode: null,
            children: [],
          }),
        },
      }
    );
    assert.equal(result.blocks, 12);
    assert.equal(result.commitMarkers, 1);
    assert.equal(result.firstTag, 'button');
    assert.equal(result.firstType, 'button');
    assert.equal(result.firstLabel, 'Jump to chapter 1');
  });

  test('renderMiniMap shows tooltip details on keyboard focus', () => {
    const created = [];
    function makeEl(tag) {
      const el = {
        tagName: tag,
        className: '',
        id: '',
        type: '',
        style: {},
        attrs: {},
        _handlers: {},
        children: [],
        setAttribute(k, v) { this.attrs[k] = String(v); },
        appendChild(c) { this.children.push(c); },
        addEventListener(type, fn) { this._handlers[type] = fn; },
        removeChild() {},
        parentNode: null,
        getBoundingClientRect() {
          return { top: 100, left: 900, height: 8, width: 22 };
        },
      };
      el.classList = {
        add(name) {
          if (!el.className.split(/\s+/).includes(name)) el.className += ' ' + name;
        },
        remove(name) {
          el.className = el.className.split(/\s+/).filter((part) => part && part !== name).join(' ');
        },
        contains(name) {
          return el.className.split(/\s+/).includes(name);
        },
      };
      return el;
    }
    const result = runComposeScript(
      `renderMiniMap();
       var block = minimapBlocks[2];
       var tooltip = minimapTooltipEl;
       block._handlers.mouseenter();
       var hoverText = tooltip.textContent;
       var hoverVisible = tooltip.classList.contains('visible');
       block._handlers.mouseleave();
       var hoverHidden = !tooltip.classList.contains('visible');
       block._handlers.focus();
       var focusText = tooltip.textContent;
       var focusVisible = tooltip.classList.contains('visible');
       block._handlers.blur();
       ({
         blockDescribedBy: block.attrs['aria-describedby'],
         tooltipId: tooltip.id,
         tooltipRole: tooltip.attrs.role,
         tooltipLive: tooltip.attrs['aria-live'],
         hoverText,
         focusText,
         hoverVisible,
         hoverHidden,
         focusVisible,
         focusHidden: !tooltip.classList.contains('visible')
       });`,
      {
        window: {
          innerHeight: 800,
          innerWidth: 1000,
          scrollY: 0,
          addEventListener() {},
          devicePixelRatio: 2,
        },
        getChapters: () => Array.from({ length: 12 }, (_, i) => ({
          tokens: { input: 10, output: 5 },
          turns: 2,
          outcome: 'clean',
          errors: 0,
          gitOps: [],
          prompt: i === 2
            ? 'Focus parity prompt with enough diagnostic content to truncate consistently'
            : 'chapter ' + i,
        })),
        document: {
          body: { style: { fontFamily: 'monospace' }, appendChild(el) { created.push(el); } },
          getElementById: () => null,
          querySelectorAll: () => [],
          createElement: makeEl,
        },
      }
    );
    assert.equal(result.blockDescribedBy, 'minimap-tooltip');
    assert.equal(result.tooltipId, 'minimap-tooltip');
    assert.equal(result.tooltipRole, 'status');
    assert.equal(result.tooltipLive, 'polite');
    assert.equal(result.focusText, result.hoverText);
    assert.match(result.focusText, /^Ch 3: Focus parity prompt with enough diagnostic content/);
    assert.ok(result.hoverVisible);
    assert.ok(result.hoverHidden);
    assert.ok(result.focusVisible);
    assert.ok(result.focusHidden);
  });

  test('renderFileHotspot lists only paths from cached _fileKeys', () => {
    const el = runComposeScript(`renderFileHotspot();`, {
      getChapters: () => [
        {
          _fileKeys: ['a.js', 'b.js'],
          files: {
            'a.js': { ops: ['Read'] },
            'b.js': { ops: ['Write'] },
            'orphan.js': { ops: ['Edit', 'Edit', 'Edit'] },
          },
        },
      ],
    });
    assert.ok(el.className.includes('file-hotspot'));
    const header = el.children.find((c) => c.className === 'file-hotspot-header');
    assert.equal(header.tagName, 'button');
    assert.equal(header.type, 'button');
    assert.equal(header.attrs['aria-expanded'], 'false');
    const list = el.children.find((c) => c.className === 'file-hotspot-body')
      ?.children?.find((c) => c.className === 'file-hotspot-list');
    assert.ok(list);
    assert.ok(list.children.every((item) => item.tagName === 'button'));
    assert.ok(list.children.every((item) => item.type === 'button'));
    assert.equal(list.children[0].attrs['aria-pressed'], 'false');
    const paths = list.children.map((item) => {
      const pathEl = item.children.find((c) => c.className === 'file-hotspot-path');
      return pathEl?.children?.[0];
    });
    assert.deepEqual(paths, ['a.js', 'b.js']);
    assert.ok(!paths.includes('orphan.js'), 'should not enumerate stray files map keys');
  });

  test('renderFileHotspot aggregates touches via _fileKeys', () => {
    const el = runComposeScript(`renderFileHotspot();`, {
      getChapters: () => [
        {
          _fileKeys: ['a.js', 'b.js'],
          files: {
            'a.js': { ops: ['Read', 'Edit', 'Edit'] },
            'b.js': { ops: ['Write'] },
          },
        },
        {
          _fileKeys: ['a.js'],
          files: { 'a.js': { ops: ['Read'] } },
        },
      ],
    });
    assert.ok(el.className.includes('file-hotspot'));
    const list = el.children.find((c) => c.className === 'file-hotspot-body')
      ?.children?.find((c) => c.className === 'file-hotspot-list');
    assert.ok(list);
    assert.ok(list.children.length >= 2);
  });

  test('renderToolPerformance iterates cached _toolKeys not stray toolCounts keys', () => {
    const el = runComposeScript(`renderToolPerformance();`, {
      getChapters: () => [
        {
          _toolKeys: ['Read', 'Edit'],
          toolCounts: { Read: 3, Edit: 2, OrphanTool: 99 },
          errorTools: {},
          retryGroups: [],
        },
        {
          _toolKeys: ['Read', 'Bash'],
          toolCounts: { Read: 1, Bash: 4, OrphanTool: 50 },
          errorTools: {},
          retryGroups: [],
        },
      ],
    });
    assert.ok(el.className.includes('tool-perf'));
    const header = el.children.find((c) => c.className === 'tool-perf-header');
    assert.equal(header.tagName, 'button');
    assert.equal(header.type, 'button');
    assert.equal(header.attrs['aria-expanded'], 'false');
    const table = el.children.find((c) => c.className === 'tool-perf-body')
      ?.children?.find((c) => c.className === 'tool-perf-table');
    assert.ok(table);
    assert.ok(table.children.every((row) => row.tagName === 'button'));
    assert.ok(table.children.every((row) => row.attrs['aria-pressed'] === 'false'));
    const names = table.children.map((row) => {
      const nameEl = row.children.find((c) => c.className === 'tool-perf-name');
      return nameEl?.children?.[0];
    });
    assert.ok(names.includes('Read'), 'should aggregate Read from _toolKeys');
    assert.ok(names.includes('Edit') && names.includes('Bash'), 'should include tools from _toolKeys');
    assert.ok(!names.includes('OrphanTool'), 'should not enumerate uncached toolCounts keys');
  });

  test('renderMiniMap skips when below chapter threshold', () => {
    const result = runComposeScript(
      `renderMiniMap(); ({ hasMinimap: !!minimapEl, blocks: minimapBlocks.length });`,
      {
        getChapters: () => Array.from({ length: 5 }, () => ({
          tokens: { input: 1, output: 1 },
          turns: 1,
          outcome: 'clean',
          errors: 0,
          gitOps: [],
        })),
      }
    );
    assert.equal(result.hasMinimap, false);
    assert.equal(result.blocks, 0);
  });
});
