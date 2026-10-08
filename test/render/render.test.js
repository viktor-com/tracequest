import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderHTML } from '../../src/render.js';
import { buildSessionChapters } from '../../src/chapters/session-chapters.js';
import { assertPerf } from "../helpers/perf-assert.js";

/** Minimal session shape for renderHTML cache/title tests. */
function baseSession(overrides = {}) {
  const events = overrides.events ?? [
    { type: 'user', text: 'hello', timestamp: '2026-06-01T10:00:00.000Z' },
  ];
  return {
    sessionId: 'tq-render-base01',
    source: 'claude',
    cwd: '/tmp',
    model: 'claude-test',
    startTime: '2026-06-01T10:00:00.000Z',
    endTime: '2026-06-01T10:05:00.000Z',
    durationMs: 300000,
    eventCount: events.length,
    events,
    stats: {
      toolCounts: {},
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheHit: 0,
      errors: 0,
      userMessages: 1,
      assistantTurns: 0,
      tokensEstimated: false,
    },
    ...overrides,
  };
}

function titleLine(html) {
  const m = html.match(/<title>([^<]*)<\/title>/);
  assert.ok(m, 'expected <title> element');
  return m[1];
}

/** Parse inlined SESSION JSON from renderHTML output (viewer boot payload). */
function parseInlinedSession(html) {
  const marker = 'const SESSION = ';
  const start = html.indexOf(marker);
  assert.ok(start >= 0, 'renderHTML should embed const SESSION');
  const jsonStart = start + marker.length;
  const jsonEnd = html.indexOf(';\n', jsonStart);
  assert.ok(jsonEnd > jsonStart, 'SESSION JSON should terminate before bundle script');
  return JSON.parse(html.slice(jsonStart, jsonEnd));
}

/**
 * Outcome checks on rendered viewer HTML: title prefix, inlined SESSION fields,
 * chapter count from the same payload the browser uses, and preserved events/stats.
 */
function assertRenderedViewerSession(html, session, { chapterCount, promptSnippet } = {}) {
  assert.ok(html.startsWith('<!DOCTYPE html>'), 'viewer should be a full HTML document');
  assert.match(html, new RegExp(`<title>tracequest — ${session.sessionId.slice(0, 8)}`));
  const inlined = parseInlinedSession(html);
  assert.equal(inlined.sessionId, session.sessionId, 'inlined SESSION.sessionId');
  assert.equal(inlined.source, session.source);
  assert.equal(inlined.model, session.model);
  assert.equal(inlined.cwd, session.cwd);
  assert.equal(inlined.gitBranch, session.gitBranch);
  assert.equal(buildSessionChapters(inlined).length, chapterCount, 'chapter count from inlined SESSION');
  if (promptSnippet) {
    assert.ok(
      inlined.events.some((e) => e.type === 'user' && e.text?.includes(promptSnippet)),
      `inlined SESSION should retain user prompt containing ${promptSnippet}`,
    );
  }
  const bashCalls = inlined.events.flatMap(
    (e) => (e.type === 'assistant' ? e.toolCalls ?? [] : []),
  );
  assert.ok(
    bashCalls.some((tc) => tc.name === 'Bash'),
    'inlined SESSION should retain assistant Bash tool call',
  );
  assert.equal(inlined.stats.toolCounts?.Bash, session.stats.toolCounts?.Bash);
  assert.equal(inlined.stats.totalInputTokens, session.stats.totalInputTokens);
  assert.equal(inlined.stats.totalOutputTokens, session.stats.totalOutputTokens);
}

describe('renderHTML cache key and LRU', () => {
  test('returns identical string reference on repeated render with same cache key', () => {
    const session = baseSession({ sessionId: 'tq-render-hit-01' });
    const a = renderHTML(session);
    const b = renderHTML(session);
    assert.strictEqual(a, b);
  });

  test('cache key includes sessionId: different id busts cache despite identical events', () => {
    const events = [
      { type: 'user', text: 'shared', timestamp: '2026-06-01T10:00:00.000Z' },
    ];
    const a = baseSession({ sessionId: 'tq-render-id-a', events });
    const b = baseSession({ sessionId: 'tq-render-id-b', events });
    const htmlA = renderHTML(a);
    const htmlB = renderHTML(b);
    assert.notStrictEqual(htmlA, htmlB);
    assert.ok(htmlA.includes('tq-render-id-a'));
    assert.ok(htmlB.includes('tq-render-id-b'));
  });

  test('invalidates when events.length changes', () => {
    const session = baseSession({ sessionId: 'tq-render-len-01' });
    const html1 = renderHTML(session);
    session.events.push({
      type: 'user',
      text: 'appended-for-cache-bust',
      timestamp: '2026-06-01T10:01:00.000Z',
    });
    session.eventCount = session.events.length;
    const html2 = renderHTML(session);
    assert.notStrictEqual(html1, html2);
    assert.ok(html2.includes('appended-for-cache-bust'));
  });

  test('invalidates when last event timestamp changes without length change', () => {
    const session = baseSession({ sessionId: 'tq-render-lastts-01' });
    session.events.push({
      type: 'assistant',
      text: 'tail-marker-alpha',
      timestamp: '2026-06-01T10:02:00.000Z',
    });
    const html1 = renderHTML(session);
    const tail = session.events[session.events.length - 1];
    tail.text = 'tail-marker-beta';
    tail.timestamp = '2026-06-01T10:03:00.000Z';
    const html2 = renderHTML(session);
    assert.notStrictEqual(html1, html2);
    assert.ok(html2.includes('tail-marker-beta'));
    assert.ok(!html2.includes('tail-marker-alpha'));
  });

  test('invalidates when endTime changes with same events', () => {
    const session = baseSession({ sessionId: 'tq-render-end-01' });
    const html1 = renderHTML(session);
    session.endTime = '2026-06-01T11:00:00.000Z';
    const html2 = renderHTML(session);
    assert.notStrictEqual(html1, html2);
  });

  test('uses startTime in cache key when endTime absent', () => {
    const session = baseSession({
      sessionId: 'tq-render-startkey-01',
      endTime: undefined,
      startTime: '2026-06-01T09:00:00.000Z',
    });
    const html1 = renderHTML(session);
    session.startTime = '2026-06-01T09:30:00.000Z';
    const html2 = renderHTML(session);
    assert.notStrictEqual(html1, html2);
  });

  test('empty events uses zero length and empty last timestamp in cache key', () => {
    const session = baseSession({
      sessionId: 'tq-render-empty-ev-01',
      events: [],
      eventCount: 0,
    });
    const html1 = renderHTML(session);
    session.endTime = '2026-06-01T12:00:00.000Z';
    const html2 = renderHTML(session);
    assert.notStrictEqual(html1, html2);
  });

  test('same cache key keeps cached HTML when only non-tail event body changes', () => {
    const session = baseSession({ sessionId: 'tq-render-mid-mut-01' });
    session.events.push({
      type: 'assistant',
      text: 'stable-tail',
      timestamp: '2026-06-01T10:04:00.000Z',
    });
    const html1 = renderHTML(session);
    session.events[0].text = 'mutated-head-not-in-key';
    const html2 = renderHTML(session);
    assert.strictEqual(html1, html2);
    assert.ok(!html2.includes('mutated-head-not-in-key'));
  });

  test('LRU evicts oldest entry after more than five distinct cache keys', () => {
    const ids = [
      'tq-render-lru-00',
      'tq-render-lru-01',
      'tq-render-lru-02',
      'tq-render-lru-03',
      'tq-render-lru-04',
      'tq-render-lru-05',
    ];
    const sessions = ids.map((sessionId, i) =>
      baseSession({
        sessionId,
        endTime: `2026-06-01T10:0${i}:00.000Z`,
        events: [
          {
            type: 'user',
            text: `marker-${sessionId}`,
            timestamp: `2026-06-01T10:0${i}:00.000Z`,
          },
        ],
      }),
    );
    const firstHtml = renderHTML(sessions[0]);
    for (let i = 1; i < sessions.length; i++) {
      renderHTML(sessions[i]);
    }
    sessions[0].events[0].text = 'marker-tq-render-lru-00-v2';
    const refreshed = renderHTML(sessions[0]);
    assert.notStrictEqual(firstHtml, refreshed);
    assert.ok(refreshed.includes('marker-tq-render-lru-00-v2'));
  });
});

describe('renderHTML title escaping', () => {
  test('title shows first eight characters of sessionId', () => {
    const html = renderHTML(baseSession({ sessionId: 'abcdefgh-ignored-suffix' }));
    assert.equal(titleLine(html), 'tracequest — abcdefgh');
  });

  test('title falls back to literal session when sessionId missing', () => {
    const session = baseSession({ sessionId: undefined });
    delete session.sessionId;
    const html = renderHTML(session);
    assert.equal(titleLine(html), 'tracequest — session');
  });

  test('title escapes ampersand in sessionId prefix', () => {
    const html = renderHTML(baseSession({ sessionId: 'a&b|cdef-extra' }));
    assert.equal(titleLine(html), 'tracequest — a&amp;b|cdef');
  });

  test('title escapes less-than and greater-than in sessionId prefix', () => {
    const html = renderHTML(baseSession({ sessionId: '<tag>!!!-rest' }));
    assert.equal(titleLine(html), 'tracequest — &lt;tag&gt;!!!');
  });

  test('title escapes double quotes in sessionId prefix', () => {
    const html = renderHTML(baseSession({ sessionId: '"evil"-xxxxxx' }));
    assert.equal(titleLine(html), 'tracequest — &quot;evil&quot;-x');
  });

  test('title does not contain raw HTML/script delimiters from malicious id', () => {
    const html = renderHTML(baseSession({ sessionId: '<script>alert(1)</script>-x' }));
    const title = titleLine(html);
    assert.ok(!title.includes('<script>'));
    assert.match(title, /&lt;script/);
    const headEnd = html.indexOf('</head>');
    assert.ok(headEnd > 0, 'expected </head>');
    const head = html.slice(0, headEnd);
    assert.ok(!head.match(/<title>[^&]*<script/));
  });

  test('title escaping is applied once on cache miss, cached title unchanged on hit', () => {
    const session = baseSession({ sessionId: 'x&yzzzzz-tail' });
    const html1 = renderHTML(session);
    const html2 = renderHTML(session);
    assert.strictEqual(html1, html2);
    assert.equal(titleLine(html1), 'tracequest — x&amp;yzzzzz');
  });
});

describe('renderHTML document shell', () => {
  test('embeds JSON-safe session payload and standard shell markers', () => {
    const session = baseSession({
      sessionId: 'tq-render-shell-01',
      events: [
        {
          type: 'user',
          text: 'closes </script> tag',
          timestamp: '2026-06-01T10:00:00.000Z',
        },
      ],
    });
    const html = renderHTML(session);
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.ok(html.includes('const SESSION = '));
    assert.ok(html.includes('closes <\\/script> tag'));
    assert.ok(!html.includes('closes </script> tag'));
    assert.ok(html.includes('<div id="app"></div>'));
  });
});

function makeLargeSession(id) {
  const events = [];
  for (let i = 0; i < 5000; i++) {
    events.push({
      type: i % 2 === 0 ? 'user' : 'assistant',
      text: 'x'.repeat(200),
      timestamp: '2026-01-01T00:00:00.000Z'
    });
  }
  return {
    sessionId: id,
    source: 'claude',
    cwd: '/tmp/test',
    model: 'claude-3-5-sonnet',
    gitBranch: 'main',
    startTime: '2026-01-01T00:00:00.000Z',
    endTime: '2026-01-01T00:01:00.000Z',
    durationMs: 60000,
    eventCount: events.length,
    events,
    stats: {
      toolCounts: { Bash: 1 },
      totalInputTokens: 10,
      totalOutputTokens: 5,
      totalCacheHit: 0,
      errors: 0,
      userMessages: 1,
      assistantTurns: 1,
      tokensEstimated: false
    }
  };
}

describe('render core', () => {
  test('renderHTML produces self-contained HTML embedding session data', () => {
    const session = {
      sessionId: 'abc123def4567890',
      source: 'claude',
      cwd: '/tmp/test',
      model: 'claude-3-5-sonnet',
      gitBranch: 'main',
      startTime: '2026-01-01T00:00:00.000Z',
      endTime: '2026-01-01T00:01:00.000Z',
      durationMs: 60000,
      eventCount: 3,
      events: [
        { type: 'user', text: 'hello world', timestamp: '2026-01-01T00:00:00.000Z' },
        {
          type: 'assistant',
          text: 'hi there',
          toolCalls: [{ id: '1', name: 'Bash', input: 'ls' }],
          tokens: { input: 10, output: 5, cacheHit: 0, cacheWrite: 0 },
          stopReason: 'end_turn',
          timestamp: '2026-01-01T00:00:30.000Z'
        },
        { type: 'tool_result', text: 'file1.txt', timestamp: '2026-01-01T00:00:31.000Z' }
      ],
      stats: {
        toolCounts: { Bash: 1 },
        totalInputTokens: 10,
        totalOutputTokens: 5,
        totalCacheHit: 0,
        errors: 0,
        userMessages: 1,
        assistantTurns: 1,
        tokensEstimated: false
      }
    };
    const html = renderHTML(session);
    assert.equal(typeof html, 'string');
    assertRenderedViewerSession(html, session, {
      chapterCount: 1,
      promptSnippet: 'hello world',
    });
    assert.ok(html.includes('<style>') && html.includes('</style>'), 'self-contained inline CSS');
    assert.ok(html.includes('<script>'), 'self-contained viewer script bundle');
  });

  test('renderHTML caches its output for identical session snapshots', () => {
    const session = makeLargeSession('cached-session-id');
    const html1 = renderHTML(session);
    const html2 = renderHTML(session);
    assert.strictEqual(html1, html2);
  });

  test('renderHTML cache invalidates when last event timestamp changes without length change', () => {
    const session = makeLargeSession('ts-invalidate-id');
    const html1 = renderHTML(session);
    const last = session.events[session.events.length - 1];
    last.text = 'updated tail content';
    last.timestamp = '2026-01-01T00:02:00.000Z';
    const html2 = renderHTML(session);
    assert.notStrictEqual(html1, html2);
    assert.ok(html2.includes('updated tail content'));
  });

  test('renderHTML cache invalidates when events.length changes', () => {
    const session = makeLargeSession('invalidate-session-id');
    const html1 = renderHTML(session);
    session.events.push({ type: 'user', text: 'new event', timestamp: '2026-01-01T00:00:00.000Z' });
    const html2 = renderHTML(session);
    assert.notStrictEqual(html1, html2);
    assert.ok(html2.includes('new event'));
  });

  test('renderHTML cold path uses precomputed shell for large sessions', () => {
    const ITERS = 15;
    const sessions = Array.from({ length: ITERS }, (_, i) =>
      makeLargeSession(`tq-render-perf-${i}`),
    );
    const t0 = performance.now();
    for (const session of sessions) {
      const html = renderHTML(session);
      assert.ok(html.includes('const SESSION = '));
      assert.ok(html.includes('<style>'));
    }
    const ms = (performance.now() - t0) / ITERS;
    assertPerf(
      ms < 15,
      `expected renderHTML cold path under 15ms/op for 5k events, got ${ms.toFixed(2)}ms`,
    );
  });
});
