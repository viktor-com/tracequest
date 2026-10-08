/**
 * Automated harness for tests/opencode-integration.md — OpenCode CLI integration.
 * Real bin/tracequest.js invocations; isolated HOME; opencode.db fixtures.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkTmp } from "../helpers/fixtures.js";
import { resolveOpenCodeDbPath } from "../../src/sessions/session-discovery-paths.js";
import { seedOpenCodeIndexDb } from "../helpers/opencode-db-fixtures.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;

const OC_SESSION_ID = "ses_integOpenCodeTestSession01";
const OC_URI = `opencode://${OC_SESSION_ID}`;
const OC_SEARCH_MARKER = "opencode-integ-marker-xyz";
const OC_PROJECT = "/home/dev/oc-integ-proj";
const OC_MODEL = "gpt-4o";

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

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

async function seedStandardOpenCodeSession(home, { prompt = `hello ${OC_SEARCH_MARKER}` } = {}) {
  await seedOpenCodeIndexDb(home, [
    {
      id: OC_SESSION_ID,
      title: "OpenCode Integration",
      directory: OC_PROJECT,
      messages: [
        {
          role: "user",
          parts: [{ type: "text", text: prompt }],
        },
        {
          role: "assistant",
          modelID: OC_MODEL,
          parts: [{ type: "text", text: "integration assistant reply for opencode" }],
        },
        {
          role: "user",
          parts: [{ type: "text", text: "third turn for discovery msg-count threshold" }],
        },
      ],
    },
  ]);
}

async function seedToolOnlyOpenCodeSession(home) {
  await seedOpenCodeIndexDb(home, [
    {
      id: OC_SESSION_ID,
      title: "OpenCode Tool Only",
      directory: OC_PROJECT,
      messages: [
        {
          role: "user",
          parts: [{ type: "text", text: "run tools only please" }],
        },
        {
          role: "assistant",
          modelID: OC_MODEL,
          parts: [
            {
              type: "tool",
              callID: "oc-integ-bash-1",
              tool: "bash",
              state: {
                input: { command: "npm test" },
                output: "ok",
                status: "ok",
              },
            },
          ],
        },
        {
          role: "user",
          parts: [{ type: "text", text: "ack tool-only turn" }],
        },
      ],
    },
  ]);
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

function writeCorruptOpenCodeDb(home) {
  const dbPath = resolveOpenCodeDbPath(home);
  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, "NOT_A_SQLITE_DB\x00\x01\x02");
  return dbPath;
}

describe("tests/opencode-integration.md harness", () => {
  test("Test 1: list discovers OpenCode sessions when DB present", async () => {
    const home = mkTmp("tracequest-opencode-list-");
    try {
      await seedStandardOpenCodeSession(home);
      const { stdout } = await runBin(["list"], { env: { HOME: home } });
      const visible = stripAnsi(stdout);
      assert.match(visible, /Found 1 sessions/);
      assert.match(visible, /\bopencode\b/);
      assert.match(visible, new RegExp(OC_URI.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Test 2: render produces HTML from opencode:// URI", async () => {
    const home = mkTmp("tracequest-opencode-render-home-");
    const outDir = mkTmp("tracequest-opencode-render-out-");
    const out = join(outDir, "oc-render.html");
    try {
      await seedStandardOpenCodeSession(home);
      const { stdout } = await runBin(["render", OC_URI, "--out", out], { env: { HOME: home } });
      assert.match(stdout, /Written:/);
      assert.ok(existsSync(out));
      const html = readFileSync(out, "utf8");
      const inlined = parseInlinedSession(html);
      assert.equal(inlined.source, "opencode");
      assert.equal(inlined.sessionId, OC_SESSION_ID);
      assert.ok(
        inlined.events.some((e) => e.type === "user" && e.text?.includes(OC_SEARCH_MARKER)),
        "inlined SESSION should retain seeded user prompt",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("Test 3: messages exports JSON from opencode:// URI", async () => {
    const home = mkTmp("tracequest-opencode-messages-");
    try {
      await seedStandardOpenCodeSession(home);
      const { stdout, stderr } = await runBin(["messages", OC_URI], { env: { HOME: home } });
      assert.match(stderr, /Parsing session/);
      const result = JSON.parse(stdout);
      assert.ok(Array.isArray(result.messages));
      assert.ok(result.messages.length >= 2);
      assert.equal(result.messages[0].role, "user");
      assert.equal(result.messages[1].role, "assistant");
      const userText = result.messages[0].content.find((b) => b.type === "text")?.text || "";
      assert.ok(userText.includes(OC_SEARCH_MARKER));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Test 4: search indexes OpenCode session text", async () => {
    const home = mkTmp("tracequest-opencode-search-");
    try {
      await seedStandardOpenCodeSession(home);
      const { stdout } = await runBin(["search", OC_SEARCH_MARKER], { env: { HOME: home } });
      const visible = stripAnsi(stdout);
      assert.match(visible, /Found 1 result/);
      assert.match(visible, new RegExp(OC_URI.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(visible, new RegExp(OC_SEARCH_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Test 5: missing opencode.db yields no OpenCode sessions", async () => {
    const home = mkTmp("tracequest-opencode-empty-home-");
    try {
      const { stdout, stderr } = await runBin(["list"], { env: { HOME: home } });
      assert.match(stripAnsi(stdout), /No sessions found\./);
      assert.ok(!stderr.includes("node:internal"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Test 6: corrupt opencode.db does not crash list", async () => {
    const home = mkTmp("tracequest-opencode-corrupt-");
    try {
      writeCorruptOpenCodeDb(home);
      const { stdout, stderr } = await runBin(["list"], { env: { HOME: home } });
      assert.match(stripAnsi(stdout), /No sessions found\./);
      assert.ok(!stderr.includes("node:internal"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Test 7: tool-only assistant turn renders and exports", async () => {
    const home = mkTmp("tracequest-opencode-toolonly-home-");
    const outDir = mkTmp("tracequest-opencode-toolonly-out-");
    const out = join(outDir, "oc-toolonly.html");
    try {
      await seedToolOnlyOpenCodeSession(home);
      const render = await runBin(["render", OC_URI, "--out", out], { env: { HOME: home } });
      assert.match(render.stdout, /Written:/);
      const inlined = parseInlinedSession(readFileSync(out, "utf8"));
      const asst = inlined.events.find((e) => e.type === "assistant");
      assert.ok(asst, "tool-only session should still have an assistant event");
      assert.ok(asst.toolCalls?.length >= 1, "assistant should retain toolCalls");
      assert.equal(asst.toolCalls[0].name, "Bash");

      const { stdout } = await runBin(["messages", OC_URI], { env: { HOME: home } });
      const result = JSON.parse(stdout);
      const assistant = result.messages.find((m) => m.role === "assistant");
      assert.ok(assistant?.content?.some((b) => b.type === "tool_use" && b.name === "Bash"));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("Test 8: malformed opencode:// URI is rejected", async () => {
    const { stderr } = await runBin(["render", "opencode://sess-not-valid-id"], { expectCode: 1 });
    assert.match(stderr, /Invalid OpenCode session path/);
    assert.ok(!stderr.includes("node:internal"));
  });
});