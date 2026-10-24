import '../helpers/skip-lr-watch-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { claudeProj, mkTmp, writeClaudeJsonl } from '../helpers/fixtures.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const CWD = '/home/dev/trapwait';
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-07-03T10:00:00.000Z');

function sessionLines() {
  let t = T0;
  let n = 0;
  const at = (ms) => new Date((t += ms)).toISOString();
  const base = () => ({ sessionId: 'trapwait-1', cwd: CWD, uuid: `u${++n}` });
  const prompt = (text, wait) => ({ ...base(), type: 'user', timestamp: at(wait), message: { role: 'user', content: text } });
  const call = (id, command, wait) => ({
    ...base(), type: 'assistant', timestamp: at(wait),
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
  });
  const result = (id, wait) => ({
    ...base(), type: 'user', timestamp: at(wait),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  });
  return [
    prompt('run the tests', 0),
    // A test run that keeps the agent waiting 20 min: a stall and a hang.
    call('t1', 'npm test', 1000),
    result('t1', 20 * MIN),
    // A test run whose result comes 17 h later (the session waited on an
    // approval prompt): neither a stall nor a hang.
    call('t2', 'node --test test/a.test.js', 5000),
    result('t2', 17 * HOUR),
    // Quick CI polls three minutes apart: CI wait events, no waiting.
    call('c1', 'sleep 60; gh pr checks 7', 5000),
    result('c1', 70 * 1000),
    call('c2', 'sleep 60; gh pr checks 7', 3 * MIN),
    result('c2', 70 * 1000),
    // A CI watch that blocks 8 min: a stall and CI waiting.
    call('c3', 'gh run watch 42', 5000),
    result('c3', 8 * MIN),
    { ...base(), type: 'assistant', timestamp: at(5000), message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
  ];
}

test('insights trap waiting is part of the stalls waiting and skips sessions left on a prompt', () => {
  const home = mkTmp('tq-insights-trapwait-');
  try {
    writeClaudeJsonl(claudeProj(home, '-home-dev-trapwait'), 'trapwait-1.jsonl', sessionLines());
    const r = spawnSync(process.execPath, ['bin/tracequest.js', 'insights', '--refresh', '--json'], {
      cwd: ROOT, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, HOME: home, TRACEQUEST_NO_SIDECAR: '1', TRACEQUEST_SKIP_TMUX: '1', TRACEQUEST_SKIP_LR_WATCH: '1' },
    });
    assert.equal(r.status, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.totals.analyzed, 1);
    assert.equal(data.stalls.count, 2);
    assert.equal(data.stalls.ms, 28 * MIN);
    const trap = Object.fromEntries(data.traps.map((t) => [t.id, t]));
    assert.equal(trap['test-hang'].events, 1);
    assert.equal(trap['test-hang'].ms, 20 * MIN);
    assert.equal(trap['ci-wait'].events, 3);
    assert.equal(trap['ci-wait'].ms, 8 * MIN);
    for (const t of data.traps) assert.ok(t.ms <= data.stalls.ms, `${t.id} waiting ${t.ms} exceeds stalls ${data.stalls.ms}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
