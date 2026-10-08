import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { renderHTML } from '../../src/render.js';
import { CSS } from '../../src/render/render-css.js';
import {
  RENDER_BUNDLE_PARTS,
  RENDER_JS,
  UI_BUNDLE_PARTS,
} from '../../src/render/render-assemble.js';
import { ANALYTICS_JS } from '../../src/render/render-analytics-compose.js';
import { CHAPTERS_JS } from '../../src/render/render-chapters.js';
import { CORE_JS } from '../../src/render/render-core.js';
import { INTERACTIONS_JS } from '../../src/render/render-interactions.js';
import { MAIN_JS } from '../../src/render/render-main.js';
import { SHARE_JS } from '../../src/render/render-share.js';

const renderSrc = readFileSync(new URL('../../src/render.js', import.meta.url), 'utf8');
const assembleSrc = readFileSync(
  new URL('../../src/render/render-assemble.js', import.meta.url),
  'utf8',
);

function assertOrdered(ids, ordered) {
  const positions = ordered.map((id) => ids.indexOf(id));
  for (let i = 0; i < ordered.length; i += 1) {
    assert.notEqual(positions[i], -1, `missing bundle part ${ordered[i]}`);
    if (i > 0) {
      assert.ok(
        positions[i - 1] < positions[i],
        `${ordered[i - 1]} should load before ${ordered[i]}`,
      );
    }
  }
}

describe('render source architecture', () => {
  test('render.js embeds only CSS and the pre-built render bundle', () => {
    assert.match(renderSrc, /import \{ CSS \} from "\.\/render\/render-css\.js";/);
    assert.match(renderSrc, /import \{ RENDER_JS \} from "\.\/render\/render-assemble\.js";/);
    assert.match(renderSrc, /\$\{CSS\}/);
    assert.match(renderSrc, /\$\{RENDER_JS\}/);

    for (const legacyName of [
      'ANALYTICS_JS',
      'CHAPTERS_JS',
      'CORE_JS',
      'INTERACTIONS_JS',
      'MAIN_JS',
      'SHARE_JS',
      'UI_JS',
      'RENDER_BUNDLE_PARTS',
      'joinBundleParts',
    ]) {
      assert.doesNotMatch(renderSrc, new RegExp(`\\b${legacyName}\\b`));
    }
  });

  test('render-assemble owns client script source modules and order', () => {
    assert.match(assembleSrc, /from "\.\/render-analytics-compose\.js"/);
    assert.match(assembleSrc, /from "\.\/render-chapters\.js"/);
    assert.match(assembleSrc, /from "\.\/render-core\.js"/);
    assert.match(assembleSrc, /from "\.\/render-interactions\.js"/);
    assert.match(assembleSrc, /from "\.\/render-main\.js"/);
    assert.match(assembleSrc, /from "\.\/render-share\.js"/);
    assert.doesNotMatch(assembleSrc, /from "\.\/render-analytics\.js"/);

    assertOrdered(UI_BUNDLE_PARTS.map((p) => p.id), [
      'ui-errors',
      'chapters-helpers',
      'chapters',
      'ui-chapters',
      'ui-detail',
    ]);
    assertOrdered(RENDER_BUNDLE_PARTS.map((p) => p.id), [
      'core',
      'ui-errors',
      'chapters-helpers',
      'chapters',
      'ui-chapters',
      'ui-detail',
      'analytics',
      'main',
      'interactions',
      'share',
    ]);
  });

  test('source constants expose the functions that renderHTML receives through RENDER_JS', () => {
    const sourceChecks = [
      [ANALYTICS_JS, 'function drawWaveform'],
      [ANALYTICS_JS, 'function renderToolFlow'],
      [CHAPTERS_JS, 'function buildChapters'],
      [CHAPTERS_JS, 'function chapterMatchesFilter'],
      [CORE_JS, 'function renderHeader'],
      [CORE_JS, 'function renderStats'],
      [INTERACTIONS_JS, 'function attachExpandToggles'],
      [INTERACTIONS_JS, 'function setFocusedChapter'],
      [INTERACTIONS_JS, 'function clearFocus'],
      [MAIN_JS, 'function render()'],
      [SHARE_JS, 'function openShareModal'],
    ];
    for (const [source, snippet] of sourceChecks) {
      assert.ok(source.includes(snippet), `source module should include ${snippet}`);
      assert.ok(RENDER_JS.includes(snippet), `RENDER_JS should include ${snippet}`);
    }
  });

  test('renderHTML embeds the CSS re-export and pre-built RENDER_JS', () => {
    const html = renderHTML({
      sessionId: 'render-source-architecture',
      startTime: '2026-01-01T00:00:00.000Z',
      events: [{ type: 'user', text: 'ping', timestamp: '2026-01-01T00:00:00.000Z' }],
    });
    const styleStart = html.indexOf('<style>');
    const styleEnd = html.indexOf('</style>', styleStart);
    assert.ok(styleStart >= 0 && styleEnd > styleStart, 'expected a style block');
    assert.ok(html.slice(styleStart, styleEnd).includes(CSS.slice(0, 120)));
    assert.ok(html.includes(RENDER_JS.slice(0, 160)));
    assert.ok(!html.includes('RENDER_BUNDLE_PARTS'));
    assert.ok(!html.includes('joinBundleParts'));
  });
});
