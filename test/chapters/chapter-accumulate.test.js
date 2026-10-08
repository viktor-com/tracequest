import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  newChapter,
  buildChapterEventMaps,
  accumulateAssistantToolCall,
} from "../../src/chapters/chapter-accumulate.js";

function htmlChapter(overrides = {}) {
  return { ...newChapter("prompt", "2026-01-01T00:00:00.000Z", "html"), ...overrides };
}

function tc(id, name, input, extra = {}) {
  return { id, name, input: input ?? "", ...extra };
}

describe("chapter-accumulate newChapter", () => {
  test("html variant includes _callSeq, tokens, and errorTools", () => {
    const ch = newChapter("fix bug", "2026-01-01T00:00:00.000Z", "html");
    assert.equal(ch.prompt, "fix bug");
    assert.deepEqual(ch._callSeq, []);
    assert.deepEqual(ch.tokens, { input: 0, output: 0, cacheHit: 0, cacheWrite: 0 });
    assert.deepEqual(ch.errorTools, {});
    assert.equal(ch.outcome, undefined);
    assert.equal(ch.corrected, false);
    assert.equal(ch.errors, 0);
  });

  test("markdown variant sets outcome clean and omits html-only fields", () => {
    const ch = newChapter("export", "2026-01-01T00:00:00.000Z", "markdown");
    assert.equal(ch.outcome, "clean");
    assert.equal(ch._callSeq, undefined);
    assert.equal(ch.errorTools, undefined);
    assert.equal(ch.tokens, undefined);
  });

  test("unknown variant defaults to html shape", () => {
    const ch = newChapter("x", "t", "unknown");
    assert.ok(Array.isArray(ch._callSeq));
    assert.equal(ch.outcome, undefined);
  });
});

describe("chapter-accumulate buildChapterEventMaps", () => {
  test("returns empty maps when events lack tool_result and assistant toolCalls", () => {
    assert.deepEqual(
      buildChapterEventMaps([
        { type: "user", text: "hi" },
        { type: "assistant", text: "ok" },
      ]),
      { resultMap: {}, toolNameMap: {} }
    );
  });

  test("builds resultMap and toolNameMap in one pass", () => {
    const { resultMap, toolNameMap } = buildChapterEventMaps([
      { type: "tool_result", toolUseId: "r1", text: "out" },
      {
        type: "assistant",
        toolCalls: [
          { id: "r1", name: "Read", input: "/a" },
          { id: "b1", name: "Bash", input: "ls" },
        ],
      },
      { type: "tool_result", toolUseId: "b1", text: "listed" },
    ]);
    assert.equal(resultMap.r1.text, "out");
    assert.equal(resultMap.b1.text, "listed");
    assert.deepEqual(toolNameMap, { r1: "Read", b1: "Bash" });
  });

  test("later tool_result overwrites earlier entry for same toolUseId", () => {
    const { resultMap } = buildChapterEventMaps([
      { type: "tool_result", toolUseId: "x", text: "first" },
      { type: "tool_result", toolUseId: "x", text: "second", isError: true },
    ]);
    assert.equal(resultMap.x.text, "second");
    assert.equal(resultMap.x.isError, true);
  });
});

describe("chapter-accumulate accumulateAssistantToolCall", () => {
  test("increments toolCounts and leaves _callSeq empty without trackCallSeq", () => {
    const ch = htmlChapter();
    const resultMap = { r1: { text: "ok" } };
    accumulateAssistantToolCall(ch, tc("r1", "Read", "/proj/a/b.js"), resultMap);
    accumulateAssistantToolCall(ch, tc("r1", "Read", "/proj/a/b.js"), resultMap);
    assert.equal(ch.toolCounts.Read, 2);
    assert.deepEqual(ch._callSeq, []);
  });

  test("trackCallSeq records name, input, isError, and id", () => {
    const ch = htmlChapter();
    const resultMap = {
      ok: { text: "fine", isError: false },
      bad: { text: "fail", isError: true },
    };
    accumulateAssistantToolCall(ch, tc("ok", "Bash", "npm test"), resultMap, { trackCallSeq: true });
    accumulateAssistantToolCall(ch, tc("bad", "Bash", "npm test"), resultMap, { trackCallSeq: true });
    assert.equal(ch._callSeq.length, 2);
    assert.equal(ch._callSeq[0].isError, false);
    assert.equal(ch._callSeq[1].isError, true);
    assert.equal(ch._callSeq[1].id, "bad");
  });

  test("missing tool_result treats call as non-error with empty output", () => {
    const ch = htmlChapter();
    accumulateAssistantToolCall(ch, tc("ghost", "Grep", "pattern"), {}, { trackCallSeq: true });
    assert.equal(ch._callSeq[0].isError, false);
    assert.equal(ch.searches[0].matches, 0);
    assert.equal(ch.searches[0].ok, true);
  });

  test("Read stores shortToolPath file key and first-read output only once", () => {
    const ch = htmlChapter();
    const lines = ["line1", "line2", "line3", "line4"].join("\n");
    const resultMap = {
      r1: { text: lines },
      r2: { text: "should not replace" },
    };
    accumulateAssistantToolCall(ch, tc("r1", "Read", "/big/proj/src/foo.js"), resultMap);
    accumulateAssistantToolCall(ch, tc("r2", "Read", "/other/proj/src/foo.js"), resultMap);
    assert.ok(ch.files["src/foo.js"]);
    assert.equal(ch.files["src/foo.js"].ops.length, 2);
    assert.match(ch.files["src/foo.js"].output, /line1/);
    assert.doesNotMatch(ch.files["src/foo.js"].output, /should not/);
  });

  test("Edit and Write on same path merge ops under one files entry", () => {
    const ch = htmlChapter();
    const resultMap = { e1: { text: "" }, w1: { text: "" } };
    accumulateAssistantToolCall(ch, tc("e1", "Edit", "/proj/a/b.js"), resultMap);
    accumulateAssistantToolCall(ch, tc("w1", "Write", "/other/a/b.js"), resultMap);
    assert.deepEqual(ch.files["a/b.js"].ops, ["Edit", "Write"]);
  });

  test("diffInfo appends up to 12 diffs then stops", () => {
    const ch = htmlChapter();
    const resultMap = {};
    for (let i = 0; i < 14; i++) {
      const id = `d${i}`;
      resultMap[id] = { text: "" };
      accumulateAssistantToolCall(
        ch,
        tc(id, "Edit", `/f/file${i}.js`, { diffInfo: { oldStr: "a", newStr: "b" } }),
        resultMap
      );
    }
    assert.equal(ch.diffs.length, 12);
    assert.equal(ch.diffs[0].path, "f/file0.js");
    assert.equal(ch.diffs[11].path, "f/file11.js");
  });

  test("Bash records ok flag, slices output, and detects git commit", () => {
    const ch = htmlChapter();
    const longOut = "x".repeat(400);
    const resultMap = {
      b1: { text: longOut, isError: true },
      b2: { text: '[main abc1234] fix things\n', isError: false },
    };
    accumulateAssistantToolCall(ch, tc("b1", "Bash", "echo hi"), resultMap);
    accumulateAssistantToolCall(ch, tc("b2", "Bash", "git commit -m msg"), resultMap);
    assert.equal(ch.commands.length, 2);
    assert.equal(ch.commands[0].ok, false);
    assert.equal(ch.commands[0].output.length, 300);
    assert.equal(ch.commands[1].ok, true);
    assert.equal(ch.gitOps.length, 1);
    assert.equal(ch.gitOps[0].type, "commit");
  });

  test("Grep counts non-empty lines and optional searchOutput", () => {
    const ch = htmlChapter();
    const output = "\nmatch one\n  \nmatch two\n";
    const resultMap = { g1: { text: output, isError: true } };
    accumulateAssistantToolCall(ch, tc("g1", "Grep", "needle"), resultMap);
    assert.equal(ch.searches[0].matches, 2);
    assert.equal(ch.searches[0].ok, false);
    assert.equal(ch.searches[0].output, undefined);

    const ch2 = htmlChapter();
    accumulateAssistantToolCall(ch2, tc("g1", "Grep", "needle"), resultMap, { searchOutput: true });
    assert.ok(ch2.searches[0].output);
    assert.ok(ch2.searches[0].output.length <= 200);
  });

  test("webInfo search parses links; fetch adds preview and pageTitle when enabled", () => {
    const ch = htmlChapter();
    const searchOut =
      '{"title":"A","url":"https://a.com"} {"title":"B","url":"https://b.com"}';
    const fetchOut = "# Page Title\n\nbody line\n\nmore";
    const resultMap = {
      w1: { text: searchOut },
      w2: { text: fetchOut, isError: true },
    };
    accumulateAssistantToolCall(
      ch,
      tc("w1", "WebSearch", "", { webInfo: { type: "search", query: "q" } }),
      resultMap
    );
    accumulateAssistantToolCall(
      ch,
      tc("w2", "WebFetch", "", { webInfo: { type: "fetch", url: "https://x.com" } }),
      resultMap,
      { webFetchPreview: true }
    );
    assert.equal(ch.webOps[0].resultCount, 2);
    assert.equal(ch.webOps[0].results.length, 2);
    assert.equal(ch.webOps[1].ok, false);
    assert.equal(ch.webOps[1].pageTitle, "Page Title");
    assert.match(ch.webOps[1].preview, /body line/);
  });

  test("webOps stops accumulating after 10 entries", () => {
    const ch = htmlChapter();
    const resultMap = {};
    for (let i = 0; i < 12; i++) {
      const id = `w${i}`;
      resultMap[id] = { text: "" };
      accumulateAssistantToolCall(
        ch,
        tc(id, "WebSearch", "", { webInfo: { type: "search", query: `q${i}` } }),
        resultMap
      );
    }
    assert.equal(ch.webOps.length, 10);
    assert.equal(ch.webOps[9].query, "q9");
  });

  test("agentInfo respects cap and agentResult option", () => {
    const ch = htmlChapter();
    const resultMap = { a0: { text: "done" } };
    accumulateAssistantToolCall(
      ch,
      tc("a0", "Task", "", {
        agentInfo: { description: "scout", prompt: "go", subagentType: "explore" },
      }),
      resultMap,
      { agentResult: true }
    );
    assert.equal(ch.agents[0].completed, true);
    assert.equal(ch.agents[0].result, "done");
    assert.equal(ch.agents[0].toolName, "Task");

    const ch2 = htmlChapter();
    accumulateAssistantToolCall(
      ch2,
      tc("a1", "Task", "", { agentInfo: { description: "pending" } }),
      {}
    );
    assert.equal(ch2.agents[0].completed, false);
    assert.equal(ch2.agents[0].result, undefined);
  });

  test("mcpInfo accumulates up to 15 ops with sliced output", () => {
    const ch = htmlChapter();
    const resultMap = {};
    for (let i = 0; i < 16; i++) {
      const id = `m${i}`;
      resultMap[id] = { text: "y".repeat(500) };
      accumulateAssistantToolCall(
        ch,
        tc(id, "mcp_x", "", {
          mcpInfo: { server: `srv${i}`, tool: `tool${i}`, params: { n: i } },
        }),
        resultMap
      );
    }
    assert.equal(ch.mcpOps.length, 15);
    assert.equal(ch.mcpOps[14].server, "srv14");
    assert.equal(ch.mcpOps[0].output.length, 400);
  });

  test("gitOps cap at 20 even when many git Bash commands run", () => {
    const ch = htmlChapter();
    const resultMap = {};
    for (let i = 0; i < 22; i++) {
      const id = `g${i}`;
      resultMap[id] = { text: "" };
      accumulateAssistantToolCall(ch, tc(id, "Bash", "git commit -m batch"), resultMap);
    }
    assert.equal(ch.gitOps.length, 20);
  });

  test("skips file/bash/grep branches when tool input is empty", () => {
    const ch = htmlChapter();
    accumulateAssistantToolCall(ch, tc("e0", "Edit", ""), {});
    accumulateAssistantToolCall(ch, tc("b0", "Bash", ""), {});
    accumulateAssistantToolCall(ch, tc("gr", "Grep", ""), {});
    assert.deepEqual(ch.files, {});
    assert.deepEqual(ch.commands, []);
    assert.deepEqual(ch.searches, []);
  });
});

describe("chapter-accumulate edge cases", () => {
  test("html tool-only chapter: synthetic prompt unchanged, only tool fields grow", () => {
    const ch = newChapter("(subagent session)", "2026-01-01T00:00:00.000Z", "html");
    const events = [
      { type: "tool_result", toolUseId: "r1", text: "line1\nline2" },
      { type: "tool_result", toolUseId: "g1", text: "hit\n" },
    ];
    const { resultMap } = buildChapterEventMaps(events);
    accumulateAssistantToolCall(ch, tc("r1", "Read", "/proj/src/a.js"), resultMap, {
      trackCallSeq: true,
    });
    accumulateAssistantToolCall(ch, tc("g1", "Grep", "needle"), resultMap, { searchOutput: true });

    assert.equal(ch.prompt, "(subagent session)");
    assert.equal(ch.lastAssistantText, "");
    assert.equal(ch.turns, 0);
    assert.deepEqual(ch.tokens, { input: 0, output: 0, cacheHit: 0, cacheWrite: 0 });
    assert.equal(ch.toolCounts.Read, 1);
    assert.equal(ch.toolCounts.Grep, 1);
    assert.ok(ch.files["src/a.js"]);
    assert.equal(ch.searches.length, 1);
    assert.equal(ch._callSeq.length, 1);
    assert.equal(ch._callSeq[0].name, "Read");
  });

  test("markdown tool-only chapter keeps outcome clean and omits html-only accumulators", () => {
    const ch = newChapter("(export tools)", "2026-01-01T00:00:01.000Z", "markdown");
    const { resultMap } = buildChapterEventMaps([
      { type: "tool_result", toolUseId: "b1", text: "ok" },
    ]);
    accumulateAssistantToolCall(ch, tc("b1", "Bash", "ls -la"), resultMap, { searchOutput: true });

    assert.equal(ch.outcome, "clean");
    assert.equal(ch._callSeq, undefined);
    assert.equal(ch.commands[0].cmd, "ls -la");
    assert.equal(ch.commands[0].ok, true);
  });

  test("single accumulate call on fresh chapter only bumps one toolCount", () => {
    const ch = htmlChapter({ prompt: "one shot" });
    accumulateAssistantToolCall(ch, tc("x1", "Glob", "**/*.js"), {});
    assert.deepEqual(ch.toolCounts, { Glob: 1 });
    assert.deepEqual(ch.files, {});
    assert.deepEqual(ch.commands, []);
    assert.deepEqual(ch._callSeq, []);
  });

  test("tool-only chapter with empty events still records Bash when result arrives later", () => {
    const ch = htmlChapter({ prompt: "(subagent session)" });
    const { resultMap: emptyMap } = buildChapterEventMaps([]);
    accumulateAssistantToolCall(ch, tc("b1", "Bash", "npm test"), emptyMap);
    assert.equal(ch.commands.length, 1);
    assert.equal(ch.commands[0].ok, true);
    assert.equal(ch.commands[0].output, "");

    const { resultMap: filledMap } = buildChapterEventMaps([
      { type: "tool_result", toolUseId: "b1", text: "FAIL", isError: true },
    ]);
    accumulateAssistantToolCall(ch, tc("b1", "Bash", "npm test"), filledMap, { trackCallSeq: true });
    assert.equal(ch.toolCounts.Bash, 2);
    assert.equal(ch.commands.length, 2);
    assert.equal(ch.commands[1].ok, false);
    assert.equal(ch._callSeq[0].isError, true);
  });

  test("empty events with orphan tool_result does not affect accumulate without matching id", () => {
    const { resultMap: map } = buildChapterEventMaps([
      { type: "tool_result", toolUseId: "orphan", text: "unused" },
    ]);
    const ch = htmlChapter();
    accumulateAssistantToolCall(ch, tc("other", "Read", "/p/x.js"), map);
    assert.ok(ch.files["p/x.js"]);
    assert.equal(ch.files["p/x.js"].output, "");
  });
});