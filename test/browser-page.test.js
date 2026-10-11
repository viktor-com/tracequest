import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { browserPage } from '../src/browser/browser-page.js';
import { browserPageHTML } from '../src/browser/browser-page-build.js';

function makeSessions(count, mtimeBase = Date.now()) {
  const sessions = [];
  for (let i = 0; i < count; i++) {
    sessions.push({
      path: `/tmp/session-${i}.jsonl`,
      source: 'claude',
      project: 'test-project',
      file: `session-${i}.jsonl`,
      size: 1024 * (i + 1),
      mtime: new Date(mtimeBase + i * 1000),
      title: `Session ${i}`
    });
  }
  return sessions;
}

function makeIndex(sessions) {
  const index = new Map();
  for (const s of sessions) {
    index.set(s.path, {
      firstPrompt: `Prompt for ${s.file}`,
      model: 'claude-3-sonnet',
      tools: ['Bash'],
      toolCounts: { Bash: 1 },
      chapters: 0,
      totalTokens: 100,
      inputTokens: 50,
      outputTokens: 50,
      cacheReadTokens: 0,
      durationMs: 1000,
      errors: 0,
      files: 0,
      commits: 0
    });
  }
  return index;
}

describe('browserPage output', () => {
  test('browserPage is deterministic when sessions and filter are unchanged', () => {
    const sessions = makeSessions(100);
    const index = makeIndex(sessions);
    const html1 = browserPage(sessions, index, null);
    const html2 = browserPage(sessions, index, null);
    assert.strictEqual(html1, html2);
  });

  test('browserPage output changes when sessions.length changes', () => {
    const sessions = makeSessions(10);
    const index = makeIndex(sessions);
    const html1 = browserPage(sessions, index, null);
    sessions.push({
      path: '/tmp/session-new.jsonl',
      source: 'claude',
      project: 'test-project',
      file: 'session-new.jsonl',
      size: 1024,
      mtime: new Date(Date.now() + 99999),
      title: 'New Session'
    });
    index.set(sessions[sessions.length - 1].path, {
      firstPrompt: 'New prompt',
      model: 'claude-3-sonnet',
      tools: [],
      toolCounts: {},
      chapters: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      durationMs: 0,
      errors: 0,
      files: 0,
      commits: 0
    });
    const html2 = browserPage(sessions, index, null);
    assert.notStrictEqual(html1, html2);
    assert.ok(html2.includes('session-new'));
  });

  test('browserPage output changes when initialFilter changes', () => {
    const sessions = makeSessions(50);
    const index = makeIndex(sessions);
    const html1 = browserPage(sessions, index, null);
    const html2 = browserPage(sessions, index, 'test');
    assert.notStrictEqual(html1, html2);
    assert.ok(html2.includes('test'));
  });

  test('browserPage output changes when session mtime changes', () => {
    const sessions = makeSessions(50);
    const index = makeIndex(sessions);
    const html1 = browserPage(sessions, index, null);
    sessions[0].mtime = new Date(Date.now() + 999999);
    const html2 = browserPage(sessions, index, null);
    assert.notStrictEqual(html1, html2);
  });

  test('browserPage output changes when a middle session mtime changes', () => {
    const sessions = makeSessions(50);
    const index = makeIndex(sessions);
    const html1 = browserPage(sessions, index, null);
    sessions[25].mtime = new Date(Date.now() + 888888);
    const html2 = browserPage(sessions, index, null);
    assert.notStrictEqual(html1, html2);
  });

  test('browserPage output changes when last session mtime changes', () => {
    const sessions = makeSessions(50);
    const index = makeIndex(sessions);
    const html1 = browserPage(sessions, index, null);
    sessions[sessions.length - 1].mtime = new Date(Date.now() + 999999);
    const html2 = browserPage(sessions, index, null);
    assert.notStrictEqual(html1, html2);
  });
});

describe('browserPageHTML constant head/tail split', () => {
  test('browserPageHTML reuses static shell; only filter and init script vary', () => {
    const scriptAnchor = 'var _INIT_DATA = ';
    const dataA = JSON.stringify({ sessions: [], total: 0, page: 1, pageSize: 50, stats: {} });
    const dataB = JSON.stringify({ sessions: [{ id: 'abc' }], total: 1, page: 1, pageSize: 50, stats: {} });
    const filter = 'myFilter';

    const htmlA = browserPageHTML(dataA, filter);
    const htmlB = browserPageHTML(dataB, filter);
    const shellA = htmlA.slice(0, htmlA.indexOf(scriptAnchor));
    const shellB = htmlB.slice(0, htmlB.indexOf(scriptAnchor));
    assert.equal(shellA, shellB, 'static HTML shell should match when filter is unchanged');

    const scriptA = htmlA.slice(htmlA.indexOf(scriptAnchor));
    const scriptB = htmlB.slice(htmlB.indexOf(scriptAnchor));
    assert.notEqual(scriptA, scriptB, 'embedded init script should reflect data payload');

    const htmlC = browserPageHTML(dataA, 'other-filter');
    const scriptC = htmlC.slice(htmlC.indexOf(scriptAnchor));
    assert.equal(scriptA, scriptC, 'script+tail should match when data is unchanged');
    assert.ok(shellA.includes('value="myFilter"'));
    assert.ok(htmlC.slice(0, htmlC.indexOf(scriptAnchor)).includes('value="other-filter"'));
  });

  test('browserPageHTML produces correct output with split constants', () => {
    const data = JSON.stringify([{ test: true }]);
    const filterVal = 'myFilter';
    const html = browserPageHTML(data, filterVal);
    assert.ok(html.startsWith('<!DOCTYPE html>'), 'output should start with <!DOCTYPE html>');
    assert.ok(html.includes('value="myFilter"'), 'output should contain filter value');
    assert.ok(html.includes('</html>'), 'output should contain </html>');
  });

  test('browserPageHTML embeds varying filter values', () => {
    const data = JSON.stringify([{ id: 's1', search: 'hello' }]);
    const html = browserPageHTML(data, 'my-filter');
    assert.ok(html.includes('value="my-filter"'));
  });
});