import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { findSessions, sortSessionsByMtimeDesc } from '../src/sessions.js';
import { INDEX_VERSION } from '../src/sessions/index-writers.js';
import { sessionMtimeMs, sessionListChecksum } from '../src/sessions/session-list.js';
import { SearchIndex, getSearchIndex, resetSearchIndexForTests } from '../src/sessions/search-index.js';


describe('sortSessionsByMtimeDesc', () => {
  test('orders by mtime descending with Date and epoch-ms values', () => {
    const sessions = [
      { path: '/a', mtime: new Date(1000) },
      { path: '/b', mtime: 3000 },
      { path: '/c', mtime: new Date(2000) },
    ];
    sortSessionsByMtimeDesc(sessions);
    assert.deepEqual(sessions.map((s) => s.path), ['/b', '/c', '/a']);
    assert.equal(sessionMtimeMs({ mtime: null }), 0);
  });

  test('re-sorts sidecar-shaped rows after mtime coercion', () => {
    const sessions = [
      { path: '/old', mtime: new Date(1000) },
      { path: '/new', mtime: new Date(5000) },
    ];
    sessions.reverse();
    sortSessionsByMtimeDesc(sessions);
    assert.equal(sessions[0].path, '/new');
  });
});

describe('sessionListChecksum', () => {
  test('changes when path identity changes at same mtime/size', () => {
    const base = { mtime: new Date(1000), size: 42 };
    const a = [{ ...base, path: '/proj-a/s1.jsonl' }];
    const b = [{ ...base, path: '/proj-b/very-long-session-name.jsonl' }];
    assert.notEqual(sessionListChecksum(a), sessionListChecksum(b));
  });

  test('sessionMtimeMs normalizes numeric and Date mtimes for checksum inputs', () => {
    const sessions = [
      { path: '/p/a.jsonl', mtime: 2000, size: 10 },
      { path: '/p/b.jsonl', mtime: new Date(3000), size: 20 },
    ];
    const allMs = [
      { path: '/p/a.jsonl', mtime: 2000, size: 10 },
      { path: '/p/b.jsonl', mtime: 3000, size: 20 },
    ];
    assert.equal(sessionMtimeMs(sessions[0]), 2000);
    assert.equal(sessionMtimeMs(sessions[1]), 3000);
    assert.equal(sessionListChecksum(sessions), sessionListChecksum(allMs));
  });
});

describe('sessions findSessions withFileTypes optimization', () => {
  test('findSessions discovers sessions from minimal provider directory trees', async () => {
    const tmpDir = fs.mkdtempSync('/tmp/findsessions-tree-');
    const claudeProj = path.join(tmpDir, '.claude', 'projects', 'myproj');
    const codexRoot = path.join(tmpDir, '.codex', 'sessions');
    const cursorProj = path.join(tmpDir, '.cursor', 'projects', 'myproj');
    const factoryWs = path.join(tmpDir, '.factory', 'sessions', 'ws-home-user-code-myproj');
    const grokWs = path.join(tmpDir, '.grok', 'sessions', 'workspace');
    const grokSess = path.join(grokWs, 'sess-1');

    fs.mkdirSync(claudeProj, { recursive: true });
    const claudeFile = path.join(claudeProj, 'abc.jsonl');
    fs.writeFileSync(claudeFile, '{}');

    fs.mkdirSync(codexRoot, { recursive: true });
    const codexFile = path.join(codexRoot, 'rollout-test.jsonl');
    fs.writeFileSync(
      codexFile,
      JSON.stringify({ type: 'session_meta', payload: { cwd: tmpDir } }) + '\n'
    );

    const cursorUuidDir = path.join(cursorProj, 'agent-transcripts', 'cursor-tree-uuid');
    fs.mkdirSync(cursorUuidDir, { recursive: true });
    const cursorFile = path.join(cursorUuidDir, 'cursor-tree-uuid.jsonl');
    fs.writeFileSync(cursorFile, JSON.stringify({
      role: 'user',
      message: { content: [{ type: 'text', text: 'cursor hello' }] },
    }) + '\n');

    fs.mkdirSync(factoryWs, { recursive: true });
    const factoryFile = path.join(factoryWs, 'factory.jsonl');
    fs.writeFileSync(factoryFile, '{}');

    fs.mkdirSync(grokSess, { recursive: true });
    fs.writeFileSync(
      path.join(grokSess, 'chat_history.jsonl'),
      JSON.stringify({ type: 'user', content: 'grok hello' }) + '\n'
    );

    const originalHome = process.env.HOME;
    const originalNoSidecar = process.env.TRACEQUEST_NO_SIDECAR;
    process.env.HOME = tmpDir;
    process.env.TRACEQUEST_NO_SIDECAR = '1';

    try {
      const modUrl = new URL('../src/sessions.js?' + Date.now(), import.meta.url);
      const { findSessions } = await import(modUrl.href);
      const sessions = findSessions(null);
      const bySource = Object.fromEntries(
        ['claude', 'codex', 'cursor', 'factory', 'grok'].map((src) => [
          src,
          sessions.filter((s) => s.source === src),
        ])
      );

      assert.equal(bySource.claude.length, 1);
      assert.equal(bySource.claude[0].path, claudeFile);
      assert.equal(bySource.codex.length, 1);
      assert.equal(bySource.codex[0].path, codexFile);
      assert.equal(bySource.cursor.length, 1);
      assert.equal(bySource.cursor[0].path, cursorFile);
      assert.equal(bySource.factory.length, 1);
      assert.equal(bySource.factory[0].path, factoryFile);
      assert.equal(bySource.grok.length, 1);
      assert.equal(bySource.grok[0].path, grokSess);
    } finally {
      process.env.HOME = originalHome;
      if (originalNoSidecar === undefined) delete process.env.TRACEQUEST_NO_SIDECAR;
      else process.env.TRACEQUEST_NO_SIDECAR = originalNoSidecar;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('findSessions list is mtime-desc when multiple claude files exist', async () => {
    const tmpDir = fs.mkdtempSync('/tmp/findsessions-order-');
    const claudeProj = path.join(tmpDir, '.claude', 'projects', 'orderproj');
    fs.mkdirSync(claudeProj, { recursive: true });
    const a = path.join(claudeProj, 'a.jsonl');
    const b = path.join(claudeProj, 'b.jsonl');
    fs.writeFileSync(a, '{}');
    fs.writeFileSync(b, '{}');
    const t = Date.now() / 1000;
    fs.utimesSync(a, t - 50, t - 50);
    fs.utimesSync(b, t, t);

    const originalHome = process.env.HOME;
    const originalNoSidecar = process.env.TRACEQUEST_NO_SIDECAR;
    process.env.HOME = tmpDir;
    process.env.TRACEQUEST_NO_SIDECAR = '1';
    try {
      const modUrl = new URL('../src/sessions.js?' + Date.now(), import.meta.url);
      const { findSessions: findFresh } = await import(modUrl.href);
      const rows = findFresh(null).filter((s) => s.project === 'orderproj');
      assert.equal(rows.length, 2);
      assert.ok(sessionMtimeMs(rows[0]) >= sessionMtimeMs(rows[1]));
      assert.equal(rows[0].file, 'b.jsonl');
    } finally {
      process.env.HOME = originalHome;
      if (originalNoSidecar === undefined) delete process.env.TRACEQUEST_NO_SIDECAR;
      else process.env.TRACEQUEST_NO_SIDECAR = originalNoSidecar;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('findSessions returns real sessions with correct shape when sessions exist', () => {
    const sessions = findSessions(null);
    if (sessions.length === 0) return; // skip if no sessions in environment
    const s = sessions[0];
    assert.ok(s.path, 'session should have path');
    assert.ok(s.mtime instanceof Date, 'session should have Date mtime');
    assert.ok(typeof s.size === 'number', 'session should have numeric size');
    assert.ok(['claude', 'codex', 'cursor', 'factory', 'grok', 'opencode'].includes(s.source), 'session should have valid source');
  });
});

describe('sessions buildIndex mtime cache optimization', () => {
  test('buildIndex skips redundant disk read when index file mtime is unchanged', async () => {
    const tmpDir = fs.mkdtempSync('/tmp/buildindex-test-');
    const cacheDir = path.join(tmpDir, '.cache', 'tracequest');
    fs.mkdirSync(cacheDir, { recursive: true });

    const mtime = 1715731200000;
    const indexData = {
      _v: INDEX_VERSION,
      '/tmp/fake-session.jsonl': {
        mtime,
        firstPrompt: 'hello',
        model: 'claude-3',
        tools: [],
        toolCounts: {},
        chapters: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        durationMs: 0,
        errors: 0,
        files: 0,
        commits: 0
      }
    };
    const indexPath = path.join(cacheDir, 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify(indexData));

    // Write a warm search.idx so mtime-matched sessions are found in the SI
    // and not force-re-indexed (fact msg: re-tokenize only when absent from SI).
    const warmSI = new SearchIndex();
    warmSI.upsert('/tmp/fake-session.jsonl', new Map([['__warm__', 1]]));
    fs.writeFileSync(path.join(cacheDir, 'search.idx'), warmSI.serialize());

    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;

    try {
      const modUrl = new URL('../src/sessions.js?' + Date.now(), import.meta.url);
      const { buildIndex } = await import(modUrl.href);

      const session = {
        path: '/tmp/fake-session.jsonl',
        mtime: new Date(mtime),
        source: 'claude',
        size: 100
      };

      const result1 = buildIndex([session]);
      assert.equal(result1.size, 1);
      assert.equal(result1.get('/tmp/fake-session.jsonl').firstPrompt, 'hello');

      // Rewrite the on-disk index with DIFFERENT content, then restore the
      // original mtime. A correct in-memory mtime cache must return the first
      // (cached) result rather than re-reading the changed file. This asserts
      // cache behavior deterministically — no flaky wall-clock comparison.
      const origStat = fs.statSync(indexPath);
      const changed = JSON.parse(JSON.stringify(indexData));
      changed['/tmp/fake-session.jsonl'].firstPrompt = 'CHANGED-ON-DISK';
      fs.writeFileSync(indexPath, JSON.stringify(changed));
      fs.utimesSync(indexPath, origStat.atime, origStat.mtime);

      const result2 = buildIndex([session]);
      assert.equal(result2.size, 1);
      assert.equal(
        result2.get('/tmp/fake-session.jsonl').firstPrompt,
        'hello',
        'second buildIndex call must return cached data (index mtime unchanged), not re-read the modified file'
      );
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('buildIndex re-reads index when file mtime changes', async () => {
    const tmpDir = fs.mkdtempSync('/tmp/buildindex-test-');
    const cacheDir = path.join(tmpDir, '.cache', 'tracequest');
    fs.mkdirSync(cacheDir, { recursive: true });

    const mtime1 = 1715731200000;
    const indexData1 = {
      _v: INDEX_VERSION,
      '/tmp/fake-session.jsonl': {
        mtime: mtime1,
        firstPrompt: 'first version',
        model: 'claude-3',
        tools: [],
        toolCounts: {},
        chapters: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        durationMs: 0,
        errors: 0,
        files: 0,
        commits: 0
      }
    };
    const indexPath = path.join(cacheDir, 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify(indexData1));
    const origStat = fs.statSync(indexPath);

    // Write a warm search.idx so mtime-matched sessions are found in the SI
    // and not force-re-indexed (fact msg: re-tokenize only when absent from SI).
    const warmSI2 = new SearchIndex();
    warmSI2.upsert('/tmp/fake-session.jsonl', new Map([['__warm__', 1]]));
    fs.writeFileSync(path.join(cacheDir, 'search.idx'), warmSI2.serialize());

    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;

    try {
      const modUrl = new URL('../src/sessions.js?' + Date.now(), import.meta.url);
      const { buildIndex } = await import(modUrl.href);

      const session = {
        path: '/tmp/fake-session.jsonl',
        mtime: new Date(mtime1),
        source: 'claude',
        size: 100
      };

      const result1 = buildIndex([session]);
      assert.equal(result1.get('/tmp/fake-session.jsonl').firstPrompt, 'first version');

      // Corrupt the file on disk but restore the original mtime so the
      // in-memory cache (if any) would be the only valid source.
      fs.writeFileSync(indexPath, '{invalid json');
      fs.utimesSync(indexPath, origStat.atime, origStat.mtime);

      // Because mtime is unchanged, a cached buildIndex must return the
      // previously parsed data and NOT crash on the corrupted disk file.
      const result2 = buildIndex([session]);
      assert.equal(result2.get('/tmp/fake-session.jsonl').firstPrompt, 'first version');

      // Now change the mtime (by rewriting valid data) — cache should invalidate
      const indexData2 = {
        _v: INDEX_VERSION,
        '/tmp/fake-session.jsonl': {
          mtime: mtime1,
          firstPrompt: 'second version',
          model: 'claude-3',
          tools: [],
          toolCounts: {},
          chapters: 0,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          durationMs: 0,
          errors: 0,
          files: 0,
          commits: 0
        }
      };
      fs.writeFileSync(indexPath, JSON.stringify(indexData2));
      // Bump mtime explicitly so cache invalidation is deterministic even when
      // the rewrite lands within the filesystem's timestamp granularity.
      const bumped = new Date(origStat.mtime.getTime() + 2000);
      fs.utimesSync(indexPath, bumped, bumped);

      const result3 = buildIndex([session]);
      assert.equal(result3.get('/tmp/fake-session.jsonl').firstPrompt, 'second version');
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('buildIndex handles missing index file gracefully with and without cache', async () => {
    const tmpDir = fs.mkdtempSync('/tmp/buildindex-test-');
    const cacheDir = path.join(tmpDir, '.cache', 'tracequest');
    fs.mkdirSync(cacheDir, { recursive: true });

    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;

    try {
      const modUrl = new URL('../src/sessions.js?' + Date.now(), import.meta.url);
      const { buildIndex } = await import(modUrl.href);

      const session = {
        path: '/tmp/fake-session.jsonl',
        mtime: new Date(1715731200000),
        source: 'claude',
        size: 100
      };

      // No index file exists — should not throw
      const result1 = buildIndex([session]);
      assert.equal(result1.size, 1);
      assert.ok(result1.get('/tmp/fake-session.jsonl'));

      // Second call also should not throw even though file is still missing
      const result2 = buildIndex([session]);
      assert.equal(result2.size, 1);
      assert.ok(result2.get('/tmp/fake-session.jsonl'));
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('sessions buildIndex cached Map reuse on mtime hit', () => {
  test('buildIndex returns the identical Map instance on repeated calls with unchanged data', async () => {
    const tmpDir = fs.mkdtempSync('/tmp/buildindex-map-test-');
    const cacheDir = path.join(tmpDir, '.cache', 'tracequest');
    fs.mkdirSync(cacheDir, { recursive: true });

    const mtime = 1715731200000;
    const indexData = {
      _v: INDEX_VERSION,
      '/tmp/fake-session.jsonl': {
        mtime,
        firstPrompt: 'hello',
        model: 'claude-3',
        tools: [],
        toolCounts: {},
        chapters: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        durationMs: 0,
        errors: 0,
        files: 0,
        commits: 0
      }
    };
    const indexPath = path.join(cacheDir, 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify(indexData));

    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;

    try {
      const modUrl = new URL('../src/sessions.js?' + Date.now(), import.meta.url);
      const { buildIndex } = await import(modUrl.href);

      const session = {
        path: '/tmp/fake-session.jsonl',
        mtime: new Date(mtime),
        source: 'claude',
        size: 100
      };

      const result1 = buildIndex([session]);
      const result2 = buildIndex([session]);

      assert.equal(result1.size, 1);
      assert.equal(result2.size, 1);
      // Identity check: if the optimization works, the exact same Map object is returned
      assert.strictEqual(
        result1,
        result2,
        'buildIndex must return the identical Map instance on repeated calls with unchanged sessions and disk cache'
      );
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('buildIndex returns a new Map when a session mtime changes (cache invalidation)', async () => {
    const tmpDir = fs.mkdtempSync('/tmp/buildindex-map-test-');
    const cacheDir = path.join(tmpDir, '.cache', 'tracequest');
    fs.mkdirSync(cacheDir, { recursive: true });

    const mtime = 1715731200000;
    const indexData = {
      _v: INDEX_VERSION,
      '/tmp/fake-session.jsonl': {
        mtime,
        firstPrompt: 'hello',
        model: 'claude-3',
        tools: [],
        toolCounts: {},
        chapters: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        durationMs: 0,
        errors: 0,
        files: 0,
        commits: 0
      }
    };
    const indexPath = path.join(cacheDir, 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify(indexData));

    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;

    try {
      const modUrl = new URL('../src/sessions.js?' + Date.now(), import.meta.url);
      const { buildIndex } = await import(modUrl.href);

      const session1 = {
        path: '/tmp/fake-session.jsonl',
        mtime: new Date(mtime),
        source: 'claude',
        size: 100
      };

      const result1 = buildIndex([session1]);

      // Change the session mtime so it becomes stale
      const session2 = {
        path: '/tmp/fake-session.jsonl',
        mtime: new Date(mtime + 1000),
        source: 'claude',
        size: 100
      };

      const result2 = buildIndex([session2]);

      assert.equal(result1.size, 1);
      assert.equal(result2.size, 1);
      assert.notStrictEqual(
        result1,
        result2,
        'buildIndex must return a new Map instance when a session mtime changes'
      );
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('sessions findOpenCodeSessions mtime cache optimization', () => {
  test('findOpenCodeSessions skips redundant DB query when SQLite DB mtime is unchanged', async () => {
    const tmpDir = fs.mkdtempSync('/tmp/opencode-test-');
    const dbDir = path.join(tmpDir, '.local', 'share', 'opencode');
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, 'opencode.db');
    const fixedMtime = new Date('2026-01-15T12:00:00Z');

    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, version TEXT, time_created INTEGER, time_updated INTEGER)`);
    db.exec(`CREATE TABLE message (session_id TEXT, role TEXT, content TEXT)`);
    const stmtSession = db.prepare(`INSERT INTO session (id, title, directory, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)`);
    const stmtMessage = db.prepare(`INSERT INTO message (session_id, role, content) VALUES (?, ?, ?)`);
    stmtSession.run('sess-1', 'Test Session', '/tmp/testproj', '1.0', 1715731200, 1715731200);
    for (let i = 0; i < 3; i++) stmtMessage.run('sess-1', 'user', 'hello');
    db.close();
    fs.utimesSync(dbPath, fixedMtime, fixedMtime);

    const originalHome = process.env.HOME;
    const originalNoSidecar = process.env.TRACEQUEST_NO_SIDECAR;
    process.env.HOME = tmpDir;
    // Force the pure-JS scan path so the in-memory mtime cache under test is
    // actually exercised (the Rust sidecar, if built, spawns fresh each call).
    process.env.TRACEQUEST_NO_SIDECAR = '1';

    try {
      const modUrl = new URL('../src/sessions/session-discovery.js?' + Date.now(), import.meta.url);
      const { findOpenCodeSessions, clearOpenCodeDiscoveryCache } = await import(modUrl.href);
      const { openCodeDbMtimeMs } = await import('../src/sessions/session-discovery-paths.js');
      clearOpenCodeDiscoveryCache();

      const result1 = [];
      findOpenCodeSessions(null, result1);
      assert.equal(result1.length, 1);
      assert.equal(result1[0].file, 'sess-1');

      // Insert a second session into the DB, then restore the DB file's original
      // mtime. A correct mtime cache must skip the re-query and still return only
      // the first (cached) session — deterministic, no wall-clock comparison.
      const origMtimeMs = openCodeDbMtimeMs(dbPath);
      const origStat = fs.statSync(dbPath);
      const db2 = new DatabaseSync(dbPath);
      const s2 = db2.prepare(`INSERT INTO session (id, title, directory, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)`);
      const m2 = db2.prepare(`INSERT INTO message (session_id, role, content) VALUES (?, ?, ?)`);
      s2.run('sess-2', 'Second Session', '/tmp/testproj', '1.0', 1715731300, 1715731300);
      for (let i = 0; i < 3; i++) m2.run('sess-2', 'user', 'hello');
      db2.close();
      fs.utimesSync(dbPath, origStat.atime, origStat.mtime);
      assert.equal(
        openCodeDbMtimeMs(dbPath),
        origMtimeMs,
        'utimes must restore DB mtime before asserting cache hit'
      );

      const result2 = [];
      findOpenCodeSessions(null, result2);
      assert.equal(result2.length, 1, 'second findOpenCodeSessions call must return cached rows (DB mtime unchanged), not re-query the modified DB');
      assert.equal(result2[0].file, 'sess-1');
    } finally {
      process.env.HOME = originalHome;
      if (originalNoSidecar === undefined) delete process.env.TRACEQUEST_NO_SIDECAR;
      else process.env.TRACEQUEST_NO_SIDECAR = originalNoSidecar;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('findOpenCodeSessions re-queries DB when file mtime changes', async () => {
    const tmpDir = fs.mkdtempSync('/tmp/opencode-test-');
    const dbDir = path.join(tmpDir, '.local', 'share', 'opencode');
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, 'opencode.db');

    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, version TEXT, time_created INTEGER, time_updated INTEGER)`);
    db.exec(`CREATE TABLE message (session_id TEXT, role TEXT, content TEXT)`);
    const stmtSession = db.prepare(`INSERT INTO session (id, title, directory, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)`);
    const stmtMessage = db.prepare(`INSERT INTO message (session_id, role, content) VALUES (?, ?, ?)`);
    stmtSession.run('sess-1', 'First Session', '/tmp/testproj', '1.0', 1715731200, 1715731200);
    for (let i = 0; i < 3; i++) stmtMessage.run('sess-1', 'user', 'hello');
    db.close();

    const originalHome = process.env.HOME;
    const originalNoSidecar = process.env.TRACEQUEST_NO_SIDECAR;
    process.env.HOME = tmpDir;
    // Force the pure-JS scan path so the mtime cache invalidation is exercised.
    process.env.TRACEQUEST_NO_SIDECAR = '1';

    try {
      const modUrl = new URL('../src/sessions.js?' + Date.now(), import.meta.url);
      const { findSessions } = await import(modUrl.href);

      const result1 = findSessions(null);
      assert.equal(result1.length, 1);
      assert.equal(result1[0].title, 'First Session');

      // Replace the DB with a new file containing different data.
      // This changes the file mtime, so any mtime-based cache must invalidate.
      fs.unlinkSync(dbPath);
      const db2 = new DatabaseSync(dbPath);
      db2.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, version TEXT, time_created INTEGER, time_updated INTEGER)`);
      db2.exec(`CREATE TABLE message (session_id TEXT, role TEXT, content TEXT)`);
      const stmtSession2 = db2.prepare(`INSERT INTO session (id, title, directory, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)`);
      const stmtMessage2 = db2.prepare(`INSERT INTO message (session_id, role, content) VALUES (?, ?, ?)`);
      stmtSession2.run('sess-2', 'Second Session', '/tmp/testproj', '1.0', 1715731200, 1715731200);
      for (let i = 0; i < 3; i++) stmtMessage2.run('sess-2', 'user', 'hello');
      db2.close();

      const result2 = findSessions(null);
      assert.equal(result2.length, 1);
      assert.equal(result2[0].title, 'Second Session');
    } finally {
      process.env.HOME = originalHome;
      if (originalNoSidecar === undefined) delete process.env.TRACEQUEST_NO_SIDECAR;
      else process.env.TRACEQUEST_NO_SIDECAR = originalNoSidecar;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('findOpenCodeSessions handles missing DB gracefully with and without cache', async () => {
    const tmpDir = fs.mkdtempSync('/tmp/opencode-test-');
    const dbDir = path.join(tmpDir, '.local', 'share', 'opencode');
    fs.mkdirSync(dbDir, { recursive: true });

    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;

    try {
      const modUrl = new URL('../src/sessions.js?' + Date.now(), import.meta.url);
      const { findSessions } = await import(modUrl.href);

      // No DB exists — should not throw
      const result1 = findSessions(null);
      assert.equal(result1.length, 0);

      // Second call also should not throw
      const result2 = findSessions(null);
      assert.equal(result2.length, 0);
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('sessions index functions single-pass optimization', () => {
  test('indexClaude still captures fallback text fields from lines during first pass', async () => {
    const tmpDir = fs.mkdtempSync('/tmp/index-claude-test-');
    const filePath = path.join(tmpDir, 'session.jsonl');
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'deploy the application to staging' }, timestamp: '2026-05-01T00:00:00Z' }),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-3', content: [{ type: 'text', text: 'I will deploy it now using the staging pipeline' }], usage: { input_tokens: 100, output_tokens: 50 } }, timestamp: '2026-05-01T00:01:00Z' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'The deployment completed successfully with zero downtime' }], usage: { input_tokens: 80, output_tokens: 40 } }, timestamp: '2026-05-01T00:02:00Z' }),
    ];
    fs.writeFileSync(filePath, lines.join('\n'));

    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;

    try {
      const modUrl = new URL('../src/sessions.js?' + Date.now(), import.meta.url);
      const { buildIndex } = await import(modUrl.href);
      const session = {
        path: filePath,
        mtime: new Date('2026-05-01'),
        source: 'claude',
        size: fs.statSync(filePath).size,
      };
      resetSearchIndexForTests();
      const index = buildIndex([session]);
      const meta = index.get(filePath);
      assert.ok(meta, 'index should contain entry for session');
      const si = getSearchIndex();
      assert.ok(si._postings.has('deploy'), 'SearchIndex should contain user prompt token');
      assert.ok(si._postings.has('staging') && si._postings.has('pipeline'), 'SearchIndex should contain assistant text tokens');
      assert.ok(si._postings.has('zero') && si._postings.has('downtime'), 'SearchIndex should contain fallback text tokens from second assistant message');
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('sessions indexSession behavioral indexing', () => {
  test('indexClaude indexes every newline-delimited event in a multi-line file', async () => {
    const tmpDir = fs.mkdtempSync('/tmp/index-claude-lines-');
    const filePath = path.join(tmpDir, 'session.jsonl');
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'line one prompt' }, timestamp: '2026-05-01T00:00:00Z' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'line two reply' }] }, timestamp: '2026-05-01T00:01:00Z' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'line three extra' }] }, timestamp: '2026-05-01T00:02:00Z' }),
    ];
    fs.writeFileSync(filePath, lines.join('\n'));

    try {
      const modUrl = new URL('../src/sessions/index.js?' + Date.now(), import.meta.url);
      const { indexSession } = await import(modUrl.href);
      const meta = indexSession({ path: filePath, source: 'claude' });
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has('line') && meta.termFreqs.has('prompt'));
      assert.ok(meta.termFreqs.has('reply'));
      assert.ok(meta.termFreqs.has('extra'));
      assert.equal(meta.durationMs, 120000);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('indexClaude uses real timestamp fields for duration, not incidental text', async () => {
    const tmpDir = fs.mkdtempSync('/tmp/index-claude-ts-');
    const filePath = path.join(tmpDir, 'session.jsonl');
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { content: 'user mentioned timestamp 2020-01-01 in chat' },
        timestamp: '2026-05-01T00:00:00Z',
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'done' }] },
        timestamp: '2026-05-01T00:05:00Z',
      }),
    ];
    fs.writeFileSync(filePath, lines.join('\n'));

    try {
      const modUrl = new URL('../src/sessions/index.js?' + Date.now(), import.meta.url);
      const { indexSession } = await import(modUrl.href);
      const meta = indexSession({ path: filePath, source: 'claude' });
      assert.equal(meta.durationMs, 300000);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('indexClaude aggregates token usage from assistant events', async () => {
    const tmpDir = fs.mkdtempSync('/tmp/index-claude-tok-');
    const filePath = path.join(tmpDir, 'session.jsonl');
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-3',
          usage: { input_tokens: 100, output_tokens: 40 },
          content: [],
        },
        timestamp: '2026-05-01T00:00:00Z',
      })
    );

    try {
      const modUrl = new URL('../src/sessions/index.js?' + Date.now(), import.meta.url);
      const { indexSession } = await import(modUrl.href);
      const meta = indexSession({ path: filePath, source: 'claude' });
      assert.equal(meta.inputTokens, 100);
      assert.equal(meta.outputTokens, 40);
      assert.equal(meta.totalTokens, 140);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('indexFactory indexes newline-delimited factory jsonl events', async () => {
    const tmpDir = fs.mkdtempSync('/tmp/index-factory-lines-');
    const filePath = path.join(tmpDir, 'session.jsonl');
    const lines = [
      JSON.stringify({
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'factory line one' }] },
        timestamp: '2026-05-01T00:00:00Z',
      }),
      JSON.stringify({
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'factory line two' }] },
        timestamp: '2026-05-01T00:01:00Z',
      }),
    ];
    fs.writeFileSync(filePath, lines.join('\n'));

    try {
      const modUrl = new URL('../src/sessions/index.js?' + Date.now(), import.meta.url);
      const { indexSession } = await import(modUrl.href);
      const meta = indexSession({ path: filePath, source: 'factory' });
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has('factory') && meta.termFreqs.has('line'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('indexCodex indexes codex events while skipping irrelevant lines', async () => {
    const tmpDir = fs.mkdtempSync('/tmp/index-codex-lines-');
    const filePath = path.join(tmpDir, 'rollout-test.jsonl');
    const lines = [
      '{"noise":"no relevant types here at all just padding text"}',
      JSON.stringify({ type: 'session_meta', payload: { model_provider: 'openai' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'codex user asks something' } }),
      '{"another":"irrelevant line without codex event types"}',
    ];
    fs.writeFileSync(filePath, lines.join('\n'));

    try {
      const modUrl = new URL('../src/sessions/index.js?' + Date.now(), import.meta.url);
      const { indexSession } = await import(modUrl.href);
      const meta = indexSession({ path: filePath, source: 'codex' });
      assert.equal(meta.model, 'openai');
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has('codex') && meta.termFreqs.has('user'));
      assert.equal(meta.chapters, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('indexGrok indexes every chat_history.jsonl line', async () => {
    const tmpDir = fs.mkdtempSync('/tmp/index-grok-lines-');
    const sessionDir = path.join(tmpDir, 'sess-1');
    fs.mkdirSync(sessionDir, { recursive: true });
    const chatPath = path.join(sessionDir, 'chat_history.jsonl');
    const lines = [
      JSON.stringify({ type: 'user', content: 'grok line one' }),
      JSON.stringify({ type: 'assistant', content: 'grok line two' }),
      JSON.stringify({ type: 'assistant', content: 'grok line three' }),
    ];
    fs.writeFileSync(chatPath, lines.join('\n'));
    fs.writeFileSync(
      path.join(sessionDir, 'events.jsonl'),
      [
        JSON.stringify({ type: 'turn_started', ts: '2026-05-01T00:00:00Z', model_id: 'grok-2' }),
        JSON.stringify({ type: 'tool_started', ts: '2026-05-01T00:02:00Z', tool_name: 'Read' }),
      ].join('\n')
    );

    try {
      const modUrl = new URL('../src/sessions/index.js?' + Date.now(), import.meta.url);
      const { indexSession } = await import(modUrl.href);
      const meta = indexSession({ path: sessionDir, source: 'grok' });
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has('grok') && meta.termFreqs.has('line'));
      assert.equal(meta.model, 'grok-2');
      assert.equal(meta.durationMs, 120000);
      assert.ok(meta.tools.includes('Read'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('sessions buildIndex write-through cache after disk write', () => {
  test('buildIndex returns identical Map on second call after stale write', async () => {
    const tmpDir = fs.mkdtempSync('/tmp/buildindex-wt-test-');
    const cacheDir = path.join(tmpDir, '.cache', 'tracequest');
    fs.mkdirSync(cacheDir, { recursive: true });

    const mtime = 1715731200000;
    const indexData = { _v: 8 };
    const indexPath = path.join(cacheDir, 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify(indexData));

    const sessionPath = path.join(tmpDir, 'session.jsonl');
    fs.writeFileSync(sessionPath, JSON.stringify({ type: 'user', message: { content: 'hello' }, timestamp: '2026-05-01T00:00:00Z' }));

    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;

    try {
      const modUrl = new URL('../src/sessions.js?' + Date.now(), import.meta.url);
      const { buildIndex } = await import(modUrl.href);

      const session = {
        path: sessionPath,
        mtime: new Date(mtime),
        source: 'claude',
        size: 100
      };

      // First call: stale, will write to disk
      const result1 = buildIndex([session]);
      assert.equal(result1.size, 1);

      // Second call: same sessions, write-through cache returns same Map instance
      const result2 = buildIndex([session]);
      assert.strictEqual(result1, result2, 'second call after stale write must return identical Map instance');
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

