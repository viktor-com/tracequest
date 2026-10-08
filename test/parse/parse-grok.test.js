import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { parseGrok, extractUserQuery } from "../../src/parse/parse-grok.js";
import { assertPerf } from "../helpers/perf-assert.js";

const SESSION = "grok-sess-edge";
const CWD = "/home/dev/tracequest";
const TS0 = "2026-06-03T12:00:00.000Z";
const TS1 = "2026-06-03T12:00:30.000Z";
const TS2 = "2026-06-03T12:01:00.000Z";

function writeGrokDir(files, suffix = "edge") {
  const dir = mkdtempSync(join(os.tmpdir(), `parse-grok-${suffix}-`));
  for (const [name, content] of Object.entries(files)) {
    const body =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((row) => (typeof row === "string" ? row : JSON.stringify(row))).join("\n") + "\n"
          : JSON.stringify(content);
    writeFileSync(join(dir, name), body.endsWith("\n") ? body : body + "\n", "utf8");
  }
  return dir;
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

describe("extractUserQuery", () => {
  test("plain text and user_query tag extraction", () => {
    assert.equal(extractUserQuery("plain question"), "plain question");
    assert.equal(extractUserQuery("<user_query>inner prompt</user_query>"), "inner prompt");
    assert.equal(extractUserQuery("<system>hidden</system>"), null);
    assert.equal(extractUserQuery("<user_query><local>xml</local></user_query>"), null);
  });

  test("command-args and command-message wrappers inside user_query", () => {
    assert.equal(
      extractUserQuery("<user_query><command-args>run tests</command-args></user_query>"),
      "run tests",
    );
    assert.equal(
      extractUserQuery("<user_query><command-message>deploy prod</command-message></user_query>"),
      "deploy prod",
    );
  });
});

describe("parseGrok events.jsonl and chat_history", () => {
  test("prompt_context.json sets cwd and default model", () => {
    const dir = writeGrokDir({
      "prompt_context.json": { working_directory: CWD, model_id: "grok-beta" },
      "events.jsonl": [{ type: "turn_started", session_id: SESSION, ts: TS0 }],
      "chat_history.jsonl": [{ type: "user", content: "hello grok" }],
    });
    try {
      const sess = parseGrok(dir);
      assert.equal(sess.cwd, CWD);
      assert.equal(sess.model, "grok-beta");
      assert.equal(sess.sessionId, SESSION);
    } finally {
      cleanup(dir);
    }
  });

  test("events.jsonl turn_started and turn_ended drive session id and timestamp backfill", () => {
    const dir = writeGrokDir({
      "events.jsonl": [
        { type: "turn_started", session_id: SESSION, model_id: "grok-live", ts: TS0 },
        { type: "turn_ended", ts: TS1 },
        { type: "turn_started", session_id: SESSION, ts: TS1 },
        { type: "turn_ended", ts: TS2 },
      ],
      "chat_history.jsonl": [
        { type: "user", content: "turn one" },
        { type: "assistant", content: "reply one" },
        { type: "user", content: "turn two" },
        { type: "assistant", content: "reply two" },
      ],
    });
    try {
      const sess = parseGrok(dir);
      assert.equal(sess.model, "grok-live");
      const users = sess.events.filter((e) => e.type === "user");
      assert.equal(users.length, 2);
      assert.equal(users[0].timestamp, TS0);
      assert.equal(users[1].timestamp, TS1);
    } finally {
      cleanup(dir);
    }
  });

  test("does not double-count tools when events.jsonl and chat_history both record them", () => {
    const dir = writeGrokDir({
      "events.jsonl": [
        { type: "turn_started", session_id: SESSION, ts: TS0 },
        { type: "tool_started", tool_name: "bash", ts: TS0 },
        { type: "tool_completed", tool_name: "bash", outcome: "success", ts: TS0 },
        { type: "tool_started", tool_name: "read", ts: TS0 },
        { type: "tool_completed", tool_name: "read", outcome: "success", ts: TS0 },
      ],
      "chat_history.jsonl": [
        { type: "user", content: "dual source" },
        {
          type: "assistant",
          content: "run",
          tool_calls: [
            { id: "b1", name: "bash", arguments: "{}" },
            { id: "r1", name: "read_file", arguments: "{}" },
          ],
        },
        { type: "tool_result", tool_call_id: "b1", content: "ok" },
        { type: "tool_result", tool_call_id: "r1", content: "ok" },
      ],
    }, "no-dc");
    try {
      const sess = parseGrok(dir);
      assert.deepEqual(sess.stats.toolCounts, { Bash: 1, Read: 1 });
      assert.equal(sess.events.filter((e) => e.type === "tool_result").length, 2);
    } finally {
      cleanup(dir);
    }
  });

  test("events.jsonl tool_started and tool_completed correlate error outcomes with tool_result", () => {
    const dir = writeGrokDir({
      "events.jsonl": [
        { type: "turn_started", session_id: SESSION, ts: TS0 },
        { type: "tool_started", tool_name: "bash", ts: TS0 },
        { type: "tool_completed", tool_name: "bash", outcome: "error", duration_ms: 42, ts: TS0 },
      ],
      "chat_history.jsonl": [
        { type: "user", content: "run cmd" },
        {
          type: "assistant",
          content: "running",
          tool_calls: [{ id: "tc-bash", name: "bash", arguments: '{"command":"false"}' }],
        },
        { type: "tool_result", tool_call_id: "tc-bash", content: "stderr output" },
      ],
    });
    try {
      const sess = parseGrok(dir);
      const tr = sess.events.find((e) => e.type === "tool_result");
      assert.equal(tr.isError, true);
      assert.equal(tr.toolUseId, "tc-bash");
      const asst = sess.events.find((e) => e.type === "assistant");
      assert.equal(asst.toolCalls[0].name, "Bash");
      assert.equal(sess.stats.toolCounts.Bash, 1);
      assert.equal(sess.stats.errors, 1);
    } finally {
      cleanup(dir);
    }
  });

  test("web_search tool_name in events.jsonl normalizes to WebSearch on assistant turn", () => {
    const dir = writeGrokDir({
      "events.jsonl": [
        { type: "turn_started", session_id: SESSION, ts: TS0 },
        { type: "tool_started", tool_name: "web_search", ts: TS0 },
        { type: "tool_completed", tool_name: "web_search", outcome: "success", duration_ms: 10, ts: TS0 },
      ],
      "chat_history.jsonl": [
        { type: "user", content: "search docs" },
        { type: "assistant", content: "searching" },
        { type: "tool_result", tool_call_id: "ws-1", content: '{"results":[]}' },
      ],
    });
    try {
      const sess = parseGrok(dir);
      const asst = sess.events.find((e) => e.type === "assistant");
      assert.equal(asst.toolCalls[0].name, "WebSearch");
      assert.equal(sess.stats.toolCounts.WebSearch, 1);
    } finally {
      cleanup(dir);
    }
  });

  test("skips user events when extractUserQuery yields empty or null", () => {
    const dir = writeGrokDir({
      "events.jsonl": [{ type: "turn_started", session_id: SESSION, ts: TS0 }],
      "chat_history.jsonl": [
        { type: "user", content: "" },
        { type: "user", content: "   \n" },
        { type: "user", content: "<user_query></user_query>" },
        { type: "user", content: "<system>hidden</system>" },
        { type: "user", content: "valid prompt" },
      ],
    });
    try {
      const users = parseGrok(dir).events.filter((e) => e.type === "user");
      assert.equal(users.length, 1);
      assert.equal(users[0].text, "valid prompt");
    } finally {
      cleanup(dir);
    }
  });

  test("truncates long plain user messages to 500 chars via safeSlice", () => {
    const long = "a".repeat(600);
    const dir = writeGrokDir({
      "events.jsonl": [{ type: "turn_started", session_id: SESSION, ts: TS0 }],
      "chat_history.jsonl": [{ type: "user", content: long }],
    });
    try {
      const user = parseGrok(dir).events.find((e) => e.type === "user");
      // Content is cut to 500 chars and a visible marker reports the drop (was silent).
      assert.ok(user.text.startsWith("a".repeat(500)));
      assert.match(user.text, /\[truncated 100 chars\]$/);
    } finally {
      cleanup(dir);
    }
  });

  test("user content array with user_query in text block extracts prompt", () => {
    const dir = writeGrokDir({
      "events.jsonl": [{ type: "turn_started", session_id: SESSION, ts: TS0 }],
      "chat_history.jsonl": [
        {
          type: "user",
          content: [
            { type: "text", text: "<user_query>from array</user_query>" },
            { type: "image", url: "ignored.png" },
          ],
        },
      ],
    });
    try {
      const user = parseGrok(dir).events.find((e) => e.type === "user");
      assert.equal(user.text, "from array");
    } finally {
      cleanup(dir);
    }
  });

  test("user content array with only non-text blocks produces no user event", () => {
    const dir = writeGrokDir({
      "events.jsonl": [{ type: "turn_started", session_id: SESSION, ts: TS0 }],
      "chat_history.jsonl": [
        {
          type: "user",
          content: [
            { type: "image", url: "x.png" },
            { type: "tool_use", id: "tu-1" },
          ],
        },
        { type: "assistant", content: "ok" },
      ],
    });
    try {
      const sess = parseGrok(dir);
      assert.equal(sess.events.filter((e) => e.type === "user").length, 0);
      assert.equal(sess.stats.userMessages, 0);
    } finally {
      cleanup(dir);
    }
  });

  test("command-message inside user_query is extracted through parseGrok", () => {
    const dir = writeGrokDir({
      "events.jsonl": [{ type: "turn_started", session_id: SESSION, ts: TS0 }],
      "chat_history.jsonl": [
        {
          type: "user",
          content: "<user_query><command-message>run npm test</command-message></user_query>",
        },
      ],
    });
    try {
      const user = parseGrok(dir).events.find((e) => e.type === "user");
      assert.equal(user.text, "run npm test");
    } finally {
      cleanup(dir);
    }
  });

  test("chat_history user_query tag extracts visible prompt; XML-only content skipped", () => {
    const dir = writeGrokDir({
      "events.jsonl": [{ type: "turn_started", session_id: SESSION, ts: TS0 }],
      "chat_history.jsonl": [
        { type: "user", content: "<user_query>ship the feature</user_query>" },
        { type: "user", content: "<user_query><command-args>lint all</command-args></user_query>" },
        { type: "user", content: "<system>do not show</system>" },
      ],
    });
    try {
      const users = parseGrok(dir).events.filter((e) => e.type === "user");
      assert.equal(users.length, 2);
      assert.equal(users[0].text, "ship the feature");
      assert.equal(users[1].text, "lint all");
    } finally {
      cleanup(dir);
    }
  });

  test("user content array blocks join text parts", () => {
    const dir = writeGrokDir({
      "events.jsonl": [{ type: "turn_started", session_id: SESSION, ts: TS0 }],
      "chat_history.jsonl": [
        {
          type: "user",
          content: [
            { type: "text", text: "line one" },
            { type: "text", text: "line two" },
          ],
        },
      ],
    });
    try {
      const user = parseGrok(dir).events.find((e) => e.type === "user");
      assert.equal(user.text, "line one\nline two");
    } finally {
      cleanup(dir);
    }
  });

  test("assistant OpenAI-style tool_calls enrich Read path from arguments", () => {
    const dir = writeGrokDir({
      "events.jsonl": [{ type: "turn_started", session_id: SESSION, ts: TS0 }],
      "chat_history.jsonl": [
        { type: "user", content: "read file" },
        {
          type: "assistant",
          model_id: "grok-2",
          content: "opening file",
          tool_calls: [
            { id: "read-1", name: "read_file", arguments: '{"file_path":"/proj/a.js"}' },
          ],
        },
        { type: "tool_result", tool_call_id: "read-1", content: "export const x = 1;" },
      ],
    });
    try {
      const sess = parseGrok(dir);
      assert.equal(sess.model, "grok-2");
      const asst = sess.events.find((e) => e.type === "assistant");
      assert.equal(asst.toolCalls[0].name, "Read");
      assert.equal(asst.toolCalls[0].input, "/proj/a.js");
      assert.equal(asst.stopReason, "tool_use");
      const tr = sess.events.find((e) => e.type === "tool_result");
      assert.equal(tr.text, "export const x = 1;");
    } finally {
      cleanup(dir);
    }
  });

  test("tool_result rows following assistant are consumed; multiple results in one turn", () => {
    const dir = writeGrokDir({
      "events.jsonl": [
        { type: "turn_started", session_id: SESSION, ts: TS0 },
        { type: "tool_started", tool_name: "read", ts: TS0 },
        { type: "tool_completed", tool_name: "read", outcome: "success", ts: TS0 },
        { type: "tool_started", tool_name: "grep", ts: TS0 },
        { type: "tool_completed", tool_name: "grep", outcome: "success", ts: TS0 },
      ],
      "chat_history.jsonl": [
        { type: "user", content: "dual tools" },
        {
          type: "assistant",
          content: "go",
          tool_calls: [
            { id: "r1", name: "read", arguments: "{}" },
            { id: "g1", name: "grep", arguments: '{"pattern":"x"}' },
          ],
        },
        { type: "tool_result", tool_call_id: "r1", content: "read out" },
        { type: "tool_result", tool_call_id: "g1", content: "grep out" },
      ],
    });
    try {
      const results = parseGrok(dir).events.filter((e) => e.type === "tool_result");
      assert.equal(results.length, 2);
      assert.equal(results[0].text, "read out");
      assert.equal(results[1].text, "grep out");
    } finally {
      cleanup(dir);
    }
  });

  test("leading tool_result before any other chat events records result from events.jsonl", () => {
    const dir = writeGrokDir({
      "events.jsonl": [
        { type: "turn_started", session_id: SESSION, ts: TS0 },
        { type: "tool_started", tool_name: "glob", ts: TS0 },
        { type: "tool_completed", tool_name: "glob", outcome: "success", ts: TS0 },
      ],
      "chat_history.jsonl": [
        { type: "tool_result", tool_call_id: "orphan-tr", content: "found 3 files" },
        { type: "assistant", content: "listed files" },
      ],
    });
    try {
      const sess = parseGrok(dir);
      const tr = sess.events.find((e) => e.type === "tool_result");
      assert.equal(tr.text, "found 3 files");
      assert.equal(tr.isError, false);
      const asst = sess.events.find((e) => e.type === "assistant");
      assert.equal(asst.text, "listed files");
      assert.deepEqual(asst.toolCalls, []);
    } finally {
      cleanup(dir);
    }
  });

  test("signals.json contextTokensUsed distributes input tokens across assistant turns", () => {
    const dir = writeGrokDir({
      "events.jsonl": [{ type: "turn_started", session_id: SESSION, ts: TS0 }],
      "signals.json": { contextTokensUsed: 300 },
      "chat_history.jsonl": [
        { type: "user", content: "one" },
        { type: "assistant", content: "a1" },
        { type: "user", content: "two" },
        { type: "assistant", content: "a2" },
      ],
    });
    try {
      const assistants = parseGrok(dir).events.filter((e) => e.type === "assistant");
      assert.equal(assistants.length, 2);
      assert.equal(assistants[0].tokens.input, 150);
      assert.equal(assistants[1].tokens.input, 150);
    } finally {
      cleanup(dir);
    }
  });

  test("invalid signals.json does not crash parse (session still parses chat)", () => {
    const dir = mkdtempSync(join(os.tmpdir(), "parse-grok-bad-signals-"));
    writeFileSync(join(dir, "signals.json"), "{broken", "utf8");
    writeFileSync(
      join(dir, "events.jsonl"),
      JSON.stringify({ type: "turn_started", session_id: SESSION, ts: TS0 }) + "\n",
      "utf8",
    );
    writeFileSync(
      join(dir, "chat_history.jsonl"),
      [
        JSON.stringify({ type: "user", content: "still works" }),
        JSON.stringify({ type: "assistant", content: "a1" }),
        JSON.stringify({ type: "assistant", content: "a2" }),
      ].join("\n") + "\n",
      "utf8",
    );
    try {
      const sess = parseGrok(dir);
      assert.equal(sess.sessionId, SESSION);
      assert.equal(sess.events.find((e) => e.type === "user").text, "still works");
      const assistants = sess.events.filter((e) => e.type === "assistant");
      assert.equal(assistants.length, 2);
      assert.notEqual(assistants[0].tokens.input, 150);
      assert.notEqual(assistants[1].tokens.input, 150);
    } finally {
      cleanup(dir);
    }
  });

  test("logs when signals.json is invalid JSON", () => {
    const dir = mkdtempSync(join(os.tmpdir(), "parse-grok-signals-log-"));
    const signalsPath = join(dir, "signals.json");
    writeFileSync(signalsPath, "not-json-at-all", "utf8");
    writeFileSync(
      join(dir, "events.jsonl"),
      JSON.stringify({ type: "turn_started", session_id: SESSION, ts: TS0 }) + "\n",
      "utf8",
    );
    writeFileSync(
      join(dir, "chat_history.jsonl"),
      JSON.stringify({ type: "user", content: "x" }) + "\n",
      "utf8",
    );
    const errors = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    try {
      parseGrok(dir);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /parseGrok: failed to parse/);
      assert.match(errors[0], /signals\.json/);
    } finally {
      console.error = origError;
      cleanup(dir);
    }
  });

  test("missing signals.json does not log console.error", () => {
    const dir = writeGrokDir({
      "events.jsonl": [{ type: "turn_started", session_id: SESSION, ts: TS0 }],
      "chat_history.jsonl": [{ type: "user", content: "hello" }],
    });
    const errors = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    try {
      parseGrok(dir);
      assert.equal(errors.length, 0);
    } finally {
      console.error = origError;
      cleanup(dir);
    }
  });

  test("invalid signals.json skips contextTokensUsed distribution", () => {
    const dir = writeGrokDir({
      "events.jsonl": [{ type: "turn_started", session_id: SESSION, ts: TS0 }],
      "signals.json": "{truncated",
      "chat_history.jsonl": [
        { type: "user", content: "one" },
        { type: "assistant", content: "a1" },
        { type: "user", content: "two" },
        { type: "assistant", content: "a2" },
      ],
    });
    const errors = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    try {
      const assistants = parseGrok(dir).events.filter((e) => e.type === "assistant");
      assert.equal(assistants.length, 2);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /signals\.json/);
      assert.notEqual(assistants[0].tokens.input, 150);
      assert.notEqual(assistants[1].tokens.input, 150);
    } finally {
      console.error = origError;
      cleanup(dir);
    }
  });

  test("errorPattern in tool_result content marks isError without events outcome", () => {
    const dir = writeGrokDir({
      "events.jsonl": [
        { type: "turn_started", session_id: SESSION, ts: TS0 },
        { type: "tool_started", tool_name: "bash", ts: TS0 },
        { type: "tool_completed", tool_name: "bash", outcome: "success", ts: TS0 },
      ],
      "chat_history.jsonl": [
        { type: "assistant", content: "fail" },
        { type: "tool_result", tool_call_id: "e1", content: "Error: ENOENT no such file" },
      ],
    });
    try {
      const tr = parseGrok(dir).events.find((e) => e.type === "tool_result");
      assert.equal(tr.isError, true);
    } finally {
      cleanup(dir);
    }
  });

  test("invalid prompt_context.json does not crash parse (session still parses chat)", () => {
    const dir = mkdtempSync(join(os.tmpdir(), "parse-grok-bad-ctx-"));
    writeFileSync(join(dir, "prompt_context.json"), "{broken", "utf8");
    writeFileSync(
      join(dir, "events.jsonl"),
      JSON.stringify({ type: "turn_started", session_id: SESSION, ts: TS0 }) + "\n",
      "utf8",
    );
    writeFileSync(
      join(dir, "chat_history.jsonl"),
      JSON.stringify({ type: "user", content: "still works" }) + "\n",
      "utf8",
    );
    try {
      const sess = parseGrok(dir);
      assert.equal(sess.sessionId, SESSION);
      assert.equal(sess.events[0].text, "still works");
      assert.equal(sess.cwd, null);
    } finally {
      cleanup(dir);
    }
  });

  test("empty grok session directory yields grok source with zero events", () => {
    const dir = mkdtempSync(join(os.tmpdir(), "parse-grok-empty-"));
    try {
      const sess = parseGrok(dir);
      assert.equal(sess.source, "grok");
      assert.equal(sess.eventCount, 0);
      assert.equal(sess.model, null);
    } finally {
      cleanup(dir);
    }
  });

  test("system lines in chat_history are ignored", () => {
    const dir = writeGrokDir({
      "events.jsonl": [{ type: "turn_started", session_id: SESSION, ts: TS0 }],
      "chat_history.jsonl": [
        { type: "system", content: "you are a coding agent" },
        { type: "user", content: "real ask" },
      ],
    });
    try {
      const sess = parseGrok(dir);
      assert.equal(sess.stats.userMessages, 1);
      assert.equal(sess.events[0].text, "real ask");
    } finally {
      cleanup(dir);
    }
  });

  test("skips filler stream_chunk rows in events.jsonl without JSON.parse (perf)", () => {
    const dir = mkdtempSync(join(os.tmpdir(), "parse-grok-events-perf-"));
    const lines = [];
    for (let i = 0; i < 8000; i++) {
      lines.push(JSON.stringify({ type: "stream_chunk", payload: "x".repeat(400) }));
    }
    lines.push(
      JSON.stringify({ type: "turn_started", session_id: SESSION, ts: TS0, model_id: "grok-2" }),
      JSON.stringify({ type: "tool_started", tool_name: "read", ts: TS0 }),
      JSON.stringify({ type: "tool_completed", tool_name: "read", outcome: "success", ts: TS0 }),
    );
    writeFileSync(join(dir, "events.jsonl"), lines.join("\n") + "\n", "utf8");
    writeFileSync(
      join(dir, "chat_history.jsonl"),
      JSON.stringify({ type: "user", content: "grok events compact probe" }) + "\n",
      "utf8",
    );
    const src = readFileSync("src/parse/parse-grok.js", "utf8");
    const gateSrc = readFileSync("src/parse/grok-chat-index.js", "utf8");
    assert.match(gateSrc, /stream_chunk filler dominates events\.jsonl volume/);
    const eventsBlock = src.slice(src.indexOf("events.jsonl"));
    assert.match(eventsBlock, /isGrokEventsIndexedLine\s*\(\s*text,\s*start,\s*end\s*\)/);
    assert.match(eventsBlock, /parseJsonlLineAt\s*\(\s*text,\s*start,\s*end\s*\)/);
    assert.match(eventsBlock, /forEachJsonlLineFromFile\s*\(\s*eventsPath/);
    assert.doesNotMatch(eventsBlock, /forEachParsedJsonlLine/);
    assert.doesNotMatch(eventsBlock, /readFileSync\s*\(\s*eventsPath/);
    try {
      const ITERS = 8;
      const t0 = performance.now();
      for (let i = 0; i < ITERS; i++) {
        const sess = parseGrok(dir);
        assert.equal(sess.sessionId, SESSION);
        assert.equal(sess.model, "grok-2");
        assert.equal(sess.events[0].text, "grok events compact probe");
      }
      const ms = (performance.now() - t0) / ITERS;
      assertPerf(
        ms < 6,
        `expected parseGrok under 6ms/op with 8k filler events lines, got ${ms.toFixed(1)}ms`,
      );
    } finally {
      cleanup(dir);
    }
  });

  test("skips filler system rows without splitJsonlLines full-array walk (perf)", () => {
    const dir = mkdtempSync(join(os.tmpdir(), "parse-grok-chat-perf-"));
    const lines = [];
    for (let i = 0; i < 5000; i++) {
      lines.push(JSON.stringify({ type: "system", content: "x".repeat(800) }));
    }
    lines.push(JSON.stringify({ type: "user", content: "grok chat compact probe" }));
    writeFileSync(join(dir, "chat_history.jsonl"), lines.join("\n") + "\n", "utf8");
    writeFileSync(
      join(dir, "events.jsonl"),
      JSON.stringify({ type: "turn_started", session_id: SESSION, ts: TS0 }) + "\n",
      "utf8",
    );
    const src = readFileSync("src/parse/parse-grok.js", "utf8");
    const chatBlock = src.slice(src.indexOf("chat_history.jsonl"));
    assert.match(chatBlock, /isGrokChatIndexedLine\s*\(\s*text,\s*start,\s*end\s*\)/);
    assert.match(chatBlock, /parseJsonlLineAt\s*\(\s*text,\s*start,\s*end\s*\)/);
    assert.match(chatBlock, /forEachJsonlLineFromFile\s*\(\s*chatPath/);
    assert.match(chatBlock, /indexedObjs/);
    assert.doesNotMatch(chatBlock, /splitJsonlLines/);
    assert.doesNotMatch(chatBlock, /readFileSync\s*\(\s*chatPath/);
    try {
      const ITERS = 8;
      const t0 = performance.now();
      for (let i = 0; i < ITERS; i++) {
        const sess = parseGrok(dir);
        assert.equal(sess.events[0].text, "grok chat compact probe");
      }
      const ms = (performance.now() - t0) / ITERS;
      assertPerf(
        ms < 8,
        `expected parseGrok under 8ms/op with 5k filler system lines, got ${ms.toFixed(1)}ms`,
      );
    } finally {
      cleanup(dir);
    }
  });
});