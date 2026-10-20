/**
 * The run view (/run?session=) shows the whole transcript and scrolls through
 * it: every message and tool row after the first prompt is painted, and the
 * mouse wheel reaches each of them on the way from the first prompt to the last
 * message. The view used to collapse earlier items to zero height (or move
 * them off screen), which left only the prompt visible and nothing to scroll.
 */
import '../helpers/skip-lr-watch-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { mkTmp, writeJsonl } from '../helpers/fixtures.js';
import { PLAYWRIGHT } from '../helpers/playwright-gate.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const pause = ms => new Promise(r => setTimeout(r, ms));
const skip = !PLAYWRIGHT && 'playwright not installed';

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
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 100; i++) {
      if (child.exitCode != null) throw new Error(log);
      try { await fetch(base + '/__probe'); return { child, base }; } catch { await pause(50); }
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

const lines = (label, count) => Array.from({ length: count }, (_, i) => `${label} line ${i + 1}`).join('\n');
const ts = n => new Date(Date.UTC(2026, 9, 18, 10, 0, 0) + n * 1000).toISOString();

// Claude rows.
const claudeRow = (n, role, content) => ({ type: role, sessionId: 'scroll', cwd: '/repo', timestamp: ts(n), uuid: `${role}-${n}`, message: role === 'assistant' ? { model: 'claude-sonnet-4-20250514', content } : { content } });
const prompt = (n, text) => claudeRow(n, 'user', text);
const say = (n, text) => claudeRow(n, 'assistant', [{ type: 'text', text }]);
const bash = (n, id, command, text = '') => claudeRow(n, 'assistant', [...(text ? [{ type: 'text', text }] : []), { type: 'tool_use', id, name: 'Bash', input: { command } }]);
const result = (n, id, content) => claudeRow(n, 'user', [{ type: 'tool_result', tool_use_id: id, content }]);

// Codex rows.
const codexRow = (n, type, payload) => ({ timestamp: ts(n), type, payload });
const codexMsg = (role, text) => ({ type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] });

const KANDEV_PROMPT = '<kandev-system>Kandev Task ID: 1234</kandev-system>\n\nFIRST PROMPT: fix the pending lock.\n' + lines('brief', 30);

function writeRecording(path, rows) {
  writeJsonl(path, rows);
  const old = new Date(Date.now() - 3600_000);
  utimesSync(path, old, old);
  return path;
}

const RECORDINGS = {
  // Finished Kandev-style Claude task: one prompt, then a long run of steps.
  'claude finished': home => writeRecording(join(home, '.claude/projects/proj/finished.jsonl'), [
    prompt(0, KANDEV_PROMPT),
    ...Array.from({ length: 10 }, (_, i) => [
      bash(1 + i * 2, `call-${i}`, `rg -n lock src/part${i}.js`, `STEP ${i}: checking part ${i}.\n${lines(`note${i}`, 4)}`),
      result(2 + i * 2, `call-${i}`, lines(`part${i}`, 3)),
    ]).flat(),
    say(40, 'LAST MESSAGE: the lock is released on timeout now.'),
  ]),
  // Finished Codex task.
  'codex finished': home => writeRecording(join(home, '.codex/sessions/2026/10/18/rollout-scroll.jsonl'), [
    codexRow(0, 'session_meta', { id: 'scroll', cwd: '/repo' }),
    codexRow(1, 'response_item', codexMsg('user', 'FIRST PROMPT: tidy the worker.\n' + lines('brief', 20))),
    ...Array.from({ length: 10 }, (_, i) => [
      codexRow(2 + i * 3, 'response_item', codexMsg('assistant', `STEP ${i}: looking at module ${i}.\n${lines(`note${i}`, 4)}`)),
      codexRow(3 + i * 3, 'response_item', { type: 'function_call', call_id: `c-${i}`, name: 'exec_command', arguments: JSON.stringify({ cmd: `ls src/m${i}` }) }),
      codexRow(4 + i * 3, 'response_item', { type: 'function_call_output', call_id: `c-${i}`, output: lines(`m${i}`, 3) }),
    ]).flat(),
    codexRow(40, 'response_item', codexMsg('assistant', 'LAST MESSAGE: the worker is tidy.')),
  ]),
  // Still generating: the newest call has no result yet. The agent wrote several
  // messages after its first call, the shape the view used to collapse.
  'claude generating': home => writeRecording(join(home, '.claude/projects/proj/generating.jsonl'), [
    prompt(0, 'FIRST PROMPT: find why the lock is never released.'),
    bash(1, 'call-a', 'rg -n releaseLock src', 'STEP 0: searching for the release call.'),
    result(2, 'call-a', lines('hit', 3)),
    ...Array.from({ length: 9 }, (_, i) => say(3 + i, `STEP ${i + 1}: reading the result.\n${lines(`note${i + 1}`, 4)}`)),
    bash(20, 'call-live', 'npm test', 'LAST MESSAGE: running the tests now.'),
  ]),
};

/** Every thread item: key, role, height, text. */
function items(page) {
  return page.evaluate(() => [...document.querySelectorAll('#chatThread > *')].map(el => ({
    key: el.getAttribute('data-block-key'), role: el.getAttribute('data-role'),
    height: el.getBoundingClientRect().height, text: el.textContent.slice(0, 60),
  })));
}
/** Keys of the items painted inside the scroller right now. */
function inView(page) {
  return page.evaluate(() => {
    const s = document.getElementById('chatScroll').getBoundingClientRect();
    return [...document.querySelectorAll('#chatThread > *')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.height > 0 && r.bottom > s.top + 1 && r.top < s.bottom - 1;
    }).map(el => el.getAttribute('data-block-key'));
  });
}
const scrollTop = page => page.evaluate(() => document.getElementById('chatScroll').scrollTop);

test('the run view renders every message after the first prompt and scrolls from the first prompt to the last message', { skip }, async () => {
  const home = mkTmp('tq-run-view-scroll-');
  const paths = Object.fromEntries(Object.entries(RECORDINGS).map(([name, write]) => [name, write(home)]));
  const { child, base } = await serve(home);
  const browser = await PLAYWRIGHT.chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    for (const [name, path] of Object.entries(paths)) {
      await page.goto(base + '/run?session=' + encodeURIComponent(path));
      await page.waitForFunction(() => document.querySelector('#chatThread').textContent.includes('LAST MESSAGE'));
      await pause(800);

      const all = await items(page);
      const texts = all.map(i => i.text).join('\n');
      assert.match(all[0].text, /FIRST PROMPT/, `${name}: the first prompt leads the thread`);
      for (let i = 0; i <= 9; i++) assert.match(texts, new RegExp(`STEP ${i}:`), `${name}: step ${i} after the first prompt is rendered`);
      assert.ok(all.filter(i => i.role === 'tools').length >= 1, `${name}: tool calls are rendered`);
      assert.match(all[all.length - 1].text, /LAST MESSAGE|npm test/, `${name}: the transcript runs to the last message`);
      assert.deepEqual(all.filter(i => i.height === 0).map(i => i.text), [], `${name}: no item is collapsed to zero height`);
      assert.equal(await page.locator('#chatHistoryCol > *').count(), 0, `${name}: no item is moved off screen`);
      assert.ok(await page.evaluate(() => { const s = document.getElementById('chatScroll'); return s.scrollHeight > s.clientHeight + 200; }), `${name}: the conversation is taller than the screen, so it scrolls`);

      // Wheel from the first prompt down to the last message; every item passes through view.
      await page.locator('#chatScroll').hover();
      for (let i = 0; i < 80 && await scrollTop(page) > 0; i++) await page.mouse.wheel(0, -800);
      assert.equal(await scrollTop(page), 0, `${name}: the wheel reaches the top`);
      const seen = new Set(await inView(page));
      assert.ok(seen.has(all[0].key), `${name}: the first prompt is in view at the top`);
      let last = -1;
      for (let i = 0; i < 80; i++) {
        await page.mouse.wheel(0, 300);
        await pause(60);
        for (const k of await inView(page)) seen.add(k);
        const top = await scrollTop(page);
        if (top === last) break;
        last = top;
      }
      assert.ok(last > 0, `${name}: the wheel scrolls down`);
      assert.deepEqual(all.filter(i => !seen.has(i.key)).map(i => i.text), [], `${name}: every item comes into view while scrolling down`);
      assert.ok((await inView(page)).includes(all[all.length - 1].key), `${name}: the last message is in view at the bottom`);
    }
  } finally {
    await browser.close();
    await stop(child, home);
  }
});
