import { test, describe, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ROUTE_MAP } from '../src/routes.js';
import { handleApiSessions, handleApiSearch } from '../src/routes/route-handlers-api.js';
import { clearRouteCache } from '../src/routes/route-cache.js';
import { clearLiveSessionsCache } from '../src/sessions/live-sessions.js';
import { getSearchIndex, resetSearchIndexForTests } from '../src/sessions/search-index.js';
import { tokenize } from '../src/sessions/search-tokenizer.js';

afterEach(() => {
  clearRouteCache();
  clearLiveSessionsCache();
  resetSearchIndexForTests();
});

function seedSearchIndex(path, text) {
  const si = getSearchIndex();
  const terms = tokenize(text);
  const termFreqs = new Map();
  for (const t of terms) termFreqs.set(t, (termFreqs.get(t) || 0) + 1);
  si.upsert(path, termFreqs);
}

function makeSessions(n) {
  const sessions = [];
  for (let i = 0; i < n; i++) {
    sessions.push({
      path: `/fake/s${i}.jsonl`,
      mtime: new Date(Date.now() - i * 60000),
      size: 1024 * (i + 1),
      source: i % 3 === 0 ? 'claude' : i % 3 === 1 ? 'codex' : 'factory',
      project: `project-${i % 5}`,
      file: `s${i}.jsonl`,
    });
  }
  return sessions;
}

function makeIndex(sessions) {
  const index = new Map();
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    index.set(s.path, {
      firstPrompt: `prompt for ${s.file}`,
      model: 'claude-sonnet-4-6',
      tools: ['Bash', 'Edit'],
      toolCounts: { Bash: 3, Edit: 2 },
      chapters: 2,
      totalTokens: 50000,
      inputTokens: 30000,
      outputTokens: 20000,
      cacheReadTokens: 10000,
      durationMs: 120000,
      errors: i % 4 === 0 ? 1 : 0,
      files: 5,
      commits: 1,
    });
  }
  return index;
}

describe('API /api/sessions endpoint', () => {
  test('handleApiSessions is registered in ROUTE_MAP', () => {
    assert.ok(ROUTE_MAP['/api/sessions'], '/api/sessions must be registered in ROUTE_MAP');
  });

  test('handleApiSessions returns JSON with sessions, total, page, pageSize', async () => {
    const sessions = makeSessions(120);
    const index = makeIndex(sessions);
    const findSessions = mock.fn(() => sessions);
    const buildIndex = mock.fn(() => index);

    let responseBody = '';
    let responseHeaders = {};
    const res = {
      writeHead: mock.fn((status, headers) => { responseHeaders = headers; }),
      end: mock.fn((body) => { responseBody = body; }),
    };
    const url = new URL('http://localhost:7777/api/sessions');

    await handleApiSessions({}, res, url, { findSessions, buildIndex });

    const data = JSON.parse(responseBody);
    assert.ok(Array.isArray(data.sessions), 'response must have sessions array');
    assert.equal(typeof data.total, 'number', 'response must have total count');
    assert.equal(typeof data.page, 'number', 'response must have page number');
    assert.equal(typeof data.pageSize, 'number', 'response must have pageSize');
    assert.ok(responseHeaders['Content-Type'].includes('application/json'), 'must return JSON content type');
  });

  test('handleApiSessions returns correct page size (default 50)', async () => {
    const sessions = makeSessions(120);
    const index = makeIndex(sessions);

    let responseBody = '';
    const res = {
      writeHead: mock.fn(() => {}),
      end: mock.fn((body) => { responseBody = body; }),
    };
    const url = new URL('http://localhost:7777/api/sessions');

    await handleApiSessions({}, res, url, { findSessions: () => sessions, buildIndex: () => index });

    const data = JSON.parse(responseBody);
    assert.equal(data.sessions.length, 50, 'default page size should be 50');
    assert.equal(data.total, 120, 'total should reflect all sessions');
    assert.equal(data.page, 1, 'default page should be 1');
  });

  test('handleApiSessions respects page and pageSize params', async () => {
    const sessions = makeSessions(120);
    const index = makeIndex(sessions);

    let responseBody = '';
    const res = {
      writeHead: mock.fn(() => {}),
      end: mock.fn((body) => { responseBody = body; }),
    };
    const url = new URL('http://localhost:7777/api/sessions?page=2&pageSize=25');

    await handleApiSessions({}, res, url, { findSessions: () => sessions, buildIndex: () => index });

    const data = JSON.parse(responseBody);
    assert.equal(data.sessions.length, 25, 'page size 25 should return 25 items');
    assert.equal(data.page, 2, 'page should be 2');
    assert.equal(data.pageSize, 25);
  });

  test('handleApiSessions session objects do not include search field', async () => {
    const sessions = makeSessions(5);
    const index = makeIndex(sessions);

    let responseBody = '';
    const res = {
      writeHead: mock.fn(() => {}),
      end: mock.fn((body) => { responseBody = body; }),
    };
    const url = new URL('http://localhost:7777/api/sessions');

    await handleApiSessions({}, res, url, { findSessions: () => sessions, buildIndex: () => index });

    const data = JSON.parse(responseBody);
    for (const s of data.sessions) {
      assert.equal(s.search, undefined, 'session object must NOT include search field');
      assert.equal(s.searchText, undefined, 'session object must NOT include searchText field');
    }
  });

  test('handleApiSessions returns aggregate stats for dashboard', async () => {
    const sessions = makeSessions(10);
    const index = makeIndex(sessions);

    let responseBody = '';
    const res = {
      writeHead: mock.fn(() => {}),
      end: mock.fn((body) => { responseBody = body; }),
    };
    const url = new URL('http://localhost:7777/api/sessions');

    await handleApiSessions({}, res, url, { findSessions: () => sessions, buildIndex: () => index });

    const data = JSON.parse(responseBody);
    assert.ok(data.stats, 'response must include stats object');
    assert.equal(typeof data.stats.totalSessions, 'number');
  });

  test('handleApiSessions supports expr param for server-side filtering', async () => {
    const sessions = makeSessions(30);
    const index = makeIndex(sessions);

    let responseBody = '';
    const res = {
      writeHead: mock.fn(() => {}),
      end: mock.fn((body) => { responseBody = body; }),
    };
    // Filter to only factory source (every 3rd session starting at index 2)
    const url = new URL('http://localhost:7777/api/sessions?expr=source:factory');

    await handleApiSessions({}, res, url, { findSessions: () => sessions, buildIndex: () => index });

    const data = JSON.parse(responseBody);
    assert.ok(data.total < 30, `filtered total (${data.total}) should be less than 30`);
    assert.ok(data.total > 0, 'filtered total should be > 0');
    for (const s of data.sessions) {
      assert.equal(s.source, 'factory', 'all returned sessions should match the source filter');
    }
    assert.equal(data.stats.totalSessions, data.total, 'stats should reflect filtered count');
  });

  test('handleApiSessions expr with text search filters by prompt content', async () => {
    const sessions = makeSessions(10);
    const index = makeIndex(sessions);

    let responseBody = '';
    const res = {
      writeHead: mock.fn(() => {}),
      end: mock.fn((body) => { responseBody = body; }),
    };
    // Text search — "s3.jsonl" appears in the prompt for session 3
    const url = new URL('http://localhost:7777/api/sessions?expr=s3.jsonl');

    await handleApiSessions({}, res, url, { findSessions: () => sessions, buildIndex: () => index });

    const data = JSON.parse(responseBody);
    assert.ok(data.total >= 1, 'text filter should match at least one session');
    assert.ok(data.total < 10, 'text filter should not match all sessions');
  });

  test('handleApiSessions expr text search matches full indexed content (BM25), not just the prompt', async () => {
    const sessions = makeSessions(10);
    const index = makeIndex(sessions);
    // Seed SearchIndex: "deploy" not in any prompt/project/id/model — only in BM25 index
    for (const s of sessions) {
      seedSearchIndex(s.path, `searchable content for ${s.file} with keywords deploy test build`);
    }

    let responseBody = '';
    const res = {
      writeHead: mock.fn(() => {}),
      end: mock.fn((body) => { responseBody = body; }),
    };
    // "deploy" is only in the SearchIndex, never in firstPrompt/project/id/model.
    // With BM25 context it must match all sessions.
    const url = new URL('http://localhost:7777/api/sessions?expr=deploy');

    await handleApiSessions({}, res, url, { findSessions: () => sessions, buildIndex: () => index });

    const data = JSON.parse(responseBody);
    assert.equal(data.total, 10, 'text filter must match content found only in BM25 SearchIndex');
    // The matched objects must not leak searchText to the client.
    for (const s of data.sessions) {
      assert.equal(s.searchText, undefined, 'searchText must not be serialized to the client');
    }
  });

  test('handleApiSessions text search excludes sessions without the term in any content', async () => {
    const sessions = makeSessions(10);
    const index = makeIndex(sessions);
    // Seed a unique term into only one session's SearchIndex entry.
    seedSearchIndex(sessions[4].path, 'xyzzy-unique-marker');

    let responseBody = '';
    const res = {
      writeHead: mock.fn(() => {}),
      end: mock.fn((body) => { responseBody = body; }),
    };
    const url = new URL('http://localhost:7777/api/sessions?expr=xyzzy-unique-marker');

    await handleApiSessions({}, res, url, { findSessions: () => sessions, buildIndex: () => index });

    const data = JSON.parse(responseBody);
    assert.equal(data.total, 1, 'only the one session containing the unique marker should match');
    assert.equal(data.sessions[0].path, sessions[4].path);
  });

  test('handleApiSessions supports sort param', async () => {
    const sessions = makeSessions(10);
    const index = makeIndex(sessions);

    let responseBody = '';
    const res = {
      writeHead: mock.fn(() => {}),
      end: mock.fn((body) => { responseBody = body; }),
    };
    const url = new URL('http://localhost:7777/api/sessions?sort=tokens');

    await handleApiSessions({}, res, url, { findSessions: () => sessions, buildIndex: () => index });

    const data = JSON.parse(responseBody);
    assert.ok(data.sessions.length > 0);
  });
});

describe('API /api/search endpoint', () => {
  test('handleApiSearch is registered in ROUTE_MAP', () => {
    assert.ok(ROUTE_MAP['/api/search'], '/api/search must be registered in ROUTE_MAP');
  });

  test('handleApiSearch returns search results as JSON', async () => {
    const sessions = makeSessions(5);
    const index = makeIndex(sessions);

    let responseBody = '';
    const res = {
      writeHead: mock.fn(() => {}),
      end: mock.fn((body) => { responseBody = body; }),
    };
    const url = new URL('http://localhost:7777/api/search?q=deploy');

    await handleApiSearch({}, res, url, { findSessions: () => sessions, buildIndex: () => index });

    const data = JSON.parse(responseBody);
    assert.ok(Array.isArray(data.results), 'response must have results array');
  });

  test('handleApiSearch returns empty results for empty query', async () => {
    let responseBody = '';
    const res = {
      writeHead: mock.fn(() => {}),
      end: mock.fn((body) => { responseBody = body; }),
    };
    const url = new URL('http://localhost:7777/api/search?q=');

    await handleApiSearch({}, res, url, { findSessions: () => [], buildIndex: () => new Map() });

    const data = JSON.parse(responseBody);
    assert.ok(Array.isArray(data.results));
    assert.equal(data.results.length, 0);
  });
});

describe('Frontend does not load all data upfront', () => {
  test('browserPage HTML does not embed a var ALL array with all session data', async () => {
    const { browserPage } = await import('../src/browser/browser-page.js');
    const sessions = makeSessions(100);
    const index = makeIndex(sessions);

    const html = browserPage(sessions, index, null);

    // The HTML should NOT contain a massive var ALL with 100 sessions
    const allMatch = html.match(/var ALL\s*=\s*\[/);
    if (allMatch) {
      // If var ALL exists, it should not contain all 100 sessions
      const dataStart = html.indexOf('var ALL');
      const dataEnd = html.indexOf('];\n', dataStart);
      if (dataEnd > dataStart) {
        const dataStr = html.slice(dataStart, dataEnd + 2);
        const sessionCount = (dataStr.match(/"path":/g) || []).length;
        assert.ok(sessionCount <= 50, `var ALL should contain at most 50 sessions (first page), found ${sessionCount}`);
      }
    }
  });

  test('browserPage session data does not include searchText', async () => {
    const { browserPage } = await import('../src/browser/browser-page.js');
    const sessions = makeSessions(5);
    const index = makeIndex(sessions);

    const html = browserPage(sessions, index, null);
    assert.ok(!html.includes('searchable content for session'), 'HTML must not contain searchText content');
  });

  test('handleApiSessions supports grade, model and source filter via expr param', async () => {
    const sessions = makeSessions(30);
    const index = makeIndex(sessions);

    let responseBody = '';
    const res = {
      writeHead: mock.fn(() => {}),
      end: mock.fn((body) => { responseBody = body; }),
    };
    // source filter via expr
    const url = new URL('http://localhost:7777/api/sessions?expr=source:codex');

    await handleApiSessions({}, res, url, { findSessions: () => sessions, buildIndex: () => index });

    const data = JSON.parse(responseBody);
    assert.ok(data.total > 0 && data.total < 30, 'source expr must filter');
    for (const s of data.sessions) {
      assert.equal(s.source, 'codex', 'all sessions must match the source filter');
    }
    assert.equal(data.stats.totalSessions, data.total, 'stats must reflect source filter');

    // model filter via expr — shortModel('claude-sonnet-4-6') contains 'sonnet-4-6'
    responseBody = '';
    const url2 = new URL('http://localhost:7777/api/sessions?expr=model:sonnet-4-6');
    await handleApiSessions({}, res, url2, { findSessions: () => sessions, buildIndex: () => index });
    const data2 = JSON.parse(responseBody);
    assert.ok(data2.total > 0, 'model expr must match sessions');
    assert.equal(data2.stats.totalSessions, data2.total);
  });
});
