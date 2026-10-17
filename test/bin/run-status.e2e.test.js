import '../helpers/skip-lr-watch-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkTmp, writeJsonl } from '../helpers/fixtures.js';
import { grokSessionDir } from '../../src/sessions/session-layout.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const pause = ms => new Promise(r => setTimeout(r, ms));
async function serve(home) {
  const socket = createServer();
  await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port;
  await new Promise(r => socket.close(r));
  const child = spawn(process.execPath, ['bin/tracequest.js', 'serve', '--port', String(port)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home, TRACEQUEST_LIVE_SESSIONS_HOME: home, TRACEQUEST_NO_SIDECAR: '1', TRACEQUEST_SKIP_TMUX: '1', TRACEQUEST_SKIP_LR_WATCH: '1' },
  });
  let log = '';
  child.stdout.on('data', c => { log += c; });
  child.stderr.on('data', c => { log += c; });
  const get = path => fetch(`http://127.0.0.1:${port}${path}`);
  try {
    for (let i = 0; i < 100; i++) {
      if (child.exitCode != null) throw new Error(log);
      try { await get('/__probe'); return { get, child }; } catch { await pause(50); }
    }
    throw new Error(`serve did not listen: ${log}`);
  } catch (e) { child.kill('SIGKILL'); throw e; }
}
async function stop(...children) {
  for (const child of children) {
    if (child.exitCode == null && child.signalCode == null) {
      child.kill('SIGKILL');
      await new Promise(r => child.once('exit', r));
    }
  }
}

// Recorded by Grok 4.7 for a one-line reply: after the answer it appends a
// synthetic user record (its skills list) while the TUI waits for input.
const text = t => [{ type: 'text', text: t }];
const query = t => ({ type: 'user', content: text(`<user_query>\n${t}\n</user_query>`), prompt_index: 0 });
const reminder = { type: 'user', content: text('<system-reminder>\nThe following skills are available for use:\n</system-reminder>'), synthetic_reason: 'system_reminder' };
const ts = n => `2026-10-15T13:23:4${n}.000Z`;
function writeGrok(home, cwd, id, { chat, events, updates }, source = 'grok') {
  const dir = grokSessionDir(home, cwd, id, source);
  writeJsonl(join(dir, 'chat_history.jsonl'), chat);
  if (events) writeJsonl(join(dir, 'events.jsonl'), events);
  if (updates) writeJsonl(join(dir, 'updates.jsonl'), updates);
  return dir;
}

test('Grok finished reply followed by a system reminder reads as idle while the Grok process stays open', async () => {
  const home = mkTmp('tq-run-status-');
  const cwd = join(home, 'work');
  mkdirSync(cwd);
  const realCwd = realpathSync(cwd);
  const finished = writeGrok(home, realCwd, 'grok-finished', {
    chat: [{ type: 'system', content: 'You are Grok.' }, query('Reply with exactly TQ15-SENTINEL.'),
      { type: 'reasoning', status: 'completed' }, { type: 'assistant', content: 'TQ15-SENTINEL', model_id: 'grok-4.7-build' }, reminder],
    events: [{ ts: ts(0), type: 'turn_started' }, { ts: ts(1), type: 'phase_changed', phase: 'streaming_text' }, { ts: ts(2), type: 'turn_ended' }],
    updates: [{ params: { update: { sessionUpdate: 'agent_message_chunk' } } }, { params: { update: { sessionUpdate: 'turn_completed' } } }],
  });
  // A prompt Grok has not answered yet stays live even with a reminder after it.
  const pending = writeGrok(home, realCwd, 'grok-pending', {
    chat: [{ type: 'system', content: 'You are Grok.' }, query('Still thinking about this one.'), reminder],
  });
  const grok = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { cwd: realCwd, stdio: 'ignore' });
  writeFileSync(join(home, '.grok', 'active_sessions.json'), JSON.stringify(['grok-finished', 'grok-pending'].map(session_id => (
    { session_id, pid: grok.pid, cwd: realCwd, opened_at: ts(0) }))));
  const { get, child } = await serve(home);
  try {
    const { sessions } = await (await get('/api/sessions')).json();
    const live = Object.fromEntries(sessions.map(s => [s.path, s.live === true]));
    assert.deepEqual(live, { [finished]: false, [pending]: true });
    const state = async path => (await (await get('/api/sessions/live?path=' + encodeURIComponent(path))).json()).state;
    assert.equal(await state(finished), 'idle');
    assert.equal(await state(pending), 'running');
  } finally {
    await stop(child, grok);
    rmSync(home, { recursive: true, force: true });
  }
});

test('vktr finished reply reads idle and an unanswered vktr prompt reads running from ~/.vktr/active_sessions.json', async () => {
  const home = mkTmp('tq-run-status-vktr-');
  const cwd = join(home, 'work');
  mkdirSync(cwd);
  const realCwd = realpathSync(cwd);
  // vktr 1.0.38 rows: grok's shapes minus the reasoning/model_fingerprint fields.
  const finished = writeGrok(home, realCwd, 'vktr-finished', {
    chat: [{ type: 'system', content: 'You are vktr.' }, query('Reply with exactly VK-SENTINEL.'),
      { type: 'assistant', content: 'VK-SENTINEL', model_id: 'viktor', tool_calls: [] }],
    events: [{ ts: ts(0), type: 'turn_started', model_id: 'viktor' }, { ts: ts(1), type: 'phase_changed', phase: 'streaming_text' },
      { ts: ts(2), type: 'turn_ended', outcome: 'completed', cancellation_category: null, cancellation_context: null }],
    updates: [{ params: { update: { sessionUpdate: 'agent_message_chunk' } } }, { params: { update: { sessionUpdate: 'turn_completed' } } }],
  }, 'vktr');
  const pending = writeGrok(home, realCwd, 'vktr-pending', {
    chat: [{ type: 'system', content: 'You are vktr.' }, query('Still thinking about this one.')],
  }, 'vktr');
  const vktr = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { cwd: realCwd, stdio: 'ignore' });
  writeFileSync(join(home, '.vktr', 'active_sessions.json'), JSON.stringify(['vktr-finished', 'vktr-pending'].map(session_id => (
    { session_id, pid: vktr.pid, cwd: realCwd, opened_at: ts(0) }))));
  const { get, child } = await serve(home);
  try {
    const { sessions } = await (await get('/api/sessions')).json();
    assert.deepEqual(sessions.map(s => s.source), ['vktr', 'vktr']);
    const live = Object.fromEntries(sessions.map(s => [s.path, s.live === true]));
    assert.deepEqual(live, { [finished]: false, [pending]: true });
    const state = async path => (await (await get('/api/sessions/live?path=' + encodeURIComponent(path))).json()).state;
    assert.equal(await state(finished), 'idle');
    assert.equal(await state(pending), 'running');
  } finally {
    await stop(child, vktr);
    rmSync(home, { recursive: true, force: true });
  }
});
