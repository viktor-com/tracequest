/**
 * agentHistory is merged in fetchSession from Claude subagent sidecars.
 * Compare and markdown export use parsed session events/chapters only.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fetchSession } from "../src/server/server-helpers.js";
import { comparePage } from "../src/browser/compare-page.js";
import { generateMarkdown } from "../src/export/markdown-export.js";
import { renderHTML } from "../src/render.js";
import { mockHttpResponse } from "./helpers/capture-json-handler.js";

const SIDECAR_MARKER = "TQ_SIDECAR_ONLY_AGENT_HISTORY_MARKER";

function claudeParentWithSidecar(tmpHome) {
  const proj = path.join(tmpHome, ".claude", "projects", "tq-surface");
  const sessionId = "sess-agent-surface";
  const subDir = path.join(proj, sessionId, "subagents");
  fs.mkdirSync(subDir, { recursive: true });
  const sessionPath = path.join(proj, `${sessionId}.jsonl`);
  fs.writeFileSync(
    sessionPath,
    '{"type":"user","timestamp":"2026-06-03T00:00:00.000Z","message":{"content":[{"type":"text","text":"parent prompt"}]}}\n',
  );
  fs.writeFileSync(
    path.join(subDir, "scout.jsonl"),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-03T00:00:01.000Z",
      text: SIDECAR_MARKER,
    }) + "\n",
  );
  return sessionPath;
}

function parseInlinedSession(html) {
  const marker = "const SESSION = ";
  const start = html.indexOf(marker);
  assert.ok(start >= 0, "renderHTML should embed const SESSION");
  const jsonStart = start + marker.length;
  const jsonEnd = html.indexOf(";\n", jsonStart);
  assert.ok(jsonEnd > jsonStart, "SESSION JSON should terminate before bundle script");
  return JSON.parse(html.slice(jsonStart, jsonEnd));
}

function parsedParentSession(sessionPath) {
  return {
    sessionId: "parent-surface",
    source: "claude",
    model: "claude-test",
    durationMs: 1000,
    startTime: "2026-06-03T00:00:00.000Z",
    events: [
      { type: "user", text: "parent prompt", timestamp: "2026-06-03T00:00:00.000Z" },
      { type: "assistant", text: "parent reply", timestamp: "2026-06-03T00:00:05.000Z", toolCalls: [] },
    ],
    stats: {
      userMessages: 1,
      assistantTurns: 1,
      toolCounts: {},
      totalInputTokens: 10,
      totalOutputTokens: 5,
      errors: 0,
    },
    _path: sessionPath,
  };
}

describe("agentHistory surface contract", () => {
  it("fetchSession attaches agentHistory from subagent sidecars", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-surface-fetch-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const sessionPath = claudeParentWithSidecar(tmpHome);
      const res = mockHttpResponse();
      const url = new URL(`http://localhost/view?path=${encodeURIComponent(sessionPath)}`);
      const session = await fetchSession(
        url,
        async (p) => ({ ...parsedParentSession(p), path: p }),
        res,
      );

      assert.ok(session);
      assert.equal(res.status, undefined);
      assert.ok(Array.isArray(session.agentHistory));
      assert.equal(session.agentHistory.length, 1);
      assert.equal(session.agentHistory[0].agentId, "scout");
      assert.equal(session.agentHistory[0].record.text, SIDECAR_MARKER);
      assert.equal(session.agentSidecarCount, 1);
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("comparePage does not render agentHistory even when present on session", () => {
    const sessionPath = "/tmp/parent.jsonl";
    const withHistory = {
      ...parsedParentSession(sessionPath),
      agentHistory: [
        {
          agentId: "scout",
          path: "/tmp/subagents/scout.jsonl",
          lineIndex: 0,
          record: { type: "assistant", text: SIDECAR_MARKER },
          timestampMs: Date.parse("2026-06-03T00:00:01.000Z"),
        },
      ],
      agentSidecarCount: 1,
    };
    const peer = {
      ...parsedParentSession("/tmp/peer.jsonl"),
      sessionId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
      _path: "/tmp/peer.jsonl",
    };

    const html = comparePage(withHistory, peer);
    assert.doesNotMatch(html, /agentHistory|agent-sidecar|Agent history/i);
    assert.match(html, /parent prompt/);
    assert.match(html, /Compare runs/);
  });

  it("renderHTML works with agentHistory on session (field not required; cache ignores it)", () => {
    const sessionPath = "/tmp/render-agent-surface.jsonl";
    const base = {
      ...parsedParentSession(sessionPath),
      sessionId: "render-agent-surface",
    };
    const withHistory = {
      ...base,
      agentHistory: [
        {
          agentId: "scout",
          path: "/tmp/subagents/scout.jsonl",
          lineIndex: 0,
          record: { type: "assistant", text: SIDECAR_MARKER },
          timestampMs: Date.parse("2026-06-03T00:00:01.000Z"),
        },
      ],
      agentSidecarCount: 1,
    };

    const htmlBase = renderHTML(base);
    assert.ok(htmlBase.startsWith("<!DOCTYPE html>"));
    assert.match(htmlBase, /const SESSION = /);
    assert.match(htmlBase, /parent prompt/);
    assert.doesNotMatch(htmlBase, new RegExp(SIDECAR_MARKER));
    const inlinedBase = parseInlinedSession(htmlBase);
    assert.equal(inlinedBase.agentHistory, undefined);
    assert.equal(inlinedBase.agentSidecarCount, undefined);

    const htmlWith = renderHTML(withHistory);
    assert.ok(htmlWith.startsWith("<!DOCTYPE html>"));
    assert.match(htmlWith, /parent prompt/);
    assert.doesNotMatch(htmlWith, /agent-sidecar|Agent history/i);
    const inlinedWith = parseInlinedSession(htmlWith);
    assert.equal(inlinedWith.agentHistory, undefined);
    assert.equal(inlinedWith.agentSidecarCount, undefined);
    // renderCacheKey ignores agentHistory: optional field does not bust cache
    assert.strictEqual(htmlWith, htmlBase);
  });

  it("generateMarkdown does not render agentHistory even when present on session", () => {
    const session = {
      ...parsedParentSession("/tmp/parent.jsonl"),
      agentHistory: [
        {
          agentId: "scout",
          path: "/tmp/subagents/scout.jsonl",
          lineIndex: 0,
          record: { type: "assistant", text: SIDECAR_MARKER },
          timestampMs: Date.parse("2026-06-03T00:00:01.000Z"),
        },
      ],
      agentSidecarCount: 1,
    };

    const md = generateMarkdown(session);
    assert.doesNotMatch(md, new RegExp(SIDECAR_MARKER));
    assert.doesNotMatch(md, /agentHistory|Agent history/i);
    assert.match(md, /parent prompt/);
    assert.match(md, /## Summary/);
  });

  it("cursor agentHistory with null timestamps renders without Invalid Date or epoch times", () => {
    const session = {
      ...parsedParentSession("/tmp/cursor-agent-surface.jsonl"),
      sessionId: "cursor-agent-surface",
      source: "cursor",
      agentHistory: [
        {
          agentId: "sub-agent-1",
          path: "/tmp/subagents/sub-agent-1.jsonl",
          lineIndex: 0,
          record: { type: "user", timestamp: null, text: SIDECAR_MARKER },
          timestampMs: null,
        },
        {
          agentId: "sub-agent-1",
          path: "/tmp/subagents/sub-agent-1.jsonl",
          lineIndex: 1,
          record: { type: "assistant", timestamp: null, text: "cursor reply", toolCalls: [] },
          timestampMs: null,
        },
      ],
      agentSidecarCount: 1,
    };

    const html = renderHTML(session);
    assert.ok(html.startsWith("<!DOCTYPE html>"));
    assert.doesNotMatch(html, /Invalid Date/);
    assert.doesNotMatch(html, /1970-01-01/);
    // Sidecar metadata stays server-side: no fabricated history entries leak into the viewer
    const inlined = parseInlinedSession(html);
    assert.equal(inlined.agentHistory, undefined);
    assert.equal(inlined.agentSidecarCount, undefined);
  });

  it("only fetchSession merges agentHistory in server src", () => {
    const serverHelpers = fs.readFileSync(
      path.join(process.cwd(), "src/server/server-helpers.js"),
      "utf8",
    );
    assert.match(serverHelpers, /session\.agentHistory = agentHistory/);
    const srcRoot = path.join(process.cwd(), "src");
    const offenders = [];
    for (const rel of ["browser/compare-page.js", "export/markdown-export.js", "chapters/compare-metrics.js"]) {
      const text = fs.readFileSync(path.join(srcRoot, rel.replace(/^src\//, "")), "utf8");
      if (/agentHistory/.test(text)) offenders.push(rel);
    }
    assert.deepEqual(offenders, [], "compare/markdown must not reference agentHistory until wired");
  });
});