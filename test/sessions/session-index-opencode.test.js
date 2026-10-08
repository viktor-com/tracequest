import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  indexOpenCode,
  accumulateOpenCodeMessages,
} from "../../src/sessions/session-index-opencode.js";
import { indexSession } from "../../src/sessions/session-index-core.js";
import { emptyIndexMeta } from "../../src/sessions/session-meta.js";
import { loadDatabaseSync, resolveOpenCodeDbPath } from "../../src/sessions/session-discovery-paths.js";
import { mkTmp } from "../helpers/fixtures.js";
import { assertPerf } from "../helpers/perf-assert.js";

function openCodeDbPath(home) {
  return resolveOpenCodeDbPath(home);
}

function withOpenCodeHome(fn) {
  const tmpDir = mkTmp("tq-index-oc-");
  const originalHome = process.env.HOME;
  process.env.HOME = tmpDir;
  return (async () => {
    try {
      return await fn(tmpDir);
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  })();
}

/** Discovery-shaped DB (session + simple message rows) for msg-count filter tests. */
async function seedDiscoveryOpenCodeDb(home, sessions) {
  const dbPath = openCodeDbPath(home);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(
    `CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, version TEXT, time_created INTEGER, time_updated INTEGER)`
  );
  db.exec(`CREATE TABLE message (session_id TEXT, role TEXT, content TEXT)`);
  const insS = db.prepare(
    `INSERT INTO session (id, title, directory, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insM = db.prepare(`INSERT INTO message (session_id, role, content) VALUES (?, ?, ?)`);
  for (const s of sessions) {
    insS.run(
      s.id,
      s.title ?? s.id,
      s.directory ?? "/tmp/ocproj",
      s.version ?? "1.0",
      s.time_created ?? 1715731200,
      s.time_updated ?? s.time_created ?? 1715731200
    );
    const count = s.msgCount ?? 0;
    for (let i = 0; i < count; i++) insM.run(s.id, "user", `msg-${i}`);
  }
  db.close();
  return dbPath;
}

/**
 * Indexing-shaped DB (message/part JSON blobs) used by indexOpenCode queries.
 * @param {string} dbPath
 * @param {Array<{ id: string, title?: string, messages?: Array<{ role?: string, modelID?: string, time?: string|number, parts?: Array<object> }> }>} sessions
 */
async function seedIndexOpenCodeDb(dbPath, sessions) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created TEXT)`);
  db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT)`);
  const insMsg = db.prepare(
    `INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)`
  );
  const insPart = db.prepare(`INSERT INTO part (id, message_id, data) VALUES (?, ?, ?)`);

  let msgSeq = 0;
  let partSeq = 0;
  for (const sess of sessions) {
    for (const msg of sess.messages ?? []) {
      const mid = `m${++msgSeq}`;
      insMsg.run(
        mid,
        sess.id,
        JSON.stringify({ role: msg.role ?? "user", modelID: msg.modelID }),
        msg.time ?? "2026-05-01T00:00:00Z"
      );
      for (const part of msg.parts ?? []) {
        insPart.run(`p${++partSeq}`, mid, JSON.stringify(part));
      }
    }
  }
  db.close();
}

function sessionRow(id, title = id) {
  return {
    source: "opencode",
    file: id,
    title,
    path: `opencode://${id}`,
  };
}

function withErrorSpy(fn) {
  const errorSpy = mock.method(console, "error", () => {});
  try {
    return fn(errorSpy);
  } finally {
    errorSpy.mock.restore();
  }
}

function errorMessages(spy) {
  return spy.mock.calls.map((c) => c.arguments.map(String).join(" "));
}

describe("session-index-opencode SQLite helpers", () => {
  test("accumulateOpenCodeMessages durationMs spans first and last message timestamps", async () =>
    withOpenCodeHome(async (home) => {
      const dbPath = openCodeDbPath(home);
      await seedIndexOpenCodeDb(dbPath, [
        {
          id: "dur-1",
          messages: [
            { time: "2026-05-01T00:00:00Z", parts: [{ type: "text", text: "start" }] },
            { role: "assistant", time: "2026-05-01T00:10:00Z", parts: [{ type: "text", text: "end" }] },
          ],
        },
      ]);
      const db = new (loadDatabaseSync())(dbPath, { readOnly: true });
      assert.equal(accumulateOpenCodeMessages(db, "dur-1").durationMs, 600000);
      db.close();
    }));

  test("accumulateOpenCodeMessages accumulates step-finish token usage", async () =>
    withOpenCodeHome(async (home) => {
      const dbPath = openCodeDbPath(home);
      await seedIndexOpenCodeDb(dbPath, [
        {
          id: "tok-1",
          messages: [
            {
              role: "assistant",
              parts: [
                { type: "text", text: "done" },
                {
                  type: "step-finish",
                  tokens: { input: 120, output: 40, cache: { read: 30, write: 0 } },
                },
              ],
            },
            {
              role: "assistant",
              parts: [
                {
                  type: "step-finish",
                  tokens: { input: 50, output: 10, cache: { read: 5, write: 2 } },
                },
              ],
            },
          ],
        },
      ]);
      const db = new (loadDatabaseSync())(dbPath, { readOnly: true });
      const msgs = accumulateOpenCodeMessages(db, "tok-1");
      assert.equal(msgs.inputTokens, 207);
      assert.equal(msgs.outputTokens, 50);
      assert.equal(msgs.cacheReadTokens, 35);
      assert.equal(msgs.totalTokens, 257);
      db.close();
    }));

  test("indexOpenCode exposes accumulated step-finish tokens in metadata", async () =>
    withOpenCodeHome(async (home) => {
      await seedIndexOpenCodeDb(openCodeDbPath(home), [
        {
          id: "tok-meta",
          messages: [
            {
              role: "assistant",
              parts: [
                {
                  type: "step-finish",
                  tokens: { input: 80, output: 20, cache: { read: 10, write: 0 } },
                },
              ],
            },
          ],
        },
      ]);
      const meta = indexOpenCode(sessionRow("tok-meta"));
      assert.equal(meta.inputTokens, 90);
      assert.equal(meta.outputTokens, 20);
      assert.equal(meta.cacheReadTokens, 10);
      assert.equal(meta.totalTokens, 110);
    }));

  test("accumulateOpenCodeMessages returns zero duration for unknown session id", async () =>
    withOpenCodeHome(async (home) => {
      const dbPath = openCodeDbPath(home);
      await seedIndexOpenCodeDb(dbPath, [{ id: "other", messages: [{ parts: [{ type: "text", text: "x" }] }] }]);
      const db = new (loadDatabaseSync())(dbPath, { readOnly: true });
      assert.equal(accumulateOpenCodeMessages(db, "missing").durationMs, 0);
      db.close();
    }));

  test("accumulateOpenCodeMessages skips text parts that start with angle brackets", async () =>
    withOpenCodeHome(async (home) => {
      const dbPath = openCodeDbPath(home);
      await seedIndexOpenCodeDb(dbPath, [
        {
          id: "angle",
          messages: [
            {
              role: "user",
              parts: [{ type: "text", text: "<system>hidden</system>" }, { type: "text", text: "visible" }],
            },
          ],
        },
      ]);
      const db = new (loadDatabaseSync())(dbPath, { readOnly: true });
      const msgs = accumulateOpenCodeMessages(db, "angle");
      assert.equal(msgs.firstPrompt, "visible");
      assert.ok(!msgs.termFreqs || !msgs.termFreqs.has("hidden"));
      db.close();
    }));

  test("accumulateOpenCodeMessages indexes text parts into termFreqs", async () =>
    withOpenCodeHome(async (home) => {
      const dbPath = openCodeDbPath(home);
      await seedIndexOpenCodeDb(dbPath, [
        {
          id: "search-text",
          messages: [
            { role: "user", parts: [{ type: "text", text: "alpha" }] },
            { role: "assistant", parts: [{ type: "text", text: "beta gamma" }] },
          ],
        },
      ]);
      const db = new (loadDatabaseSync())(dbPath, { readOnly: true });
      const msgs = accumulateOpenCodeMessages(db, "search-text");
      assert.ok(msgs.termFreqs instanceof Map);
      assert.ok(msgs.termFreqs.has("alpha") && msgs.termFreqs.has("beta") && msgs.termFreqs.has("gamma"));
      db.close();
    }));

  test("indexOpenCode builds termFreqs incrementally on multi-part message", async () =>
    withOpenCodeHome(async (home) => {
      const dbPath = openCodeDbPath(home);
      const bigMsg = JSON.stringify({ role: "user", modelID: "gpt-4o", filler: "x".repeat(8 * 1024) });
      const parts = Array.from({ length: 30 }, (_, i) => ({
        type: "text",
        text: `part-${i} ${"y".repeat(200)}`,
      }));
      const { DatabaseSync } = await import("node:sqlite");
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const db = new DatabaseSync(dbPath);
      db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created TEXT)`);
      db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT)`);
      db.prepare(
        `INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)`
      ).run("m1", "perf-oc", bigMsg, "2026-05-01T00:00:00Z");
      const insPart = db.prepare(`INSERT INTO part (id, message_id, data) VALUES (?, ?, ?)`);
      parts.forEach((part, i) => insPart.run(`p${i}`, "m1", JSON.stringify(part)));
      db.close();

      const session = sessionRow("perf-oc", "Perf Title");
      const ITERS = 200;
      const t0 = performance.now();
      for (let i = 0; i < ITERS; i++) indexOpenCode(session);
      const ms = (performance.now() - t0) / ITERS;
      assertPerf(
        ms < 8,
        `expected indexOpenCode under 8ms/op for 30-part message with 8KB msg JSON, got ${ms.toFixed(2)}ms`,
      );
      const meta = indexOpenCode(session);
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("part"));
    }));

  test("accumulateOpenCodeMessages indexes many parts on one message once", async () =>
    withOpenCodeHome(async (home) => {
      const dbPath = openCodeDbPath(home);
      const parts = Array.from({ length: 25 }, (_, i) => ({
        type: "text",
        text: `chunk-${i}`,
      }));
      await seedIndexOpenCodeDb(dbPath, [
        {
          id: "multi-part",
          messages: [{ role: "user", modelID: "gpt-4o", parts }],
        },
      ]);
      const db = new (loadDatabaseSync())(dbPath, { readOnly: true });
      const msgs = accumulateOpenCodeMessages(db, "multi-part");
      assert.equal(msgs.chapters, 1);
      assert.equal(msgs.firstPrompt, "chunk-0");
      assert.ok(msgs.termFreqs instanceof Map && msgs.termFreqs.has("chunk"));
      db.close();
    }));

  test("accumulateOpenCodeMessages counts user chapters and uses content field", async () =>
    withOpenCodeHome(async (home) => {
      const dbPath = openCodeDbPath(home);
      await seedIndexOpenCodeDb(dbPath, [
        {
          id: "ch-1",
          messages: [
            {
              role: "user",
              modelID: "gpt-4o",
              parts: [
                { type: "text", text: "Visible first prompt" },
                { type: "tool", tool: "bash" },
              ],
            },
            { role: "user", parts: [{ type: "text", text: "Second chapter ask" }] },
            { role: "assistant", parts: [{ type: "text", content: "assistant via content field" }] },
          ],
        },
      ]);
      const db = new (loadDatabaseSync())(dbPath, { readOnly: true });
      const msgs = accumulateOpenCodeMessages(db, "ch-1");
      assert.equal(msgs.firstPrompt, "Visible first prompt");
      assert.equal(msgs.model, "gpt-4o");
      assert.equal(msgs.chapters, 2);
      assert.ok(msgs.termFreqs instanceof Map && msgs.termFreqs.has("assistant") && msgs.termFreqs.has("content") && msgs.termFreqs.has("field"));
      assert.ok(!msgs.termFreqs || !msgs.termFreqs.has("bash"));
      db.close();
    }));

  test("accumulateOpenCodeMessages normalizes multiple tools", async () =>
    withOpenCodeHome(async (home) => {
      const dbPath = openCodeDbPath(home);
      await seedIndexOpenCodeDb(dbPath, [
        {
          id: "tools-1",
          messages: [
            {
              role: "assistant",
              parts: [
                { type: "tool", tool: "bash" },
                { type: "tool", tool: "bash" },
                { type: "tool", tool: "read" },
              ],
            },
          ],
        },
      ]);
      const db = new (loadDatabaseSync())(dbPath, { readOnly: true });
      const { tools, toolCounts } = accumulateOpenCodeMessages(db, "tools-1");
      assert.deepEqual(tools.sort(), ["Bash", "Read"]);
      assert.equal(toolCounts.Bash, 2);
      assert.equal(toolCounts.Read, 1);
      db.close();
    }));

  test("accumulateOpenCodeMessages tallies parts with error status", async () =>
    withOpenCodeHome(async (home) => {
      const dbPath = openCodeDbPath(home);
      await seedIndexOpenCodeDb(dbPath, [
        {
          id: "err-1",
          messages: [
            {
              role: "assistant",
              parts: [
                { type: "tool", tool: "bash", status: "error" },
                { type: "tool", tool: "bash", status: "ok" },
                { type: "text", text: "fine" },
              ],
            },
          ],
        },
      ]);
      const db = new (loadDatabaseSync())(dbPath, { readOnly: true });
      assert.equal(accumulateOpenCodeMessages(db, "err-1").errors, 1);
      db.close();
    }));

  test("accumulateOpenCodeMessages truncates firstPrompt to 200 characters", async () =>
    withOpenCodeHome(async (home) => {
      const dbPath = openCodeDbPath(home);
      const long = "z".repeat(260);
      await seedIndexOpenCodeDb(dbPath, [
        {
          id: "long-prompt",
          messages: [{ role: "user", parts: [{ type: "text", text: long }] }],
        },
      ]);
      const db = new (loadDatabaseSync())(dbPath, { readOnly: true });
      const msgs = accumulateOpenCodeMessages(db, "long-prompt");
      assert.equal(msgs.firstPrompt.length, 200);
      assert.equal(msgs.firstPrompt, long.slice(0, 200));
      db.close();
    }));

  test("indexOpenCode logs and returns empty meta when message table is missing", async () =>
    withOpenCodeHome(async (home) => {
      const dbPath = openCodeDbPath(home);
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(dbPath);
      db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT)`);
      db.close();

      const ro = new (loadDatabaseSync())(dbPath, { readOnly: true });
      withErrorSpy((spy) => {
        const meta = indexOpenCode(sessionRow("any", "Any Title"), ro);
        assert.deepEqual(meta.tools, []);
        assert.equal(meta.durationMs, 0);
        assert.equal(meta.firstPrompt, "Any Title");
        assert.equal(spy.mock.calls.length, 1);
        assert.match(errorMessages(spy)[0], /indexOpenCode: failed to index any/);
      });
      ro.close();
    }));

  test("indexOpenCode logs and returns empty meta when part table is missing", async () =>
    withOpenCodeHome(async (home) => {
      const dbPath = openCodeDbPath(home);
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(dbPath);
      db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created TEXT)`);
      db.close();

      const ro = new (loadDatabaseSync())(dbPath, { readOnly: true });
      withErrorSpy((spy) => {
        const meta = indexOpenCode(sessionRow("sess", "Sess Title"), ro);
        assert.deepEqual(meta.tools, []);
        assert.deepEqual(meta.toolCounts, {});
        assert.equal(meta.firstPrompt, "Sess Title");
        assert.equal(spy.mock.calls.length, 1);
        assert.match(errorMessages(spy)[0], /indexOpenCode: failed to index sess/);
      });
      ro.close();
    }));
});

describe("indexOpenCode msg-count and title behavior", () => {
  test("indexes zero-message session with title-only search metadata", async () =>
    withOpenCodeHome(async (home) => {
      await seedIndexOpenCodeDb(openCodeDbPath(home), [{ id: "zero-msgs", messages: [] }]);
      const meta = indexOpenCode(sessionRow("zero-msgs", "Zero Msg Title"));
      assert.equal(meta.firstPrompt, "Zero Msg Title");
      assert.equal(meta.chapters, 0);
      assert.equal(meta.durationMs, 0);
      assert.deepEqual(meta.tools, []);
    }));

  test("indexes single-message session (below discovery threshold of 3)", async () =>
    withOpenCodeHome(async (home) => {
      await seedIndexOpenCodeDb(openCodeDbPath(home), [
        {
          id: "one-msg",
          messages: [{ role: "user", parts: [{ type: "text", text: "Only user turn" }] }],
        },
      ]);
      const meta = indexOpenCode(sessionRow("one-msg", "One Msg"));
      assert.equal(meta.firstPrompt, "Only user turn");
      assert.equal(meta.chapters, 1);
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("only") && meta.termFreqs.has("user") && meta.termFreqs.has("turn"));
    }));

  test("indexes two-message session with two chapters", async () =>
    withOpenCodeHome(async (home) => {
      await seedIndexOpenCodeDb(openCodeDbPath(home), [
        {
          id: "two-msg",
          messages: [
            { role: "user", parts: [{ type: "text", text: "Chapter one" }] },
            { role: "user", parts: [{ type: "text", text: "Chapter two" }] },
          ],
        },
      ]);
      const meta = indexOpenCode(sessionRow("two-msg"));
      assert.equal(meta.chapters, 2);
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("chapter"));
    }));

  test("indexes three-message session used by discovery msg-count filter", async () =>
    withOpenCodeHome(async (home) => {
      await seedIndexOpenCodeDb(openCodeDbPath(home), [
        {
          id: "three-msg",
          messages: [
            { role: "user", parts: [{ type: "text", text: "First of three" }] },
            { role: "assistant", parts: [{ type: "text", text: "Middle reply" }] },
            { role: "user", parts: [{ type: "text", text: "Third turn" }] },
          ],
        },
      ]);
      const meta = indexOpenCode(sessionRow("three-msg", "Three Msg Title"));
      assert.equal(meta.chapters, 2);
      assert.equal(meta.firstPrompt, "First of three");
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("middle") && meta.termFreqs.has("reply"));
    }));

  test("findOpenCodeSessions filters <3 messages but indexOpenCode still indexes two-msg session", async () =>
    withOpenCodeHome(async (home) => {
      await seedDiscoveryOpenCodeDb(home, [
        { id: "few", msgCount: 2 },
        { id: "enough", msgCount: 3, title: "Enough Msgs" },
      ]);
      const modUrl = new URL("../../src/sessions/session-discovery.js?" + Date.now(), import.meta.url);
      const { findOpenCodeSessions } = await import(modUrl.href);
      const discovered = [];
      findOpenCodeSessions(null, discovered);
      assert.equal(discovered.length, 1);
      assert.equal(discovered[0].file, "enough");

      fs.unlinkSync(openCodeDbPath(home));
      await seedIndexOpenCodeDb(openCodeDbPath(home), [
        {
          id: "few",
          messages: [
            { role: "user", parts: [{ type: "text", text: "Filtered from discovery" }] },
            { role: "user", parts: [{ type: "text", text: "Still indexed" }] },
          ],
        },
      ]);
      const meta = indexOpenCode(sessionRow("few", "Few Msgs"));
      assert.equal(meta.chapters, 2);
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("filtered") && meta.termFreqs.has("discovery"));
    }));

  test("uses session title when user messages have no text parts", async () =>
    withOpenCodeHome(async (home) => {
      await seedIndexOpenCodeDb(openCodeDbPath(home), [
        {
          id: "no-text",
          messages: [{ role: "user", parts: [{ type: "tool", tool: "bash" }] }],
        },
      ]);
      const meta = indexOpenCode(sessionRow("no-text", "Title Becomes Prompt"));
      assert.equal(meta.firstPrompt, "Title Becomes Prompt");
      assert.equal(meta.chapters, 1);
    }));

  test("title and message text both contribute to termFreqs", async () =>
    withOpenCodeHome(async (home) => {
      await seedIndexOpenCodeDb(openCodeDbPath(home), [
        {
          id: "titled",
          messages: [{ role: "user", parts: [{ type: "text", text: "needle in sqlite" }] }],
        },
      ]);
      const meta = indexOpenCode(sessionRow("titled", "My OpenCode Session"));
      assert.equal(meta.firstPrompt, "needle in sqlite");
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("needle") && meta.termFreqs.has("sqlite"));
    }));

  test("indexSession dispatches opencode source to indexOpenCode", async () =>
    withOpenCodeHome(async (home) => {
      await seedIndexOpenCodeDb(openCodeDbPath(home), [
        {
          id: "dispatch",
          messages: [{ role: "user", modelID: "claude-opus", parts: [{ type: "text", text: "dispatch path" }] }],
        },
      ]);
      const session = sessionRow("dispatch", "Dispatch Title");
      const direct = indexOpenCode(session);
      const viaCore = indexSession(session);
      assert.deepEqual(viaCore, direct);
      assert.equal(viaCore.model, "claude-opus");
    }));
});

describe("indexOpenCode corrupt DB and schema failures", () => {
  test("falls back to title when opencode.db is missing", async () =>
    withOpenCodeHome(async (home) => {
      fs.mkdirSync(path.dirname(openCodeDbPath(home)), { recursive: true });
      const meta = indexOpenCode(sessionRow("missing-db", "Title Only"));
      assert.equal(meta.firstPrompt, "Title Only");
      assert.equal(meta.chapters, 0);
      assert.deepEqual(meta.tools, []);
    }));

  test("falls back to title when opencode.db is not valid SQLite", async () =>
    withOpenCodeHome(async (home) => {
      const dbPath = openCodeDbPath(home);
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      fs.writeFileSync(dbPath, "NOT_A_SQLITE_FILE");
      const meta = indexOpenCode(sessionRow("corrupt-file", "Corrupt DB Title"));
      assert.equal(meta.firstPrompt, "Corrupt DB Title");
      assert.equal(meta.chapters, 0);
      assert.equal(meta.durationMs, 0);
      assert.deepEqual(meta.tools, []);
    }));

  test("falls back to title when message table exists but part table is missing", async () =>
    withOpenCodeHome(async (home) => {
      const dbPath = openCodeDbPath(home);
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(dbPath);
      db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created TEXT)`);
      db.prepare(`INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)`).run(
        "m1",
        "schema-gap",
        JSON.stringify({ role: "user" }),
        "2026-05-01T00:00:00Z"
      );
      db.close();

      const meta = indexOpenCode(sessionRow("schema-gap", "Schema Gap Title"));
      assert.equal(meta.firstPrompt, "Schema Gap Title");
    }));

  test("falls back to title when message JSON is corrupt", async () =>
    withOpenCodeHome(async (home) => {
      const dbPath = openCodeDbPath(home);
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(dbPath);
      db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created TEXT)`);
      db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT)`);
      db.prepare(`INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)`).run(
        "m1",
        "bad-json",
        "{not valid json",
        "2026-05-01T00:00:00Z"
      );
      db.close();

      const meta = indexOpenCode(sessionRow("bad-json", "Bad JSON Title"));
      assert.equal(meta.firstPrompt, "Bad JSON Title");
    }));

  test("uses title when session id has no rows in SQLite", async () =>
    withOpenCodeHome(async (home) => {
      await seedIndexOpenCodeDb(openCodeDbPath(home), [
        { id: "other-session", messages: [{ parts: [{ type: "text", text: "other" }] }] },
      ]);
      const meta = indexOpenCode(sessionRow("absent-id", "Absent Row Title"));
      assert.equal(meta.firstPrompt, "Absent Row Title");
      assert.equal(meta.chapters, 0);
    }));

  test("logs and falls back to title when opencode.db is unreadable", async () =>
    withOpenCodeHome(async (home) => {
      await seedIndexOpenCodeDb(openCodeDbPath(home), [
        { id: "chmod", messages: [{ role: "user", parts: [{ type: "text", text: "never read" }] }] },
      ]);
      const dbPath = openCodeDbPath(home);
      withErrorSpy((spy) => {
        fs.chmodSync(dbPath, 0o000);
        try {
          const meta = indexOpenCode(sessionRow("chmod", "Unreadable DB Title"));
          assert.equal(meta.firstPrompt, "Unreadable DB Title");
          assert.equal(meta.chapters, 0);
          assert.equal(spy.mock.calls.length, 1);
          assert.match(errorMessages(spy)[0], /indexOpenCode: failed to index chmod/);
        } finally {
          fs.chmodSync(dbPath, 0o644);
        }
      });
    }));
});

describe("indexOpenCode mtime and buildIndex cache", () => {
  test("discovery mtime prefers time_updated over time_created", async () =>
    withOpenCodeHome(async (home) => {
      await seedDiscoveryOpenCodeDb(home, [
        { id: "mtime-sess", msgCount: 3, time_created: 1000, time_updated: 2500 },
      ]);
      const modUrl = new URL("../../src/sessions/session-discovery.js?" + Date.now(), import.meta.url);
      const { findOpenCodeSessions } = await import(modUrl.href);
      const out = [];
      findOpenCodeSessions(null, out);
      assert.equal(out[0].mtime.getTime(), 2500);
      assert.equal(out[0].title, "mtime-sess");
    }));

  test("buildIndex reuses cached opencode metadata until session mtime changes", async () =>
    withOpenCodeHome(async (home) => {
      const dbPath = openCodeDbPath(home);
      await seedIndexOpenCodeDb(dbPath, [
        {
          id: "oc-cache",
          messages: [{ role: "user", parts: [{ type: "text", text: "version A prompt" }] }],
        },
      ]);

      const originalNoSidecar = process.env.TRACEQUEST_NO_SIDECAR;
      process.env.TRACEQUEST_NO_SIDECAR = "1";
      try {
        const modUrl = new URL("../../src/sessions.js?" + Date.now(), import.meta.url);
        const { buildIndex } = await import(modUrl.href);

        const mtimeMs = 1715731200000;
        const session = {
          ...sessionRow("oc-cache", "Cache Title"),
          mtime: new Date(mtimeMs),
          size: 3 * 1024,
        };

        const map1 = buildIndex([session]);
        assert.equal(map1.get(session.path).firstPrompt, "version A prompt");

        const { DatabaseSync } = await import("node:sqlite");
        const db = new DatabaseSync(dbPath);
        db.prepare(`DELETE FROM part`).run();
        db.prepare(`DELETE FROM message`).run();
        db.prepare(
          `INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)`
        ).run("m2", "oc-cache", JSON.stringify({ role: "user" }), "2026-05-02T00:00:00Z");
        db.prepare(`INSERT INTO part (id, message_id, data) VALUES (?, ?, ?)`).run(
          "p2",
          "m2",
          JSON.stringify({ type: "text", text: "version B prompt" })
        );
        db.close();

        const map2 = buildIndex([session]);
        assert.equal(
          map2.get(session.path).firstPrompt,
          "version A prompt",
          "unchanged session mtime must keep cached index even if DB content changed"
        );

        const bumped = { ...session, mtime: new Date(mtimeMs + 60_000) };
        const map3 = buildIndex([bumped]);
        assert.equal(map3.get(session.path).firstPrompt, "version B prompt");
        assert.notStrictEqual(map2, map3);
      } finally {
        if (originalNoSidecar === undefined) delete process.env.TRACEQUEST_NO_SIDECAR;
        else process.env.TRACEQUEST_NO_SIDECAR = originalNoSidecar;
      }
    }));
});

describe("indexOpenCode full fixture integration", () => {
  test("returns duration, tools, errors, and searchable text from rich fixture", async () =>
    withOpenCodeHome(async (home) => {
      const dbPath = openCodeDbPath(home);
      await seedIndexOpenCodeDb(dbPath, [
        {
          id: "idx-oc-1",
          messages: [
            {
              role: "user",
              modelID: "gpt-4o",
              time: "2026-05-01T00:00:00Z",
              parts: [{ type: "text", text: "OpenCode index needle" }],
            },
            {
              role: "assistant",
              modelID: "gpt-4o-mini",
              time: "2026-05-01T00:02:00Z",
              parts: [
                { type: "text", text: "Indexed assistant reply" },
                { type: "tool", tool: "bash" },
                { type: "tool", status: "error" },
              ],
            },
            {
              role: "user",
              time: "2026-05-01T00:04:00Z",
              parts: [{ type: "text", text: "Second user chapter" }],
            },
          ],
        },
      ]);

      const session = sessionRow("idx-oc-1", "Fixture Title");
      const meta = indexOpenCode(session);
      assert.equal(meta.firstPrompt, "OpenCode index needle");
      assert.equal(meta.model, "gpt-4o");
      assert.equal(meta.chapters, 2);
      assert.equal(meta.durationMs, 240000);
      assert.equal(meta.errors, 1);
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("second") && meta.termFreqs.has("user") && meta.termFreqs.has("chapter"));
      assert.deepEqual(meta.tools, ["Bash"]);
      assert.equal(meta.toolCounts.Bash, 1);
    }));
});

describe("indexOpenCode reasoning part indexing", () => {
  test("reasoning parts are indexed into termFreqs", async () =>
    withOpenCodeHome(async (home) => {
      const dbPath = openCodeDbPath(home);
      await seedIndexOpenCodeDb(dbPath, [
        {
          id: "reasoning-1",
          messages: [
            {
              role: "assistant",
              parts: [
                { type: "text", text: "Short reply." },
                { type: "reasoning", text: "dissectinglogic the problem step by step." },
              ],
            },
          ],
        },
      ]);
      const db = new (loadDatabaseSync())(dbPath, { readOnly: true });
      const msgs = accumulateOpenCodeMessages(db, "reasoning-1");
      assert.ok(msgs.termFreqs instanceof Map, "termFreqs must be a Map");
      assert.ok(msgs.termFreqs.has("dissectinglogic"), "reasoning text must be tokenized into termFreqs");
      assert.ok(msgs.termFreqs.has("step"), "reasoning text words must appear in termFreqs");
      db.close();
    }));

  test("reasoning parts do not set firstPrompt (only text parts for user role do)", async () =>
    withOpenCodeHome(async (home) => {
      const dbPath = openCodeDbPath(home);
      await seedIndexOpenCodeDb(dbPath, [
        {
          id: "reasoning-2",
          messages: [
            {
              role: "assistant",
              parts: [
                { type: "reasoning", text: "Should not be firstPrompt" },
                { type: "text", text: "Actual reply text" },
              ],
            },
            {
              role: "user",
              parts: [{ type: "text", text: "User prompt here" }],
            },
          ],
        },
      ]);
      const meta = indexOpenCode(sessionRow("reasoning-2", "Title"));
      assert.equal(meta.firstPrompt, "User prompt here", "firstPrompt must come from user text part, not reasoning");
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("reply"), "text parts still indexed");
    }));
});

describe("session-index-opencode module (root layout parity)", () => {
  test("resolveOpenCodeDbPath uses OPENCODE_DB_REL under HOME", () => {
    const home = "/tmp/fake-home";
    assert.ok(resolveOpenCodeDbPath(home).endsWith(".local/share/opencode/opencode.db"));
  });

  test("emptyIndexMeta matches opencode failure fallback shape", () => {
    const meta = emptyIndexMeta();
    assert.equal(meta.searchText, undefined);
    assert.equal(meta.chapters, 0);
    assert.equal(meta.durationMs, 0);
    assert.deepEqual(meta.tools, []);
  });
});