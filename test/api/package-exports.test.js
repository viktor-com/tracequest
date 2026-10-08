import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import * as sessionsBarrel from "../../src/sessions.js";
import * as parseBarrel from "../../src/parse.js";
import * as renderBarrel from "../../src/render.js";
import { minimalSession } from "../helpers/minimal-session.js";
import { getSearchIndex, resetSearchIndexForTests } from "../../src/sessions/search-index.js";
import { tokenize } from "../../src/sessions/search-tokenizer.js";

afterEach(() => {
  resetSearchIndexForTests();
});

function seedSearchIndex(filePath, text) {
  const si = getSearchIndex();
  const terms = tokenize(text);
  const termFreqs = new Map();
  for (const t of terms) termFreqs.set(t, (termFreqs.get(t) || 0) + 1);
  si.upsert(filePath, termFreqs);
}

describe("tracequest package.json export subpaths", () => {
  test("tracequest/api findSessions filters sessions by project query", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-export-find-"));
    const originalHome = process.env.HOME;
    const originalNoSidecar = process.env.TRACEQUEST_NO_SIDECAR;
    process.env.HOME = tmpDir;
    process.env.TRACEQUEST_NO_SIDECAR = "1";
    try {
      const hitProj = path.join(tmpDir, ".claude", "projects", "api-export-find-hit");
      const missProj = path.join(tmpDir, ".claude", "projects", "api-export-find-miss");
      fs.mkdirSync(hitProj, { recursive: true });
      fs.mkdirSync(missProj, { recursive: true });
      fs.writeFileSync(path.join(hitProj, "hit.jsonl"), JSON.stringify({ command: "echo" }));
      fs.writeFileSync(path.join(missProj, "miss.jsonl"), JSON.stringify({ command: "echo" }));

      const { findSessions } = await import("tracequest/api");
      const sessions = findSessions("api-export-find-hit");
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].file, "hit.jsonl");
      assert.ok(sessions[0].project.includes("api-export-find-hit"));
    } finally {
      process.env.HOME = originalHome;
      if (originalNoSidecar === undefined) delete process.env.TRACEQUEST_NO_SIDECAR;
      else process.env.TRACEQUEST_NO_SIDECAR = originalNoSidecar;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("tracequest/api searchSessions finds needle in minimal index", async () => {
    const { searchSessions } = await import("tracequest/api");
    const filePath = "/fake/api-export-search.jsonl";
    const sessions = [
      {
        path: filePath,
        source: "claude",
        project: "myproj",
        file: "api-export-search.jsonl",
        mtime: new Date("2026-01-01"),
      },
    ];
    seedSearchIndex(filePath, "api export search smoke needle");
    const index = new Map();
    index.set(filePath, {
      firstPrompt: "hello",
      model: "claude-3",
    });
    const results = searchSessions(sessions, index, "needle", 5);
    assert.equal(results.length, 1);
    assert.equal(results[0].path, filePath);
    assert.ok(results[0].matches?.length >= 1);
  });

  test("tracequest/api parseSession reads minimal claude jsonl", async () => {
    const { parseSession } = await import("tracequest/api");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-export-api-parse-"));
    const filePath = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "text", text: "api export parse smoke" }] },
      }) + "\n"
    );
    try {
      const session = parseSession(filePath, "claude");
      assert.equal(session.source, "claude");
      assert.ok(session.events.length >= 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("tracequest/api peekSession extracts prompt from claude jsonl", async () => {
    const { peekSession } = await import("tracequest/api");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-export-api-peek-"));
    const filePath = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "text", text: "api export peek smoke" }] },
      }) + "\n"
    );
    const size = fs.statSync(filePath).size;
    try {
      const meta = peekSession({ path: filePath, size, source: "claude" });
      assert.equal(meta.firstPrompt, "api export peek smoke");
      assert.ok(meta.termFreqs instanceof Map && meta.termFreqs.has("api") && meta.termFreqs.has("peek"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("sessions barrel exposes only stable tracequest-api surface", () => {
    const publicKeys = [
      "findSessions",
      "buildIndex",
      "searchSessions",
      "peekSession",
      "sortSessionsByMtimeDesc",
    ];
    assert.deepEqual(Object.keys(sessionsBarrel).sort(), publicKeys.sort());
    for (const key of [
      "detectLiveSessions",
      "INDEX_VERSION",
      "indexOpenCode",
      "indexSession",
      "sessionMtimeMs",
      "sessionListChecksum",
    ]) {
      assert.equal(sessionsBarrel[key], undefined, `internal ${key} must not be on sessions barrel`);
    }
  });

  test("tracequest/parse parseSession reads minimal claude jsonl", async () => {
    const { parseSession } = await import("tracequest/parse");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-export-parse-"));
    const filePath = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "text", text: "parse export smoke" }] },
      }) + "\n"
    );
    try {
      const session = parseSession(filePath, "claude");
      assert.equal(session.source, "claude");
      assert.ok(session.events.length >= 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("parse barrel exposes only stable tracequest-api surface", () => {
    assert.deepEqual(Object.keys(parseBarrel).sort(), ["parseSession"]);
    for (const key of [
      "parseJsonlLine",
      "normalizeToolName",
      "shortToolPath",
      "safeSlice",
      "parseEscapedJsonString",
      "forEachPartialParsedJsonlLine",
    ]) {
      assert.equal(parseBarrel[key], undefined, `internal ${key} must not be on parse barrel`);
    }
  });

  test("tracequest/api renderHTML emits self-contained HTML", async () => {
    const { renderHTML } = await import("tracequest/api");
    const html = renderHTML(minimalSession());
    assert.equal(typeof html, "string");
    assert.ok(html.startsWith("<!DOCTYPE html>"));
    assert.match(html, /const SESSION =/);
    assert.match(html, /tracequest/);
  });

  test("tracequest/api generateMarkdown emits markdown document", async () => {
    const { generateMarkdown } = await import("tracequest/api");
    const md = generateMarkdown(minimalSession());
    assert.equal(typeof md, "string");
    assert.match(md, /^# Session aaaaaaaa/);
    assert.match(md, /Exported from \[tracequest\]/);
  });

  test("tracequest/api exportMessages emits anthropic messages", async () => {
    const { exportMessages } = await import("tracequest/api");
    const result = exportMessages(minimalSession());
    assert.ok(Array.isArray(result.messages));
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].role, "user");
    assert.equal(result.messages[0].content[0].text, "hello");
  });

  test("tracequest/api comparePage emits comparison HTML", async () => {
    const { comparePage } = await import("tracequest/api");
    const html = comparePage(
      minimalSession(),
      minimalSession({
        sessionId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
        _path: "/tmp/compare-b.jsonl",
      })
    );
    assert.equal(typeof html, "string");
    assert.ok(html.startsWith("<!DOCTYPE html>"));
    assert.match(html, /session comparison/);
    assert.match(html, /cmp-col-b/);
  });

  test("tracequest/render renderHTML emits self-contained HTML", async () => {
    const { renderHTML } = await import("tracequest/render");
    const html = renderHTML(minimalSession());
    assert.equal(typeof html, "string");
    assert.ok(html.startsWith("<!DOCTYPE html>"));
    assert.match(html, /const SESSION =/);
    assert.match(html, /tracequest/);
  });

  test("render barrel exposes only stable tracequest-api surface", () => {
    assert.deepEqual(Object.keys(renderBarrel).sort(), ["renderHTML"]);
  });

  test("api subpath comparePage is not on render barrel", () => {
    assert.equal(renderBarrel.comparePage, undefined);
  });
});

describe("tracequest export subpath smoke behavior", () => {
  test("tracequest/api buildIndex([]) returns empty Map", async () => {
    const { buildIndex } = await import("tracequest/api");
    const index = buildIndex([]);
    assert.ok(index instanceof Map);
    assert.equal(index.size, 0);
  });

  test("tracequest/api sortSessionsByMtimeDesc orders newest first", async () => {
    const { sortSessionsByMtimeDesc } = await import("tracequest/api");
    const rows = [
      { path: "/a", mtime: new Date(1000) },
      { path: "/b", mtime: new Date(3000) },
      { path: "/c", mtime: new Date(2000) },
    ];
    sortSessionsByMtimeDesc(rows);
    assert.deepEqual(
      rows.map((r) => r.path),
      ["/b", "/c", "/a"]
    );
  });
});