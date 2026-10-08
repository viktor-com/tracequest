/**
 * Automated harness for tests/render-messages-integration.md — render/messages edge cases.
 * Real bin/tracequest.js invocations; temp dirs; isolated fixtures.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_FIXTURE_MODEL, mkTmp, writeJsonl } from "../helpers/fixtures.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;

const TS = "2026-06-03T12:00:00.000Z";
const IMAGE_MARKER = "RENDER_IMAGE_MARKER_XYZ";
const MALFORMED_MARKER = "MALFORMED_EDGE_MARKER_XYZ";
const LONG_TOOL_MARKER = "LONG_TOOL_START";
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function runBin(args, { timeoutMs = 30_000, expectCode = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [BIN, ...args], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        TRACEQUEST_NO_SIDECAR: "1",
        TRACEQUEST_SKIP_LR_WATCH: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`bin timeout after ${timeoutMs}ms: ${args.join(" ")}`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== expectCode) {
        reject(
          new Error(
            `bin ${args.join(" ")} expected exit ${expectCode}, got ${code}\nstdout: ${stdout}\nstderr: ${stderr}`,
          ),
        );
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

function parseInlinedSession(html) {
  const marker = "const SESSION = ";
  const start = html.indexOf(marker);
  assert.ok(start >= 0, "render HTML should embed const SESSION");
  const jsonStart = start + marker.length;
  const jsonEnd = html.indexOf(";\n", jsonStart);
  assert.ok(jsonEnd > jsonStart, "SESSION JSON should terminate before bundle script");
  return JSON.parse(html.slice(jsonStart, jsonEnd));
}

function systemOnlyLines(sessionId) {
  return [
    {
      type: "system",
      subtype: "init",
      sessionId,
      cwd: "/home/dev/tracequest",
      timestamp: TS,
    },
    {
      type: "user",
      sessionId,
      isMeta: true,
      timestamp: TS,
      uuid: "u-meta-1",
      message: { content: [{ type: "text", text: "System context preamble only" }] },
    },
    {
      type: "user",
      sessionId,
      isMeta: true,
      timestamp: TS,
      uuid: "u-meta-2",
      message: { content: "bootstrap instructions without displayable turns" },
    },
  ];
}

function imageContentLines(sessionId) {
  return [
    {
      type: "user",
      sessionId,
      isMeta: false,
      timestamp: TS,
      uuid: "u-img",
      message: {
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: PNG_B64 },
          },
          { type: "text", text: `describe this screenshot ${IMAGE_MARKER}` },
        ],
      },
    },
    {
      type: "assistant",
      sessionId,
      timestamp: TS,
      uuid: "a-img",
      message: {
        model: CLAUDE_FIXTURE_MODEL,
        content: [{ type: "text", text: `I see the image related to ${IMAGE_MARKER}` }],
      },
    },
  ];
}

function longToolOutputLines(sessionId) {
  const huge = "L".repeat(8000);
  return [
    {
      type: "user",
      sessionId,
      isMeta: false,
      timestamp: TS,
      uuid: "u-long",
      message: { content: [{ type: "text", text: "run verbose command" }] },
    },
    {
      type: "assistant",
      sessionId,
      timestamp: TS,
      uuid: "a-long",
      message: {
        model: CLAUDE_FIXTURE_MODEL,
        content: [
          { type: "text", text: "running" },
          { type: "tool_use", id: "t-long", name: "Bash", input: { command: "npm test --verbose" } },
        ],
      },
    },
    {
      type: "user",
      sessionId,
      timestamp: TS,
      uuid: "u-tr",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t-long", content: LONG_TOOL_MARKER + huge }],
      },
    },
  ];
}

function malformedEdgeLines(sessionId) {
  const validUser = {
    type: "user",
    sessionId,
    isMeta: false,
    timestamp: TS,
    uuid: "u-ok",
    message: { content: `hello after garbage ${MALFORMED_MARKER}` },
  };
  return [
    "",
    "   ",
    `{"type":"user","sessionId":"${sessionId}","isMeta":false,"timestamp":"${TS}","uuid":"u-bad","message":{broken`,
    JSON.stringify({ type: "system", content: "ignored filler row" }),
    JSON.stringify(validUser),
  ];
}

describe("tests/render-messages-integration.md harness", () => {
  test("Test 1: system-only session renders and exports empty messages", async () => {
    const dir = mkTmp("tracequest-render-msg-int-1-");
    const sessionId = "render-msg-sys-only-1";
    const sessionPath = join(dir, "system-only.jsonl");
    const out = join(dir, "system-only.html");
    writeJsonl(sessionPath, systemOnlyLines(sessionId));
    try {
      const render = await runBin(["render", sessionPath, "--out", out]);
      const renderErr = stripAnsi(render.stderr);
      assert.match(renderErr, /0 events parsed/);
      assert.ok(existsSync(out));
      const session = parseInlinedSession(readFileSync(out, "utf8"));
      assert.equal(session.eventCount, 0);
      assert.deepEqual(session.events, []);

      const messages = await runBin(["messages", sessionPath]);
      assert.match(stripAnsi(messages.stderr), /Parsing session/);
      const exported = JSON.parse(messages.stdout);
      assert.deepEqual(exported.messages, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Test 2: image content blocks preserve text and omit image payload", async () => {
    const dir = mkTmp("tracequest-render-msg-int-2-");
    const sessionId = "render-msg-image-1";
    const sessionPath = join(dir, "image-blocks.jsonl");
    const out = join(dir, "image-blocks.html");
    writeJsonl(sessionPath, imageContentLines(sessionId));
    try {
      const render = await runBin(["render", sessionPath, "--out", out]);
      assert.match(stripAnsi(render.stdout), /Written:/);
      const html = readFileSync(out, "utf8");
      const session = parseInlinedSession(html);
      assert.ok(html.includes(IMAGE_MARKER));
      assert.ok(!html.includes(PNG_B64));
      assert.equal(session.events[0].text, `describe this screenshot ${IMAGE_MARKER}`);

      const messages = await runBin(["messages", sessionPath]);
      const exported = JSON.parse(messages.stdout);
      const userText = exported.messages[0].content.find((b) => b.type === "text")?.text;
      assert.equal(userText, `describe this screenshot ${IMAGE_MARKER}`);
      assert.ok(!messages.stdout.includes(PNG_B64));
      assert.equal(exported.messages[0].content.filter((b) => b.type === "image").length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Test 3: very long tool output is truncated to 1000 chars", async () => {
    const dir = mkTmp("tracequest-render-msg-int-3-");
    const sessionId = "render-msg-long-tool-1";
    const sessionPath = join(dir, "long-tool.jsonl");
    const out = join(dir, "long-tool.html");
    const hugeTail = "L".repeat(8000);
    writeJsonl(sessionPath, longToolOutputLines(sessionId));
    try {
      const render = await runBin(["render", sessionPath, "--out", out]);
      assert.match(stripAnsi(render.stdout), /Written:/);
      const html = readFileSync(out, "utf8");
      const session = parseInlinedSession(html);
      const toolResult = session.events.find((e) => e.type === "tool_result");
      assert.ok(toolResult);
      // Cut to 1000 chars of real content, then a visible truncation marker.
      assert.ok(toolResult.text.startsWith(LONG_TOOL_MARKER));
      assert.match(toolResult.text, /\[truncated \d+ chars\]$/);
      assert.ok(!html.includes(hugeTail));

      const messages = await runBin(["messages", sessionPath]);
      const exported = JSON.parse(messages.stdout);
      const toolMsg = exported.messages.find(
        (m) =>
          m.role === "user" &&
          Array.isArray(m.content) &&
          m.content.some((b) => b.type === "tool_result"),
      );
      assert.ok(toolMsg);
      const block = toolMsg.content.find((b) => b.type === "tool_result");
      assert.ok(block.content.startsWith(LONG_TOOL_MARKER));
      assert.match(block.content, /\[truncated \d+ chars\]$/);
      assert.ok(!messages.stdout.includes(hugeTail));

      // --full re-parses untruncated: full tail present, no marker.
      const full = await runBin(["messages", sessionPath, "--full"]);
      assert.ok(full.stdout.includes(hugeTail));
      assert.doesNotMatch(full.stdout, /\[truncated \d+ chars\]/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Test 4: malformed indexed-looking JSONL lines are skipped with stderr warning", async () => {
    const dir = mkTmp("tracequest-render-msg-int-4-");
    const sessionId = "render-msg-malformed-1";
    const sessionPath = join(dir, "malformed-edge.jsonl");
    const out = join(dir, "malformed-edge.html");
    writeJsonl(sessionPath, malformedEdgeLines(sessionId));
    try {
      const render = await runBin(["render", sessionPath, "--out", out]);
      assert.match(render.stderr, /parseJsonlLine: malformed JSONL line/);
      assert.ok(!render.stderr.includes("node:internal/process"));
      const session = parseInlinedSession(readFileSync(out, "utf8"));
      assert.equal(session.events.length, 1);
      assert.match(session.events[0].text, new RegExp(MALFORMED_MARKER));

      const messages = await runBin(["messages", sessionPath]);
      assert.match(messages.stderr, /parseJsonlLine: malformed JSONL line/);
      const exported = JSON.parse(messages.stdout);
      assert.equal(exported.messages.length, 1);
      assert.match(exported.messages[0].content[0].text, new RegExp(MALFORMED_MARKER));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});