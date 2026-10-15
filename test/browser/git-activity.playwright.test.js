import '../helpers/skip-lr-watch-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { mkTmp, writeJsonl } from '../helpers/fixtures.js';
import { PLAYWRIGHT, SKIP_NO_PLAYWRIGHT } from '../helpers/playwright-gate.js';

const ROOT = new URL('../../', import.meta.url).pathname;

test('git activity labels respect checkout flags and the commit message boundary', SKIP_NO_PLAYWRIGHT, async () => {
  const home = mkTmp('tq-git-activity-');
  const path = join(home, '.claude/projects/git-activity/session.jsonl');
  const commands = [
    ['git checkout -q main', ''],
    ['git switch --quiet topic', ''],
    ['git checkout main\npython3 -V', ''],
    ['git switch topic\npython3 -V', ''],
    ['git checkout -q HEAD -- file.py', ''],
    ['git checkout file.py', ''],
    ['git checkout main --', ''],
    ['git checkout -b feature/create', ''],
    ['git switch -c feature/switch', ''],
    ["git commit -qam 'preserve the actual subject' && python3 - <<'EOF'\nimport re\nEOF", 'abc1234'],
    ["python3 - <<'EOF'\nimport os\nEOF\ntrue; git commit -m \"plain subject\"", 'def5678'],
    ["git commit -m \"$(cat <<'EOF'\nheredoc subject; keep the full subject\n\nbody\nEOF\n)\"", ''],
    ["git -C /repo commit -m \"$(cat <<'EOF'\nsubject with git directory\nEOF\n)\"", ''],
    ['git commit -m "subject from flag"', '[topic 123abcd] subject from output'],
  ];
  const rows = [{ type: 'user', sessionId: 'git-activity', cwd: '/repo', timestamp: '2026-10-15T10:00:00Z', message: { role: 'user', content: 'Check git activity' } }];
  for (const [i, [command, output]] of commands.entries()) {
    rows.push({ type: 'assistant', timestamp: `2026-10-15T10:00:${String(i * 2 + 1).padStart(2, '0')}Z`, message: { role: 'assistant', content: [{ type: 'tool_use', id: `bash-${i}`, name: 'Bash', input: { command } }] } });
    rows.push({ type: 'user', timestamp: `2026-10-15T10:00:${String(i * 2 + 2).padStart(2, '0')}Z`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `bash-${i}`, content: output }] } });
  }
  writeJsonl(path, rows);
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ['bin/tracequest.js', 'serve', '--port', String(port)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home, TRACEQUEST_LIVE_SESSIONS_HOME: home, TRACEQUEST_NO_SIDECAR: '1', TRACEQUEST_SKIP_TMUX: '1', TRACEQUEST_SKIP_LR_WATCH: '1', TRACEQUEST_TMUX_SOCKET: `tq-git-${port}`, TRACEQUEST_TMUX_SESSION: `tq-git-${port}` },
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  let browser;
  try {
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(child.exitCode, null, log);
      try { if ((await fetch(base + '/')).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, log);
    browser = await PLAYWRIGHT.chromium.launch();
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/view?path=' + encodeURIComponent(path));
    await page.locator('.git-timeline').waitFor();
    if (await page.locator('.tool-perf-header').count()) await page.locator('.tool-perf-header').click();
    const labels = await page.locator('.git-op-detail').allTextContents();
    assert.deepEqual(labels.map(label => label.trim()), [
      'switch to main', 'switch to topic', 'switch to main', 'switch to topic', 'switch to main', 'create feature/create', 'create feature/switch', 'abc1234preserve the actual subject',
      'def5678plain subject', 'heredoc subject; keep the full subject', 'subject with git directory', '123abcdsubject from output',
    ]);
    assert.deepEqual(errors, [], 'rendered helpers execute without browser errors');
  } finally {
    await browser?.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
    rmSync(home, { recursive: true, force: true });
  }
});
