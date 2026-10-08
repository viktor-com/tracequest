import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { browserPage } from "../../src/browser/browser-page.js";
import {
  computeStats,
  getSessionMeta,
  sessionToApiObject,
} from "../../src/server/server-helpers.js";

describe("server-helpers sessionToApiObject", () => {
  test("exposes projectRaw before folder normalization", () => {
    const session = {
      path: "/tmp/nested.jsonl",
      source: "codex",
      project: "/home/user/code/foo/bar",
      file: "nested.jsonl",
      size: 1024,
      mtime: new Date("2026-01-01T00:00:00Z"),
    };
    const api = sessionToApiObject(session, {});
    assert.equal(api.projectRaw, "/home/user/code/foo/bar");
    assert.equal(api.project, "bar");
    assert.equal("host" in api, false);
  });

  test("copies host when the discovery row carries it", () => {
    const api = sessionToApiObject({
      path: "/tmp/hosts/gpu/.claude/projects/p/a.jsonl",
      source: "claude",
      host: "gpu",
      project: "p",
      file: "a.jsonl",
      size: 10,
      mtime: new Date("2026-01-01T00:00:00Z"),
    }, {});
    assert.equal(api.host, "gpu");
    assert.equal(api.source, "claude");
  });
});

describe("server-helpers getSessionMeta", () => {
  test("returns index entry when present", () => {
    const session = { path: "/tmp/a.jsonl" };
    const meta = { firstPrompt: "hi", model: "m" };
    const index = new Map([[session.path, meta]]);
    assert.strictEqual(getSessionMeta(index, session, () => ({ wrong: true })), meta);
  });

  test("falls back to peekSession when index misses", () => {
    const session = { path: "/tmp/b.jsonl" };
    const peeked = { firstPrompt: "peeked" };
    assert.deepEqual(getSessionMeta(new Map(), session, () => peeked), peeked);
  });

  test("returns empty object when index misses and peekSession absent", () => {
    const session = { path: "/tmp/c.jsonl" };
    assert.deepEqual(getSessionMeta(new Map(), session, null), {});
  });
});

describe("browserPage stats via shared computeStats", () => {
  test("embedded _INIT_DATA stats match computeStats over sessionToApiObject rows", () => {
    const sessions = [
      {
        path: "/tmp/s0.jsonl",
        source: "claude",
        project: "proj-a",
        file: "s0.jsonl",
        size: 2048,
        mtime: new Date("2026-01-01T00:00:00Z"),
        title: "t0",
      },
      {
        path: "/tmp/s1.jsonl",
        source: "codex",
        project: "proj-b",
        file: "s1.jsonl",
        size: 4096,
        mtime: new Date("2026-01-02T00:00:00Z"),
        title: "t1",
      },
    ];
    const index = new Map([
      [sessions[0].path, {
        firstPrompt: "p0",
        model: "claude-sonnet-4-6",
        tools: ["Bash"],
        chapters: 2,
        totalTokens: 100,
        inputTokens: 60,
        outputTokens: 40,
        cacheReadTokens: 10,
        durationMs: 1000,
        errors: 1,
        files: 1,
        commits: 0,
      }],
      [sessions[1].path, {
        firstPrompt: "p1",
        model: "gpt-4",
        tools: ["Read"],
        chapters: 0,
        totalTokens: 50,
        inputTokens: 30,
        outputTokens: 20,
        cacheReadTokens: 0,
        durationMs: 500,
        errors: 0,
        files: 2,
        commits: 1,
      }],
    ]);

    const html = browserPage(sessions, index, null);
    const anchor = "var _INIT_DATA = ";
    const start = html.indexOf(anchor) + anchor.length;
    const end = html.indexOf(";\n", start);
    const payload = JSON.parse(html.slice(start, end));

    const expected = computeStats(
      sessions.map((s) => sessionToApiObject(s, getSessionMeta(index, s, null))),
    );
    assert.deepEqual(payload.stats, expected);
    assert.equal(payload.stats.totalSessions, 2);
    assert.equal(payload.stats.totalTokens, 150);
    assert.equal(payload.stats.errorSessionCount, 1);
  });
});