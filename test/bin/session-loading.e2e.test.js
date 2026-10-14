import '../helpers/skip-lr-watch-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkTmp, writeJsonl } from '../helpers/fixtures.js';
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
