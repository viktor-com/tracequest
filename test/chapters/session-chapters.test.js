import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  buildSessionChapters,
} from "../../src/chapters/session-chapters.js";
import { summarizeChapterQuality } from "../../src/chapters/chapter-quality.js";
import { assertPerf } from "../helpers/perf-assert.js";

const T0 = "2026-01-01T00:00:00.000Z";

function session(events, overrides = {}) {
  return { startTime: T0, events, ...overrides };
}

function user(text, ts = T0) {
  return { type: "user", text, timestamp: ts };
}

function assistant(overrides = {}) {
  return { type: "assistant", timestamp: "2026-01-01T00:00:01.000Z", ...overrides };
}

function toolResult(toolUseId, text, extra = {}) {
  return { type: "tool_result", toolUseId, text, timestamp: "2026-01-01T00:00:02.000Z", ...extra };
}

describe("buildSessionChapters pipeline", () => {
  test("empty session yields no chapters and zeroed quality summary", () => {
    const chapters = buildSessionChapters({ startTime: T0, events: [] });
    const q = summarizeChapterQuality(chapters);
    assert.deepEqual(chapters, []);
    assert.deepEqual(q, {
      chapters: 0,
      retries: 0,
      clean: 0,
      corrected: 0,
      struggling: 0,
      files: 0,
      commits: 0,
    });
  });

  test("missing events array is treated as empty", () => {
    const chapters = buildSessionChapters({ startTime: T0 });
    assert.deepEqual(chapters, []);
  });

  test("does not mutate session object or events array", () => {
    const events = [
      user("hello"),
      assistant({ text: "hi", turns: 1 }),
    ];
    const sess = session(events);
    const eventsBefore = JSON.stringify(events);
    const sessBefore = JSON.stringify(sess);
    buildSessionChapters(sess);
    assert.equal(JSON.stringify(events), eventsBefore);
    assert.equal(JSON.stringify(sess), sessBefore);
  });

  test("splits chapters on user prompts and preserves timestamps", () => {
    const chapters = buildSessionChapters(
      session([
        user("first", "2026-01-01T00:00:00.000Z"),
        assistant({ timestamp: "2026-01-01T00:00:01.000Z" }),
        user("second", "2026-01-01T00:00:03.000Z"),
        assistant({ timestamp: "2026-01-01T00:00:04.000Z" }),
      ])
    );
    assert.equal(chapters.length, 2);
    assert.equal(chapters[0].prompt, "first");
    assert.equal(chapters[0].timestamp, "2026-01-01T00:00:00.000Z");
    assert.equal(chapters[1].prompt, "second");
    assert.equal(chapters[1].endTimestamp, "2026-01-01T00:00:04.000Z");
  });

  test("skips leading non-user events until first user or assistant", () => {
    const chapters = buildSessionChapters(
      session([
        { type: "tool_result", toolUseId: "x", text: "orphan" },
        { type: "system", text: "boot" },
        user("start"),
        assistant(),
      ])
    );
    assert.equal(chapters.length, 1);
    assert.equal(chapters[0].prompt, "start");
  });

  test("assistant-only session opens synthetic subagent chapter", () => {
    const chapters = buildSessionChapters(
      session([
        assistant({
          text: "orphan sidecar reply without user prompt",
          timestamp: "2026-01-01T00:00:05.000Z",
        }),
      ])
    );
    assert.equal(chapters.length, 1);
    assert.equal(chapters[0].prompt, "orphan sidecar reply without user prompt");
    assert.equal(chapters[0].timestamp, "2026-01-01T00:00:05.000Z");
    assert.equal(chapters[0].turns, 1);
  });

  test("tool-only session: single assistant turn accumulates tools under subagent placeholder", () => {
    const chapters = buildSessionChapters(
      session([
        assistant({
          timestamp: "2026-01-01T00:00:01.000Z",
          toolCalls: [
            { id: "r1", name: "Read", input: "/proj/src/a.js" },
            { id: "g1", name: "Grep", input: "needle" },
          ],
        }),
        toolResult("r1", "line1\nline2\nline3"),
        toolResult("g1", "match one\nmatch two\n"),
      ])
    );
    assert.equal(chapters.length, 1);
    const ch = chapters[0];
    assert.equal(ch.prompt, "(subagent session)");
    assert.equal(ch.turns, 1);
    assert.equal(ch.lastAssistantText, "");
    assert.equal(ch.toolCounts.Read, 1);
    assert.equal(ch.toolCounts.Grep, 1);
    assert.deepEqual(ch._fileKeys, ["src/a.js"]);
    assert.deepEqual(ch._toolKeys, ["Read", "Grep"]);
    assert.equal(ch.searches.length, 1);
    assert.equal(ch.searches[0].matches, 2);
    assert.equal(ch._callSeq, undefined);
    assert.equal(ch.retries, 0);
    assert.equal(ch.efficiency, undefined);
    assert.equal(ch.outcome, "clean");
  });

  test("tool-only session: multiple assistant turns stack tools without short-text prompt swap", () => {
    const chapters = buildSessionChapters(
      session([
        assistant({
          text: "short",
          timestamp: "2026-01-01T00:00:01.000Z",
          toolCalls: [{ id: "b1", name: "Bash", input: "npm test" }],
        }),
        toolResult("b1", "ok"),
        assistant({
          text: "also short",
          timestamp: "2026-01-01T00:00:02.000Z",
          toolCalls: [{ id: "r1", name: "Read", input: "/p/x.js" }],
        }),
        toolResult("r1", "content"),
      ])
    );
    assert.equal(chapters.length, 1);
    const ch = chapters[0];
    assert.equal(ch.prompt, "(subagent session)");
    assert.equal(ch.turns, 2);
    assert.equal(ch.toolCounts.Bash, 1);
    assert.equal(ch.toolCounts.Read, 1);
    assert.equal(ch.commands.length, 1);
    assert.equal(ch.commands[0].ok, true);
    assert.deepEqual(ch._fileKeys, ["p/x.js"]);
    assert.deepEqual(ch._toolKeys, ["Bash", "Read"]);
    assert.equal(ch.endTimestamp, "2026-01-01T00:00:02.000Z");
  });

  test("tool-only session: tool_result errors map to errorTools via assistant toolCalls", () => {
    const chapters = buildSessionChapters(
      session([
        assistant({
          toolCalls: [
            { id: "e1", name: "Bash", input: "false" },
            { id: "r1", name: "Read", input: "/missing" },
          ],
        }),
        toolResult("e1", "fail", { isError: true }),
        toolResult("r1", "ENOENT", { isError: true }),
      ])
    );
    const ch = chapters[0];
    assert.equal(ch.prompt, "(subagent session)");
    assert.equal(ch.errors, 2);
    assert.equal(ch.errorTools.Bash, 1);
    assert.equal(ch.errorTools.Read, 1);
    assert.ok(["corrected", "struggling"].includes(ch.outcome));
  });

  test("subagent placeholder replaced when later assistant text exceeds 20 chars", () => {
    const long =
      "This assistant message is long enough to replace the subagent session placeholder.";
    const chapters = buildSessionChapters(
      session([
        assistant({ text: "short", timestamp: "2026-01-01T00:00:01.000Z" }),
        assistant({ text: long, timestamp: "2026-01-01T00:00:02.000Z" }),
      ])
    );
    assert.equal(chapters.length, 1);
    assert.equal(chapters[0].prompt, long);
    assert.equal(chapters[0].turns, 2);
  });

  test("accumulates tokens, turns, thinking, and lastAssistantText", () => {
    const thinking = Array.from({ length: 25 }, (_, i) => `thought-${i}`);
    const chapters = buildSessionChapters(
      session([
        user("work"),
        assistant({
          text: "first",
          tokens: { input: 10, output: 5, cacheHit: 1, cacheWrite: 2 },
          thinking: thinking.slice(0, 15),
        }),
        assistant({
          text: "second",
          tokens: { input: 20, output: 10, cacheHit: 0, cacheWrite: 0 },
          thinking: thinking.slice(15),
        }),
      ])
    );
    const ch = chapters[0];
    assert.equal(ch.turns, 2);
    assert.equal(ch.lastAssistantText, "second");
    assert.equal(ch.tokens.input, 30);
    assert.equal(ch.tokens.output, 15);
    assert.equal(ch.tokens.cacheHit, 1);
    assert.equal(ch.tokens.cacheWrite, 2);
    // Gate is per assistant turn (< 20), so a second turn can push past 20 total.
    assert.equal(ch.thinking.length, 25);
    assert.equal(ch.thinking[0], "thought-0");
    assert.equal(ch.thinking[24], "thought-24");
  });

  test("git commit bash populates gitOps from command output", () => {
    const chapters = buildSessionChapters(
      session([
        user("ship it"),
        assistant({
          toolCalls: [{ id: "b1", name: "Bash", input: "git commit -m 'fix things'" }],
        }),
        toolResult("b1", "[main abc1234] fix things\n"),
      ])
    );
    const ch = chapters[0];
    assert.equal(ch.gitOps.length, 1);
    assert.equal(ch.gitOps[0].type, "commit");
    assert.equal(ch.gitOps[0].hash, "abc1234");
    assert.match(ch.gitOps[0].message, /fix things/);
    const q = summarizeChapterQuality(chapters);
    assert.equal(q.commits, 1);
  });

  test("Task subagent flags record type, completion, and result text", () => {
    const chapters = buildSessionChapters(
      session([
        user("spawn explorer"),
        assistant({
          toolCalls: [
            {
              id: "ag1",
              name: "Task",
              input: "",
              agentInfo: {
                description: "repo scout",
                prompt: "find tests",
                subagentType: "explore",
              },
            },
          ],
        }),
        toolResult("ag1", "found 12 test files under test/"),
      ])
    );
    const agent = chapters[0].agents[0];
    assert.equal(agent.subagentType, "explore");
    assert.equal(agent.description, "repo scout");
    assert.equal(agent.completed, true);
    assert.match(agent.result, /found 12 test/);
    assert.equal(agent.toolName, "Task");
  });

  test("tool_result errors increment errors and errorTools by tool name", () => {
    const chapters = buildSessionChapters(
      session([
        user("run"),
        assistant({
          toolCalls: [
            { id: "e1", name: "Bash", input: "false" },
            { id: "r1", name: "Read", input: "/missing.js" },
          ],
        }),
        toolResult("e1", "fail", { isError: true }),
        toolResult("r1", "ENOENT", { isError: true }),
        toolResult("e1", "fail again", { isError: true }),
      ])
    );
    const ch = chapters[0];
    assert.equal(ch.errors, 3);
    assert.equal(ch.errorTools.Bash, 2);
    assert.equal(ch.errorTools.Read, 1);
  });

  test("markUserPromptCorrections marks prior chapter from next user prompt", () => {
    const chapters = buildSessionChapters(
      session([
        user("implement feature"),
        assistant({
          toolCalls: [{ id: "b1", name: "Bash", input: "npm test" }],
        }),
        toolResult("b1", "fail", { isError: true }),
        user("no that's wrong — revert and try again"),
        assistant(),
      ])
    );
    assert.equal(chapters[0].corrected, true);
    assert.equal(chapters[1].corrected, false);
    const q = summarizeChapterQuality(chapters);
    assert.ok(q.corrected >= 1);
  });

  test("Read and Edit populate files map and _fileKeys", () => {
    const chapters = buildSessionChapters(
      session([
        user("edit file"),
        assistant({
          toolCalls: [
            { id: "r1", name: "Read", input: "/big/proj/src/foo.js" },
            { id: "e1", name: "Edit", input: "/other/proj/src/foo.js" },
          ],
        }),
        toolResult("r1", "line1\nline2\nline3\nline4"),
        toolResult("e1", "ok"),
      ])
    );
    const ch = chapters[0];
    assert.deepEqual(ch._fileKeys, ["src/foo.js"]);
    assert.deepEqual(ch._toolKeys, ["Read", "Edit"]);
    assert.deepEqual(ch.files["src/foo.js"].ops, ["Read", "Edit"]);
    assert.match(ch.files["src/foo.js"].output, /line1/);
  });

  test("Delete tool call adds its path to chapter files", () => {
    const chapters = buildSessionChapters(
      session([
        user("clean up"),
        assistant({
          toolCalls: [{ id: "d1", name: "Delete", input: "/big/proj/src/old.js" }],
        }),
        toolResult("d1", "ok"),
      ])
    );
    const ch = chapters[0];
    assert.deepEqual(ch._fileKeys, ["src/old.js"]);
    assert.deepEqual(ch.files["src/old.js"].ops, ["Delete"]);
  });

  test("Grep pipeline enables searchOutput snippets on searches", () => {
    const output = "match one\n\nmatch two\n";
    const chapters = buildSessionChapters(
      session([
        user("search"),
        assistant({ toolCalls: [{ id: "g1", name: "Grep", input: "needle" }] }),
        toolResult("g1", output),
      ])
    );
    const search = chapters[0].searches[0];
    assert.equal(search.matches, 2);
    assert.equal(search.ok, true);
    assert.ok(search.output);
    assert.ok(search.output.length <= 200);
  });

  test("WebFetch pipeline enables webFetchPreview and pageTitle", () => {
    const chapters = buildSessionChapters(
      session([
        user("fetch docs"),
        assistant({
          toolCalls: [
            {
              id: "wf1",
              name: "WebFetch",
              input: "https://example.com",
              webInfo: { type: "fetch", url: "https://example.com" },
            },
          ],
        }),
        toolResult("wf1", "# API Reference\n\nFirst paragraph.\n\nSecond."),
      ])
    );
    const web = chapters[0].webOps[0];
    assert.equal(web.type, "fetch");
    assert.equal(web.pageTitle, "API Reference");
    assert.match(web.preview, /First paragraph/);
  });

  test("duplicate Bash calls surface retries and enriched outcome", () => {
    const chapters = buildSessionChapters(
      session([
        user("run tests"),
        assistant({
          toolCalls: [
            { id: "b1", name: "Bash", input: "npm test" },
            { id: "b2", name: "Bash", input: "npm test" },
          ],
        }),
        toolResult("b1", "fail", { isError: true }),
        toolResult("b2", "ok"),
      ])
    );
    const ch = chapters[0];
    assert.ok(ch.retries >= 1);
    assert.ok(ch._callSeq === undefined);
    assert.ok(["clean", "corrected", "struggling"].includes(ch.outcome));
    assert.equal(ch.efficiency, undefined);
    const q = summarizeChapterQuality(chapters);
    assert.equal(q.chapters, 1);
    assert.equal(q.retries, ch.retries);
    assert.equal(q.clean + q.corrected + q.struggling, 1);
  });

  test("summarizeChapterQuality aggregates unique files across chapters", () => {
    const chapters = buildSessionChapters(
      session([
        user("a"),
        assistant({ toolCalls: [{ id: "r1", name: "Read", input: "/p/a.js" }] }),
        toolResult("r1", "a"),
        user("b"),
        assistant({ toolCalls: [{ id: "r2", name: "Read", input: "/p/b.js" }] }),
        toolResult("r2", "b"),
        user("c"),
        assistant({ toolCalls: [{ id: "r3", name: "Read", input: "/p/a.js" }] }),
        toolResult("r3", "a again"),
      ])
    );
    const q = summarizeChapterQuality(chapters);
    assert.equal(chapters.length, 3);
    assert.equal(q.files, 2);
    assert.equal(q.chapters, 3);
  });

  test("defers _fileKeysSet until enrichChaptersForRender (perf)", () => {
    const events = [];
    for (let i = 0; i < 500; i++) {
      events.push(user("chapter " + i, "2026-01-01T00:" + String(i % 60).padStart(2, "0") + ":00.000Z"));
      events.push(
        assistant({
          text: "work " + i,
          toolCalls: [
            { id: "r" + i, name: "Read", input: "/proj/src/file" + (i % 20) + ".js" },
            { id: "e" + i, name: "Edit", input: "/proj/src/file" + ((i + 1) % 20) + ".js" },
          ],
        })
      );
      events.push(toolResult("r" + i, "ok"));
      events.push(toolResult("e" + i, "ok"));
    }
    const sess = session(events);
    for (let w = 0; w < 3; w++) buildSessionChapters(sess);
    const ITERS = 120;
    const t0 = performance.now();
    for (let i = 0; i < ITERS; i++) {
      const chapters = buildSessionChapters(sess);
      assert.equal(chapters.length, 500);
      assert.equal(chapters[0]._fileKeysSet, undefined);
    }
    const ms = (performance.now() - t0) / ITERS;
    assertPerf(
      ms < 5,
      `expected buildSessionChapters under 5ms/op on 500 chapters (efficiency deferred), got ${ms.toFixed(3)}ms`,
    );
  });
});
describe("null toolUseId / tool call id isolation (cursor turn_ended errors)", () => {
  test("null-id tool calls never resolve a null-key tool_result; non-null pairs still match; error surfaces standalone", () => {
    const events = [
      user("do stuff"),
      assistant({
        toolCalls: [
          { id: null, name: "Bash", input: "ls" },
          { id: null, name: "Bash", input: "pwd" },
          { id: "tu1", name: "Bash", input: "echo hi" },
        ],
      }),
      toolResult("tu1", "hi"),
      toolResult(null, "User aborted request", { isError: true }),
    ];
    const chapters = buildSessionChapters(session(events));
    assert.equal(chapters.length, 1);
    const ch = chapters[0];

    // null-id calls have no attached result and are not errored
    const lsCmd = ch.commands.find(c => c.cmd === "ls");
    const pwdCmd = ch.commands.find(c => c.cmd === "pwd");
    assert.ok(lsCmd && pwdCmd);
    assert.equal(lsCmd.ok, true);
    assert.equal(lsCmd.output, "");
    assert.equal(pwdCmd.ok, true);
    assert.equal(pwdCmd.output, "");

    // non-null matching still works
    const echoCmd = ch.commands.find(c => c.cmd === "echo hi");
    assert.ok(echoCmd);
    assert.equal(echoCmd.ok, true);
    assert.equal(echoCmd.output, "hi");

    // error still counted and surfaced as a standalone session-level error
    assert.equal(ch.errors, 1);
    assert.deepEqual(ch.errorTools, {});
    assert.deepEqual(ch.standaloneErrors, ["User aborted request"]);
  });

  test("null-key error does not misattribute a tool name, but a matched non-null error still does", () => {
    const events = [
      user("go"),
      assistant({
        toolCalls: [
          { id: null, name: "Grep", input: "pattern" },
          { id: "tu9", name: "Bash", input: "false" },
        ],
      }),
      toolResult("tu9", "boom", { isError: true }),
      toolResult(null, "Turn error", { isError: true }),
    ];
    const ch = buildSessionChapters(session(events))[0];
    assert.equal(ch.errors, 2);
    assert.deepEqual(ch.errorTools, { Bash: 1 });
    assert.deepEqual(ch.standaloneErrors, ["Turn error"]);
    // the null-id Grep call is not marked as failed
    assert.equal(ch.searches[0].ok, true);
  });
});
