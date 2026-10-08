import { test, describe, afterEach } from 'node:test';
import { performance } from 'node:perf_hooks';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handleApiSessions } from '../../src/routes/route-handlers-api.js';
import { clearRouteCache } from '../../src/routes/route-cache.js';
import { clearLiveSessionsCache } from '../../src/sessions/live-sessions.js';
import { captureJsonHandler } from '../helpers/capture-json-handler.js';
import { assertPerf } from '../helpers/perf-assert.js';
import { sessionRow, makeFilteredApiDeps } from '../helpers/api-route-cache-fixtures.js';

/** Register route-cache + live-snapshot tests for handleApiSessions. */
export function registerApiSessionsCacheLiveTests() {
  const origHomeEnv = process.env.TRACEQUEST_LIVE_SESSIONS_HOME;

  describe('handleApiSessions route cache + live snapshot', () => {
    afterEach(() => {
      clearRouteCache();
      clearLiveSessionsCache();
      if (origHomeEnv === undefined) delete process.env.TRACEQUEST_LIVE_SESSIONS_HOME;
      else process.env.TRACEQUEST_LIVE_SESSIONS_HOME = origHomeEnv;
    });

    /** Grok live path for beta that sits outside an alpha-only table filter. */
    function setupGrokLiveBetaPath() {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-api-live-beta-'));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = process.cwd();
      const sessionId = 'api-live-beta';
      const grokDir = path.join(home, '.grok');
      const sessionsDir = path.join(grokDir, 'sessions', encodeURIComponent(cwd));
      fs.mkdirSync(sessionsDir, { recursive: true });
      const betaPath = path.join(sessionsDir, sessionId);
      fs.writeFileSync(
        betaPath,
        JSON.stringify({ ts: '2026-08-26T12:12:50.353Z', type: 'turn_started', session_id: sessionId }) + '\n',
      );
      fs.writeFileSync(
        path.join(grokDir, 'active_sessions.json'),
        JSON.stringify([{ session_id: sessionId, cwd, pid: process.pid }]),
      );
      return { home, betaPath };
    }

    test('filtered /api/sessions does not call findSessions(null) when route cache warm', async () => {
      const rows = [
        sessionRow('/fake/live-alpha.jsonl', 'alpha'),
        sessionRow('/fake/live-beta.jsonl', 'beta'),
      ];
      const deps = makeFilteredApiDeps(rows);
      const { res: resWarm, parse: parseWarm } = captureJsonHandler();

      await handleApiSessions({}, resWarm, new URL('http://localhost:7777/api/sessions'), deps);
      parseWarm();
      const callsBeforeFilter = deps.findSessions.mock.calls.length;

      const { res, parse } = captureJsonHandler();
      await handleApiSessions(
        {},
        res,
        new URL('http://localhost:7777/api/sessions?filter=alpha'),
        deps,
      );
      const data = parse();
      const filterCalls = deps.findSessions.mock.calls.slice(callsBeforeFilter);

      assert.deepEqual(filterCalls.map((c) => c.arguments[0]), ['alpha']);
      assert.equal(data.total, 1);
      assert.equal(data.sessions[0].path, '/fake/live-alpha.jsonl');
    });

    test('clearLiveSessionsCache refreshes liveSessions instead of body-cache hit', async () => {
      const { home, betaPath } = setupGrokLiveBetaPath();
      try {
        const rows = [
          sessionRow('/fake/live-alpha.jsonl', 'alpha'),
          sessionRow(betaPath, 'beta'),
        ];
        const deps = makeFilteredApiDeps(rows);
        const url = new URL('http://localhost:7777/api/sessions?filter=alpha');

        const warm = captureJsonHandler();
        await handleApiSessions({}, warm.res, new URL('http://localhost:7777/api/sessions'), deps);
        warm.parse();

        const first = captureJsonHandler();
        await handleApiSessions({}, first.res, url, deps);
        assert.equal(first.parse().liveSessions.length, 1);
        assert.equal(first.parse().liveSessions[0].path, betaPath);

        clearLiveSessionsCache();
        fs.unlinkSync(path.join(home, '.grok', 'active_sessions.json'));

        const second = captureJsonHandler();
        await handleApiSessions({}, second.res, url, deps);
        assert.deepEqual(second.parse().liveSessions, []);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test('repeat /api/sessions body cache hit stays under 0.12ms/op for 200 sessions', async () => {
      const rows = Array.from({ length: 200 }, (_, i) =>
        sessionRow(`/fake/api-perf-${i}.jsonl`, `proj-${i % 5}`),
      );
      const deps = makeFilteredApiDeps(rows);
      const url = new URL('http://localhost:7777/api/sessions?pageSize=50');
      const cap = captureJsonHandler();
      await handleApiSessions({}, cap.res, url, deps);

      const iters = 80;
      const t0 = performance.now();
      for (let i = 0; i < iters; i++) {
        const c = captureJsonHandler();
        await handleApiSessions({}, c.res, url, deps);
      }
      const msPerOp = (performance.now() - t0) / iters;
      assertPerf(msPerOp < 0.12, `expected body-cache hit <0.12ms/op, got ${msPerOp.toFixed(3)}`);
    });

    test('repeat /api/sessions reuses cached response body string', async () => {
      const rows = [
        sessionRow('/fake/live-alpha.jsonl', 'alpha'),
        sessionRow('/fake/live-beta.jsonl', 'beta'),
      ];
      const deps = makeFilteredApiDeps(rows);
      const url = new URL('http://localhost:7777/api/sessions?pageSize=50');

      const first = captureJsonHandler();
      await handleApiSessions({}, first.res, url, deps);
      const body1 = first.res.end.mock.calls[0].arguments[0];

      const second = captureJsonHandler();
      await handleApiSessions({}, second.res, url, deps);
      const body2 = second.res.end.mock.calls[0].arguments[0];

      assert.strictEqual(body2, body1);
      assert.equal(deps.findSessions.mock.calls.length, 1);
    });

    test('liveSessions carry the origin-agnostic activity line (same derivation as run rows)', async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-api-live-activity-'));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = process.cwd();
      // A .jsonl-named grok live entry so the freshness path is the file itself;
      // the row's source (claude) picks the parser, mirroring discovery.
      const sessionId = 'api-live-activity.jsonl';
      const grokDir = path.join(home, '.grok');
      const sessionsDir = path.join(grokDir, 'sessions', encodeURIComponent(cwd));
      fs.mkdirSync(sessionsDir, { recursive: true });
      const livePath = path.join(sessionsDir, sessionId);
      fs.writeFileSync(livePath, [
        JSON.stringify({ type: 'user', sessionId: 's1', timestamp: '2026-08-11T10:00:00.000Z', uuid: 'u1', isMeta: false, message: { content: [{ type: 'text', text: 'run the suite' }] } }),
        JSON.stringify({ type: 'assistant', sessionId: 's1', timestamp: '2026-08-11T10:00:05.000Z', uuid: 'a1', message: { model: 'claude-sonnet-4', content: [{ type: 'text', text: 'On it.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }], usage: { input_tokens: 1, output_tokens: 1 } } }),
      ].join('\n') + '\n');
      fs.writeFileSync(
        path.join(grokDir, 'active_sessions.json'),
        JSON.stringify([{ session_id: sessionId, cwd, pid: process.pid }]),
      );
      try {
        const deps = makeFilteredApiDeps([sessionRow(livePath, 'proj')]);
        const { res, parse } = captureJsonHandler();
        await handleApiSessions({}, res, new URL('http://localhost:7777/api/sessions'), deps);
        const data = parse();
        assert.equal(data.liveSessions.length, 1);
        // The newest assistant turn has an unresolved tool call — the live
        // session reads exactly like a running run row would.
        assert.equal(data.liveSessions[0].activity, 'Running npm test');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test('liveSessions include live paths outside filter when global snapshot exists', async () => {
      const { home, betaPath } = setupGrokLiveBetaPath();
      try {
        const rows = [
          sessionRow('/fake/live-alpha.jsonl', 'alpha'),
          sessionRow(betaPath, 'beta'),
        ];
        const deps = makeFilteredApiDeps(rows);

        const { res: resWarm, parse: parseWarm } = captureJsonHandler();
        await handleApiSessions({}, resWarm, new URL('http://localhost:7777/api/sessions'), deps);
        parseWarm();
        const callsBeforeFilter = deps.findSessions.mock.calls.length;

        const { res, parse } = captureJsonHandler();
        await handleApiSessions(
          {},
          res,
          new URL('http://localhost:7777/api/sessions?filter=alpha'),
          deps,
        );
        const data = parse();
        const filterCalls = deps.findSessions.mock.calls.slice(callsBeforeFilter);

        assert.equal(data.sessions.length, 1);
        assert.equal(data.sessions[0].path, '/fake/live-alpha.jsonl');
        assert.equal(data.liveSessions.length, 1);
        assert.equal(data.liveSessions[0].path, betaPath);
        assert.equal(filterCalls.some((c) => c.arguments[0] === null), false);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  });
}