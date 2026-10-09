/**
 * End-to-end compare pipeline: two minimal Claude JSONL fixtures → parseSession →
 * comparePage. No network; uses temp files only.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseSession } from "../src/parse.js";
import { comparePage } from "../src/browser/compare-page.js";
import { COMPARE_METRIC_LABELS, GRADE_COLUMN_LABELS } from "../src/chapters/compare-metrics.js";
import { sessionHash } from "../src/sessions/session-hash.js";
import {
  CLAUDE_FIXTURE_CWD,
  CLAUDE_FIXTURE_MODEL,
  writeClaudeJsonl,
} from "./helpers/fixtures.js";

const SESSION_A_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const SESSION_B_ID = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
const FIXTURE_CWD = CLAUDE_FIXTURE_CWD;
const FIXTURE_MODEL = CLAUDE_FIXTURE_MODEL;

/** Session A: one clean chapter, low errors, Bash-heavy tools. */
function sessionAJsonlLines() {
  return [
    {
      type: "user",
      sessionId: SESSION_A_ID,
      cwd: FIXTURE_CWD,
      gitBranch: "anneal/compare-a",
      timestamp: "2026-06-02T10:00:00.000Z",
      uuid: "u-compare-a-0",
      isMeta: false,
      message: { content: [{ type: "text", text: "Run integration compare for session A" }] },
    },
    {
      type: "assistant",
      sessionId: SESSION_A_ID,
      timestamp: "2026-06-02T10:00:05.000Z",
      uuid: "a-compare-a-0",
      message: {
        model: FIXTURE_MODEL,
        stop_reason: "end_turn",
        usage: { input_tokens: 200, output_tokens: 60, cache_read_input_tokens: 80 },
        content: [
          { type: "text", text: "Running compare pipeline test for session A." },
          {
            type: "tool_use",
            id: "tool-bash-a1",
            name: "Bash",
            input: { command: "npm test -- test/integration-compare.test.js" },
          },
          {
            type: "tool_use",
            id: "tool-bash-a2",
            name: "Bash",
            input: { command: "git status" },
          },
        ],
      },
    },
    {
      type: "user",
      sessionId: SESSION_A_ID,
      timestamp: "2026-06-02T10:00:10.000Z",
      uuid: "u-compare-a-tr-0",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-bash-a1",
            content: [{ type: "text", text: "ok" }],
          },
          {
            type: "tool_result",
            tool_use_id: "tool-bash-a2",
            content: [{ type: "text", text: "clean" }],
          },
        ],
      },
    },
  ];
}

/** Session B: struggling chapter (errors), fewer tools, higher token use. */
function sessionBJsonlLines() {
  return [
    {
      type: "user",
      sessionId: SESSION_B_ID,
      cwd: FIXTURE_CWD,
      gitBranch: "anneal/compare-b",
      timestamp: "2026-06-02T11:00:00.000Z",
      uuid: "u-compare-b-0",
      isMeta: false,
      message: { content: [{ type: "text", text: "Integration compare session B with failures" }] },
    },
    {
      type: "assistant",
      sessionId: SESSION_B_ID,
      timestamp: "2026-06-02T11:00:08.000Z",
      uuid: "a-compare-b-0",
      message: {
        model: FIXTURE_MODEL,
        stop_reason: "end_turn",
        usage: { input_tokens: 500, output_tokens: 120 },
        content: [
          { type: "text", text: "Retrying after tool failures in session B." },
          {
            type: "tool_use",
            id: "tool-read-b1",
            name: "Read",
            input: { file_path: "/home/dev/tracequest/missing.js" },
          },
          {
            type: "tool_use",
            id: "tool-bash-b1",
            name: "Bash",
            input: { command: "false" },
          },
          {
            type: "tool_use",
            id: "tool-bash-b2",
            name: "Bash",
            input: { command: "false" },
          },
        ],
      },
    },
    {
      type: "user",
      sessionId: SESSION_B_ID,
      timestamp: "2026-06-02T11:00:12.000Z",
      uuid: "u-compare-b-tr-0",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-read-b1",
            content: [{ type: "text", text: "ENOENT" }],
            is_error: true,
          },
          {
            type: "tool_result",
            tool_use_id: "tool-bash-b1",
            content: [{ type: "text", text: "exit 1" }],
            is_error: true,
          },
          {
            type: "tool_result",
            tool_use_id: "tool-bash-b2",
            content: [{ type: "text", text: "exit 1" }],
            is_error: true,
          },
        ],
      },
    },
  ];
}

function assertMetricTable(html) {
  assert.match(html, /<table class="cmp-table">/);
  assert.match(html, /cmp-section-title">Metrics/);
  assert.match(html, /cmp-col-a/);
  assert.match(html, /cmp-col-b/);
  for (const label of COMPARE_METRIC_LABELS) {
    assert.match(html, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
}

function assertGradeColumns(html) {
  for (const label of GRADE_COLUMN_LABELS) {
    assert.match(html, new RegExp(`cmp-label">${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}<`));
  }
}

function assertViewLinks(html, pathA, pathB) {
  assert.match(html, new RegExp(`href="/view\\?id=${sessionHash(pathA)}"`));
  assert.match(html, new RegExp(`href="/view\\?id=${sessionHash(pathB)}"`));
  assert.equal((html.match(/View full session/g) || []).length, 2);
  assert.equal((html.match(/href="\/view\?id=[0-9a-f]{8}/g) || []).length, 2);
}

describe("integration compare (parse ×2 → comparePage)", () => {
  test("two fixture sessions produce compare HTML with metrics, grades, and view links", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-compare-"));
    try {
      const pathA = writeClaudeJsonl(tmpDir, "compare-session-a.jsonl", sessionAJsonlLines());
      const pathB = writeClaudeJsonl(tmpDir, "compare-session-b.jsonl", sessionBJsonlLines());

      const sessionA = parseSession(pathA, "claude");
      const sessionB = parseSession(pathB, "claude");
      sessionA._path = pathA;
      sessionB._path = pathB;

      assert.equal(sessionA.sessionId, SESSION_A_ID);
      assert.equal(sessionB.sessionId, SESSION_B_ID);
      assert.ok(sessionA.stats.toolCounts.Bash >= 2, "session A should record Bash tools");
      assert.ok(sessionB.stats.errors >= 3, "session B should record tool errors");
      assert.ok(
        sessionA.events.some((e) => e.text?.includes("integration compare")),
        "session A prompt survives parse",
      );
      assert.ok(
        sessionB.events.some((e) => e.text?.includes("session B")),
        "session B prompt survives parse",
      );

      const html = comparePage(sessionA, sessionB);

      assert.equal(typeof html, "string");
      assert.ok(html.startsWith("<!DOCTYPE html>"));
      assert.match(html, /Compare runs/);
      assert.match(html, /session-a/);
      assert.match(html, /session-b/);
      assert.match(html, new RegExp(sessionHash(pathA)));
      assert.match(html, new RegExp(sessionHash(pathB)));
      assert.match(html, /integration compare/i);
      assert.match(html, /session B/i);

      assertMetricTable(html);
      assertGradeColumns(html);
      assertViewLinks(html, pathA, pathB);

      const strugglingRow = html.match(
        /<td class="cmp-label">Struggling chapters<\/td>\s*<td data-side="a" class="cmp-val[^>]*>(\d+)<\/td>\s*<td data-side="b" class="cmp-val[^>]*>(\d+)<\/td>/,
      );
      assert.ok(strugglingRow, "grade row should show struggling counts");
      assert.equal(Number(strugglingRow[1]), 0, "session A should have no struggling chapters");
      assert.ok(Number(strugglingRow[2]) >= 1, "session B should have struggling chapters");

      assert.match(html, /cmp-outcome-seg/);
      assert.match(html, /chapter quality/i);
      assert.match(html, /tool-cmp-row/);
      assert.match(html, /Bash/);
      assert.match(html, /delta-good|delta-bad/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("compare pipeline preserves distinct session paths in view URLs", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-compare-paths-"));
    try {
      const pathA = writeClaudeJsonl(tmpDir, "a.jsonl", sessionAJsonlLines());
      const pathB = writeClaudeJsonl(tmpDir, "nested/b.jsonl", sessionBJsonlLines());

      const sessionA = parseSession(pathA, "claude");
      const sessionB = parseSession(pathB, "claude");
      sessionA._path = pathA;
      sessionB._path = pathB;

      const html = comparePage(sessionA, sessionB);
      assertViewLinks(html, pathA, pathB);
      assert.doesNotMatch(html, /href="\/view\?path=.*source=/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
