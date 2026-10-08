import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parseOpenCode } from "../../src/parse/parse-opencode.js";
import { resolveOpenCodeDbPath } from "../../src/sessions/session-discovery-paths.js";
import { mkTmp } from "../helpers/fixtures.js";
import { seedOpenCodeIndexDb } from "../helpers/opencode-db-fixtures.js";
import { assertPerf } from "../helpers/perf-assert.js";

const SESSION = "oc-parse-edge";
const CWD = "/home/dev/tracequest";
const TITLE = "OpenCode Parse Edge";

/** Epoch ms for deterministic ISO timestamps in assertions. */
const T0 = Date.parse("2026-06-03T12:00:00.000Z");
const T1 = Date.parse("2026-06-03T12:00:05.000Z");
const T2 = Date.parse("2026-06-03T12:00:10.000Z");

function withOpenCodeHome(fn) {
  const tmpDir = mkTmp("tq-parse-oc-");
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

/** parseOpenCode fixtures: shared index schema with parse-test cwd/timestamp defaults. */
function seedParseOpenCodeDb(home, sessions) {
  return seedOpenCodeIndexDb(home, sessions, { defaultDirectory: CWD, defaultTime: T0 });
}

function parseUri(sessionId) {
  return `opencode://${sessionId}`;
}

describe("parseOpenCode session metadata", () => {
  test("reads session row directory and sessionId from opencode URI", async () =>
    withOpenCodeHome(async (home) => {
      await seedParseOpenCodeDb(home, [
        {
          id: SESSION,
          title: TITLE,
          directory: CWD,
          messages: [
            {
              id: "mu1",
              role: "user",
              modelID: "claude-opus-4",
              time: { created: T0 },
              parts: [{ type: "text", text: "opencode hello" }],
            },
          ],
        },
      ]);
      const sess = parseOpenCode(parseUri(SESSION));
      assert.equal(sess.source, "opencode");
      assert.equal(sess.sessionId, SESSION);
      assert.equal(sess.cwd, CWD);
      assert.equal(sess.model, "claude-opus-4");
      assert.equal(sess.gitBranch, null);
    }));

  test("parseOpenCode reads the imported host db", async () =>
    withOpenCodeHome(async (home) => {
      const hostHome = path.join(home, ".local", "share", "tracequest", "hosts", "gpu");
      await seedParseOpenCodeDb(hostHome, [
        {
          id: SESSION,
          title: TITLE,
          directory: CWD,
          messages: [
            {
              id: "mu-host",
              role: "user",
              modelID: "claude-opus-4",
              time: { created: T0 },
              parts: [{ type: "text", text: "imported opencode hello" }],
            },
          ],
        },
      ]);
      const sess = parseOpenCode(`opencode://gpu/${SESSION}`);
      assert.equal(sess.source, "opencode");
      assert.equal(sess.sessionId, SESSION);
      assert.equal(sess.cwd, CWD);
      assert.ok(sess.events.some((e) => (e.text || "").includes("imported opencode hello")));
    }));

  test("unknown session id yields opencode session with no events", async () =>
    withOpenCodeHome(async (home) => {
      await seedParseOpenCodeDb(home, [
        {
          id: "other-session",
          messages: [{ parts: [{ type: "text", text: "other" }] }],
        },
      ]);
      const sess = parseOpenCode(parseUri("missing-id"));
      assert.equal(sess.sessionId, "missing-id");
      assert.equal(sess.cwd, null);
      assert.equal(sess.events.length, 0);
    }));

  test("empty message table yields zero events", async () =>
    withOpenCodeHome(async (home) => {
      await seedParseOpenCodeDb(home, [{ id: SESSION, messages: [] }]);
      const sess = parseOpenCode(parseUri(SESSION));
      assert.equal(sess.eventCount, 0);
      assert.equal(sess.stats.userMessages, 0);
    }));
});

describe("parseOpenCode user messages", () => {
  test("concatenates text parts and supports content field alias", async () =>
    withOpenCodeHome(async (home) => {
      await seedParseOpenCodeDb(home, [
        {
          id: SESSION,
          messages: [
            {
              id: "mu-multi",
              role: "user",
              time: { created: T0 },
              parts: [
                { type: "text", text: "part one" },
                { type: "text", content: "part two" },
              ],
            },
          ],
        },
      ]);
      const ev = parseOpenCode(parseUri(SESSION)).events[0];
      assert.equal(ev.type, "user");
      assert.equal(ev.text, "part one\npart two");
      assert.equal(ev.uuid, "mu-multi");
    }));

  test("skips user turns whose combined text starts with angle brackets", async () =>
    withOpenCodeHome(async (home) => {
      await seedParseOpenCodeDb(home, [
        {
          id: SESSION,
          messages: [
            {
              role: "user",
              time: { created: T0 },
              parts: [
                { type: "text", text: "<system>hidden</system>" },
                { type: "text", text: "suffix still skipped when aggregate starts with <" },
              ],
            },
            {
              role: "user",
              time: { created: T1 },
              parts: [{ type: "text", text: "visible opencode prompt" }],
            },
            {
              role: "user",
              time: { created: T2 },
              parts: [{ type: "text", text: "<local>xml only</local>" }],
            },
          ],
        },
      ]);
      const users = parseOpenCode(parseUri(SESSION)).events.filter((e) => e.type === "user");
      assert.equal(users.length, 1);
      assert.equal(users[0].text, "visible opencode prompt");
    }));

  test("user text longer than 500 chars is truncated", async () =>
    withOpenCodeHome(async (home) => {
      const long = "u".repeat(700);
      await seedParseOpenCodeDb(home, [
        {
          id: SESSION,
          messages: [{ role: "user", time: { created: T0 }, parts: [{ type: "text", text: long }] }],
        },
      ]);
      const ev = parseOpenCode(parseUri(SESSION)).events[0];
      assert.ok(ev.text.startsWith("u".repeat(500)));
      assert.match(ev.text, /\[truncated 200 chars\]$/);
    }));
});

describe("parseOpenCode assistant turns", () => {
  test("assistant text tools and inline tool_result events", async () =>
    withOpenCodeHome(async (home) => {
      await seedParseOpenCodeDb(home, [
        {
          id: SESSION,
          messages: [
            {
              id: "ma1",
              role: "assistant",
              modelID: "gpt-4o",
              time: { created: T1 },
              parts: [
                { type: "text", text: "I'll run tools." },
                {
                  type: "tool",
                  callID: "bash-1",
                  tool: "bash",
                  state: { input: { command: "npm test" }, output: "ok\n", status: "ok" },
                },
                {
                  type: "tool",
                  callID: "read-1",
                  tool: "read",
                  state: { input: { file_path: "/proj/a.js" }, output: "file body", status: "ok" },
                },
              ],
            },
          ],
        },
      ]);
      const sess = parseOpenCode(parseUri(SESSION));
      const asst = sess.events.find((e) => e.uuid === "ma1");
      const results = sess.events.filter((e) => e.type === "tool_result");
      assert.equal(asst.text, "I'll run tools.");
      assert.equal(asst.stopReason, "tool_use");
      assert.equal(asst.toolCalls.length, 2);
      assert.equal(asst.toolCalls[0].name, "Bash");
      assert.equal(asst.toolCalls[1].name, "Read");
      assert.equal(results.length, 2);
      assert.equal(results[0].toolUseId, "bash-1");
      assert.equal(results[0].isError, false);
      assert.equal(sess.stats.toolCounts.Bash, 1);
    }));

  test("tool error status and errorPattern mark tool_result isError", async () =>
    withOpenCodeHome(async (home) => {
      await seedParseOpenCodeDb(home, [
        {
          id: SESSION,
          messages: [
            {
              role: "assistant",
              time: { created: T0 },
              parts: [
                {
                  type: "tool",
                  callID: "err-status",
                  tool: "bash",
                  state: { input: { command: "false" }, output: "minor", status: "error" },
                },
                {
                  type: "tool",
                  callID: "err-pattern",
                  tool: "bash",
                  state: { input: { command: "x" }, output: "Error: boom", status: "ok" },
                },
              ],
            },
          ],
        },
      ]);
      const results = parseOpenCode(parseUri(SESSION)).events.filter((e) => e.type === "tool_result");
      assert.equal(results.length, 2);
      assert.equal(results[0].isError, true);
      assert.equal(results[1].isError, true);
      assert.equal(parseOpenCode(parseUri(SESSION)).stats.errors, 2);
    }));

  test("step-finish tokens rollup including cache read/write", async () =>
    withOpenCodeHome(async (home) => {
      await seedParseOpenCodeDb(home, [
        {
          id: SESSION,
          messages: [
            {
              role: "assistant",
              time: { created: T0 },
              parts: [
                { type: "text", text: "counted" },
                {
                  type: "step-finish",
                  tokens: { input: 100, output: 40, cache: { read: 30, write: 20 } },
                },
              ],
            },
          ],
        },
      ]);
      const ev = parseOpenCode(parseUri(SESSION)).events[0];
      assert.equal(ev.tokens.output, 40);
      assert.equal(ev.tokens.cacheHit, 30);
      assert.equal(ev.tokens.cacheWrite, 20);
      assert.equal(ev.tokens.input, 150);
    }));

  test("MCP tool parts retain mcp__ name and mcpInfo", async () =>
    withOpenCodeHome(async (home) => {
      await seedParseOpenCodeDb(home, [
        {
          id: SESSION,
          messages: [
            {
              role: "assistant",
              time: { created: T0 },
              parts: [
                {
                  type: "tool",
                  callID: "mcp-1",
                  tool: "mcp__github__search_issues",
                  state: { input: { query: "tracequest" }, output: "[]", status: "ok" },
                },
              ],
            },
          ],
        },
      ]);
      const asst = parseOpenCode(parseUri(SESSION)).events.find((e) => e.type === "assistant");
      const tc = asst.toolCalls[0];
      assert.equal(tc.name, "mcp__github__search_issues");
      assert.equal(tc.mcpInfo.server, "github");
      assert.equal(tc.mcpInfo.params.query, "tracequest");
    }));

  test("assistant end_turn when no tool parts", async () =>
    withOpenCodeHome(async (home) => {
      await seedParseOpenCodeDb(home, [
        {
          id: SESSION,
          messages: [
            {
              role: "assistant",
              time: { created: T0 },
              parts: [{ type: "text", text: "reply only" }],
            },
          ],
        },
      ]);
      const ev = parseOpenCode(parseUri(SESSION)).events[0];
      assert.equal(ev.stopReason, "end_turn");
      assert.deepEqual(ev.toolCalls, []);
    }));
});

describe("parseOpenCode robustness", () => {
  test("missing opencode.db returns empty session without throwing", async () =>
    withOpenCodeHome(async () => {
      const errors = [];
      const origError = console.error;
      console.error = (...args) => errors.push(args.join(" "));
      try {
        const sess = parseOpenCode(parseUri(SESSION));
        assert.equal(sess.source, "opencode");
        assert.equal(sess.sessionId, SESSION);
        assert.equal(sess.events.length, 0);
        assert.equal(sess.stats.userMessages, 0);
        assert.equal(errors.length, 0);
      } finally {
        console.error = origError;
      }
    }));

  test("logs and returns empty session when opencode.db exists but is unreadable", async () =>
    withOpenCodeHome(async (home) => {
      await seedParseOpenCodeDb(home, [{ id: SESSION, messages: [] }]);
      const dbPath = resolveOpenCodeDbPath(home);
      const errors = [];
      const origError = console.error;
      console.error = (...args) => errors.push(args.join(" "));
      try {
        fs.chmodSync(dbPath, 0o000);
        const sess = parseOpenCode(parseUri(SESSION));
        assert.equal(sess.sessionId, SESSION);
        assert.equal(sess.events.length, 0);
        assert.equal(errors.length, 1);
        assert.match(errors[0], /parseOpenCode: failed to open/);
        assert.match(errors[0], /opencode\.db/);
      } finally {
        fs.chmodSync(dbPath, 0o644);
        console.error = origError;
      }
    }));

  test("malformed message JSON rows are skipped", async () =>
    withOpenCodeHome(async (home) => {
      const dbPath = resolveOpenCodeDbPath(home);
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(dbPath);
      db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT)`);
      db.exec(
        `CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER, time_updated INTEGER)`
      );
      db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT, time_created INTEGER)`);
      db.prepare(`INSERT INTO session (id, title, directory) VALUES (?, ?, ?)`).run(
        SESSION,
        TITLE,
        CWD
      );
      db.prepare(
        `INSERT INTO message (id, session_id, data, time_created, time_updated) VALUES (?, ?, ?, ?, ?)`
      ).run("bad", SESSION, "{not json", T0, T0);
      db.prepare(
        `INSERT INTO message (id, session_id, data, time_created, time_updated) VALUES (?, ?, ?, ?, ?)`
      ).run(
        "good",
        SESSION,
        JSON.stringify({ role: "user", time: { created: T0 } }),
        T1,
        T1
      );
      db.prepare(`INSERT INTO part (id, message_id, data, time_created) VALUES (?, ?, ?, ?)`).run(
        "p1",
        "good",
        JSON.stringify({ type: "text", text: "after bad row" }),
        T1
      );
      db.close();

      const sess = parseOpenCode(parseUri(SESSION));
      assert.equal(sess.events.length, 1);
      assert.equal(sess.events[0].text, "after bad row");
    }));

  test("malformed part JSON is skipped without dropping the assistant turn", async () =>
    withOpenCodeHome(async (home) => {
      await seedParseOpenCodeDb(home, [
        {
          id: SESSION,
          messages: [
            {
              id: "ma-parts",
              role: "assistant",
              time: { created: T0 },
              parts: [
                { id: "p-bad", type: "text", text: "will be lost if alone" },
                { id: "p-good", type: "text", text: "visible reply" },
              ],
            },
          ],
        },
      ]);
      const dbPath = resolveOpenCodeDbPath(home);
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(dbPath);
      db.prepare(`UPDATE part SET data = ? WHERE id = ?`).run("{bad json", "p-bad");
      db.close();

      const ev = parseOpenCode(parseUri(SESSION)).events[0];
      assert.equal(ev.text, "visible reply");
    }));

  test("messages ordered by time_created across user and assistant turns", async () =>
    withOpenCodeHome(async (home) => {
      await seedParseOpenCodeDb(home, [
        {
          id: SESSION,
          messages: [
            {
              id: "u1",
              role: "user",
              timeCreated: T0,
              time: { created: T0 },
              parts: [{ type: "text", text: "first user" }],
            },
            {
              id: "a1",
              role: "assistant",
              timeCreated: T1,
              time: { created: T1 },
              parts: [{ type: "text", text: "assistant middle" }],
            },
            {
              id: "u2",
              role: "user",
              timeCreated: T2,
              time: { created: T2 },
              parts: [{ type: "text", text: "second user" }],
            },
          ],
        },
      ]);
      const sess = parseOpenCode(parseUri(SESSION));
      assert.deepEqual(
        sess.events.map((e) => e.text),
        ["first user", "assistant middle", "second user"]
      );
      assert.equal(sess.stats.userMessages, 2);
      assert.equal(sess.stats.assistantTurns, 1);
      assert.ok(sess.durationMs >= 0);
    }));
});

describe("parseOpenCode performance", () => {
  test("loads large sessions with one joined query instead of per-message part queries (perf)", async () =>
    withOpenCodeHome(async (home) => {
      const dbPath = resolveOpenCodeDbPath(home);
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(dbPath);
      db.exec(
        `CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, version TEXT, time_created INTEGER, time_updated INTEGER)`
      );
      db.exec(
        `CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER, time_updated INTEGER)`
      );
      db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT, time_created INTEGER)`);
      db.prepare(
        `INSERT INTO session (id, title, directory, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)`
      ).run("perf-oc", "Perf", CWD, "1.0", T0, T2);

      const insM = db.prepare(
        `INSERT INTO message (id, session_id, data, time_created, time_updated) VALUES (?, ?, ?, ?, ?)`
      );
      const insP = db.prepare(`INSERT INTO part (id, message_id, data, time_created) VALUES (?, ?, ?, ?)`);
      const MSG_COUNT = 200;
      const PARTS_PER_MSG = 8;
      for (let m = 0; m < MSG_COUNT; m++) {
        const role = m % 2 === 0 ? "user" : "assistant";
        const mid = `m${m}`;
        const created = T0 + m * 1000;
        insM.run(
          mid,
          "perf-oc",
          JSON.stringify({ role, modelID: "gpt-4o", time: { created } }),
          created,
          created
        );
        for (let p = 0; p < PARTS_PER_MSG; p++) {
          if (role === "user") {
            insP.run(`p${m}-${p}`, mid, JSON.stringify({ type: "text", text: `hello ${m}-${p}` }), created + p);
          } else if (p % 2 === 0) {
            insP.run(`p${m}-${p}`, mid, JSON.stringify({ type: "text", text: `reply ${m}` }), created + p);
          } else {
            insP.run(
              `p${m}-${p}`,
              mid,
              JSON.stringify({
                type: "tool",
                callID: `c${m}-${p}`,
                tool: "Bash",
                state: { input: { command: "ls" }, output: "ok" },
              }),
              created + p
            );
          }
        }
      }
      db.close();

      const src = fs.readFileSync(
        new URL("../../src/parse/parse-opencode.js", import.meta.url),
        "utf8"
      );
      assert.ok(src.includes("LEFT JOIN part p ON p.message_id = m.id"));
      assert.ok(!src.includes('part WHERE message_id = ?'));

      const ITERS = 40;
      for (let w = 0; w < 3; w++) parseOpenCode(parseUri("perf-oc"));
      const t0 = performance.now();
      for (let i = 0; i < ITERS; i++) {
        const sess = parseOpenCode(parseUri("perf-oc"));
        assert.ok(sess.events.length > MSG_COUNT);
      }
      const ms = (performance.now() - t0) / ITERS;
      assertPerf(
        ms < 8,
        `expected parseOpenCode under 8ms/op for 200×8-part session (single JOIN), got ${ms.toFixed(2)}ms`,
      );
    }));
});