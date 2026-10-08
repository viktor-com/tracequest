import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { minimalSession } from "../helpers/minimal-session.js";

async function withEmptyHome(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-api-home-"));
  const originalHome = process.env.HOME;
  const originalNoSidecar = process.env.TRACEQUEST_NO_SIDECAR;
  process.env.HOME = tmpDir;
  process.env.TRACEQUEST_NO_SIDECAR = "1";
  try {
    const modUrl = new URL("../../src/api/tracequest-api.js?" + Date.now(), import.meta.url);
    const api = await import(modUrl.href);
    await fn(tmpDir, api);
  } finally {
    process.env.HOME = originalHome;
    if (originalNoSidecar === undefined) delete process.env.TRACEQUEST_NO_SIDECAR;
    else process.env.TRACEQUEST_NO_SIDECAR = originalNoSidecar;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("tracequest-api package exports", () => {
  test("tracequest/api subpath resolves core entry points", async () => {
    const api = await import("tracequest/api");
    assert.equal(typeof api.findSessions, "function");
    assert.equal(typeof api.buildIndex, "function");
    assert.equal(typeof api.searchSessions, "function");
    assert.equal(typeof api.comparePage, "function");
    assert.equal(typeof api.parseSession, "function");
    assert.equal(typeof api.renderHTML, "function");
    assert.equal(typeof api.generateMarkdown, "function");
    assert.equal(typeof api.exportMessages, "function");
    assert.equal(typeof api.peekSession, "function");
    assert.equal(typeof api.sortSessionsByMtimeDesc, "function");
  });
});

describe("tracequest-api findSessions (empty HOME)", () => {
  test("findSessions(null) returns empty array when HOME has no agent dirs", async () => {
    await withEmptyHome(async (_tmpDir, { findSessions }) => {
      const sessions = findSessions(null);
      assert.deepEqual(sessions, []);
    });
  });

  test("findSessions(filter) returns empty array when nothing matches", async () => {
    await withEmptyHome(async (_tmpDir, { findSessions }) => {
      const sessions = findSessions("nonexistent-project-filter-xyz");
      assert.deepEqual(sessions, []);
    });
  });

  test("findSessions discovers claude jsonl under isolated HOME", async () => {
    await withEmptyHome(async (tmpDir, { findSessions }) => {
      const projDir = path.join(tmpDir, ".claude", "projects", "api-smoke-proj");
      fs.mkdirSync(projDir, { recursive: true });
      const sessionPath = path.join(projDir, "sess.jsonl");
      fs.writeFileSync(sessionPath, JSON.stringify({ type: "user", message: { content: "x" } }) + "\n");

      const sessions = findSessions("api-smoke-proj");
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].path, sessionPath);
      assert.equal(sessions[0].source, "claude");
    });
  });
});

describe("tracequest-api buildIndex smoke", () => {
  test("buildIndex([]) returns empty Map", async () => {
    const { buildIndex } = await import("../../src/api/tracequest-api.js");
    const index = buildIndex([]);
    assert.ok(index instanceof Map);
    assert.equal(index.size, 0);
  });

  test("buildIndex after findSessions on empty HOME stays empty", async () => {
    await withEmptyHome(async (_tmpDir, { findSessions, buildIndex }) => {
      const sessions = findSessions(null);
      const index = buildIndex(sessions);
      assert.equal(sessions.length, 0);
      assert.ok(index instanceof Map);
      assert.equal(index.size, 0);
    });
  });

  test("buildIndex indexes discovered session under isolated HOME", async () => {
    await withEmptyHome(async (tmpDir, { findSessions, buildIndex, searchSessions }) => {
      const projDir = path.join(tmpDir, ".claude", "projects", "api-index-proj");
      fs.mkdirSync(projDir, { recursive: true });
      const sessionPath = path.join(projDir, "needle.jsonl");
      const row = {
        type: "user",
        message: { content: [{ type: "text", text: "api-index-needle prompt" }] },
      };
      fs.writeFileSync(sessionPath, JSON.stringify(row) + "\n");

      const sessions = findSessions("api-index-proj");
      const index = buildIndex(sessions);
      assert.equal(sessions.length, 1);
      assert.ok(index instanceof Map);
      const hits = searchSessions(sessions, index, "api-index-needle", 10);
      assert.equal(hits.length, 1);
      assert.equal(hits[0].file, "needle.jsonl");
    });
  });
});

describe("tracequest-api comparePage import", () => {
  test("comparePage from API barrel emits comparison HTML", async () => {
    const { comparePage } = await import("../../src/api/tracequest-api.js");
    const html = comparePage(
      minimalSession(),
      minimalSession({
        sessionId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
        _path: "/tmp/smoke-b.jsonl",
      })
    );
    assert.equal(typeof html, "string");
    assert.ok(html.startsWith("<!DOCTYPE html>"));
    assert.match(html, /session comparison/);
    assert.match(html, /cmp-col-b/);
  });
});

describe("tracequest-api integration smoke", () => {
  test("searchSessions on empty inputs returns []", async () => {
    const { buildIndex, searchSessions } = await import("../../src/api/tracequest-api.js");
    const index = buildIndex([]);
    assert.deepEqual(searchSessions([], index, "needle", 5), []);
  });

  test("sortSessionsByMtimeDesc orders by mtime descending", async () => {
    const { sortSessionsByMtimeDesc } = await import("../../src/api/tracequest-api.js");
    const sessions = [
      { path: "/a", mtime: new Date(1000) },
      { path: "/b", mtime: new Date(3000) },
      { path: "/c", mtime: new Date(2000) },
    ];
    sortSessionsByMtimeDesc(sessions);
    assert.deepEqual(
      sessions.map((s) => s.path),
      ["/b", "/c", "/a"]
    );
  });

  test("peekSession extracts prompt and model from minimal claude jsonl", async () => {
    const { peekSession } = await import("../../src/api/tracequest-api.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-api-"));
    const filePath = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: "user",
          message: { content: [{ type: "text", text: "api smoke" }] },
        }),
        JSON.stringify({
          type: "assistant",
          message: { model: "claude-sonnet-4", content: [{ type: "text", text: "ok" }] },
        }),
      ].join("\n") + "\n"
    );

    try {
      const size = fs.statSync(filePath).size;
      const row = { path: filePath, size, source: "claude" };
      const meta = peekSession(row);
      assert.equal(meta.firstPrompt, "api smoke");
      assert.equal(meta.model, "claude-sonnet-4");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});