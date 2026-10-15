import '../helpers/skip-lr-watch-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { mkTmp, writeJsonl } from '../helpers/fixtures.js';
import { PLAYWRIGHT, SKIP_NO_PLAYWRIGHT } from '../helpers/playwright-gate.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function recording(home, id, outcomes, outputs, { orphan = false } = {}) {
  const path = join(home, '.grok/sessions/%2Frepo', id);
  writeJsonl(join(path, 'events.jsonl'), [
    { type: 'turn_started', session_id: id, ts: '2026-10-15T10:00:00Z' },
    ...outcomes.flatMap(outcome => [
      { type: 'tool_started', tool_name: 'bash', ts: '2026-10-15T10:00:01Z' },
      { type: 'tool_completed', tool_name: 'bash', outcome, ts: '2026-10-15T10:00:02Z' },
    ]),
    { type: 'turn_ended', ts: '2026-10-15T10:00:03Z' },
  ]);
  writeJsonl(join(path, 'chat_history.jsonl'), [
    ...(!orphan ? [
      { type: 'user', content: id },
      { type: 'assistant', content: 'Inspect recorded output', tool_calls: outputs.map((_, i) => ({ id: `call-${i}`, name: 'bash', arguments: '{"command":"cat report.txt"}' })) },
    ] : []),
    ...outputs.map((content, i) => ({ type: 'tool_result', tool_call_id: `call-${i}`, content })),
    { type: 'assistant', content: 'Finished' },
  ]);
  return path;
}

test('Grok recorded outcomes agree in served detail and Insights', SKIP_NO_PLAYWRIGHT, async () => {
  const home = mkTmp('tq-grok-failures-');
  const cases = [
    { id: 'successful-output', outcomes: ['success', 'success'], outputs: ['exit: 0\nexit code 1 from an inner command', 'exit: 0\nTypeError: HTTP_ERROR constant in source'], errors: 0 },
    { id: 'confirmed-error', outcomes: ['error'], outputs: ['exit: 0\nordinary looking output'], errors: 1 },
    { id: 'truncated-error', outcomes: ['error'], outputs: ['ordinary output '.repeat(200) + '\nError: failure after display cutoff'], errors: 1 },
    { id: 'unrecorded-outcome', outcomes: [], outputs: ['Error: permission denied'], errors: 1 },
    { id: 'orphan-success', outcomes: ['success'], outputs: ['exit: 0\nTypeError: HTTP_ERROR constant'], errors: 0, orphan: true },
    { id: 'orphan-error', outcomes: ['error'], outputs: ['exit: 0\nordinary output'], errors: 1, orphan: true },
  ];
  for (const c of cases) c.path = recording(home, c.id, c.outcomes, c.outputs, c);
  const env = { ...process.env, HOME: home, TRACEQUEST_LIVE_SESSIONS_HOME: home, TRACEQUEST_NO_SIDECAR: '1', TRACEQUEST_SKIP_TMUX: '1', TRACEQUEST_SKIP_LR_WATCH: '1', TRACEQUEST_TMUX_SOCKET: `tq-grok-${process.pid}`, TRACEQUEST_TMUX_SESSION: `tq-grok-${process.pid}` };
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  let child;
  let browser;
  try {
    const refresh = spawnSync(process.execPath, ['bin/tracequest.js', 'insights', '--refresh'], { cwd: ROOT, env, encoding: 'utf8', timeout: 30000 });
    assert.equal(refresh.status, 0, refresh.stderr);
    child = spawn(process.execPath, ['bin/tracequest.js', 'serve', '--port', String(port)], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', data => { log += data; });
    child.stderr.on('data', data => { log += data; });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; ; i++) {
      assert.ok(i < 200 && child.exitCode == null, `server did not start: ${log}`);
      try { if ((await fetch(base + '/api/sessions')).ok) break; } catch {}
      await pause(50);
    }
    browser = await PLAYWRIGHT.chromium.launch({ headless: true });
    const page = await browser.newPage();
    for (const c of cases) {
      await page.goto(`${base}/view?path=${encodeURIComponent(c.path)}&source=grok`);
      const stat = page.locator('.stats-bar .stat').filter({ has: page.locator('.stat-label', { hasText: /^errors$/ }) }).locator('.stat-value');
      await stat.waitFor();
      assert.equal(await stat.innerText(), String(c.errors), `${c.id}: detail errors follow outer outcome`);
      if (!c.orphan) assert.equal(await page.locator('.error-summary').count(), c.errors ? 1 : 0, `${c.id}: failure groups`);
    }
    await page.goto(base + '/insights');
    assert.match(await page.locator('body').innerText(), /4 of 5 calls/);
    assert.doesNotMatch(await page.locator('.ins-foot').innerText(), /results flagged as errors/);
  } finally {
    if (browser) await browser.close();
    if (child && child.exitCode == null && child.signalCode == null) {
      child.kill('SIGKILL');
      await new Promise(resolve => child.once('exit', resolve));
    }
    rmSync(home, { recursive: true, force: true });
  }
});
