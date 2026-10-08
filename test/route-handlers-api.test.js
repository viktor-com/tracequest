import "./helpers/skip-lr-watch-env.js";
import { installModVersionTestHygiene } from "./helpers/mod-version-hygiene.js";
import { getSearchIndex, resetSearchIndexForTests } from "../src/sessions/search-index.js";
import { tokenize } from "../src/sessions/search-tokenizer.js";

import { test, describe, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  getSessionsAndIndex,
  computeStats,
  handleApiSessions,
  handleApiSearch,
  buildSearchCatalog,
  parseApiSearchCatalog,
} from "../src/routes/route-handlers-api.js";
import { clearRouteCache } from "../src/routes/route-cache.js";
import { setInitialFilter } from "../src/server/server-state.js";
import { clearLiveSessionsCache } from "../src/sessions/live-sessions.js";
import { captureJsonHandler } from "./helpers/capture-json-handler.js";


installModVersionTestHygiene();

afterEach(() => {
  clearRouteCache();
  clearLiveSessionsCache();
  setInitialFilter(null);
  resetSearchIndexForTests();
});

/** Populate the SearchIndex with terms from text for a given path. */
function seedSearchIndex(path, text) {
  const si = getSearchIndex();
  const terms = tokenize(text);
  const termFreqs = new Map();
  for (const t of terms) termFreqs.set(t, (termFreqs.get(t) || 0) + 1);
  si.upsert(path, termFreqs);
}

function makeApiObject(overrides = {}) {
  return {
    path: '/fake/s0.jsonl',
    source: 'claude',
    project: 'my-project',
    id: 's0',
    totalTokens: 1000,
    inputTokens: 600,
    outputTokens: 400,
    cacheReadTokens: 100,
    durationMs: 5000,
    errors: 0,
    commits: 1,
    files: 3,
    chapters: 2,
    model: 'claude-sonnet-4-6',
    tools: ['Bash', 'Edit'],
    toolCounts: { Bash: 2, Edit: 1 },
    ...overrides,
  };
}

const STATS_KEYS = [
  'totalSessions', 'totalTokens', 'totalInputTokens', 'totalOutputTokens',
  'totalCacheReadTokens', 'totalDurationMs', 'totalErrors', 'totalCommits',
  'totalFiles', 'totalChapters', 'totalCost', 'toolAgg', 'projectCounts',
  'sourceCounts', 'modelCounts', 'gradeDist', 'errorSessionCount',
];

const SESSION_ITEM_KEYS = [
  'path', 'source', 'projectRaw', 'project', 'id', 'sizeKB', 'mtime', 'prompt', 'model',
  'tools', 'toolCounts', 'chapters', 'totalTokens', 'inputTokens',
  'outputTokens', 'cacheReadTokens', 'durationMs', 'errors', 'files', 'commits',
];

const SESSIONS_ENVELOPE_KEYS = ['sessions', 'total', 'page', 'pageSize', 'stats', 'liveSessions'];

function makeApiSessionRow(i) {
  return {
    path: `/fake/s${i}.jsonl`,
    mtime: new Date(Date.now() - i * 60000),
    size: 2048,
    source: 'claude',
    project: 'proj',
    file: `s${i}.jsonl`,
  };
}

describe('route-handlers-api getSessionsAndIndex', () => {
  test('loads sessions and index from deps using filter param', () => {
    const sessions = [{ path: '/a.jsonl', mtime: new Date(), size: 1 }];
    const index = new Map([['/a.jsonl', { firstPrompt: 'hi' }]]);
    const findSessions = mock.fn(() => sessions);
    const buildIndex = mock.fn(() => index);
    const url = new URL('http://localhost:7777/api/sessions?filter=my-filter');

    const result = getSessionsAndIndex(url, { findSessions, buildIndex });

    assert.equal(findSessions.mock.calls.length, 1);
    assert.equal(findSessions.mock.calls[0].arguments[0], 'my-filter');
    assert.equal(buildIndex.mock.calls.length, 1);
    assert.strictEqual(result.sessions, sessions);
    assert.strictEqual(result.index, index);
  });

  test('passes null filter when param absent', () => {
    const findSessions = mock.fn(() => []);
    const buildIndex = mock.fn(() => new Map());
    const url = new URL('http://localhost:7777/api/sessions');
    getSessionsAndIndex(url, { findSessions, buildIndex });
    assert.equal(findSessions.mock.calls[0].arguments[0], null);
  });
});

describe('route-handlers-api computeStats', () => {
  test('returns zeroed aggregates for empty input', () => {
    const stats = computeStats([]);
    assert.equal(stats.totalSessions, 0);
    assert.equal(stats.totalTokens, 0);
    assert.equal(stats.totalCost, 0);
    assert.equal(stats.errorSessionCount, 0);
    assert.deepEqual(stats.gradeDist, { A: 0, B: 0, C: 0, D: 0, F: 0 });
  });

  test('sums token and duration fields across sessions', () => {
    const stats = computeStats([
      makeApiObject({ totalTokens: 100, inputTokens: 60, outputTokens: 40, durationMs: 1000 }),
      makeApiObject({ totalTokens: 200, inputTokens: 120, outputTokens: 80, durationMs: 2000 }),
    ]);
    assert.equal(stats.totalSessions, 2);
    assert.equal(stats.totalTokens, 300);
    assert.equal(stats.totalInputTokens, 180);
    assert.equal(stats.totalOutputTokens, 120);
    assert.equal(stats.totalDurationMs, 3000);
  });

  test('counts error sessions and aggregates tools by name', () => {
    const stats = computeStats([
      makeApiObject({ errors: 2, tools: ['Bash'] }),
      makeApiObject({ errors: 0, tools: ['Bash', 'Edit'] }),
    ]);
    assert.equal(stats.totalErrors, 2);
    assert.equal(stats.errorSessionCount, 1);
    assert.equal(stats.toolAgg.Bash, 2);
    assert.equal(stats.toolAgg.Edit, 1);
  });

  test('builds project, source, and model histograms', () => {
    const stats = computeStats([
      makeApiObject({ project: 'alpha', source: 'claude', model: 'claude-sonnet-4-6' }),
      makeApiObject({ project: 'alpha', source: 'codex', model: 'gpt-4.1' }),
      makeApiObject({ project: 'beta', source: 'claude', model: '' }),
    ]);
    assert.equal(stats.projectCounts.alpha, 2);
    assert.equal(stats.projectCounts.beta, 1);
    assert.equal(stats.sourceCounts.claude, 2);
    assert.equal(stats.sourceCounts.codex, 1);
    assert.ok(typeof stats.modelCounts === 'object');
    assert.ok(Object.keys(stats.modelCounts).length >= 1);
  });

  test('includes grade distribution for graded sessions', () => {
    const stats = computeStats([
      makeApiObject({ chapters: 3, errors: 0, toolCounts: { Bash: 5 } }),
    ]);
    const letters = Object.values(stats.gradeDist).reduce((a, b) => a + b, 0);
    assert.ok(letters >= 1, 'at least one letter grade should be recorded');
  });

  test('accumulates estimated cost from token breakdown', () => {
    const stats = computeStats([makeApiObject()]);
    assert.ok(stats.totalCost >= 0);
    assert.equal(typeof stats.totalCost, 'number');
  });

  test('aggregates cacheReadTokens, commits, files, and chapters', () => {
    const stats = computeStats([
      makeApiObject({ cacheReadTokens: 50, commits: 2, files: 4, chapters: 3 }),
      makeApiObject({ cacheReadTokens: 30, commits: 1, files: 6, chapters: 5 }),
    ]);
    assert.equal(stats.totalCacheReadTokens, 80);
    assert.equal(stats.totalCommits, 3);
    assert.equal(stats.totalFiles, 10);
    assert.equal(stats.totalChapters, 8);
  });

  test('treats missing numeric fields as zero', () => {
    const stats = computeStats([{
      project: 'p',
      source: 'claude',
      tools: [],
      errors: 0,
    }]);
    assert.equal(stats.totalTokens, 0);
    assert.equal(stats.totalDurationMs, 0);
    assert.equal(stats.totalErrors, 0);
    assert.equal(stats.errorSessionCount, 0);
  });

  test('omits empty model from modelCounts histogram', () => {
    const stats = computeStats([
      makeApiObject({ model: 'claude-sonnet-4-6' }),
      makeApiObject({ model: '' }),
    ]);
    const modelKeys = Object.keys(stats.modelCounts);
    assert.equal(modelKeys.length, 1);
    assert.ok(stats.modelCounts[modelKeys[0]] >= 1);
  });

  test('totalCost sums per-session estimates', () => {
    const a = makeApiObject({ inputTokens: 1_000_000, outputTokens: 500_000 });
    const b = makeApiObject({ inputTokens: 100, outputTokens: 50 });
    const stats = computeStats([a, b]);
    const singleA = computeStats([a]).totalCost;
    const singleB = computeStats([b]).totalCost;
    assert.equal(stats.totalCost, singleA + singleB);
  });

  test('toolAgg counts each tool once per session, not per invocation', () => {
    const stats = computeStats([
      makeApiObject({ tools: ['Bash', 'Edit'] }),
      makeApiObject({ tools: ['Bash'] }),
    ]);
    assert.equal(stats.toolAgg.Bash, 2);
    assert.equal(stats.toolAgg.Edit, 1);
  });

  test('errorSessionCount counts sessions with errors>0, not error events', () => {
    const stats = computeStats([
      makeApiObject({ errors: 5 }),
      makeApiObject({ errors: 10 }),
      makeApiObject({ errors: 0 }),
    ]);
    assert.equal(stats.errorSessionCount, 2);
    assert.equal(stats.totalErrors, 15);
  });

  test('zero chapters does not increment gradeDist buckets', () => {
    const stats = computeStats([
      makeApiObject({ chapters: 0, errors: 0, toolCounts: { Bash: 1 } }),
      makeApiObject({ chapters: 0 }),
    ]);
    assert.deepEqual(stats.gradeDist, { A: 0, B: 0, C: 0, D: 0, F: 0 });
    assert.equal(stats.totalChapters, 0);
  });

  test('handles undefined or null tools without throwing', () => {
    const stats = computeStats([
      makeApiObject({ tools: undefined }),
      makeApiObject({ tools: null }),
      { project: 'p', source: 'claude', tools: [] },
    ]);
    assert.deepEqual(stats.toolAgg, {});
    assert.equal(stats.totalSessions, 3);
  });

  test('duplicate tool names in one session increment toolAgg per entry', () => {
    const stats = computeStats([
      makeApiObject({ tools: ['Bash', 'Bash', 'Edit'] }),
    ]);
    assert.equal(stats.toolAgg.Bash, 2);
    assert.equal(stats.toolAgg.Edit, 1);
  });

  test('negative errors sum into totalErrors but skip errorSessionCount', () => {
    const stats = computeStats([makeApiObject({ errors: -1 })]);
    assert.equal(stats.totalErrors, -1);
    assert.equal(stats.errorSessionCount, 0);
  });

  test('null project and source keys appear in histograms', () => {
    const stats = computeStats([
      makeApiObject({ project: null, source: null }),
      makeApiObject({ project: null, source: 'claude' }),
    ]);
    assert.equal(stats.projectCounts.null, 2);
    assert.equal(stats.sourceCounts.null, 1);
    assert.equal(stats.sourceCounts.claude, 1);
  });

  test('returns every STATS_KEYS field on empty and populated input', () => {
    for (const stats of [computeStats([]), computeStats([makeApiObject()])]) {
      for (const key of STATS_KEYS) {
        assert.ok(key in stats, `missing key: ${key}`);
      }
    }
  });

  test('opus model yields higher totalCost than sonnet for same tokens', () => {
    const tokens = { inputTokens: 500_000, outputTokens: 200_000, cacheReadTokens: 50_000 };
    const sonnet = computeStats([makeApiObject({ ...tokens, model: 'claude-sonnet-4-6' })]);
    const opus = computeStats([makeApiObject({ ...tokens, model: 'claude-opus-4-6' })]);
    assert.ok(opus.totalCost > sonnet.totalCost);
  });

  test('gradeDist accumulates multiple letter buckets in one batch', () => {
    const high = makeApiObject({
      chapters: 5,
      errors: 0,
      inputTokens: 100_000,
      cacheReadTokens: 90_000,
      toolCounts: { Bash: 20 },
    });
    const low = makeApiObject({
      chapters: 1,
      errors: 50,
      inputTokens: 100,
      cacheReadTokens: 0,
      toolCounts: { Bash: 1 },
    });
    const stats = computeStats([high, low, makeApiObject({ chapters: 0 })]);
    assert.equal(stats.gradeDist.A, 1);
    assert.equal(stats.gradeDist.F, 1);
    assert.equal(stats.gradeDist.B + stats.gradeDist.C + stats.gradeDist.D, 0);
  });

  test('modelCounts merges shortModel variants of the same family', () => {
    const stats = computeStats([
      makeApiObject({ model: 'claude-sonnet-4-6' }),
      makeApiObject({ model: 'claude-sonnet-4-6-20250514' }),
    ]);
    const keys = Object.keys(stats.modelCounts);
    assert.equal(keys.length, 1);
    assert.equal(stats.modelCounts[keys[0]], 2);
  });

  test('zero token sessions contribute zero cost', () => {
    const stats = computeStats([
      makeApiObject({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }),
      makeApiObject({ inputTokens: undefined, outputTokens: undefined }),
    ]);
    assert.equal(stats.totalCost, 0);
  });
});

describe('route-handlers-api handleApiSessions', () => {
  const makeSession = makeApiSessionRow;

  function makeDeps(sessionCount = 3) {
    const sessions = Array.from({ length: sessionCount }, (_, i) => makeSession(i));
    const index = new Map();
    for (const s of sessions) {
      index.set(s.path, {
        firstPrompt: `prompt ${s.file}`,
        model: 'claude-sonnet-4-6',

        tools: ['Bash'],
        toolCounts: { Bash: 1 },
        chapters: 1,
        totalTokens: 1000,
        inputTokens: 600,
        outputTokens: 400,
        errors: 0,
      });
    }
    return { findSessions: () => sessions, buildIndex: () => index };
  }

  test('responds with JSON content-type and pagination envelope', async () => {
    const { res, parse, headers } = captureJsonHandler();
    const url = new URL('http://localhost:7777/api/sessions?pageSize=2');
    await handleApiSessions({}, res, url, makeDeps(5));
    assert.ok(headers['Content-Type'].includes('application/json'));
    const data = parse();
    assert.equal(data.sessions.length, 2);
    assert.equal(data.total, 5);
    assert.equal(data.pageSize, 2);
    assert.ok(data.stats);
  });

  test('reuses route cache on repeat requests with the same filter', async () => {
    clearRouteCache();
    const sessions = Array.from({ length: 2 }, (_, i) => makeSession(i));
    const index = new Map();
    for (const s of sessions) {
      index.set(s.path, {
        firstPrompt: `prompt ${s.file}`,
        model: 'claude-sonnet-4-6',

        tools: ['Bash'],
        toolCounts: { Bash: 1 },
        chapters: 1,
        totalTokens: 1000,
        inputTokens: 600,
        outputTokens: 400,
        errors: 0,
      });
    }
    const findSessions = mock.fn(() => sessions);
    const buildIndex = mock.fn(() => index);
    const deps = { findSessions, buildIndex };
    const url = new URL('http://localhost:7777/api/sessions?filter=cache-once');

    const { res: res1 } = captureJsonHandler();
    const { res: res2 } = captureJsonHandler();
    await handleApiSessions({}, res1, url, deps);
    await handleApiSessions({}, res2, url, deps);

    assert.equal(findSessions.mock.calls.length, 1);
    assert.equal(buildIndex.mock.calls.length, 1);
  });

  test('strips searchText from page items and liveSessions', async () => {
    const { res, parse } = captureJsonHandler();
    await handleApiSessions({}, res, new URL('http://localhost:7777/api/sessions'), makeDeps(2));
    const data = parse();
    for (const s of data.sessions) {
      assert.equal(s.searchText, undefined);
    }
    for (const s of data.liveSessions) {
      assert.equal(s.searchText, undefined);
    }
  });

  test('clamps page beyond last page to maxPage', async () => {
    const { res, parse } = captureJsonHandler();
    const url = new URL('http://localhost:7777/api/sessions?page=99&pageSize=10');
    await handleApiSessions({}, res, url, makeDeps(5));
    const data = parse();
    assert.equal(data.page, 1);
    assert.equal(data.sessions.length, 5);
  });

  test('filters with expr param and aligns stats.totalSessions with total', async () => {
    const sessions = [
      makeSession(0),
      { ...makeSession(1), source: 'factory' },
      makeSession(2),
    ];
    const index = makeDeps(3).buildIndex();
    const { res, parse } = captureJsonHandler();
    const url = new URL('http://localhost:7777/api/sessions?expr=source:factory');
    await handleApiSessions({}, res, url, {
      findSessions: () => sessions,
      buildIndex: () => index,
    });
    const data = parse();
    assert.equal(data.total, 1);
    assert.equal(data.stats.totalSessions, 1);
    assert.equal(data.sessions[0].source, 'factory');
  });

  test('pageSize is capped at 200', async () => {
    const { res, parse } = captureJsonHandler();
    const url = new URL('http://localhost:7777/api/sessions?pageSize=500');
    await handleApiSessions({}, res, url, makeDeps(10));
    assert.equal(parse().pageSize, 200);
  });

  test('JSON envelope has only expected top-level keys', async () => {
    const { res, parse } = captureJsonHandler();
    await handleApiSessions({}, res, new URL('http://localhost:7777/api/sessions'), makeDeps(1));
    assert.deepEqual(Object.keys(parse()).sort(), [...SESSIONS_ENVELOPE_KEYS].sort());
  });

  test('stats object exposes full dashboard metric shape', async () => {
    const { res, parse } = captureJsonHandler();
    await handleApiSessions({}, res, new URL('http://localhost:7777/api/sessions'), makeDeps(2));
    const { stats } = parse();
    for (const key of STATS_KEYS) {
      assert.ok(key in stats, `stats missing key: ${key}`);
    }
    assert.deepEqual(Object.keys(stats.gradeDist).sort(), ['A', 'B', 'C', 'D', 'F']);
  });

  test('session items include core API fields from sessionToApiObject', async () => {
    const { res, parse } = captureJsonHandler();
    await handleApiSessions({}, res, new URL('http://localhost:7777/api/sessions?pageSize=1'), makeDeps(1));
    const item = parse().sessions[0];
    for (const key of SESSION_ITEM_KEYS) {
      assert.ok(key in item, `session item missing key: ${key}`);
    }
    assert.equal(typeof item.path, 'string');
    assert.equal(typeof item.mtime, 'number');
    assert.ok(Array.isArray(item.tools));
  });

  test('defaults page to 1 and pageSize to 50 when params omitted', async () => {
    const { res, parse } = captureJsonHandler();
    await handleApiSessions({}, res, new URL('http://localhost:7777/api/sessions'), makeDeps(60));
    const data = parse();
    assert.equal(data.page, 1);
    assert.equal(data.pageSize, 50);
    assert.equal(data.sessions.length, 50);
    assert.equal(data.total, 60);
  });

  test('coerces invalid page and pageSize to safe defaults', async () => {
    const { res, parse } = captureJsonHandler();
    const url = new URL('http://localhost:7777/api/sessions?page=0&pageSize=not-a-number');
    await handleApiSessions({}, res, url, makeDeps(3));
    const data = parse();
    assert.equal(data.page, 1);
    assert.equal(data.pageSize, 50);
  });

  test('empty session list returns valid zero envelope', async () => {
    const { res, parse } = captureJsonHandler();
    await handleApiSessions({}, res, new URL('http://localhost:7777/api/sessions'), {
      findSessions: () => [],
      buildIndex: () => new Map(),
    });
    const data = parse();
    assert.deepEqual(data.sessions, []);
    assert.deepEqual(data.liveSessions, []);
    assert.equal(data.total, 0);
    assert.equal(data.stats.totalSessions, 0);
  });

  test('stats reflect full filtered set, not only the current page slice', async () => {
    const sessions = Array.from({ length: 4 }, (_, i) => makeSession(i));
    const index = new Map();
    for (const s of sessions) {
      index.set(s.path, {
        firstPrompt: 'p',
        totalTokens: 1000 * (sessions.indexOf(s) + 1),
        inputTokens: 100,
        outputTokens: 50,
        errors: 0,
        tools: [],
        toolCounts: {},
        chapters: 1,
      });
    }
    const { res, parse } = captureJsonHandler();
    const url = new URL('http://localhost:7777/api/sessions?page=2&pageSize=1');
    await handleApiSessions({}, res, url, {
      findSessions: () => sessions,
      buildIndex: () => index,
    });
    const data = parse();
    assert.equal(data.sessions.length, 1);
    assert.equal(data.stats.totalSessions, 4);
    assert.equal(data.stats.totalTokens, 1000 + 2000 + 3000 + 4000);
  });

  test('liveSessions is always an array and omits searchText', async () => {
    const { res, parse } = captureJsonHandler();
    await handleApiSessions({}, res, new URL('http://localhost:7777/api/sessions'), makeDeps(2));
    const data = parse();
    assert.ok(Array.isArray(data.liveSessions));
    for (const s of data.liveSessions) {
      assert.equal(s.searchText, undefined);
    }
  });

  test('sort=tokens orders sessions by totalTokens descending', async () => {
    const sessions = [makeSession(0), makeSession(1), makeSession(2)];
    const tokens = [100, 900, 300];
    const index = new Map(sessions.map((s, i) => [s.path, {
      firstPrompt: 'p',
      totalTokens: tokens[i],
      inputTokens: 1,
      outputTokens: 1,
      errors: 0,
      tools: [],
      toolCounts: {},
      chapters: 0,
    }]));
    const { res, parse } = captureJsonHandler();
    await handleApiSessions({}, res, new URL('http://localhost:7777/api/sessions?sort=tokens'), {
      findSessions: () => sessions,
      buildIndex: () => index,
    });
    const totals = parse().sessions.map((s) => s.totalTokens);
    assert.deepEqual(totals, [900, 300, 100]);
  });

});

/** Sessions API deps with optional partial index; missing paths fall through to peekSession. */
function makePeekFallbackDeps(sessions, { indexEntries = {}, peekImpl } = {}) {
  const index = new Map();
  for (const [path, meta] of Object.entries(indexEntries)) {
    index.set(path, meta);
  }
  const peekSession = mock.fn(
    peekImpl
      ?? ((s) => ({
        firstPrompt: `peek-${s.file}`,
        model: 'peek-default-model',
        totalTokens: 100,
        inputTokens: 60,
        outputTokens: 40,
        cacheReadTokens: 5,
        durationMs: 1200,
        errors: 0,
        tools: ['Read'],
        toolCounts: { Read: 1 },
        chapters: 1,
        files: 2,
        commits: 1,
      })),
  );
  return {
    findSessions: () => sessions,
    buildIndex: () => index,
    peekSession,
  };
}

async function runPeekFallbackApi(sessions, opts = {}, url = 'http://localhost:7777/api/sessions') {
  const deps = makePeekFallbackDeps(sessions, opts);
  const { res, parse } = captureJsonHandler();
  await handleApiSessions({}, res, new URL(url), deps);
  return { data: parse(), peekSession: deps.peekSession };
}

describe('route-handlers-api handleApiSessions peekSession fallback', () => {
  const makeSession = makeApiSessionRow;

  test('uses peekSession when index has no entry for a path', async () => {
    const s = makeSession(0);
    const peekSession = mock.fn(() => ({
      firstPrompt: 'from-peek',
      model: 'peek-model',
      totalTokens: 42,
      inputTokens: 10,
      outputTokens: 5,
      errors: 0,
      tools: [],
      toolCounts: {},
      chapters: 0,
    }));
    const { res, parse } = captureJsonHandler();
    await handleApiSessions({}, res, new URL('http://localhost:7777/api/sessions'), {
      findSessions: () => [s],
      buildIndex: () => new Map(),
      peekSession,
    });
    assert.equal(peekSession.mock.calls.length, 1);
    const item = parse().sessions[0];
    assert.equal(item.prompt, 'from-peek');
    assert.equal(item.totalTokens, 42);
  });

  test('passes each session row to peekSession by reference', async () => {
    const s = makeSession(3);
    const { peekSession } = await runPeekFallbackApi([s]);
    assert.equal(peekSession.mock.calls.length, 1);
    assert.strictEqual(peekSession.mock.calls[0].arguments[0], s);
  });

  test('does not call peekSession when index already has the path', async () => {
    const s = makeSession(0);
    const { peekSession } = await runPeekFallbackApi([s], {
      indexEntries: {
        [s.path]: {
          firstPrompt: 'from-index',
          model: 'index-model',
          totalTokens: 999,
          inputTokens: 1,
          outputTokens: 1,
          errors: 0,
          tools: [],
          toolCounts: {},
          chapters: 0,
        },
      },
    });
    assert.equal(peekSession.mock.calls.length, 0);
  });

  test('calls peekSession only for paths missing from a partial index', async () => {
    const indexed = makeSession(0);
    const unindexedA = makeSession(1);
    const unindexedB = makeSession(2);
    const { peekSession } = await runPeekFallbackApi(
      [indexed, unindexedA, unindexedB],
      {
        indexEntries: {
          [indexed.path]: {
            firstPrompt: 'indexed-only',
            totalTokens: 1,
            inputTokens: 0,
            outputTokens: 0,
            errors: 0,
            tools: [],
            toolCounts: {},
            chapters: 0,
          },
        },
      },
    );
    assert.equal(peekSession.mock.calls.length, 2);
    const peekedPaths = peekSession.mock.calls.map((c) => c.arguments[0].path);
    assert.deepEqual(peekedPaths.sort(), [unindexedA.path, unindexedB.path].sort());
  });

  test('maps token, tool, and activity fields from peek meta into API items', async () => {
    const s = makeSession(0);
    const { data: { sessions: [item] } } = await runPeekFallbackApi([s], {
      peekImpl: () => ({
        firstPrompt: 'full-peek-prompt',
        model: 'gpt-5.1-codex',
        totalTokens: 5000,
        inputTokens: 3000,
        outputTokens: 2000,
        cacheReadTokens: 800,
        durationMs: 90_000,
        errors: 3,
        tools: ['Bash', 'Edit'],
        toolCounts: { Bash: 4, Edit: 2 },
        chapters: 7,
        files: 11,
        commits: 4,
      }),
    });
    assert.equal(item.prompt, 'full-peek-prompt');
    assert.equal(item.model, 'gpt-5.1-codex');
    assert.equal(item.totalTokens, 5000);
    assert.equal(item.inputTokens, 3000);
    assert.equal(item.outputTokens, 2000);
    assert.equal(item.cacheReadTokens, 800);
    assert.equal(item.durationMs, 90_000);
    assert.equal(item.errors, 3);
    assert.deepEqual(item.tools, ['Bash', 'Edit']);
    assert.deepEqual(item.toolCounts, { Bash: 4, Edit: 2 });
    assert.equal(item.chapters, 7);
    assert.equal(item.files, 11);
    assert.equal(item.commits, 4);
    assert.equal(item.searchText, undefined);
  });

  test('stats aggregate totals from peek meta for unindexed sessions', async () => {
    const a = makeSession(0);
    const b = makeSession(1);
    const { data: { stats } } = await runPeekFallbackApi([a, b], {
      peekImpl: (s) => ({
        firstPrompt: 'p',
        totalTokens: s.file === 's0.jsonl' ? 1000 : 250,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        durationMs: 500,
        errors: 1,
        tools: ['Bash'],
        toolCounts: { Bash: 1 },
        chapters: 2,
        files: 1,
        commits: 1,
      }),
    });
    assert.equal(stats.totalSessions, 2);
    assert.equal(stats.totalTokens, 1250);
    assert.equal(stats.totalInputTokens, 200);
    assert.equal(stats.totalOutputTokens, 100);
    assert.equal(stats.totalCacheReadTokens, 20);
    assert.equal(stats.totalDurationMs, 1000);
    assert.equal(stats.totalErrors, 2);
    assert.equal(stats.errorSessionCount, 2);
    assert.equal(stats.totalFiles, 2);
    assert.equal(stats.totalCommits, 2);
    assert.equal(stats.totalChapters, 4);
    assert.equal(stats.toolAgg.Bash, 2);
  });

  test('expr bare term matches firstPrompt supplied by peekSession', async () => {
    const s = makeSession(0);
    const { data } = await runPeekFallbackApi(
      [s],
      {
        peekImpl: () => ({
          firstPrompt: 'xyzzy-peek-marker-token',
          totalTokens: 1,
          inputTokens: 0,
          outputTokens: 0,
          errors: 0,
          tools: [],
          toolCounts: {},
          chapters: 0,
        }),
      },
      'http://localhost:7777/api/sessions?expr=xyzzy-peek-marker',
    );
    assert.equal(data.total, 1);
    assert.equal(data.sessions[0].path, s.path);
  });

  test('sort=tokens orders using peek totalTokens when index entry is absent', async () => {
    const low = makeSession(0);
    const mid = makeSession(1);
    const high = makeSession(2);
    const tokenByFile = { 's0.jsonl': 50, 's1.jsonl': 500, 's2.jsonl': 5000 };
    const { data } = await runPeekFallbackApi(
      [low, mid, high],
      {
        peekImpl: (s) => ({
          firstPrompt: 'p',
          totalTokens: tokenByFile[s.file],
          inputTokens: 1,
          outputTokens: 1,
          errors: 0,
          tools: [],
          toolCounts: {},
          chapters: 0,
        }),
      },
      'http://localhost:7777/api/sessions?sort=tokens&pageSize=10',
    );
    assert.deepEqual(
      data.sessions.map((row) => row.totalTokens),
      [5000, 500, 50],
    );
  });

  test('prompt falls back to session.title when peek omits firstPrompt', async () => {
    const s = { ...makeSession(0), title: 'Title From Session Row' };
    const { data: { sessions: [item] } } = await runPeekFallbackApi([s], {
      peekImpl: () => ({
        model: 'm',
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        errors: 0,
        tools: [],
        toolCounts: {},
        chapters: 0,
      }),
    });
    assert.equal(item.prompt, 'Title From Session Row');
  });

  test('peekSession returning sparse meta zero-fills missing numeric API fields', async () => {
    const { data: { sessions: [item], stats } } = await runPeekFallbackApi([makeSession(0)], {
      peekImpl: () => ({}),
    });
    assert.equal(item.prompt, '');
    assert.equal(item.model, '');
    assert.equal(item.totalTokens, 0);
    assert.equal(item.chapters, 0);
    assert.deepEqual(item.tools, []);
    assert.deepEqual(item.toolCounts, {});
    assert.equal(stats.totalTokens, 0);
    assert.equal(stats.totalCost, 0);
  });

  test('mixed index and peek: indexed meta wins without calling peek for that path', async () => {
    const indexed = makeSession(0);
    const peeked = makeSession(1);
    const { data, peekSession } = await runPeekFallbackApi([indexed, peeked], {
      indexEntries: {
        [indexed.path]: {
          firstPrompt: 'index-wins',
          totalTokens: 777,
          inputTokens: 1,
          outputTokens: 1,
          errors: 0,
          tools: [],
          toolCounts: {},
          chapters: 0,
        },
      },
      peekImpl: () => ({
        firstPrompt: 'peek-loses-for-other',
        totalTokens: 1,
        inputTokens: 0,
        outputTokens: 0,
        errors: 0,
        tools: [],
        toolCounts: {},
        chapters: 0,
      }),
    });
    assert.equal(peekSession.mock.calls.length, 1);
    const byPath = Object.fromEntries(data.sessions.map((row) => [row.path, row]));
    assert.equal(byPath[indexed.path].prompt, 'index-wins');
    assert.equal(byPath[indexed.path].totalTokens, 777);
    assert.equal(byPath[peeked.path].prompt, 'peek-loses-for-other');
  });
});

function makeSearchSessionRow(path, overrides = {}) {
  return {
    path,
    mtime: new Date(),
    size: 100,
    source: 'claude',
    project: 'p',
    file: path.split('/').pop(),
    ...overrides,
  };
}

/** Builds N indexed sessions that all match the same API search needle. */
function makeIndexedSearchFixture(count, token = 'api-cap-needle') {
  const sessions = [];
  const index = new Map();
  for (let i = 0; i < count; i++) {
    const p = `/fake/api-cap-${i}.jsonl`;
    sessions.push(makeSearchSessionRow(p, { file: `api-cap-${i}.jsonl` }));
    seedSearchIndex(p, `${token} hit ${i}`);
    index.set(p, { firstPrompt: `prompt ${i}` });
  }
  return { sessions, index, token };
}

describe('route-handlers-api handleApiSearch', () => {
  test('returns empty results for blank query without scanning', async () => {
    const findSessions = mock.fn(() => []);
    const buildIndex = mock.fn(() => new Map());
    const { res, parse } = captureJsonHandler();
    await handleApiSearch({}, res, new URL('http://localhost:7777/api/search?q='), {
      findSessions,
      buildIndex,
    });
    assert.deepEqual(parse(), { results: [] });
    assert.equal(findSessions.mock.calls.length, 0);
  });

  test('returns JSON search hits when query is non-empty', async () => {
    const sessions = [{
      path: '/fake/a.jsonl',
      mtime: new Date(),
      size: 100,
      source: 'claude',
      project: 'p',
      file: 'a.jsonl',
    }];
    seedSearchIndex('/fake/a.jsonl', 'unique-needle-here');
    const index = new Map([['/fake/a.jsonl', {}]]);
    const { res, parse } = captureJsonHandler();
    await handleApiSearch({}, res, new URL('http://localhost:7777/api/search?q=needle'), {
      findSessions: () => sessions,
      buildIndex: () => index,
    });
    const data = parse();
    assert.ok(Array.isArray(data.results));
    assert.ok(data.results.length >= 1);
  });

  test('applies filter param when loading sessions for search', async () => {
    const findSessions = mock.fn(() => []);
    const buildIndex = mock.fn(() => new Map());
    const { res } = captureJsonHandler();
    await handleApiSearch({}, res, new URL('http://localhost:7777/api/search?q=x&filter=proj-a'), {
      findSessions,
      buildIndex,
    });
    assert.equal(findSessions.mock.calls[0].arguments[0], 'proj-a');
  });

  test('whitespace-only query returns empty results without scanning', async () => {
    const findSessions = mock.fn(() => [{ path: '/x.jsonl' }]);
    const buildIndex = mock.fn(() => new Map());
    const { res, parse } = captureJsonHandler();
    await handleApiSearch({}, res, new URL('http://localhost:7777/api/search?q=%20%20'), {
      findSessions,
      buildIndex,
    });
    assert.deepEqual(parse(), { results: [] });
    assert.equal(findSessions.mock.calls.length, 0);
  });

  test('responds with application/json charset utf-8', async () => {
    const { res, headers } = captureJsonHandler();
    await handleApiSearch({}, res, new URL('http://localhost:7777/api/search?q=hi'), {
      findSessions: () => [],
      buildIndex: () => new Map(),
    });
    assert.equal(headers['Content-Type'], 'application/json; charset=utf-8');
  });

  test('result items include path, prompt, and matches array', async () => {
    const sessions = [{
      path: '/fake/z.jsonl',
      mtime: new Date(),
      size: 512,
      source: 'claude',
      project: 'proj-z',
      file: 'z.jsonl',
    }];
    seedSearchIndex('/fake/z.jsonl', 'alpha beta gamma needle omega');
    const index = new Map([['/fake/z.jsonl', {
      firstPrompt: 'start prompt',
      model: 'claude-sonnet-4-6',
    }]]);
    const { res, parse } = captureJsonHandler();
    await handleApiSearch({}, res, new URL('http://localhost:7777/api/search?q=needle'), {
      findSessions: () => sessions,
      buildIndex: () => index,
    });
    const hit = parse().results[0];
    assert.equal(hit.path, '/fake/z.jsonl');
    assert.equal(hit.prompt, 'start prompt');
    assert.ok(Array.isArray(hit.matches));
    assert.ok(hit.matches.length >= 1);
    assert.equal(typeof hit.id, 'string');
  });

  test('search is case-insensitive on indexed content', async () => {
    const sessions = [{
      path: '/fake/case.jsonl',
      mtime: new Date(),
      size: 1,
      source: 'claude',
      project: 'p',
      file: 'case.jsonl',
    }];
    seedSearchIndex('/fake/case.jsonl', 'UPPERCASE-TOKEN-XYZ');
    const index = new Map([['/fake/case.jsonl', { firstPrompt: '' }]]);
    const { res, parse } = captureJsonHandler();
    await handleApiSearch({}, res, new URL('http://localhost:7777/api/search?q=uppercase-token'), {
      findSessions: () => sessions,
      buildIndex: () => index,
    });
    assert.equal(parse().results.length, 1);
  });

  test('excludes sessions with no indexed term match', async () => {
    const sessions = [
      { path: '/a.jsonl', mtime: new Date(), size: 1, source: 'claude', project: 'p', file: 'a.jsonl' },
      { path: '/b.jsonl', mtime: new Date(), size: 1, source: 'claude', project: 'p', file: 'b.jsonl' },
    ];
    seedSearchIndex('/a.jsonl', 'only-a-has-token');
    seedSearchIndex('/b.jsonl', 'unrelated content');
    const index = new Map([
      ['/a.jsonl', { firstPrompt: 'a' }],
      ['/b.jsonl', { firstPrompt: 'b' }],
    ]);
    const { res, parse } = captureJsonHandler();
    await handleApiSearch({}, res, new URL('http://localhost:7777/api/search?q=only-a-has'), {
      findSessions: () => sessions,
      buildIndex: () => index,
    });
    assert.equal(parse().results.length, 1);
    assert.equal(parse().results[0].path, '/a.jsonl');
  });

  test('matches firstPrompt term when it is in the SearchIndex', async () => {
    const sessions = [{
      path: '/fake/prompt-only.jsonl',
      mtime: new Date(),
      size: 1,
      source: 'claude',
      project: 'p',
      file: 'prompt-only.jsonl',
    }];
    seedSearchIndex('/fake/prompt-only.jsonl', 'header with special-term-here');
    const index = new Map([['/fake/prompt-only.jsonl', {
      firstPrompt: 'header with special-term-here',
    }]]);
    const { res, parse } = captureJsonHandler();
    await handleApiSearch({}, res, new URL('http://localhost:7777/api/search?q=special-term'), {
      findSessions: () => sessions,
      buildIndex: () => index,
    });
    assert.equal(parse().results.length, 1);
    assert.equal(parse().results[0].prompt, 'header with special-term-here');
  });

  test('GET /api/search catalog=1 returns compact session identities', async () => {
    const sessions = [
      makeSearchSessionRow('/fake/cat-a.jsonl', { project: 'tracequest', source: 'claude' }),
      makeSearchSessionRow('/fake/cat-b.jsonl', { project: 'other', source: 'grok' }),
    ];
    const index = new Map([
      ['/fake/cat-a.jsonl', { firstPrompt: 'Document the catalog path', model: 'opus', tools: ['Read', 'Bash'] }],
      ['/fake/cat-b.jsonl', { firstPrompt: 'Unrelated prompt', model: 'grok', tools: ['WebSearch'] }],
    ]);
    const searchSessions = mock.fn(() => {
      throw new Error('catalog must not call searchSessions');
    });
    const peekSession = mock.fn(() => {
      throw new Error('catalog must not peek session files');
    });
    const { res, parse } = captureJsonHandler();
    await handleApiSearch({}, res, new URL('http://localhost:7777/api/search?catalog=1'), {
      findSessions: () => sessions,
      buildIndex: () => index,
      searchSessions,
      peekSession,
    });
    assert.equal(searchSessions.mock.calls.length, 0);
    assert.equal(peekSession.mock.calls.length, 0);
    const data = parse();
    assert.ok(Array.isArray(data.sessions));
    assert.equal(data.sessions.length, 2);
    const row = data.sessions[0];
    assert.equal(row.source, 'claude');
    assert.equal(row.prompt, 'Document the catalog path');
    assert.equal(row.model, 'opus');
    assert.equal(row.project, 'tracequest');
    assert.deepEqual(row.tools, ['Read', 'Bash']);
    assert.equal(typeof row.id, 'string');
    assert.ok(row.id.length >= 8);
    assert.equal(data.sessions[1].source, 'grok');
    assert.ok(!Object.hasOwn(row, 'path'));
    assert.equal(parseApiSearchCatalog('1'), true);
    assert.equal(parseApiSearchCatalog(''), false);
    const built = buildSearchCatalog(sessions, index);
    assert.equal(built[0].prompt, 'Document the catalog path');
    assert.deepEqual(built[0].tools, ['Read', 'Bash']);
  });

  test('GET /api/search honors limit and snippets=0', async () => {
    const { sessions, index, token } = makeIndexedSearchFixture(20);
    let captured;
    const searchSessions = mock.fn((sess, idx, q, max, opts) => {
      captured = { max, opts };
      return sess.slice(0, max).map((s, i) => ({
        path: s.path,
        id: `id${i}`,
        prompt: `prompt ${i}`,
        matches: [{ type: 'text', snippet: `prompt ${i}` }],
      }));
    });
    const { res, parse } = captureJsonHandler();
    await handleApiSearch({}, res, new URL(`http://localhost:7777/api/search?q=${token}&limit=8&snippets=0`), {
      findSessions: () => sessions,
      buildIndex: () => index,
      searchSessions,
    });
    assert.equal(captured.max, 8);
    assert.equal(captured.opts.snippets, false);
    const data = parse();
    assert.equal(data.results.length, 8);
    assert.ok(data.results.every((r) => r.id && r.prompt != null));
  });

  test('caps results at 50 indexed hits (API scan limit)', async () => {
    const { sessions, index, token } = makeIndexedSearchFixture(55);
    const { res, parse } = captureJsonHandler();
    await handleApiSearch({}, res, new URL(`http://localhost:7777/api/search?q=${token}`), {
      findSessions: () => sessions,
      buildIndex: () => index,
    });
    assert.equal(parse().results.length, 50);
  });

  test('stops scanning once 50 matches are found across a larger pool', async () => {
    const { sessions, index, token } = makeIndexedSearchFixture(60);
    const { res, parse } = captureJsonHandler();
    await handleApiSearch({}, res, new URL(`http://localhost:7777/api/search?q=${token}`), {
      findSessions: () => sessions,
      buildIndex: () => index,
    });
    const data = parse();
    assert.equal(data.results.length, 50);
    assert.ok(data.results.every((r) => (r.matches?.length || 0) >= 1));
  });

  test('project filter narrows findSessions pool before search', async () => {
    const alphaPath = '/fake/api-alpha.jsonl';
    const betaPath = '/fake/api-beta.jsonl';
    const allSessions = [
      makeSearchSessionRow(alphaPath, { project: 'api-proj-alpha', file: 'api-alpha.jsonl' }),
      makeSearchSessionRow(betaPath, { project: 'api-proj-beta', file: 'api-beta.jsonl' }),
    ];
    seedSearchIndex(alphaPath, 'shared-api-needle alpha');
    seedSearchIndex(betaPath, 'shared-api-needle beta');
    const index = new Map([
      [alphaPath, { firstPrompt: 'a' }],
      [betaPath, { firstPrompt: 'b' }],
    ]);
    const findSessions = mock.fn((filter) => {
      if (!filter) return allSessions;
      return allSessions.filter((s) => (s.project || '').includes(filter));
    });
    const buildIndex = mock.fn(() => index);
    const { res, parse } = captureJsonHandler();
    await handleApiSearch({}, res, new URL('http://localhost:7777/api/search?q=shared-api-needle&filter=api-proj-alpha'), {
      findSessions,
      buildIndex,
    });
    assert.equal(findSessions.mock.calls[0].arguments[0], 'api-proj-alpha');
    assert.equal(buildIndex.mock.calls[0].arguments[0].length, 1);
    assert.equal(buildIndex.mock.calls[0].arguments[0][0].path, alphaPath);
    const hits = parse().results;
    assert.equal(hits.length, 1);
    assert.equal(hits[0].path, alphaPath);
    assert.ok(hits[0].project.includes('api-proj-alpha'));
  });

  test('without project filter both projects can match the same query', async () => {
    const alphaPath = '/fake/api-alpha.jsonl';
    const betaPath = '/fake/api-beta.jsonl';
    const sessions = [
      makeSearchSessionRow(alphaPath, { project: 'api-proj-alpha', file: 'api-alpha.jsonl' }),
      makeSearchSessionRow(betaPath, { project: 'api-proj-beta', file: 'api-beta.jsonl' }),
    ];
    seedSearchIndex(alphaPath, 'dual-hit-needle alpha');
    seedSearchIndex(betaPath, 'dual-hit-needle beta');
    const index = new Map([
      [alphaPath, { firstPrompt: 'a' }],
      [betaPath, { firstPrompt: 'b' }],
    ]);
    const { res, parse } = captureJsonHandler();
    await handleApiSearch({}, res, new URL('http://localhost:7777/api/search?q=dual-hit-needle'), {
      findSessions: () => sessions,
      buildIndex: () => index,
    });
    assert.equal(parse().results.length, 2);
  });

  test('expr param narrows search hits to matching sessions', async () => {
    const sonnetPath = '/fake/search-sonnet.jsonl';
    const opusPath = '/fake/search-opus.jsonl';
    const sessions = [
      makeSearchSessionRow(sonnetPath, { file: 'search-sonnet.jsonl' }),
      makeSearchSessionRow(opusPath, { file: 'search-opus.jsonl' }),
    ];
    seedSearchIndex(sonnetPath, 'shared-search-expr-needle sonnet body');
    seedSearchIndex(opusPath, 'shared-search-expr-needle opus body');
    const index = new Map([
      [sonnetPath, { firstPrompt: 'sonnet prompt', model: 'claude-sonnet-4-20250514' }],
      [opusPath, { firstPrompt: 'opus prompt', model: 'claude-opus-4-20250514' }],
    ]);
    const { res, parse } = captureJsonHandler();
    await handleApiSearch(
      {},
      res,
      new URL('http://localhost:7777/api/search?q=shared-search-expr-needle&expr=model:sonnet'),
      {
        findSessions: () => sessions,
        buildIndex: () => index,
      },
    );
    const hits = parse().results;
    assert.equal(hits.length, 1);
    assert.equal(hits[0].path, sonnetPath);
    assert.match(hits[0].model, /sonnet/i);
  });

  test('falls back to getInitialFilter when filter param absent', async () => {
    setInitialFilter('initial-search-filter');
    const findSessions = mock.fn(() => []);
    const buildIndex = mock.fn(() => new Map());
    const { res } = captureJsonHandler();
    await handleApiSearch({}, res, new URL('http://localhost:7777/api/search?q=x'), {
      findSessions,
      buildIndex,
    });
    assert.equal(findSessions.mock.calls[0].arguments[0], 'initial-search-filter');
  });

  test('treats empty ?filter= as null because empty string is falsy', async () => {
    const findSessions = mock.fn(() => []);
    const buildIndex = mock.fn(() => new Map());
    const { res } = captureJsonHandler();
    await handleApiSearch({}, res, new URL('http://localhost:7777/api/search?q=x&filter='), {
      findSessions,
      buildIndex,
    });
    assert.equal(findSessions.mock.calls[0].arguments[0], null);
  });
});

describe('route-handlers barrel omits API symbols', () => {
  test('route-handlers.js does not re-export route-handlers-api', async () => {
    const handlers = await import('../src/routes/route-handlers.js');
    assert.equal(handlers.handleApiSessions, undefined);
    assert.equal(handlers.handleApiSearch, undefined);
    assert.equal(handlers.computeStats, undefined);
    assert.equal(handlers.getSessionsAndIndex, undefined);
  });

  test('routes.js wires /api/sessions and /api/search to API module', async () => {
    const routes = await import('../src/routes.js');
    assert.equal(routes.ROUTE_MAP['/api/sessions'], handleApiSessions);
    assert.equal(routes.ROUTE_MAP['/api/search'], handleApiSearch);
  });
});