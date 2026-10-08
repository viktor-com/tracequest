import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSession } from "../../src/parse.js";
import { sessionToApiObject } from "../../src/server/server-helpers.js";
import {
  attachSessionHash,
  findSessionsByHash,
  isSessionHash,
  resolveSessionHandle,
  sessionHash,
} from "../../src/sessions/session-hash.js";

function expectedHash(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, 8);
}

function writeClaudeSession(dir, name = "session.jsonl") {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    [
      JSON.stringify({
        type: "user",
        sessionId: "native-session-id",
        timestamp: "2026-06-03T12:00:00.000Z",
        uuid: "u1",
        isMeta: false,
        message: { content: "hello hash" },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-03T12:00:01.000Z",
        uuid: "a1",
        message: { model: "claude-test", content: [{ type: "text", text: "ok" }] },
      }),
    ].join("\n") + "\n"
  );
  return file;
}

describe("sessionHash", () => {
  test("derives stable 8-character lowercase hex hashes from canonical paths", () => {
    const filePath = "/home/dev/.claude/projects/proj/session.jsonl";
    const ocPath = "opencode://ses_1c558d1a8ffeLIDNXi2mi8401L";
    assert.equal(sessionHash(filePath), expectedHash(filePath));
    assert.equal(sessionHash(ocPath), expectedHash(ocPath));
    assert.match(sessionHash(filePath), /^[0-9a-f]{8}$/);
    assert.equal(isSessionHash(sessionHash(filePath)), true);
  });

  test("attaches sessionHash to parsed sessions and API objects", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tq-session-hash-"));
    try {
      const file = writeClaudeSession(tmp);
      const parsed = parseSession(file, "claude");
      assert.equal(parsed.path, file);
      assert.equal(parsed.sessionHash, sessionHash(file));

      const row = { path: file, source: "claude", project: "proj", file: "session.jsonl", size: 1, mtime: new Date(0) };
      const api = sessionToApiObject(row, { firstPrompt: "hello" });
      assert.equal(api.id, sessionHash(file));
      assert.equal(api.sessionHash, sessionHash(file));
      assert.equal(api.path, file);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("resolves unique hashes and reports missing or ambiguous handles", () => {
    const sessions = [
      { path: "/tmp/a.jsonl" },
      { path: "/tmp/b.jsonl" },
    ];
    const hash = sessionHash("/tmp/a.jsonl");
    assert.deepEqual(findSessionsByHash(hash, sessions), [sessions[0]]);
    assert.equal(resolveSessionHandle(hash, sessions).session, sessions[0]);
    assert.equal(resolveSessionHandle("00000000", sessions).status, "not-found");

    const dup = { path: "/tmp/a.jsonl" };
    assert.equal(resolveSessionHandle(hash, [...sessions, dup]).status, "ambiguous");
  });

  test("attachSessionHash mutates session-like discovery rows in place", () => {
    const row = { path: "/tmp/in-place.jsonl" };
    assert.equal(attachSessionHash(row), row);
    assert.equal(row.sessionHash, sessionHash(row.path));
  });
});
