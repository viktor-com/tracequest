/**
 * Automated harness for tests/messages-format-integration.md — Anthropic/OpenAI
 * message export across Claude, OpenCode, Codex, Factory, and Grok sources.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mkTmp,
  writeClaudeJsonl,
  writeJsonl,
  CLAUDE_FIXTURE_CWD,
  CLAUDE_FIXTURE_MODEL,
} from "../helpers/fixtures.js";
import { seedOpenCodeIndexDb } from "../helpers/opencode-db-fixtures.js";
import {
  assertAnthropicMessagesExport,
  assertOpenAiMessagesExport,
} from "../helpers/anthropic-messages-assert.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;

const MSG_MARKER = "msgfmt-integ-marker-xyz";
const OC_SESSION_ID = "ses_msgFmtIntegSession01";
const OC_URI = `opencode://${OC_SESSION_ID}`;
const OC_PROJECT = "/home/dev/msgfmt-oc-proj";

function runBin(args, { env = {}, timeoutMs = 30_000, expectCode = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [BIN, ...args], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        TRACEQUEST_NO_SIDECAR: "1",
        TRACEQUEST_SKIP_LR_WATCH: "1",
        ...env,
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

function minimalClaudeSession(sessionId, { withToolUse = false } = {}) {
  const ts = "2026-06-03T12:00:00.000Z";
  const assistantContent = [{ type: "text", text: "messages format claude assistant reply" }];
  if (withToolUse) {
    assistantContent.push({
      type: "tool_use",
      id: "toolu_msgfmt1",
      name: "Read",
      input: { file_path: "/src/app.js" },
    });
  }
  return [
    {
      type: "user",
      sessionId,
      cwd: CLAUDE_FIXTURE_CWD,
      timestamp: ts,
      uuid: `u-${sessionId}`,
      isMeta: false,
      message: { content: [{ type: "text", text: `claude hello ${MSG_MARKER}` }] },
    },
    {
      type: "assistant",
      sessionId,
      timestamp: ts,
      uuid: `a-${sessionId}`,
      message: {
        model: CLAUDE_FIXTURE_MODEL,
        content: assistantContent,
      },
    },
  ];
}

function seedClaudeSession(home, { withToolUse = false } = {}) {
  const dir = join(home, ".claude", "projects", "msgfmt-claude");
  mkdirSync(dir, { recursive: true });
  return writeClaudeJsonl(dir, "claude-msgfmt.jsonl", minimalClaudeSession("msgfmt-claude-1", { withToolUse }));
}

async function seedOpenCodeSession(home) {
  await seedOpenCodeIndexDb(home, [
    {
      id: OC_SESSION_ID,
      title: "Messages Format OpenCode",
      directory: OC_PROJECT,
      messages: [
        { role: "user", parts: [{ type: "text", text: `opencode hello ${MSG_MARKER}` }] },
        {
          role: "assistant",
          modelID: "gpt-4o",
          parts: [{ type: "text", text: "messages format opencode assistant reply" }],
        },
        { role: "user", parts: [{ type: "text", text: "third turn for discovery msg-count threshold" }] },
      ],
    },
  ]);
}

function seedCodexSession(home) {
  const codexDir = join(home, ".codex", "sessions", "2026", "06", "03");
  mkdirSync(codexDir, { recursive: true });
  const filePath = join(codexDir, "rollout-msgfmt.jsonl");
  writeJsonl(filePath, [
    {
      type: "session_meta",
      payload: { cwd: "/home/dev/msgfmt-codex-proj", model_provider: "openai" },
    },
    {
      type: "event_msg",
      payload: { type: "user_message", message: `codex hello ${MSG_MARKER}` },
    },
    {
      type: "response_item",
      payload: {
        role: "assistant",
        content: [{ type: "output_text", text: "messages format codex assistant reply" }],
      },
    },
  ]);
  return filePath;
}

function seedFactorySession(home) {
  const wsDir = join(home, ".factory", "sessions", "ws-home-dev-code-msgfmt-factory");
  mkdirSync(wsDir, { recursive: true });
  const filePath = join(wsDir, "factory-msgfmt.jsonl");
  writeJsonl(filePath, [
    {
      type: "message",
      message: { role: "user", content: [{ type: "text", text: `factory hello ${MSG_MARKER}` }] },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "messages format factory assistant reply" }],
      },
    },
  ]);
  return filePath;
}

function seedGrokSession(home) {
  const sessDir = join(home, ".grok", "sessions", "ws-msgfmt-grok", "grok-msgfmt-sess");
  mkdirSync(sessDir, { recursive: true });
  writeJsonl(join(sessDir, "chat_history.jsonl"), [
    { type: "user", content: `grok hello ${MSG_MARKER}` },
    { type: "assistant", content: "messages format grok assistant reply" },
  ]);
  writeJsonl(join(sessDir, "events.jsonl"), [
    { type: "turn_started", ts: "2026-06-03T12:00:00.000Z", model_id: "grok-3" },
  ]);
  return sessDir;
}

function rmHome(home) {
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

describe("tests/messages-format-integration.md harness", () => {
  test("Test 1: Claude JSONL exports valid Anthropic-format JSON", async () => {
    const home = mkTmp("tracequest-msgfmt-claude-");
    try {
      const claudePath = seedClaudeSession(home);
      const { stdout, stderr } = await runBin(["messages", claudePath], { env: { HOME: home } });
      assert.match(stderr, /Parsing session/);
      assertAnthropicMessagesExport(JSON.parse(stdout), { expectMarker: MSG_MARKER });
    } finally {
      rmHome(home);
    }
  });

  test("Test 2: OpenCode opencode:// URI exports valid Anthropic-format JSON", async () => {
    const home = mkTmp("tracequest-msgfmt-opencode-");
    try {
      await seedOpenCodeSession(home);
      const { stdout, stderr } = await runBin(["messages", OC_URI], { env: { HOME: home } });
      assert.match(stderr, /Parsing session/);
      assertAnthropicMessagesExport(JSON.parse(stdout), { expectMarker: MSG_MARKER });
    } finally {
      rmHome(home);
    }
  });

  test("Test 3: Codex rollout JSONL exports valid Anthropic-format JSON", async () => {
    const home = mkTmp("tracequest-msgfmt-codex-");
    try {
      const codexPath = seedCodexSession(home);
      const { stdout, stderr } = await runBin(["messages", codexPath], { env: { HOME: home } });
      assert.match(stderr, /Parsing session/);
      assertAnthropicMessagesExport(JSON.parse(stdout), { expectMarker: MSG_MARKER });
    } finally {
      rmHome(home);
    }
  });

  test("Test 4: Factory JSONL exports valid Anthropic-format JSON", async () => {
    const home = mkTmp("tracequest-msgfmt-factory-");
    try {
      const factoryPath = seedFactorySession(home);
      const { stdout, stderr } = await runBin(["messages", factoryPath], { env: { HOME: home } });
      assert.match(stderr, /Parsing session/);
      assertAnthropicMessagesExport(JSON.parse(stdout), { expectMarker: MSG_MARKER });
    } finally {
      rmHome(home);
    }
  });

  test("Test 5: Grok session dir exports valid Anthropic-format JSON", async () => {
    const home = mkTmp("tracequest-msgfmt-grok-");
    try {
      const grokDir = seedGrokSession(home);
      const { stdout, stderr } = await runBin(["messages", grokDir], { env: { HOME: home } });
      assert.match(stderr, /Parsing session/);
      assertAnthropicMessagesExport(JSON.parse(stdout), { expectMarker: MSG_MARKER });
    } finally {
      rmHome(home);
    }
  });

  test("Test 6: Claude --format openai exports valid OpenAI-format JSON", async () => {
    const home = mkTmp("tracequest-msgfmt-openai-");
    try {
      const claudePath = seedClaudeSession(home, { withToolUse: true });
      const { stdout, stderr } = await runBin(["messages", claudePath, "--format", "openai"], {
        env: { HOME: home },
      });
      assert.match(stderr, /Parsing session/);
      const parsed = JSON.parse(stdout);
      assertOpenAiMessagesExport(parsed);
      const assistant = parsed.messages.find((m) => m.role === "assistant" && m.tool_calls?.length);
      assert.ok(assistant, "assistant should include tool_calls");
      assert.equal(typeof assistant.tool_calls[0].function.arguments, "string");
    } finally {
      rmHome(home);
    }
  });

  test("Test 7: Claude --pretty emits indented JSON", async () => {
    const home = mkTmp("tracequest-msgfmt-pretty-");
    try {
      const claudePath = seedClaudeSession(home);
      const { stdout } = await runBin(["messages", claudePath, "--pretty"], { env: { HOME: home } });
      assert.match(stdout, /\n  "messages"/);
      assertAnthropicMessagesExport(JSON.parse(stdout), { expectMarker: MSG_MARKER });
    } finally {
      rmHome(home);
    }
  });
});