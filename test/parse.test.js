import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseSession } from '../src/parse.js';
import { normalizeToolName } from '../src/parse/parse-enrich.js';
import { parseJsonlLine } from '../src/parse/jsonl-read.js';
import { shortToolPath, parseWebSearchLinks, parseEscapedJsonString } from '../src/parse/parse-utils.js';
import { parseToolArgs } from '../src/parse/parse-utils.js';
import { extractUserQuery } from '../src/parse/parse-grok.js';
import { estimateParsedStatsCost } from '../src/filter/filter-formats.js';
import { isSessionHash } from '../src/sessions/session-hash.js';
import { seedOpenCodeIndexDb } from './helpers/opencode-db-fixtures.js';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

function assertUnifiedSessionShape(sess, { source, path, sessionId }) {
  for (const key of [
    'sessionId', 'source', 'cwd', 'model', 'gitBranch', 'startTime', 'endTime',
    'durationMs', 'eventCount', 'events', 'stats', 'path', 'sessionHash',
  ]) {
    assert.ok(Object.hasOwn(sess, key), `${source} session missing ${key}`);
  }
  assert.equal(sess.source, source);
  assert.equal(sess.path, path);
  assert.equal(sess.sessionId, sessionId);
  assert.ok(isSessionHash(sess.sessionHash), `${source} sessionHash should be 8 hex chars`);
  assert.ok(Array.isArray(sess.events), `${source} events should be an array`);
  assert.equal(sess.eventCount, sess.events.length);
  assert.equal(typeof sess.durationMs, 'number');
  assert.ok(Number.isFinite(sess.durationMs), `${source} durationMs should be finite`);
  assert.doesNotThrow(() => new Date(sess.startTime).toISOString());
  assert.doesNotThrow(() => new Date(sess.endTime).toISOString());
  assert.equal(typeof sess.stats, 'object');
  assert.notEqual(sess.stats, null);
  for (const key of [
    'userMessages', 'assistantTurns', 'totalInputTokens', 'totalOutputTokens',
    'totalCacheHit', 'errors', 'toolCounts', 'tokensEstimated',
  ]) {
    assert.ok(Object.hasOwn(sess.stats, key), `${source} stats missing ${key}`);
  }
}

describe('parse core', () => {
  test('parseJsonlLine returns null for malformed JSONL', () => {
    assert.equal(parseJsonlLine(''), null);
    assert.equal(parseJsonlLine('{bad'), null);
    assert.deepEqual(parseJsonlLine('{"a":1}'), { a: 1 });
  });

  test('parseEscapedJsonString decodes regex-captured JSON string literals', () => {
    assert.equal(parseEscapedJsonString(''), null);
    assert.equal(parseEscapedJsonString('bad\\u'), null);
    assert.equal(parseEscapedJsonString('git commit -m \\"fix\\"'), 'git commit -m "fix"');
    assert.equal(parseEscapedJsonString('line\\none'), 'line\none');
  });

  test('shortToolPath keeps last two path segments', () => {
    assert.equal(shortToolPath('/home/user/proj/src/foo.js'), 'src/foo.js');
    assert.equal(shortToolPath(''), '');
    assert.equal(shortToolPath(null), '');
  });

  test('parseWebSearchLinks extracts title/url pairs from output', () => {
    const out = '{"results":[{"title":"A","url":"https://a"},{"title":"B","url":"https://b"}]}';
    const links = parseWebSearchLinks(out);
    assert.equal(links.length, 2);
    assert.equal(links[0].title, 'A');
    assert.equal(links[1].url, 'https://b');
  });

  test('estimateParsedStatsCost subtracts cache hits from input billing', () => {
    const stats = { totalInputTokens: 1000, totalCacheHit: 400, totalOutputTokens: 200 };
    const cost = estimateParsedStatsCost('claude-3-sonnet', stats);
    const expected = (600 * 3 + 400 * 0.3 + 200 * 15) / 1e6;
    assert.ok(Math.abs(cost - expected) < 1e-9);
  });

  test('normalizeToolName maps variants and preserves MCP', () => {
    assert.equal(normalizeToolName('bash'), 'Bash');
    assert.equal(normalizeToolName('shell'), 'Bash');
    assert.equal(normalizeToolName('read_file'), 'Read');
    assert.equal(normalizeToolName('read'), 'Read');
    assert.equal(normalizeToolName('edit_file'), 'Edit');
    assert.equal(normalizeToolName('edit'), 'Edit');
    assert.equal(normalizeToolName('web_search'), 'WebSearch');
    assert.equal(normalizeToolName('websearch'), 'WebSearch');
    assert.equal(normalizeToolName('mcp__foo__bar'), 'mcp__foo__bar');
    assert.equal(normalizeToolName('mcp__server__tool'), 'mcp__server__tool');
    assert.equal(normalizeToolName(null), 'unknown');
    assert.equal(normalizeToolName(''), 'unknown');
    assert.equal(normalizeToolName('unknowncmd'), 'Unknowncmd');
    assert.equal(normalizeToolName('FooBar'), 'FooBar');
  });
});

describe('parse split by source', () => {
  test('parseSession returns unified shape for all supported sources', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'parse-session-shape-'));
    const originalHome = process.env.HOME;
    const ts = '2026-05-20T12:00:00Z';
    const timeMs = Date.parse(ts);

    try {
      const claudePath = join(root, 'claude.jsonl');
      writeFileSync(claudePath, JSON.stringify({
        type: 'user',
        sessionId: 'shape-claude',
        cwd: '/shape/claude',
        timestamp: ts,
        uuid: 'u-shape-claude',
        isMeta: false,
        message: { content: 'claude shape prompt' },
      }) + '\n');

      const cursorPath = join(root, 'cursor.jsonl');
      writeFileSync(cursorPath, JSON.stringify({
        role: 'user',
        message: { content: [{ type: 'text', text: 'cursor shape prompt' }] },
      }) + '\n');

      const cursorCloudPath = join(root, 'bc-shape.jsonl');
      writeFileSync(cursorCloudPath, [
        JSON.stringify({
          type: 'session_meta',
          bcId: 'bc-shape',
          name: 'Cloud shape run',
          status: 'FINISHED',
          createdAt: ts,
        }),
        JSON.stringify({
          role: 'user',
          message: { content: [{ type: 'text', text: 'cursor-cloud shape prompt' }] },
        }),
      ].join('\n') + '\n');

      const codexPath = join(root, 'codex.jsonl');
      writeFileSync(codexPath, [
        JSON.stringify({ type: 'session_meta', payload: { id: 'shape-codex', cwd: '/shape/codex', model_provider: 'codex-model' } }),
        JSON.stringify({ type: 'event_msg', timestamp: ts, payload: { type: 'user_message', message: 'codex shape prompt' } }),
      ].join('\n') + '\n');

      const factoryPath = join(root, 'factory.jsonl');
      writeFileSync(factoryPath, [
        JSON.stringify({ type: 'session_start', id: 'shape-factory', cwd: '/shape/factory', model: 'factory-model' }),
        JSON.stringify({
          type: 'message',
          timestamp: ts,
          message: { role: 'user', content: [{ type: 'text', text: 'factory shape prompt' }] },
        }),
      ].join('\n') + '\n');

      const grokPath = join(root, 'grok-session');
      mkdirSync(grokPath);
      writeFileSync(join(grokPath, 'events.jsonl'), JSON.stringify({
        type: 'turn_started',
        session_id: 'shape-grok',
        ts,
        model_id: 'grok-model',
      }) + '\n');
      writeFileSync(join(grokPath, 'chat_history.jsonl'), JSON.stringify({
        type: 'user',
        content: 'grok shape prompt',
      }) + '\n');

      const opencodePath = 'opencode://shape-opencode';
      const opencodeHome = join(root, 'opencode-home');
      process.env.HOME = opencodeHome;
      await seedOpenCodeIndexDb(opencodeHome, [
        {
          id: 'shape-opencode',
          directory: '/shape/opencode',
          messages: [
            {
              id: 'oc-user-shape',
              role: 'user',
              modelID: 'opencode-model',
              time: { created: timeMs },
              parts: [{ type: 'text', text: 'opencode shape prompt' }],
            },
          ],
        },
      ], { defaultTime: timeMs });

      for (const [source, path, sessionId] of [
        ['claude', claudePath, 'shape-claude'],
        ['cursor', cursorPath, 'cursor'],
        ['cursor-cloud', cursorCloudPath, 'bc-shape'],
        ['codex', codexPath, 'shape-codex'],
        ['factory', factoryPath, 'shape-factory'],
        ['grok', grokPath, 'shape-grok'],
        ['opencode', opencodePath, 'shape-opencode'],
      ]) {
        assertUnifiedSessionShape(parseSession(path, source), { source, path, sessionId });
      }
    } finally {
      process.env.HOME = originalHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('cursor source preserves cursor identity', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'parse-cursor-'));
    try {
      const cursorDir = join(root, '.cursor', 'projects', 'cursor-proj', 'agent-transcripts', 'sess-uuid');
      mkdirSync(cursorDir, { recursive: true });
      const cursorPath = join(cursorDir, 'sess-uuid.jsonl');
      writeFileSync(cursorPath, [
        JSON.stringify({
          role: 'user',
          message: { content: [{ type: 'text', text: 'Cursor prompt' }] },
        }),
        JSON.stringify({
          role: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Cursor reply text' },
              { type: 'thinking', thinking: 'cursor private thinking' },
              { type: 'tool_use', name: 'StrReplace', input: { path: '/tmp/a.js', old_string: 'x', new_string: 'y' } },
            ],
          },
        }),
        JSON.stringify({ type: 'turn_ended', status: 'error', error: 'User aborted request' }),
      ].join('\n') + '\n');

      const explicit = parseSession(cursorPath, 'cursor');
      assert.equal(explicit.source, 'cursor');
      assert.equal(explicit.stats.userMessages, 1);
      // Parity fields derived for Cursor: sessionId from file basename, model label,
      // file-metadata timing fallback (no timestamps in the format — fact tln),
      // estimated output tokens, turn_ended error surfaced as an error tool_result event.
      assert.equal(explicit.sessionId, 'sess-uuid');
      assert.equal(explicit.model, 'cursor');
      assert.notEqual(explicit.startTime, null);
      assert.notEqual(explicit.endTime, null);
      assert.ok(explicit.durationMs >= 0);
      assert.equal(explicit.timesEstimated, true);
      assert.ok(explicit.stats.totalOutputTokens > 0);
      assert.equal(explicit.stats.tokensEstimated, true);
      assert.equal(explicit.stats.errors, 1);
      const errEvent = explicit.events.find((e) => e.isError);
      assert.equal(errEvent.text, 'User aborted request');
      // Thinking blocks surface like parseClaude
      const assistantEvent = explicit.events.find((e) => e.type === 'assistant');
      assert.deepEqual(assistantEvent.thinking, ['cursor private thinking']);
      // StrReplace normalizes to Edit and carries diffInfo
      const editCall = explicit.events.flatMap((e) => e.toolCalls || []).find((tc) => tc.name === 'Edit');
      assert.ok(editCall, 'StrReplace should normalize to Edit');
      assert.equal(editCall.diffInfo.oldStr, 'x');
      assert.equal(explicit.stats.toolCounts.Edit, 1);
      // No Shell working_directory or SetActiveBranch inputs: cwd/gitBranch stay null
      assert.equal(explicit.cwd, null);
      assert.equal(explicit.gitBranch, null);

      const detected = parseSession(cursorPath);
      assert.equal(detected.source, 'cursor');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('cursor-cloud source preserves cursor-cloud identity', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'parse-cursor-cloud-'));
    const hadOverride = Object.hasOwn(process.env, 'TRACEQUEST_CURSOR_CLOUD_DIR');
    const prevOverride = process.env.TRACEQUEST_CURSOR_CLOUD_DIR;
    try {
      // The import root is env-overridable; auto-detection must sniff it before
      // the generic ".cursor/" match (fact ccpp).
      const cloudRoot = join(root, 'cursor-cloud');
      process.env.TRACEQUEST_CURSOR_CLOUD_DIR = cloudRoot;
      const cloudDir = join(cloudRoot, 'org-repo');
      mkdirSync(cloudDir, { recursive: true });
      const cloudPath = join(cloudDir, 'bc-1234abcd.jsonl');
      writeFileSync(cloudPath, [
        JSON.stringify({
          type: 'session_meta',
          bcId: 'bc-1234abcd',
          name: 'Cloud identity run',
          status: 'FINISHED',
          createdAt: '2026-07-01T10:00:00Z',
          updatedAt: '2026-07-01T11:00:00Z',
        }),
        JSON.stringify({
          role: 'user',
          message: { content: [{ type: 'text', text: 'Cloud prompt' }] },
        }),
        JSON.stringify({
          role: 'assistant',
          message: { content: [{ type: 'text', text: 'Cloud reply text' }] },
        }),
      ].join('\n') + '\n');

      const explicit = parseSession(cloudPath, 'cursor-cloud');
      assert.equal(explicit.source, 'cursor-cloud');
      assert.equal(explicit.stats.userMessages, 1);
      // sessionId is the <agentId>.jsonl basename; the model falls back to the
      // "cursor-cloud" literal, never the local cursor state db (fact ccmf).
      assert.equal(explicit.sessionId, 'bc-1234abcd');
      assert.equal(explicit.model, 'cursor-cloud');
      assert.ok(explicit.stats.totalOutputTokens > 0);
      assert.equal(explicit.stats.tokensEstimated, true);

      const detected = parseSession(cloudPath);
      assert.equal(detected.source, 'cursor-cloud');
    } finally {
      if (hadOverride) process.env.TRACEQUEST_CURSOR_CLOUD_DIR = prevOverride;
      else delete process.env.TRACEQUEST_CURSOR_CLOUD_DIR;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('cursor-cloud meta timestamps produce measured start and end times', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'parse-cursor-cloud-times-'));
    try {
      const cloudDir = join(root, 'cursor-cloud-root', 'org-repo');
      mkdirSync(cloudDir, { recursive: true });
      const cloudPath = join(cloudDir, 'bc-times.jsonl');
      const createdAt = '2026-07-01T10:00:00.000Z';
      const updatedAt = '2026-07-01T11:30:00.000Z';
      writeFileSync(cloudPath, [
        JSON.stringify({
          type: 'session_meta',
          bcId: 'bc-times',
          name: 'Timed cloud run',
          status: 'FINISHED',
          createdAt,
          updatedAt,
          model: 'gpt-5-cursor',
        }),
        JSON.stringify({
          role: 'user',
          message: { content: [{ type: 'text', text: 'no event timestamps here' }] },
        }),
      ].join('\n') + '\n');
      // File times a day in the past must be ignored while meta times are present.
      const pastMs = Date.now() - 24 * 60 * 60 * 1000;
      utimesSync(cloudPath, new Date(pastMs), new Date(pastMs));

      const session = parseSession(cloudPath, 'cursor-cloud');
      assert.equal(session.timesEstimated, false);
      assert.equal(new Date(session.startTime).getTime(), Date.parse(createdAt));
      assert.equal(new Date(session.endTime).getTime(), Date.parse(updatedAt));
      assert.equal(session.durationMs, Date.parse(updatedAt) - Date.parse(createdAt));
      assert.equal(session.model, 'gpt-5-cursor');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('cursor-cloud file without session_meta estimates times like local cursor', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'parse-cursor-cloud-degraded-'));
    try {
      const cloudDir = join(root, 'cursor-cloud-root', 'org-repo');
      mkdirSync(cloudDir, { recursive: true });
      const cloudPath = join(cloudDir, 'bc-degraded.jsonl');
      writeFileSync(cloudPath, JSON.stringify({
        role: 'user',
        message: { content: [{ type: 'text', text: 'no meta line at all' }] },
      }) + '\n');

      const session = parseSession(cloudPath, 'cursor-cloud');
      assert.equal(session.source, 'cursor-cloud');
      assert.equal(session.timesEstimated, true);
      assert.notEqual(session.startTime, null);
      assert.ok(session.durationMs >= 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('cursor derives cwd and gitBranch from tool inputs', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'parse-cursor-cwd-'));
    try {
      const cursorDir = join(root, '.cursor', 'projects', 'cursor-proj', 'agent-transcripts', 'sess-cwd');
      mkdirSync(cursorDir, { recursive: true });
      const cursorPath = join(cursorDir, 'sess-cwd.jsonl');
      const assistantRow = (blocks) => JSON.stringify({ role: 'assistant', message: { content: blocks } });
      writeFileSync(cursorPath, [
        JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'do work' }] } }),
        assistantRow([{ type: 'tool_use', name: 'Shell', input: { command: 'ls', working_directory: '/repo/main' } }]),
        assistantRow([
          { type: 'tool_use', name: 'Shell', input: { command: 'pwd', working_directory: '/repo/other' } },
          { type: 'tool_use', name: 'SetActiveBranch', input: { branchName: 'feature/first' } },
        ]),
        assistantRow([
          { type: 'tool_use', name: 'Shell', input: { command: 'git status', working_directory: '/repo/main' } },
          // Second SetActiveBranch is ignored: first-row-wins
          { type: 'tool_use', name: 'SetActiveBranch', input: { branchName: 'feature/second' } },
          // Malformed inputs are ignored
          { type: 'tool_use', name: 'Shell', input: { command: 'echo', working_directory: '' } },
          { type: 'tool_use', name: 'Shell', input: { command: 'echo' } },
        ]),
      ].join('\n') + '\n');

      const session = parseSession(cursorPath, 'cursor');
      assert.equal(session.cwd, '/repo/main');
      assert.equal(session.gitBranch, 'feature/first');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('cursor falls back to file timestamps when transcript has none', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'parse-cursor-times-'));
    try {
      const cursorDir = join(root, '.cursor', 'projects', 'cursor-proj', 'agent-transcripts', 'sess-times');
      mkdirSync(cursorDir, { recursive: true });
      const cursorPath = join(cursorDir, 'sess-times.jsonl');
      writeFileSync(cursorPath, JSON.stringify({
        role: 'user',
        message: { content: [{ type: 'text', text: 'no timestamps here' }] },
      }) + '\n');
      // Push mtime 5s into the future: birthtime (now) <= mtime → real span.
      const futureMs = Date.now() + 5000;
      utimesSync(cursorPath, new Date(futureMs), new Date(futureMs));

      const session = parseSession(cursorPath, 'cursor');
      assert.notEqual(session.startTime, null);
      assert.equal(session.timesEstimated, true);
      // endTime is the mtime we set (ms truncation tolerance).
      assert.ok(Math.abs(new Date(session.endTime).getTime() - futureMs) < 10);
      assert.ok(session.durationMs >= 0);
      assert.equal(session.durationMs,
        new Date(session.endTime).getTime() - new Date(session.startTime).getTime());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('cursor clamps file-time fallback when birthtime is after mtime', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'parse-cursor-clamp-'));
    try {
      const cursorDir = join(root, '.cursor', 'projects', 'cursor-proj', 'agent-transcripts', 'sess-clamp');
      mkdirSync(cursorDir, { recursive: true });
      const cursorPath = join(cursorDir, 'sess-clamp.jsonl');
      writeFileSync(cursorPath, JSON.stringify({
        role: 'user',
        message: { content: [{ type: 'text', text: 'clamp me' }] },
      }) + '\n');
      // mtime a day in the past; the file was just created, so birthtime >= mtime
      // regardless of whether the platform lowers birthtime along with mtime.
      const pastMs = Date.now() - 24 * 60 * 60 * 1000;
      utimesSync(cursorPath, new Date(pastMs), new Date(pastMs));

      const session = parseSession(cursorPath, 'cursor');
      assert.equal(session.timesEstimated, true);
      assert.equal(session.startTime, session.endTime);
      assert.equal(session.durationMs, 0);
      assert.ok(Math.abs(new Date(session.endTime).getTime() - pastMs) < 10);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('barrel re-exports parse-utils symbols', () => {
    assert.equal(typeof parseToolArgs, 'function');
    assert.deepEqual(parseToolArgs('{"x":1}'), { x: 1 });
  });

  test('extractUserQuery strips tags and command wrappers', () => {
    assert.equal(extractUserQuery('plain question'), 'plain question');
    assert.equal(extractUserQuery('<user_query>inner</user_query>'), 'inner');
    assert.equal(extractUserQuery('<user_query><command-args>run it</command-args></user_query>'), 'run it');
    assert.equal(extractUserQuery('<system>hidden</system>'), null);
  });

  test('parseSession codex indexes user_message and session_meta', () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'parse-codex-'));
    const f = join(dir, 'rollout.jsonl');
    const ts = '2026-05-20T12:00:00Z';
    const lines = [
      JSON.stringify({ type: 'session_meta', payload: { id: 'cx1', cwd: '/proj', model_provider: 'openai' } }),
      JSON.stringify({ type: 'event_msg', timestamp: ts, payload: { type: 'user_message', message: 'fix the bug' } }),
    ];
    writeFileSync(f, lines.join('\n') + '\n');
    const sess = parseSession(f, 'codex');
    assert.equal(sess.source, 'codex');
    assert.equal(sess.sessionId, 'cx1');
    assert.equal(sess.cwd, '/proj');
    assert.equal(sess.stats.userMessages, 1);
    rmSync(dir, { recursive: true, force: true });
  });

  test('parseSession factory reads session_start and message roles', () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'parse-factory-'));
    const f = join(dir, 'run.jsonl');
    const lines = [
      JSON.stringify({ type: 'session_start', id: 'f1', cwd: '/ws' }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-05-20T12:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'factory prompt' }] },
      }),
    ];
    writeFileSync(f, lines.join('\n') + '\n');
    const sess = parseSession(f, 'factory');
    assert.equal(sess.source, 'factory');
    assert.equal(sess.sessionId, 'f1');
    assert.equal(sess.model, 'claude (factory)');
    assert.equal(sess.stats.userMessages, 1);
    rmSync(dir, { recursive: true, force: true });
  });

  test('parseSession grok reads chat_history user_query', () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'parse-grok-'));
    writeFileSync(join(dir, 'chat_history.jsonl'), JSON.stringify({
      type: 'user',
      content: '<user_query>ship feature</user_query>',
    }) + '\n');
    writeFileSync(join(dir, 'events.jsonl'), JSON.stringify({
      type: 'turn_started', session_id: 'g1', ts: '2026-05-20T12:00:00Z',
    }) + '\n');
    const sess = parseSession(dir, 'grok');
    assert.equal(sess.source, 'grok');
    assert.equal(sess.sessionId, 'g1');
    assert.equal(sess.stats.userMessages, 1);
    assert.ok(sess.events.some((e) => e.type === 'user' && e.text.includes('ship feature')));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('parse robustness (timestamp + malformed data per @spec z6m/0lo/5mj)', () => {
  test('parseSession skips malformed JSONL lines and returns null defaults for missing metadata', () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'parse-malformed-defaults-'));
    const f = join(dir, 'malformed-defaults.jsonl');
    const ts = '2026-05-20T12:00:00Z';
    const lines = [
      '{"type":"user","message":',
      JSON.stringify({ type: 'user', message: { content: 'valid prompt' }, timestamp: ts, uuid: 'u1', isMeta: false }),
    ];
    writeFileSync(f, lines.join('\n') + '\n');

    const errors = [];
    const originalError = console.error;
    console.error = (...args) => { errors.push(args.join(' ')); };
    try {
      const sess = parseSession(f, 'claude');
      assert.equal(sess.source, 'claude');
      assert.equal(sess.sessionId, null);
      assert.equal(sess.cwd, null);
      assert.equal(sess.model, null);
      assert.equal(sess.gitBranch, null);
      assert.equal(sess.eventCount, 1);
      assert.equal(sess.events[0].text, 'valid prompt');
      assert.ok(errors.some((line) => line.includes('parseJsonlLine: malformed JSONL line:')));
    } finally {
      console.error = originalError;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('parseSession succeeds (no RangeError crash) on claude jsonl with invalid/non-ISO timestamps; uses only valid ones for timing', () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'parse-robust-'));
    const f = join(dir, 'badts.jsonl');
    const goodTs = '2026-05-20T12:00:00Z';
    const lines = [
      JSON.stringify({ type: 'user', sessionId: 's1', message: { content: 'hi' }, timestamp: 'not-a-date', uuid: 'u0', isMeta: false }),
      JSON.stringify({ type: 'user', sessionId: 's1', message: { content: 'real' }, timestamp: goodTs, uuid: 'u1', isMeta: false }),
      JSON.stringify({ type: 'assistant', message: { model: 'm', content: [{ type: 'text', text: 'ok' }] }, timestamp: goodTs, uuid: 'a1' })
    ];
    writeFileSync(f, lines.join('\n') + '\n');
    let sess;
    assert.doesNotThrow(() => { sess = parseSession(f, 'claude'); });
    assert.equal(sess.eventCount, 3);
    assert.ok(sess.startTime.includes('2026-05-20')); // from the good ts only
    assert.equal(sess.stats.userMessages, 2);
    rmSync(dir, { recursive: true, force: true });
  });

  test('normalizeToolName still works after parse changes', () => {
    assert.equal(normalizeToolName('bash'), 'Bash');
    assert.equal(normalizeToolName('read_file'), 'Read');
    assert.equal(normalizeToolName('unknowncmd'), 'Unknowncmd');
    assert.equal(normalizeToolName('mcp__foo__bar'), 'mcp__foo__bar');
  });
});
