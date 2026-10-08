import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  peekSession,
  peekClaude,
  peekCursor,
  peekCodex,
  peekFactory,
  peekGrok,
  peekOpenCode,
} from "../../src/sessions/session-peek.js";
import { writeJsonl } from "../helpers/fixtures.js";
import { assertPerf } from "../helpers/perf-assert.js";

/** Append filler JSONL lines until file size exceeds minBytes. */
function padJsonlUntil(filePath, minBytes, filler = { type: "padding", payload: "x" }) {
  const fillerLine = JSON.stringify(filler) + "\n";
  const lineCount = Math.ceil(minBytes / Buffer.byteLength(fillerLine, "utf-8"));
  fs.appendFileSync(filePath, fillerLine.repeat(lineCount));
}

describe("session-peek dispatch", () => {
  test("peekSession routes codex source to peekCodex", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-peek-dispatch-codex-"));
    const filePath = path.join(tmpDir, "rollout.jsonl");
    writeJsonl(filePath, [
      { type: "session_meta", payload: { model_provider: "openai-codex" } },
      {
        type: "response_item",
        payload: { role: "user", content: [{ type: "input_text", text: "Codex dispatch probe" }] },
      },
    ]);
    try {
      const size = fs.statSync(filePath).size;
      assert.deepEqual(peekSession({ path: filePath, size, source: "codex" }), peekCodex(filePath, size));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("peekSession routes grok source to peekGrok", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-peek-dispatch-grok-"));
    const sessionDir = path.join(tmpDir, "grok-sess");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "prompt_context.json"), JSON.stringify({ model_id: "grok-3" }));
    writeJsonl(path.join(sessionDir, "chat_history.jsonl"), [
      { type: "user", content: "Grok dispatch probe" },
    ]);
    try {
      assert.deepEqual(peekSession({ path: sessionDir, source: "grok" }), peekGrok(sessionDir));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("unknown source falls back to peekClaude", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-peek-dispatch-unknown-"));
    const filePath = path.join(tmpDir, "legacy.jsonl");
    writeJsonl(filePath, [
      {
        type: "user",
        message: { content: [{ type: "text", text: "Unknown vendor still Claude-shaped" }] },
      },
    ]);
    try {
      const size = fs.statSync(filePath).size;
      const claude = peekClaude(filePath, size);
      assert.equal(claude.firstPrompt, "Unknown vendor still Claude-shaped");
      assert.deepEqual(peekSession({ path: filePath, size, source: "windsurf" }), claude);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("peekSession routes cursor source to peekCursor", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-peek-dispatch-cursor-"));
    const filePath = path.join(tmpDir, "cursor.jsonl");
    writeJsonl(filePath, [
      {
        role: "user",
        message: { content: [{ type: "text", text: "Cursor vendor is first class" }] },
      },
    ]);
    try {
      const size = fs.statSync(filePath).size;
      const peeked = peekCursor(filePath, size);
      assert.deepEqual(peekSession({ path: filePath, size, source: "cursor" }), peeked);
      assert.equal(peeked.firstPrompt, "Cursor vendor is first class");
      assert.equal(peeked.model, "cursor");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("missing source defaults to claude peek", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-peek-dispatch-default-"));
    const filePath = path.join(tmpDir, "default.jsonl");
    writeJsonl(filePath, [
      { type: "user", message: { content: [{ type: "text", text: "Default source path" }] } },
    ]);
    try {
      const size = fs.statSync(filePath).size;
      assert.deepEqual(peekSession({ path: filePath, size }), peekClaude(filePath, size));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("session-peek partial read limits", () => {
  test("peekClaude only indexes user prompt within first 512KiB prefix", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-peek-partial-claude-"));
    const filePath = path.join(tmpDir, "big.jsonl");
    padJsonlUntil(filePath, 600_000);
    fs.appendFileSync(
      filePath,
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "text", text: "Beyond partial window" }] },
      }) + "\n"
    );
    try {
      const size = fs.statSync(filePath).size;
      const meta = peekClaude(filePath, size);
      assert.equal(meta.firstPrompt, null);
      assert.ok(meta.termFreqs === null || meta.termFreqs.size === 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("peekClaude finds early prompt inside partial prefix", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-peek-partial-claude-hit-"));
    const filePath = path.join(tmpDir, "early.jsonl");
    writeJsonl(filePath, [
      { type: "user", message: { content: [{ type: "text", text: "Early user ask" }] } },
    ]);
    padJsonlUntil(filePath, 600_000);
    try {
      const size = fs.statSync(filePath).size;
      const meta = peekClaude(filePath, size);
      assert.equal(meta.firstPrompt, "Early user ask");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("peekCodex ignores prompts appended after 512KiB prefix", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-peek-partial-codex-"));
    const filePath = path.join(tmpDir, "codex-big.jsonl");
    padJsonlUntil(filePath, 600_000);
    fs.appendFileSync(
      filePath,
      JSON.stringify({
        type: "response_item",
        payload: { role: "user", content: [{ type: "input_text", text: "Late codex prompt" }] },
      }) + "\n"
    );
    try {
      const size = fs.statSync(filePath).size;
      const meta = peekCodex(filePath, size);
      assert.equal(meta.firstPrompt, null);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("peekGrok events.jsonl only scans first 128KiB for tools", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-peek-partial-grok-events-"));
    const sessionDir = path.join(tmpDir, "grok-partial");
    fs.mkdirSync(sessionDir, { recursive: true });
    const eventsPath = path.join(sessionDir, "events.jsonl");
    padJsonlUntil(eventsPath, 200_000);
    fs.appendFileSync(
      eventsPath,
      JSON.stringify({ type: "tool_started", tool_name: "bash" }) + "\n"
    );
    writeJsonl(path.join(sessionDir, "chat_history.jsonl"), [
      { type: "user", content: "Events partial limit" },
    ]);
    try {
      const meta = peekGrok(sessionDir);
      assert.equal(meta.firstPrompt, "Events partial limit");
      assert.deepEqual(meta.tools, []);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("session-peek jsonl sources", () => {
  test("peekClaude extracts prompt, model, and tools", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-peek-claude-"));
    const filePath = path.join(tmpDir, "session.jsonl");
    writeJsonl(filePath, [
      {
        type: "user",
        message: { content: [{ type: "text", text: "List project files" }] },
      },
      {
        type: "assistant",
        message: {
          model: "claude-sonnet-4",
          content: [
            { type: "tool_use", name: "Bash", input: {} },
            { type: "text", text: "Running ls" },
          ],
        },
      },
    ]);

    try {
      const size = fs.statSync(filePath).size;
      const meta = peekClaude(filePath, size);
      assert.equal(meta.firstPrompt, "List project files");
      assert.equal(meta.model, "claude-sonnet-4");
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("running") && meta.termFreqs.has("ls"));
      assert.deepEqual(meta.tools, ["Bash"]);
      assert.deepEqual(peekSession({ path: filePath, size, source: "claude" }), meta);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("peekClaude parses user_query tags via extractPrompt", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-peek-claude-tags-"));
    const filePath = path.join(tmpDir, "tags.jsonl");
    writeJsonl(filePath, [
      {
        type: "user",
        message: {
          content: [{ type: "text", text: "<user_query>\nRefactor session peek\n</user_query>" }],
        },
      },
    ]);
    try {
      const size = fs.statSync(filePath).size;
      const meta = peekClaude(filePath, size);
      assert.equal(meta.firstPrompt, "Refactor session peek");
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("refactor") && meta.termFreqs.has("session") && meta.termFreqs.has("peek"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("peekClaude skips meta user lines and angle-bracket prompts", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-peek-claude-skip-"));
    const filePath = path.join(tmpDir, "skip.jsonl");
    writeJsonl(filePath, [
      { type: "user", isMeta: true, message: { content: [{ type: "text", text: "Meta preamble" }] } },
      { type: "user", message: { content: [{ type: "text", text: "<system>hidden</system>" }] } },
      { type: "user", message: { content: [{ type: "text", text: "Real user question" }] } },
    ]);
    try {
      const size = fs.statSync(filePath).size;
      const meta = peekClaude(filePath, size);
      assert.equal(meta.firstPrompt, "Real user question");
      assert.ok(!(meta.termFreqs instanceof Map && meta.termFreqs.has("meta") && meta.termFreqs.has("preamble")));
      assert.ok(!(meta.termFreqs instanceof Map && meta.termFreqs.has("hidden")));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("peekClaude truncates firstPrompt to 200 characters", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-peek-claude-trunc-"));
    const filePath = path.join(tmpDir, "trunc.jsonl");
    const longText = "A".repeat(250);
    writeJsonl(filePath, [
      { type: "user", message: { content: [{ type: "text", text: longText }] } },
    ]);
    try {
      const size = fs.statSync(filePath).size;
      const meta = peekClaude(filePath, size);
      assert.equal(meta.firstPrompt.length, 200);
      assert.equal(meta.firstPrompt, longText.slice(0, 200));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("peekClaude skips JSON.parse on non user/assistant lines", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-peek-claude-skip-"));
    const filePath = path.join(tmpDir, "large.jsonl");
    const lines = [];
    for (let i = 0; i < 5000; i++) {
      lines.push(
        JSON.stringify({
          type: "tool_result",
          content: "x".repeat(200),
        }),
      );
      if (i % 3 === 0) {
        lines.push(
          JSON.stringify({
            type: "user",
            message: { content: [{ type: "text", text: `peek prompt ${i}` }] },
          }),
        );
      }
    }
    fs.writeFileSync(filePath, lines.join("\n") + "\n");
    try {
      const size = fs.statSync(filePath).size;
      const ITERS = 5;
      const t0 = performance.now();
      for (let i = 0; i < ITERS; i++) {
        const meta = peekClaude(filePath, size);
        assert.ok(meta.firstPrompt);
      }
      const ms = (performance.now() - t0) / ITERS;
      assertPerf(
        ms < 80,
        `expected peekClaude under 80ms for 5k-line synthetic session, got ${ms.toFixed(1)}ms`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("peekCodex skips JSON.parse on non-indexed lines", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-peek-codex-skip-"));
    const filePath = path.join(tmpDir, "rollout.jsonl");
    const lines = [];
    for (let i = 0; i < 5000; i++) {
      lines.push(
        JSON.stringify({
          type: "token_count",
          payload: { info: { last_token_usage: { input_tokens: 1, output_tokens: 2 } } },
        }),
      );
      if (i % 3 === 0) {
        lines.push(
          JSON.stringify({
            type: "response_item",
            payload: {
              role: "user",
              content: [{ type: "input_text", text: `peek codex prompt ${i}` }],
            },
          }),
        );
      }
    }
    fs.writeFileSync(filePath, lines.join("\n") + "\n");
    try {
      const size = fs.statSync(filePath).size;
      const ITERS = 5;
      const t0 = performance.now();
      for (let i = 0; i < ITERS; i++) {
        const meta = peekCodex(filePath, size);
        assert.ok(meta.firstPrompt);
      }
      const ms = (performance.now() - t0) / ITERS;
      assertPerf(
        ms < 80,
        `expected peekCodex under 80ms for 5k-line synthetic session, got ${ms.toFixed(1)}ms`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("peekCodex extracts session_meta model and event tools", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-peek-codex-"));
    const filePath = path.join(tmpDir, "rollout.jsonl");
    writeJsonl(filePath, [
      { type: "session_meta", payload: { model_provider: "openai" } },
      {
        type: "response_item",
        payload: {
          role: "user",
          content: [{ type: "input_text", text: "Fix the failing test" }],
        },
      },
      { type: "event_msg", payload: { type: "exec_command_end" } },
    ]);

    try {
      const size = fs.statSync(filePath).size;
      const meta = peekCodex(filePath, size);
      assert.equal(meta.firstPrompt, "Fix the failing test");
      assert.equal(meta.model, "openai");
      assert.ok(meta.tools.includes("Bash"));
      assert.deepEqual(peekSession({ path: filePath, size, source: "codex" }), meta);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("peekCodex skips the injected AGENTS.md first user item — firstPrompt is the true prompt (r8 real dialect)", () => {
    // Real rollouts open with a user response_item holding ONLY injected
    // blocks (recommended_plugins / AGENTS.md markdown / environment_context);
    // the true prompt arrives later as an event_msg user_message plus its own
    // response_item. firstPrompt must be the true prompt, or run attribution's
    // promptCorroborates can never match a launch prompt (r7 defect).
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-peek-codex-agents-"));
    const filePath = path.join(tmpDir, "rollout-agents.jsonl");
    writeJsonl(filePath, [
      { type: "session_meta", payload: { model_provider: "openai" } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "<recommended_plugins>\nplugins…\n</recommended_plugins>" },
            { type: "input_text", text: "# AGENTS.md instructions for /Users/dev/proj\n\n<INSTRUCTIONS>injected</INSTRUCTIONS>" },
            { type: "input_text", text: "<environment_context>\n  <cwd>/Users/dev/proj</cwd>\n</environment_context>" },
          ],
        },
      },
      { type: "event_msg", payload: { type: "user_message", message: "the real launch prompt" } },
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "the real launch prompt" }] },
      },
    ]);
    try {
      const size = fs.statSync(filePath).size;
      const meta = peekCodex(filePath, size);
      assert.equal(meta.firstPrompt, "the real launch prompt");
      assert.deepEqual(peekSession({ path: filePath, size, source: "codex" }), meta);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("peekCodex uses turn_context model and web_search_call tool", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-peek-codex-turn-"));
    const filePath = path.join(tmpDir, "turn.jsonl");
    writeJsonl(filePath, [
      { type: "turn_context", payload: { model: "gpt-5-codex" } },
      {
        type: "response_item",
        payload: { role: "user", content: [{ type: "input_text", text: "Search the web" }] },
      },
      { type: "response_item", payload: { type: "web_search_call" } },
    ]);
    try {
      const size = fs.statSync(filePath).size;
      const meta = peekCodex(filePath, size);
      assert.equal(meta.model, "gpt-5-codex");
      assert.ok(meta.tools.includes("WebSearch"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("peekFactory indexes factory message roles", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-peek-factory-"));
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
      const size = fs.statSync(filePath).size;
      const meta = peekFactory(filePath, size);
      assert.equal(meta.firstPrompt, "Ship the release");
      assert.equal(meta.model, "claude (factory)");
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("reading") && meta.termFreqs.has("changelog"));
      assert.deepEqual(meta.tools, ["Read"]);
      assert.deepEqual(peekSession({ path: filePath, size, source: "factory" }), meta);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("peekGrok reads prompt_context, events, and chat_history", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-peek-grok-"));
    const sessionDir = path.join(tmpDir, "sess-1");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "prompt_context.json"),
      JSON.stringify({ model_id: "grok-beta" })
    );
    writeJsonl(path.join(sessionDir, "events.jsonl"), [
      { type: "turn_started", model_id: "grok-live" },
      { type: "tool_started", tool_name: "web_search" },
    ]);
    writeJsonl(path.join(sessionDir, "chat_history.jsonl"), [
      { type: "user", content: "Summarize the repo" },
      { type: "assistant", content: "Here is a summary" },
    ]);

    try {
      const meta = peekGrok(sessionDir);
      assert.equal(meta.firstPrompt, "Summarize the repo");
      assert.equal(meta.model, "grok-live");
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("here") && meta.termFreqs.has("is") && meta.termFreqs.has("summary"));
      assert.ok(meta.tools.includes("WebSearch"));
      assert.deepEqual(peekSession({ path: sessionDir, source: "grok" }), meta);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("peekGrok uses prompt_context model when events omit turn_started", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-peek-grok-ctx-"));
    const sessionDir = path.join(tmpDir, "grok-ctx");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "prompt_context.json"),
      JSON.stringify({ model_id: "grok-from-context" })
    );
    writeJsonl(path.join(sessionDir, "chat_history.jsonl"), [
      { type: "user", content: "Context-only model" },
    ]);
    try {
      const meta = peekGrok(sessionDir);
      assert.equal(meta.model, "grok-from-context");
      assert.equal(meta.firstPrompt, "Context-only model");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("peekGrok skips JSON.parse on non user/assistant chat lines", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-peek-grok-skip-"));
    const sessionDir = path.join(tmpDir, "grok-skip");
    fs.mkdirSync(sessionDir, { recursive: true });
    const lines = [];
    for (let i = 0; i < 5000; i++) {
      lines.push(
        JSON.stringify({
          type: "tool_result",
          content: "x".repeat(400),
        }),
      );
      if (i % 3 === 0) {
        lines.push(JSON.stringify({ type: "user", content: `peek grok prompt ${i}` }));
      }
    }
    fs.writeFileSync(path.join(sessionDir, "chat_history.jsonl"), lines.join("\n") + "\n");
    try {
      const ITERS = 5;
      const t0 = performance.now();
      for (let i = 0; i < ITERS; i++) {
        const meta = peekGrok(sessionDir);
        assert.ok(meta.firstPrompt);
      }
      const ms = (performance.now() - t0) / ITERS;
      assertPerf(
        ms < 80,
        `expected peekGrok under 80ms for 5k-line synthetic session, got ${ms.toFixed(1)}ms`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("peekClaude returns empty meta for missing file", () => {
    const missing = path.join(os.tmpdir(), `tq-peek-missing-${Date.now()}.jsonl`);
    const meta = peekClaude(missing, 0);
    assert.equal(meta.firstPrompt, null);
    assert.equal(meta.model, null);
    assert.ok(meta.termFreqs === null || meta.termFreqs.size === 0);
    assert.deepEqual(meta.tools, []);
  });
});

describe("session-peek peekOpenCode", () => {
  test("reads prompts, model, and tools from opencode SQLite schema", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-peek-opencode-"));
    const dbDir = path.join(tmpDir, ".local", "share", "opencode");
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, "opencode.db");

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER)`);
    db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT)`);

    const msgUser = db.prepare(
      `INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)`
    );
    const msgAsst = db.prepare(
      `INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)`
    );
    const insPart = db.prepare(`INSERT INTO part (id, message_id, data) VALUES (?, ?, ?)`);

    msgUser.run("m1", "peek-oc-1", JSON.stringify({ role: "user", modelID: "gpt-4o" }), 100);
    insPart.run("p1", "m1", JSON.stringify({ type: "text", text: "OpenCode user prompt" }));

    msgAsst.run("m2", "peek-oc-1", JSON.stringify({ role: "assistant", modelID: "gpt-4o-mini" }), 200);
    insPart.run("p2", "m2", JSON.stringify({ type: "text", text: "Assistant reply" }));
    insPart.run("p3", "m2", JSON.stringify({ type: "tool", tool: "bash" }));
    db.close();

    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const session = {
        source: "opencode",
        file: "peek-oc-1",
        title: "Peek OC Title",
        path: "opencode://peek-oc-1",
      };
      const meta = peekOpenCode(session);
      assert.equal(meta.firstPrompt, "OpenCode user prompt");
      assert.equal(meta.searchText, undefined);
      assert.equal(meta.model, "gpt-4o");
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("peek") && meta.termFreqs.has("oc") && meta.termFreqs.has("title"));
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("assistant") && meta.termFreqs.has("reply"));
      assert.deepEqual(meta.tools, ["Bash"]);

      const viaDispatch = peekSession(session);
      assert.equal(viaDispatch.firstPrompt, meta.firstPrompt);
      assert.equal(viaDispatch.model, meta.model);
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("peekOpenCode collects tools after the first 20 prompt rows", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-peek-opencode-tools-late-"));
    const dbDir = path.join(tmpDir, ".local", "share", "opencode");
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, "opencode.db");

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER)`);
    db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT)`);

    const insMsg = db.prepare(
      `INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)`
    );
    const insPart = db.prepare(`INSERT INTO part (id, message_id, data) VALUES (?, ?, ?)`);

    for (let i = 0; i < 25; i++) {
      insMsg.run(`m${i}`, "peek-late-tools", JSON.stringify({ role: "user" }), 100 + i);
      insPart.run(`p${i}`, `m${i}`, JSON.stringify({ type: "text", text: `prompt ${i}` }));
    }
    insMsg.run("m-late", "peek-late-tools", JSON.stringify({ role: "assistant" }), 500);
    insPart.run("p-late", "m-late", JSON.stringify({ type: "tool", tool: "grep" }));
    db.close();

    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const session = {
        source: "opencode",
        file: "peek-late-tools",
        title: "Late Tools",
        path: "opencode://peek-late-tools",
      };
      const meta = peekOpenCode(session);
      assert.equal(meta.firstPrompt, "prompt 0");
      assert.deepEqual(meta.tools, ["Grep"]);
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("peekOpenCode indexes reasoning parts into termFreqs like indexOpenCode", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-peek-opencode-reasoning-"));
    const dbDir = path.join(tmpDir, ".local", "share", "opencode");
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, "opencode.db");

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER)`);
    db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT)`);

    const insMsg = db.prepare(
      `INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)`
    );
    const insPart = db.prepare(`INSERT INTO part (id, message_id, data) VALUES (?, ?, ?)`);

    insMsg.run("m1", "peek-reasoning", JSON.stringify({ role: "assistant", modelID: "gpt-4o" }), 100);
    insPart.run(
      "p1",
      "m1",
      JSON.stringify({ type: "reasoning", text: "dissectinglogic the problem step by step." }),
    );
    insPart.run("p2", "m1", JSON.stringify({ type: "text", text: "Short reply." }));
    db.close();

    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const session = {
        source: "opencode",
        file: "peek-reasoning",
        title: "Reasoning Peek",
        path: "opencode://peek-reasoning",
      };
      const meta = peekOpenCode(session);
      assert.ok(meta.termFreqs instanceof Map, "termFreqs must be a Map");
      assert.ok(meta.termFreqs.has("dissectinglogic"), "reasoning text must be tokenized into termFreqs");
      assert.ok(meta.termFreqs.has("step"), "reasoning text words must appear in termFreqs");
      assert.equal(meta.firstPrompt, "Reasoning Peek", "reasoning must not become firstPrompt");
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("peekOpenCode falls back to session title when database is unavailable", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-peek-opencode-fallback-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const session = {
        source: "opencode",
        file: "missing-session",
        title: "Offline Session Title",
        path: "opencode://missing-session",
      };
      const meta = peekOpenCode(session);
      assert.equal(meta.firstPrompt, "Offline Session Title");
      assert.equal(meta.searchText, undefined);
      assert.equal(meta.model, null);
      assert.ok(meta.termFreqs === null || meta.termFreqs.size === 0);
      assert.deepEqual(meta.tools, []);
      assert.deepEqual(peekSession(session), meta);
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
