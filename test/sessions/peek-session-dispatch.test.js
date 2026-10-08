/**
 * peekSession dispatch table: every known source must route to the correct peek* impl.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  peekSession,
  peekClaude,
  peekCursor,
  peekCursorCloud,
  peekCodex,
  peekFactory,
  peekGrok,
  peekOpenCode,
} from "../../src/sessions/session-peek.js";
import { mkTmp, writeJsonl } from "../helpers/fixtures.js";

const PEEK_META_KEYS = ["firstPrompt", "model", "termFreqs", "tools"];

function assertPeekShape(meta, label) {
  for (const key of PEEK_META_KEYS) {
    assert.ok(key in meta, `${label}: missing ${key}`);
  }
  assert.ok(Array.isArray(meta.tools), `${label}: tools must be an array`);
}

function assertDispatchEquals(session, directFn, ...directArgs) {
  const expected = directFn(...directArgs);
  const actual = peekSession(session);
  assert.deepEqual(actual, expected);
  assertPeekShape(actual, session.source ?? "(default claude)");
}

describe("peekSession dispatch table", () => {
  test("missing source defaults to peekClaude", () => {
    const tmpDir = mkTmp("tq-peek-dispatch-default-");
    const filePath = path.join(tmpDir, "session.jsonl");
    writeJsonl(filePath, [
      { type: "user", message: { content: [{ type: "text", text: "Default claude dispatch" }] } },
    ]);
    try {
      const size = fs.statSync(filePath).size;
      assertDispatchEquals({ path: filePath, size }, peekClaude, filePath, size);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("explicit claude source routes to peekClaude", () => {
    const tmpDir = mkTmp("tq-peek-dispatch-claude-");
    const filePath = path.join(tmpDir, "explicit.jsonl");
    writeJsonl(filePath, [
      {
        type: "assistant",
        message: { model: "claude-sonnet", content: [{ type: "text", text: "claude dispatch" }] },
      },
    ]);
    try {
      const size = fs.statSync(filePath).size;
      assertDispatchEquals({ path: filePath, size, source: "claude" }, peekClaude, filePath, size);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("codex source routes to peekCodex with file size", () => {
    const tmpDir = mkTmp("tq-peek-dispatch-codex-");
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
      assertDispatchEquals({ path: filePath, size, source: "codex" }, peekCodex, filePath, size);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("factory source routes to peekFactory with file size", () => {
    const tmpDir = mkTmp("tq-peek-dispatch-factory-");
    const filePath = path.join(tmpDir, "factory.jsonl");
    writeJsonl(filePath, [
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "Factory dispatch probe" }] },
      },
    ]);
    try {
      const size = fs.statSync(filePath).size;
      assertDispatchEquals({ path: filePath, size, source: "factory" }, peekFactory, filePath, size);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("grok source routes to peekGrok on session path (directory)", () => {
    const tmpDir = mkTmp("tq-peek-dispatch-grok-");
    const sessionDir = path.join(tmpDir, "grok-sess");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "prompt_context.json"), JSON.stringify({ model_id: "grok-3" }));
    writeJsonl(path.join(sessionDir, "chat_history.jsonl"), [
      { type: "user", content: "Grok dispatch probe" },
    ]);
    try {
      assertDispatchEquals({ path: sessionDir, source: "grok" }, peekGrok, sessionDir);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("grok dispatch ignores session.size (only path is passed through)", () => {
    const tmpDir = mkTmp("tq-peek-dispatch-grok-size-");
    const sessionDir = path.join(tmpDir, "grok-size");
    fs.mkdirSync(sessionDir, { recursive: true });
    writeJsonl(path.join(sessionDir, "chat_history.jsonl"), [
      { type: "user", content: "Size should not matter for grok" },
    ]);
    try {
      const direct = peekGrok(sessionDir);
      const withWrongSize = peekSession({ path: sessionDir, source: "grok", size: 1 });
      assert.deepEqual(withWrongSize, direct);
      assert.equal(withWrongSize.firstPrompt, "Size should not matter for grok");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("opencode source routes to peekOpenCode with full session row", async () => {
    const tmpDir = mkTmp("tq-peek-dispatch-opencode-");
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
    const insPart = db.prepare(`INSERT INTO part (id, message_id, data) VALUES (?, ?, ?)`);

    msgUser.run("m1", "dispatch-oc", JSON.stringify({ role: "user", modelID: "gpt-4o" }), 100);
    insPart.run("p1", "m1", JSON.stringify({ type: "text", text: "OpenCode dispatch user prompt" }));
    db.close();

    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const session = {
        source: "opencode",
        file: "dispatch-oc",
        title: "Dispatch OC Title",
        path: "opencode://dispatch-oc",
        size: 0,
      };
      assertDispatchEquals(session, peekOpenCode, session);
      const dispatchMeta = peekSession(session);
      assert.ok(dispatchMeta.termFreqs instanceof Map && dispatchMeta.termFreqs.has("dispatch") && dispatchMeta.termFreqs.has("oc") && dispatchMeta.termFreqs.has("title"));
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("opencode without database still receives session.title via dispatch", () => {
    const tmpDir = mkTmp("tq-peek-dispatch-opencode-fallback-");
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const session = {
        source: "opencode",
        file: "missing-oc",
        title: "Title-only via peekSession",
        path: "opencode://missing-oc",
      };
      assertDispatchEquals(session, peekOpenCode, session);
      assert.equal(peekSession(session).firstPrompt, "Title-only via peekSession");
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("empty string source falls back to peekClaude (falsy → default claude)", () => {
    const tmpDir = mkTmp("tq-peek-dispatch-empty-source-");
    const filePath = path.join(tmpDir, "empty-src.jsonl");
    writeJsonl(filePath, [
      { type: "user", message: { content: [{ type: "text", text: "Empty source uses claude" }] } },
    ]);
    try {
      const size = fs.statSync(filePath).size;
      assertDispatchEquals({ path: filePath, size, source: "" }, peekClaude, filePath, size);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("cursor source routes to peekCursor", () => {
    const tmpDir = mkTmp("tq-peek-dispatch-cursor-");
    const filePath = path.join(tmpDir, "cursor.jsonl");
    writeJsonl(filePath, [
      { type: "user", message: { content: [{ type: "text", text: "Cursor-shaped jsonl" }] } },
    ]);
    try {
      const size = fs.statSync(filePath).size;
      assertDispatchEquals({ path: filePath, size, source: "cursor" }, peekCursor, filePath, size);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("cursor-cloud source routes to peekCursorCloud", () => {
    const tmpDir = mkTmp("tq-peek-dispatch-cursor-cloud-");
    const filePath = path.join(tmpDir, "bc-dispatch.jsonl");
    writeJsonl(filePath, [
      {
        type: "session_meta",
        bcId: "bc-dispatch",
        name: "Cloud dispatch probe",
        status: "FINISHED",
        createdAt: "2026-07-01T10:00:00Z",
        updatedAt: "2026-07-01T11:00:00Z",
        model: "gpt-5-cursor",
      },
      { role: "user", message: { content: [{ type: "text", text: "Cursor-cloud shaped jsonl" }] } },
    ]);
    try {
      const size = fs.statSync(filePath).size;
      assertDispatchEquals({ path: filePath, size, source: "cursor-cloud" }, peekCursorCloud, filePath, size);
      const meta = peekSession({ path: filePath, size, source: "cursor-cloud" });
      assert.equal(meta.model, "gpt-5-cursor");
      // session_meta.name feeds termFreqs alongside the message rows (fact ccpk).
      assert.ok(meta.termFreqs.has("dispatch") && meta.termFreqs.has("probe"));
      assert.equal(meta.firstPrompt, "Cursor-cloud shaped jsonl");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("windsurf source falls back to peekClaude", () => {
    const tmpDir = mkTmp("tq-peek-dispatch-windsurf-");
    const filePath = path.join(tmpDir, "windsurf.jsonl");
    writeJsonl(filePath, [
      { type: "user", message: { content: [{ type: "text", text: "Windsurf-shaped jsonl" }] } },
    ]);
    try {
      const size = fs.statSync(filePath).size;
      assertDispatchEquals({ path: filePath, size, source: "windsurf" }, peekClaude, filePath, size);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("unknown legacy provider falls back to peekClaude", () => {
    const tmpDir = mkTmp("tq-peek-dispatch-legacy-");
    const filePath = path.join(tmpDir, "legacy.jsonl");
    writeJsonl(filePath, [
      { type: "user", message: { content: [{ type: "text", text: "Legacy vendor still Claude-shaped" }] } },
    ]);
    try {
      const size = fs.statSync(filePath).size;
      assertDispatchEquals(
        { path: filePath, size, source: "legacy-provider" },
        peekClaude,
        filePath,
        size
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("codex dispatch forwards session.size into partial read window", () => {
    const tmpDir = mkTmp("tq-peek-dispatch-codex-size-");
    const filePath = path.join(tmpDir, "codex-partial.jsonl");
    writeJsonl(filePath, [
      {
        type: "response_item",
        payload: { role: "user", content: [{ type: "input_text", text: "Early codex dispatch prompt" }] },
      },
    ]);
    const fillerLine = JSON.stringify({ type: "padding", payload: "x" }) + "\n";
    fs.appendFileSync(filePath, fillerLine.repeat(Math.ceil(600_000 / Buffer.byteLength(fillerLine, "utf-8"))));
    fs.appendFileSync(
      filePath,
      JSON.stringify({
        type: "response_item",
        payload: { role: "user", content: [{ type: "input_text", text: "Late codex dispatch prompt" }] },
      }) + "\n"
    );
    try {
      const fullSize = fs.statSync(filePath).size;
      const tinySize = 80;
      const viaDispatch = peekSession({ path: filePath, size: tinySize, source: "codex" });
      const directTiny = peekCodex(filePath, tinySize);
      assert.deepEqual(viaDispatch, directTiny);
      assert.equal(viaDispatch.firstPrompt, null, "tiny size must not read full first line");
      const fullMeta = peekCodex(filePath, fullSize);
      assert.equal(fullMeta.firstPrompt, "Early codex dispatch prompt");
      assert.deepEqual(
        peekSession({ path: filePath, size: fullSize, source: "codex" }),
        fullMeta
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("table: Claude-shaped vendors all deepEqual peekClaude", () => {
    const tmpDir = mkTmp("tq-peek-dispatch-vendors-");
    const filePath = path.join(tmpDir, "vendors.jsonl");
    writeJsonl(filePath, [
      { type: "user", message: { content: [{ type: "text", text: "Shared vendor fixture" }] } },
    ]);
    const size = fs.statSync(filePath).size;
    const expected = peekClaude(filePath, size);
    const vendors = ["aider", "continue", "copilot", "cline", "zed"];
    try {
      for (const source of vendors) {
        assert.deepEqual(
          peekSession({ path: filePath, size, source }),
          expected,
          `source=${source} must route to peekClaude`
        );
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
