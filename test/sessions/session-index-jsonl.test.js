import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import {
  indexClaudeJsonl,
  indexCodexJsonl,
  indexFactoryJsonl,
  indexGrokJsonl,
  isGrokEventsIndexedLine,
  isGrokChatIndexedLine,
  emptyIndexMeta,
} from "../../src/sessions/session-index-jsonl.js";
import { extractPrompt } from "../../src/sessions/extract-prompt.js";
import { mkTmp, writeJsonl } from "../helpers/fixtures.js";
import { assertPerf } from "../helpers/perf-assert.js";

describe("session-index-jsonl helpers", () => {
  test("extractPrompt pulls text from user_query blocks", () => {
    const content = "<user_query>\nDeploy the staging app\n</user_query>";
    assert.equal(extractPrompt(content), "Deploy the staging app");
  });
});

describe("indexClaudeJsonl", () => {
  test("indexes model, tokens, duration, and assistant text", () => {
    const tmpDir = mkTmp("tq-index-claude-core-");
    const filePath = path.join(tmpDir, "session.jsonl");
    writeJsonl(filePath, [
      {
        type: "assistant",
        message: {
          model: "claude-3-opus",
          usage: { input_tokens: 50, output_tokens: 25 },
          content: [],
        },
        timestamp: "2026-05-01T00:00:00Z",
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "follow-up reply" }] },
        timestamp: "2026-05-01T00:02:00Z",
      },
    ]);
    try {
      const meta = indexClaudeJsonl(filePath);
      assert.equal(meta.model, "claude-3-opus");
      assert.equal(meta.inputTokens, 50);
      assert.equal(meta.outputTokens, 25);
      assert.equal(meta.durationMs, 120000);
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("follow") && meta.termFreqs.has("reply"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("firstPrompt when user content embeds type assistant block", () => {
    const tmpDir = mkTmp("tq-index-claude-nested-assistant-");
    const filePath = path.join(tmpDir, "nested.jsonl");
    writeJsonl(filePath, [
      {
        type: "user",
        message: {
          content: [
            { type: "assistant", text: "embedded assistant block" },
            { type: "text", text: "Real prompt" },
          ],
        },
      },
    ]);
    try {
      const meta = indexClaudeJsonl(filePath);
      assert.equal(meta.firstPrompt, "Real prompt");
      assert.equal(meta.chapters, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("extracts user prompts and skips meta or angle-bracket lines", () => {
    const tmpDir = mkTmp("tq-index-claude-user-");
    const filePath = path.join(tmpDir, "users.jsonl");
    writeJsonl(filePath, [
      { type: "user", isMeta: true, message: { content: [{ type: "text", text: "Meta line" }] } },
      { type: "user", message: { content: [{ type: "text", text: "<system>hidden</system>" }] } },
      { type: "user", message: { content: [{ type: "text", text: "Ship the feature" }] } },
      { type: "user", message: { content: [{ type: "text", text: "Second turn ask" }] } },
    ]);
    try {
      const meta = indexClaudeJsonl(filePath);
      assert.equal(meta.firstPrompt, "Ship the feature");
      assert.equal(meta.chapters, 3);
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("ship") && meta.termFreqs.has("feature"));
      assert.ok(meta.termFreqs.has("second") && meta.termFreqs.has("ask"));
      assert.ok(!meta.termFreqs.has("meta") || !meta.termFreqs.has("line"));
      assert.ok(!meta.termFreqs.has("hidden"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("parses user_query tags into searchable chunks", () => {
    const tmpDir = mkTmp("tq-index-claude-tags-");
    const filePath = path.join(tmpDir, "tags.jsonl");
    writeJsonl(filePath, [
      {
        type: "user",
        message: {
          content: [
            {
              type: "text",
              text: "<user_query>\nRefactor session index\n</user_query>",
            },
          ],
        },
      },
    ]);
    try {
      const meta = indexClaudeJsonl(filePath);
      assert.equal(meta.firstPrompt, "Refactor session index");
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("refactor") && meta.termFreqs.has("session"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("accumulates tools, files, cache tokens, and git commits", () => {
    const tmpDir = mkTmp("tq-index-claude-tools-");
    const filePath = path.join(tmpDir, "tools.jsonl");
    writeJsonl(filePath, [
      {
        type: "assistant",
        message: {
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 40,
            cache_creation_input_tokens: 8,
          },
          content: [
            {
              type: "tool_use",
              name: "Read",
              input: { file_path: "/proj/src/a.js" },
            },
            {
              type: "tool_use",
              name: "Bash",
              input: { command: "git commit -m 'index tests'" },
            },
          ],
        },
      },
    ]);
    try {
      const meta = indexClaudeJsonl(filePath);
      assert.ok(meta.tools.includes("Read"));
      assert.ok(meta.tools.includes("Bash"));
      assert.equal(meta.toolCounts.Read, 1);
      assert.equal(meta.files, 1);
      assert.equal(meta.commits, 1);
      assert.equal(meta.inputTokens, 18, "cache creation bills at input rate like parse rollup");
      assert.equal(meta.cacheReadTokens, 40);
      assert.equal(meta.totalTokens, 10 + 5 + 40 + 8);
      assert.equal(meta.inputTokens + meta.cacheReadTokens, 58, "matches parse totalInputTokens rollup");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("counts tool errors and includes thinking text", () => {
    const tmpDir = mkTmp("tq-index-claude-errors-");
    const filePath = path.join(tmpDir, "errors.jsonl");
    writeJsonl(filePath, [
      {
        type: "assistant",
        message: {
          content: [{ type: "thinking", thinking: "Plan the fix carefully before editing" }],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              content: [{ type: "text", text: "Error: command failed with exit code 2" }],
              is_error: true,
            },
          ],
        },
      },
    ]);
    try {
      const meta = indexClaudeJsonl(filePath);
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("plan") && meta.termFreqs.has("fix"));
      assert.ok(meta.errors >= 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("standalone tool_result filler skips accumulators and fallback JSON.parse", () => {
    const tmpDir = mkTmp("tq-index-claude-filler-fb-");
    const filePath = path.join(tmpDir, "filler.jsonl");
    const fillerText = "x".repeat(80);
    writeJsonl(filePath, [
      {
        type: "tool_result",
        tool_use_id: "filler-only",
        content: [{ type: "text", text: fillerText }],
      },
      {
        type: "user",
        message: { content: "Indexed claude prompt" },
      },
    ]);
    try {
      const meta = indexClaudeJsonl(filePath);
      assert.equal(meta.firstPrompt, "Indexed claude prompt");
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("indexed") && meta.termFreqs.has("claude") && meta.termFreqs.has("prompt"));
      assert.ok(!meta.termFreqs || !meta.termFreqs.has("x".repeat(80)));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("indexes stderr-only tool_result rows via termFreqs", () => {
    const tmpDir = mkTmp("tq-index-claude-stderr-fb-");
    const filePath = path.join(tmpDir, "stderr.jsonl");
    writeJsonl(filePath, [
      { type: "user", message: { content: "run failing command" } },
      {
        type: "tool_result",
        stderr:
          "Error: deployment failed because the staging service was unreachable after retries",
      },
    ]);
    try {
      const meta = indexClaudeJsonl(filePath);
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("deployment") && meta.termFreqs.has("failed"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("streams large claude sessions without readFileSync (perf)", () => {
    const tmpDir = mkTmp("tq-index-claude-perf-");
    const filePath = path.join(tmpDir, "large.jsonl");
    const lines = [];
    for (let i = 0; i < 5000; i++) {
      lines.push(
        JSON.stringify({
          type: "progress",
          data: "x".repeat(200),
        }),
      );
      if (i % 3 === 0) {
        lines.push(
          JSON.stringify({
            type: "user",
            message: { content: `claude prompt ${i}` },
          }),
        );
      }
    }
    fs.writeFileSync(filePath, lines.join("\n") + "\n");
    try {
      const ITERS = 8;
      for (let w = 0; w < 2; w++) indexClaudeJsonl(filePath);
      const t0 = performance.now();
      for (let i = 0; i < ITERS; i++) {
        const meta = indexClaudeJsonl(filePath);
        assert.ok(meta.chapters > 0);
      }
      const ms = (performance.now() - t0) / ITERS;
      assertPerf(
        ms < 12,
        `expected indexClaudeJsonl under 12ms/op for 5k progress-filler session, got ${ms.toFixed(1)}ms`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("skips tool_result filler accumulators in large claude sessions (perf)", () => {
    const tmpDir = mkTmp("tq-index-claude-tool-filler-perf-");
    const filePath = path.join(tmpDir, "tool-filler.jsonl");
    const lines = [];
    for (let i = 0; i < 5000; i++) {
      lines.push(
        JSON.stringify({
          type: "tool_result",
          tool_use_id: `t${i}`,
          content: [{ type: "text", text: "x".repeat(200) }],
        }),
      );
      if (i % 3 === 0) {
        lines.push(
          JSON.stringify({
            type: "user",
            message: { content: `claude prompt ${i}` },
          }),
        );
      }
    }
    fs.writeFileSync(filePath, lines.join("\n") + "\n");
    try {
      const ITERS = 8;
      for (let w = 0; w < 2; w++) indexClaudeJsonl(filePath);
      const t0 = performance.now();
      for (let i = 0; i < ITERS; i++) {
        const meta = indexClaudeJsonl(filePath);
        assert.ok(meta.chapters > 0);
      }
      const ms = (performance.now() - t0) / ITERS;
      assertPerf(
        ms < 15,
        `expected indexClaudeJsonl under 15ms/op for 5k tool_result-filler session, got ${ms.toFixed(1)}ms`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("skips system filler rows in large claude sessions (perf)", () => {
    const tmpDir = mkTmp("tq-index-claude-system-perf-");
    const filePath = path.join(tmpDir, "system-filler.jsonl");
    const lines = [];
    for (let i = 0; i < 5000; i++) {
      lines.push(
        JSON.stringify({
          type: "system",
          subtype: "init",
          data: "x".repeat(800),
        }),
      );
      if (i % 5 === 0) {
        lines.push(
          JSON.stringify({
            type: "user",
            message: { content: `claude prompt ${i}` },
          }),
        );
      }
    }
    fs.writeFileSync(filePath, lines.join("\n") + "\n");
    try {
      const ITERS = 8;
      for (let w = 0; w < 2; w++) indexClaudeJsonl(filePath);
      const t0 = performance.now();
      for (let i = 0; i < ITERS; i++) {
        const meta = indexClaudeJsonl(filePath);
        assert.ok(meta.chapters > 0);
      }
      const ms = (performance.now() - t0) / ITERS;
      assertPerf(
        ms < 15,
        `expected indexClaudeJsonl under 15ms/op for 5k system-filler session, got ${ms.toFixed(1)}ms`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns empty metadata when the session file is missing without logging", () => {
    const errors = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    try {
      const meta = indexClaudeJsonl(path.join(os.tmpdir(), "tq-index-claude-missing.jsonl"));
      assert.deepEqual(meta, emptyIndexMeta());
      assert.equal(errors.length, 0);
    } finally {
      console.error = origError;
    }
  });

  test("returns empty metadata and logs when the session file is unreadable", () => {
    const tmpDir = mkTmp("tq-index-claude-locked-");
    const filePath = path.join(tmpDir, "locked.jsonl");
    writeJsonl(filePath, [{ type: "user", message: { content: [{ type: "text", text: "locked" }] } }]);
    const errors = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    try {
      fs.chmodSync(filePath, 0o000);
      const meta = indexClaudeJsonl(filePath);
      assert.deepEqual(meta, emptyIndexMeta());
      assert.equal(errors.length, 1);
      assert.match(errors[0], /indexClaude: failed to index/);
      assert.match(errors[0], /locked\.jsonl/);
    } finally {
      fs.chmodSync(filePath, 0o644);
      console.error = origError;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("indexCodexJsonl", () => {
  test("indexes session_meta model and event_msg user_message", () => {
    const tmpDir = mkTmp("tq-index-codex-core-");
    const filePath = path.join(tmpDir, "rollout.jsonl");
    writeJsonl(filePath, [
      { noise: "padding without codex types" },
      { type: "session_meta", payload: { model_provider: "openai" } },
      {
        type: "event_msg",
        payload: { type: "user_message", message: "codex user asks something" },
      },
      { another: "irrelevant line" },
    ]);
    try {
      const meta = indexCodexJsonl(filePath);
      assert.equal(meta.model, "openai");
      assert.equal(meta.firstPrompt, "codex user asks something");
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("codex") && meta.termFreqs.has("user"));
      assert.equal(meta.chapters, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("firstPrompt skips the injected AGENTS.md first user item (r8 real dialect)", () => {
    // Real rollouts open with a user response_item of injected blocks; the
    // session-list title must be the user's prompt, never the injection.
    const tmpDir = mkTmp("tq-index-codex-agents-");
    const filePath = path.join(tmpDir, "rollout-agents.jsonl");
    writeJsonl(filePath, [
      { type: "session_meta", payload: { model_provider: "openai" } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "# AGENTS.md instructions for /Users/dev/proj\n\n<INSTRUCTIONS>injected</INSTRUCTIONS>" },
            { type: "input_text", text: "<environment_context>\n  <cwd>/Users/dev/proj</cwd>\n</environment_context>" },
          ],
        },
      },
      { type: "event_msg", payload: { type: "user_message", message: "index the real prompt" } },
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "index the real prompt" }] },
      },
    ]);
    try {
      const meta = indexCodexJsonl(filePath);
      assert.equal(meta.firstPrompt, "index the real prompt");
      assert.ok(!meta.termFreqs?.has("agents"), "injected AGENTS.md text must not enter search terms");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("accumulates token_count total_token_usage as latest session totals", () => {
    const tmpDir = mkTmp("tq-index-codex-token-count-");
    const filePath = path.join(tmpDir, "token-count.jsonl");
    writeJsonl(filePath, [
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: { input_tokens: 500, output_tokens: 120, cached_input_tokens: 30 } },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: { input_tokens: 900, output_tokens: 200, cached_input_tokens: 0 } },
        },
      },
    ]);
    try {
      const meta = indexCodexJsonl(filePath);
      assert.equal(meta.inputTokens, 900);
      assert.equal(meta.outputTokens, 200);
      assert.equal(meta.cacheReadTokens, 0);
      assert.equal(meta.totalTokens, 1100);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("token_count total_token_usage takes precedence over later turn_context usage", () => {
    const tmpDir = mkTmp("tq-index-codex-token-precedence-");
    const filePath = path.join(tmpDir, "token-precedence.jsonl");
    writeJsonl(filePath, [
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: { input_tokens: 100, output_tokens: 40 } },
        },
      },
      {
        type: "turn_context",
        payload: {
          model: "gpt-5-codex",
          last_token_usage: { input_tokens: 50, output_tokens: 10 },
        },
      },
    ]);
    try {
      const meta = indexCodexJsonl(filePath);
      assert.equal(meta.inputTokens, 100);
      assert.equal(meta.outputTokens, 40);
      assert.equal(meta.totalTokens, 140);
      assert.equal(meta.model, "gpt-5-codex");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("accumulates turn_context model and token usage", () => {
    const tmpDir = mkTmp("tq-index-codex-turn-");
    const filePath = path.join(tmpDir, "turn.jsonl");
    writeJsonl(filePath, [
      {
        type: "turn_context",
        payload: {
          model: "gpt-5-codex",
          last_token_usage: { input_tokens: 120, output_tokens: 30 },
        },
      },
    ]);
    try {
      const meta = indexCodexJsonl(filePath);
      assert.equal(meta.model, "gpt-5-codex");
      assert.equal(meta.inputTokens, 120);
      assert.equal(meta.outputTokens, 30);
      assert.equal(meta.totalTokens, 150);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("indexes response_item assistant output and function_call tools", () => {
    const tmpDir = mkTmp("tq-index-codex-response-");
    const filePath = path.join(tmpDir, "response.jsonl");
    writeJsonl(filePath, [
      {
        type: "response_item",
        payload: {
          role: "assistant",
          content: [
            { type: "output_text", text: "Codex assistant says hi" },
            {
              type: "function_call",
              name: "read_file",
              arguments: JSON.stringify({ path: "/src/index.js" }),
            },
          ],
        },
      },
    ]);
    try {
      const meta = indexCodexJsonl(filePath);
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("codex") && meta.termFreqs.has("assistant"));
      assert.ok(meta.tools.includes("Read"));
      assert.equal(meta.files, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("records patch_apply, web_search, bash errors, and git commits from events", () => {
    const tmpDir = mkTmp("tq-index-codex-events-");
    const filePath = path.join(tmpDir, "events.jsonl");
    writeJsonl(filePath, [
      { type: "event_msg", payload: { type: "patch_apply_end", path: "/app/main.js" } },
      { type: "event_msg", payload: { type: "web_search_end" } },
      {
        type: "event_msg",
        payload: {
          type: "exec_command_end",
          exit_code: 1,
          command: "git commit -m 'codex index'",
        },
      },
      {
        type: "response_item",
        payload: { type: "function_call_output", output: "Error: ENOENT missing file" },
      },
    ]);
    try {
      const meta = indexCodexJsonl(filePath);
      assert.ok(meta.tools.includes("Edit"));
      assert.ok(meta.tools.includes("WebSearch"));
      assert.ok(meta.tools.includes("Bash"));
      assert.equal(meta.commits, 1);
      assert.ok(meta.errors >= 1);
      assert.equal(meta.files, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("tracks duration from timestamps on codex lines", () => {
    const tmpDir = mkTmp("tq-index-codex-duration-");
    const filePath = path.join(tmpDir, "duration.jsonl");
    writeJsonl(filePath, [
      { type: "session_meta", payload: { model_provider: "codex" }, timestamp: "2026-05-01T00:00:00Z" },
      { type: "event_msg", payload: { type: "user_message", message: "done" }, timestamp: "2026-05-01T00:05:00Z" },
    ]);
    try {
      const meta = indexCodexJsonl(filePath);
      assert.equal(meta.durationMs, 300000);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns empty metadata when rollout file is missing", () => {
    const meta = indexCodexJsonl(path.join(os.tmpdir(), "tq-index-codex-missing.jsonl"));
    assert.deepEqual(meta, emptyIndexMeta());
  });

  test("ignores stream_chunk filler rows", () => {
    const tmpDir = mkTmp("tq-index-codex-stream-chunk-");
    const filePath = path.join(tmpDir, "rollout.jsonl");
    const lines = [
      JSON.stringify({
        type: "session_meta",
        payload: { model_provider: "openai" },
        timestamp: "2026-05-01T00:00:00Z",
      }),
    ];
    for (let i = 0; i < 200; i++) {
      lines.push(JSON.stringify({ type: "stream_chunk", payload: { text: "x".repeat(200) } }));
    }
    lines.push(
      JSON.stringify({
        type: "event_msg",
        payload: { type: "user_message", message: "after filler" },
        timestamp: "2026-05-01T00:01:00Z",
      }),
    );
    writeJsonl(filePath, lines);
    try {
      const meta = indexCodexJsonl(filePath);
      assert.equal(meta.model, "openai");
      assert.equal(meta.firstPrompt, "after filler");
      assert.equal(meta.chapters, 1);
      assert.equal(meta.durationMs, 60000);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("skips stream_chunk filler in large codex sessions (perf)", () => {
    const tmpDir = mkTmp("tq-index-codex-perf-");
    const filePath = path.join(tmpDir, "rollout.jsonl");
    const lines = [
      JSON.stringify({
        type: "session_meta",
        payload: { model_provider: "openai", cwd: "/tmp/proj" },
      }),
    ];
    for (let i = 0; i < 8000; i++) {
      lines.push(JSON.stringify({ type: "stream_chunk", payload: { text: "x".repeat(400) } }));
    }
    lines.push(
      JSON.stringify({
        type: "event_msg",
        payload: { type: "user_message", message: "codex perf prompt marker" },
      }),
    );
    writeJsonl(filePath, lines);
    try {
      const ITERS = 20;
      for (let w = 0; w < 2; w++) indexCodexJsonl(filePath);
      const t0 = performance.now();
      for (let i = 0; i < ITERS; i++) {
        const meta = indexCodexJsonl(filePath);
        assert.equal(meta.firstPrompt, "codex perf prompt marker");
      }
      const ms = (performance.now() - t0) / ITERS;
      assertPerf(
        ms < 2.5,
        `expected indexCodexJsonl under 2.5ms/op for 8k stream_chunk filler, got ${ms.toFixed(2)}ms`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("indexFactoryJsonl", () => {
  test("firstPrompt when user content embeds type assistant block", () => {
    const tmpDir = mkTmp("tq-index-factory-nested-assistant-");
    const filePath = path.join(tmpDir, "nested.jsonl");
    writeJsonl(filePath, [
      {
        type: "message",
        message: {
          role: "user",
          content: [
            { type: "assistant", text: "embedded assistant block" },
            { type: "text", text: "Real factory prompt" },
          ],
        },
      },
    ]);
    try {
      const meta = indexFactoryJsonl(filePath);
      assert.equal(meta.firstPrompt, "Real factory prompt");
      assert.equal(meta.chapters, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("indexes user and assistant message roles", () => {
    const tmpDir = mkTmp("tq-index-factory-roles-");
    const filePath = path.join(tmpDir, "factory.jsonl");
    writeJsonl(filePath, [
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "Ship the release" }] },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", name: "Read" },
            { type: "text", text: "Reading changelog" },
          ],
        },
      },
    ]);
    try {
      const meta = indexFactoryJsonl(filePath);
      assert.equal(meta.firstPrompt, "Ship the release");
      assert.equal(meta.model, "claude (factory)");
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("reading") && meta.termFreqs.has("changelog"));
      assert.ok(meta.tools.includes("Read"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("standalone tool_result filler skips fallback JSON.parse and is not indexed", () => {
    const tmpDir = mkTmp("tq-index-factory-filler-fb-");
    const filePath = path.join(tmpDir, "filler.jsonl");
    const fillerText = "x".repeat(80);
    writeJsonl(filePath, [
      {
        type: "tool_result",
        tool_use_id: "filler-only",
        content: [{ type: "text", text: fillerText }],
      },
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "Indexed factory prompt" }],
        },
      },
    ]);
    try {
      const meta = indexFactoryJsonl(filePath);
      assert.equal(meta.firstPrompt, "Indexed factory prompt");
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("indexed") && meta.termFreqs.has("factory") && meta.termFreqs.has("prompt"));
      assert.ok(!meta.termFreqs || !meta.termFreqs.has("x".repeat(80)));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("counts embedded tool_result errors on indexed message lines only", () => {
    const tmpDir = mkTmp("tq-index-factory-embedded-errors-");
    const filePath = path.join(tmpDir, "errors.jsonl");
    writeJsonl(filePath, [
      {
        type: "tool_result",
        tool_use_id: "filler",
        is_error: true,
        content: [{ type: "text", text: "Error: standalone filler must not count" }],
      },
      {
        type: "message",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              is_error: true,
              content: [{ type: "text", text: "Error: embedded factory failure" }],
            },
          ],
        },
      },
    ]);
    try {
      const meta = indexFactoryJsonl(filePath);
      assert.equal(meta.errors, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("skips tool_result filler in large factory sessions (perf)", () => {
    const tmpDir = mkTmp("tq-index-factory-perf-");
    const filePath = path.join(tmpDir, "large.jsonl");
    const lines = [];
    for (let i = 0; i < 8000; i++) {
      lines.push(
        JSON.stringify({
          type: "tool_result",
          tool_use_id: `t${i}`,
          content: "x".repeat(200),
        }),
      );
      if (i % 3 === 0) {
        lines.push(
          JSON.stringify({
            type: "message",
            message: {
              role: "user",
              content: [{ type: "text", text: `factory prompt ${i}` }],
            },
          }),
        );
      }
    }
    fs.writeFileSync(filePath, lines.join("\n") + "\n");
    try {
      const ITERS = 5;
      const t0 = performance.now();
      for (let i = 0; i < ITERS; i++) {
        const meta = indexFactoryJsonl(filePath);
        assert.ok(meta.chapters > 0);
      }
      const ms = (performance.now() - t0) / ITERS;
      assertPerf(
        ms < 15,
        `expected indexFactoryJsonl under 15ms/op for 8k tool_result filler, got ${ms.toFixed(2)}ms`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("indexGrokJsonl", () => {
  test("indexes chat_history text, events model, duration, and tools", () => {
    const tmpDir = mkTmp("tq-index-grok-core-");
    const sessionDir = path.join(tmpDir, "sess-1");
    fs.mkdirSync(sessionDir, { recursive: true });
    writeJsonl(path.join(sessionDir, "chat_history.jsonl"), [
      { type: "user", content: "grok line one" },
      {
        type: "assistant",
        content: "grok line two",
        tool_calls: [{ id: "r1", name: "read", arguments: '{"file_path":"/a.js"}' }],
      },
      { type: "tool_result", tool_call_id: "r1", content: "ok" },
      { type: "assistant", content: "grok line three" },
    ]);
    writeJsonl(path.join(sessionDir, "events.jsonl"), [
      { type: "turn_started", ts: "2026-05-01T00:00:00Z", model_id: "grok-2" },
      { type: "tool_started", ts: "2026-05-01T00:02:00Z", tool_name: "read" },
      { type: "tool_completed", ts: "2026-05-01T00:02:01Z", tool_name: "read", outcome: "success" },
    ]);
    try {
      const meta = indexGrokJsonl(sessionDir);
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("grok") && meta.termFreqs.has("line"));
      assert.equal(meta.model, "grok-2");
      assert.equal(meta.durationMs, 121000);
      assert.ok(meta.tools.includes("Read"));
      assert.equal(meta.chapters, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("logs malformed prompt_context.json but still indexes chat_history", () => {
    const tmpDir = mkTmp("tq-index-grok-bad-ctx-");
    const sessionDir = path.join(tmpDir, "bad-ctx");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "prompt_context.json"), "{not-json");
    writeJsonl(path.join(sessionDir, "chat_history.jsonl"), [
      { type: "user", content: "Grok despite bad ctx" },
    ]);
    const errors = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    try {
      const meta = indexGrokJsonl(sessionDir);
      assert.equal(meta.firstPrompt, "Grok despite bad ctx");
      assert.equal(errors.length, 1);
      assert.match(errors[0], /indexGrok: failed to parse/);
      assert.match(errors[0], /prompt_context\.json/);
    } finally {
      console.error = origError;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("reads model from prompt_context.json when events omit turn_started", () => {
    const tmpDir = mkTmp("tq-index-grok-ctx-");
    const sessionDir = path.join(tmpDir, "ctx-sess");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "prompt_context.json"),
      JSON.stringify({ model_id: "grok-3-fast" })
    );
    writeJsonl(path.join(sessionDir, "chat_history.jsonl"), [
      { type: "user", content: "Context model probe" },
    ]);
    try {
      const meta = indexGrokJsonl(sessionDir);
      assert.equal(meta.model, "grok-3-fast");
      assert.equal(meta.firstPrompt, "Context model probe");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("indexes assistant tool_calls, file paths, and bash commits", () => {
    const tmpDir = mkTmp("tq-index-grok-tools-");
    const sessionDir = path.join(tmpDir, "tool-sess");
    fs.mkdirSync(sessionDir, { recursive: true });
    writeJsonl(path.join(sessionDir, "chat_history.jsonl"), [
      {
        type: "assistant",
        content: [{ type: "text", text: "Using tools now" }],
        tool_calls: [
          {
            name: "bash",
            arguments: JSON.stringify({ command: "git commit -m 'grok'" }),
          },
          {
            name: "read",
            arguments: JSON.stringify({ file_path: "/repo/README.md" }),
          },
        ],
      },
    ]);
    try {
      const meta = indexGrokJsonl(sessionDir);
      assert.ok(meta.tools.includes("Bash"));
      assert.ok(meta.tools.includes("Read"));
      assert.equal(meta.commits, 1);
      assert.equal(meta.files, 1);
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("using") && meta.termFreqs.has("tools"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("counts tool_completed errors from events.jsonl", () => {
    const tmpDir = mkTmp("tq-index-grok-errors-");
    const sessionDir = path.join(tmpDir, "err-sess");
    fs.mkdirSync(sessionDir, { recursive: true });
    writeJsonl(path.join(sessionDir, "events.jsonl"), [
      { type: "tool_completed", outcome: "error" },
      { type: "tool_completed", outcome: "ok" },
    ]);
    writeJsonl(path.join(sessionDir, "chat_history.jsonl"), [
      { type: "user", content: "Trigger tool failure" },
    ]);
    try {
      const meta = indexGrokJsonl(sessionDir);
      assert.equal(meta.errors, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("estimates token counts from chat character volume", () => {
    const tmpDir = mkTmp("tq-index-grok-tokens-");
    const sessionDir = path.join(tmpDir, "tok-sess");
    fs.mkdirSync(sessionDir, { recursive: true });
    const userText = "x".repeat(40);
    const assistantText = "y".repeat(60);
    writeJsonl(path.join(sessionDir, "chat_history.jsonl"), [
      { type: "user", content: userText },
      { type: "assistant", content: assistantText },
    ]);
    try {
      const meta = indexGrokJsonl(sessionDir);
      assert.equal(meta.inputTokens, Math.round(userText.length / 4));
      assert.equal(meta.outputTokens, Math.round(assistantText.length / 4));
      assert.equal(meta.totalTokens, meta.inputTokens + meta.outputTokens);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("does not double-count tools from events.jsonl and chat_history tool_calls", () => {
    const tmpDir = mkTmp("tq-index-grok-no-dc-");
    const sessionDir = path.join(tmpDir, "dc-sess");
    fs.mkdirSync(sessionDir, { recursive: true });
    writeJsonl(path.join(sessionDir, "events.jsonl"), [
      { type: "turn_started", ts: "2026-06-03T12:00:00Z", model_id: "grok-2" },
      { type: "tool_started", ts: "2026-06-03T12:00:01Z", tool_name: "bash" },
      { type: "tool_completed", ts: "2026-06-03T12:00:02Z", tool_name: "bash", outcome: "success" },
      { type: "tool_started", ts: "2026-06-03T12:00:03Z", tool_name: "read" },
      { type: "tool_completed", ts: "2026-06-03T12:00:04Z", tool_name: "read", outcome: "success" },
    ]);
    writeJsonl(path.join(sessionDir, "chat_history.jsonl"), [
      { type: "user", content: "run tools" },
      {
        type: "assistant",
        content: "go",
        tool_calls: [
          { id: "1", name: "bash", arguments: "{}" },
          { id: "2", name: "read_file", arguments: "{}" },
        ],
      },
      { type: "tool_result", tool_call_id: "1", content: "ok" },
      { type: "tool_result", tool_call_id: "2", content: "ok" },
    ]);
    try {
      const meta = indexGrokJsonl(sessionDir);
      assert.deepEqual(meta.toolCounts, { Bash: 1, Read: 1 });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("parses user_query blocks in grok chat lines", () => {
    const tmpDir = mkTmp("tq-index-grok-tags-");
    const sessionDir = path.join(tmpDir, "tag-sess");
    fs.mkdirSync(sessionDir, { recursive: true });
    writeJsonl(path.join(sessionDir, "chat_history.jsonl"), [
      {
        type: "user",
        content: "<user_query>\nExpand jsonl index tests\n</user_query>",
      },
    ]);
    try {
      const meta = indexGrokJsonl(sessionDir);
      assert.equal(meta.firstPrompt, "Expand jsonl index tests");
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("expand") && meta.termFreqs.has("jsonl"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("isGrokEventsIndexedLine skips stream filler without ts or tool markers", () => {
    assert.equal(isGrokEventsIndexedLine(JSON.stringify({ type: "stream_chunk", data: "x" })), false);
    const filler = JSON.stringify({ type: "stream_chunk", payload: "x".repeat(400) });
    assert.equal(isGrokEventsIndexedLine(filler, 0, filler.length), false);
    assert.equal(isGrokEventsIndexedLine(JSON.stringify({ type: "turn_started", ts: "2026-01-01T00:00:00Z" })), true);
    assert.equal(isGrokEventsIndexedLine(JSON.stringify({ type: "tool_completed", outcome: "error" })), true);
  });

  test("isGrokChatIndexedLine skips system filler without user/assistant/tool markers", () => {
    assert.equal(isGrokChatIndexedLine(JSON.stringify({ type: "system", content: "x" })), false);
    assert.equal(isGrokChatIndexedLine(JSON.stringify({ type: "user", content: "hi" })), true);
    assert.equal(isGrokChatIndexedLine(JSON.stringify({ type: "tool_result", content: "ok" })), true);
    assert.equal(isGrokChatIndexedLine(JSON.stringify({ type: "tool", content: "ok" })), true);
  });

  test("isGrokChatIndexedLine system prefix fast-reject on large chat_history (perf)", () => {
    const filler = JSON.stringify({ type: "system", content: "x".repeat(800) });
    const lines = Array.from({ length: 8000 }, () => filler);
    lines.push(JSON.stringify({ type: "user", content: "gate probe" }));
    const ITERS = 20;
    for (let w = 0; w < 3; w++) {
      for (const line of lines) isGrokChatIndexedLine(line);
    }
    const t0 = performance.now();
    for (let w = 0; w < ITERS; w++) {
      for (const line of lines) isGrokChatIndexedLine(line);
    }
    const ms = (performance.now() - t0) / ITERS;
    assertPerf(
      ms < 1.2,
      `expected isGrokChatIndexedLine under 1.2ms/op on 8k system filler, got ${ms.toFixed(2)}ms`,
    );
  });

  test("streams large events.jsonl without readFileSync (perf)", () => {
    const tmpDir = mkTmp("tq-index-grok-events-perf-");
    const sessionDir = path.join(tmpDir, "perf-sess");
    fs.mkdirSync(sessionDir, { recursive: true });
    const lines = [];
    for (let i = 0; i < 8000; i++) {
      lines.push(JSON.stringify({ type: "stream_chunk", payload: "x".repeat(400) }));
    }
    lines.push(
      JSON.stringify({ type: "turn_started", ts: "2026-05-01T00:00:00Z", model_id: "grok-2" }),
      JSON.stringify({ type: "tool_started", ts: "2026-05-01T00:01:00Z", tool_name: "read" }),
      JSON.stringify({
        type: "tool_completed",
        ts: "2026-05-01T00:02:00Z",
        tool_name: "read",
        outcome: "success",
      }),
    );
    writeJsonl(path.join(sessionDir, "events.jsonl"), lines);
    writeJsonl(path.join(sessionDir, "chat_history.jsonl"), [
      { type: "user", content: "grok events stream probe" },
    ]);
    try {
      const ITERS = 8;
      const t0 = performance.now();
      for (let i = 0; i < ITERS; i++) {
        const meta = indexGrokJsonl(sessionDir);
        assert.equal(meta.model, "grok-2");
        assert.ok(meta.tools.includes("Read"));
      }
      const ms = (performance.now() - t0) / ITERS;
      assertPerf(
        ms < 30,
        `expected indexGrokJsonl under 30ms/op with 8k filler events lines, got ${ms.toFixed(1)}ms`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("streams large chat_history.jsonl without readFileSync (perf)", () => {
    const tmpDir = mkTmp("tq-index-grok-chat-perf-");
    const sessionDir = path.join(tmpDir, "perf-sess");
    fs.mkdirSync(sessionDir, { recursive: true });
    const lines = [];
    for (let i = 0; i < 5000; i++) {
      lines.push(JSON.stringify({ type: "system", content: "x".repeat(800) }));
    }
    lines.push(JSON.stringify({ type: "user", content: "grok chat stream probe" }));
    writeJsonl(path.join(sessionDir, "chat_history.jsonl"), lines);
    try {
      const ITERS = 8;
      const t0 = performance.now();
      for (let i = 0; i < ITERS; i++) {
        const meta = indexGrokJsonl(sessionDir);
        assert.equal(meta.firstPrompt, "grok chat stream probe");
        assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("grok") && meta.termFreqs.has("chat"));
      }
      const ms = (performance.now() - t0) / ITERS;
      assertPerf(
        ms < 12,
        `expected indexGrokJsonl under 12ms/op with 5k-line chat_history, got ${ms.toFixed(1)}ms`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});