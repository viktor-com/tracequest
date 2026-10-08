import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Script, createContext } from 'node:vm';
import { buildSessionChapters } from '../src/chapters/session-chapters.js';
import { enrichChaptersForRender } from '../src/chapters/chapter-render-enrich.js';
import { CHAPTERS_JS } from '../src/render/render-chapters.js';
import { CHAPTERS_HELPERS_JS, UI_BUNDLE_PARTS } from '../src/render/render-assemble.js';
import { joinBundleParts } from '../src/render/join-bundle.js';
import { assertPerf } from "./helpers/perf-assert.js";

/** Packed bigram key matching enrichChaptersForRender _tokenBigrams storage. */
function tokenKey(q) {
  return (q.charCodeAt(0) << 16) | q.charCodeAt(1);
}

function hasChapterToken(ch, q) {
  if (q.length === 1) {
    const c = q.charCodeAt(0);
    if (c < 256) return !!(ch._charBits[c >>> 5] & (1 << (c & 31)));
    return ch._extraChars.has(q);
  }
  return ch._tokenBigrams.has(tokenKey(q));
}

function mockChapterTokens(tokens) {
  const charBits = new Uint32Array(8);
  const bigrams = new Set();
  const extraChars = new Set();
  for (const t of tokens) {
    for (let i = 0; i < t.length; i++) {
      const c = t.charCodeAt(i);
      if (c < 256) charBits[c >>> 5] |= 1 << (c & 31);
      else extraChars.add(t[i]);
      if (i + 1 < t.length) bigrams.add((c << 16) | t.charCodeAt(i + 1));
    }
  }
  return { _charBits: charBits, _tokenBigrams: bigrams, _extraChars: extraChars };
}

/** Same segments spliced into UI_JS before chapter list render (browser bundle slice). */
const BROWSER_CHAPTERS_VM_JS = joinBundleParts(
  UI_BUNDLE_PARTS.filter((p) => p.id === 'chapters-helpers' || p.id === 'chapters'),
);

function runBuildChaptersBrowserBundle(events, tail = 'buildChapters();') {
  const script = new Script(`
    const session = { startTime: '2026-01-01T00:00:00.000Z' };
    ${BROWSER_CHAPTERS_VM_JS}
    ${tail}
  `);
  return script.runInNewContext({ events, Object, Array, String, Math, Date, Set, Uint32Array });
}

function minimalChapterEvents() {
  return [
    { type: 'user', text: 'Fix auth module', timestamp: '2026-01-01T00:00:00.000Z' },
    {
      type: 'assistant',
      text: 'Reading auth file',
      timestamp: '2026-01-01T00:00:01.000Z',
      toolCalls: [{ id: 'tc1', name: 'Read', input: '/proj/src/auth.js' }],
    },
    { type: 'tool_result', toolUseId: 'tc1', text: 'ok', timestamp: '2026-01-01T00:00:02.000Z' },
  ];
}

function runBuildChapters(events) {
  const script = new Script(`
    const session = { startTime: '2026-01-01T00:00:00.000Z' };
    ${CHAPTERS_HELPERS_JS}
    ${CHAPTERS_JS}
    buildChapters();
  `);
  return script.runInNewContext({ events, Object, Array, String, Math, Date, Set, Uint32Array });
}

function enrichmentEvents() {
  return [
    { type: 'user', text: 'Fix MIXED Case', timestamp: '2026-01-01T00:00:00.000Z' },
    {
      type: 'assistant',
      text: 'Assistant MIXED Text',
      thinking: ['Think MIXED'],
      timestamp: '2026-01-01T00:00:01.000Z',
      toolCalls: [
        { id: 'tc1', name: 'Read', input: '/proj/src/FooBar.js' },
        { id: 'tc2', name: 'Bash', input: 'echo UPPER_CMD' },
        { id: 'tc3', name: 'Bash', input: 'git commit -m "MSG"' },
        { id: 'tc4', name: 'Grep', input: 'Search UPPER Query' },
        {
          id: 'tc5',
          name: 'Edit',
          input: '/proj/src/EditMe.js',
          diffInfo: { oldStr: 'OLD_STR', newStr: 'NEW_STR', content: 'DIFF_CONTENT' },
        },
        {
          id: 'tc6',
          name: 'WebSearch',
          input: '',
          webInfo: { type: 'search', url: 'https://EXAMPLE.com', query: 'Web QUERY' },
        },
        {
          id: 'tc7',
          name: 'Task',
          input: '',
          agentInfo: { description: 'Agent DESC', prompt: 'Agent PROMPT', subagentType: 'explore' },
        },
        {
          id: 'tc8',
          name: 'mcp_tool',
          input: '',
          mcpInfo: { server: 'MCP Server', tool: 'MCP Tool', rawName: 'mcp_tool', params: { key: 'Param VAL' } },
        },
      ],
    },
    { type: 'tool_result', toolUseId: 'tc1', text: 'file ok', timestamp: '2026-01-01T00:00:02.000Z' },
    { type: 'tool_result', toolUseId: 'tc2', text: 'CMD output UPPER', timestamp: '2026-01-01T00:00:03.000Z' },
    { type: 'tool_result', toolUseId: 'tc3', text: 'ok', timestamp: '2026-01-01T00:00:04.000Z' },
    { type: 'tool_result', toolUseId: 'tc4', text: 'match\\nline', timestamp: '2026-01-01T00:00:05.000Z' },
    { type: 'tool_result', toolUseId: 'tc5', text: 'edited', timestamp: '2026-01-01T00:00:06.000Z' },
    {
      type: 'tool_result',
      toolUseId: 'tc6',
      text: '{"title":"Result TITLE","url":"https://RESULT.com"}',
      timestamp: '2026-01-01T00:00:07.000Z',
    },
    { type: 'tool_result', toolUseId: 'tc7', text: 'agent done', timestamp: '2026-01-01T00:00:08.000Z' },
    { type: 'tool_result', toolUseId: 'tc8', text: 'mcp ok', timestamp: '2026-01-01T00:00:09.000Z' },
  ];
}

function runChapterMatchesFilter(ch, query, toolFilters = []) {
  const script = new Script(`
    ${CHAPTERS_HELPERS_JS}
    ${CHAPTERS_JS}
    activeToolFilters = new Set(${JSON.stringify(toolFilters)});
    searchQuery = ${JSON.stringify(query)};
    wasteFilterActive = false;
    chaptersCache = null;
    chapterMatchesFilter(ch);
  `);
  return script.runInNewContext({ ch, Date, Set, Object, Array, String, Uint32Array });
}

describe('render-chapters buildChapters VM (browser bundle)', () => {
  test('browser UI bundle slice runs chapter pipeline and filter entrypoints in one VM', () => {
    const result = runBuildChaptersBrowserBundle(minimalChapterEvents(), `
      searchQuery = 'auth';
      wasteFilterActive = false;
      activeToolFilters = new Set(['Read']);
      const raw = buildSessionChapters({ events, startTime: session.startTime });
      enrichChaptersEfficiency(raw);
      enrichChaptersForRender(raw);
      const viaBuild = buildChapters();
      const viaGet1 = getChapters();
      const viaGet2 = getChapters();
      ({
        rawLen: raw.length,
        rawPromptLower: raw[0]._promptLower,
        buildProducesChapter: viaBuild[0]._promptLower === 'fix auth module',
        getCaches: viaGet1 === viaGet2,
        filterMatch: chapterMatchesFilter(viaGet1[0]),
      });
    `);
    assert.equal(result.rawLen, 1);
    assert.equal(result.rawPromptLower, 'fix auth module');
    assert.equal(result.buildProducesChapter, true);
    assert.equal(result.getCaches, true);
    assert.equal(result.filterMatch, true);
  });

  test('buildChapters end-to-end on minimal session produces enriched chapter shape', () => {
    const chapters = runBuildChaptersBrowserBundle(minimalChapterEvents());
    assert.equal(chapters.length, 1);
    const ch = chapters[0];

    assert.equal(ch.prompt, 'Fix auth module');
    assert.equal(ch._promptLower, 'fix auth module');
    assert.equal(ch._lastAssistantTextLower, 'reading auth file');
    assert.deepEqual(ch._fileKeys, ['src/auth.js']);
    assert.deepEqual(ch._toolKeys, ['Read']);
    assert.deepEqual(ch._fileKeysLower, ['src/auth.js']);
    assert.ok(ch._charBits instanceof Uint32Array);
    assert.ok(ch._tokenBigrams instanceof Set);
    assert.ok(ch._tokenBigrams.size > 0);
    assert.ok(ch.deps);
    assert.ok(ch.efficiency);
    assert.ok(['clean', 'corrected', 'struggling'].includes(ch.outcome));
    assert.ok(chapters._depSummary);
    assert.equal(ch.toolCounts.Read, 1);
  });

  test('getChapters caches buildChapters result in browser bundle VM', () => {
    const result = runBuildChaptersBrowserBundle(minimalChapterEvents(), `
      const first = getChapters();
      const second = getChapters();
      ({ sameRef: first === second, len: first.length, promptLower: first[0]._promptLower, cached: chaptersCache !== null });
    `);
    assert.equal(result.sameRef, true);
    assert.equal(result.len, 1);
    assert.equal(result.promptLower, 'fix auth module');
    assert.equal(result.cached, true);
  });

  test('chapterMatchesFilter uses enrichment from buildChapters in same VM context', () => {
    const matched = runBuildChaptersBrowserBundle(minimalChapterEvents(), `
      const ch = buildChapters()[0];
      searchQuery = 'auth';
      wasteFilterActive = false;
      activeToolFilters = new Set(['Read']);
      chapterMatchesFilter(ch);
    `);
    assert.equal(matched, true);
  });
});

describe('render-chapters performance', () => {
  test('buildSessionChapters pre-caches _fileKeys before dependency analysis', () => {
    const events = [
      { type: 'user', text: 'read foo', timestamp: '2026-01-01T00:00:00.000Z' },
      {
        type: 'assistant',
        text: 'reading',
        toolCalls: [{ id: 'tc1', name: 'Read', input: '/proj/src/foo.js' }],
        timestamp: '2026-01-01T00:00:01.000Z',
      },
      { type: 'tool_result', toolUseId: 'tc1', text: 'ok', timestamp: '2026-01-01T00:00:02.000Z' },
    ];
    const chapters = buildSessionChapters({ events, startTime: '2026-01-01T00:00:00.000Z' });
    assert.equal(chapters.length, 1);
    assert.deepEqual(chapters[0]._fileKeys, ['src/foo.js']);
    assert.equal(chapters[0].deps, undefined);
    assert.equal(chapters[0]._fileKeysSet, undefined);
  });

  test('enrichChaptersForRender lazily caches _fileKeysSet and reuses across lookback', () => {
    const events = [
      { type: 'user', text: 'a', timestamp: '2026-01-01T00:00:00.000Z' },
      {
        type: 'assistant',
        text: 'read',
        toolCalls: [{ id: 't1', name: 'Read', input: '/p/shared.js' }],
        timestamp: '2026-01-01T00:00:01.000Z',
      },
      { type: 'tool_result', toolUseId: 't1', text: 'ok', timestamp: '2026-01-01T00:00:02.000Z' },
      { type: 'user', text: 'b', timestamp: '2026-01-01T00:00:03.000Z' },
      {
        type: 'assistant',
        text: 'read again',
        toolCalls: [{ id: 't2', name: 'Read', input: '/p/shared.js' }],
        timestamp: '2026-01-01T00:00:04.000Z',
      },
      { type: 'tool_result', toolUseId: 't2', text: 'ok', timestamp: '2026-01-01T00:00:05.000Z' },
    ];
    const chapters = buildSessionChapters({ events, startTime: '2026-01-01T00:00:00.000Z' });
    assert.equal(chapters[0]._fileKeysSet, undefined);
    enrichChaptersForRender(chapters);
    assert.deepEqual(chapters[0]._fileKeysSet, new Set(chapters[0]._fileKeys));
    const prevSet = chapters[0]._fileKeysSet;
    enrichChaptersForRender(chapters);
    assert.strictEqual(chapters[0]._fileKeysSet, prevSet);
    assert.ok(chapters[1].deps.continuesFrom.includes(0));
  });

  test('chapterMatchesFilter uses cached _fileKeys instead of Object.keys(ch.files) to avoid redundant enumeration per filter evaluation', () => {
    const events = [
      { type: 'user', text: 'read foo', timestamp: '2026-01-01T00:00:00.000Z' },
      {
        type: 'assistant',
        text: 'reading',
        toolCalls: [{ id: 'tc1', name: 'Read', input: '/proj/src/foo.js' }],
        timestamp: '2026-01-01T00:00:01.000Z',
      },
      { type: 'tool_result', toolUseId: 'tc1', text: 'ok', timestamp: '2026-01-01T00:00:02.000Z' },
    ];
    const chapters = runBuildChapters(events);
    const ch = chapters[0];

    assert.ok(runChapterMatchesFilter(ch, 'foo.js'), 'filter should match file path from enrichment');

    // Re-enumerating ch.files on each filter call would miss paths after files is cleared
    ch.files = {};
    assert.ok(
      runChapterMatchesFilter(ch, 'foo.js'),
      'filter should still match via cached _fileKeys/_fileKeysLower when ch.files is empty'
    );
    assert.notDeepEqual(ch._fileKeys, Object.keys(ch.files));
  });

  test('chapterMatchesFilter uses cached _toolKeys instead of Object.keys(ch.toolCounts) per filter evaluation', () => {
    const events = [
      { type: 'user', text: 'grep', timestamp: '2026-01-01T00:00:00.000Z' },
      {
        type: 'assistant',
        text: 'searching',
        toolCalls: [{ id: 'tc1', name: 'Grep', input: 'pattern foo' }],
        timestamp: '2026-01-01T00:00:01.000Z',
      },
      { type: 'tool_result', toolUseId: 'tc1', text: 'ok', timestamp: '2026-01-01T00:00:02.000Z' },
    ];
    const chapters = runBuildChapters(events);
    const ch = chapters[0];

    assert.ok(runChapterMatchesFilter(ch, '', ['Grep']), 'filter should match Grep from build');

    ch.toolCounts = {};
    assert.ok(
      runChapterMatchesFilter(ch, '', ['Grep']),
      'filter should still match via cached _toolKeys when toolCounts is cleared'
    );
    assert.notDeepEqual(ch._toolKeys, Object.keys(ch.toolCounts));
  });

  test('buildChapters pre-lowercases chapter fields in an enrichment pass for fast filter evaluation', () => {
    const chapters = runBuildChapters(enrichmentEvents());
    assert.equal(chapters.length, 1);
    const ch = chapters[0];

    assert.equal(ch._promptLower, 'fix mixed case');
    assert.equal(ch._lastAssistantTextLower, 'assistant mixed text');
    assert.deepEqual(ch._fileKeysLower, ['src/foobar.js', 'src/editme.js']);
    assert.deepEqual(Array.from(ch._thinkingLower), ['think mixed']);

    const cmd = ch.commands[0];
    assert.equal(cmd._cmdLower, 'echo upper_cmd');
    assert.equal(cmd._outputLower, 'cmd output upper');

    const search = ch.searches[0];
    assert.equal(search._queryLower, 'search upper query');

    const agent = ch.agents[0];
    assert.equal(agent._descriptionLower, 'agent desc');
    assert.equal(agent._promptLower, 'agent prompt');

    const diff = ch.diffs[0];
    assert.equal(diff._pathLower, 'src/editme.js');
    assert.equal(diff.diffInfo._oldStrLower, 'old_str');
    assert.equal(diff.diffInfo._newStrLower, 'new_str');
    assert.equal(diff.diffInfo._contentLower, 'diff_content');

    const git = ch.gitOps[0];
    assert.equal(git._messageLower, 'msg');
    assert.equal(git._branchLower, '');
    assert.equal(git._hashLower, '');
    assert.equal(git._cmdLower, 'git commit -m "msg"');

    const web = ch.webOps[0];
    assert.equal(web._urlLower, 'https://example.com');
    assert.equal(web._queryLower, 'web query');
    const result = web.results[0];
    assert.equal(result._titleLower, 'result title');
    assert.equal(result._urlLower, 'https://result.com');

    const mcp = ch.mcpOps[0];
    assert.equal(mcp._serverLower, 'mcp server');
    assert.equal(mcp._toolLower, 'mcp tool');
    assert.equal(mcp._rawNameLower, 'mcp_tool');
    assert.deepEqual([...mcp._paramValsLower], ['param val']);

    assert.ok(runChapterMatchesFilter(ch, 'mixed'), 'filter should match via pre-lowercased enrichment');
    assert.ok(runChapterMatchesFilter(ch, 'upper_cmd'), 'filter should match command via _cmdLower');
    assert.ok(runChapterMatchesFilter(ch, 'agent desc'), 'filter should match agent via _descriptionLower');
    assert.ok(runChapterMatchesFilter(ch, 'mcp server'), 'filter should match mcp via _serverLower');
  });

  test('chapterMatchesFilter uses pre-lowercased fields only (not live chapter text) during search', () => {
    const chapters = runBuildChapters(enrichmentEvents());
    const ch = chapters[0];

    ch.prompt = 'SHOULD_NOT_MATCH';
    ch.lastAssistantText = 'SHOULD_NOT_MATCH';
    for (const cmd of ch.commands) {
      cmd.cmd = 'SHOULD_NOT_MATCH';
      cmd.output = 'SHOULD_NOT_MATCH';
    }
    ch.thinking = ['SHOULD_NOT_MATCH'];

    assert.ok(runChapterMatchesFilter(ch, 'mixed'), 'should match cached _promptLower after prompt cleared');
    assert.ok(runChapterMatchesFilter(ch, 'upper_cmd'), 'should match cached _cmdLower after cmd cleared');
    assert.ok(!runChapterMatchesFilter(ch, 'should_not_match'), 'should not fall back to cleared source fields');
  });

  test('buildChapters creates token bitmap per chapter with 1-char and 2-char substrings for early-exit filtering', () => {
    const chapters = runBuildChapters(enrichmentEvents());
    const ch = chapters[0];

    assert.ok(ch._charBits instanceof Uint32Array, '_charBits should be a Uint32Array');
    assert.ok(ch._tokenBigrams.size > 0, '_tokenBigrams should contain tokens from enriched fields');
    assert.ok(hasChapterToken(ch, 'fi'), 'should index 2-char substrings from _promptLower');
    assert.ok(hasChapterToken(ch, 'ix'), 'should index 2-char substrings from _promptLower');
    assert.ok(hasChapterToken(ch, 'mi'), 'should index substrings from assistant text');
    assert.ok(hasChapterToken(ch, 'ed'), 'should index substrings from file paths');

    assert.ok(runChapterMatchesFilter(ch, 'mi'), 'short query present in index should match');
    assert.ok(!runChapterMatchesFilter(ch, 'zz'), 'short query absent from index should not match');
  });

  test('chapterMatchesFilter reuses cached searchQueryLower across chapters (no per-chapter toLowerCase)', () => {
    const chapters = [];
    for (let i = 0; i < 400; i++) {
      chapters.push({
        toolCounts: { Read: 1 },
        _toolKeys: ['Read'],
        efficiency: null,
        commands: [{ _cmdLower: 'npm test', _outputLower: 'ok' }],
        searches: [],
        agents: [],
        diffs: [],
        gitOps: [],
        webOps: [],
        mcpOps: [],
        ...mockChapterTokens(['au', 'th']),
        _promptLower: 'fix authmodule ' + i,
        _lastAssistantTextLower: 'assistant done',
        _fileKeysLower: ['src/foobar.js'],
        _thinkingLower: ['plan'],
      });
    }
    const ctx = createContext({ chapters, Set, Object, Array, String, Uint32Array });
    new Script(`
      ${CHAPTERS_JS}
      function runChapterFilterBatch() {
        searchQuery = 'authmod';
        let visible = 0;
        for (let i = 0; i < chapters.length; i++) {
          if (chapterMatchesFilter(chapters[i])) visible++;
        }
        return visible;
      }
    `).runInContext(ctx);
    const ITERS = 120;
    const t0 = performance.now();
    for (let i = 0; i < ITERS; i++) {
      const visible = new Script('runChapterFilterBatch();').runInContext(ctx);
      assert.ok(visible > 0);
    }
    const ms = (performance.now() - t0) / ITERS;
    assertPerf(
      ms < 0.2,
      `expected chapterMatchesFilter x400 under 0.2ms/op with cached searchQueryLower, got ${ms.toFixed(3)}ms`,
    );
  });

  test('chapterMatchesFilter re-lowercases searchQuery only when query string changes', () => {
    const chapters = [];
    for (let i = 0; i < 50; i++) {
      chapters.push({
        toolCounts: { Read: 1 },
        _toolKeys: ['Read'],
        efficiency: null,
        commands: [],
        searches: [],
        agents: [],
        diffs: [],
        gitOps: [],
        webOps: [],
        mcpOps: [],
        ...mockChapterTokens(['au', 'th']),
        _promptLower: 'fix authmodule ' + i,
        _lastAssistantTextLower: 'assistant done',
        _fileKeysLower: ['src/foobar.js'],
        _thinkingLower: ['plan'],
      });
    }
    const instrumentedChaptersJs = CHAPTERS_JS.replace(
      '_searchQueryLowerCache = searchQuery.toLowerCase();',
      '_searchQueryLowerCache = searchQuery.toLowerCase(); __searchLowerCalls++;',
    );
    const script = new Script(`
      let __searchLowerCalls = 0;
      ${instrumentedChaptersJs}
      function runBatch(q) {
        __searchLowerCalls = 0;
        searchQuery = q;
        let matches = 0;
        for (let i = 0; i < chapters.length; i++) {
          if (chapterMatchesFilter(chapters[i])) matches++;
        }
        return { calls: __searchLowerCalls, matches };
      }
      const first = runBatch('AUTHMOD');
      const second = runBatch('AUTHMOD');
      const third = runBatch('nomatch');
      ({ first, second, third });
    `);
    const result = script.runInNewContext({ chapters, Set, Object, Array, String, Uint32Array });
    assert.equal(result.first.calls, 1);
    assert.ok(result.first.matches > 0);
    assert.equal(result.second.calls, 0);
    assert.ok(result.second.matches > 0);
    assert.equal(result.third.calls, 1);
    assert.equal(result.third.matches, 0);
  });
});
