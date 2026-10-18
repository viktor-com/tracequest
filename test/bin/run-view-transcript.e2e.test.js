/**
 * The run view (/run?session=) shows the whole transcript like Cursor's and
 * Kandev's chat: it opens at the end of the conversation, a long prompt folds
 * behind show more instead of filling the screen, a growing recording streams
 * in below the earlier items, and a Kandev-started Grok session keeps its
 * prompt. Agent sessions usually open with one very long prompt, which the
 * view used to frame at the top of the screen so nothing else was visible.
 */
import '../helpers/skip-lr-watch-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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

const timestamp = n => new Date(Date.UTC(2026, 9, 18, 10, 0, 0) + n * 1000).toISOString();
const claudeRow = (n, role, content) => ({ type: role, sessionId: 'run-view', cwd: '/repo', timestamp: timestamp(n), uuid: `${role}-${n}`, message: role === 'assistant' ? { model: 'claude-sonnet-4-20250514', content } : { content } });
const prompt = (n, text) => claudeRow(n, 'user', text);
const say = (n, text) => claudeRow(n, 'assistant', [{ type: 'text', text }]);
const bash = (n, id, command, text = '') => claudeRow(n, 'assistant', [...(text ? [{ type: 'text', text }] : []), { type: 'tool_use', id, name: 'Bash', input: { command } }]);
const result = (n, id, content) => claudeRow(n, 'user', [{ type: 'tool_result', tool_use_id: id, content }]);
const lines = (label, count) => Array.from({ length: count }, (_, i) => `${label} line ${i + 1}`).join('\n');

/** A Kandev-style task prompt: a context block, then a brief far longer than the screen. */
const KANDEV_PROMPT = '<kandev-system>Kandev Task ID: 1234\nUse the kandev tools.</kandev-system>\n\nBrief: fix the pending lock.\n' + lines('brief', 120);

/** One agent turn: prose, a command and its output, `count` times. */
function work(start, count) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const n = start + i * 2;
    rows.push(bash(n, `call-${n}`, `rg -n lock src/part${i}.js`, `Step ${i}: checking part ${i}.`));
    rows.push(result(n + 1, `call-${n}`, lines(`part${i}`, 3)));
  }
  return rows;
}

function writeRecording(home, name, rows) {
  const path = join(home, `.claude/projects/proj/${name}.jsonl`);
  writeJsonl(path, rows);
  const old = new Date(Date.now() - 3600_000);
  utimesSync(path, old, old);
  return path;
}

/** Every thread item with its height and whether it is painted inside the scroller. */
function shown(page) {
  return page.evaluate(() => {
    const scroller = document.getElementById('chatScroll').getBoundingClientRect();
    return [...document.querySelectorAll('#chatThread > *')].map(el => {
      const r = el.getBoundingClientRect();
      return { role: el.getAttribute('data-role'), text: el.textContent.slice(0, 80), height: r.height, inView: r.height > 0 && r.bottom > scroller.top + 1 && r.top < scroller.bottom - 1 };
    });
  });
}
async function scrollToTop(page) {
  await page.locator('#chatScroll').hover();
  for (let i = 0; i < 60 && await page.evaluate(() => document.getElementById('chatScroll').scrollTop) > 0; i++) await page.mouse.wheel(0, -800);
}

test('run view opens at the end of the conversation, not on a long first prompt', { skip }, async () => {
  const home = mkTmp('tq-run-view-end-');
  const recordings = {
    'one-long-prompt': [prompt(0, KANDEV_PROMPT), ...work(1, 12), say(40, 'FINAL REPLY: the lock is released on timeout now.')],
    'long-follow-up': [prompt(0, 'Investigate the lock'), ...work(1, 4), prompt(20, 'Now write it up.\n' + lines('follow-up', 90)), ...work(21, 6), say(40, 'FINAL REPLY: written up in NOTES.md.')],
    'no-prompt': [...work(1, 12), say(40, 'FINAL REPLY: done without a recorded prompt.')],
  };
  const paths = Object.fromEntries(Object.entries(recordings).map(([name, rows]) => [name, writeRecording(home, name, rows)]));
  const { child, base } = await serve(home);
  const browser = await PLAYWRIGHT.chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
    for (const [name, path] of Object.entries(paths)) {
      await page.setViewportSize({ width: 1280, height: 760 });
      await page.goto(base + '/run?session=' + encodeURIComponent(path));
      await page.waitForFunction(() => document.querySelector('#chatThread').textContent.includes('FINAL REPLY'));
      await pause(600);
      const initial = await shown(page);
      const last = initial[initial.length - 1];
      assert.match(last.text, /FINAL REPLY/, `${name}: the final reply ends the thread`);
      assert.ok(last.inView, `${name}: the final reply is in view on open`);
      assert.ok(initial.filter(b => b.inView).some(b => b.role !== 'user'), `${name}: the screen is not only a prompt`);
      assert.deepEqual(initial.filter(b => b.height === 0).map(b => b.text), [], `${name}: no item is collapsed to zero height`);
      assert.equal(await page.locator('#chatHistoryCol > *').count(), 0, `${name}: no item is moved off screen`);
      const tools = initial.filter(b => b.role === 'tools').length;
      assert.ok(tools >= 1, `${name}: tool rows are in the thread`);

      await page.setViewportSize({ width: 1280, height: 480 });
      await pause(300);
      const resized = await shown(page);
      assert.ok(resized[resized.length - 1].inView, `${name}: the final reply stays in view after the window shrinks`);

      await scrollToTop(page);
      const top = await shown(page);
      assert.ok(top[0].inView, `${name}: the first item is reachable by scrolling up`);
      if (name !== 'no-prompt') assert.equal(top[0].role, 'user', `${name}: the first prompt leads the thread`);
    }
  } finally {
    await browser.close();
    await stop(child, home);
  }
});

test('a long prompt folds behind show more and opens in place', { skip }, async () => {
  const home = mkTmp('tq-run-view-long-');
  const path = writeRecording(home, 'long', [prompt(0, KANDEV_PROMPT), ...work(1, 3), say(10, 'FINAL REPLY: done.')]);
  const { child, base } = await serve(home);
  const browser = await PLAYWRIGHT.chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
    await page.goto(base + '/run?session=' + encodeURIComponent(path));
    const bubble = page.locator('.chat-user').first();
    await bubble.waitFor();
    const folded = await bubble.innerText();
    assert.match(folded, /Brief: fix the pending lock/, 'the start of the prompt shows');
    assert.doesNotMatch(folded, /kandev-system|Kandev Task ID/, 'the Kandev context block is not part of the prompt');
    assert.doesNotMatch(folded, /brief line 120/, 'the end of a long prompt is folded');
    assert.ok(folded.split('\n').filter(Boolean).length <= 9, 'at most 8 prompt lines and the button show');
    const more = bubble.locator('button', { hasText: /show more/ });
    assert.equal(await more.count(), 1, 'a folded prompt offers show more');

    await more.click();
    assert.match(await bubble.innerText(), /brief line 120/, 'show more opens the whole prompt in place');
    const startInView = await bubble.evaluate(el => {
      const r = el.getBoundingClientRect();
      const s = document.getElementById('chatScroll').getBoundingClientRect();
      return r.top >= s.top - 1 && r.top < s.bottom;
    });
    assert.ok(startInView, 'the reader stays at the start of the opened prompt');
    // A live re-render (the recording grows) keeps the reader's choice.
    appendFileSync(path, JSON.stringify(say(11, 'APPENDED REPLY after opening the prompt.')) + '\n');
    await page.waitForFunction(() => document.querySelector('#chatThread').textContent.includes('APPENDED REPLY'));
    assert.match(await bubble.innerText(), /brief line 120/, 'the opened prompt stays open across a re-render');
    await bubble.locator('button', { hasText: /show less/ }).click();
    assert.doesNotMatch(await bubble.innerText(), /brief line 120/, 'show less folds it back');

    // A find hit in the folded part opens the prompt.
    await page.goto(base + '/run?session=' + encodeURIComponent(path) + '&q=' + encodeURIComponent('brief line 117'));
    await page.locator('.chat-user').first().waitFor();
    await page.waitForFunction(() => document.querySelector('.chat-user').textContent.includes('brief line 117'));
    assert.ok(await page.locator('.chat-user mark.chat-hit').count() >= 1, 'the find hit is highlighted inside the opened prompt');

    // A short prompt has no button.
    const shortPath = writeRecording(home, 'short', [prompt(0, 'Short prompt'), say(1, 'FINAL REPLY: ok.')]);
    await page.goto(base + '/run?session=' + encodeURIComponent(shortPath));
    await page.locator('.chat-user').first().waitFor();
    assert.equal(await page.locator('.chat-user button').count(), 0, 'a short prompt is shown whole with no button');
  } finally {
    await browser.close();
    await stop(child, home);
  }
});

test('a live recording streams in below the earlier items without hiding them', { skip }, async () => {
  const home = mkTmp('tq-run-view-live-');
  // The newest assistant event holds a call with no result yet: the view treats the turn as generating.
  const path = writeRecording(home, 'live', [prompt(0, KANDEV_PROMPT), ...work(1, 8), say(30, 'Midway note before the next call.'), bash(31, 'call-live-1', 'npm test')]);
  const { child, base } = await serve(home);
  const browser = await PLAYWRIGHT.chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 680 } });
    await page.goto(base + '/run?session=' + encodeURIComponent(path));
    await page.waitForFunction(() => document.querySelector('#chatThread').textContent.includes('Midway note'));
    await pause(600);
    let items = await shown(page);
    assert.deepEqual(items.filter(b => b.height === 0).map(b => b.text), [], 'no earlier item is hidden while generating');
    assert.ok(items[items.length - 1].inView, 'the running call is in view');
    assert.ok(items.some(b => /Step 0/.test(b.text)), 'the first step of the turn is still in the thread');

    appendFileSync(path, [result(32, 'call-live-1', 'tests pass'), say(33, 'STREAMED REPLY one.'), bash(34, 'call-live-2', 'npm run lint')].map(r => JSON.stringify(r)).join('\n') + '\n');
    await page.waitForFunction(() => document.querySelector('#chatThread').textContent.includes('STREAMED REPLY one'));
    await pause(600);
    items = await shown(page);
    assert.deepEqual(items.filter(b => b.height === 0).map(b => b.text), [], 'appended items do not hide earlier ones');
    assert.ok(items.findIndex(b => /Midway note/.test(b.text)) < items.findIndex(b => /STREAMED REPLY one/.test(b.text)), 'new items land below the earlier ones');
    assert.ok(items[items.length - 1].inView, 'a reader at the bottom follows the newest item');

    await scrollToTop(page);
    const before = await page.evaluate(() => document.getElementById('chatScroll').scrollTop);
    appendFileSync(path, [result(35, 'call-live-2', 'lint clean'), say(36, 'STREAMED REPLY two.')].map(r => JSON.stringify(r)).join('\n') + '\n');
    await page.waitForFunction(() => document.querySelector('#chatThread').textContent.includes('STREAMED REPLY two'));
    await pause(600);
    const after = await page.evaluate(() => document.getElementById('chatScroll').scrollTop);
    assert.ok(Math.abs(after - before) < 5, `a reader who scrolled up keeps their place (${before} -> ${after})`);
  } finally {
    await browser.close();
    await stop(child, home);
  }
});

test('a Grok session started by Kandev keeps its prompt after the Kandev context', async () => {
  const home = mkTmp('tq-run-view-grok-');
  const dir = join(home, '.grok/sessions', encodeURIComponent('/repo'), 'grok-kandev-1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'prompt_context.json'), JSON.stringify({ working_directory: '/repo' }));
  const text = t => [{ type: 'text', text: t }];
  writeJsonl(join(dir, 'chat_history.jsonl'), [
    { type: 'system', content: 'You are Grok.' },
    { type: 'user', content: text('<user_query>\n<kandev-system>Kandev Task ID: 42</kandev-system>\n\nPublish the release notes\n</user_query>') },
    { type: 'user', content: text('<user_query>\n<kandev-system>Only context</kandev-system>\n</user_query>') },
    { type: 'assistant', content: 'Publishing them now.', tool_calls: [] },
  ]);
  writeJsonl(join(dir, 'events.jsonl'), [{ type: 'turn_started', ts: '2026-10-18T10:00:00Z', model_id: 'grok-4' }]);
  const { child, base } = await serve(home);
  try {
    const res = await fetch(base + '/api/sessions/live?path=' + encodeURIComponent(dir));
    assert.equal(res.status, 200);
    const { session } = await res.json();
    assert.deepEqual(session.events.filter(e => e.type === 'user').map(e => e.text), ['Publish the release notes']);
  } finally { await stop(child, home); }
});
