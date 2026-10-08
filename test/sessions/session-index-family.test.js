import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import {
  indexClaudeJsonl,
  indexCodexJsonl,
  indexCursorJsonl,
  indexFactoryJsonl,
  indexGrokJsonl,
} from "../../src/sessions/session-index-jsonl.js";
import { parseSession } from "../../src/parse.js";
import { mkTmp, writeJsonl } from "../helpers/fixtures.js";

describe("indexClaudeFamilyJsonl shared indexer", () => {
  test("claude, factory, and codex family indexers each surface user prompts", () => {
    const cases = [
      {
        name: "claude",
        index: indexClaudeJsonl,
        lines: [
          { type: "user", message: { content: [{ type: "text", text: "family claude ask" }] } },
        ],
      },
      {
        name: "factory",
        index: indexFactoryJsonl,
        lines: [
          { type: "session_start", id: "f1", cwd: "/p" },
          {
            type: "message",
            message: { role: "user", content: [{ type: "text", text: "family factory ask" }] },
          },
        ],
      },
      {
        name: "codex",
        index: indexCodexJsonl,
        lines: [
          { type: "event_msg", payload: { type: "user_message", message: "family codex ask" } },
        ],
      },
    ];
    for (const { name, index, lines } of cases) {
      const tmpDir = mkTmp(`tq-family-user-${name}-`);
      const filePath = path.join(tmpDir, "session.jsonl");
      writeJsonl(filePath, lines);
      try {
        const meta = index(filePath);
        assert.equal(meta.chapters, 1, `${name} chapters`);
        assert.ok(meta.firstPrompt?.includes("family"), `${name} firstPrompt`);
        assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("family"), `${name} termFreqs`);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  });

  test("claude assistant-only session has zero user chapters", () => {
    const tmpDir = mkTmp("tq-family-claude-assistant-only-");
    const filePath = path.join(tmpDir, "assistant-only.jsonl");
    writeJsonl(filePath, [
      {
        type: "assistant",
        message: {
          model: "claude-3-opus",
          content: [{ type: "text", text: "assistant-only reply" }],
        },
      },
    ]);
    try {
      const meta = indexClaudeJsonl(filePath);
      assert.equal(meta.chapters, 0);
      assert.equal(meta.firstPrompt, null);
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("assistant"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("codex ignores claude-style token accumulators on assistant lines", () => {
    const tmpDir = mkTmp("tq-family-codex-no-claude-acc-");
    const filePath = path.join(tmpDir, "codex-tokens.jsonl");
    fs.writeFileSync(
      filePath,
      '{"type":"response_item","payload":{"role":"assistant","content":[{"type":"output_text","text":"codex only"}]},"input_tokens":900,"output_tokens":100}\n',
    );
    try {
      const meta = indexCodexJsonl(filePath);
      assert.equal(meta.inputTokens, 0);
      assert.equal(meta.outputTokens, 0);
      assert.equal(meta.totalTokens, 0);
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("codex"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("factory session_start filler does not create user chapters", () => {
    const tmpDir = mkTmp("tq-family-factory-session-start-");
    const filePath = path.join(tmpDir, "session-start.jsonl");
    writeJsonl(filePath, [
      { type: "session_start", id: "factory-start", cwd: "/proj" },
      { type: "tool_result", tool_use_id: "t0", content: "orphan result only" },
    ]);
    try {
      const meta = indexFactoryJsonl(filePath);
      assert.equal(meta.chapters, 0);
      assert.equal(meta.firstPrompt, null);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("claude progress filler rows do not count as user chapters", () => {
    const tmpDir = mkTmp("tq-family-claude-progress-");
    const filePath = path.join(tmpDir, "progress.jsonl");
    writeJsonl(filePath, [
      { type: "progress", data: "UNIQUE_PROGRESS_FILLER_MARKER".repeat(4) },
      { type: "progress", data: "y".repeat(120) },
      { type: "user", message: { content: [{ type: "text", text: "after filler rows" }] } },
    ]);
    try {
      const meta = indexClaudeJsonl(filePath);
      assert.equal(meta.chapters, 1);
      assert.equal(meta.firstPrompt, "after filler rows");
      assert.ok(!meta.termFreqs?.has("unique_progress_filler_marker"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("family indexer processes on-disk multi-line JSONL sessions", () => {
    const tmpDir = mkTmp("tq-family-multiline-disk-");
    const filePath = path.join(tmpDir, "multiline.jsonl");
    const lines = [];
    for (let i = 0; i < 120; i++) {
      lines.push(JSON.stringify({ type: "progress", data: `filler-${i}` }));
    }
    lines.push(
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "text", text: "disk stream prompt" }] },
      }),
    );
    fs.writeFileSync(filePath, lines.join("\n") + "\n");
    try {
      const meta = indexClaudeJsonl(filePath);
      assert.equal(meta.chapters, 1);
      assert.equal(meta.firstPrompt, "disk stream prompt");
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("stream"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("long non-index filler without text keys does not pollute termFreqs", () => {
    const tmpDir = mkTmp("tq-family-fallback-gate-");
    const filePath = path.join(tmpDir, "fallback-gate.jsonl");
    const fillerText = "z".repeat(80);
    writeJsonl(filePath, [
      {
        type: "tool_result",
        tool_use_id: "filler-only",
        content: [{ type: "text", text: fillerText }],
      },
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "factory after filler" }] },
      },
    ]);
    try {
      const meta = indexFactoryJsonl(filePath);
      assert.equal(meta.firstPrompt, "factory after filler");
      assert.equal(meta.chapters, 1);
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("factory"));
      assert.ok(!meta.termFreqs.has(fillerText));
      assert.ok(!meta.termFreqs.has("zzzz"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("indexCursorJsonl real-format parity", () => {
  test("estimates tokens, defaults model, counts turn_ended errors and path-input files", () => {
    const tmpDir = mkTmp("tq-cursor-parity-");
    const filePath = path.join(tmpDir, "cursor.jsonl");
    writeJsonl(filePath, [
      { role: "user", message: { content: [{ type: "text", text: "Hello cursor" }] } },
      {
        role: "assistant",
        message: {
          content: [
            { type: "text", text: "Cursor reply" },
            { type: "tool_use", name: "Read", input: { path: "/tmp/test.txt" } },
          ],
        },
      },
      { type: "turn_ended", status: "success" },
      { type: "turn_ended", status: "error", error: "User aborted request" },
    ]);
    try {
      const meta = indexCursorJsonl(filePath);
      assert.equal(meta.model, "cursor");
      // input "Hello cursor" = 12 chars → 3; output "Cursor reply" (12) + "Read"+20 (24) = 36 → 9
      assert.equal(meta.inputTokens, 3);
      assert.equal(meta.outputTokens, 9);
      assert.equal(meta.totalTokens, 12);
      assert.equal(meta.errors, 1);
      assert.equal(meta.files, 1);
      assert.equal(meta.chapters, 1);
      assert.equal(meta.toolCounts.Read, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("explicit usage fields take precedence over estimation", () => {
    const tmpDir = mkTmp("tq-cursor-usage-");
    const filePath = path.join(tmpDir, "cursor.jsonl");
    writeJsonl(filePath, [
      { role: "user", message: { content: [{ type: "text", text: "usage cursor prompt" }] } },
      {
        role: "assistant",
        message: {
          content: [{ type: "text", text: "reply" }],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
    ]);
    try {
      const meta = indexCursorJsonl(filePath);
      assert.equal(meta.inputTokens, 100);
      assert.equal(meta.outputTokens, 50);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("durationMs derives from file birthtime/mtime and matches parseSession (fact rc8)", () => {
    const tmpDir = mkTmp("tq-cursor-duration-");
    const filePath = path.join(tmpDir, "cursor.jsonl");
    writeJsonl(filePath, [
      { role: "user", message: { content: [{ type: "text", text: "time me" }] } },
    ]);
    try {
      // mtime 5s in the future: birthtime (now) <= mtime → real span.
      const futureMs = Date.now() + 5000;
      fs.utimesSync(filePath, new Date(futureMs), new Date(futureMs));
      const meta = indexCursorJsonl(filePath);
      assert.ok(meta.durationMs > 0);
      // Layer parity: index durationMs equals parseSession durationMs for the same file.
      const session = parseSession(filePath, "cursor");
      assert.equal(meta.durationMs, session.durationMs);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("durationMs clamps to 0 when birthtime is after mtime", () => {
    const tmpDir = mkTmp("tq-cursor-duration-clamp-");
    const filePath = path.join(tmpDir, "cursor.jsonl");
    writeJsonl(filePath, [
      { role: "user", message: { content: [{ type: "text", text: "clamp me" }] } },
    ]);
    try {
      const pastMs = Date.now() - 24 * 60 * 60 * 1000;
      fs.utimesSync(filePath, new Date(pastMs), new Date(pastMs));
      const meta = indexCursorJsonl(filePath);
      assert.equal(meta.durationMs, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("Grep path input does not count as a touched file", () => {
    const tmpDir = mkTmp("tq-cursor-grep-");
    const filePath = path.join(tmpDir, "cursor.jsonl");
    writeJsonl(filePath, [
      {
        role: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Grep", input: { pattern: "x", path: "/repo/src" } },
            { type: "tool_use", name: "Write", input: { path: "/repo/src/new.js", contents: "x" } },
          ],
        },
      },
    ]);
    try {
      const meta = indexCursorJsonl(filePath);
      assert.equal(meta.files, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("indexCodexJsonl lineKind routing", () => {
  test("non-user event_msg lines do not count as user chapters", () => {
    const tmpDir = mkTmp("tq-index-codex-linekind-");
    const filePath = path.join(tmpDir, "events-only.jsonl");
    writeJsonl(filePath, [
      { type: "event_msg", payload: { type: "patch_apply_end", path: "/only-patch.js" } },
      { type: "event_msg", payload: { type: "web_search_end" } },
    ]);
    try {
      const meta = indexCodexJsonl(filePath);
      assert.equal(meta.chapters, 0);
      assert.equal(meta.firstPrompt, null);
      assert.ok(meta.tools.includes("Edit"));
      assert.ok(meta.tools.includes("WebSearch"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("lineKind user routes event_msg user_message and response_item role user", () => {
    const tmpDir = mkTmp("tq-index-codex-linekind-user-");
    const filePath = path.join(tmpDir, "user-routes.jsonl");
    writeJsonl(filePath, [
      {
        type: "event_msg",
        payload: { type: "user_message", message: "codex asks via event" },
      },
      {
        type: "response_item",
        payload: {
          role: "user",
          content: [{ type: "input_text", text: "codex asks via response_item" }],
        },
      },
    ]);
    try {
      const meta = indexCodexJsonl(filePath);
      assert.equal(meta.firstPrompt, "codex asks via event");
      assert.equal(meta.chapters, 2);
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("codex") && meta.termFreqs.has("asks"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("indexFactoryJsonl lineKind routing", () => {
  test("non-user indexed lines do not count as user chapters", () => {
    const tmpDir = mkTmp("tq-index-factory-linekind-");
    const filePath = path.join(tmpDir, "assistant-only.jsonl");
    writeJsonl(filePath, [
      { type: "session_start", id: "factory-linekind", cwd: "/proj" },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Read", input: { file_path: "/only-read.js" } }],
        },
      },
      { type: "tool_result", tool_use_id: "t1", content: "for user review only" },
    ]);
    try {
      const meta = indexFactoryJsonl(filePath);
      assert.equal(meta.chapters, 0);
      assert.equal(meta.firstPrompt, null);
      assert.ok(meta.tools.includes("Read"));
      assert.equal(meta.files, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("lineKind user routes message role user text blocks", () => {
    const tmpDir = mkTmp("tq-index-factory-linekind-user-");
    const filePath = path.join(tmpDir, "user-routes.jsonl");
    writeJsonl(filePath, [
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "factory asks one" }] },
      },
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "factory asks two" }] },
      },
    ]);
    try {
      const meta = indexFactoryJsonl(filePath);
      assert.equal(meta.firstPrompt, "factory asks one");
      assert.equal(meta.chapters, 2);
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("factory") && meta.termFreqs.has("asks"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("rounds estimated input tokens with Math.round(chars/4)", () => {
    const tmpDir = mkTmp("tq-index-factory-round-");
    const filePath = path.join(tmpDir, "round.jsonl");
    writeJsonl(filePath, [
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "abcdef" }] },
      },
    ]);
    try {
      const meta = indexFactoryJsonl(filePath);
      assert.equal(meta.inputTokens, 2);
      assert.equal(meta.outputTokens, 0);
      assert.equal(meta.totalTokens, 2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("estimates tokens from user and assistant text when usage fields are absent", () => {
    const tmpDir = mkTmp("tq-index-factory-est-tokens-");
    const filePath = path.join(tmpDir, "est-tokens.jsonl");
    writeJsonl(filePath, [
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "abcd" }] },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "efgh" },
            { type: "tool_use", name: "Read", input: { file_path: "/x.js" } },
          ],
        },
      },
    ]);
    try {
      const meta = indexFactoryJsonl(filePath);
      assert.equal(meta.inputTokens, 1);
      assert.equal(meta.outputTokens, 7);
      assert.equal(meta.totalTokens, 8);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("lineKind user with nested type assistant content sets firstPrompt from text block", () => {
    const tmpDir = mkTmp("tq-index-factory-linekind-nested-assistant-");
    const filePath = path.join(tmpDir, "nested-assistant.jsonl");
    writeJsonl(filePath, [
      {
        type: "message",
        message: {
          role: "user",
          content: [
            { type: "assistant", text: "embedded assistant block must not win" },
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
});

describe("indexGrokJsonl streaming indexer", () => {
  test("events.jsonl ignores stream filler but indexes turn_started model", () => {
    const tmpDir = mkTmp("tq-family-grok-events-stream-");
    const sessionDir = path.join(tmpDir, "grok-events");
    fs.mkdirSync(sessionDir, { recursive: true });
    writeJsonl(path.join(sessionDir, "events.jsonl"), [
      { type: "stream_chunk", payload: "x".repeat(400) },
      { type: "stream_chunk", data: "y".repeat(400) },
      { type: "turn_started", ts: "2026-06-01T00:00:00Z", model_id: "grok-family" },
      { type: "tool_started", ts: "2026-06-01T00:00:01Z", tool_name: "read" },
    ]);
    writeJsonl(path.join(sessionDir, "chat_history.jsonl"), [
      { type: "user", content: "grok events stream probe" },
    ]);
    try {
      const meta = indexGrokJsonl(sessionDir);
      assert.equal(meta.model, "grok-family");
      assert.equal(meta.firstPrompt, "grok events stream probe");
      assert.ok(meta.tools.includes("Read"));
      assert.equal(meta.chapters, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("chat_history.jsonl ignores system filler and indexes user prompts", () => {
    const tmpDir = mkTmp("tq-family-grok-chat-stream-");
    const sessionDir = path.join(tmpDir, "grok-chat");
    fs.mkdirSync(sessionDir, { recursive: true });
    writeJsonl(path.join(sessionDir, "chat_history.jsonl"), [
      { type: "system", content: "x".repeat(800) },
      { type: "system", content: "bootstrap filler only" },
      { type: "user", content: "grok chat stream probe" },
      {
        type: "assistant",
        content: "indexed assistant tail",
        tool_calls: [{ id: "t1", name: "bash", arguments: "{}" }],
      },
    ]);
    try {
      const meta = indexGrokJsonl(sessionDir);
      assert.equal(meta.firstPrompt, "grok chat stream probe");
      assert.equal(meta.chapters, 1);
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("grok") && meta.termFreqs.has("probe"));
      assert.ok(meta.tools.includes("Bash"));
      assert.ok(!meta.termFreqs.has("bootstrap"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});