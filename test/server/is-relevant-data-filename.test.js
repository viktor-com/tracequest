import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isRelevantDataFilename } from "../../src/server/server-live-reload.js";

describe("isRelevantDataFilename (live-reload data watcher filter)", () => {
  it("accepts nested chat_history session artifacts", () => {
    assert.equal(isRelevantDataFilename("nested/chat_history/turn.json"), true);
    assert.equal(isRelevantDataFilename("proj/.opencode/chat_history/msg.json"), true);
  });

  it("accepts chat_history anywhere in the basename", () => {
    assert.equal(isRelevantDataFilename("chat_history"), true);
    assert.equal(isRelevantDataFilename("prefix-chat_history-suffix.log"), true);
  });

  it("accepts .jsonl session logs at any depth", () => {
    assert.equal(isRelevantDataFilename("session.jsonl"), true);
    assert.equal(isRelevantDataFilename("agents/run-2024/session.jsonl"), true);
  });

  it("rejects .jsonl only when it is not the suffix", () => {
    assert.equal(isRelevantDataFilename("session.jsonl.tmp"), false);
    assert.equal(isRelevantDataFilename("session.jsonl.bak"), false);
    assert.equal(isRelevantDataFilename("not-jsonl.json"), false);
  });

  it("accepts grok active_sessions.json for live session updates", () => {
    assert.equal(isRelevantDataFilename("active_sessions.json"), true);
  });

  it("accepts opencode.db paths used by session discovery", () => {
    assert.equal(isRelevantDataFilename("share/opencode.db"), true);
    assert.equal(isRelevantDataFilename("opencode.db"), true);
    assert.equal(isRelevantDataFilename("home/.local/share/opencode.db"), true);
  });

  it("accepts opencode.db as an infix segment (wal/shm siblings)", () => {
    assert.equal(isRelevantDataFilename("opencode.db-wal"), true);
    assert.equal(isRelevantDataFilename("backup/opencode.db-journal"), true);
  });

  it("rejects index and config files that should not debounce SSE", () => {
    assert.equal(isRelevantDataFilename("index.json"), false);
    assert.equal(isRelevantDataFilename("package-lock.json"), false);
    assert.equal(isRelevantDataFilename("config.toml"), false);
  });

  it("rejects README, dotfiles, and other non-session noise", () => {
    assert.equal(isRelevantDataFilename("README"), false);
    assert.equal(isRelevantDataFilename(".git/index"), false);
    assert.equal(isRelevantDataFilename("tracequest.log"), false);
  });

  it("rejects falsy and empty watcher filenames", () => {
    assert.equal(isRelevantDataFilename(null), false);
    assert.equal(isRelevantDataFilename(undefined), false);
    assert.equal(isRelevantDataFilename(""), false);
  });

  it("rejects whitespace-only filenames", () => {
    assert.equal(isRelevantDataFilename("   "), false);
    assert.equal(isRelevantDataFilename("\t"), false);
  });

  it("is case-sensitive for .jsonl suffix", () => {
    assert.equal(isRelevantDataFilename("session.JSONL"), false);
    assert.equal(isRelevantDataFilename("SESSION.jsonl"), true);
  });

  it("does not treat chat_history-like names without the substring as relevant", () => {
    assert.equal(isRelevantDataFilename("chat.json"), false);
    assert.equal(isRelevantDataFilename("history/chat.json"), false);
  });

  it("grok session dir artifacts: chat_history.jsonl, events.jsonl, not prompt_context", () => {
    assert.equal(
      isRelevantDataFilename("sessions/%2Fproj%2Ffoo/abc123/chat_history.jsonl"),
      true
    );
    assert.equal(
      isRelevantDataFilename("sessions/%2Fproj%2Ffoo/abc123/events.jsonl"),
      true
    );
    assert.equal(
      isRelevantDataFilename("sessions/%2Fproj%2Ffoo/abc123/prompt_context.json"),
      false
    );
    assert.equal(isRelevantDataFilename("events.JSONL"), false);
  });

  it("active_sessions: basename-only match and case-sensitive name", () => {
    assert.equal(isRelevantDataFilename("active_sessions.json"), true);
    assert.equal(isRelevantDataFilename("active_sessions.JSON"), false);
    assert.equal(isRelevantDataFilename("nested/active_sessions.json"), true);
    assert.equal(isRelevantDataFilename("prefix-active_sessions.json"), false);
    assert.equal(isRelevantDataFilename("active_sessions.json.bak"), false);
  });

  it("opencode.db canonical share path and sqlite sidecar siblings", () => {
    assert.equal(
      isRelevantDataFilename(".local/share/opencode/opencode.db"),
      true
    );
    assert.equal(
      isRelevantDataFilename("share/opencode/opencode.db-wal"),
      true
    );
    assert.equal(
      isRelevantDataFilename("share/opencode/opencode.db-shm"),
      true
    );
    assert.equal(isRelevantDataFilename("OPENCODE.DB"), false);
  });

  it("path-segment traps: chat_history substring vs basename-only active_sessions", () => {
    assert.equal(
      isRelevantDataFilename("workspaces/ws-id/chat_history.jsonl"),
      true
    );
    assert.equal(
      isRelevantDataFilename("archives/chat_history-v1/events.jsonl"),
      true
    );
    assert.equal(
      isRelevantDataFilename("notes/chat_history_readme.md"),
      true
    );
    assert.equal(isRelevantDataFilename("sessions/ws-id/notes.log"), false);
  });
});