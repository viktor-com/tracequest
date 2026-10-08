import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleApiSearch } from '../../src/routes/route-handlers-api.js';
import { clearRouteCache } from '../../src/routes/route-cache.js';
import { captureJsonHandler } from '../helpers/capture-json-handler.js';
import { sessionRow, makeSearchDeps } from '../helpers/api-route-cache-fixtures.js';
import { getSearchIndex, resetSearchIndexForTests } from '../../src/sessions/search-index.js';
import { accumulateTermFreqs } from '../../src/sessions/search-tokenizer.js';

function seedSearchIndex(filePath, text) {
  const si = getSearchIndex();
  const termFreqs = new Map();
  accumulateTermFreqs(text, termFreqs, [text.length + 1]);
  si.upsert(filePath, termFreqs);
}

/** Register route-cache tests for handleApiSearch (shared resolveSessionsAndIndex). */
export function registerApiSearchCacheTests() {
  describe('handleApiSearch route cache', () => {
    afterEach(() => {
      clearRouteCache();
      resetSearchIndexForTests();
    });

    test('repeated /api/search with same filter hits route cache (single findSessions)', async () => {
      const rows = [
        sessionRow('/fake/search-alpha.jsonl', 'alpha-proj'),
        sessionRow('/fake/search-beta.jsonl', 'beta-proj'),
      ];
      const deps = makeSearchDeps(rows);
      const url = new URL(
        'http://localhost:7777/api/search?q=fixture-needle&filter=alpha-proj',
      );

      const first = captureJsonHandler();
      await handleApiSearch({}, first.res, url, deps);
      first.parse();

      const second = captureJsonHandler();
      await handleApiSearch({}, second.res, url, deps);
      second.parse();

      assert.equal(deps.findSessions.mock.calls.length, 1);
      assert.deepEqual(deps.findSessions.mock.calls[0].arguments, ['alpha-proj']);
      assert.equal(deps.buildIndex.mock.calls.length, 1);
    });

    test('repeat search returns identical JSON for fixture query', async () => {
      const rows = [sessionRow('/fake/search-fixture.jsonl', 'fixture-proj')];
      seedSearchIndex('/fake/search-fixture.jsonl', 'fixture-needle content indexed');
      const deps = makeSearchDeps(rows);
      const url = new URL('http://localhost:7777/api/search?q=fixture-needle');

      const first = captureJsonHandler();
      await handleApiSearch({}, first.res, url, deps);
      const data1 = first.parse();

      const second = captureJsonHandler();
      await handleApiSearch({}, second.res, url, deps);
      const data2 = second.parse();

      assert.deepEqual(data2, data1);
      assert.equal(data1.results.length, 1);
      assert.equal(data1.results[0].path, '/fake/search-fixture.jsonl');
    });

    test('repeat search reuses cached response body string', async () => {
      const rows = [sessionRow('/fake/search-body.jsonl', 'fixture-proj')];
      const deps = makeSearchDeps(rows);
      const url = new URL('http://localhost:7777/api/search?q=fixture-needle');

      const first = captureJsonHandler();
      await handleApiSearch({}, first.res, url, deps);
      const body1 = first.res.end.mock.calls[0].arguments[0];

      const second = captureJsonHandler();
      await handleApiSearch({}, second.res, url, deps);
      const body2 = second.res.end.mock.calls[0].arguments[0];

      assert.strictEqual(body2, body1);
    });
  });
}