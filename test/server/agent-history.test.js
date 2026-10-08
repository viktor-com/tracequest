import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  historyTimestamp,
  parseAgentHistoryJsonl,
  loadAgentHistoryForSession,
  loadAgentHistoryFile,
  loadCursorAgentHistoryFile,
  mergeAgentHistories,
  discoverAgentSidecarPaths,
} from "../../src/server/agent-history.js";
import { claudeProj, mkTmp } from "../helpers/fixtures.js";

const cleanup = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Build a minimal Claude parent session + optional subagents tree under tmpDir.
 *
 * @param {string} tmpDir
 * @param {{
 *   project?: string,
 *   sessionId?: string,
 *   sidecars?: Record<string, string>,
 *   subagentsExtras?: Array<{ name: string, isDir?: boolean }>,
 * }} [opts]
 */
function claudeSessionTree(tmpDir, opts = {}) {
  const project = opts.project ?? "myproj";
  const sessionId = opts.sessionId ?? "sess-uuid-1234";
  const proj = claudeProj(tmpDir, project);
  const parentPath = path.join(proj, `${sessionId}.jsonl`);
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(parentPath, "{}");

  const subDir = path.join(proj, sessionId, "subagents");
  if (opts.sidecars || opts.subagentsExtras || opts.emptySubagents) {
    fs.mkdirSync(subDir, { recursive: true });
    for (const [name, body] of Object.entries(opts.sidecars ?? {})) {
      fs.writeFileSync(path.join(subDir, name), body);
    }
    for (const extra of opts.subagentsExtras ?? []) {
      const p = path.join(subDir, extra.name);
      if (extra.isDir) fs.mkdirSync(p, { recursive: true });
      else fs.writeFileSync(p, extra.name);
    }
  }

  return { parentPath, proj, sessionId, subDir };
}

function cursorUserRow(text) {
  return JSON.stringify({ role: "user", message: { content: [{ type: "text", text }] } });
}

function cursorAssistantRow(text, tool) {
  const content = [{ type: "text", text }];
  if (tool) content.push({ type: "tool_use", name: tool.name, input: tool.input });
  return JSON.stringify({ role: "assistant", message: { content } });
}

/**
 * Build a minimal Cursor parent transcript + optional subagents tree under tmpDir:
 * `.cursor/projects/{proj}/agent-transcripts/{uuid}/{uuid}.jsonl` (+ `{uuid}/subagents/*.jsonl`).
 *
 * @param {string} tmpDir
 * @param {{
 *   project?: string,
 *   uuid?: string,
 *   sidecars?: Record<string, string>,
 *   emptySubagents?: boolean,
 * }} [opts]
 */
function cursorSessionTree(tmpDir, opts = {}) {
  const project = opts.project ?? "Users-me-code-proj";
  const uuid = opts.uuid ?? "11111111-2222-3333-4444-555555555555";
  const uuidDir = path.join(tmpDir, ".cursor", "projects", project, "agent-transcripts", uuid);
  const subDir = path.join(uuidDir, "subagents");
  fs.mkdirSync(uuidDir, { recursive: true });
  const parentPath = path.join(uuidDir, `${uuid}.jsonl`);
  fs.writeFileSync(parentPath, cursorUserRow("parent prompt") + "\n");
  if (opts.sidecars || opts.emptySubagents) {
    fs.mkdirSync(subDir, { recursive: true });
    for (const [name, body] of Object.entries(opts.sidecars ?? {})) {
      fs.writeFileSync(path.join(subDir, name), body);
    }
  }
  return { parentPath, subDir, uuidDir, uuid };
}

describe("agent-history", () => {
  describe("historyTimestamp", () => {
    test("reads ISO timestamp and epoch-ms ts fields", () => {
      assert.equal(
        historyTimestamp({ timestamp: "2026-01-02T10:00:00.000Z" }),
        Date.parse("2026-01-02T10:00:00.000Z"),
      );
      assert.equal(historyTimestamp({ ts: 1_700_000_000_000 }), 1_700_000_000_000);
    });

    test("returns null for missing or invalid timestamps", () => {
      assert.equal(historyTimestamp({}), null);
      assert.equal(historyTimestamp({ timestamp: "not-a-date" }), null);
      assert.equal(historyTimestamp(null), null);
    });
  });

  describe("parseAgentHistoryJsonl — empty history", () => {
    test("returns [] for empty, whitespace-only, or non-string input", () => {
      assert.deepEqual(parseAgentHistoryJsonl(""), []);
      assert.deepEqual(parseAgentHistoryJsonl("   \n\n  "), []);
      assert.deepEqual(parseAgentHistoryJsonl(null), []);
      assert.deepEqual(parseAgentHistoryJsonl(undefined), []);
    });

    test("preserves agentId and path metadata on valid lines", () => {
      const entries = parseAgentHistoryJsonl(
        '{"type":"user","timestamp":"2026-03-01T00:00:00.000Z"}\n',
        { agentId: "parent", path: "/tmp/parent.jsonl" },
      );
      assert.equal(entries.length, 1);
      assert.equal(entries[0].agentId, "parent");
      assert.equal(entries[0].path, "/tmp/parent.jsonl");
      assert.equal(entries[0].lineIndex, 0);
      assert.equal(entries[0].record.type, "user");
    });
  });

  describe("parseAgentHistoryJsonl — malformed jsonl", () => {
    test("skips bad lines without throwing and keeps line indices for valid rows", () => {
      const raw = [
        "{not json",
        '{"type":"user","timestamp":"2026-03-01T00:00:01.000Z"}',
        "",
        '{"broken":',
        '{"type":"assistant","timestamp":"2026-03-01T00:00:02.000Z"}',
      ].join("\n");

      const entries = parseAgentHistoryJsonl(raw, { agentId: "a1" });
      assert.equal(entries.length, 2);
      assert.equal(entries[0].lineIndex, 0);
      assert.equal(entries[0].record.type, "user");
      assert.equal(entries[1].lineIndex, 1);
      assert.equal(entries[1].record.type, "assistant");
    });

    test("handles file consisting only of malformed lines", () => {
      assert.deepEqual(parseAgentHistoryJsonl("{bad\n[also bad\n"), []);
    });
  });

  describe("loadAgentHistoryForSession", () => {
    test("returns null for falsy or non-Claude session paths", () => {
      assert.equal(loadAgentHistoryForSession(""), null);
      assert.equal(loadAgentHistoryForSession(null), null);
      assert.equal(loadAgentHistoryForSession(undefined), null);
      assert.equal(
        loadAgentHistoryForSession("/tmp/codex/sessions/rollout.jsonl"),
        null,
      );
    });

    test("returns null when no sidecar directory exists", () => {
      const dir = mkTmp("agent-load-");
      cleanup.push(dir);
      const { parentPath } = claudeSessionTree(dir, { sessionId: "solo" });
      assert.equal(loadAgentHistoryForSession(parentPath), null);
    });

    test("returns null when subagents/ exists but has no .jsonl files", () => {
      const dir = mkTmp("agent-load-");
      cleanup.push(dir);
      const { parentPath } = claudeSessionTree(dir, {
        sidecars: { "notes.txt": "skip", ".hidden.bak": "" },
      });
      assert.equal(loadAgentHistoryForSession(parentPath), null);
    });

    test("returns null when every sidecar line is malformed or files are empty", () => {
      const dir = mkTmp("agent-load-");
      cleanup.push(dir);
      const { parentPath } = claudeSessionTree(dir, {
        sidecars: {
          "bad.jsonl": "{not json\n[also bad\n",
          "empty.jsonl": "",
        },
      });
      assert.equal(loadAgentHistoryForSession(parentPath), null);
    });

    test("loads a single sidecar with agentId, path, and lineIndex metadata", () => {
      const dir = mkTmp("agent-load-");
      cleanup.push(dir);
      const { parentPath, subDir } = claudeSessionTree(dir, {
        sidecars: {
          "scout.jsonl":
            '{"type":"assistant","timestamp":"2026-06-03T00:00:01.000Z","text":"hi"}\n',
        },
      });
      const merged = loadAgentHistoryForSession(parentPath);
      assert.ok(merged);
      assert.equal(merged.length, 1);
      assert.equal(merged[0].agentId, "scout");
      assert.equal(merged[0].path, path.join(subDir, "scout.jsonl"));
      assert.equal(merged[0].lineIndex, 0);
      assert.equal(merged[0].record.text, "hi");
      assert.equal(
        merged[0].timestampMs,
        Date.parse("2026-06-03T00:00:01.000Z"),
      );
    });

    test("merges multiple sidecars in chronological order", () => {
      const dir = mkTmp("agent-load-");
      cleanup.push(dir);
      const { parentPath } = claudeSessionTree(dir, {
        sidecars: {
          "agent-b.jsonl":
            '{"type":"assistant","timestamp":"2026-06-02T00:00:01.000Z"}\n',
          "agent-a.jsonl":
            '{"type":"user","timestamp":"2026-06-02T00:00:00.000Z"}\n',
        },
      });
      const merged = loadAgentHistoryForSession(parentPath);
      assert.ok(merged);
      assert.equal(merged.length, 2);
      assert.deepEqual(
        merged.map((e) => [e.agentId, e.record.type]),
        [
          ["agent-a", "user"],
          ["agent-b", "assistant"],
        ],
      );
    });

    test("orders entries with epoch-ms ts fields across agents", () => {
      const dir = mkTmp("agent-load-");
      cleanup.push(dir);
      const { parentPath } = claudeSessionTree(dir, {
        sidecars: {
          "late.jsonl": '{"type":"late","ts":1700000000002}\n',
          "early.jsonl": '{"type":"early","ts":1700000000000}\n',
        },
      });
      const merged = loadAgentHistoryForSession(parentPath);
      assert.deepEqual(merged.map((e) => e.record.type), ["early", "late"]);
    });

    test("places timestamped entries before entries lacking timestamps", () => {
      const dir = mkTmp("agent-load-");
      cleanup.push(dir);
      const { parentPath } = claudeSessionTree(dir, {
        sidecars: {
          "a.jsonl":
            '{"type":"system"}\n{"type":"user","timestamp":"2026-07-01T00:00:00.000Z"}\n',
        },
      });
      const merged = loadAgentHistoryForSession(parentPath);
      assert.equal(merged.length, 2);
      assert.equal(merged[0].record.type, "user");
      assert.equal(merged[1].record.type, "system");
      assert.equal(merged[1].timestampMs, null);
    });

    test("ignores non-jsonl clutter and nested dirs under subagents/", () => {
      const dir = mkTmp("agent-load-");
      cleanup.push(dir);
      const { parentPath } = claudeSessionTree(dir, {
        sidecars: {
          "keep.jsonl": '{"type":"tool","timestamp":"2026-08-01T00:00:00.000Z"}\n',
          "notes.txt": "nope",
        },
        subagentsExtras: [{ name: "nested", isDir: true }],
      });
      const merged = loadAgentHistoryForSession(parentPath);
      assert.equal(merged.length, 1);
      assert.equal(merged[0].agentId, "keep");
      assert.equal(merged[0].record.type, "tool");
    });

    test("preserves dotted agent basenames on merged entries", () => {
      const dir = mkTmp("agent-load-");
      cleanup.push(dir);
      const { parentPath } = claudeSessionTree(dir, {
        sidecars: {
          "agent.tool.v2.jsonl":
            '{"type":"assistant","timestamp":"2026-06-01T00:00:00.000Z"}\n',
        },
      });
      const merged = loadAgentHistoryForSession(parentPath);
      assert.equal(merged.length, 1);
      assert.equal(merged[0].agentId, "agent.tool.v2");
    });
  });

  describe("loadAgentHistoryFile", () => {
    test("returns [] when path is missing or file does not exist", () => {
      assert.deepEqual(loadAgentHistoryFile(""), []);
      assert.deepEqual(loadAgentHistoryFile(null), []);
      assert.deepEqual(loadAgentHistoryFile("/no/such/tracequest-session.jsonl"), []);
    });

    test("logs and returns [] when file exists but is unreadable", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-history-"));
      const filePath = path.join(dir, "locked.jsonl");
      fs.writeFileSync(filePath, '{"type":"user"}\n');
      const errors = [];
      const origError = console.error;
      console.error = (...args) => errors.push(args.join(" "));
      try {
        fs.chmodSync(filePath, 0o000);
        assert.deepEqual(loadAgentHistoryFile(filePath, "locked"), []);
        assert.equal(errors.length, 1);
        assert.match(errors[0], /loadAgentHistoryFile: failed to read/);
        assert.match(errors[0], /locked\.jsonl/);
      } finally {
        fs.chmodSync(filePath, 0o644);
        console.error = origError;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test("loads valid jsonl from disk", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-history-"));
      const filePath = path.join(dir, "session.jsonl");
      fs.writeFileSync(
        filePath,
        '{"type":"user","timestamp":"2026-04-01T12:00:00.000Z","text":"hi"}\n',
      );
      try {
        const entries = loadAgentHistoryFile(filePath, "disk-agent");
        assert.equal(entries.length, 1);
        assert.equal(entries[0].agentId, "disk-agent");
        assert.equal(entries[0].record.text, "hi");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("mergeAgentHistories — path sources (loadAgentHistoryFile)", () => {
    test("loads and interleaves multiple agents from disk paths only", () => {
      const dir = mkTmp("agent-merge-path-");
      cleanup.push(dir);
      const pathA = path.join(dir, "agent-a.jsonl");
      const pathB = path.join(dir, "agent-b.jsonl");
      fs.writeFileSync(
        pathA,
        '{"type":"user","timestamp":"2026-05-01T10:00:02.000Z"}\n',
      );
      fs.writeFileSync(
        pathB,
        '{"type":"assistant","timestamp":"2026-05-01T10:00:00.000Z"}\n',
      );

      const merged = mergeAgentHistories([
        { agentId: "agent-a", path: pathA },
        { agentId: "agent-b", path: pathB },
      ]);

      assert.deepEqual(
        merged.map((e) => [e.agentId, e.record.type, e.path]),
        [
          ["agent-b", "assistant", pathB],
          ["agent-a", "user", pathA],
        ],
      );
    });

    test("skips malformed lines when merge source is a disk path", () => {
      const dir = mkTmp("agent-merge-malformed-");
      cleanup.push(dir);
      const filePath = path.join(dir, "noisy.jsonl");
      fs.writeFileSync(
        filePath,
        [
          "{bad",
          '{"type":"keep","timestamp":"2026-08-11T00:00:00.000Z"}',
          '{"type":"also","timestamp":"2026-08-11T00:00:01.000Z"}',
        ].join("\n"),
      );

      const merged = mergeAgentHistories([{ agentId: "noisy", path: filePath }]);

      assert.equal(merged.length, 2);
      assert.deepEqual(merged.map((e) => e.record.type), ["keep", "also"]);
      assert.deepEqual(merged.map((e) => e.lineIndex), [0, 1]);
      assert.ok(merged.every((e) => e.path === filePath));
    });

    test("ignores empty on-disk sidecar while merging other path sources", () => {
      const dir = mkTmp("agent-merge-empty-");
      cleanup.push(dir);
      const emptyPath = path.join(dir, "ghost.jsonl");
      const realPath = path.join(dir, "real.jsonl");
      fs.writeFileSync(emptyPath, "");
      fs.writeFileSync(
        realPath,
        '{"type":"only","timestamp":"2026-09-01T00:00:00.000Z"}\n',
      );

      const merged = mergeAgentHistories([
        { agentId: "ghost", path: emptyPath },
        { agentId: "real", path: realPath },
      ]);

      assert.equal(merged.length, 1);
      assert.equal(merged[0].agentId, "real");
      assert.equal(merged[0].record.type, "only");
      assert.equal(merged[0].path, realPath);
    });
  });

  describe("mergeAgentHistories — ordering", () => {
    test("returns [] for empty or missing sources", () => {
      assert.deepEqual(mergeAgentHistories([]), []);
      assert.deepEqual(mergeAgentHistories(null), []);
      assert.deepEqual(mergeAgentHistories(undefined), []);
    });

    test("interleaves multiple agents by timestamp ascending", () => {
      const merged = mergeAgentHistories([
        {
          agentId: "parent",
          entries: [
            {
              agentId: "parent",
              path: "p",
              lineIndex: 0,
              record: { type: "user", timestamp: "2026-05-01T10:00:00.000Z" },
              timestampMs: Date.parse("2026-05-01T10:00:00.000Z"),
            },
            {
              agentId: "parent",
              path: "p",
              lineIndex: 1,
              record: { type: "assistant", timestamp: "2026-05-01T10:00:02.000Z" },
              timestampMs: Date.parse("2026-05-01T10:00:02.000Z"),
            },
          ],
        },
        {
          agentId: "subagent",
          raw: [
            '{"type":"tool_result","timestamp":"2026-05-01T10:00:01.000Z"}',
            '{"type":"assistant","timestamp":"2026-05-01T10:00:03.000Z"}',
          ].join("\n"),
        },
      ]);

      assert.deepEqual(
        merged.map((e) => [e.agentId, e.record.type]),
        [
          ["parent", "user"],
          ["subagent", "tool_result"],
          ["parent", "assistant"],
          ["subagent", "assistant"],
        ],
      );
    });

    test("uses source list order when timestamps tie", () => {
      const ts = "2026-06-01T00:00:00.000Z";
      const ms = Date.parse(ts);
      const merged = mergeAgentHistories([
        {
          agentId: "first",
          entries: [
            {
              agentId: "first",
              path: "",
              lineIndex: 0,
              record: { type: "user", timestamp: ts },
              timestampMs: ms,
            },
          ],
        },
        {
          agentId: "second",
          entries: [
            {
              agentId: "second",
              path: "",
              lineIndex: 0,
              record: { type: "assistant", timestamp: ts },
              timestampMs: ms,
            },
          ],
        },
      ]);

      assert.deepEqual(merged.map((e) => e.agentId), ["first", "second"]);
    });

    test("places timestamped entries before entries lacking timestamps", () => {
      const merged = mergeAgentHistories([
        {
          agentId: "a",
          raw: '{"type":"system"}\n{"type":"user","timestamp":"2026-07-01T00:00:00.000Z"}\n',
        },
      ]);

      assert.equal(merged.length, 2);
      assert.equal(merged[0].record.type, "user");
      assert.equal(merged[0].timestampMs, Date.parse("2026-07-01T00:00:00.000Z"));
      assert.equal(merged[1].record.type, "system");
      assert.equal(merged[1].timestampMs, null);
    });

    test("merges three agents from raw strings in stable chronological order", () => {
      const merged = mergeAgentHistories([
        { agentId: "c", raw: '{"type":"c","timestamp":"2026-08-03T00:00:00.000Z"}\n' },
        { agentId: "a", raw: '{"type":"a","timestamp":"2026-08-01T00:00:00.000Z"}\n' },
        { agentId: "b", raw: '{"type":"b","timestamp":"2026-08-02T00:00:00.000Z"}\n' },
      ]);

      assert.deepEqual(
        merged.map((e) => e.record.type),
        ["a", "b", "c"],
      );
    });

    test("sorts by numeric ts field when timestamp string is absent", () => {
      const early = 1_700_000_000_000;
      const late = early + 5_000;
      const merged = mergeAgentHistories([
        {
          agentId: "epoch",
          raw: [
            `{"type":"late","ts":${late}}`,
            `{"type":"early","ts":${early}}`,
          ].join("\n"),
        },
      ]);

      assert.deepEqual(merged.map((e) => e.record.type), ["early", "late"]);
      assert.deepEqual(merged.map((e) => e.timestampMs), [early, late]);
    });

    test("preserves line order within one agent when every entry lacks a timestamp", () => {
      const merged = mergeAgentHistories([
        {
          agentId: "solo",
          raw: '{"type":"alpha"}\n{"type":"beta"}\n{"type":"gamma"}\n',
        },
      ]);

      assert.deepEqual(merged.map((e) => e.record.type), ["alpha", "beta", "gamma"]);
      assert.deepEqual(
        merged.map((e) => e.lineIndex),
        [0, 1, 2],
      );
      assert.ok(merged.every((e) => e.timestampMs === null));
    });

    test("ignores empty raw, empty entries, and missing path payloads", () => {
      const merged = mergeAgentHistories([
        { agentId: "ghost", raw: "" },
        { agentId: "void", entries: [] },
        { agentId: "missing", path: "/no/such/agent.jsonl" },
        {
          agentId: "real",
          raw: '{"type":"only","timestamp":"2026-09-01T00:00:00.000Z"}\n',
        },
      ]);

      assert.equal(merged.length, 1);
      assert.equal(merged[0].agentId, "real");
      assert.equal(merged[0].record.type, "only");
    });

    test("three-way timestamp tie follows source list order", () => {
      const ts = "2026-06-15T12:00:00.000Z";
      const ms = Date.parse(ts);
      const mk = (agentId, type) => ({
        agentId,
        entries: [
          {
            agentId,
            path: "",
            lineIndex: 0,
            record: { type, timestamp: ts },
            timestampMs: ms,
          },
        ],
      });

      const merged = mergeAgentHistories([mk("z", "z"), mk("m", "m"), mk("a", "a")]);
      assert.deepEqual(merged.map((e) => e.agentId), ["z", "m", "a"]);
    });

    test("breaks equal timestamps by lineIndex within the same agent", () => {
      const ts = "2026-06-20T00:00:00.000Z";
      const ms = Date.parse(ts);
      const merged = mergeAgentHistories([
        {
          agentId: "parent",
          entries: [
            {
              agentId: "parent",
              path: "p",
              lineIndex: 2,
              record: { type: "third", timestamp: ts },
              timestampMs: ms,
            },
            {
              agentId: "parent",
              path: "p",
              lineIndex: 0,
              record: { type: "first", timestamp: ts },
              timestampMs: ms,
            },
            {
              agentId: "parent",
              path: "p",
              lineIndex: 1,
              record: { type: "second", timestamp: ts },
              timestampMs: ms,
            },
          ],
        },
      ]);

      assert.deepEqual(merged.map((e) => e.record.type), ["first", "second", "third"]);
    });

    test("places all timestamped rows before untimestamped across multiple agents", () => {
      const merged = mergeAgentHistories([
        {
          agentId: "a",
          raw: '{"type":"a-null"}\n{"type":"a-ts","timestamp":"2026-07-02T00:00:00.000Z"}\n',
        },
        {
          agentId: "b",
          raw: '{"type":"b-null"}\n{"type":"b-ts","timestamp":"2026-07-01T00:00:00.000Z"}\n',
        },
      ]);

      assert.deepEqual(
        merged.map((e) => e.record.type),
        ["b-ts", "a-ts", "a-null", "b-null"],
      );
      assert.ok(merged.slice(0, 2).every((e) => e.timestampMs != null));
      assert.ok(merged.slice(2).every((e) => e.timestampMs === null));
    });

    test("untimestamped entries from multiple agents follow source order then lineIndex", () => {
      const merged = mergeAgentHistories([
        {
          agentId: "second",
          raw: '{"type":"s-1"}\n{"type":"s-2"}\n',
        },
        {
          agentId: "first",
          raw: '{"type":"f-1"}\n{"type":"f-2"}\n',
        },
      ]);

      assert.deepEqual(
        merged.map((e) => [e.agentId, e.record.type]),
        [
          ["second", "s-1"],
          ["second", "s-2"],
          ["first", "f-1"],
          ["first", "f-2"],
        ],
      );
    });

    test("shares agent order across duplicate agentId sources and breaks ties by lineIndex", () => {
      const ts = "2026-06-25T00:00:00.000Z";
      const ms = Date.parse(ts);
      const merged = mergeAgentHistories([
        {
          agentId: "dup",
          entries: [
            {
              agentId: "dup",
              path: "a",
              lineIndex: 1,
              record: { type: "from-first", timestamp: ts },
              timestampMs: ms,
            },
          ],
        },
        {
          agentId: "other",
          entries: [
            {
              agentId: "other",
              path: "b",
              lineIndex: 0,
              record: { type: "other", timestamp: ts },
              timestampMs: ms,
            },
          ],
        },
        {
          agentId: "dup",
          entries: [
            {
              agentId: "dup",
              path: "c",
              lineIndex: 0,
              record: { type: "from-second", timestamp: ts },
              timestampMs: ms,
            },
          ],
        },
      ]);

      assert.deepEqual(merged.map((e) => e.record.type), ["from-second", "from-first", "other"]);
    });

    test("mixes pre-parsed entries with raw sources in one merge", () => {
      const merged = mergeAgentHistories([
        {
          agentId: "parsed",
          entries: [
            {
              agentId: "parsed",
              path: "",
              lineIndex: 0,
              record: { type: "mid", timestamp: "2026-08-10T00:00:01.000Z" },
              timestampMs: Date.parse("2026-08-10T00:00:01.000Z"),
            },
          ],
        },
        {
          agentId: "raw",
          raw: [
            '{"type":"early","timestamp":"2026-08-10T00:00:00.000Z"}',
            '{"type":"late","timestamp":"2026-08-10T00:00:02.000Z"}',
          ].join("\n"),
        },
      ]);

      assert.deepEqual(
        merged.map((e) => [e.agentId, e.record.type]),
        [
          ["raw", "early"],
          ["parsed", "mid"],
          ["raw", "late"],
        ],
      );
    });

    test("skips malformed jsonl lines while merging raw sidecars", () => {
      const merged = mergeAgentHistories([
        {
          agentId: "noisy",
          raw: [
            "{bad",
            '{"type":"keep","timestamp":"2026-08-11T00:00:00.000Z"}',
            "",
            '{"type":"also","timestamp":"2026-08-11T00:00:01.000Z"}',
          ].join("\n"),
        },
      ]);

      assert.equal(merged.length, 2);
      assert.deepEqual(merged.map((e) => e.record.type), ["keep", "also"]);
      assert.deepEqual(merged.map((e) => e.lineIndex), [0, 1]);
    });

    test("does not expose internal sort metadata on merged entries", () => {
      const merged = mergeAgentHistories([
        {
          agentId: "meta",
          raw: '{"type":"x","timestamp":"2026-08-12T00:00:00.000Z"}\n',
        },
      ]);

      assert.equal(merged.length, 1);
      assert.ok(!("_agentOrder" in merged[0]));
      assert.ok(!Object.prototype.hasOwnProperty.call(merged[0], "_agentOrder"));
    });

    test("sorts chronologically regardless of per-source entry order", () => {
      const merged = mergeAgentHistories([
        {
          agentId: "late-first",
          entries: [
            {
              agentId: "late-first",
              path: "",
              lineIndex: 0,
              record: { type: "late", timestamp: "2026-08-20T00:00:02.000Z" },
              timestampMs: Date.parse("2026-08-20T00:00:02.000Z"),
            },
            {
              agentId: "late-first",
              path: "",
              lineIndex: 1,
              record: { type: "early", timestamp: "2026-08-20T00:00:00.000Z" },
              timestampMs: Date.parse("2026-08-20T00:00:00.000Z"),
            },
          ],
        },
      ]);

      assert.deepEqual(merged.map((e) => e.record.type), ["early", "late"]);
    });
  });
});

describe("discoverAgentSidecarPaths", () => {
  test("returns [] for falsy or non-string sessionPath", () => {
    assert.deepEqual(discoverAgentSidecarPaths(""), []);
    assert.deepEqual(discoverAgentSidecarPaths(null), []);
    assert.deepEqual(discoverAgentSidecarPaths(undefined), []);
  });

  test("returns [] when path lacks .claude/ segment", () => {
    assert.deepEqual(discoverAgentSidecarPaths("/tmp/foo.jsonl"), []);
    assert.deepEqual(
      discoverAgentSidecarPaths("/home/x/projects/sess.jsonl"),
      [],
    );
  });

  test("returns [] when path does not end with .jsonl", () => {
    assert.deepEqual(
      discoverAgentSidecarPaths("/home/x/.claude/projects/p/sess.txt"),
      [],
    );
    assert.deepEqual(
      discoverAgentSidecarPaths("/home/x/.claude/projects/p/sess"),
      [],
    );
  });

  test("returns [] for non-Claude agent session roots", () => {
    assert.deepEqual(
      discoverAgentSidecarPaths("/home/x/.codex/sessions/rollout-a.jsonl"),
      [],
    );
    assert.deepEqual(
      discoverAgentSidecarPaths("/home/x/.opencode/sessions/ses_abc.jsonl"),
      [],
    );
  });

  test("returns [] when parent exists but subagents/ is missing", () => {
    const dir = mkTmp("agent-sidecar-disc-");
    cleanup.push(dir);
    const { parentPath } = claudeSessionTree(dir, { sessionId: "solo" });
    assert.deepEqual(discoverAgentSidecarPaths(parentPath), []);
  });

  test("returns [] when subagents/ exists but has no .jsonl files", () => {
    const dir = mkTmp("agent-sidecar-disc-");
    cleanup.push(dir);
    const { parentPath } = claudeSessionTree(dir, {
      sidecars: { "readme.txt": "skip", ".hidden.jsonl.bak": "" },
    });
    assert.deepEqual(discoverAgentSidecarPaths(parentPath), []);
  });

  test("discovers a single sidecar and strips .jsonl for agentId", () => {
    const dir = mkTmp("agent-sidecar-disc-");
    cleanup.push(dir);
    const { parentPath, subDir } = claudeSessionTree(dir, {
      sidecars: {
        "agent-abc.jsonl": '{"type":"user","timestamp":"2026-06-01T00:00:00.000Z"}\n',
      },
    });
    const sidecars = discoverAgentSidecarPaths(parentPath);
    assert.equal(sidecars.length, 1);
    assert.equal(sidecars[0].agentId, "agent-abc");
    assert.equal(sidecars[0].path, path.join(subDir, "agent-abc.jsonl"));
  });

  test("discovers every .jsonl file in subagents/", () => {
    const dir = mkTmp("agent-sidecar-disc-");
    cleanup.push(dir);
    const { parentPath, subDir } = claudeSessionTree(dir, {
      sidecars: {
        "agent-a.jsonl": "{}\n",
        "agent-b.jsonl": "{}\n",
        "agent-c.jsonl": "{}\n",
      },
    });
    const sidecars = discoverAgentSidecarPaths(parentPath);
    assert.equal(sidecars.length, 3);
    const ids = sidecars.map((s) => s.agentId).sort();
    assert.deepEqual(ids, ["agent-a", "agent-b", "agent-c"]);
    for (const id of ids) {
      const hit = sidecars.find((s) => s.agentId === id);
      assert.equal(hit.path, path.join(subDir, `${id}.jsonl`));
    }
  });

  test("ignores non-jsonl files and nested directories under subagents/", () => {
    const dir = mkTmp("agent-sidecar-disc-");
    cleanup.push(dir);
    const { parentPath } = claudeSessionTree(dir, {
      sidecars: { "keep.jsonl": "{}\n", "notes.txt": "nope" },
      subagentsExtras: [{ name: "nested-agent", isDir: true }],
    });
    const sidecars = discoverAgentSidecarPaths(parentPath);
    assert.equal(sidecars.length, 1);
    assert.equal(sidecars[0].agentId, "keep");
  });

  test("resolves sidecars for UUID session ids under ~/.claude/projects/", () => {
    const dir = mkTmp("agent-sidecar-disc-");
    cleanup.push(dir);
    const sessionId = "019e47cd-151a-75d1-8f42-53efb31db13f";
    const { parentPath, subDir } = claudeSessionTree(dir, {
      project: "ws-home-user-code-tracequest",
      sessionId,
      sidecars: { "sub-agent-1.jsonl": "{}\n" },
    });
    assert.ok(parentPath.includes(".claude/projects/"));
    const sidecars = discoverAgentSidecarPaths(parentPath);
    assert.deepEqual(sidecars, [
      {
        agentId: "sub-agent-1",
        path: path.join(subDir, "sub-agent-1.jsonl"),
      },
    ]);
  });

  test("preserves dotted agent basenames in agentId", () => {
    const dir = mkTmp("agent-sidecar-disc-");
    cleanup.push(dir);
    const { parentPath } = claudeSessionTree(dir, {
      sidecars: { "agent.tool.v2.jsonl": "{}\n" },
    });
    const sidecars = discoverAgentSidecarPaths(parentPath);
    assert.equal(sidecars.length, 1);
    assert.equal(sidecars[0].agentId, "agent.tool.v2");
  });

  test("accepts .claude/ anywhere in the path, not only under home", () => {
    const dir = mkTmp("agent-sidecar-disc-");
    cleanup.push(dir);
    const parentPath = path.join(
      dir,
      "mnt",
      "sync",
      ".claude",
      "projects",
      "p",
      "edge.jsonl",
    );
    const subDir = path.join(dir, "mnt", "sync", ".claude", "projects", "p", "edge", "subagents");
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(parentPath, "{}");
    fs.writeFileSync(path.join(subDir, "remote.jsonl"), "{}\n");

    const sidecars = discoverAgentSidecarPaths(parentPath);
    assert.equal(sidecars.length, 1);
    assert.equal(sidecars[0].agentId, "remote");
    assert.equal(sidecars[0].path, path.join(subDir, "remote.jsonl"));
  });

  test("an unreadable subagents/ is skipped and warned about, not rethrown", () => {
    // This used to rethrow, on the reasoning that an unreadable directory is
    // not the same as an absent one. It is not the same — but it is also not a
    // reason to fail the caller: the same helper backs session discovery, where
    // one 0700 directory anywhere under a session root emptied the entire
    // dashboard (fact a4k). The distinction is now carried by a warning rather
    // than by an exception.
    const dir = mkTmp("agent-sidecar-disc-");
    cleanup.push(dir);
    const { parentPath, subDir } = claudeSessionTree(dir, {
      sidecars: { "agent-x.jsonl": "{}\n" },
    });
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      fs.chmodSync(subDir, 0o000);
      let sidecars;
      assert.doesNotThrow(() => {
        sidecars = discoverAgentSidecarPaths(parentPath);
      });
      assert.deepEqual(sidecars, [], "an unreadable sidecar dir contributes nothing");
      assert.equal(warnings.length, 1, "and says so exactly once");
      assert.match(warnings[0], /skipping unreadable subagents dir/);
      assert.match(warnings[0], /subagents/);
    } finally {
      fs.chmodSync(subDir, 0o755);
      console.warn = origWarn;
    }
  });

  test("returns [] for non-string sessionPath values", () => {
    assert.deepEqual(discoverAgentSidecarPaths(0), []);
    assert.deepEqual(discoverAgentSidecarPaths(false), []);
    assert.deepEqual(discoverAgentSidecarPaths({ path: "/x/.claude/p/s.jsonl" }), []);
  });

  test("returns [] when parent session uses non-lowercase .jsonl extension", () => {
    const dir = mkTmp("agent-sidecar-disc-");
    cleanup.push(dir);
    const proj = claudeProj(dir, "caseproj");
    const sessionId = "sess-upper";
    const parentPath = path.join(proj, `${sessionId}.JSONL`);
    const subDir = path.join(proj, sessionId, "subagents");
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(parentPath, "{}");
    fs.writeFileSync(path.join(subDir, "scout.jsonl"), "{}\n");
    assert.deepEqual(discoverAgentSidecarPaths(parentPath), []);
  });

  test("returns [] when subagents/ exists but is empty", () => {
    const dir = mkTmp("agent-sidecar-disc-");
    cleanup.push(dir);
    const { parentPath } = claudeSessionTree(dir, { emptySubagents: true });
    assert.deepEqual(discoverAgentSidecarPaths(parentPath), []);
  });

  test("discovers dot-prefixed and zero-byte .jsonl sidecars without reading them", () => {
    const dir = mkTmp("agent-sidecar-disc-");
    cleanup.push(dir);
    const { parentPath, subDir } = claudeSessionTree(dir, {
      sidecars: {
        ".hidden-scout.jsonl": "",
        "empty.jsonl": "",
      },
    });
    const sidecars = discoverAgentSidecarPaths(parentPath);
    assert.equal(sidecars.length, 2);
    const byId = Object.fromEntries(sidecars.map((s) => [s.agentId, s.path]));
    assert.equal(byId[".hidden-scout"], path.join(subDir, ".hidden-scout.jsonl"));
    assert.equal(byId.empty, path.join(subDir, "empty.jsonl"));
  });

  test("skips directory entries whose names end with .jsonl", () => {
    const dir = mkTmp("agent-sidecar-disc-");
    cleanup.push(dir);
    const { parentPath, subDir } = claudeSessionTree(dir, {
      sidecars: { "real.jsonl": "{}\n" },
      subagentsExtras: [{ name: "fake.jsonl", isDir: true }],
    });
    const sidecars = discoverAgentSidecarPaths(parentPath);
    assert.equal(sidecars.length, 1);
    assert.equal(sidecars[0].agentId, "real");
    assert.equal(sidecars[0].path, path.join(subDir, "real.jsonl"));
  });

  test("skips symlinked .jsonl entries (readdir isFile() is false for symlinks)", () => {
    const dir = mkTmp("agent-sidecar-disc-");
    cleanup.push(dir);
    const { parentPath, subDir } = claudeSessionTree(dir, {
      sidecars: { "target.jsonl": '{"type":"user"}\n' },
    });
    fs.symlinkSync(path.join(subDir, "target.jsonl"), path.join(subDir, "via-link.jsonl"));
    const sidecars = discoverAgentSidecarPaths(parentPath);
    assert.equal(sidecars.length, 1);
    assert.equal(sidecars[0].agentId, "target");
  });
});

describe("discoverAgentSidecarPaths — cursor", () => {
  test("discovers sibling subagents/ sidecars for a cursor parent transcript", () => {
    const dir = mkTmp("cursor-sidecar-disc-");
    cleanup.push(dir);
    const { parentPath, subDir } = cursorSessionTree(dir, {
      sidecars: { "sub-1.jsonl": cursorUserRow("do the thing") + "\n" },
    });
    const sidecars = discoverAgentSidecarPaths(parentPath);
    assert.deepEqual(sidecars, [
      { agentId: "sub-1", path: path.join(subDir, "sub-1.jsonl"), format: "cursor" },
    ]);
  });

  test("returns [] for the cursor subagent session paths themselves", () => {
    const dir = mkTmp("cursor-sidecar-disc-");
    cleanup.push(dir);
    const { subDir } = cursorSessionTree(dir, {
      sidecars: { "sub-1.jsonl": cursorUserRow("hi") + "\n" },
    });
    assert.deepEqual(discoverAgentSidecarPaths(path.join(subDir, "sub-1.jsonl")), []);
  });

  test("returns [] when subagents/ is missing or empty", () => {
    const dir = mkTmp("cursor-sidecar-disc-");
    cleanup.push(dir);
    const solo = cursorSessionTree(dir, { uuid: "aaaaaaaa-0000-0000-0000-000000000001" });
    assert.deepEqual(discoverAgentSidecarPaths(solo.parentPath), []);
    const empty = cursorSessionTree(dir, {
      uuid: "aaaaaaaa-0000-0000-0000-000000000002",
      emptySubagents: true,
    });
    assert.deepEqual(discoverAgentSidecarPaths(empty.parentPath), []);
  });

  test("returns [] for .cursor/ paths outside the agent-transcripts layout", () => {
    const dir = mkTmp("cursor-sidecar-disc-");
    cleanup.push(dir);
    const stray = path.join(dir, ".cursor", "projects", "p", "stray.jsonl");
    fs.mkdirSync(path.dirname(stray), { recursive: true });
    fs.writeFileSync(stray, cursorUserRow("hi") + "\n");
    assert.deepEqual(discoverAgentSidecarPaths(stray), []);
  });

  test("orders sidecars by file mtime ascending, not by name", () => {
    const dir = mkTmp("cursor-sidecar-disc-");
    cleanup.push(dir);
    const { parentPath, subDir } = cursorSessionTree(dir, {
      sidecars: {
        "aaa-newer.jsonl": cursorUserRow("newer") + "\n",
        "zzz-older.jsonl": cursorUserRow("older") + "\n",
      },
    });
    const t0 = new Date("2026-07-01T00:00:00Z");
    const t1 = new Date("2026-07-01T01:00:00Z");
    fs.utimesSync(path.join(subDir, "zzz-older.jsonl"), t0, t0);
    fs.utimesSync(path.join(subDir, "aaa-newer.jsonl"), t1, t1);
    const sidecars = discoverAgentSidecarPaths(parentPath);
    assert.deepEqual(sidecars.map((s) => s.agentId), ["zzz-older", "aaa-newer"]);
    assert.ok(sidecars.every((s) => s.format === "cursor"));
  });
});

describe("agent history — cursor sidecars", () => {
  test("loadCursorAgentHistoryFile returns [] for missing or falsy paths", () => {
    assert.deepEqual(loadCursorAgentHistoryFile(""), []);
    assert.deepEqual(loadCursorAgentHistoryFile(null), []);
    assert.deepEqual(loadCursorAgentHistoryFile("/no/such/cursor-subagent.jsonl"), []);
  });

  test("parses cursor rows into Claude-shape records with null timestamps", () => {
    const dir = mkTmp("cursor-history-");
    cleanup.push(dir);
    const { parentPath, subDir } = cursorSessionTree(dir, {
      sidecars: {
        "sub-1.jsonl": [
          cursorUserRow("<user_query>review the diff for bugs</user_query>"),
          cursorAssistantRow("Scanning the diff now", {
            name: "Shell",
            input: { command: "git diff", working_directory: "/w" },
          }),
          '{"type":"turn_ended","status":"error","error":"subagent crashed"}',
        ].join("\n") + "\n",
      },
    });

    const merged = loadAgentHistoryForSession(parentPath);
    assert.ok(merged);
    assert.equal(merged.length, 3);
    assert.ok(merged.every((e) => e.agentId === "sub-1"));
    assert.ok(merged.every((e) => e.path === path.join(subDir, "sub-1.jsonl")));
    assert.ok(merged.every((e) => e.timestampMs === null));
    assert.ok(merged.every((e) => e.record.timestamp === null));
    assert.deepEqual(merged.map((e) => e.lineIndex), [0, 1, 2]);

    assert.equal(merged[0].record.type, "user");
    assert.equal(merged[0].record.text, "review the diff for bugs");

    assert.equal(merged[1].record.type, "assistant");
    assert.equal(merged[1].record.text, "Scanning the diff now");
    assert.equal(merged[1].record.toolCalls.length, 1);
    // enrichToolEvent normalizes Cursor "Shell" to the Claude-shape "Bash" tool name.
    assert.equal(merged[1].record.toolCalls[0].name, "Bash");

    assert.equal(merged[2].record.type, "tool_result");
    assert.equal(merged[2].record.isError, true);
    assert.match(merged[2].record.text, /subagent crashed/);
  });

  test("orders entries across sidecars by file mtime, keeping file order within each", () => {
    const dir = mkTmp("cursor-history-");
    cleanup.push(dir);
    const { parentPath, subDir } = cursorSessionTree(dir, {
      sidecars: {
        "aaa-newer.jsonl": cursorUserRow("n-1") + "\n" + cursorAssistantRow("n-2") + "\n",
        "zzz-older.jsonl": cursorUserRow("o-1") + "\n" + cursorAssistantRow("o-2") + "\n",
      },
    });
    const t0 = new Date("2026-07-01T00:00:00Z");
    const t1 = new Date("2026-07-01T01:00:00Z");
    fs.utimesSync(path.join(subDir, "zzz-older.jsonl"), t0, t0);
    fs.utimesSync(path.join(subDir, "aaa-newer.jsonl"), t1, t1);

    const merged = loadAgentHistoryForSession(parentPath);
    assert.deepEqual(
      merged.map((e) => [e.agentId, e.record.text]),
      [
        ["zzz-older", "o-1"],
        ["zzz-older", "o-2"],
        ["aaa-newer", "n-1"],
        ["aaa-newer", "n-2"],
      ],
    );
  });

  test("returns null when cursor sidecars exist but contain no parseable rows", () => {
    const dir = mkTmp("cursor-history-");
    cleanup.push(dir);
    const { parentPath } = cursorSessionTree(dir, {
      sidecars: { "empty.jsonl": "", "noise.jsonl": "{not json\n" },
    });
    assert.equal(loadAgentHistoryForSession(parentPath), null);
  });

  test("mixed merge with timestamped Claude entries does not throw and keeps timestamped rows first", () => {
    const dir = mkTmp("cursor-history-");
    cleanup.push(dir);
    const { subDir } = cursorSessionTree(dir, {
      sidecars: { "sub-1.jsonl": cursorUserRow("untimestamped cursor row") + "\n" },
    });

    const merged = mergeAgentHistories([
      { agentId: "sub-1", path: path.join(subDir, "sub-1.jsonl"), format: "cursor" },
      {
        agentId: "claude-agent",
        raw: '{"type":"assistant","timestamp":"2026-06-03T00:00:01.000Z","text":"claude row"}\n',
      },
    ]);

    assert.deepEqual(
      merged.map((e) => [e.agentId, e.record.text, e.timestampMs === null]),
      [
        ["claude-agent", "claude row", false],
        ["sub-1", "untimestamped cursor row", true],
      ],
    );
  });
});