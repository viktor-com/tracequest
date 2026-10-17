import '../helpers/skip-lr-watch-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkTmp, writeJsonl } from '../helpers/fixtures.js';
import { seedOpenCodeIndexDb } from '../helpers/opencode-db-fixtures.js';
import { PLAYWRIGHT } from '../helpers/playwright-gate.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const pause = ms => new Promise(r => setTimeout(r, ms));
async function serve(home, env = {}) {
  const socket = createServer();
  await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port;
  await new Promise(r => socket.close(r));
  const child = spawn(process.execPath, ['bin/tracequest.js', 'serve', '--port', String(port)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home, TRACEQUEST_LIVE_SESSIONS_HOME: home, TRACEQUEST_NO_SIDECAR: '1', TRACEQUEST_SKIP_TMUX: '1', TRACEQUEST_SKIP_LR_WATCH: '1', ...env },
  });
  let log = '';
  child.stdout.on('data', c => { log += c; });
  child.stderr.on('data', c => { log += c; });
  const base = `http://127.0.0.1:${port}`;
  const get = path => fetch(base + path);
  try {
    for (let i = 0; i < 100; i++) {
      if (child.exitCode != null) throw new Error(log);
      try { await get('/__probe'); return { get, child, base }; } catch { await pause(50); }
    }
    throw new Error(`serve did not listen: ${log}`);
  } catch (e) { child.kill('SIGKILL'); throw e; }
}
async function stop(child, home) {
  if (child.exitCode == null && child.signalCode == null) {
    child.kill('SIGKILL');
    await new Promise(r => child.once('exit', r));
  }
  rmSync(home, { recursive: true, force: true });
}
const timestamp = n => `2026-10-13T10:00:${String(n).padStart(2, '0')}.000Z`;
const row = (n, type, payload) => ({ timestamp: timestamp(n), type, payload });
const message = (role, text) => ({ type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] });
const meta = row(0, 'session_meta', { id: 'ordering', cwd: '/repo' });
async function open(get, path) {
  const res = await get('/api/sessions/live?path=' + encodeURIComponent(path));
  assert.equal(res.status, 200);
  return (await res.json()).session;
}

test('Codex tool order preserves calls, results, mixed prompts and a tool-only tail over HTTP', async () => {
  const home = mkTmp('tq-loading-');
  const path = join(home, '.codex/sessions/2026/10/13/rollout-ordering.jsonl');
  writeJsonl(path, [meta,
    row(1, 'response_item', message('user', 'first prompt')),
    row(1, 'event_msg', { type: 'user_message', message: 'first prompt' }),
    row(2, 'response_item', message('assistant', 'checking')),
    row(3, 'response_item', { type: 'function_call', call_id: 'call-1', name: 'exec_command', arguments: '{"cmd":"ls"}' }),
    row(4, 'response_item', { type: 'function_call_output', call_id: 'call-1', output: 'listed' }),
    row(5, 'response_item', message('assistant', 'finished')),
    row(6, 'response_item', message('user', 'second prompt')),
    row(7, 'response_item', { type: 'custom_tool_call', call_id: 'call-2', name: 'apply_patch', input: 'patch' }),
    row(8, 'response_item', { type: 'custom_tool_call_output', call_id: 'call-2', output: 'patched' }),
  ]);
  const { get, child } = await serve(home);
  try {
    const s = await open(get, path);
    assert.deepEqual(s.events.map(e => e.type === 'tool_result' ? e.text : e.toolCalls?.length ? e.toolCalls[0].id : e.text),
      ['first prompt', 'checking', 'call-1', 'listed', 'finished', 'second prompt', 'call-2', 'patched']);
    assert.deepEqual(s.events.map(e => e.timestamp), Array.from({ length: 8 }, (_, i) => timestamp(i + 1)));
  } finally { await stop(child, home); }
});

test('Codex failed task is visible in the served transcript', async () => {
  const home = mkTmp('tq-loading-failure-');
  const path = join(home, '.codex/sessions/2026/10/13/rollout-failure.jsonl');
  writeJsonl(path, [meta, row(1, 'response_item', message('user', 'review this')),
    row(2, 'event_msg', { type: 'task_complete', error: { message: 'The requested model is not supported', codex_error_info: 'other' } }),
  ]);
  const { get, child, base } = await serve(home);
  try {
    const s = await open(get, path);
    assert.equal(s.events.length, 2);
    assert.equal(s.events[1].isError, true);
    assert.equal(s.events[1].toolUseId, null);
    assert.match(s.events[1].text, /requested model is not supported/);
    if (PLAYWRIGHT) {
      const browser = await PLAYWRIGHT.chromium.launch();
      try {
        const page = await browser.newPage();
        await page.goto(base + '/run?session=' + encodeURIComponent(path));
        await page.locator('.chat-errnote').waitFor({ state: 'visible' });
        assert.match(await page.locator('.chat-errnote').innerText(), /requested model is not supported/);
      } finally { await browser.close(); }
    }
  } finally { await stop(child, home); }
});

test('cold default chat leaves other HTTP requests responsive during discovery', async () => {
  const home = mkTmp('tq-loading-cold-');
  const path = join(home, '.claude/projects/proj/session.jsonl');
  writeJsonl(path, [{ type: 'user', sessionId: 'cold', timestamp: timestamp(0), message: { content: 'cold prompt' } }]);
  const marker = join(home, 'sidecar-started');
  const sidecar = join(home, 'slow-sidecar');
  writeFileSync(sidecar, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, 'started');\nsetTimeout(() => process.exit(1), 1500);\n`, { mode: 0o755 });
  const { get, child } = await serve(home, { TRACEQUEST_NO_SIDECAR: '', TRACEQUEST_SIDECAR_PATH: sidecar, TRACEQUEST_SIDECAR_TIMEOUT_MS: '5000' });
  try {
    const pending = get('/').catch(e => e);
    const deadline = Date.now() + 10000;
    while (!existsSync(marker) && Date.now() < deadline) await pause(20);
    assert.ok(existsSync(marker), 'cold page started discovery');
    const start = performance.now();
    assert.equal((await get('/__probe')).status, 404);
    assert.ok(performance.now() - start < 600, 'probe answered while cold discovery is pending');
    assert.equal((await pending).status, 200);
  } finally { await stop(child, home); }
});

test('wrapped user prompts survive in Claude and Codex transcripts over HTTP', async () => {
  const home = mkTmp('tq-loading-wrapped-');
  const claude = join(home, '.claude/projects/proj/wrapped.jsonl');
  const codex = join(home, '.codex/sessions/2026/10/13/rollout-wrapped.jsonl');
  const wrapped = '<kandev-system>Previous session context</kandev-system>\n\n<kandev-system>Tools</kandev-system>\n\nPlease continue the review';
  const onlyContext = '<kandev-system>Tools only</kandev-system>';
  writeJsonl(claude, [wrapped, onlyContext].map((text, i) => ({ type: 'user', sessionId: 'wrapped', timestamp: timestamp(i), message: { content: text } })));
  writeJsonl(codex, [meta, row(1, 'response_item', message('user', wrapped)), row(2, 'response_item', message('user', onlyContext))]);
  const { get, child } = await serve(home);
  try {
    for (const path of [claude, codex]) {
      const s = await open(get, path);
      assert.deepEqual(s.events.filter(e => e.type === 'user').map(e => e.text), ['Please continue the review']);
    }
  } finally { await stop(child, home); }
});

// An OpenCode recording imported from a hub host: tool parts carry their outcome in
// state.status, and a completed call can still print an error.
const OC_HOST = 'gpu';
const OC_FAILED = 'ses_failedtoolcallsxxxxx';
const OC_CLEAN = 'ses_cleantoolcallsxxxxxx';
const ocTool = (callID, status, output) => ({ type: 'tool', tool: 'bash', callID, state: { status, input: { command: 'ls' }, output } });
const ocSession = (id, tools) => ({ id, title: id, messages: [
  { role: 'user', parts: [{ type: 'text', text: `run ${id}` }] },
  { role: 'assistant', modelID: 'gpt-5', parts: [{ type: 'text', text: 'running' }, ...tools] },
  { role: 'user', parts: [{ type: 'text', text: 'thanks' }] },
] });
async function seedImportedOpenCode(home) {
  await seedOpenCodeIndexDb(join(home, '.local/share/tracequest/hosts', OC_HOST), [
    ocSession(OC_FAILED, [ocTool('c1', 'error'), ocTool('c2', 'completed', 'Error: ENOENT: no such file'), ocTool('c3', 'completed', 'ok')]),
    ocSession(OC_CLEAN, [ocTool('c4', 'completed', 'ok')]),
  ]);
  return `opencode://${OC_HOST}/${OC_FAILED}`;
}
const REAL_SIDECAR = join(ROOT, 'sidecar/target/release/tracequest-sidecar');
// The native indexer through a wrapper that records each call, so a silent fallback to JS fails
// the test. ran() reports whether it indexed since the last ran().
function nativeIndexerEnv(home) {
  const bin = join(home, 'tracequest-sidecar');
  const log = join(home, 'sidecar-calls.log');
  writeFileSync(bin, `#!/bin/sh\necho "$1" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(REAL_SIDECAR)} "$@"\n`, { mode: 0o755 });
  const ran = () => {
    const calls = existsSync(log) ? readFileSync(log, 'utf8') : '';
    rmSync(log, { force: true });
    return calls.includes('index');
  };
  return { env: { TRACEQUEST_NO_SIDECAR: '', TRACEQUEST_SIDECAR_PATH: bin }, ran };
}
const INDEXERS = { javascript: () => ({ env: {}, ran: () => true }), native: nativeIndexerEnv };

for (const [name, indexer] of Object.entries(INDEXERS)) {
  test(`OpenCode tool errors match the detail view and the errors filter (${name} indexer)`, async () => {
    const home = mkTmp('tq-loading-ocerr-');
    const failed = await seedImportedOpenCode(home);
    const { env, ran } = indexer(home);
    const { get, child } = await serve(home, env);
    try {
      const res = await get('/api/sessions?expr=' + encodeURIComponent('source:opencode errors:>0'));
      assert.equal(res.status, 200);
      const rows = (await res.json()).sessions;
      assert.ok(ran(), `${name} indexer built the index`);
      assert.deepEqual(rows.map(r => r.path), [failed]);
      const view = await get('/api/view-session?path=' + encodeURIComponent(failed));
      assert.equal(view.status, 200);
      const detail = (await view.json()).session.stats.errors;
      assert.equal(detail, 2);
      assert.equal(rows[0].errors, detail);
    } finally { await stop(child, home); }
  });
}

function findOpenCode(home, expr, env) {
  const r = spawnSync(process.execPath, ['bin/tracequest.js', 'find', expr, '--json'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, HOME: home, TRACEQUEST_NO_SIDECAR: '1', TRACEQUEST_SKIP_TMUX: '1', TRACEQUEST_SKIP_LR_WATCH: '1', ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().startsWith('[') ? JSON.parse(r.stdout).map(s => s.path) : [];
}

for (const [name, indexer] of Object.entries(INDEXERS)) {
  test(`OpenCode error heal re-reads rows cached before errors were counted, once (${name} indexer)`, async () => {
    const home = mkTmp('tq-loading-ocheal-');
    try {
      const failed = await seedImportedOpenCode(home);
      const { env, ran } = indexer(home);
      const indexPath = join(home, '.cache/tracequest/index.json');
      assert.equal(findOpenCode(home, 'source:opencode errors:>=0', env).length, 2);
      assert.ok(ran(), `${name} indexer built the index`);
      // Turn it into an index written before the fix: mtime-current rows with no errors and no marker.
      const old = JSON.parse(readFileSync(indexPath, 'utf8'));
      assert.equal(old._ocerr, 1);
      delete old._ocerr;
      old[failed].errors = 0;
      writeFileSync(indexPath, JSON.stringify(old));
      assert.deepEqual(findOpenCode(home, 'source:opencode errors:>0', env), [failed]);
      assert.ok(ran(), `${name} indexer re-read the rows`);
      const healed = JSON.parse(readFileSync(indexPath, 'utf8'));
      assert.equal(healed._ocerr, 1);
      assert.equal(healed[failed].errors, 2);
      // Once marked, a cached row is not read again.
      healed[failed].errors = 0;
      writeFileSync(indexPath, JSON.stringify(healed));
      assert.deepEqual(findOpenCode(home, 'source:opencode errors:>0', env), []);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}

const claudeRow = (n, role, content) => ({ type: role, sessionId: 'reachable', cwd: '/repo', timestamp: timestamp(n), uuid: `${role}-${n}`, message: role === 'assistant' ? { model: 'claude-sonnet-4-20250514', content } : { content } });
const bash = (n, id, command) => claudeRow(n, 'assistant', [{ type: 'tool_use', id, name: 'Bash', input: { command } }]);
const result = (n, id, content, isError = false) => claudeRow(n, 'user', [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }]);
const say = (n, text) => claudeRow(n, 'assistant', [{ type: 'text', text }]);
const lines = (label, count) => Array.from({ length: count }, (_, i) => `${label} line ${i + 1}`).join('\n');
const firstTurn = [
  claudeRow(0, 'user', 'Investigate the Slack pending-lock report'),
  say(1, 'Looking at the lock directory first.'),
  bash(2, 'cd-1', 'cd /srv/slack/pending-lock && ls'),
  result(3, 'cd-1', 'bash: cd: /srv/slack/pending-lock: No such file or directory', true),
  bash(4, 'rg-1', 'rg -n pending_lock src'),
  result(5, 'rg-1', lines('rg', 30)),
  say(6, 'The lock lives in the worker, checking its history.'),
  bash(7, 'log-1', 'git log --oneline -20 src/worker.js'),
  result(8, 'log-1', lines('log', 20)),
  say(9, 'The worker never releases the pending lock after a timeout.'),
];

test('earlier chat blocks stay reachable by scrolling up in a finished conversation', { skip: !PLAYWRIGHT && 'playwright not installed' }, async () => {
  const home = mkTmp('tq-loading-reachable-');
  const old = new Date(Date.now() - 3600_000);
  const recordings = {
    single: firstTurn,
    'newest-with-output': [...firstTurn, claudeRow(10, 'user', 'Show the release call'), bash(11, 'grep-2', 'rg -n releaseLock src'), result(12, 'grep-2', lines('release', 12)), say(13, 'Release is only called on success.')],
    'newest-text-only': [...firstTurn, claudeRow(10, 'user', 'Summarise the cause'), say(11, 'The timeout path skips releaseLock.')],
  };
  for (const [name, rows] of Object.entries(recordings)) {
    const path = join(home, `.claude/projects/proj/${name}.jsonl`);
    writeJsonl(path, rows);
    utimesSync(path, old, old);
  }
  const { child, base } = await serve(home);
  const browser = await PLAYWRIGHT.chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    for (const [name, rows] of Object.entries(recordings)) {
      const path = join(home, `.claude/projects/proj/${name}.jsonl`);
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(base + '/run?session=' + encodeURIComponent(path));
      await page.waitForFunction(text => document.querySelector('.chat-app').textContent.includes(text), rows[rows.length - 1].message.content[0].text);
      await pause(500);
      const shown = () => page.evaluate(() => {
        const scroller = document.getElementById('chatScroll').getBoundingClientRect();
        return [...document.querySelectorAll('#chatThread > *')].map(el => {
          const r = el.getBoundingClientRect();
          return { text: el.textContent.slice(0, 80), height: r.height, inView: r.height > 0 && r.bottom > scroller.top && r.top < scroller.bottom };
        });
      });
      const initial = await shown();
      assert.ok(initial[initial.length - 1].inView, `${name}: the final reply is framed on open`);
      assert.deepEqual(initial.filter(b => b.height === 0).map(b => b.text), [], `${name}: no block is collapsed to zero height`);
      assert.equal(await page.locator('#chatHistoryCol > *').count(), 0, `${name}: no block is moved off screen`);
      await page.setViewportSize({ width: 1280, height: 520 });
      await pause(300);
      const resized = await shown();
      assert.ok(resized[resized.length - 1].inView, `${name}: the final reply stays framed after the window shrinks`);

      // Scroll up with the mouse wheel, as a reader would.
      await page.locator('#chatScroll').hover();
      for (let i = 0; i < 40 && await page.evaluate(() => document.getElementById('chatScroll').scrollTop) > 0; i++) await page.mouse.wheel(0, -600);
      const top = await shown();
      assert.match(top[0].text, /Slack pending-lock report/, `${name}: the first prompt leads the thread`);
      assert.ok(top[0].inView, `${name}: the first prompt is reachable`);

      const failed = page.locator('.tg-row.err', { hasText: 'No such file or directory' });
      await failed.scrollIntoViewIfNeeded();
      const hit = await failed.evaluate(el => {
        const r = el.getBoundingClientRect();
        return r.height > 0 && el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 20)));
      });
      assert.ok(hit, `${name}: the failed cd output is painted where it scrolls to`);
    }
  } finally {
    await browser.close();
    await stop(child, home);
  }
});
