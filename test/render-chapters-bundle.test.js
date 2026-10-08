import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import {
  buildChaptersHelpersScript,
  CHAPTERS_BUNDLE_FUNCTION_NAMES,
  CHAPTERS_HELPERS_JS,
} from '../src/render/render-assemble.js';
import {
  safeSlice,
  countWords,
  joinFirstLines,
  shortToolPath,
  FIRST_PROMPT_MAX_LEN,
} from '../src/parse/parse-utils.js';
import { detectGitOp } from '../src/utils/git-op.js';
import { buildSessionChapters } from '../src/chapters/session-chapters.js';
import { enrichChaptersEfficiency } from '../src/chapters/chapter-quality.js';
import { enrichChaptersForRender } from '../src/chapters/chapter-render-enrich.js';
import { CORRECTION_HINT_RE } from '../src/chapters/chapter-patterns.js';

const VM_CTX = { Object, Array, String, Math, Date, Set, Uint32Array };

/** Count top-level `function name` declarations in a script string. */
function countFunctionDef(src, name) {
  const re = new RegExp(`function ${name}\\b`, 'g');
  return (src.match(re) || []).length;
}

function runBundleVm(body, extraCtx = {}) {
  const script = new Script(`${CHAPTERS_HELPERS_JS}\n${body}`);
  return script.runInNewContext({ ...VM_CTX, ...extraCtx });
}

describe('render-chapters-bundle', () => {
  test('buildChaptersHelpersScript is deterministic and matches CHAPTERS_HELPERS_JS', () => {
    const a = buildChaptersHelpersScript();
    const b = buildChaptersHelpersScript();
    assert.equal(a, b, 'repeated buildChaptersHelpersScript should be deterministic');
    assert.equal(a, CHAPTERS_HELPERS_JS, 'CHAPTERS_HELPERS_JS should match buildChaptersHelpersScript()');
    assert.ok(a.length > 5000, 'assembled chapter helpers should be substantial');
  });

  test('CHAPTERS_HELPERS_JS is browser-safe (no ESM export tokens)', () => {
    assert.ok(!CHAPTERS_HELPERS_JS.includes('export function'), 'bundle must not contain export function');
    assert.ok(!CHAPTERS_HELPERS_JS.includes('export const'), 'bundle must not contain export const');
    assert.doesNotThrow(() => new Script(CHAPTERS_HELPERS_JS), 'bundle should parse as plain script');
  });

  test('each chapter helper is defined exactly once in CHAPTERS_HELPERS_JS', () => {
    for (const name of CHAPTERS_BUNDLE_FUNCTION_NAMES) {
      assert.equal(
        countFunctionDef(CHAPTERS_HELPERS_JS, name),
        1,
        `function ${name} should be defined exactly once in CHAPTERS_HELPERS_JS`,
      );
    }
  });

  test('injected parse-utils helpers match module exports in VM', () => {
    const text = 'hello world';
    const multiline = 'alpha\nbeta\ngamma';
    const pathInput = '/home/user/proj/src/auth.js';

    const vm = runBundleVm(`({
      slice: safeSlice(${JSON.stringify(text)}, 5),
      words: countWords(${JSON.stringify(text)}),
      joined: joinFirstLines(${JSON.stringify(multiline)}, 2),
      path: shortToolPath(${JSON.stringify(pathInput)}),
      maxLen: FIRST_PROMPT_MAX_LEN,
    });`);

    assert.equal(vm.slice, safeSlice(text, 5));
    assert.equal(vm.words, countWords(text));
    assert.equal(vm.joined, joinFirstLines(multiline, 2));
    assert.equal(vm.path, shortToolPath(pathInput));
    assert.equal(vm.maxLen, FIRST_PROMPT_MAX_LEN);
  });

  test('injected detectGitOp matches module on commit and push commands', () => {
    const commitCmd = 'git commit -m "docs: update README"';
    const pushCmd = 'git push origin main';

    const vm = runBundleVm(`({
      commit: detectGitOp(${JSON.stringify(commitCmd)}),
      push: detectGitOp(${JSON.stringify(pushCmd)}),
    });`);

    const nodeCommit = detectGitOp(commitCmd);
    const nodePush = detectGitOp(pushCmd);
    assert.equal(vm.commit.type, nodeCommit.type);
    assert.equal(vm.commit.message, nodeCommit.message);
    assert.equal(vm.commit.cmd, nodeCommit.cmd);
    assert.equal(vm.push.type, nodePush.type);
    assert.equal(vm.push.remote, nodePush.remote);
    assert.equal(vm.commit.type, 'commit');
    assert.equal(vm.push.type, 'push');
  });

  test('injected CORRECTION_HINT_RE flags corrective prompts in full bundle VM', () => {
    const vm = runBundleVm(`({
      undo: CORRECTION_HINT_RE.test('No, undo that'),
      benign: CORRECTION_HINT_RE.test('please fix the tests'),
    });`);
    assert.equal(vm.undo, CORRECTION_HINT_RE.test('No, undo that'));
    assert.equal(vm.benign, CORRECTION_HINT_RE.test('please fix the tests'));
    assert.equal(vm.undo, true);
    assert.equal(vm.benign, false);
  });

  test('full CHAPTERS_HELPERS_JS pipeline matches module chapter build from events', () => {
    const events = [
      { type: 'user', text: 'Ship auth fix', timestamp: '2026-01-01T00:00:00.000Z' },
      {
        type: 'assistant',
        text: 'Committing docs',
        timestamp: '2026-01-01T00:00:01.000Z',
        toolCalls: [
          { id: 'tc1', name: 'Read', input: '/proj/src/auth.js' },
          { id: 'tc2', name: 'Bash', input: 'git commit -m "auth: tighten guard"' },
        ],
      },
      { type: 'tool_result', toolUseId: 'tc1', text: 'ok', timestamp: '2026-01-01T00:00:02.000Z' },
      { type: 'tool_result', toolUseId: 'tc2', text: '[main abc] auth: tighten guard\n', timestamp: '2026-01-01T00:00:03.000Z' },
    ];

    const vm = runBundleVm(
      `(() => {
        const session = { startTime: '2026-01-01T00:00:00.000Z' };
        let chapters = buildSessionChapters({ events, startTime: session.startTime });
        enrichChaptersEfficiency(chapters);
        enrichChaptersForRender(chapters);
        const ch = chapters[0];
        return {
          len: chapters.length,
          promptLower: ch._promptLower,
          fileKeys: ch._fileKeys,
          gitType: ch.gitOps[0]?.type,
          gitMessage: ch.gitOps[0]?.message,
          outcome: ch.outcome,
          hasEfficiency: ch.efficiency != null,
          hasDeps: ch.deps != null,
        };
      })();`,
      { events },
    );

    let chapters = buildSessionChapters({ events, startTime: '2026-01-01T00:00:00.000Z' });
    enrichChaptersEfficiency(chapters);
    enrichChaptersForRender(chapters);
    const ch = chapters[0];

    assert.equal(vm.len, 1);
    assert.equal(vm.promptLower, ch._promptLower);
    assert.deepEqual(vm.fileKeys, ch._fileKeys);
    assert.equal(vm.gitType, ch.gitOps[0]?.type);
    assert.equal(vm.gitMessage, ch.gitOps[0]?.message);
    assert.equal(vm.outcome, ch.outcome);
    assert.equal(vm.hasEfficiency, ch.efficiency != null);
    assert.equal(vm.hasDeps, ch.deps != null);
    assert.equal(vm.gitType, 'commit');
    assert.equal(vm.gitMessage, 'auth: tighten guard');
  });
});