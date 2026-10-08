import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sessionRow } from '../helpers/api-route-cache-fixtures.js';
import { installModVersionTestHygiene } from '../helpers/mod-version-hygiene.js';
import {
  buildRouteCacheKey,
  clearRouteCache,
  DATA_ROOTS,
  getDataRoots,
  isRouteCacheTopMtimesValid,
  peekApiResponseBody,
  peekRouteCache,
  resolveSessionsAndIndex,
  routeCacheKeyWithIndexMtime,
  storeApiResponseBody,
  storeRouteCache,
} from '../../src/routes/route-cache.js';
import { indexDiskMtimeMs } from '../../src/sessions/index-writers.js';
import { bumpModVersion, modVersion } from '../../src/server/server-live-reload.js';

installModVersionTestHygiene();

/** @type {string[]} */
const tempPaths = [];

afterEach(() => {
  clearRouteCache();
  for (const p of tempPaths.splice(0)) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* already removed */
    }
  }
});

function tempJsonl(prefix = 'tracequest-route-cache') {
  const ts = Date.now() + Math.random();
  const path = join(tmpdir(), `${prefix}-${ts}.jsonl`);
  fs.writeFileSync(path, '{"x":1}\n');
  tempPaths.push(path);
  return { path, mtime: fs.statSync(path).mtime, size: fs.statSync(path).size };
}

function sessionFromPath(path) {
  const st = fs.statSync(path);
  return { path, mtime: st.mtime, size: st.size };
}

/** Newest-first, matching findSessions sort order. */
function newestFirstSessions(paths) {
  return paths.map(sessionFromPath).sort((a, b) => b.mtime - a.mtime);
}

/** Third colon-separated segment is indexDiskMtimeMs() (filter, modVersion, index mtime, …roots). */
function indexDiskMtimeSegment(cacheKey) {
  return cacheKey.split(':')[2];
}

describe('route-cache DATA_ROOTS', () => {
  test('DATA_ROOTS matches discoveryRoots paths', () => {
    assert.ok(Array.isArray(DATA_ROOTS));
    assert.ok(DATA_ROOTS.length >= 4);
    assert.deepEqual(getDataRoots(), DATA_ROOTS);
  });
});

describe('route-cache buildRouteCacheKey', () => {
  test('includes filter and mod version in key', () => {
    const key = buildRouteCacheKey('test-filter');
    assert.ok(key.startsWith('test-filter:'));
  });

  test('uses custom roots when provided', () => {
    const key = buildRouteCacheKey(null, ['/nonexistent-root-tracequest']);
    assert.ok(key.includes(':0'), 'missing root should contribute 0 mtime');
  });

  test('key is stable when nothing changes', () => {
    const key1 = buildRouteCacheKey(null);
    const key2 = buildRouteCacheKey(null);
    assert.strictEqual(key2, key1);
  });

  test('different filters produce different keys', () => {
    const a = buildRouteCacheKey('alpha');
    const b = buildRouteCacheKey('beta');
    assert.notEqual(a, b);
    assert.ok(a.startsWith('alpha:'));
    assert.ok(b.startsWith('beta:'));
  });

  test('null filter uses empty string as first segment', () => {
    const key = buildRouteCacheKey(null);
    const parts = key.split(':');
    assert.equal(parts[0], '');
  });

  test('key changes when index.json mtime changes', () => {
    const tmpDir = fs.mkdtempSync(join(tmpdir(), 'tracequest-route-cache-index-'));
    const cacheDir = join(tmpDir, '.cache', 'tracequest');
    fs.mkdirSync(cacheDir, { recursive: true });
    const indexPath = join(cacheDir, 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify({ _v: 9 }));

    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const key1 = buildRouteCacheKey('index-mtime');
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(indexPath, later, later);
      const key2 = buildRouteCacheKey('index-mtime');
      assert.notEqual(key2, key1, 'cache key must change when index.json mtime changes');
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('buildRouteCacheKey third segment tracks indexDiskMtimeMs when index.json mtime changes', () => {
    const tmpDir = fs.mkdtempSync(join(tmpdir(), 'tracequest-route-cache-index-disk-'));
    const cacheDir = join(tmpDir, '.cache', 'tracequest');
    fs.mkdirSync(cacheDir, { recursive: true });
    const indexPath = join(cacheDir, 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify({ _v: 9 }));

    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const diskMs = indexDiskMtimeMs();
      assert.equal(diskMs, fs.statSync(indexPath).mtime.getTime());

      const keyBefore = buildRouteCacheKey('index-disk-link');
      assert.equal(keyBefore.split(':')[0], 'index-disk-link');
      assert.equal(keyBefore.split(':')[1], String(modVersion()));
      assert.equal(indexDiskMtimeSegment(keyBefore), String(diskMs));

      const laterSec = Math.floor(Date.now() / 1000) + 90;
      fs.utimesSync(indexPath, laterSec, laterSec);

      const diskMsAfter = indexDiskMtimeMs();
      assert.ok(diskMsAfter > diskMs, 'indexDiskMtimeMs should reflect utimes on index.json');

      const keyAfter = buildRouteCacheKey('index-disk-link');
      assert.equal(indexDiskMtimeSegment(keyAfter), String(diskMsAfter));
      assert.notEqual(keyAfter, keyBefore);
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('buildRouteCacheKey uses 0 index segment when index.json is missing', () => {
    const tmpDir = fs.mkdtempSync(join(tmpdir(), 'tracequest-route-cache-no-index-'));
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      assert.equal(indexDiskMtimeMs(), 0);
      const key = buildRouteCacheKey('missing-index');
      assert.equal(indexDiskMtimeSegment(key), '0');
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('key changes when a custom data root directory mtime changes', () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'tracequest-route-cache-root-'));
    try {
      const key1 = buildRouteCacheKey('root-mtime', [root]);
      const later = new Date(Date.now() + 90_000);
      fs.utimesSync(root, later, later);
      const key2 = buildRouteCacheKey('root-mtime', [root]);
      assert.notEqual(key2, key1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('key changes after bumpModVersion', () => {
    const before = buildRouteCacheKey('mod-bump');
    bumpModVersion();
    const after = buildRouteCacheKey('mod-bump');
    assert.notEqual(after, before);
  });
});

describe('route-cache peek/store', () => {
  test('peekRouteCache returns null before any store', () => {
    assert.equal(peekRouteCache('never-stored'), null);
  });

  test('peekRouteCache returns stored sessions when key and mtimes match', () => {
    const key = 'peek-test';
    const sessions = [sessionFromPath(tempJsonl().path)];
    const index = new Map([['a', 1]]);
    storeRouteCache(key, sessions, index);
    const hit = peekRouteCache(key);
    assert.ok(hit);
    assert.equal(hit.sessions, sessions);
    assert.equal(hit.index, index);
  });

  test('peekRouteCache returns null when cache key does not match', () => {
    storeRouteCache('stored-key', [{ path: '/fake/x.jsonl', mtime: new Date(), size: 0 }], new Map());
    assert.equal(peekRouteCache('other-key'), null);
  });

  test('clearRouteCache evicts the stored entry', () => {
    const key = 'clear-me';
    storeRouteCache(key, [], new Map());
    assert.ok(peekRouteCache(key));
    clearRouteCache();
    assert.equal(peekRouteCache(key), null);
  });

  test('storeRouteCache overwrites prior entry for a new key', () => {
    const first = [{ path: '/a.jsonl', mtime: new Date(1), size: 1 }];
    const second = [{ path: '/b.jsonl', mtime: new Date(2), size: 2 }];
    storeRouteCache('key-a', first, new Map([['a', true]]));
    storeRouteCache('key-b', second, new Map([['b', true]]));
    assert.equal(peekRouteCache('key-a'), null);
    const hit = peekRouteCache('key-b');
    assert.equal(hit?.sessions, second);
    assert.equal(hit?.index.get('b'), true);
  });

  test('empty sessions array can be stored and retrieved', () => {
    const key = 'empty-sessions';
    const index = new Map();
    storeRouteCache(key, [], index);
    const hit = peekRouteCache(key);
    assert.ok(hit);
    assert.deepEqual(hit.sessions, []);
    assert.equal(hit.index, index);
  });

  test('peekRouteCache misses when top session file mtime changes on disk', () => {
    const { path, mtime, size } = tempJsonl('mtime-invalidate');
    const sessions = [{ path, mtime, size }];
    const key = buildRouteCacheKey('mtime-invalidate');
    storeRouteCache(key, sessions, new Map());
    assert.ok(peekRouteCache(key), 'cache should hit before mtime change');

    const later = new Date(mtime.getTime() + 60_000);
    fs.utimesSync(path, later.getTime() / 1000, later.getTime() / 1000);
    assert.equal(peekRouteCache(key), null, 'cache should miss after file mtime bump');
  });

  test('peekRouteCache does not serve stale entry after index.json rebuild', () => {
    const tmpDir = fs.mkdtempSync(join(tmpdir(), 'tracequest-route-cache-rebuild-'));
    const cacheDir = join(tmpDir, '.cache', 'tracequest');
    fs.mkdirSync(cacheDir, { recursive: true });
    const indexPath = join(cacheDir, 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify({ _v: 9 }));

    const { path, mtime, size } = tempJsonl('sess-rebuild');
    const sessions = [{ path, mtime, size }];
    const staleIndex = new Map([['stale', true]]);

    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const keyBefore = buildRouteCacheKey('index-rebuild');
      storeRouteCache(keyBefore, sessions, staleIndex);
      assert.equal(peekRouteCache(keyBefore)?.index, staleIndex);

      const later = new Date(Date.now() + 120_000);
      fs.writeFileSync(indexPath, JSON.stringify({ _v: 9, rebuilt: true }));
      fs.utimesSync(indexPath, later, later);

      const keyAfter = buildRouteCacheKey('index-rebuild');
      assert.notEqual(keyAfter, keyBefore, 'index rebuild must change cache key');
      assert.equal(peekRouteCache(keyAfter), null, 'must not serve stale cache after index rebuild');
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('peekRouteCache still hits when only the 6th newest file mtime changes', () => {
    const paths = Array.from({ length: 6 }, (_, i) => tempJsonl(`top6-${i}`).path);
    const sessions = newestFirstSessions(paths);
    const key = 'top-five-only';
    storeRouteCache(key, sessions, new Map());
    assert.ok(peekRouteCache(key));

    const sixth = sessions[5].path;
    const bumped = new Date(Date.now() + 300_000);
    fs.utimesSync(sixth, bumped.getTime() / 1000, bumped.getTime() / 1000);
    assert.ok(peekRouteCache(key), '6th file is outside top-5 mtime watch');
  });

  test('peekRouteCache misses when the 3rd newest file mtime changes', () => {
    const paths = Array.from({ length: 4 }, (_, i) => tempJsonl(`top4-${i}`).path);
    const sessions = newestFirstSessions(paths);
    const key = 'third-file';
    storeRouteCache(key, sessions, new Map());
    assert.ok(peekRouteCache(key));

    const third = sessions[2].path;
    const bumped = new Date(Date.now() + 300_000);
    fs.utimesSync(third, bumped.getTime() / 1000, bumped.getTime() / 1000);
    assert.equal(peekRouteCache(key), null);
  });

  test('peekRouteCache misses new cache key after mod version bump', () => {
    const key = buildRouteCacheKey('mod-invalidate');
    storeRouteCache(key, [{ path: '/fake.jsonl', mtime: new Date(), size: 1 }], new Map());
    assert.ok(peekRouteCache(key));
    bumpModVersion();
    const newKey = buildRouteCacheKey('mod-invalidate');
    assert.notEqual(newKey, key);
    assert.equal(peekRouteCache(newKey), null, 'handler must miss until store under new key');
    assert.ok(peekRouteCache(key), 'old key still maps to same slot until replaced');
  });

  test('peekApiResponseBody stores and returns identical body for route cache key', () => {
    const key = buildRouteCacheKey('api-body');
    storeRouteCache(key, [{ path: '/fake.jsonl', mtime: new Date(), size: 1 }], new Map());
    assert.equal(peekApiResponseBody(key, 'search:needle'), undefined);
    storeApiResponseBody(key, 'search:needle', '{"results":[]}');
    assert.strictEqual(peekApiResponseBody(key, 'search:needle'), '{"results":[]}');
  });

  test('peekApiResponseBody misses when top session mtime changes', () => {
    const { path, mtime, size } = tempJsonl('api-body-mtime');
    const sessions = [{ path, mtime, size }];
    const key = buildRouteCacheKey('api-body-mtime');
    storeRouteCache(key, sessions, new Map());
    storeApiResponseBody(key, 'sessions:1:50:recent::123', '{"sessions":[]}');
    assert.strictEqual(peekApiResponseBody(key, 'sessions:1:50:recent::123'), '{"sessions":[]}');

    const bumped = new Date(Date.now() + 300_000);
    fs.utimesSync(path, bumped.getTime() / 1000, bumped.getTime() / 1000);
    assert.equal(peekApiResponseBody(key, 'sessions:1:50:recent::123'), undefined);
  });

  test('clearRouteCache drops stored API response bodies', () => {
    const key = buildRouteCacheKey('api-body-clear');
    storeRouteCache(key, [{ path: '/fake.jsonl', mtime: new Date(), size: 1 }], new Map());
    storeApiResponseBody(key, 'search:x', '{"results":[]}');
    clearRouteCache();
    storeRouteCache(key, [{ path: '/fake.jsonl', mtime: new Date(), size: 1 }], new Map());
    assert.equal(peekApiResponseBody(key, 'search:x'), undefined);
  });
});

describe('route-cache resolveSessionsAndIndex', () => {
  function makeDeps(rows) {
    const findCalls = [];
    return {
      findCalls,
      findSessions(filter) {
        findCalls.push(filter);
        if (!filter) return rows;
        return rows.filter((s) => (s.project || '').includes(filter));
      },
      buildIndex(sessions) {
        return new Map(sessions.map((s) => [s.path, { firstPrompt: s.project }]));
      },
    };
  }

  test('unfiltered request seeds global snapshot for live-session detection', () => {
    const rows = [
      sessionRow('/tmp/a.jsonl', 'alpha'),
      sessionRow('/tmp/b.jsonl', 'beta'),
    ];
    const deps = makeDeps(rows);
    const out = resolveSessionsAndIndex(null, deps);
    assert.deepEqual(deps.findCalls, [null]);
    assert.equal(out.sessions, rows);
    assert.equal(out.allSessions, rows);
    assert.equal(out.index.get('/tmp/a.jsonl')?.firstPrompt, 'alpha');
  });

  test('filtered request reuses global snapshot without findSessions(null)', () => {
    const rows = [
      sessionRow('/tmp/a.jsonl', 'alpha'),
      sessionRow('/tmp/b.jsonl', 'beta'),
    ];
    const deps = makeDeps(rows);
    resolveSessionsAndIndex(null, deps);
    deps.findCalls.length = 0;

    const out = resolveSessionsAndIndex('alpha', deps);
    assert.deepEqual(deps.findCalls, ['alpha']);
    assert.equal(out.sessions.length, 1);
    assert.equal(out.sessions[0].path, '/tmp/a.jsonl');
    assert.equal(out.allSessions, rows);
  });

  test('second filtered request hits route cache and skips findSessions', () => {
    const rows = [sessionRow('/tmp/a.jsonl', 'alpha')];
    const deps = makeDeps(rows);
    resolveSessionsAndIndex(null, deps);
    resolveSessionsAndIndex('alpha', deps);
    deps.findCalls.length = 0;

    const cached = resolveSessionsAndIndex('alpha', deps);
    assert.deepEqual(deps.findCalls, []);
    assert.equal(cached.sessions.length, 1);
    assert.equal(cached.allSessions, rows);
  });

  test('filtered request before any unfiltered load omits allSessions', () => {
    const rows = [sessionRow('/tmp/a.jsonl', 'alpha')];
    const deps = makeDeps(rows);
    const out = resolveSessionsAndIndex('alpha', deps);
    assert.deepEqual(deps.findCalls, ['alpha']);
    assert.equal(out.allSessions, undefined);
  });

  test('resolveSessionsAndIndex passes coalesced index mtime to buildIndex', () => {
    let receivedMtime;
    const deps = {
      findSessions() {
        return [];
      },
      buildIndex(_sessions, opts = {}) {
        receivedMtime = opts.indexDiskMtimeMs;
        return new Map();
      },
    };
    const { indexMtimeMs } = routeCacheKeyWithIndexMtime(null);
    resolveSessionsAndIndex(null, deps, { indexMtimeMs });
    assert.equal(receivedMtime, indexMtimeMs);
  });
});

describe('route-cache isRouteCacheTopMtimesValid', () => {
  test('requires topMtimes snapshot', () => {
    assert.equal(
      isRouteCacheTopMtimesValid({ sessions: [{ path: '/x', mtime: new Date() }] }),
      false
    );
    assert.equal(
      isRouteCacheTopMtimesValid({
        sessions: [{ path: '/fake-missing.jsonl', mtime: new Date() }],
        topMtimes: [Date.now()],
      }),
      true
    );
  });

  test('returns true for empty sessions when topMtimes is present', () => {
    assert.equal(isRouteCacheTopMtimesValid({ sessions: [], topMtimes: [] }), true);
  });

  test('returns false when a watched file mtime drifts from snapshot', () => {
    const { path, mtime } = tempJsonl('validity-drift');
    const entry = {
      sessions: [{ path, mtime, size: 1 }],
      topMtimes: [mtime.getTime() - 1],
    };
    assert.equal(isRouteCacheTopMtimesValid(entry), false);
  });

  test('treats ENOENT paths as still valid', () => {
    const entry = {
      sessions: [{ path: join(tmpdir(), `missing-${Date.now()}.jsonl`), mtime: new Date() }],
      topMtimes: [12345],
    };
    assert.equal(isRouteCacheTopMtimesValid(entry), true);
  });

  test('validates only the first five sessions', () => {
    const paths = Array.from({ length: 6 }, (_, i) => tempJsonl(`valid-top5-${i}`).path);
    const sessions = newestFirstSessions(paths);
    const topMtimes = sessions.slice(0, 5).map((s) => s.mtime.getTime());
    const entry = { sessions, topMtimes };
    assert.equal(isRouteCacheTopMtimesValid(entry), true);

    const sixth = sessions[5].path;
    const bumped = new Date(Date.now() + 400_000);
    fs.utimesSync(sixth, bumped.getTime() / 1000, bumped.getTime() / 1000);
    assert.equal(isRouteCacheTopMtimesValid(entry), true);
  });
});