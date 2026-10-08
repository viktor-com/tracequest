import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  rollupClaudeUsage,
  safeSlice,
  capContent,
  setContentTruncation,
  isContentTruncationEnabled,
  truncateFirstPrompt,
  FIRST_PROMPT_MAX_LEN,
  shortToolPath,
  parseEscapedJsonString,
  parseToolArgs,
  parseWebSearchLinks,
  countWords,
  countWordsInStrings,
  sumToolCounts,
  joinFirstLines,
  includesLower,
  indexOfLower,
  INDEX_OF_LOWER_JS,
} from "../../src/parse/parse-utils.js";
import { normalizeToolName } from "../../src/parse/parse-enrich.js";
import { buildSession } from "../../src/parse/parse-session-build.js";

describe("rollupClaudeUsage", () => {
  test("rolls base + cache read + cache creation into input", () => {
    const rolled = rollupClaudeUsage({
      input_tokens: 100,
      output_tokens: 40,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 20,
    });
    assert.deepEqual(rolled, {
      input: 150,
      output: 40,
      cacheHit: 30,
      cacheWrite: 20,
    });
  });

  test("defaults missing usage object to zeros", () => {
    assert.deepEqual(rollupClaudeUsage(), {
      input: 0,
      output: 0,
      cacheHit: 0,
      cacheWrite: 0,
    });
    assert.deepEqual(rollupClaudeUsage({}), {
      input: 0,
      output: 0,
      cacheHit: 0,
      cacheWrite: 0,
    });
  });

  test("sums output_tokens only when caches absent", () => {
    assert.deepEqual(rollupClaudeUsage({ input_tokens: 512, output_tokens: 64 }), {
      input: 512,
      output: 64,
      cacheHit: 0,
      cacheWrite: 0,
    });
  });

  test("cache-only usage still contributes to input rollup", () => {
    assert.deepEqual(
      rollupClaudeUsage({
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 100,
      }),
      { input: 1000, output: 0, cacheHit: 900, cacheWrite: 100 },
    );
  });
});

describe("normalizeToolName", () => {
  test("maps shell execution variants to Bash", () => {
    for (const name of ["bash", "shell", "execute", "run_terminal_command", "write_stdin"]) {
      assert.equal(normalizeToolName(name), "Bash");
    }
  });

  test("maps read/write/edit and patch variants", () => {
    assert.equal(normalizeToolName("read_file"), "Read");
    assert.equal(normalizeToolName("write"), "Write");
    assert.equal(normalizeToolName("apply_patch"), "Edit");
    assert.equal(normalizeToolName("search_replace"), "Edit");
  });

  test("preserves MCP tool names verbatim", () => {
    assert.equal(normalizeToolName("mcp__server__tool"), "mcp__server__tool");
    assert.equal(normalizeToolName("mcp__org_srv__do_thing"), "mcp__org_srv__do_thing");
  });

  test("returns unknown for falsy names", () => {
    assert.equal(normalizeToolName(null), "unknown");
    assert.equal(normalizeToolName(undefined), "unknown");
    assert.equal(normalizeToolName(""), "unknown");
  });

  test("capitalizes unrecognized tools", () => {
    assert.equal(normalizeToolName("unknowncmd"), "Unknowncmd");
    assert.equal(normalizeToolName("FooBar"), "FooBar");
  });

  test("maps web and agent aliases", () => {
    assert.equal(normalizeToolName("web_search"), "WebSearch");
    assert.equal(normalizeToolName("webfetch"), "WebFetch");
    assert.equal(normalizeToolName("dispatch_agent"), "Agent");
    assert.equal(normalizeToolName("taskcreate"), "Agent");
  });
});

describe("buildSession smoke", () => {
  test("assembles session metadata, timing, and stats", () => {
    const events = [
      { type: "user", timestamp: "2026-01-01T10:00:00Z", text: "hi" },
      {
        type: "assistant",
        timestamp: "2026-01-01T10:01:00Z",
        text: "hello",
        toolCalls: [{ id: "1", name: "Read", input: "/f" }],
        tokens: { input: 10, output: 5, cacheHit: 2, cacheWrite: 1 },
      },
      { type: "tool_result", timestamp: "2026-01-01T10:01:05Z", toolUseId: "1", text: "ok", isError: false },
    ];
    const session = buildSession({
      sessionId: "s1",
      cwd: "/proj",
      model: "claude-sonnet",
      gitBranch: "main",
      events,
      source: "claude",
    });
    assert.equal(session.sessionId, "s1");
    assert.equal(session.source, "claude");
    assert.equal(session.eventCount, 3);
    assert.equal(session.durationMs, 65000);
    assert.equal(session.stats.userMessages, 1);
    assert.equal(session.stats.assistantTurns, 1);
    assert.equal(session.stats.totalInputTokens, 10);
    assert.equal(session.stats.totalOutputTokens, 5);
    assert.equal(session.stats.totalCacheHit, 2);
    assert.equal(session.stats.toolCounts.Read, 1);
  });

  test("empty events yield null timing and zero stats", () => {
    const session = buildSession({
      sessionId: "empty",
      cwd: null,
      model: null,
      gitBranch: null,
      events: [],
      source: "factory",
    });
    assert.equal(session.eventCount, 0);
    assert.equal(session.durationMs, 0);
    assert.equal(session.startTime, null);
    assert.equal(session.stats.userMessages, 0);
    assert.equal(session.stats.assistantTurns, 0);
  });

  test("stats reflect rollupClaudeUsage-shaped assistant tokens", () => {
    const tokens = rollupClaudeUsage({
      input_tokens: 50,
      output_tokens: 10,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 5,
    });
    const session = buildSession({
      sessionId: "tok",
      cwd: "/",
      model: "m",
      gitBranch: null,
      events: [
        { type: "assistant", timestamp: "2026-06-03T12:00:00.000Z", text: "x", toolCalls: [], tokens },
      ],
      source: "claude",
    });
    assert.equal(session.stats.totalInputTokens, 60);
    assert.equal(session.stats.totalOutputTokens, 10);
    assert.equal(session.stats.totalCacheHit, 5);
  });
});

describe("parse-utils helpers", () => {
  test("safeSlice preserves surrogate pairs at boundary", () => {
    const emoji = "hello 🌍 end";
    assert.equal(safeSlice(emoji, 100), emoji);
    const cut = safeSlice(emoji, 8);
    assert.ok(!cut.endsWith("\uD83C"), "must not end on high surrogate");
    assert.equal(safeSlice(null, 5), "");
  });

  test("truncateFirstPrompt caps at FIRST_PROMPT_MAX_LEN via safeSlice", () => {
    assert.equal(FIRST_PROMPT_MAX_LEN, 200);
    const long = "x".repeat(250);
    assert.equal(truncateFirstPrompt(long).length, 200);
    assert.equal(truncateFirstPrompt(long), safeSlice(long, FIRST_PROMPT_MAX_LEN));
    assert.equal(truncateFirstPrompt(null), "");
  });

  test("capContent truncates with a visible marker and can be disabled (fact content-truncation)", () => {
    try {
      // Default: content over the cap is cut and the drop is reported visibly.
      const long = "a".repeat(600);
      const capped = capContent(long, 500);
      assert.ok(capped.startsWith("a".repeat(500)));
      assert.match(capped, /\[truncated 100 chars\]$/);
      // Short content is returned unchanged (no marker).
      assert.equal(capContent("short", 500), "short");
      // Full mode returns the original string verbatim.
      assert.equal(isContentTruncationEnabled(), true);
      setContentTruncation(false);
      assert.equal(isContentTruncationEnabled(), false);
      assert.equal(capContent(long, 500), long);
      assert.doesNotMatch(capContent(long, 500), /truncated/);
    } finally {
      setContentTruncation(true); // restore global default for other tests
    }
  });

  test("capContent restored default truncates again after full mode", () => {
    assert.equal(isContentTruncationEnabled(), true);
    assert.match(capContent("b".repeat(700), 500), /\[truncated 200 chars\]$/);
  });

  test("shortToolPath keeps last two segments", () => {
    const legacy = (p) => p.split("/").slice(-2).join("/");
    const samples = [
      "/a/b/c/d.js",
      "/home/user/proj/src/foo.js",
      "file.txt",
      "a/b",
      "/a",
      "//a/b",
      "a/b/",
      "",
      null,
    ];
    for (const p of samples) {
      assert.equal(shortToolPath(p), legacy(p ?? ""), `shortToolPath(${JSON.stringify(p)})`);
    }
  });

  test("parseEscapedJsonString decodes escapes", () => {
    assert.equal(parseEscapedJsonString("line\\nbreak"), "line\nbreak");
    assert.equal(parseEscapedJsonString('say \\"hi\\"'), 'say "hi"');
    assert.equal(parseEscapedJsonString(""), null);
    assert.equal(parseEscapedJsonString("\\u263A"), "☺");
  });

  test("parseEscapedJsonString logs malformed escaped literals", () => {
    const errorSpy = mock.method(console, "error", () => {});
    try {
      assert.equal(parseEscapedJsonString("bad\\u"), null);
      assert.equal(errorSpy.mock.callCount(), 1);
      const [prefix, detail] = errorSpy.mock.calls[0].arguments;
      assert.match(String(prefix), /parseEscapedJsonString: malformed escaped literal/);
      assert.match(String(detail), /Unicode escape/);
    } finally {
      errorSpy.mock.restore();
    }
  });

  test("parseToolArgs accepts object or JSON string", () => {
    assert.deepEqual(parseToolArgs('{"path":"/x"}'), { path: "/x" });
    assert.deepEqual(parseToolArgs({ k: 1 }), { k: 1 });
    assert.deepEqual(parseToolArgs(null), {});
    assert.deepEqual(parseToolArgs("{bad", "ctx"), {});
  });

  test("parseWebSearchLinks extracts title/url pairs from output", () => {
    const out =
      'Found: {"title":"Docs","url":"https://example.com"} and {"title":"Blog","url":"https://blog.test"}';
    assert.deepEqual(parseWebSearchLinks(out), [
      { title: "Docs", url: "https://example.com" },
      { title: "Blog", url: "https://blog.test" },
    ]);
    assert.deepEqual(parseWebSearchLinks(""), []);
  });

  test("includesLower and indexOfLower match toLowerCase includes/indexOf", () => {
    const samples = [
      ["", "x"],
      ["Hello World", "world"],
      ["npm run TASK-42", "task"],
      ["/path/To/File.ts", "file.ts"],
      ["no match here", "zzz"],
      ["MiXeD CaSe", "mixed"],
    ];
    for (const [hay, needle] of samples) {
      const n = needle.toLowerCase();
      assert.equal(includesLower(hay, n), hay.toLowerCase().includes(n), `includesLower(${JSON.stringify(hay)}, ${n})`);
      assert.equal(indexOfLower(hay, n), hay.toLowerCase().indexOf(n), `indexOfLower(${JSON.stringify(hay)}, ${n})`);
    }
    assert.equal(indexOfLower("abc", "b", 1), 1);
    assert.equal(indexOfLower("abc", "b", 2), -1);
    assert.equal(includesLower("café", "é"), "café".toLowerCase().includes("é"));
  });

  test("INDEX_OF_LOWER_JS bundles indexOfLower for browser-client", () => {
    assert.ok(INDEX_OF_LOWER_JS.includes("var LOWER_NATIVE_THRESHOLD = 4096"));
    assert.ok(INDEX_OF_LOWER_JS.includes("function needsLocaleFold"));
    assert.ok(INDEX_OF_LOWER_JS.includes("function indexOfLower"));
    const vmOut = vm.runInNewContext(`${INDEX_OF_LOWER_JS}; indexOfLower("Hello", "ell");`);
    assert.equal(vmOut, 1);
  });

  test("sumToolCounts matches Object.values reduce", () => {
    const legacy = (tc) => Object.values(tc).reduce((a, b) => a + b, 0);
    const samples = [{}, { Bash: 3 }, { Read: 1, Grep: 2, Bash: 5 }];
    for (const tc of samples) {
      assert.equal(sumToolCounts(tc), legacy(tc));
    }
  });

  test("joinFirstLines matches split/slice/join for newlines", () => {
    const legacy = (t, n) => t.split("\n").slice(0, n).join("\n");
    const samples = [
      ["", 3],
      ["one", 3],
      ["a\nb", 3],
      ["a\nb\nc\nd", 3],
      ["a\nb\n", 3],
      ["only\n", 1],
    ];
    for (const [t, n] of samples) {
      assert.equal(joinFirstLines(t, n), legacy(t, n), `joinFirstLines(${JSON.stringify(t)}, ${n})`);
    }
    assert.equal(joinFirstLines("x", 0), "");
  });

  test("countWords matches split/filter word count", () => {
    const legacy = (t) => t.split(/\s+/).filter((w) => w).length;
    const samples = [
      "",
      "one",
      "one two three",
      "  padded   words  ",
      "tab\there",
      "line\nbreak",
      "mix  of\t\n  whitespace",
      "emoji \u{1F9E0} still one token",
    ];
    for (const s of samples) {
      assert.equal(countWords(s), legacy(s), `countWords("${s}")`);
    }
    assert.equal(countWordsInStrings(["one two", "  three "]), 3);
    assert.equal(countWordsInStrings([]), 0);
  });
});