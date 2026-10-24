import '../helpers/skip-lr-watch-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { mkTmp, writeJsonl } from '../helpers/fixtures.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const pause = ms => new Promise(r => setTimeout(r, ms));
const timestamp = n => `2026-10-13T10:00:${String(n).padStart(2, '0')}.000Z`;
const row = (n, type, payload) => ({ timestamp: timestamp(n), type, payload });
const message = (role, text) => ({ type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] });
const failure = (chunk, tag) => `Chunk ID: ${chunk}\nWall time: 0.0000 seconds\nProcess exited with code 1\nOriginal token count: 13\nOutput:\nError: tag '${tag}' cannot contain whitespace\n`;

function env(home) {
  const e = { ...process.env, HOME: home, TRACEQUEST_LIVE_SESSIONS_HOME: home, TRACEQUEST_NO_SIDECAR: '1', TRACEQUEST_SKIP_TMUX: '1', TRACEQUEST_SKIP_LR_WATCH: '1' };
  delete e.TRACEQUEST_CACHE_DIR;
  return e;
}

function writeSession(home) {
  const lines = [row(0, 'session_meta', { id: 'tags', cwd: '/repo' }), row(1, 'response_item', message('user', 'tag the facts'))];
  const outputs = [failure('abdd84', 'spec cursor'), failure('0237f6', 'spec cursor'), failure('07251e', 'spec cursor parse'), failure('c0e29a', 'spec cursor')];
  outputs.forEach((output, i) => {
    lines.push(row(2 + i * 2, 'response_item', { type: 'function_call', call_id: `call-${i}`, name: 'exec_command', arguments: JSON.stringify({ cmd: `facts edit x --add-tag "spec cursor" #${i}` }) }));
    lines.push(row(3 + i * 2, 'response_item', { type: 'function_call_output', call_id: `call-${i}`, output }));
  });
  writeJsonl(join(home, '.codex/sessions/2026/10/13/rollout-tags.jsonl'), lines);
}

async function serve(home) {
  const socket = createServer();
  await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port;
  await new Promise(r => socket.close(r));
  const child = spawn(process.execPath, ['bin/tracequest.js', 'serve', '--port', String(port)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: env(home) });
  let log = '';
  child.stdout.on('data', c => { log += c; });
  child.stderr.on('data', c => { log += c; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode != null) throw new Error(log);
    try { await fetch(base + '/__probe'); return { child, base }; } catch { await pause(50); }
  }
  child.kill('SIGKILL');
  throw new Error(`serve did not listen: ${log}`);
}

test('an error class example says the count is for the class and how many errors carry the shown message', async () => {
  const home = mkTmp('tq-insights-note-');
  let child = null;
  let base = '';
  try {
    writeSession(home);
    const run = spawnSync(process.execPath, ['bin/tracequest.js', 'insights', '--refresh', '--json'], { cwd: ROOT, env: env(home), encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const cls = JSON.parse(run.stdout).classes.find(c => c.id === 'nonzero-exit');
    assert.ok(cls, run.stdout);
    assert.equal(cls.count, 4);
    const note = cls.examples[0].note;
    assert.match(note, /^4 errors of this class, 3 with this message; e\.g\. Chunk ID: abdd84 .*Error: tag 'spec cursor' cannot contain whitespace$/);
    assert.doesNotMatch(note, /\d×/);

    ({ child, base } = await serve(home));
    const html = await (await fetch(`${base}/insights`)).text();
    assert.ok(html.includes('4 errors of this class, 3 with this message; e.g. '), html.slice(0, 2000));
    assert.doesNotMatch(html, /4× — /);
  } finally {
    if (child && child.exitCode == null) { child.kill('SIGKILL'); await new Promise(r => child.once('exit', r)); }
    rmSync(home, { recursive: true, force: true });
  }
});
