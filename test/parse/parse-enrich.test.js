import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeToolName,
  summarizeInput,
  enrichToolEvent,
  extractToolResultText,
  extractMcpInfo,
  extractWebInfo,
  extractAgentInfo,
  isMcpTool,
  isWebTool,
  isAgentTool,
  errorPattern,
} from "../../src/parse/parse-enrich.js";

describe("normalizeToolName", () => {
  test("maps shell execution variants to Bash", () => {
    for (const name of ["bash", "shell", "exec_command", "run_terminal_command", "write_stdin"]) {
      assert.equal(normalizeToolName(name), "Bash");
    }
  });

  test("maps read, write, edit, grep, and glob families", () => {
    assert.equal(normalizeToolName("read_file"), "Read");
    assert.equal(normalizeToolName("create_file"), "Write");
    assert.equal(normalizeToolName("apply_patch"), "Edit");
    assert.equal(normalizeToolName("ripgrep"), "Grep");
    assert.equal(normalizeToolName("list_dir"), "Glob");
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
    assert.equal(normalizeToolName("custom_tool"), "Custom_tool");
    assert.equal(normalizeToolName("FooBar"), "FooBar");
  });

  test("maps web, memory, plan, and agent aliases", () => {
    assert.equal(normalizeToolName("web_search"), "WebSearch");
    assert.equal(normalizeToolName("browser_tab"), "WebFetch");
    assert.equal(normalizeToolName("memory_search"), "Memory");
    assert.equal(normalizeToolName("enter_plan_mode"), "Plan");
    assert.equal(normalizeToolName("spawn_subagent"), "Agent");
    assert.equal(normalizeToolName("todo_write"), "TodoWrite");
  });
});

describe("summarizeInput", () => {
  test("extracts Bash, Read, Write, and Edit paths", () => {
    assert.equal(summarizeInput("Bash", { command: "npm test" }), "npm test");
    assert.equal(summarizeInput("Bash", { cmd: "echo hi" }), "echo hi");
    assert.equal(summarizeInput("Read", { target_file: "/x.js" }), "/x.js");
    assert.equal(summarizeInput("Write", { filePath: "out.txt" }), "out.txt");
    assert.equal(summarizeInput("Edit", { path: "src/a.js" }), "src/a.js");
  });

  test("formats Grep, Glob, and Agent summaries", () => {
    assert.equal(summarizeInput("Grep", { pattern: "foo", path: "/proj" }), "foo /proj");
    assert.equal(summarizeInput("Glob", { target_directory: "/tmp" }), "/tmp");
    assert.equal(summarizeInput("Agent", { description: "scan repo" }), "scan repo");
    assert.equal(summarizeInput("Agent", { prompt: "x".repeat(120) }), "x".repeat(100));
  });

  test("summarizes Skill, TaskCreate, TaskUpdate, and web tools", () => {
    assert.equal(summarizeInput("Skill", { skill: "lint" }), "lint");
    assert.equal(summarizeInput("TaskCreate", { subject: "Fix bug" }), "Fix bug");
    assert.equal(summarizeInput("TaskUpdate", { id: "t1", status: "done" }), "t1 → done");
    assert.equal(summarizeInput("WebFetch", { url: "https://ex.com" }), "https://ex.com");
    assert.equal(summarizeInput("WebSearch", { query: "tracequest" }), "tracequest");
    assert.equal(summarizeInput("ToolSearch", { query: "grep" }), "grep");
  });

  test("MCP summarize prefers path, query, url, then content slice", () => {
    const name = "mcp__srv__tool";
    assert.equal(summarizeInput(name, { path: "/a" }), "/a");
    assert.equal(summarizeInput(name, { query: "q" }), "q");
    assert.equal(summarizeInput(name, { content: "y".repeat(200) }), "y".repeat(100));
  });

  test("summarizes Cursor SemanticSearch, Delete, Await, and Ask", () => {
    assert.equal(summarizeInput("SemanticSearch", { query: "how does auth work?" }), "how does auth work?");
    assert.equal(summarizeInput("Delete", { path: "/proj/old.js" }), "/proj/old.js");
    assert.equal(summarizeInput("Await", { task_id: "286390", block_until_ms: 600000 }), "task 286390");
    assert.equal(summarizeInput("Await", { block_until_ms: 900000 }), "wait 900000ms");
    assert.equal(summarizeInput("Await", {}), "");
    assert.equal(summarizeInput("Ask", { questions: [{ question: "Which env?" }, { question: "x" }] }), "Which env?");
    assert.equal(summarizeInput("Ask", { questions: [] }), "");
    assert.equal(summarizeInput("Ask", {}), "");
  });

  test("summarizes CallMcpTool as server/tool with argument preview", () => {
    const s = summarizeInput("CallMcpTool", {
      server: "linear", toolName: "list_issues", arguments: { query: "bugs" },
    });
    assert.equal(s, 'linear/list_issues {"query":"bugs"}');
    assert.equal(summarizeInput("CallMcpTool", { server: "linear", toolName: "list_issues" }), "linear/list_issues");
    // Malformed input falls back to JSON slice rather than throwing
    assert.equal(summarizeInput("CallMcpTool", { foo: 1 }), '{"foo":1}');
  });

  test("returns empty string for missing input and JSON for unknown tools", () => {
    assert.equal(summarizeInput("Bash", null), "");
    assert.equal(summarizeInput("Custom", { a: 1, b: 2 }), '{"a":1,"b":2}');
  });
});

describe("extractToolResultText", () => {
  test("returns string content as-is", () => {
    assert.equal(extractToolResultText("plain result"), "plain result");
  });

  test("joins text blocks from content arrays", () => {
    const content = [
      { type: "image", data: "x" },
      { type: "text", text: "line1" },
      { type: "text", text: "line2" },
    ];
    assert.equal(extractToolResultText(content), "line1\nline2");
  });

  test("joins Codex input_text / output_text blocks instead of stringifying objects", () => {
    const content = [
      { type: "input_text", text: "Script completed\n" },
      { type: "input_text", text: "hello stdout" },
      { type: "output_text", text: "trailer" },
    ];
    assert.equal(extractToolResultText(content), "Script completed\n\nhello stdout\ntrailer");
    assert.doesNotMatch(extractToolResultText(content), /\[object Object\]/);
  });

  test("returns empty string for null, number, or empty array", () => {
    assert.equal(extractToolResultText(null), "");
    assert.equal(extractToolResultText(42), "");
    assert.equal(extractToolResultText([]), "");
  });
});

describe("MCP helpers", () => {
  test("isMcpTool detects mcp__ prefix only on strings", () => {
    assert.ok(isMcpTool("mcp__a__b"));
    assert.ok(!isMcpTool("bash"));
    assert.ok(!isMcpTool(null));
  });

  test("extractMcpInfo parses server and tool from compound names", () => {
    const info = extractMcpInfo("mcp__org_srv__send_mail", {
      subject: "Hello",
      recipient: "user@example.com",
      url: "https://mail.test",
    });
    assert.equal(info.server, "org_srv");
    assert.equal(info.tool, "send_mail");
    assert.equal(info.params.subject, "Hello");
    assert.equal(info.params.recipient, "user@example.com");
    assert.equal(info.params.url, "https://mail.test");
  });

  test("extractMcpInfo falls back to first scalar keys when no known params", () => {
    const info = extractMcpInfo("mcp__srv__x", { limit: 10, active: true, note: "ok" });
    assert.equal(info.params.limit, "10");
    assert.equal(info.params.active, "true");
    assert.equal(info.params.note, "ok");
  });

  test("extractMcpInfo returns null for non-MCP or missing input", () => {
    assert.equal(extractMcpInfo("Read", { path: "/x" }), null);
    assert.equal(extractMcpInfo("mcp__a__b", null), null);
  });
});

describe("web and agent helpers", () => {
  test("isWebTool matches fetch and search aliases", () => {
    assert.ok(isWebTool("web_fetch"));
    assert.ok(isWebTool("WebSearch"));
    assert.ok(!isWebTool("Read"));
  });

  test("extractWebInfo returns fetch shape with prompt slice", () => {
    assert.deepEqual(extractWebInfo("web_fetch", { url: "https://u", prompt: "p".repeat(300) }), {
      type: "fetch",
      url: "https://u",
      prompt: "p".repeat(200),
    });
  });

  test("extractWebInfo returns search shape", () => {
    assert.deepEqual(extractWebInfo("WebSearch", { query: "docs" }), {
      type: "search",
      query: "docs",
    });
  });

  test("isAgentTool covers agent, task, dispatch, and skill names", () => {
    for (const n of ["agent", "task", "dispatch_agent", "skill", "TaskCreate"]) {
      assert.ok(isAgentTool(n), n);
    }
    assert.ok(!isAgentTool("Read"));
  });

  test("extractAgentInfo uses subject as title and description as prompt", () => {
    const long = "Long ".repeat(70);
    const info = extractAgentInfo("TaskCreate", {
      subject: "Short",
      description: long,
    });
    assert.equal(info.description, "Short");
    assert.equal(info.prompt.length, 300);
    assert.equal(info.prompt, long.slice(0, 300));
  });

  test("extractAgentInfo uses description and prompt for Agent tools", () => {
    const info = extractAgentInfo("agent", {
      description: "sub",
      prompt: "work",
      subagent_type: "explore",
    });
    assert.equal(info.description, "sub");
    assert.equal(info.prompt, "work");
    assert.equal(info.subagentType, "explore");
  });
});

describe("enrichToolEvent", () => {
  test("normalizes name and summarizes Bash input", () => {
    const tc = enrichToolEvent({
      id: "t1",
      rawName: "bash",
      input: { command: "git status" },
    });
    assert.equal(tc.id, "t1");
    assert.equal(tc.name, "Bash");
    assert.equal(tc.input, "git status");
    assert.equal(tc.diffInfo, undefined);
  });

  test("attaches Edit diffInfo from old and new strings", () => {
    const tc = enrichToolEvent({
      id: "e1",
      rawName: "edit",
      input: { old_string: "a", new_string: "b", path: "x.js" },
    });
    assert.equal(tc.name, "Edit");
    assert.deepEqual(tc.diffInfo, { oldStr: "a", newStr: "b" });
  });

  test("attaches Write diffInfo from content", () => {
    const tc = enrichToolEvent({
      id: "w1",
      rawName: "write",
      input: { content: "hello", path: "f.txt" },
    });
    assert.deepEqual(tc.diffInfo, { content: "hello" });
  });

  test("attaches mcpInfo, webInfo, and agentInfo when applicable", () => {
    const mcp = enrichToolEvent({
      id: "m1",
      rawName: "mcp__srv__tool",
      input: { path: "/tmp/x" },
    });
    assert.equal(mcp.mcpInfo.server, "srv");
    assert.equal(mcp.mcpInfo.params.path, "/tmp/x");

    const web = enrichToolEvent({
      id: "ws1",
      rawName: "web_search",
      input: { query: "tracequest" },
    });
    assert.deepEqual(web.webInfo, { type: "search", query: "tracequest" });

    const agent = enrichToolEvent({
      id: "a1",
      rawName: "agent",
      input: { description: "sub", prompt: "do work" },
    });
    assert.equal(agent.agentInfo.description, "sub");
  });

  test("CallMcpTool attaches mcpInfo with object arguments", () => {
    const tc = enrichToolEvent({
      id: "c1",
      rawName: "CallMcpTool",
      input: { server: "plugin-linear-linear", toolName: "list_issues", arguments: { query: "onboarding", limit: 30 } },
    });
    assert.equal(tc.name, "CallMcpTool");
    assert.equal(tc.mcpInfo.server, "plugin-linear-linear");
    assert.equal(tc.mcpInfo.tool, "list_issues");
    assert.equal(tc.mcpInfo.rawName, "CallMcpTool");
    assert.equal(tc.mcpInfo.params.query, "onboarding");
    assert.match(tc.input, /^plugin-linear-linear\/list_issues /);
  });

  test("CallMcpTool parses JSON-string arguments", () => {
    const tc = enrichToolEvent({
      id: "c2",
      rawName: "CallMcpTool",
      input: { server: "srv", toolName: "do_thing", arguments: '{"url":"https://x.test"}' },
    });
    assert.equal(tc.mcpInfo.params.url, "https://x.test");
  });

  test("CallMcpTool tolerates missing server and malformed arguments", () => {
    const noServer = enrichToolEvent({
      id: "c3",
      rawName: "CallMcpTool",
      input: { toolName: "orphan", arguments: "not json" },
    });
    assert.equal(noServer.mcpInfo.server, "");
    assert.equal(noServer.mcpInfo.tool, "orphan");
    assert.deepEqual(noServer.mcpInfo.params, {});

    const noMcpShape = enrichToolEvent({ id: "c4", rawName: "CallMcpTool", input: { foo: 1 } });
    assert.equal(noMcpShape.mcpInfo, undefined);
  });

  test("normalize:false keeps raw tool name without remapping input switch", () => {
    const tc = enrichToolEvent({
      id: "c1",
      rawName: "Edit",
      input: { path: "a.js" },
      normalize: false,
    });
    assert.equal(tc.name, "Edit");
    assert.equal(tc.input, "a.js");
  });

  test("handles missing rawName and input gracefully", () => {
    const tc = enrichToolEvent({ id: "x" });
    assert.equal(tc.name, "unknown");
    assert.equal(tc.input, "");
  });
});

describe("errorPattern", () => {
  test("matches common CLI and JS failure prefixes", () => {
    for (const msg of [
      "Error: boom",
      "exit code 2",
      "command failed",
      "ENOENT: no such file",
      "SyntaxError: unexpected",
    ]) {
      assert.ok(errorPattern.test(msg), msg);
    }
  });

  test("does not match benign success output", () => {
    assert.ok(!errorPattern.test("ok"));
    assert.ok(!errorPattern.test("exit code 0"));
    assert.ok(!errorPattern.test("completed successfully"));
  });
});