/**
 * End-to-end pipeline: minimal fixtures (Claude JSONL, Codex JSONL, OpenCode DB)
 * → parseSession → buildSessionChapters → renderHTML | comparePage | generateMarkdown.
 * No network; uses temp files only.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseSession } from "../src/parse.js";
import { buildSessionChapters } from "../src/chapters/session-chapters.js";
import { summarizeChapterQuality } from "../src/chapters/chapter-quality.js";
import { COMPARE_METRIC_LABELS } from "../src/chapters/compare-metrics.js";
import { renderHTML } from "../src/render.js";

import { comparePage } from "../src/browser/compare-page.js";
import { generateMarkdown, buildMarkdownHeader } from "../src/export/markdown-export.js";
import { resolveOpenCodeDbPath } from "../src/sessions/session-discovery-paths.js";
import { sessionHash } from "../src/sessions/session-hash.js";
import {
  CLAUDE_FIXTURE_CWD,
  CLAUDE_FIXTURE_MODEL,
  writeClaudeJsonl,
  writeJsonl,
} from "./helpers/fixtures.js";

const PIPELINE_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const PIPELINE_SESSION_B_ID = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
const PIPELINE_CODEX_SESSION_ID = "codex-pipe-aaaa-bbbb-cccc-dddd-eeeeeeee";
const PIPELINE_CODEX_B_ID = "codex-pipe-bbbb-cccc-dddd-eeee-ffffffff";
const PIPELINE_OPENCODE_A = "oc-pipeline-aaaaaaaa";
const PIPELINE_OPENCODE_B = "oc-pipeline-bbbbbbbb";
const PIPELINE_FACTORY_SESSION_ID = "factory-pipe-aaaa-bbbb-cccc-dddd-eeee";
const PIPELINE_FACTORY_B_ID = "factory-pipe-bbbb-cccc-dddd-eeee-ffffffff";
const FACTORY_FIXTURE_MODEL = "claude-sonnet-4-20250514";
const CODEX_FIXTURE_MODEL = "openai";
const OPENCODE_FIXTURE_MODEL = "gpt-5-codex";
const FIXTURE_CWD = CLAUDE_FIXTURE_CWD;
const FIXTURE_MODEL = CLAUDE_FIXTURE_MODEL;
const OC_T0 = Date.parse("2026-06-01T10:00:00.000Z");
const OC_T1 = Date.parse("2026-06-01T10:00:05.000Z");
const OC_T2 = Date.parse("2026-06-01T10:00:10.000Z");
const OC_T3 = Date.parse("2026-06-01T10:00:20.000Z");
const OC_T4 = Date.parse("2026-06-01T10:00:25.000Z");
const TS0 = "2026-06-01T10:00:00.000Z";
const TS1 = "2026-06-01T10:00:05.000Z";
const TS2 = "2026-06-01T10:00:10.000Z";
const TS3 = "2026-06-01T10:00:20.000Z";
const TS4 = "2026-06-01T10:00:25.000Z";

/** Minimal Claude Code JSONL lines exercising user, assistant, tools, and two chapters. */
function claudeJsonlLines() {
  return [
    {
      type: "user",
      sessionId: PIPELINE_SESSION_ID,
      cwd: FIXTURE_CWD,
      gitBranch: "anneal/integration",
      timestamp: TS0,
      uuid: "u-pipeline-0",
      isMeta: false,
      message: { content: [{ type: "text", text: "Add integration pipeline test" }] },
    },
    {
      type: "assistant",
      sessionId: PIPELINE_SESSION_ID,
      timestamp: TS1,
      uuid: "a-pipeline-0",
      message: {
        model: FIXTURE_MODEL,
        stop_reason: "end_turn",
        usage: { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 30 },
        content: [
          { type: "text", text: "I will add the test and run npm test." },
          {
            type: "tool_use",
            id: "tool-bash-1",
            name: "Bash",
            input: { command: "npm test -- test/integration-pipeline.test.js" },
          },
        ],
      },
    },
    {
      type: "user",
      sessionId: PIPELINE_SESSION_ID,
      timestamp: TS2,
      uuid: "u-pipeline-tr-0",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-bash-1",
            content: [{ type: "text", text: "438 tests green" }],
          },
        ],
      },
    },
    {
      type: "user",
      sessionId: PIPELINE_SESSION_ID,
      timestamp: TS3,
      uuid: "u-pipeline-1",
      isMeta: false,
      message: { content: [{ type: "text", text: "Verify chapter structure in HTML" }] },
    },
    {
      type: "assistant",
      sessionId: PIPELINE_SESSION_ID,
      timestamp: TS4,
      uuid: "a-pipeline-1",
      message: {
        model: FIXTURE_MODEL,
        stop_reason: "end_turn",
        usage: { input_tokens: 80, output_tokens: 20 },
        content: [
          { type: "text", text: "Chapters embed via buildSessionChapters in the viewer bundle." },
          {
            type: "tool_use",
            id: "tool-read-1",
            name: "Read",
            input: { file_path: "/home/dev/tracequest/src/chapters/session-chapters.js" },
          },
        ],
      },
    },
    {
      type: "user",
      sessionId: PIPELINE_SESSION_ID,
      timestamp: TS4,
      uuid: "u-pipeline-tr-1",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-read-1",
            content: [{ type: "text", text: "ENOENT: no such file" }],
            is_error: true,
          },
        ],
      },
    },
  ];
}

/** Variant B: one struggling chapter with Read/Bash errors for compare deltas. */
function claudeJsonlVariantBLines() {
  return [
    {
      type: "user",
      sessionId: PIPELINE_SESSION_B_ID,
      cwd: FIXTURE_CWD,
      gitBranch: "anneal/integration-b",
      timestamp: "2026-06-01T11:00:00.000Z",
      uuid: "u-pipeline-b-0",
      isMeta: false,
      message: { content: [{ type: "text", text: "Pipeline variant B with tool failures" }] },
    },
    {
      type: "assistant",
      sessionId: PIPELINE_SESSION_B_ID,
      timestamp: "2026-06-01T11:00:08.000Z",
      uuid: "a-pipeline-b-0",
      message: {
        model: FIXTURE_MODEL,
        stop_reason: "end_turn",
        usage: { input_tokens: 400, output_tokens: 90 },
        content: [
          { type: "text", text: "Retrying after failures in pipeline variant B." },
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
        ],
      },
    },
    {
      type: "user",
      sessionId: PIPELINE_SESSION_B_ID,
      timestamp: "2026-06-01T11:00:12.000Z",
      uuid: "u-pipeline-b-tr-0",
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
        ],
      },
    },
  ];
}

function parsePipelineFixture(dir, name = "pipeline-session.jsonl", lines = claudeJsonlLines()) {
  const filePath = writeClaudeJsonl(dir, name, lines);
  const session = parseSession(filePath, "claude");
  session._path = filePath;
  return session;
}

/** Minimal Codex rollout JSONL: two user chapters, Bash + Read tools, one tool error. */
function codexJsonlLines() {
  return [
    {
      type: "session_meta",
      payload: {
        id: PIPELINE_CODEX_SESSION_ID,
        cwd: FIXTURE_CWD,
        model_provider: CODEX_FIXTURE_MODEL,
        git: { branch: "anneal/codex-pipeline" },
      },
    },
    {
      type: "event_msg",
      timestamp: TS0,
      payload: { type: "user_message", message: "Add codex integration pipeline test" },
    },
    {
      type: "event_msg",
      timestamp: TS1,
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { input_tokens: 120, output_tokens: 40, cached_input_tokens: 30 },
        },
      },
    },
    {
      type: "event_msg",
      timestamp: TS1,
      payload: {
        type: "exec_command_end",
        call_id: "codex-bash-1",
        parsed_cmd: [{ cmd: "npm test -- test/integration-pipeline.test.js" }],
        aggregated_output: "438 tests green",
        exit_code: 0,
      },
    },
    {
      type: "response_item",
      timestamp: TS1,
      payload: {
        role: "assistant",
        content: [
          { type: "output_text", text: "Codex rollout will add the integration test." },
        ],
      },
    },
    {
      type: "event_msg",
      timestamp: TS3,
      payload: { type: "user_message", message: "Verify codex chapter structure in HTML" },
    },
    {
      type: "response_item",
      timestamp: TS4,
      payload: {
        type: "function_call",
        call_id: "codex-read-1",
        name: "read_file",
        arguments: JSON.stringify({ file_path: "/home/dev/tracequest/src/chapters/session-chapters.js" }),
      },
    },
    {
      type: "response_item",
      timestamp: TS4,
      payload: {
        type: "function_call_output",
        call_id: "codex-read-1",
        is_error: true,
        output: "Error: ENOENT no such file",
      },
    },
    {
      type: "response_item",
      timestamp: TS4,
      payload: {
        role: "assistant",
        content: [{ type: "output_text", text: "Read failed; chapters still render from parse." }],
      },
    },
  ];
}

/** Codex variant B: single chapter with Read + Bash errors for struggling compare metrics. */
function codexJsonlVariantBLines() {
  return [
    {
      type: "session_meta",
      payload: {
        id: PIPELINE_CODEX_B_ID,
        cwd: FIXTURE_CWD,
        model_provider: CODEX_FIXTURE_MODEL,
        git: { branch: "anneal/codex-pipeline-b" },
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-06-01T11:00:00.000Z",
      payload: { type: "user_message", message: "Codex pipeline variant B with tool failures" },
    },
    {
      type: "response_item",
      timestamp: "2026-06-01T11:00:08.000Z",
      payload: {
        type: "function_call",
        call_id: "codex-read-b1",
        name: "read_file",
        arguments: JSON.stringify({ file_path: "/home/dev/tracequest/missing.js" }),
      },
    },
    {
      type: "response_item",
      timestamp: "2026-06-01T11:00:09.000Z",
      payload: {
        type: "function_call_output",
        call_id: "codex-read-b1",
        is_error: true,
        output: "Error: ENOENT",
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-06-01T11:00:10.000Z",
      payload: {
        type: "exec_command_end",
        call_id: "codex-bash-b1",
        command: ["bash", "-lc", "false"],
        stderr: "exit 1",
        exit_code: 1,
      },
    },
    {
      type: "response_item",
      timestamp: "2026-06-01T11:00:12.000Z",
      payload: {
        role: "assistant",
        content: [{ type: "output_text", text: "Codex variant B retrying after tool failures." }],
      },
    },
  ];
}

function writeCodexJsonl(dir, name, lines) {
  const filePath = path.join(dir, name);
  writeJsonl(filePath, lines);
  return filePath;
}

function parseCodexPipelineFixture(dir, name = "codex-pipeline.jsonl", lines = codexJsonlLines()) {
  const filePath = writeCodexJsonl(dir, name, lines);
  const session = parseSession(filePath, "codex");
  session._path = filePath;
  return session;
}

async function seedPipelineOpenCodeDb(home, sessions) {
  const dbPath = resolveOpenCodeDbPath(home);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(
    `CREATE TABLE session (
      id TEXT PRIMARY KEY,
      title TEXT,
      directory TEXT,
      version TEXT,
      time_created INTEGER,
      time_updated INTEGER
    )`
  );
  db.exec(
    `CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      data TEXT,
      time_created INTEGER,
      time_updated INTEGER
    )`
  );
  db.exec(
    `CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      data TEXT,
      time_created INTEGER
    )`
  );

  const insS = db.prepare(
    `INSERT INTO session (id, title, directory, version, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insM = db.prepare(
    `INSERT INTO message (id, session_id, data, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?)`
  );
  const insP = db.prepare(
    `INSERT INTO part (id, message_id, data, time_created) VALUES (?, ?, ?, ?)`
  );

  for (const sess of sessions) {
    insS.run(sess.id, sess.title ?? sess.id, sess.directory ?? FIXTURE_CWD, "1.0", OC_T0, OC_T4);
    for (const msg of sess.messages ?? []) {
      const mid = msg.id;
      const created = msg.timeCreated ?? OC_T0;
      const data = {
        role: msg.role ?? "user",
        modelID: msg.modelID ?? OPENCODE_FIXTURE_MODEL,
        time: { created },
      };
      insM.run(mid, sess.id, JSON.stringify(data), created, created);
      for (const part of msg.parts ?? []) {
        insP.run(part.id, mid, JSON.stringify(part), part.timeCreated ?? created);
      }
    }
  }
  db.close();
}

function openCodePipelineSessionA() {
  return {
    id: PIPELINE_OPENCODE_A,
    title: "OpenCode pipeline A",
    messages: [
      {
        id: "oc-u0",
        role: "user",
        timeCreated: OC_T0,
        parts: [{ id: "oc-p0", type: "text", text: "Add opencode integration pipeline test" }],
      },
      {
        id: "oc-a0",
        role: "assistant",
        modelID: OPENCODE_FIXTURE_MODEL,
        timeCreated: OC_T1,
        parts: [
          { id: "oc-p1", type: "text", text: "Running npm test for opencode pipeline." },
          {
            id: "oc-p2",
            type: "tool",
            callID: "oc-bash-1",
            tool: "bash",
            state: {
              input: { command: "npm test -- test/integration-pipeline.test.js" },
              output: "438 tests green",
              status: "ok",
            },
          },
          {
            id: "oc-p3",
            type: "step-finish",
            tokens: { input: 120, output: 40, cache: { read: 30, write: 0 } },
          },
        ],
      },
      {
        id: "oc-u1",
        role: "user",
        timeCreated: OC_T3,
        parts: [{ id: "oc-p4", type: "text", text: "Verify opencode chapter structure in HTML" }],
      },
      {
        id: "oc-a1",
        role: "assistant",
        timeCreated: OC_T4,
        parts: [
          { id: "oc-p5", type: "text", text: "Read failed; chapters still render." },
          {
            id: "oc-p6",
            type: "tool",
            callID: "oc-read-1",
            tool: "read",
            state: {
              input: { file_path: "/home/dev/tracequest/src/chapters/session-chapters.js" },
              output: "Error: ENOENT no such file",
              status: "error",
            },
          },
        ],
      },
    ],
  };
}

function openCodePipelineSessionB() {
  return {
    id: PIPELINE_OPENCODE_B,
    title: "OpenCode pipeline B",
    messages: [
      {
        id: "oc-b-u0",
        role: "user",
        timeCreated: OC_T0,
        parts: [{ id: "oc-b-p0", type: "text", text: "OpenCode pipeline variant B with tool failures" }],
      },
      {
        id: "oc-b-a0",
        role: "assistant",
        timeCreated: OC_T1,
        parts: [
          { id: "oc-b-p1", type: "text", text: "OpenCode variant B after tool failures." },
          {
            id: "oc-b-p2",
            type: "tool",
            callID: "oc-read-b1",
            tool: "read",
            state: {
              input: { file_path: "/home/dev/tracequest/missing.js" },
              output: "Error: ENOENT",
              status: "error",
            },
          },
          {
            id: "oc-b-p3",
            type: "tool",
            callID: "oc-bash-b1",
            tool: "bash",
            state: { input: { command: "false" }, output: "exit 1", status: "error" },
          },
        ],
      },
    ],
  };
}

function withOpenCodePipeline(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-pipeline-oc-"));
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

/** Minimal Factory (Droid) JSONL: session_start + message roles, two chapters. */
function factoryJsonlLines() {
  return [
    {
      type: "session_start",
      id: PIPELINE_FACTORY_SESSION_ID,
      cwd: FIXTURE_CWD,
      gitBranch: "anneal/factory-pipeline",
      model: FACTORY_FIXTURE_MODEL,
    },
    {
      type: "message",
      id: "f-u0",
      timestamp: TS0,
      message: { role: "user", content: [{ type: "text", text: "Add factory integration pipeline test" }] },
    },
    {
      type: "message",
      id: "f-a0",
      timestamp: TS1,
      message: {
        role: "assistant",
        model: FACTORY_FIXTURE_MODEL,
        content: [
          { type: "text", text: "Factory rollout will add the integration test." },
          {
            type: "tool_use",
            id: "factory-bash-1",
            name: "Bash",
            input: { command: "npm test -- test/integration-pipeline.test.js" },
          },
        ],
      },
    },
    {
      type: "message",
      id: "f-tr0",
      timestamp: TS2,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "factory-bash-1",
            content: [{ type: "text", text: "438 tests green" }],
          },
        ],
      },
    },
    {
      type: "message",
      id: "f-u1",
      timestamp: TS3,
      message: { role: "user", content: [{ type: "text", text: "Verify factory chapter structure in HTML" }] },
    },
    {
      type: "message",
      id: "f-a1",
      timestamp: TS4,
      message: {
        role: "assistant",
        model: FACTORY_FIXTURE_MODEL,
        content: [
          { type: "text", text: "Read failed; chapters still render from parse." },
          {
            type: "tool_use",
            id: "factory-read-1",
            name: "Read",
            input: { file_path: "/home/dev/tracequest/src/chapters/session-chapters.js" },
          },
        ],
      },
    },
    {
      type: "message",
      id: "f-tr1",
      timestamp: TS4,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "factory-read-1",
            content: [{ type: "text", text: "ENOENT: no such file" }],
            is_error: true,
          },
        ],
      },
    },
  ];
}

function factoryJsonlVariantBLines() {
  return [
    {
      type: "session_start",
      id: PIPELINE_FACTORY_B_ID,
      cwd: FIXTURE_CWD,
      gitBranch: "anneal/factory-pipeline-b",
    },
    {
      type: "message",
      id: "f-b-u0",
      timestamp: "2026-06-01T11:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "Factory pipeline variant B with tool failures" }] },
    },
    {
      type: "message",
      id: "f-b-a0",
      timestamp: "2026-06-01T11:00:08.000Z",
      message: {
        role: "assistant",
        model: FACTORY_FIXTURE_MODEL,
        content: [
          { type: "text", text: "Factory variant B retrying after tool failures." },
          {
            type: "tool_use",
            id: "factory-read-b1",
            name: "Read",
            input: { file_path: "/home/dev/tracequest/missing.js" },
          },
          {
            type: "tool_use",
            id: "factory-bash-b1",
            name: "Bash",
            input: { command: "false" },
          },
        ],
      },
    },
    {
      type: "message",
      id: "f-b-tr0",
      timestamp: "2026-06-01T11:00:12.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "factory-read-b1",
            content: [{ type: "text", text: "ENOENT" }],
            is_error: true,
          },
          {
            type: "tool_result",
            tool_use_id: "factory-bash-b1",
            content: [{ type: "text", text: "exit 1" }],
            is_error: true,
          },
        ],
      },
    },
  ];
}

function writeFactoryJsonl(dir, name, lines) {
  const filePath = path.join(dir, name);
  writeJsonl(filePath, lines);
  return filePath;
}

function parseFactoryPipelineFixture(dir, name = "factory-pipeline.jsonl", lines = factoryJsonlLines()) {
  const filePath = writeFactoryJsonl(dir, name, lines);
  const session = parseSession(filePath, "factory");
  session._path = filePath;
  return session;
}

function parseOpenCodePipelineFixture(sessionId) {
  const uri = `opencode://${sessionId}`;
  const session = parseSession(uri, "opencode");
  session._path = uri;
  return session;
}

function expectedSessionDisplayId(session) {
  return session.sessionHash || (session.path ? sessionHash(session.path) : "") || session.sessionId?.slice(0, 8) || "session";
}

function assertCompareShell(html, sessionA, sessionB) {
  assert.equal(typeof html, "string");
  assert.ok(html.startsWith("<!DOCTYPE html>"));
  assert.match(html, /Compare runs/);
  assert.match(html, /session-a/);
  assert.match(html, /session-b/);
  assert.match(html, new RegExp(expectedSessionDisplayId(sessionA)));
  assert.match(html, new RegExp(expectedSessionDisplayId(sessionB)));
  assert.match(html, /<table class="cmp-table">/);
  assert.match(html, /cmp-section-title">Metrics/);
  for (const label of COMPARE_METRIC_LABELS) {
    assert.match(html, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(html, /cmp-outcome-seg/);
  assert.match(html, /chapter quality/i);
}

/** Parse inlined SESSION JSON from renderHTML output (viewer boot payload). */
function parseInlinedSession(html) {
  const marker = "const SESSION = ";
  const start = html.indexOf(marker);
  assert.ok(start >= 0, "renderHTML should embed const SESSION");
  const jsonStart = start + marker.length;
  const jsonEnd = html.indexOf(";\n", jsonStart);
  assert.ok(jsonEnd > jsonStart, "SESSION JSON should terminate before bundle script");
  return JSON.parse(html.slice(jsonStart, jsonEnd));
}

/**
 * Outcome checks on rendered viewer HTML: title prefix, full session id in payload,
 * and chapter count derived from the same inlined session the browser uses.
 */
function assertRenderedViewerHtml(html, { sessionId, chapterCount, source, promptSnippet }) {
  assert.ok(html.startsWith("<!DOCTYPE html>"), "viewer should be a full HTML document");
  const inlined = parseInlinedSession(html);
  assert.match(html, new RegExp(`<title>tracequest — ${expectedSessionDisplayId(inlined)}`));
  assert.equal(inlined.sessionId, sessionId, "inlined SESSION.sessionId");
  if (source !== undefined) assert.equal(inlined.source, source);
  assert.equal(buildSessionChapters(inlined).length, chapterCount, "chapter count from inlined SESSION");
  if (promptSnippet) {
    assert.ok(
      inlined.events.some((e) => e.type === "user" && e.text?.includes(promptSnippet)),
      `inlined SESSION should retain user prompt containing ${promptSnippet}`,
    );
  }
}

function assertCompareViewLinks(html, pathA, pathB, { sourceA, sourceB } = {}) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const qA = sourceA ? `&source=${sourceA}` : "";
  const qB = sourceB ? `&source=${sourceB}` : "";
  assert.match(html, new RegExp(`href="/view\\?id=${esc(sessionHash(pathA))}${qA}"`));
  assert.match(html, new RegExp(`href="/view\\?id=${esc(sessionHash(pathB))}${qB}"`));
  assert.equal((html.match(/View full session/g) || []).length, 2);
}

function assertChapterShape(ch, idx) {
  assert.ok(ch.prompt, `chapter ${idx} should have prompt`);
  assert.ok(ch.timestamp, `chapter ${idx} should have timestamp`);
  assert.equal(typeof ch.turns, "number");
  assert.ok(ch.toolCounts && typeof ch.toolCounts === "object");
  assert.ok(ch.tokens && typeof ch.tokens.input === "number");
  assert.equal(typeof ch.retries, "number");
  assert.ok(["clean", "corrected", "struggling"].includes(ch.outcome));
  assert.equal(ch.efficiency, undefined, "efficiency deferred to HTML render pipeline");
  assert.equal(ch._callSeq, undefined, "quality enrichment strips _callSeq before render");
}

describe("integration pipeline (parse → chapters → render)", () => {
  test("minimal claude jsonl runs full pipeline without network", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-pipeline-"));
    try {
      const filePath = writeClaudeJsonl(tmpDir, "pipeline-session.jsonl", claudeJsonlLines());
      const session = parseSession(filePath, "claude");

      assert.equal(session.source, "claude");
      assert.equal(session.sessionId, PIPELINE_SESSION_ID);
      assert.equal(session.cwd, FIXTURE_CWD);
      assert.equal(session.gitBranch, "anneal/integration");
      assert.equal(session.model, FIXTURE_MODEL);
      assert.ok(session.events.length >= 5, "fixture should yield user, assistant, and tool events");
      assert.ok(
        session.events.some((e) => e.type === "user" && e.text.includes("integration pipeline")),
        "parsed user prompt should survive parseClaude"
      );
      assert.ok(
        session.events.some((e) => e.type === "assistant" && e.toolCalls?.length),
        "assistant tool calls should be enriched"
      );
      assert.ok(session.stats.userMessages >= 2);
      assert.ok(session.stats.toolCounts.Bash >= 1 || session.stats.toolCounts.Read >= 1);

      const chapters = buildSessionChapters(session);
      assert.equal(chapters.length, 2, "two user prompts → two chapters");
      assertChapterShape(chapters[0], 0);
      assertChapterShape(chapters[1], 1);
      assert.match(chapters[0].prompt, /integration pipeline/i);
      assert.match(chapters[1].prompt, /chapter structure/i);
      assert.ok(chapters[0].toolCounts.Bash >= 1, "first chapter should record Bash");
      assert.ok(chapters[1].toolCounts.Read >= 1, "second chapter should record Read");
      assert.ok(chapters[1].errors >= 1, "failed Read should increment chapter errors");
      assert.ok(chapters[0].tokens.input > 0, "token rollup from assistant usage");

      const quality = summarizeChapterQuality(chapters);
      assert.equal(quality.chapters, 2);
      assert.equal(quality.clean + quality.corrected + quality.struggling, 2);

      const html = renderHTML(session);
      assertRenderedViewerHtml(html, {
        sessionId: PIPELINE_SESSION_ID,
        chapterCount: 2,
        source: "claude",
        promptSnippet: "integration pipeline",
      });
      assert.ok(html.includes(FIXTURE_MODEL), "model should appear in inlined SESSION");
      assert.ok(html.includes("chapter-permalink") && html.includes("filter-search"), "chapter UI hooks");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("pipeline chapters align event order and timestamps with parsed session", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-pipeline-order-"));
    try {
      const session = parseSession(writeClaudeJsonl(tmpDir, "pipeline-session.jsonl", claudeJsonlLines()), "claude");
      const chapters = buildSessionChapters(session);
      const userEvents = session.events.filter((e) => e.type === "user" && e.text);
      assert.equal(chapters.length, userEvents.length);
      for (let i = 0; i < chapters.length; i++) {
        assert.equal(chapters[i].timestamp, userEvents[i].timestamp);
        assert.ok(chapters[i].prompt.includes(userEvents[i].text.slice(0, 24)));
      }
      assert.ok(chapters[0].endTimestamp >= chapters[0].timestamp);
      assert.ok(chapters[1].endTimestamp >= chapters[1].timestamp);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("renderHTML cache key changes when pipeline fixture gains another event", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-pipeline-cache-"));
    try {
      const session = parseSession(writeClaudeJsonl(tmpDir, "pipeline-session.jsonl", claudeJsonlLines()), "claude");
      const html1 = renderHTML(session);
      session.events.push({
        type: "user",
        text: "post-render tail event",
        timestamp: "2026-06-01T10:01:00.000Z",
      });
      session.eventCount = session.events.length;
      const html2 = renderHTML(session);
      assert.notStrictEqual(html1, html2);
      assert.ok(html2.includes("post-render tail event"));
      const chapters = buildSessionChapters(session);
      assert.equal(chapters.length, 3);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("integration pipeline comparePage branch (parse ×2 → comparePage)", () => {
  test("pipeline fixture A vs variant B renders compare metrics and view links", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-pipeline-cmp-"));
    try {
      const sessionA = parsePipelineFixture(tmpDir, "pipeline-a.jsonl");
      const sessionB = parsePipelineFixture(tmpDir, "pipeline-b.jsonl", claudeJsonlVariantBLines());

      assert.equal(sessionA.sessionId, PIPELINE_SESSION_ID);
      assert.equal(sessionB.sessionId, PIPELINE_SESSION_B_ID);
      assert.equal(buildSessionChapters(sessionA).length, 2);
      assert.equal(buildSessionChapters(sessionB).length, 1);
      assert.ok(sessionB.stats.errors >= 2, "variant B should record tool errors");

      const html = comparePage(sessionA, sessionB);
      assertCompareShell(html, sessionA, sessionB);
      assertCompareViewLinks(html, sessionA._path, sessionB._path);
      assert.match(html, /integration pipeline/i);
      assert.match(html, /variant B/i);
      assert.match(html, /tool-cmp-row/);
      assert.match(html, /Bash/);
      assert.match(html, /delta-good|delta-bad/);

      const strugglingRow = html.match(
        /<td class="cmp-label">Struggling chapters<\/td>\s*<td data-side="a" class="cmp-val[^>]*>(\d+)<\/td>\s*<td data-side="b" class="cmp-val[^>]*>(\d+)<\/td>/,
      );
      assert.ok(strugglingRow, "compare should show struggling chapter counts");
      assert.equal(Number(strugglingRow[1]), 0, "pipeline A has no struggling chapters");
      assert.ok(Number(strugglingRow[2]) >= 1, "variant B should have struggling chapters");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("comparePage self-compare on pipeline fixture preserves equal chapter metrics", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-pipeline-self-cmp-"));
    try {
      const session = parsePipelineFixture(tmpDir);
      const html = comparePage(session, { ...session, sessionId: session.sessionId });

      assertCompareShell(html, session, session);
      assertCompareViewLinks(html, session._path, session._path);

      const chaptersRow = html.match(
        /<td class="cmp-label">Chapters<\/td>\s*<td data-side="a" class="cmp-val[^>]*>(\d+)<\/td>\s*<td data-side="b" class="cmp-val[^>]*>(\d+)<\/td>/,
      );
      assert.ok(chaptersRow, "chapters row should be present");
      assert.equal(chaptersRow[1], chaptersRow[2], "self-compare chapter counts should match");
      assert.equal(Number(chaptersRow[1]), 2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("comparePage nested path B preserves distinct view URLs", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-pipeline-cmp-paths-"));
    try {
      const sessionA = parsePipelineFixture(tmpDir, "a.jsonl");
      const sessionB = parsePipelineFixture(tmpDir, "nested/b.jsonl", claudeJsonlVariantBLines());
      const html = comparePage(sessionA, sessionB);

      assertCompareViewLinks(html, sessionA._path, sessionB._path);
      assert.doesNotMatch(html, /href="\/view\?path=.*source=/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("integration pipeline markdown export branch (parse → generateMarkdown)", () => {
  test("generateMarkdown from pipeline fixture includes header, two chapters, footer", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-pipeline-md-"));
    try {
      const session = parseSession(writeClaudeJsonl(tmpDir, "pipeline-session.jsonl", claudeJsonlLines()), "claude");
      const md = generateMarkdown(session);

      assert.match(md, new RegExp(`^# Session ${expectedSessionDisplayId(session)}`));
      assert.match(md, new RegExp(`\\*\\*Model:\\*\\* ${FIXTURE_MODEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.match(md, /\*\*Source:\*\* claude/);
      assert.match(md, /\*\*Branch:\*\* `anneal\/integration`/);
      assert.match(md, /## Summary/);
      assert.match(md, /\*\*Prompts:\*\* 2/);
      assert.match(md, /## Chapter 1/);
      assert.match(md, /## Chapter 2/);
      assert.match(md, /Exported from \[tracequest\]/);

      const summaryIdx = md.indexOf("## Summary");
      const ch1Idx = md.indexOf("## Chapter 1");
      const footerIdx = md.indexOf("Exported from [tracequest]");
      assert.ok(summaryIdx >= 0 && ch1Idx > summaryIdx && footerIdx > ch1Idx);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("markdown chapter prompts align with buildSessionChapters from same parse", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-pipeline-md-ch-"));
    try {
      const session = parseSession(writeClaudeJsonl(tmpDir, "pipeline-session.jsonl", claudeJsonlLines()), "claude");
      const chapters = buildSessionChapters(session);
      const md = generateMarkdown(session);

      for (let i = 0; i < chapters.length; i++) {
        const snippet = chapters[i].prompt.slice(0, 32).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        assert.match(md, new RegExp(`## Chapter ${i + 1}[\\s\\S]*> [^\\n]*${snippet}`));
      }
      assert.match(md, /> Add integration pipeline test/);
      assert.match(md, /> Verify chapter structure in HTML/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("markdown export records Read error and Bash command from pipeline chapters", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-pipeline-md-tools-"));
    try {
      const session = parseSession(writeClaudeJsonl(tmpDir, "pipeline-session.jsonl", claudeJsonlLines()), "claude");
      const chapters = buildSessionChapters(session);
      const md = generateMarkdown(session);

      assert.ok(chapters[1].errors >= 1);
      const ch2Start = md.indexOf("## Chapter 2");
      const ch2Body = md.slice(ch2Start, md.indexOf("---", ch2Start + 1));
      assert.match(ch2Body, /ENOENT|no such file|Read/i);
      assert.match(md, /npm test -- test\/integration-pipeline\.test\.js/);
      assert.match(md, /session-chapters\.js/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("buildMarkdownHeader summary matches parsed pipeline stats", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-pipeline-md-hdr-"));
    try {
      const session = parseSession(writeClaudeJsonl(tmpDir, "pipeline-session.jsonl", claudeJsonlLines()), "claude");
      const header = buildMarkdownHeader(session).join("\n");
      const totalTools = Object.values(session.stats.toolCounts).reduce((a, b) => a + b, 0);

      assert.match(header, /\*\*Prompts:\*\* 2/);
      assert.match(header, new RegExp(`\\*\\*Tool calls:\\*\\* ${totalTools}`));
      assert.ok(session.stats.totalInputTokens + session.stats.totalOutputTokens > 0);
      assert.match(header, /\*\*Tokens:\*\*/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("integration pipeline unified outputs (parse → chapters → render | compare | markdown)", () => {
  test("single parse feeds renderHTML, comparePage, and generateMarkdown consistently", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-pipeline-unified-"));
    try {
      const sessionA = parsePipelineFixture(tmpDir, "unified-a.jsonl");
      const sessionB = parsePipelineFixture(tmpDir, "unified-b.jsonl", claudeJsonlVariantBLines());
      const chapters = buildSessionChapters(sessionA);
      const html = renderHTML(sessionA);
      const cmp = comparePage(sessionA, sessionB);
      const md = generateMarkdown(sessionA);

      assert.equal(chapters.length, 2);
      assertRenderedViewerHtml(html, {
        sessionId: PIPELINE_SESSION_ID,
        chapterCount: 2,
        source: "claude",
        promptSnippet: "integration pipeline",
      });
      assert.ok(cmp.includes(expectedSessionDisplayId(sessionA)));
      assert.ok(md.includes("integration pipeline"));
      assert.equal((md.match(/^## Chapter /gm) || []).length, 2);
      assert.ok(cmp.includes("variant B"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("integration pipeline codex jsonl branch (parse → chapters → render | compare | markdown)", () => {
  test("minimal codex rollout runs full pipeline without network", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-pipeline-codex-"));
    try {
      const session = parseCodexPipelineFixture(tmpDir);

      assert.equal(session.source, "codex");
      assert.equal(session.sessionId, PIPELINE_CODEX_SESSION_ID);
      assert.equal(session.cwd, FIXTURE_CWD);
      assert.equal(session.gitBranch, "anneal/codex-pipeline");
      assert.equal(session.model, CODEX_FIXTURE_MODEL);
      assert.ok(session.events.some((e) => e.type === "user" && /codex integration pipeline/i.test(e.text)));
      assert.ok(session.stats.toolCounts.Bash >= 1);

      const chapters = buildSessionChapters(session);
      assert.equal(chapters.length, 2);
      assertChapterShape(chapters[0], 0);
      assertChapterShape(chapters[1], 1);
      assert.ok(chapters[0].toolCounts.Bash >= 1);
      assert.ok(chapters[1].errors >= 1, "failed Read should increment chapter errors");

      const html = renderHTML(session);
      assertRenderedViewerHtml(html, {
        sessionId: PIPELINE_CODEX_SESSION_ID,
        chapterCount: 2,
        source: "codex",
        promptSnippet: "codex integration pipeline",
      });

      const md = generateMarkdown(session);
      assert.match(md, /\*\*Source:\*\* codex/);
      assert.match(md, /## Chapter 1/);
      assert.match(md, /## Chapter 2/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("codex pipeline A vs variant B comparePage shows struggling delta", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-pipeline-codex-cmp-"));
    try {
      const sessionA = parseCodexPipelineFixture(tmpDir, "codex-a.jsonl");
      const sessionB = parseCodexPipelineFixture(tmpDir, "codex-b.jsonl", codexJsonlVariantBLines());

      assert.equal(buildSessionChapters(sessionA).length, 2);
      assert.equal(buildSessionChapters(sessionB).length, 1);
      assert.ok(sessionB.stats.errors >= 2, "variant B should record multiple tool errors");

      const html = comparePage(sessionA, sessionB);
      assertCompareShell(html, sessionA, sessionB);
      assertCompareViewLinks(html, sessionA._path, sessionB._path, {
        sourceA: "codex",
        sourceB: "codex",
      });
      assert.match(html, /codex integration pipeline/i);
      assert.match(html, /variant B/i);

      const strugglingRow = html.match(
        /<td class="cmp-label">Struggling chapters<\/td>\s*<td data-side="a" class="cmp-val[^>]*>(\d+)<\/td>\s*<td data-side="b" class="cmp-val[^>]*>(\d+)<\/td>/,
      );
      assert.ok(strugglingRow);
      assert.equal(Number(strugglingRow[1]), 0);
      assert.ok(Number(strugglingRow[2]) >= 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("codex markdown chapter prompts align with buildSessionChapters", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-pipeline-codex-md-"));
    try {
      const session = parseCodexPipelineFixture(tmpDir);
      const chapters = buildSessionChapters(session);
      const md = generateMarkdown(session);

      assert.match(md, /\*\*Branch:\*\* `anneal\/codex-pipeline`/);
      assert.match(md, /> Add codex integration pipeline test/);
      assert.match(md, /> Verify codex chapter structure in HTML/);
      for (let i = 0; i < chapters.length; i++) {
        const snippet = chapters[i].prompt.slice(0, 32).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        assert.match(md, new RegExp(`## Chapter ${i + 1}[\\s\\S]*> [^\\n]*${snippet}`));
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("integration pipeline opencode branch (parse → chapters → render | compare | markdown)", () => {
  test("opencode URI runs full pipeline without network", async () =>
    withOpenCodePipeline(async () => {
      await seedPipelineOpenCodeDb(process.env.HOME, [openCodePipelineSessionA()]);
      const session = parseOpenCodePipelineFixture(PIPELINE_OPENCODE_A);

      assert.equal(session.source, "opencode");
      assert.equal(session.sessionId, PIPELINE_OPENCODE_A);
      assert.equal(session.cwd, FIXTURE_CWD);
      assert.equal(session.model, OPENCODE_FIXTURE_MODEL);
      assert.ok(session.events.some((e) => e.type === "user" && /opencode integration pipeline/i.test(e.text)));

      const chapters = buildSessionChapters(session);
      assert.equal(chapters.length, 2);
      assertChapterShape(chapters[0], 0);
      assert.ok(chapters[0].toolCounts.Bash >= 1);
      assert.ok(chapters[1].errors >= 1);

      const html = renderHTML(session);
      assertRenderedViewerHtml(html, {
        sessionId: PIPELINE_OPENCODE_A,
        chapterCount: 2,
        source: "opencode",
        promptSnippet: "opencode integration pipeline",
      });

      const md = generateMarkdown(session);
      assert.match(md, /\*\*Source:\*\* opencode/);
      assert.equal((md.match(/^## Chapter /gm) || []).length, 2);
    }));

  test("opencode pipeline chapters align event order with parsed user messages", async () =>
    withOpenCodePipeline(async () => {
      await seedPipelineOpenCodeDb(process.env.HOME, [openCodePipelineSessionA()]);
      const session = parseOpenCodePipelineFixture(PIPELINE_OPENCODE_A);
      const chapters = buildSessionChapters(session);
      const userEvents = session.events.filter((e) => e.type === "user" && e.text);

      assert.equal(chapters.length, userEvents.length);
      for (let i = 0; i < chapters.length; i++) {
        assert.ok(chapters[i].prompt.includes(userEvents[i].text.slice(0, 24)));
      }
    }));

  test("opencode comparePage A vs B preserves virtual view paths", async () =>
    withOpenCodePipeline(async () => {
      await seedPipelineOpenCodeDb(process.env.HOME, [
        openCodePipelineSessionA(),
        openCodePipelineSessionB(),
      ]);
      const sessionA = parseOpenCodePipelineFixture(PIPELINE_OPENCODE_A);
      const sessionB = parseOpenCodePipelineFixture(PIPELINE_OPENCODE_B);

      const html = comparePage(sessionA, sessionB);
      assertCompareShell(html, sessionA, sessionB);
      assertCompareViewLinks(html, sessionA._path, sessionB._path, {
        sourceA: "opencode",
        sourceB: "opencode",
      });
      assert.match(html, /opencode integration pipeline/i);
      assert.match(html, /variant B/i);
    }));
});

describe("integration pipeline factory branch (parse → chapters → render | compare | markdown)", () => {
  test("minimal factory jsonl runs full pipeline without network", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-pipeline-factory-"));
    try {
      const session = parseFactoryPipelineFixture(tmpDir);

      assert.equal(session.source, "factory");
      assert.equal(session.sessionId, PIPELINE_FACTORY_SESSION_ID);
      assert.equal(session.cwd, FIXTURE_CWD);
      assert.equal(session.gitBranch, "anneal/factory-pipeline");
      assert.equal(session.model, FACTORY_FIXTURE_MODEL);
      assert.ok(session.events.some((e) => e.type === "user" && /factory integration pipeline/i.test(e.text)));
      assert.ok(session.stats.toolCounts.Bash >= 1);

      const chapters = buildSessionChapters(session);
      assert.equal(chapters.length, 2);
      assertChapterShape(chapters[0], 0);
      assertChapterShape(chapters[1], 1);
      assert.ok(chapters[0].toolCounts.Bash >= 1);
      assert.ok(chapters[1].errors >= 1, "failed Read should increment chapter errors");

      const html = renderHTML(session);
      assertRenderedViewerHtml(html, {
        sessionId: PIPELINE_FACTORY_SESSION_ID,
        chapterCount: 2,
        source: "factory",
        promptSnippet: "factory integration pipeline",
      });

      const md = generateMarkdown(session);
      assert.match(md, /\*\*Source:\*\* factory/);
      assert.match(md, /\*\*Branch:\*\* `anneal\/factory-pipeline`/);
      assert.equal((md.match(/^## Chapter /gm) || []).length, 2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("factory pipeline A vs variant B comparePage shows struggling delta", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-pipeline-factory-cmp-"));
    try {
      const sessionA = parseFactoryPipelineFixture(tmpDir, "factory-a.jsonl");
      const sessionB = parseFactoryPipelineFixture(tmpDir, "factory-b.jsonl", factoryJsonlVariantBLines());

      assert.equal(buildSessionChapters(sessionA).length, 2);
      assert.equal(buildSessionChapters(sessionB).length, 1);
      assert.ok(sessionB.stats.errors >= 2);

      const html = comparePage(sessionA, sessionB);
      assertCompareShell(html, sessionA, sessionB);
      assertCompareViewLinks(html, sessionA._path, sessionB._path, {
        sourceA: "factory",
        sourceB: "factory",
      });
      assert.match(html, /factory integration pipeline/i);
      assert.match(html, /variant B/i);

      const strugglingRow = html.match(
        /<td class="cmp-label">Struggling chapters<\/td>\s*<td data-side="a" class="cmp-val[^>]*>(\d+)<\/td>\s*<td data-side="b" class="cmp-val[^>]*>(\d+)<\/td>/,
      );
      assert.ok(strugglingRow);
      assert.equal(Number(strugglingRow[1]), 0);
      assert.ok(Number(strugglingRow[2]) >= 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
