import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildMarkdownChapterSections,
  buildMarkdownFooter,
  generateMarkdown,
  renderMarkdownChapter,
} from "../../src/export/markdown-export.js";
import { joinMarkdownHeader } from "./markdown-header-test-helpers.js";
import { buildSessionChapters } from "../../src/chapters/session-chapters.js";

const MARKDOWN_EXPORT_JS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../src/export/markdown-export.js"),
  "utf8",
);

function minimalStats(overrides = {}) {
  return {
    userMessages: 1,
    assistantTurns: 1,
    toolCounts: { Bash: 1 },
    totalInputTokens: 1000,
    totalOutputTokens: 500,
    totalCacheHit: 200,
    errors: 0,
    ...overrides,
  };
}

function emptyChapter(overrides = {}) {
  return {
    prompt: "",
    timestamp: null,
    endTimestamp: null,
    turns: 0,
    outcome: "clean",
    gitOps: [],
    files: {},
    diffs: [],
    commands: [],
    webOps: [],
    mcpOps: [],
    agents: [],
    thinking: [],
    errors: 0,
    lastAssistantText: "",
    ...overrides,
  };
}

function richSessionEvents() {
  const longPrompt = Array.from({ length: 12 }, (_, i) => `prompt line ${i + 1}`).join("\n");
  const longResponse = "R".repeat(900);

  return [
    { type: "user", text: longPrompt, timestamp: "2026-01-01T00:00:00.000Z" },
    {
      type: "assistant",
      text: longResponse,
      thinking: ["think block one", "think block two", "think block three"],
      timestamp: "2026-01-01T00:00:05.000Z",
      toolCalls: [
        { id: "r1", name: "Read", input: "/proj/src/Foo.js" },
        { id: "e1", name: "Edit", input: "/proj/src/Edit.js", diffInfo: { oldStr: "old", newStr: "new" } },
        { id: "w1", name: "Write", input: "/proj/src/New.js", diffInfo: { content: "line1\nline2" } },
        { id: "b1", name: "Bash", input: "git commit -m 'feat: <tag> & \"quote\"'" },
        { id: "b2", name: "Bash", input: "false" },
        { id: "ws1", name: "WebSearch", input: "", webInfo: { type: "search", query: "tracequest" } },
        { id: "wf1", name: "WebFetch", input: "https://example.com", webInfo: { type: "fetch", url: "https://example.com", prompt: "summarize" } },
        { id: "t1", name: "Task", input: "", agentInfo: { description: "explorer", prompt: "find files", subagentType: "explore" } },
        {
          id: "m1",
          name: "mcp_tool",
          input: "",
          mcpInfo: { server: "my_server", tool: "search", rawName: "mcp_tool", params: { q: "test" } },
        },
      ],
    },
    { type: "tool_result", toolUseId: "r1", text: "ok", timestamp: "2026-01-01T00:00:01.000Z" },
    { type: "tool_result", toolUseId: "e1", text: "edited", timestamp: "2026-01-01T00:00:02.000Z" },
    { type: "tool_result", toolUseId: "w1", text: "written", timestamp: "2026-01-01T00:00:03.000Z" },
    { type: "tool_result", toolUseId: "b1", text: "committed", timestamp: "2026-01-01T00:00:04.000Z" },
    { type: "tool_result", toolUseId: "b2", text: "fail", isError: true, timestamp: "2026-01-01T00:00:04.500Z" },
    {
      type: "tool_result",
      toolUseId: "ws1",
      text: '[{"title":"Result & <ok>","url":"https://r.example"}]',
      timestamp: "2026-01-01T00:00:05.000Z",
    },
    { type: "tool_result", toolUseId: "wf1", text: "page body", timestamp: "2026-01-01T00:00:06.000Z" },
    { type: "tool_result", toolUseId: "t1", text: "done", timestamp: "2026-01-01T00:00:07.000Z" },
    { type: "tool_result", toolUseId: "m1", text: "mcp output line", timestamp: "2026-01-01T00:00:08.000Z" },
  ];
}

function richSession() {
  return {
    sessionId: "019e47cd-151a-75d1-8f42-53efb31db13f",
    model: "claude-sonnet",
    source: "claude",
    startTime: "2026-01-01T00:00:00.000Z",
    durationMs: 125_000,
    cwd: "/home/user/code/tracequest",
    gitBranch: "main",
    stats: minimalStats({ errors: 1, toolCounts: { Bash: 3, Read: 1, Edit: 1, Write: 1 } }),
    events: richSessionEvents(),
  };
}

describe("markdown-export perf", () => {
});

describe("markdown-export renderMarkdownChapter", () => {
  test("truncates long prompts, responses, diffs, and commands with overflow notes", () => {
    const session = richSession();
    const chapters = buildSessionChapters(session);
    assert.equal(chapters.length, 1);
    const ch = chapters[0];

    ch.diffs = Array.from({ length: 10 }, (_, i) => ({
      path: `f${i}.js`,
      name: "Write",
      diffInfo: { content: "x" },
    }));
    ch.commands = Array.from({ length: 14 }, (_, i) => ({
      cmd: `cmd-${i}`,
      ok: true,
      output: "line",
    }));
    ch.thinking = ["a", "b", "c"];

    const md = renderMarkdownChapter(ch, 0).join("\n");
    assert.match(md, /^## Chapter 1/);
    assert.match(md, /> prompt line 1/);
    assert.match(md, /> \.\.\./);
    assert.match(md, /\*\.\.\.and 2 more changes\*/);
    assert.match(md, /\*\.\.\.and 2 more commands\*/);
    assert.match(md, /\*\.\.\.and 1 more thinking blocks\*/);
    assert.equal((md.match(/### Response/g) || []).length, 1);
    assert.ok(md.includes("R".repeat(800)));
    assert.ok(!md.includes("R".repeat(801)));
  });

  test("preserves raw <>&\" in prompts and markdown-significant chars without escaping", () => {
    const ch = {
      prompt: 'fix <html> & "quotes"',
      timestamp: "2026-01-01T00:00:00.000Z",
      endTimestamp: "2026-01-01T00:00:10.000Z",
      turns: 1,
      outcome: "corrected",
      gitOps: [{ type: "commit", hash: "abc123def456", message: 'msg <>&"' }],
      files: { "src/a.js": { ops: ["Read", "Edit"] } },
      diffs: [{
        path: "src/a.js",
        name: "Edit",
        diffInfo: { oldStr: "a < b", newStr: 'c & "d"' },
      }],
      commands: [{ cmd: 'echo "<tag>"', ok: false, output: "err & fail" }],
      webOps: [],
      mcpOps: [],
      agents: [],
      thinking: [],
      errors: 1,
      lastAssistantText: "done **bold**",
    };
    const md = renderMarkdownChapter(ch, 0).join("\n");
    assert.match(md, /> fix <html> & "quotes"/);
    assert.match(md, /outcome: corrected/);
    assert.match(md, /msg <>&"/);
    assert.match(md, /- a < b/);
    assert.match(md, /\+ c & "d"/);
    assert.match(md, /\[FAIL\].*`echo "<tag>"`/);
    assert.match(md, /done \*\*bold\*\*/);
  });

  test("empty chapter omits prompt, git, files, and response sections", () => {
    const md = renderMarkdownChapter(emptyChapter(), 2).join("\n");
    assert.match(md, /^## Chapter 3/);
    assert.doesNotMatch(md, /^> /m);
    assert.doesNotMatch(md, /### Git/);
    assert.doesNotMatch(md, /### Files/);
    assert.doesNotMatch(md, /### Response/);
    assert.doesNotMatch(md, /outcome:/);
    assert.match(md, /^---$/m);
  });

  test("renders all git operation types", () => {
    const md = renderMarkdownChapter(emptyChapter({
      gitOps: [
        { type: "commit", hash: "deadbeef", message: "init" },
        { type: "push", remote: "origin", branch: "main", tags: true },
        { type: "branch-create", branch: "feat/x" },
        { type: "branch-switch", branch: "main" },
        { type: "merge", branch: "feat/x" },
        { type: "rebase", branch: "main" },
        { type: "tag", tag: "v1.0.0" },
        { type: "stash" },
      ],
    }), 0).join("\n");
    assert.match(md, /### Git/);
    assert.match(md, /\*\*commit\*\*/);
    assert.match(md, /\*\*push\*\* origin main --tags/);
    assert.match(md, /branch\*\* create/);
    assert.match(md, /\*\*checkout\*\*/);
    assert.match(md, /\*\*merge\*\*/);
    assert.match(md, /\*\*rebase\*\*/);
    assert.match(md, /\*\*tag\*\*/);
    assert.match(md, /\*\*stash\*\*/);
  });

  test("write diff uses fenced block label write", () => {
    const md = renderMarkdownChapter(emptyChapter({
      diffs: [{ path: "new.js", name: "Write", diffInfo: { content: "alpha\nbeta" } }],
    }), 0).join("\n");
    assert.match(md, /\*\*`new\.js`\*\* \(write\)/);
    assert.match(md, /```[\s\S]*alpha/);
  });

  test("MCP FAIL and agent pending statuses appear in export", () => {
    const md = renderMarkdownChapter(emptyChapter({
      mcpOps: [{ server: "srv", tool: "run", params: {}, ok: false, output: "boom" }],
      agents: [{ description: "worker", subagentType: "task", completed: false, isError: false }],
    }), 0).join("\n");
    assert.match(md, /### Integrations \(MCP\)/);
    assert.match(md, /\[FAIL\]/);
    assert.match(md, /### Subagents/);
    assert.match(md, /\[pending\]/);
  });

  test("web search and fetch sections list results and prompts", () => {
    const md = renderMarkdownChapter(emptyChapter({
      webOps: [
        { type: "search", query: "tracequest docs", results: [{ title: "Guide", url: "https://g.example" }] },
        { type: "fetch", url: "https://example.com", pageTitle: "Home", prompt: "summarize page" },
      ],
    }), 0).join("\n");
    assert.match(md, /### Web/);
    assert.match(md, /\*\*Search\*\*/);
    assert.match(md, /\[Guide\]/);
    assert.match(md, /\*\*Fetch\*\*/);
    assert.match(md, /summarize page/);
  });

  test("chapter header shows timestamp, plural turns, duration, and non-clean outcome", () => {
    const md = renderMarkdownChapter(emptyChapter({
      timestamp: "2026-01-01T10:00:00.000Z",
      endTimestamp: "2026-01-01T10:02:30.000Z",
      turns: 3,
      outcome: "struggling",
    }), 0).join("\n");
    assert.match(md, /\*[^*]+\| 3 turns \|[^*]+\| outcome: struggling\*/);
    assert.doesNotMatch(md, /1 turn/);
  });

  test("chapter header omits meta line when timestamp, turns, duration, and outcome are absent", () => {
    const md = renderMarkdownChapter(emptyChapter({
      timestamp: null,
      endTimestamp: null,
      turns: 0,
      outcome: "clean",
    }), 0).join("\n");
    assert.match(md, /^## Chapter 1\n\n---/m);
    assert.doesNotMatch(md, /^\*[^*]+\*$/m);
  });

  test("commit without hash still renders message placeholder", () => {
    const md = renderMarkdownChapter(emptyChapter({
      gitOps: [{ type: "commit", hash: null, message: "" }],
    }), 0).join("\n");
    assert.match(md, /- \*\*commit\*\*.*\(no message\)/);
    assert.doesNotMatch(md, /`[0-9a-f]{7}`/);
  });

  test("completed and failed subagents show OK and FAIL statuses", () => {
    const md = renderMarkdownChapter(emptyChapter({
      agents: [
        { description: "done agent", completed: true, isError: false },
        { description: "bad agent", completed: true, isError: true },
      ],
    }), 0).join("\n");
    assert.match(md, /\[OK\].*done agent/);
    assert.match(md, /\[FAIL\].*bad agent/);
  });
});

describe("markdown-export Files Commands Errors Thinking sections", () => {
  test("Files section aggregates duplicate ops with xN suffix", () => {
    const md = renderMarkdownChapter(emptyChapter({
      files: {
        "lib/util.js": { ops: ["Read", "Read", "Edit"] },
        "README.md": { ops: ["Write"] },
      },
    }), 0).join("\n");
    assert.match(md, /### Files/);
    assert.match(md, /`lib\/util\.js` — read x2, edit/);
    assert.match(md, /`README\.md` — write/);
  });

  test("Commands section shows ok/FAIL, fences output, and caps listed commands at twelve", () => {
    const commands = Array.from({ length: 14 }, (_, i) => ({
      cmd: `echo cmd-${i}`,
      ok: i !== 2,
      output: i === 1 ? "line1\nline2\nline3\nline4\nline5" : "",
    }));
    const md = renderMarkdownChapter(emptyChapter({ commands, errors: 1 }), 0).join("\n");
    assert.match(md, /### Commands/);
    assert.match(md, /\[ok\].*`echo cmd-0`/);
    assert.match(md, /\[FAIL\].*`echo cmd-2`/);
    assert.match(md, /line4/);
    assert.doesNotMatch(md, /line5/);
    assert.equal((md.match(/\[ok\]/g) || []).length + (md.match(/\[FAIL\]/g) || []).length, 12);
    assert.match(md, /\*\.\.\.and 2 more commands\*/);
  });

  test("Errors section lists failed commands with first output line", () => {
    const md = renderMarkdownChapter(emptyChapter({
      errors: 2,
      commands: [
        { cmd: "npm test", ok: false, output: "FAIL pkg\nstack trace" },
        { cmd: "npm run lint", ok: true, output: "" },
      ],
    }), 0).join("\n");
    const errorsBlock = md.split("### Errors")[1]?.split("---")[0] ?? "";
    assert.match(md, /### Errors/);
    assert.match(errorsBlock, /`npm test`/);
    assert.match(errorsBlock, /> FAIL pkg/);
    assert.doesNotMatch(errorsBlock, /npm run lint/);
  });

  test("Errors section omitted when errors count is zero despite failed commands", () => {
    const md = renderMarkdownChapter(emptyChapter({
      errors: 0,
      commands: [{ cmd: "false", ok: false, output: "boom" }],
    }), 0).join("\n");
    assert.doesNotMatch(md, /### Errors/);
  });

  test("Thinking section reports word count and caps blocks at two", () => {
    const md = renderMarkdownChapter(emptyChapter({
      thinking: ["one two three", "four five", "six seven eight"],
    }), 0).join("\n");
    assert.match(md, /### Thinking \(8 words\)/);
    assert.equal((md.match(/```/g) || []).length, 4);
    assert.match(md, /\*\.\.\.and 1 more thinking blocks\*/);
  });
});

describe("markdown-export diff sections", () => {
  test("edit diff renders old and new lines in diff fence", () => {
    const md = renderMarkdownChapter(emptyChapter({
      diffs: [{
        path: "src/patch.js",
        name: "Edit",
        diffInfo: { oldStr: "const a = 1;\nconst b = 2;", newStr: "const a = 2;\nconst b = 2;" },
      }],
    }), 0).join("\n");
    assert.match(md, /### Changes/);
    assert.match(md, /\*\*`src\/patch\.js`\*\* \(edit\)/);
    assert.match(md, /```diff[\s\S]*- const a = 1;/);
    assert.match(md, /\+ const a = 2;/);
  });

  test("edit diff with only oldStr renders minus lines without plus lines", () => {
    const md = renderMarkdownChapter(emptyChapter({
      diffs: [{ path: "only-old.js", name: "Edit", diffInfo: { oldStr: "removed line" } }],
    }), 0).join("\n");
    assert.match(md, /```diff[\s\S]*- removed line/);
    assert.doesNotMatch(md, /^\+ /m);
  });

  test("edit without oldStr omits diff fence entirely", () => {
    const md = renderMarkdownChapter(emptyChapter({
      diffs: [{ path: "no-old.js", name: "Edit", diffInfo: { newStr: "orphan plus" } }],
    }), 0).join("\n");
    assert.match(md, /\(edit\)/);
    assert.doesNotMatch(md, /```diff/);
  });

  test("write diff labels path and fences full content up to eight lines", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
    const md = renderMarkdownChapter(emptyChapter({
      diffs: [{ path: "out.txt", name: "Write", diffInfo: { content: lines.join("\n") } }],
    }), 0).join("\n");
    assert.match(md, /\*\*`out\.txt`\*\* \(write\)/);
    assert.match(md, /line 1/);
    assert.match(md, /line 8/);
    assert.doesNotMatch(md, /line 9/);
    assert.doesNotMatch(md, /line 12/);
  });

  test("write diff with empty content skips fenced body", () => {
    const md = renderMarkdownChapter(emptyChapter({
      diffs: [{ path: "empty.js", name: "Write", diffInfo: { content: "" } }],
    }), 0).join("\n");
    assert.match(md, /\(write\)/);
    const afterHeader = md.split("(write)")[1];
    assert.doesNotMatch(afterHeader, /```[\s\S]*?```/);
  });

  test("multiple write and edit diffs preserve order and type labels", () => {
    const md = renderMarkdownChapter(emptyChapter({
      diffs: [
        { path: "a.js", name: "Write", diffInfo: { content: "w1" } },
        { path: "b.js", name: "Edit", diffInfo: { oldStr: "x", newStr: "y" } },
        { path: "c.js", name: "Write", diffInfo: { content: "w2" } },
      ],
    }), 0).join("\n");
    const aIdx = md.indexOf("a.js");
    const bIdx = md.indexOf("b.js");
    const cIdx = md.indexOf("c.js");
    assert.ok(aIdx < bIdx && bIdx < cIdx);
    assert.match(md, /a\.js.*\(write\)/s);
    assert.match(md, /b\.js.*\(edit\)/s);
    assert.match(md, /c\.js.*\(write\)/s);
  });

  test("more than eight diffs adds overflow note", () => {
    const diffs = Array.from({ length: 10 }, (_, i) => ({
      path: `f${i}.js`,
      name: "Write",
      diffInfo: { content: "x" },
    }));
    const md = renderMarkdownChapter(emptyChapter({ diffs }), 0).join("\n");
    assert.equal((md.match(/\(write\)/g) || []).length, 8);
    assert.match(md, /\*\.\.\.and 2 more changes\*/);
  });

  test("edit diff preserves angle brackets and quotes in diff lines", () => {
    const md = renderMarkdownChapter(emptyChapter({
      diffs: [{
        path: "unsafe.html",
        name: "Edit",
        diffInfo: { oldStr: "<tag>", newStr: '"quoted"' },
      }],
    }), 0).join("\n");
    assert.match(md, /- <tag>/);
    assert.match(md, /\+ "quoted"/);
  });

  test("parsed session maps Edit and Write tool calls into Changes section", () => {
    const session = {
      stats: minimalStats(),
      startTime: "2026-01-01T00:00:00.000Z",
      events: [
        { type: "user", text: "patch files", timestamp: "2026-01-01T00:00:00.000Z" },
        {
          type: "assistant",
          text: "done",
          timestamp: "2026-01-01T00:00:01.000Z",
          toolCalls: [
            { id: "e1", name: "Edit", input: "/proj/x.js", diffInfo: { oldStr: "old", newStr: "new" } },
            { id: "w1", name: "Write", input: "/proj/y.js", diffInfo: { content: "fresh" } },
          ],
        },
        { type: "tool_result", toolUseId: "e1", text: "ok", timestamp: "2026-01-01T00:00:02.000Z" },
        { type: "tool_result", toolUseId: "w1", text: "ok", timestamp: "2026-01-01T00:00:03.000Z" },
      ],
    };
    const md = buildMarkdownChapterSections(session).join("\n");
    assert.match(md, /### Changes/);
    assert.match(md, /x\.js.*\(edit\)/s);
    assert.match(md, /y\.js.*\(write\)/s);
    assert.match(md, /- old/);
    assert.match(md, /fresh/);
  });
});

describe("markdown-export MCP blocks", () => {
  test("successful MCP shows OK status with params and output preview", () => {
    const md = renderMarkdownChapter(emptyChapter({
      mcpOps: [{
        server: "docs_server",
        tool: "fetch_page",
        params: { url: "https://docs.example", depth: 2 },
        ok: true,
        output: "line one\nline two\nline three",
      }],
    }), 0).join("\n");
    assert.match(md, /### Integrations \(MCP\)/);
    assert.match(md, /\[OK\]/);
    assert.match(md, /docs server.*fetch page/s);
    assert.match(md, /url: https:\/\/docs\.example/);
    assert.match(md, /depth: 2/);
    assert.match(md, /> line one line two/);
  });

  test("MCP without params omits parameter line", () => {
    const md = renderMarkdownChapter(emptyChapter({
      mcpOps: [{ server: "bare", tool: "ping", params: {}, ok: true, output: "pong" }],
    }), 0).join("\n");
    assert.match(md, /\[OK\].*`bare`/);
    assert.doesNotMatch(md, /url:/);
    assert.match(md, /> pong/);
  });

  test("failed MCP truncates long output preview", () => {
    const longOut = "x".repeat(200);
    const md = renderMarkdownChapter(emptyChapter({
      mcpOps: [{ server: "srv", tool: "run", params: { q: "a" }, ok: false, output: longOut }],
    }), 0).join("\n");
    assert.match(md, /\[FAIL\]/);
    const preview = md.match(/>\s*(.+)/)?.[1] ?? "";
    assert.ok(preview.length <= 120);
    assert.ok(preview.includes("x"));
  });

  test("more than ten MCP ops adds no overflow note but caps listed entries", () => {
    const mcpOps = Array.from({ length: 12 }, (_, i) => ({
      server: `srv${i}`,
      tool: `tool${i}`,
      params: {},
      ok: true,
      output: "",
    }));
    const md = renderMarkdownChapter(emptyChapter({ mcpOps }), 0).join("\n");
    assert.equal((md.match(/\[OK\]/g) || []).length, 10);
    assert.doesNotMatch(md, /srv10/);
    assert.doesNotMatch(md, /more MCP/i);
  });

  test("rich session MCP block includes server arrow tool and result text", () => {
    const md = buildMarkdownChapterSections(richSession()).join("\n");
    assert.match(md, /### Integrations \(MCP\)/);
    assert.match(md, /\[OK\].*`my server`.*search/s);
    assert.match(md, /q: test/);
    assert.match(md, /> mcp output line/);
  });

  test("MCP error from tool_result surfaces FAIL in chapter export", () => {
    const session = {
      stats: minimalStats({ errors: 1 }),
      startTime: "2026-01-01T00:00:00.000Z",
      events: [
        { type: "user", text: "call mcp", timestamp: "2026-01-01T00:00:00.000Z" },
        {
          type: "assistant",
          text: "trying",
          timestamp: "2026-01-01T00:00:01.000Z",
          toolCalls: [{
            id: "m1",
            name: "mcp_run",
            input: "",
            mcpInfo: { server: "fail_srv", tool: "boom", rawName: "mcp_run", params: { id: 1 } },
          }],
        },
        { type: "tool_result", toolUseId: "m1", text: "timeout", isError: true, timestamp: "2026-01-01T00:00:02.000Z" },
      ],
    };
    const md = buildMarkdownChapterSections(session).join("\n");
    assert.match(md, /\[FAIL\].*`fail srv`/);
    assert.match(md, /> timeout/);
  });
});

describe("markdown-export web sections", () => {
  test("search lists up to three markdown links from results", () => {
    const results = Array.from({ length: 5 }, (_, i) => ({
      title: `Hit ${i + 1}`,
      url: `https://example.com/${i + 1}`,
    }));
    const md = renderMarkdownChapter(emptyChapter({
      webOps: [{ type: "search", query: "wide query", results }],
    }), 0).join("\n");
    assert.match(md, /### Web/);
    assert.match(md, /\*\*Search\*\* "wide query"/);
    assert.match(md, /\[Hit 1\]/);
    assert.match(md, /\[Hit 3\]/);
    assert.doesNotMatch(md, /\[Hit 4\]/);
    assert.doesNotMatch(md, /\[Hit 5\]/);
  });

  test("search without results still renders query line", () => {
    const md = renderMarkdownChapter(emptyChapter({
      webOps: [{ type: "search", query: "no hits", results: [] }],
    }), 0).join("\n");
    assert.match(md, /\*\*Search\*\* "no hits"/);
    assert.doesNotMatch(md, /\]\(https?:\/\//);
  });

  test("fetch with url only omits title and prompt lines", () => {
    const md = renderMarkdownChapter(emptyChapter({
      webOps: [{ type: "fetch", url: "https://bare.example/page" }],
    }), 0).join("\n");
    assert.match(md, /\*\*Fetch\*\* https:\/\/bare\.example\/page/);
    assert.doesNotMatch(md, /—/);
    assert.doesNotMatch(md, /\n  \*/);
  });

  test("fetch includes page title and italicized prompt when present", () => {
    const md = renderMarkdownChapter(emptyChapter({
      webOps: [{
        type: "fetch",
        url: "https://example.com",
        pageTitle: "Example Page",
        prompt: "extract headings",
      }],
    }), 0).join("\n");
    assert.match(md, /\*\*Fetch\*\* https:\/\/example\.com — Example Page/);
    assert.match(md, /\*extract headings\*/);
  });

  test("more than six web ops lists only first six entries", () => {
    const webOps = Array.from({ length: 8 }, (_, i) => ({
      type: "search",
      query: `q${i}`,
      results: [],
    }));
    const md = renderMarkdownChapter(emptyChapter({ webOps }), 0).join("\n");
    assert.match(md, /"q0"/);
    assert.match(md, /"q5"/);
    assert.doesNotMatch(md, /"q6"/);
    assert.doesNotMatch(md, /"q7"/);
  });

  test("web titles and queries preserve special characters unescaped", () => {
    const md = renderMarkdownChapter(emptyChapter({
      webOps: [{
        type: "search",
        query: 'foo & "bar"',
        results: [{ title: "Title <ok>", url: "https://x.example/?a=1&b=2" }],
      }],
    }), 0).join("\n");
    assert.match(md, /"foo & "bar""/);
    assert.match(md, /\[Title <ok>\]\(https:\/\/x\.example\/\?a=1&b=2\)/);
  });

  test("parsed WebFetch derives page title from markdown heading in result", () => {
    const session = {
      stats: minimalStats(),
      startTime: "2026-01-01T00:00:00.000Z",
      events: [
        { type: "user", text: "fetch", timestamp: "2026-01-01T00:00:00.000Z" },
        {
          type: "assistant",
          text: "fetched",
          timestamp: "2026-01-01T00:00:01.000Z",
          toolCalls: [{
            id: "wf1",
            name: "WebFetch",
            input: "https://site.example",
            webInfo: { type: "fetch", url: "https://site.example", prompt: "read intro" },
          }],
        },
        {
          type: "tool_result",
          toolUseId: "wf1",
          text: "# Landing Page\n\nBody text here.",
          timestamp: "2026-01-01T00:00:02.000Z",
        },
      ],
    };
    const md = buildMarkdownChapterSections(session).join("\n");
    assert.match(md, /### Web/);
    assert.match(md, /Landing Page/);
    assert.match(md, /\*read intro\*/);
  });

  test("rich session web section includes search links and fetch prompt", () => {
    const md = buildMarkdownChapterSections(richSession()).join("\n");
    assert.match(md, /### Web/);
    assert.match(md, /\*\*Search\*\* "tracequest"/);
    assert.match(md, /\[Result & <ok>\]/);
    assert.match(md, /\*\*Fetch\*\* https:\/\/example\.com/);
    assert.match(md, /\*summarize\*/);
  });
});

describe("markdown-export buildMarkdownChapterSections", () => {
  test("renders git, files, web, mcp, and subagents from parsed session events", () => {
    const md = buildMarkdownChapterSections(richSession()).join("\n");
    assert.match(md, /^---/);
    assert.match(md, /## Chapter 1/);
    assert.match(md, /### Git/);
    assert.match(md, /### Files/);
    assert.match(md, /### Changes/);
    assert.match(md, /### Commands/);
    assert.match(md, /### Errors/);
    assert.match(md, /### Web/);
    assert.match(md, /### Integrations \(MCP\)/);
    assert.match(md, /### Subagents/);
    assert.match(md, /Result & <ok>/);
  });

  test("emits multiple chapter headings for multi-prompt sessions", () => {
    const session = {
      stats: minimalStats({ userMessages: 2 }),
      startTime: "2026-01-01T00:00:00.000Z",
      events: [
        { type: "user", text: "first", timestamp: "2026-01-01T00:00:00.000Z" },
        { type: "assistant", text: "a1", timestamp: "2026-01-01T00:00:01.000Z" },
        { type: "user", text: "second", timestamp: "2026-01-01T00:01:00.000Z" },
        { type: "assistant", text: "a2", timestamp: "2026-01-01T00:01:01.000Z" },
      ],
    };
    const md = buildMarkdownChapterSections(session).join("\n");
    assert.match(md, /## Chapter 1/);
    assert.match(md, /> first/);
    assert.match(md, /## Chapter 2/);
    assert.match(md, /> second/);
    assert.match(md, /### Response[\s\S]*a2/);
  });

  test("empty events yield separator only without chapter headings", () => {
    const md = buildMarkdownChapterSections({
      stats: minimalStats({ userMessages: 0, assistantTurns: 0, toolCounts: {} }),
      events: [],
    }).join("\n");
    assert.match(md, /^---/);
    assert.doesNotMatch(md, /## Chapter/);
  });

  test("assistant-only session yields synthetic subagent chapter", () => {
    const md = buildMarkdownChapterSections({
      stats: minimalStats({ userMessages: 0, assistantTurns: 1, toolCounts: {} }),
      events: [{ type: "assistant", text: "orphan reply", timestamp: "2026-01-01T00:00:00.000Z" }],
    }).join("\n");
    assert.match(md, /## Chapter 1/);
    assert.match(md, /> \(subagent session\)/);
    assert.match(md, /orphan reply/);
  });
});

describe("markdown-export compare-style session headers", () => {
  test("distinct sessions get eight-char ids and differing summary counts", () => {
    const idA = "019e47cd-151a-75d1-8f42-53efb31db13f";
    const idB = "019e4786-aaaa-bbbb-cccc-ddddeeeeffff";
    const headerA = joinMarkdownHeader({
      sessionId: idA,
      model: "claude-sonnet",
      stats: minimalStats({ userMessages: 2, assistantTurns: 4 }),
    });
    const headerB = joinMarkdownHeader({
      sessionId: idB,
      model: "codex",
      stats: minimalStats({ userMessages: 5, assistantTurns: 1 }),
    });
    assert.match(headerA, /^# Session 019e47cd/);
    assert.match(headerB, /^# Session 019e4786/);
    assert.notEqual(headerA.split("\n")[0], headerB.split("\n")[0]);
    assert.match(headerA, /\*\*Prompts:\*\* 2/);
    assert.match(headerB, /\*\*Prompts:\*\* 5/);
  });

  test("headers share Summary structure for side-by-side diffing", () => {
    for (const id of ["aaaaaaaa-1111", "bbbbbbbb-2222"]) {
      const hdr = joinMarkdownHeader({ sessionId: id, stats: minimalStats() });
      assert.match(hdr, /^# Session /);
      assert.match(hdr, /## Summary/);
      assert.match(hdr, /\*\*Prompts:\*\*/);
      assert.match(hdr, /\*\*Turns:\*\*/);
      assert.match(hdr, /\*\*Tool calls:\*\*/);
    }
  });
});

describe("markdown-export generateMarkdown", () => {
  test("joins header, chapters, and tracequest footer", () => {
    const md = generateMarkdown(richSession());
    assert.match(md, /^# Session 019e47cd/);
    assert.match(md, /## Summary/);
    assert.match(md, /## Chapter 1/);
    assert.match(md, /Exported from \[tracequest\]/);
    assert.ok(md.endsWith("\n") || md.includes("\n"));
  });

  test("buildMarkdownFooter is stable shape", () => {
    const footer = buildMarkdownFooter().join("\n");
    assert.match(footer, /Exported from \[tracequest\]/);
    assert.match(footer, /on \d/);
  });

  test("handles empty events without throwing", () => {
    const session = {
      sessionId: "empty000",
      stats: minimalStats({ userMessages: 0, assistantTurns: 0, toolCounts: {} }),
      events: [],
    };
    const md = generateMarkdown(session);
    assert.match(md, /^# Session empty000/);
    assert.doesNotMatch(md, /## Chapter 1/);
    assert.match(md, /Exported from \[tracequest\]/);
  });

  test("stats-only empty session exports header and footer without metadata or chapter bodies", () => {
    const md = generateMarkdown({
      stats: minimalStats({
        userMessages: 0,
        assistantTurns: 0,
        toolCounts: {},
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheHit: 0,
      }),
    });
    assert.match(md, /^# Session unknown/);
    assert.match(md, /## Summary/);
    assert.doesNotMatch(md, /\*\*Model:\*\*/);
    assert.doesNotMatch(md, /## Chapter/);
    assert.match(md, /^---$/m);
    assert.match(md, /Exported from \[tracequest\]/);
  });

  test("unicode prompt and output survive export intact", () => {
    const session = {
      stats: minimalStats(),
      startTime: "2026-01-01T00:00:00.000Z",
      events: [
        { type: "user", text: "café naïve 日本語 🎉", timestamp: "2026-01-01T00:00:00.000Z" },
        { type: "assistant", text: "réponse ✓", timestamp: "2026-01-01T00:00:01.000Z" },
      ],
    };
    const md = generateMarkdown(session);
    assert.match(md, /> café naïve 日本語 🎉/);
    assert.match(md, /réponse ✓/);
  });

  test("full document order is header then chapters then footer", () => {
    const md = generateMarkdown(richSession());
    const headerIdx = md.indexOf("## Summary");
    const chapterIdx = md.indexOf("## Chapter 1");
    const footerIdx = md.indexOf("Exported from [tracequest]");
    assert.ok(headerIdx >= 0 && chapterIdx > headerIdx && footerIdx > chapterIdx);
  });
});
describe("markdown export cursor null-id error isolation", () => {
  function cursorErrorSession() {
    return {
      sessionId: "cursor-null-id-session-0001",
      model: "gpt-5",
      source: "cursor",
      startTime: "2026-01-01T00:00:00.000Z",
      stats: minimalStats({ errors: 1, toolCounts: { Bash: 2 } }),
      events: [
        { type: "user", text: "run things", timestamp: "2026-01-01T00:00:00.000Z" },
        {
          type: "assistant",
          text: "running",
          timestamp: "2026-01-01T00:00:01.000Z",
          toolCalls: [
            { id: null, name: "Bash", input: "ls" },
            { id: null, name: "Bash", input: "pwd" },
          ],
        },
        {
          type: "tool_result",
          toolUseId: null,
          isError: true,
          text: "User aborted request",
          timestamp: "2026-01-01T00:00:02.000Z",
        },
      ],
    };
  }

  test("turn error does not mark every command FAIL and is listed once as a session error", () => {
    const md = generateMarkdown(cursorErrorSession());
    assert.ok(!md.includes("[FAIL]"), "no per-command FAIL markers expected");
    assert.match(md, /\*\*\[ok\]\*\* `ls`/);
    assert.match(md, /\*\*\[ok\]\*\* `pwd`/);
    const errorsIdx = md.indexOf("### Errors");
    assert.ok(errorsIdx >= 0, "Errors section expected");
    assert.match(md, /- \*\*session:\*\* User aborted request/);
    // listed exactly once, and not attributed to a tool command
    assert.equal(md.split("User aborted request").length, 2);
    assert.ok(!md.includes("- `ls`"), "error must not be attributed to a command");
  });
});
