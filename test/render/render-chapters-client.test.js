import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { chapterToolKeys } from '../../src/chapters/chapter-keys.js';
import { CHAPTERS_CLIENT_JS } from '../../src/render/render-chapters-client.js';
import { CHAPTERS_JS } from '../../src/render/render-chapters.js';
import { RENDER_JS } from '../../src/render/render-assemble.js';

const CHAPTER_TOOL_KEYS_SRC = chapterToolKeys.toString().replace(/^export /, '');

function countFunctionDef(src, name) {
  const re = new RegExp(`function ${name}\\b`, 'g');
  return (src.match(re) || []).length;
}

/** Packed bigram key matching enrichChaptersForRender _tokenBigrams storage. */
function tokenKey(q) {
  return (q.charCodeAt(0) << 16) | q.charCodeAt(1);
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

function emptyChapterTokens() {
  return {
    _charBits: new Uint32Array(8),
    _tokenBigrams: new Set(),
    _extraChars: new Set(),
  };
}

function makeEnrichedChapter(overrides = {}) {
  const { toolCounts: toolCountsOverride, _toolKeys: toolKeysOverride, ...rest } = overrides;
  const toolCounts = toolCountsOverride ?? { Read: 1, Bash: 1 };
  return {
    toolCounts,
    _toolKeys: toolKeysOverride ?? Object.keys(toolCounts),
    efficiency: null,
    commands: [],
    searches: [],
    agents: [],
    diffs: [],
    gitOps: [],
    webOps: [],
    mcpOps: [],
    ...mockChapterTokens([
      'fi', 'ix', 'au', 'ut', 'th', 'do', 'ne', 'ba', 'sh', 'fo', 'o.', 'js',
      'zz', 'mi', 'ed', 'ol', 'ne', 'ws', 'tr', 'ag', 'mc', 'gi', 'we',
    ]),
    _promptLower: 'fix auth module',
    _lastAssistantTextLower: 'assistant done',
    _fileKeysLower: ['src/foobar.js'],
    _thinkingLower: ['plan the refactor'],
    ...rest,
  };
}

function runChapterMatchesFilter(opts = {}) {
  const {
    ch,
    wasteFilterActive = false,
    activeToolFilters = [],
    searchQuery = '',
  } = opts;
  const script = new Script(`
    ${CHAPTER_TOOL_KEYS_SRC}
    ${CHAPTERS_CLIENT_JS}
    wasteFilterActive = ${wasteFilterActive};
    activeToolFilters = new Set(${JSON.stringify(activeToolFilters)});
    searchQuery = ${JSON.stringify(searchQuery)};
    chapterMatchesFilter(ch);
  `);
  return script.runInNewContext({ ch, Set, Object, Array, String, Uint32Array });
}

function runFilterStateMutation(body) {
  const ctx = { Set, Object, Array, String, Uint32Array, __log: [] };
  const script = new Script(`
    ${CHAPTER_TOOL_KEYS_SRC}
    ${CHAPTERS_CLIENT_JS}
    ${body}
  `);
  script.runInNewContext(ctx);
  return ctx;
}

describe('render-chapters-client VM', () => {
  test('chapterMatchesFilter returns true with default filter state', () => {
    const ch = makeEnrichedChapter();
    assert.equal(runChapterMatchesFilter({ ch }), true);
  });

  test('wasteFilterActive requires efficiency.isWasteful', () => {
    const wasteful = makeEnrichedChapter({
      efficiency: { isWasteful: true },
    });
    const clean = makeEnrichedChapter({
      efficiency: { isWasteful: false },
    });
    const missing = makeEnrichedChapter({ efficiency: null });

    assert.equal(runChapterMatchesFilter({ ch: wasteful, wasteFilterActive: true }), true);
    assert.equal(runChapterMatchesFilter({ ch: clean, wasteFilterActive: true }), false);
    assert.equal(runChapterMatchesFilter({ ch: missing, wasteFilterActive: true }), false);
  });

  test('activeToolFilters matches when chapter toolCounts intersects', () => {
    const ch = makeEnrichedChapter({ toolCounts: { Read: 2, Grep: 1 } });
    assert.equal(runChapterMatchesFilter({ ch, activeToolFilters: ['Read'] }), true);
    assert.equal(runChapterMatchesFilter({ ch, activeToolFilters: ['Grep'] }), true);
    assert.equal(runChapterMatchesFilter({ ch, activeToolFilters: ['Bash'] }), false);
  });

  test('activeToolFilters uses OR across multiple selected tools', () => {
    const ch = makeEnrichedChapter({ toolCounts: { Edit: 1 } });
    assert.equal(
      runChapterMatchesFilter({ ch, activeToolFilters: ['Read', 'Edit'] }),
      true
    );
    assert.equal(
      runChapterMatchesFilter({ ch, activeToolFilters: ['Read', 'Bash'] }),
      false
    );
  });

  test('searchQuery matches _promptLower without reading live prompt', () => {
    const ch = makeEnrichedChapter({ _promptLower: 'cached prompt text' });
    ch.prompt = 'SHOULD_NOT_MATCH';
    assert.equal(runChapterMatchesFilter({ ch, searchQuery: 'cached' }), true);
    assert.equal(runChapterMatchesFilter({ ch, searchQuery: 'should_not' }), false);
  });

  test('searchQuery matches _lastAssistantTextLower', () => {
    const ch = makeEnrichedChapter({ _lastAssistantTextLower: 'wrote tests' });
    assert.equal(runChapterMatchesFilter({ ch, searchQuery: 'tests' }), true);
    assert.equal(runChapterMatchesFilter({ ch, searchQuery: 'missing' }), false);
  });

  test('searchQuery short-circuits on token bitmap for queries length <= 2', () => {
    const ch = makeEnrichedChapter({
      ...mockChapterTokens(['ab', 'cd']),
      _promptLower: 'abcdef',
    });
    assert.equal(runChapterMatchesFilter({ ch, searchQuery: 'ab' }), true);
    assert.equal(runChapterMatchesFilter({ ch, searchQuery: 'zz' }), false);
  });

  test('searchQuery length 3+ skips token index early-exit', () => {
    const ch = makeEnrichedChapter({
      ...emptyChapterTokens(),
      _promptLower: 'uniquephrase',
    });
    assert.equal(runChapterMatchesFilter({ ch, searchQuery: 'phrase' }), true);
  });

  test('searchQuery matches commands via _cmdLower and _outputLower', () => {
    const ch = makeEnrichedChapter({
      commands: [
        { _cmdLower: 'npm test', _outputLower: 'all passed' },
        { _cmdLower: 'git status', _outputLower: '' },
      ],
    });
    assert.equal(runChapterMatchesFilter({ ch, searchQuery: 'npm' }), true);
    assert.equal(runChapterMatchesFilter({ ch, searchQuery: 'passed' }), true);
    assert.equal(runChapterMatchesFilter({ ch, searchQuery: 'status' }), true);
    assert.equal(runChapterMatchesFilter({ ch, searchQuery: 'missing' }), false);
  });

  test('searchQuery matches _fileKeysLower paths', () => {
    const ch = makeEnrichedChapter({
      _fileKeysLower: ['lib/utils/helper.ts', 'readme.md'],
    });
    assert.equal(runChapterMatchesFilter({ ch, searchQuery: 'helper.ts' }), true);
    assert.equal(runChapterMatchesFilter({ ch, searchQuery: 'readme' }), true);
    assert.equal(runChapterMatchesFilter({ ch, searchQuery: 'nowhere' }), false);
  });

  test('searchQuery matches searches, agents, diffs, git, web, mcp, and thinking', () => {
    const ch = makeEnrichedChapter({
      searches: [{ _queryLower: 'grep pattern' }],
      agents: [{ _descriptionLower: 'explore agent', _promptLower: 'find usages' }],
      diffs: [{
        _pathLower: 'src/edit.js',
        diffInfo: {
          _oldStr: 'old line',
          _newStr: 'new line',
          _content: 'diff body',
          _oldStrLower: 'old line',
          _newStrLower: 'new line',
          _contentLower: 'diff body',
        },
      }],
      gitOps: [{
        _messageLower: 'fix bug',
        _branchLower: 'main',
        _hashLower: 'abc123',
        _cmdLower: 'git commit',
      }],
      webOps: [{
        _urlLower: 'https://example.com',
        _queryLower: 'web search term',
        _pageTitleLower: 'example page',
        results: [{ _titleLower: 'result title', _urlLower: 'https://result.io' }],
      }],
      mcpOps: [{
        _serverLower: 'myserver',
        _toolLower: 'search',
        _rawNameLower: 'mcp_search',
        _paramValsLower: ['paramvalue'],
      }],
      _thinkingLower: ['reason about edge cases'],
    });

    assert.equal(runChapterMatchesFilter({ ch, searchQuery: 'pattern' }), true);
    assert.equal(runChapterMatchesFilter({ ch, searchQuery: 'explore' }), true);
    assert.equal(runChapterMatchesFilter({ ch, searchQuery: 'usages' }), true);
    assert.equal(runChapterMatchesFilter({ ch, searchQuery: 'old line' }), true);
    assert.equal(runChapterMatchesFilter({ ch, searchQuery: 'diff body' }), true);
    assert.equal(runChapterMatchesFilter({ ch, searchQuery: 'fix bug' }), true);
    assert.equal(runChapterMatchesFilter({ ch, searchQuery: 'abc123' }), true);
    assert.equal(runChapterMatchesFilter({ ch, searchQuery: 'web search' }), true);
    assert.equal(runChapterMatchesFilter({ ch, searchQuery: 'result title' }), true);
    assert.equal(runChapterMatchesFilter({ ch, searchQuery: 'myserver' }), true);
    assert.equal(runChapterMatchesFilter({ ch, searchQuery: 'paramvalue' }), true);
    assert.equal(runChapterMatchesFilter({ ch, searchQuery: 'edge cases' }), true);
  });

  test('searchQuery handles optional git/web/diff fields without throwing', () => {
    const ch = makeEnrichedChapter({
      diffs: [{
        _pathLower: 'x.js',
        diffInfo: { _oldStr: null, _newStr: null, _content: null },
      }],
      gitOps: [{ _messageLower: '', _branchLower: '', _hashLower: '', _cmdLower: '' }],
      webOps: [{ _urlLower: 'u', _queryLower: 'q', _pageTitleLower: 't' }],
    });
    assert.equal(runChapterMatchesFilter({ ch, searchQuery: 'x.js' }), true);
    assert.equal(runChapterMatchesFilter({ ch, searchQuery: 'ghost' }), false);
  });

  test('combined waste, tool, and search filters require all predicates', () => {
    const ch = makeEnrichedChapter({
      efficiency: { isWasteful: true },
      toolCounts: { Bash: 1 },
      _promptLower: 'waste bash chapter',
    });
    assert.equal(
      runChapterMatchesFilter({
        ch,
        wasteFilterActive: true,
        activeToolFilters: ['Bash'],
        searchQuery: 'waste',
      }),
      true
    );
    assert.equal(
      runChapterMatchesFilter({
        ch,
        wasteFilterActive: true,
        activeToolFilters: ['Read'],
        searchQuery: 'waste',
      }),
      false
    );
    assert.equal(
      runChapterMatchesFilter({
        ch,
        wasteFilterActive: false,
        activeToolFilters: ['Bash'],
        searchQuery: 'nomatch',
      }),
      false
    );
  });

  test('filter state variables are independent per VM context', () => {
    const ctxA = runFilterStateMutation(`
      activeToolFilters.add('Read');
      searchQuery = 'alpha';
      wasteFilterActive = true;
      __log.push(activeToolFilters.size, searchQuery, wasteFilterActive);
    `);
    const ctxB = runFilterStateMutation(`
      __log.push(activeToolFilters.size, searchQuery, wasteFilterActive);
    `);
    assert.deepEqual(ctxA.__log, [1, 'alpha', true]);
    assert.deepEqual(ctxB.__log, [0, '', false]);
  });

  test('activeToolFilters Set can be cleared and repopulated in same context', () => {
    const ctx = runFilterStateMutation(`
      activeToolFilters.add('Read');
      activeToolFilters.add('Bash');
      const before = activeToolFilters.size;
      activeToolFilters.clear();
      activeToolFilters.add('Grep');
      __log.push(before, activeToolFilters.size, activeToolFilters.has('Grep'), activeToolFilters.has('Read'));
    `);
    assert.deepEqual(ctx.__log, [2, 1, true, false]);
  });

  test('searchQuery empty string does not block match when other filters pass', () => {
    const ch = makeEnrichedChapter({ toolCounts: { Read: 1 } });
    assert.equal(
      runChapterMatchesFilter({ ch, activeToolFilters: ['Read'], searchQuery: '' }),
      true
    );
  });
});

describe('render-chapters-client assembly contract', () => {
  test('CHAPTERS_JS runs chapterMatchesFilter with tool and waste filters', () => {
    const ch = makeEnrichedChapter({
      efficiency: { isWasteful: true },
      toolCounts: { Bash: 1 },
      _promptLower: 'waste bash',
    });
    const script = new Script(`
      ${CHAPTER_TOOL_KEYS_SRC}
      ${CHAPTERS_JS}
      wasteFilterActive = true;
      activeToolFilters = new Set(['Bash']);
      searchQuery = 'waste';
      chapterMatchesFilter(ch);
    `);
    assert.equal(script.runInNewContext({ ch, Set, Object, Array, String, Uint32Array }), true);
  });

  test('CHAPTERS_JS short-query bitmap rejects non-indexed bigrams', () => {
    const ch = makeEnrichedChapter({
      ...emptyChapterTokens(),
      _promptLower: 'unrelated text',
    });
    const script = new Script(`
      ${CHAPTER_TOOL_KEYS_SRC}
      ${CHAPTERS_JS}
      searchQuery = 'zz';
      chapterMatchesFilter(ch);
    `);
    assert.equal(script.runInNewContext({ ch, Set, Object, Array, String, Uint32Array }), false);
  });

  test('RENDER_JS defines chapterMatchesFilter exactly once via CHAPTERS_JS splice', () => {
    assert.equal(
      countFunctionDef(RENDER_JS, 'chapterMatchesFilter'),
      1,
      'assembled viewer bundle should define chapterMatchesFilter once',
    );
  });

  test('filter state defaults are fresh per CHAPTERS_JS VM context', () => {
    const script = new Script(`
      ${CHAPTER_TOOL_KEYS_SRC}
      ${CHAPTERS_JS}
      ({
        toolSize: activeToolFilters.size,
        search: searchQuery,
        waste: wasteFilterActive,
      })
    `);
    const defaults = script.runInNewContext({ Set, Object, Array, String, Uint32Array });
    assert.equal(defaults.toolSize, 0);
    assert.equal(defaults.search, '');
    assert.equal(defaults.waste, false);
  });
});