/**
 * E2E smoke: spawn bin/tracequest.js as a child process (real CLI entry).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  CLAUDE_FIXTURE_CWD,
  CLAUDE_FIXTURE_MODEL,
  mkTmp,
  writeClaudeJsonl,
} from "../helpers/fixtures.js";
import {
  TRACEQUEST_BIN as BIN,
  TRACEQUEST_NODE as NODE,
  TRACEQUEST_ROOT as ROOT,
  richClaudeFixture,
  runTracequestBin,
  writeFakeStandupProbePath,
  writeStandupProfiles,
} from "../helpers/standup-handoff-fixtures.js";

/** Strip ANSI SGR so e2e compares visible CLI text, not escape sequences. */
function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Order-independent stdout lines (readdir / preset block order can vary). */
function sortedStdoutLines(stdout) {
  return stripAnsi(stdout)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .sort();
}

/** Assert each pattern appears somewhere in stdout (order-independent). */
function assertStdoutContains(stdout, patterns) {
  const visible = stripAnsi(stdout);
  for (const pattern of patterns) {
    assert.match(visible, pattern);
  }
}

function assertProbePreflight(stderr) {
  assert.match(stderr, /TraceQuest standup agent probe:/);
  assert.match(stderr, /synthetic sentinel prompts only/);
  assert.match(stderr, /No sessions are discovered/);
  assert.match(stderr, /no raw JSONL, real prompts, assistant replies, tool outputs, or absolute session paths are sent/);
  assert.match(stderr, /JSON probe report will be written to stdout/);
}

function changelogReleaseSection(changelog, version) {
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`## \\[${escapedVersion}\\][^\\n]*\\n([\\s\\S]*?)(?=\\n## \\[|$)`);
  return changelog.match(pattern)?.[1] ?? "";
}

function previousWeekdayAt(hour) {
  const now = new Date();
  const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, hour, 0, 0, 0);
  while (candidate.getDay() === 0 || candidate.getDay() === 6) {
    candidate.setDate(candidate.getDate() - 1);
  }
  return candidate;
}

/** Spawn node bin/tracequest.js; rejects on non-matching exit code or timeout. */
function runBin(args, { cwd = ROOT, timeoutMs = 30_000, expectCode = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [BIN, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
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

function minimalClaudeFixture(sessionId = "e2e-bin-1") {
  const ts = "2026-06-03T12:00:00.000Z";
  return [
    {
      type: "user",
      sessionId,
      cwd: CLAUDE_FIXTURE_CWD,
      timestamp: ts,
      uuid: "u-e2e-1",
      isMeta: false,
      message: { content: [{ type: "text", text: "e2e smoke" }] },
    },
    {
      type: "assistant",
      sessionId,
      timestamp: ts,
      uuid: "a-e2e-1",
      message: {
        model: CLAUDE_FIXTURE_MODEL,
        content: [{ type: "text", text: "ok" }],
      },
    },
  ];
}

describe("bin/tracequest.js e2e smoke", () => {
  test("--help prints usage and subcommands", async () => {
    const { stdout } = await runBin(["--help"]);
    assert.match(stdout, /tracequest/);
    assert.match(stdout, /Commands:/);
    assert.match(stdout, /\brender\b/);
    assert.match(stdout, /\bserve\b/);
    assert.match(stdout, /\bpresets\b/);
  });

  test("--version prints semver from package.json", async () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const { stdout } = await runBin(["--version"]);
    assert.equal(stdout.trim(), pkg.version);
  });

  test("help subcommand exits 0 with render/list/latest", async () => {
    const { stdout } = await runBin(["help"]);
    assert.match(stdout, /render/);
    assert.match(stdout, /latest/);
  });

  test("render --out writes HTML file for fixture jsonl", async () => {
    const dir = mkTmp("bin-e2e-render-");
    const jsonl = join(dir, "session.jsonl");
    const out = join(dir, "tracequest-out.html");
    writeClaudeJsonl(dir, "session.jsonl", minimalClaudeFixture());
    try {
      const { stdout } = await runBin(["render", jsonl, "--out", out]);
      assert.match(stdout, /Written:/);
      assert.ok(existsSync(out), "render --out should create HTML file");
      const html = readFileSync(out, "utf8");
      assert.match(html, /<html/i);
      assert.match(html, /SESSION\s*=/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("render without session path exits 1 with stderr Error prefix", async () => {
    const { stderr, stdout } = await runBin(["render"], { expectCode: 1 });
    assert.equal(stdout, "");
    assert.match(stderr, /Error:.*session\.jsonl/);
  });

  test("unknown command exits 1 with stderr Error prefix", async () => {
    const { stderr, stdout } = await runBin(["not-a-command"], { expectCode: 1 });
    assert.equal(stdout, "");
    assert.match(stderr, /Error: Unknown command/);
  });

  test("serve invalid port exits 1 with stderr Error prefix", async () => {
    const { stderr, stdout } = await runBin(["serve", "--port", "0"], { expectCode: 1 });
    assert.equal(stdout, "");
    assert.match(stderr, /Error: Invalid port/);
  });

  test("presets lists built-in default and local with ports", async () => {
    const { stdout, stderr } = await runBin(["presets"]);
    assert.equal(stderr, "");
    assertStdoutContains(stdout, [
      /Built-in presets/,
      /\bdefault\b/,
      /\blocal\b/,
      /\b7777\b/,
      /\b8888\b/,
    ]);
    const lines = sortedStdoutLines(stdout);
    assert.ok(lines.some((l) => /\bdefault\b/.test(l)));
    assert.ok(lines.some((l) => /\blocal\b/.test(l)));
    assert.ok(lines.some((l) => /\b7777\b/.test(l)));
    assert.ok(lines.some((l) => /\b8888\b/.test(l)));
  });

  test("preset alias lists same built-ins as presets", async () => {
    const presets = await runBin(["presets"]);
    const preset = await runBin(["preset"]);
    assert.equal(preset.stderr, "");
    assert.equal(presets.stderr, "");
    assert.deepEqual(
      sortedStdoutLines(preset.stdout),
      sortedStdoutLines(presets.stdout),
    );
  });

  test("render missing file exits 1 with stderr Error prefix", async () => {
    const { stderr, stdout } = await runBin(
      ["render", "/tmp/tracequest-nonexistent-session.jsonl"],
      { expectCode: 1 },
    );
    assert.equal(stdout, "");
    assert.match(stderr, /Error: File not found/);
  });

  test("render rejects bare directory without chat_history.jsonl", async () => {
    const dir = mkTmp("bin-e2e-dir-");
    try {
      const { stderr, stdout } = await runBin(["render", dir], { expectCode: 1 });
      assert.equal(stdout, "");
      assert.match(stderr, /Error: Not a session file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers for new CLI command e2e tests
// ---------------------------------------------------------------------------

const runBinWithEnv = runTracequestBin;

async function waitForFile(path, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await delay(10);
  }
  throw new Error(`timed out waiting for ${path}`);
}

function privacyClaudeFixture(sessionId, {
  promptTail,
  replyTail,
  rawJsonlSentinel,
  absPathSentinel,
  toolOutputSentinel,
} = {}) {
  const ts = "2026-06-03T12:00:00.000Z";
  const usefulPrompt = "Investigate compact-input privacy regression and keep a standup-safe progress summary.";
  const usefulReply = "Added focused regression coverage and preserved useful capped standup signal.";
  const commandPath = `/tmp/${absPathSentinel}/workspace/tracequest/private/secret-output.log`;
  const readPath = `/tmp/${absPathSentinel}/workspace/tracequest/private/config.secret`;
  return [
    {
      type: "user",
      sessionId,
      cwd: `/tmp/${absPathSentinel}/workspace/tracequest`,
      timestamp: ts,
      uuid: `u-${sessionId}`,
      isMeta: false,
      rawTraceSentinel: rawJsonlSentinel,
      message: {
        content: `${usefulPrompt} ${"private prompt detail ".repeat(30)} ${promptTail}`,
      },
    },
    {
      type: "assistant",
      sessionId,
      timestamp: ts,
      uuid: `a-${sessionId}`,
      message: {
        model: CLAUDE_FIXTURE_MODEL,
        content: [
          { type: "text", text: `${usefulReply} ${"private assistant detail ".repeat(30)} ${replyTail}` },
          { type: "tool_use", id: "toolu_privacy_bash", name: "Bash", input: { command: `npm run test:privacy -- --log ${commandPath}` } },
          { type: "tool_use", id: "toolu_privacy_read", name: "Read", input: { file_path: readPath } },
        ],
      },
    },
    {
      type: "user",
      sessionId,
      timestamp: ts,
      uuid: `tr-${sessionId}`,
      isMeta: false,
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_privacy_bash",
            content: [{ type: "text", text: `private command output ${toolOutputSentinel}\n`.repeat(40) }],
          },
          {
            type: "tool_result",
            tool_use_id: "toolu_privacy_read",
            content: [{ type: "text", text: `private file contents ${toolOutputSentinel}` }],
          },
        ],
      },
    },
  ];
}

/**
 * Seed a tmp HOME with Claude sessions for e2e testing.
 * Returns { home, sessions: [{path, project, model, ...}] }.
 */
function seedE2eHome() {
  const home = mkTmp("bin-e2e-home-");
  const sessions = [];

  // Project "e2e-sonnet" with sonnet model
  const sonnetDir = join(home, ".claude", "projects", "e2e-sonnet");
  mkdirSync(sonnetDir, { recursive: true });
  const s1 = writeClaudeJsonl(sonnetDir, "sonnet-session.jsonl",
    richClaudeFixture("e2e-sonnet-1", { model: "claude-sonnet-4-20250514", prompt: "deploy the sonnet application", tools: ["Read"] }));
  sessions.push({ path: s1, project: "e2e-sonnet", model: "sonnet" });

  // Project "e2e-opus" with opus model
  const opusDir = join(home, ".claude", "projects", "e2e-opus");
  mkdirSync(opusDir, { recursive: true });
  const s2 = writeClaudeJsonl(opusDir, "opus-session.jsonl",
    richClaudeFixture("e2e-opus-1", { model: "claude-opus-4-20250514", prompt: "refactor the opus module", tools: ["Edit", "Bash"] }));
  sessions.push({ path: s2, project: "e2e-opus", model: "opus" });

  return { home, sessions };
}

function seedE2eStandupWindowHome() {
  const home = mkTmp("bin-e2e-standup-window-");
  const projDir = join(home, ".claude", "projects", "e2e-standup-window");
  mkdirSync(projDir, { recursive: true });

  const todayPath = writeClaudeJsonl(projDir, "today.jsonl",
    richClaudeFixture("e2e-standup-today", { prompt: "today standup e2e prompt" }));
  const yesterdayPath = writeClaudeJsonl(projDir, "yesterday.jsonl",
    richClaudeFixture("e2e-standup-yesterday", { prompt: "yesterday standup e2e prompt" }));
  const afterWorkPath = writeClaudeJsonl(projDir, "after-work.jsonl",
    richClaudeFixture("e2e-standup-after-work", { prompt: "after workday standup e2e prompt" }));
  const previousWorkdayPath = writeClaudeJsonl(projDir, "previous-workday.jsonl",
    richClaudeFixture("e2e-standup-previous-workday", { prompt: "previous workday standup e2e prompt" }));
  const previousWorkdayEarlyPath = writeClaudeJsonl(projDir, "previous-workday-early.jsonl",
    richClaudeFixture("e2e-standup-previous-workday-early", { prompt: "early previous workday standup e2e prompt" }));

  const now = new Date();
  const todayNoon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
  const todayEvening = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 18, 0, 0);
  const yesterdayNoon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12, 0, 0);
  const previousWorkdayNoon = previousWeekdayAt(12);
  const previousWorkdayEarly = previousWeekdayAt(8);
  utimesSync(todayPath, todayNoon, todayNoon);
  utimesSync(afterWorkPath, todayEvening, todayEvening);
  utimesSync(yesterdayPath, yesterdayNoon, yesterdayNoon);
  utimesSync(previousWorkdayPath, previousWorkdayNoon, previousWorkdayNoon);
  utimesSync(previousWorkdayEarlyPath, previousWorkdayEarly, previousWorkdayEarly);

  return { home, todayPath, yesterdayPath, afterWorkPath, previousWorkdayPath, previousWorkdayEarlyPath };
}

/** Seed a tmp HOME with >10 Claude sessions for find default-limit e2e. */
function seedE2eFindManyHome(count = 12) {
  const home = mkTmp("bin-e2e-find-many-");
  const projDir = join(home, ".claude", "projects", "e2e-find-many");
  mkdirSync(projDir, { recursive: true });
  const sessions = [];
  for (let i = 0; i < count; i++) {
    const name = `session-${String(i).padStart(2, "0")}.jsonl`;
    const filePath = writeClaudeJsonl(
      projDir,
      name,
      richClaudeFixture(`e2e-find-${i}`, { prompt: `e2e find session ${i}` }),
    );
    const t = Date.now() / 1000 - i * 10;
    utimesSync(filePath, t, t);
    sessions.push({ path: filePath, index: i });
  }
  return { home, sessions, count };
}

// ---------------------------------------------------------------------------
// E2E: tracequest messages
// ---------------------------------------------------------------------------

describe("bin/tracequest.js e2e messages", () => {
  test("messages outputs valid Anthropic-format JSON to stdout", async () => {
    const dir = mkTmp("bin-e2e-messages-");
    const jsonl = join(dir, "session.jsonl");
    writeClaudeJsonl(dir, "session.jsonl", richClaudeFixture("e2e-msg-1", { tools: ["Read"] }));
    try {
      const { stdout, stderr } = await runBin(["messages", jsonl]);
      // stderr gets the status message; stdout gets JSON
      assert.match(stderr, /Parsing session/);
      const result = JSON.parse(stdout);
      assert.ok(Array.isArray(result.messages), "messages should be an array");
      assert.ok(result.messages.length >= 2, "should have at least user + assistant");
      assert.equal(result.messages[0].role, "user");
      assert.equal(result.messages[1].role, "assistant");
      // Verify Anthropic format: content should be arrays with typed blocks
      assert.ok(Array.isArray(result.messages[0].content));
      assert.equal(result.messages[0].content[0].type, "text");
      // Verify tool_use has object input (not string)
      const assistantMsg = result.messages[1];
      const toolUse = assistantMsg.content.find((b) => b.type === "tool_use");
      if (toolUse) {
        assert.equal(typeof toolUse.input, "object", "tool_use.input must be an object");
        assert.ok(toolUse.name, "tool_use must have a name");
        assert.ok(toolUse.id, "tool_use must have an id");
      }
      // Model should be included
      assert.ok(result.model);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("messages --format openai outputs valid OpenAI-format JSON", async () => {
    const dir = mkTmp("bin-e2e-messages-openai-");
    const jsonl = join(dir, "session.jsonl");
    writeClaudeJsonl(dir, "session.jsonl", richClaudeFixture("e2e-msg-openai", { tools: ["Bash"] }));
    try {
      const { stdout } = await runBin(["messages", jsonl, "--format", "openai"]);
      const result = JSON.parse(stdout);
      assert.ok(Array.isArray(result.messages));
      // First message should be user with string content (OpenAI format)
      const userMsg = result.messages[0];
      assert.equal(userMsg.role, "user");
      assert.equal(typeof userMsg.content, "string");
      // Assistant with tool_calls
      const assistantMsg = result.messages[1];
      assert.equal(assistantMsg.role, "assistant");
      if (assistantMsg.tool_calls) {
        for (const tc of assistantMsg.tool_calls) {
          assert.equal(tc.type, "function");
          assert.ok(tc.function.name);
          // arguments must be a valid JSON string
          assert.equal(typeof tc.function.arguments, "string");
          assert.doesNotThrow(() => JSON.parse(tc.function.arguments),
            "function.arguments must be valid JSON");
        }
      }
      // Tool result messages should have role "tool"
      const toolMsgs = result.messages.filter((m) => m.role === "tool");
      for (const tm of toolMsgs) {
        assert.ok(tm.tool_call_id, "tool message must have tool_call_id");
        assert.equal(typeof tm.content, "string");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("messages --pretty outputs indented JSON", async () => {
    const dir = mkTmp("bin-e2e-messages-pretty-");
    const jsonl = join(dir, "session.jsonl");
    writeClaudeJsonl(dir, "session.jsonl", minimalClaudeFixture("e2e-pretty"));
    try {
      const { stdout } = await runBin(["messages", jsonl, "--pretty"]);
      // Pretty JSON has newlines and indentation
      assert.ok(stdout.includes("\n  "), "pretty output should have indentation");
      const result = JSON.parse(stdout);
      assert.ok(Array.isArray(result.messages));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("messages without path exits 1", async () => {
    const { stderr } = await runBin(["messages"], { expectCode: 1 });
    assert.match(stderr, /Error:.*session\.jsonl/);
  });

  test("messages with invalid format exits 1", async () => {
    const dir = mkTmp("bin-e2e-messages-badfmt-");
    const jsonl = join(dir, "session.jsonl");
    writeClaudeJsonl(dir, "session.jsonl", minimalClaudeFixture());
    try {
      const { stderr } = await runBin(["messages", jsonl, "--format", "xml"], { expectCode: 1 });
      assert.match(stderr, /Invalid format/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// E2E: tracequest find
// ---------------------------------------------------------------------------

describe("bin/tracequest.js e2e find", () => {
  test("find 'model:sonnet' lists matching sessions", async () => {
    const { home, sessions } = seedE2eHome();
    try {
      const { stdout } = await runBinWithEnv(["find", "--filter", "model:sonnet"], { env: { HOME: home } });
      const visible = stripAnsi(stdout);
      assert.match(visible, /Found \d+ session/);
      assert.match(visible, /e2e-sonnet/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("find with no --filter lists 10 most recent sessions", async () => {
    const { home, count } = seedE2eFindManyHome(12);
    try {
      const { stdout } = await runBinWithEnv(["find"], { env: { HOME: home } });
      const visible = stripAnsi(stdout);
      assert.match(visible, new RegExp(`Found ${count} sessions`));
      const sessionLines = visible.split(/\r?\n/).filter((l) => l.includes(".jsonl"));
      assert.equal(sessionLines.length, 10);
      assert.match(visible, /session-00\.jsonl/);
      assert.match(visible, /session-09\.jsonl/);
      assert.ok(!visible.includes("session-10.jsonl"));
      assert.match(visible, /\.\.\. and 2 more/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("find with positional expression lists matching sessions", async () => {
    const { home } = seedE2eHome();
    try {
      const { stdout } = await runBinWithEnv(["find", "model:sonnet"], { env: { HOME: home } });
      const visible = stripAnsi(stdout);
      assert.match(visible, /Found \d+ session/);
      assert.match(visible, /e2e-sonnet/);
      assert.ok(!visible.includes("e2e-opus"), "opus-only project should be excluded");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("find 'model:nonexistent' reports no matches", async () => {
    const { home } = seedE2eHome();
    try {
      const { stdout } = await runBinWithEnv(["find", "--filter", "model:nonexistent"], { env: { HOME: home } });
      const visible = stripAnsi(stdout);
      assert.match(visible, /No sessions match/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// E2E: tracequest search
// ---------------------------------------------------------------------------

describe("bin/tracequest.js e2e search", () => {
  test("search finds sessions matching query text", async () => {
    const { home } = seedE2eHome();
    try {
      const { stdout } = await runBinWithEnv(["search", "deploy"], { env: { HOME: home } });
      const visible = stripAnsi(stdout);
      // Should find at least the sonnet session whose prompt contains "deploy"
      assert.match(visible, /Found \d+ result/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("search --format handoff emits Markdown stdout and progress stderr", async () => {
    const { home } = seedE2eHome();
    try {
      const { stdout, stderr } = await runBinWithEnv(["search", "deploy", "--format", "handoff", "--limit", "1"], { env: { HOME: home } });
      assert.match(stdout, /^# TraceQuest Search Handoff\n/);
      assert.match(stdout, /Session `[0-9a-f]{8}`/);
      assert.match(stdout, /tracequest render [0-9a-f]{8}/);
      assert.match(stdout, /tracequest messages [0-9a-f]{8} --pretty/);
      assert.doesNotMatch(stdout, /Discovering sessions|Building index/);
      assert.doesNotMatch(stdout, /\x1b\[/);
      assert.match(stderr, /Discovering sessions/);
      assert.match(stderr, /Building index/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("direct handoff command emits Markdown stdout and progress stderr", async () => {
    const { home } = seedE2eHome();
    try {
      const { stdout, stderr } = await runBinWithEnv(["handoff", "deploy", "--limit", "1"], { env: { HOME: home } });
      assert.match(stdout, /^# TraceQuest Search Handoff\n/);
      assert.match(stdout, /Session `[0-9a-f]{8}`/);
      assert.match(stdout, /Refresh this handoff: `tracequest handoff deploy --limit 1`/);
      assert.match(stdout, /tracequest render [0-9a-f]{8}/);
      assert.match(stdout, /tracequest messages [0-9a-f]{8} --pretty/);
      assert.doesNotMatch(stdout, /Discovering sessions|Building index|Running standup agent/);
      assert.doesNotMatch(stdout, /\x1b\[/);
      assert.match(stderr, /Discovering sessions/);
      assert.match(stderr, /Building index/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("direct handoff command applies --filter before search", async () => {
    const home = mkTmp("bin-e2e-handoff-filter-home-");
    try {
      const includeDir = join(home, ".claude", "projects", "e2e-handoff-include");
      const excludeDir = join(home, ".claude", "projects", "e2e-handoff-exclude");
      mkdirSync(includeDir, { recursive: true });
      mkdirSync(excludeDir, { recursive: true });
      writeClaudeJsonl(includeDir, "include.jsonl",
        richClaudeFixture("e2e-handoff-filter-include", { prompt: "shared direct handoff filter token include" }));
      writeClaudeJsonl(excludeDir, "exclude.jsonl",
        richClaudeFixture("e2e-handoff-filter-exclude", { prompt: "shared direct handoff filter token exclude" }));

      const { stdout, stderr } = await runBinWithEnv([
        "handoff",
        "shared direct handoff filter token",
        "--filter",
        "project:e2e-handoff-include",
        "--limit",
        "5",
      ], { env: { HOME: home } });

      assert.match(stdout, /^# TraceQuest Search Handoff\n/);
      assert.match(stdout, /- Results: 1/);
      assert.match(stdout, /Project: `e2e-handoff-include`/);
      assert.doesNotMatch(stdout, /e2e-handoff-exclude/);
      assert.doesNotMatch(stdout, /Discovering sessions|Filtering sessions|Building index|Running standup agent/);
      assert.doesNotMatch(stdout, /\x1b\[/);
      assert.match(stderr, /Discovering sessions/);
      assert.match(stderr, /Filtering sessions/);
      assert.match(stderr, /Building index for 1 sessions/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("direct handoff command orders matching results by recency when --sort recent", async () => {
    const home = mkTmp("bin-e2e-handoff-sort-home-");
    try {
      const oldDir = join(home, ".claude", "projects", "e2e-handoff-sort-old");
      const newDir = join(home, ".claude", "projects", "e2e-handoff-sort-new");
      mkdirSync(oldDir, { recursive: true });
      mkdirSync(newDir, { recursive: true });
      const oldPath = writeClaudeJsonl(oldDir, "old.jsonl",
        richClaudeFixture("e2e-handoff-sort-old", { prompt: `${"handoff recency needle ".repeat(40)}older high relevance match` }));
      const newPath = writeClaudeJsonl(newDir, "new.jsonl",
        richClaudeFixture("e2e-handoff-sort-new", { prompt: "handoff recency needle newer low relevance match" }));
      const oldMtime = new Date(Date.now() - 86_400_000);
      const newMtime = new Date();
      utimesSync(oldPath, oldMtime, oldMtime);
      utimesSync(newPath, newMtime, newMtime);

      const relevance = await runBinWithEnv([
        "handoff",
        "handoff recency needle",
        "--limit",
        "1",
      ], { env: { HOME: home } });
      assert.match(relevance.stdout, /- Sort: `relevance`/);
      assert.match(relevance.stdout, /Project: `e2e-handoff-sort-old`/);
      assert.doesNotMatch(relevance.stdout, /Project: `e2e-handoff-sort-new`/);

      const { stdout, stderr } = await runBinWithEnv([
        "handoff",
        "handoff recency needle",
        "--sort",
        "recent",
        "--limit",
        "1",
      ], { env: { HOME: home } });

      assert.match(stdout, /^# TraceQuest Search Handoff\n/);
      assert.match(stdout, /- Sort: `recent`/);
      assert.match(stdout, /- Results: 1/);
      assert.match(stdout, /Project: `e2e-handoff-sort-new`/);
      assert.doesNotMatch(stdout, /Project: `e2e-handoff-sort-old`/);
      assert.match(stdout, /Refresh this handoff: `tracequest handoff 'handoff recency needle' --sort recent --limit 1`/);
      assert.doesNotMatch(stdout, /Discovering sessions|Building index|Running standup agent/);
      assert.doesNotMatch(stdout, /\x1b\[/);
      assert.match(stderr, /Discovering sessions/);
      assert.match(stderr, /Building index for 2 sessions/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("search --format handoff accepts direct handoff filter and sort options", async () => {
    const home = mkTmp("bin-e2e-search-handoff-options-home-");
    try {
      const oldDir = join(home, ".claude", "projects", "e2e-search-handoff-include-old");
      const newDir = join(home, ".claude", "projects", "e2e-search-handoff-include-new");
      const excludedDir = join(home, ".claude", "projects", "e2e-search-handoff-exclude");
      mkdirSync(oldDir, { recursive: true });
      mkdirSync(newDir, { recursive: true });
      mkdirSync(excludedDir, { recursive: true });
      const oldPath = writeClaudeJsonl(oldDir, "old.jsonl",
        richClaudeFixture("e2e-search-handoff-options-old", {
          prompt: `${"legacy handoff compat needle ".repeat(40)}older high relevance match`,
        }));
      const newPath = writeClaudeJsonl(newDir, "new.jsonl",
        richClaudeFixture("e2e-search-handoff-options-new", {
          prompt: "legacy handoff compat needle newer low relevance match",
        }));
      writeClaudeJsonl(excludedDir, "excluded.jsonl",
        richClaudeFixture("e2e-search-handoff-options-excluded", {
          prompt: "legacy handoff compat needle excluded match",
        }));
      const oldMtime = new Date(Date.now() - 86_400_000);
      const newMtime = new Date();
      utimesSync(oldPath, oldMtime, oldMtime);
      utimesSync(newPath, newMtime, newMtime);

      const { stdout, stderr } = await runBinWithEnv([
        "search",
        "legacy handoff compat needle",
        "--format",
        "handoff",
        "--filter",
        "project:e2e-search-handoff-include",
        "--sort",
        "recent",
        "--limit",
        "1",
      ], { env: { HOME: home } });

      assert.match(stdout, /^# TraceQuest Search Handoff\n/);
      assert.match(stdout, /- Sort: `recent`/);
      assert.match(stdout, /- Results: 1/);
      assert.match(stdout, /Project: `e2e-search-handoff-include-new`/);
      assert.doesNotMatch(stdout, /e2e-search-handoff-include-old/);
      assert.doesNotMatch(stdout, /e2e-search-handoff-exclude/);
      assert.match(stdout, /Refresh this handoff: `tracequest search 'legacy handoff compat needle' --format handoff --filter project:e2e-search-handoff-include --sort recent --limit 1`/);
      assert.doesNotMatch(stdout, /Discovering sessions|Filtering sessions|Building index|Running standup agent/);
      assert.doesNotMatch(stdout, /\x1b\[/);
      assert.match(stderr, /Discovering sessions/);
      assert.match(stderr, /Filtering sessions/);
      assert.match(stderr, /Building index for 2 sessions/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("search --sort without handoff reports handoff-only usage", async () => {
    const { home } = seedE2eHome();
    try {
      const { stdout, stderr } = await runBinWithEnv([
        "search",
        "deploy",
        "--sort",
        "recent",
      ], { env: { HOME: home }, expectCode: 1 });

      assert.equal(stdout, "");
      assert.match(stderr, /search --sort is only supported with --format handoff/);
      assert.match(stderr, /tracequest handoff <query> --sort recent/);
      assert.doesNotMatch(stderr, /Discovering sessions|Building index|Running standup agent/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("search --format handoff no-match keeps Markdown stdout and progress stderr", async () => {
    const { home } = seedE2eHome();
    try {
      const { stdout, stderr } = await runBinWithEnv([
        "search",
        "zzz_no_match_xyz_12345",
        "--format",
        "handoff",
        "--limit",
        "3",
      ], { env: { HOME: home } });

      assert.match(stdout, /^# TraceQuest Search Handoff\n/);
      assert.match(stdout, /- Query: `zzz_no_match_xyz_12345`/);
      assert.match(stdout, /- Results: 0/);
      assert.match(stdout, /No matching sessions found\./);
      assert.doesNotMatch(stdout, /Discovering sessions|Building index/);
      assert.doesNotMatch(stdout, /\x1b\[/);
      assert.equal(stdout.includes(home), false, "empty handoff should avoid absolute paths");
      assert.doesNotMatch(stdout, /sonnet-session\.jsonl|opus-session\.jsonl/);
      assert.match(stderr, /Discovering sessions/);
      assert.match(stderr, /Building index/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("search --format handoff empty corpus still emits a no-result handoff", async () => {
    const home = mkTmp("bin-e2e-handoff-empty-home-");
    try {
      const { stdout, stderr } = await runBinWithEnv([
        "search",
        "anything",
        "--format",
        "handoff",
        "--limit",
        "3",
      ], { env: { HOME: home } });

      assert.match(stdout, /^# TraceQuest Search Handoff\n/);
      assert.match(stdout, /- Query: `anything`/);
      assert.match(stdout, /- Results: 0/);
      assert.match(stdout, /No matching sessions found\./);
      assert.doesNotMatch(stdout, /No sessions found/);
      assert.doesNotMatch(stdout, /Discovering sessions|Building index/);
      assert.doesNotMatch(stdout, /\x1b\[/);
      assert.match(stderr, /Discovering sessions/);
      assert.doesNotMatch(stderr, /Building index/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("search with no query exits 1", async () => {
    const { stderr } = await runBinWithEnv(["search"], { expectCode: 1 });
    assert.match(stderr, /Error:.*query/i);
  });

  test("search with no matches reports gracefully", async () => {
    const { home } = seedE2eHome();
    try {
      const { stdout } = await runBinWithEnv(["search", "zzz_no_match_xyz_12345"], { env: { HOME: home } });
      const visible = stripAnsi(stdout);
      assert.match(visible, /No sessions match/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// E2E: tracequest standup
// ---------------------------------------------------------------------------

describe("bin/tracequest.js e2e standup", () => {
  test("standup --probe-agents probes synthetic installed agents without sessions or profile loading", async () => {
    const home = mkTmp("bin-e2e-standup-probe-agents-");
    const fakeBin = writeFakeStandupProbePath(home);
    try {
      const { stdout, stderr } = await runBinWithEnv([
        "standup",
        "--probe-agents",
        "--profile",
        "missing-profile-must-not-load",
        "--agent-timeout-ms",
        "1000",
      ], {
        env: {
          HOME: home,
          PATH: fakeBin,
          TRACEQUEST_FAKE_BIN: fakeBin,
        },
      });

      assertProbePreflight(stderr);
      assert.doesNotMatch(stdout, /No sessions found|TraceQuest Standup Request/);
      assert.doesNotMatch(stdout, /TraceQuest standup agent probe:/);
      assert.equal(stdout.includes(home), false, "probe report must not include temp HOME");
      const report = JSON.parse(stdout);
      assert.equal(report.mode, "standup-agent-probe");
      assert.match(report.dataPolicy, /synthetic prompts only/);
      assert.match(report.dataPolicy, /no raw JSONL/);
      assert.equal(report.timeoutMs, 1000);
      assert.deepEqual(report.actions, {
        loadedProfile: false,
        discoveredSessions: false,
        builtCompactInputFromRealTraces: false,
        sentPrivateTraceData: false,
      });
      assert.deepEqual(report.summary, { passed: 1, failed: 0, missing: 2, skipped: 0 });
      assert.deepEqual(report.agents.map((agent) => [agent.id, agent.status]), [
        ["codex", "passed"],
        ["claude", "missing"],
        ["droid", "missing"],
      ]);
      assert.match(report.agents[0].stdoutSnippet, /TQ_AGENT_PROBE_CODEX_OK/);
      assert.match(report.agents[0].args.join(" "), /--skip-git-repo-check/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("standup --probe-agents exit status reflects failed versus missing probes", async () => {
    const missingHome = mkTmp("bin-e2e-standup-probe-missing-");
    try {
      const emptyPath = join(missingHome, "empty-path");
      mkdirSync(emptyPath, { recursive: true });
      const { stdout, stderr } = await runBinWithEnv(["standup", "--probe-agents"], {
        env: {
          HOME: missingHome,
          PATH: emptyPath,
          TRACEQUEST_STANDUP_AGENT_COMMAND: "",
          TRACEQUEST_STANDUP_AGENT_ARGS: "",
          TRACEQUEST_STANDUP_AGENT_TIMEOUT_MS: "",
        },
      });

      assertProbePreflight(stderr);
      const report = JSON.parse(stdout);
      assert.deepEqual(report.summary, { passed: 0, failed: 0, missing: 3, skipped: 0 });
      assert.deepEqual(report.agents.map((agent) => [agent.id, agent.status]), [
        ["codex", "missing"],
        ["claude", "missing"],
        ["droid", "missing"],
      ]);
    } finally {
      rmSync(missingHome, { recursive: true, force: true });
    }

    const failedHome = mkTmp("bin-e2e-standup-probe-failed-");
    try {
      const binDir = join(failedHome, "bin");
      mkdirSync(binDir, { recursive: true });
      const fakeWhich = join(binDir, "which");
      writeFileSync(fakeWhich, [
        "#!/bin/sh",
        "case \"$1\" in",
        "  codex) printf '%s\\n' \"$TRACEQUEST_FAKE_BIN/codex\"; exit 0 ;;",
        "esac",
        "exit 1",
        "",
      ].join("\n"));
      chmodSync(fakeWhich, 0o755);
      const fakeCodex = join(binDir, "codex");
      writeFileSync(fakeCodex, [
        "#!/bin/sh",
        "while IFS= read -r line || [ -n \"$line\" ]; do",
        "  :",
        "done",
        "printf '%s\\n' 'Refusing request that mentions TQ_AGENT_PROBE_CODEX_OK in diagnostics only.'",
        "exit 0",
        "",
      ].join("\n"));
      chmodSync(fakeCodex, 0o755);

      const { stdout, stderr } = await runBinWithEnv(["standup", "--probe-agents", "--agent-timeout-ms", "1000"], {
        expectCode: 1,
        env: {
          HOME: failedHome,
          PATH: binDir,
          TRACEQUEST_FAKE_BIN: binDir,
          TRACEQUEST_STANDUP_AGENT_COMMAND: "",
          TRACEQUEST_STANDUP_AGENT_ARGS: "",
          TRACEQUEST_STANDUP_AGENT_TIMEOUT_MS: "",
        },
      });

      assertProbePreflight(stderr);
      const report = JSON.parse(stdout);
      assert.deepEqual(report.summary, { passed: 0, failed: 1, missing: 2, skipped: 0 });
      assert.deepEqual(report.agents.map((agent) => [agent.id, agent.status]), [
        ["codex", "failed"],
        ["claude", "missing"],
        ["droid", "missing"],
      ]);
      assert.equal(report.agents[0].reason, "sentinel line not found in stdout");
      assert.match(report.agents[0].stdoutSnippet, /TQ_AGENT_PROBE_CODEX_OK/);
    } finally {
      rmSync(failedHome, { recursive: true, force: true });
    }
  });

  test("standup dry-run agent detection is accepted by the real bin parser without sessions or agent invocation", async () => {
    const home = mkTmp("bin-e2e-standup-dry-run-");
    const marker = join(home, "dry-run-agent-ran");
    const agentCode = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`;
    try {
      const { stdout, stderr } = await runBinWithEnv([
        "standup",
        "--dry-run-agent-detection",
        "--agent-command",
        NODE,
        "--agent-arg=-e",
        "--agent-arg",
        agentCode,
        "--param",
        "model=bin-dry-run",
      ], { env: { HOME: home } });

      assert.equal(stderr, "");
      assert.equal(existsSync(marker), false);
      assert.doesNotMatch(stdout, /TraceQuest Standup Request|Omitted: raw JSONL|Running standup agent|No sessions found/);
      const report = JSON.parse(stdout);
      assert.equal(report.mode, "standup-agent-detection-dry-run");
      assert.deepEqual(report.agent, {
        id: "configured",
        source: "configured",
        command: NODE,
        args: ["-e", agentCode, "--model", "bin-dry-run"],
        input: "stdin",
      });
      assert.equal(report.actions.discoveredSessions, false);
      assert.equal(report.actions.builtCompactInput, false);
      assert.equal(report.actions.sentPrompt, false);
      assert.equal(report.actions.invokedAgent, false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("standup dry-run agent detection uses default candidate detection without invoking the detected command", async () => {
    const home = mkTmp("bin-e2e-standup-dry-run-default-");
    const binDir = join(home, "bin");
    const marker = join(home, "detected-agent-ran");
    try {
      mkdirSync(binDir, { recursive: true });
      const fakeCodex = join(binDir, "codex");
      writeFileSync(fakeCodex, "#!/bin/sh\nprintf ran > \"$TRACEQUEST_DRY_RUN_MARKER\"\nexit 99\n");
      chmodSync(fakeCodex, 0o755);

      const { stdout, stderr } = await runBinWithEnv([
        "standup",
        "--dry-run-agent-detection",
      ], {
        env: {
          HOME: home,
          PATH: `${binDir}:${process.env.PATH || ""}`,
          TRACEQUEST_DRY_RUN_MARKER: marker,
          TRACEQUEST_STANDUP_AGENT_COMMAND: "",
          TRACEQUEST_STANDUP_AGENT_ARGS: "",
          TRACEQUEST_STANDUP_AGENT_TIMEOUT_MS: "",
        },
      });

      assert.equal(stderr, "");
      assert.equal(existsSync(marker), false);
      assert.doesNotMatch(stdout, /TraceQuest Standup Request|No sessions found/);
      const report = JSON.parse(stdout);
      assert.deepEqual(report.agent, {
        id: "codex",
        source: "detected",
        command: "codex",
        args: ["exec", "--skip-git-repo-check", "-"],
        input: "stdin",
      });
      assert.equal(report.actions.invokedAgent, false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("standup --since --print-input is accepted by the real bin parser", async () => {
    const { home } = seedE2eHome();
    try {
      const { stdout, stderr } = await runBinWithEnv([
        "standup",
        "--since",
        "1d",
        "--print-input",
        "--limit",
        "1",
      ], { env: { HOME: home } });

      assert.match(stdout, /^# TraceQuest Standup Request\n/);
      assert.match(stdout, /Window: since 1d/);
      assert.match(stdout, /Omitted: raw JSONL/);
      assert.equal(stderr, "");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("standup --print-input privacy regression runs through real bin with compact summaries", async () => {
    const home = mkTmp("bin-e2e-standup-privacy-");
    const project = "standup-privacy-bin";
    const projectDir = join(home, ".claude", "projects", project);
    const promptTail = "FULL_PRIVATE_PROMPT_TAIL_SENTINEL_BIN_16NF";
    const replyTail = "FULL_PRIVATE_ASSISTANT_TAIL_SENTINEL_BIN_27PG";
    const rawJsonlSentinel = "RAW_JSONL_RECORD_SENTINEL_BIN_38QH";
    const absPathSentinel = "ABSOLUTE_SESSION_PATH_SENTINEL_BIN_49RJ";
    const toolOutputSentinel = "FULL_TOOL_OUTPUT_SENTINEL_BIN_50SK";
    let sessionPath = "";

    try {
      mkdirSync(projectDir, { recursive: true });
      sessionPath = writeClaudeJsonl(
        projectDir,
        "privacy.jsonl",
        privacyClaudeFixture("standup-privacy-bin-session", {
          promptTail,
          replyTail,
          rawJsonlSentinel,
          absPathSentinel,
          toolOutputSentinel,
        }),
      );

      const { stdout, stderr } = await runBinWithEnv([
        "standup",
        project,
        "--print-input",
        "--limit",
        "1",
      ], { env: { HOME: home } });

      assert.match(stdout, /^# TraceQuest Standup Request\n/);
      assert.match(stdout, /Omitted: raw JSONL/);
      assert.match(stdout, /Sessions selected: 1 of 1/);
      assert.match(stdout, /Project: standup-privacy-bin/);
      assert.match(stdout, /Investigate compact-input privacy regression/);
      assert.match(stdout, /Added focused regression coverage/);
      assert.match(stdout, /Bash x1, Read x1/);
      assert.match(stdout, /Commands: \[ok\] npm run test:privacy -- --log \.\.\.\/secret-output\.log/);
      assert.match(stdout, /Files: private\/config\.secret \(Read\)/);
      assert.match(stdout, /\.\.\./);

      for (const privateNeedle of [
        promptTail,
        replyTail,
        rawJsonlSentinel,
        `"rawTraceSentinel":"${rawJsonlSentinel}"`,
        absPathSentinel,
        toolOutputSentinel,
        "private command output",
        "private file contents",
        sessionPath,
        projectDir,
        home,
        "privacy.jsonl",
        "\"type\":\"user\"",
        "\"type\":\"tool_result\"",
        "\"sessionId\":\"standup-privacy-bin-session\"",
      ]) {
        assert.ok(!stdout.includes(privateNeedle), `bin --print-input leaked ${privateNeedle}`);
      }
      assert.equal(stderr, "");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("standup --today and --yesterday filter at the real bin boundary", async () => {
    const { home } = seedE2eStandupWindowHome();
    try {
      const today = await runBinWithEnv([
        "standup",
        "--today",
        "--print-input",
        "--limit",
        "5",
      ], { env: { HOME: home } });

      assert.match(today.stdout, /^# TraceQuest Standup Request\n/);
      assert.match(today.stdout, /Window: today/);
      assert.match(today.stdout, /today standup e2e prompt/);
      assert.doesNotMatch(today.stdout, /yesterday standup e2e prompt/);
      assert.equal(today.stderr, "");

      const yesterday = await runBinWithEnv([
        "standup",
        "--yesterday",
        "--print-input",
        "--limit",
        "5",
      ], { env: { HOME: home } });

      assert.match(yesterday.stdout, /^# TraceQuest Standup Request\n/);
      assert.match(yesterday.stdout, /Window: yesterday/);
      assert.match(yesterday.stdout, /yesterday standup e2e prompt/);
      assert.doesNotMatch(yesterday.stdout, /today standup e2e prompt/);
      assert.equal(yesterday.stderr, "");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("standup --workday filters at the real bin boundary", async () => {
    const { home } = seedE2eStandupWindowHome();
    try {
      const { stdout, stderr } = await runBinWithEnv([
        "standup",
        "--workday",
        "--print-input",
        "--limit",
        "5",
      ], { env: { HOME: home, TRACEQUEST_NO_SIDECAR: "1" } });

      assert.match(stdout, /^# TraceQuest Standup Request\n/);
      assert.match(stdout, /Window: workday \(09:00-17:00 local\)/);
      assert.match(stdout, /today standup e2e prompt/);
      assert.doesNotMatch(stdout, /after workday standup e2e prompt/);
      assert.doesNotMatch(stdout, /yesterday standup e2e prompt/);
      assert.equal(stderr, "");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("standup --previous-workday filters at the real bin boundary", async () => {
    const { home } = seedE2eStandupWindowHome();
    try {
      const { stdout, stderr } = await runBinWithEnv([
        "standup",
        "--previous-workday",
        "--print-input",
        "--limit",
        "5",
      ], { env: { HOME: home, TRACEQUEST_NO_SIDECAR: "1" } });

      assert.match(stdout, /^# TraceQuest Standup Request\n/);
      assert.match(stdout, /Window: previous workday \(09:00-17:00 local\)/);
      assert.match(stdout, /previous workday standup e2e prompt/);
      assert.doesNotMatch(stdout, /early previous workday standup e2e prompt/);
      assert.doesNotMatch(stdout, /today standup e2e prompt/);
      assert.doesNotMatch(stdout, /after workday standup e2e prompt/);
      assert.equal(stderr, "");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("standup runs configured fixture agent with compact input", async () => {
    const { home } = seedE2eHome();
    const agentCode = [
      "let stdin = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { stdin += chunk; });",
      "process.stdin.on('end', () => {",
      "  const contract = {",
      "    hasHeader: stdin.includes('# TraceQuest Standup Request'),",
      "    hasInstructions: stdin.includes('## Prompt-Agent Instructions'),",
      "    hasSectionContract: stdin.includes('Use sections: Progress, Risks/Blockers, and Next Steps'),",
      "    hasSummariesOnly: stdin.includes('Use only the compact summaries below'),",
      "    hasPrivacyDiscipline: stdin.includes('Do not request, infer, or reconstruct raw JSONL'),",
      "    hasPrivacyBoundary: stdin.includes('Omitted: raw JSONL'),",
      "    hasRawJsonl: stdin.includes('\"type\":\"user\"'),",
      "    argv: process.argv.slice(1),",
      "  };",
      "  if (!contract.hasHeader || !contract.hasInstructions || !contract.hasSectionContract || !contract.hasSummariesOnly || !contract.hasPrivacyDiscipline || contract.hasRawJsonl) {",
      "    process.stdout.write(JSON.stringify(contract));",
      "    process.exit(7);",
      "  }",
      "  process.stdout.write([",
      "    '## Progress',",
      "    '- Fake agent received compact standup summaries.',",
      "    '',",
      "    '## Risks/Blockers',",
      "    '- No synthetic blocker.',",
      "    '',",
      "    '## Next Steps',",
      "    '- Keep compact prompt validation in the fake-agent path.',",
      "    '',",
      "    `TRACEQUEST_AGENT_CONTRACT ${JSON.stringify(contract)}`,",
      "    '',",
      "  ].join('\\n'));",
      "});",
    ].join("\n");

    try {
      const { stdout, stderr } = await runBinWithEnv([
        "standup",
        "--limit",
        "1",
        "--agent-command",
        NODE,
        "--agent-arg=-e",
        "--agent-arg",
        agentCode,
        "--agent-arg=--",
        "--param",
        "model=standup-e2e",
      ], { env: { HOME: home } });

      assert.match(stdout, /^## Progress\n/);
      assert.match(stdout, /^## Risks\/Blockers$/m);
      assert.match(stdout, /^## Next Steps$/m);
      const contractMatch = stdout.match(/^TRACEQUEST_AGENT_CONTRACT (.+)$/m);
      assert.ok(contractMatch, `expected fake-agent contract marker in stdout, got: ${stdout}`);
      const result = JSON.parse(contractMatch[1]);
      assert.equal(result.hasHeader, true);
      assert.equal(result.hasInstructions, true);
      assert.equal(result.hasSectionContract, true);
      assert.equal(result.hasSummariesOnly, true);
      assert.equal(result.hasPrivacyDiscipline, true);
      assert.equal(result.hasPrivacyBoundary, true);
      assert.equal(result.hasRawJsonl, false);
      assert.deepEqual(result.argv, ["--model", "standup-e2e"]);
      assert.match(stderr, /Running standup agent:/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("standup streams configured agent output before the agent exits", async () => {
    const { home } = seedE2eHome();
    const flagPath = join(home, "standup-stream-agent-started");
    const agentCode = [
      "const { writeFileSync } = require('node:fs');",
      `const flagPath = ${JSON.stringify(flagPath)};`,
      "let stdin = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { stdin += chunk; });",
      "process.stdin.on('end', () => {",
      "  if (!stdin.includes('# TraceQuest Standup Request')) process.exit(4);",
      "  writeFileSync(flagPath, 'started');",
      "  process.stdout.write('stream-first\\n');",
      "  process.stderr.write('stream-err\\n');",
      "  setTimeout(() => { process.stdout.write('stream-last\\n'); }, 260);",
      "  setTimeout(() => { process.exit(0); }, 500);",
      "});",
    ].join("\n");

    const child = spawn(NODE, [
      BIN,
      "standup",
      "--limit",
      "1",
      "--agent-command",
      NODE,
      "--agent-arg=-e",
      "--agent-arg",
      agentCode,
    ], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TRACEQUEST_NO_SIDECAR: "1", HOME: home },
    });
    let stdout = "";
    let stderr = "";
    let closeCode;
    let resolveFirst;
    const firstStdout = new Promise((resolve) => { resolveFirst = resolve; });
    const closePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("streaming standup bin timeout"));
      }, 10_000);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        closeCode = code;
        resolve(code);
      });
    });
    child.stdout.on("data", (d) => {
      stdout += d;
      if (stdout.includes("stream-first")) resolveFirst();
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });

    try {
      await waitForFile(flagPath);
      const streamed = await Promise.race([
        firstStdout.then(() => true),
        delay(200).then(() => false),
      ]);
      assert.equal(streamed, true, `expected early streamed stdout, got stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`);
      assert.equal(closeCode, undefined);
      assert.equal(child.exitCode, null);

      const code = await closePromise;
      assert.equal(code, 0);
      assert.match(stdout, /stream-first\nstream-last\n/);
      assert.match(stderr, /Running standup agent:/);
      assert.match(stderr, /stream-err/);
    } finally {
      if (closeCode === undefined && child.exitCode === null) child.kill("SIGTERM");
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("standup uses TRACEQUEST_STANDUP_AGENT_* defaults through real bin", async () => {
    const { home } = seedE2eHome();
    const agentCode = [
      "let stdin = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { stdin += chunk; });",
      "process.stdin.on('end', () => {",
      "  process.stdout.write(JSON.stringify({",
      "    argv: process.argv.slice(1),",
      "    hasHeader: stdin.includes('# TraceQuest Standup Request'),",
      "    hasPrivacyBoundary: stdin.includes('Omitted: raw JSONL'),",
      "    hasRawJsonl: stdin.includes('\"type\":\"user\"'),",
      "    hasPrompt: stdin.includes('deploy the sonnet application') || stdin.includes('refactor the opus module'),",
      "  }));",
      "});",
    ].join("\n");

    try {
      const { stdout, stderr } = await runBinWithEnv([
        "standup",
        "--limit",
        "1",
        "--param",
        "model=standup-env-e2e",
      ], {
        env: {
          HOME: home,
          TRACEQUEST_STANDUP_AGENT_COMMAND: NODE,
          TRACEQUEST_STANDUP_AGENT_ARGS: JSON.stringify(["-e", agentCode, "--", "--env-default"]),
          TRACEQUEST_STANDUP_AGENT_TIMEOUT_MS: "2345",
        },
      });

      const result = JSON.parse(stdout);
      assert.deepEqual(result.argv, ["--env-default", "--model", "standup-env-e2e"]);
      assert.equal(result.hasHeader, true);
      assert.equal(result.hasPrivacyBoundary, true);
      assert.equal(result.hasRawJsonl, false);
      assert.equal(result.hasPrompt, true);
      assert.match(stderr, /Running standup agent:/);
      assert.match(stderr, /timeout 2345ms/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("standup profiles load config through real bin and CLI overrides profile values", async () => {
    const { home } = seedE2eHome();
    const agentCode = [
      "let stdin = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { stdin += chunk; });",
      "process.stdin.on('end', () => {",
      "  process.stdout.write(JSON.stringify({",
      "    argv: process.argv.slice(1),",
      "    hasHeader: stdin.includes('# TraceQuest Standup Request'),",
      "    hasPrivacyBoundary: stdin.includes('Omitted: raw JSONL'),",
      "    hasRawJsonl: stdin.includes('\"type\":\"user\"'),",
      "    hasSonnet: stdin.includes('deploy the sonnet application'),",
      "    hasOpus: stdin.includes('refactor the opus module'),",
      "  }));",
      "});",
    ].join("\n");

    try {
      writeStandupProfiles(home, {
        daily: {
          project: "e2e-sonnet",
          limit: 1,
          agentCommand: NODE,
          agentArgs: ["-e", agentCode, "--", "--profile-e2e"],
          agentTimeoutMs: 9999,
          params: {
            model: "profile-model",
          },
        },
      });

      const { stdout, stderr } = await runBinWithEnv([
        "standup",
        "--profile",
        "daily",
        "--param",
        "model=cli-e2e",
        "--agent-timeout-ms",
        "3456",
      ], { env: { HOME: home } });

      const result = JSON.parse(stdout);
      assert.deepEqual(result.argv, ["--profile-e2e", "--model", "cli-e2e"]);
      assert.equal(result.hasHeader, true);
      assert.equal(result.hasPrivacyBoundary, true);
      assert.equal(result.hasRawJsonl, false);
      assert.equal(result.hasSonnet, true);
      assert.equal(result.hasOpus, false);
      assert.match(stderr, /Running standup agent:/);
      assert.match(stderr, /timeout 3456ms/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("standup mixed partial agent overrides through real bin", async () => {
    const home = mkTmp("bin-e2e-standup-agent-overrides-");
    const env = {
      HOME: home,
      TRACEQUEST_STANDUP_AGENT_COMMAND: "env-agent",
      TRACEQUEST_STANDUP_AGENT_ARGS: JSON.stringify(["--from-env"]),
      TRACEQUEST_STANDUP_AGENT_TIMEOUT_MS: "1111",
    };

    try {
      writeStandupProfiles(home, {
        daily: {
          project: "profile-project-with-no-sessions",
          agentCommand: "profile-agent",
          agentArgs: ["--from-profile"],
          agentTimeoutMs: 2222,
          params: { model: "profile-model" },
        },
        commandOnly: {
          project: "profile-project-with-no-sessions",
          agentCommand: "profile-agent",
          agentTimeoutMs: 2222,
        },
      });

      const commandOverride = await runBinWithEnv([
        "standup",
        "--profile",
        "daily",
        "--dry-run-agent-detection",
        "--agent-command",
        "cli-agent",
      ], { env });
      assert.equal(commandOverride.stderr, "");
      const commandReport = JSON.parse(commandOverride.stdout);
      assert.equal(commandReport.agent.command, "cli-agent");
      assert.deepEqual(commandReport.agent.args, []);
      assert.equal(commandReport.timeoutMs, 2222);
      assert.equal(commandReport.actions.discoveredSessions, false);
      assert.equal(commandReport.actions.invokedAgent, false);

      const profileCommandOnly = await runBinWithEnv([
        "standup",
        "--profile",
        "commandOnly",
        "--dry-run-agent-detection",
      ], { env });
      assert.equal(profileCommandOnly.stderr, "");
      const profileReport = JSON.parse(profileCommandOnly.stdout);
      assert.equal(profileReport.agent.command, "profile-agent");
      assert.deepEqual(profileReport.agent.args, []);
      assert.equal(profileReport.timeoutMs, 2222);
      assert.equal(profileReport.actions.discoveredSessions, false);
      assert.equal(profileReport.actions.invokedAgent, false);

      const argsOverride = await runBinWithEnv([
        "standup",
        "--profile",
        "daily",
        "--dry-run-agent-detection",
        "--agent-arg=--from-cli",
      ], { env });
      assert.equal(argsOverride.stderr, "");
      const argsReport = JSON.parse(argsOverride.stdout);
      assert.equal(argsReport.agent.command, "profile-agent");
      assert.deepEqual(argsReport.agent.args, ["--from-cli", "--model", "profile-model"]);
      assert.equal(argsReport.timeoutMs, 2222);
      assert.equal(argsReport.actions.discoveredSessions, false);
      assert.equal(argsReport.actions.invokedAgent, false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("standup profile print-input audit skips profile-configured agent through real bin", async () => {
    const { home } = seedE2eHome();
    try {
      writeStandupProfiles(home, {
        audit: {
          project: "e2e-sonnet",
          limit: 1,
          agentCommand: NODE,
          agentArgs: ["-e", "process.stdout.write('PROFILE E2E AGENT SHOULD NOT RUN')"],
        },
      });

      const { stdout, stderr } = await runBinWithEnv([
        "standup",
        "--profile",
        "audit",
        "--print-input",
      ], { env: { HOME: home } });

      assert.match(stdout, /^# TraceQuest Standup Request\n/);
      assert.match(stdout, /deploy the sonnet application/);
      assert.match(stdout, /Omitted: raw JSONL/);
      assert.doesNotMatch(stdout, /PROFILE E2E AGENT SHOULD NOT RUN/);
      assert.equal(stderr, "");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("standup --agent-timeout-ms exits with clear timeout error", async () => {
    const { home } = seedE2eHome();
    const agentCode = "process.stdin.resume(); setInterval(() => {}, 1000);";

    try {
      const { stdout, stderr } = await runBinWithEnv([
        "standup",
        "--limit",
        "1",
        "--agent-command",
        NODE,
        "--agent-arg=-e",
        "--agent-arg",
        agentCode,
        "--agent-timeout-ms",
        "50",
      ], { env: { HOME: home }, expectCode: 1, timeoutMs: 10_000 });

      assert.equal(stdout, "");
      assert.match(stderr, /Running standup agent:/);
      assert.match(stderr, /Error: Standup agent timed out after 50ms/);
      assert.match(stderr, /Command: /);
      assert.match(stderr, /Stdout: \(empty\)/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("standup timeout diagnostics preserve bounded noisy agent tails through real bin", async () => {
    const home = mkTmp("bin-e2e-standup-timeout-noisy-");
    const project = "standup-timeout-noisy-bin";
    const projectDir = join(home, ".claude", "projects", project);
    const promptSentinel = "TQ_TIMEOUT_COMPACT_INPUT_PRIVATE";
    const assistantSentinel = "TQ_TIMEOUT_ASSISTANT_PRIVATE";
    const rawJsonlSentinel = "TQ_TIMEOUT_RAW_JSONL_PRIVATE";
    const agentScript = join(home, "noisy-timeout-agent.mjs");

    try {
      mkdirSync(projectDir, { recursive: true });
      const fixture = richClaudeFixture("standup-timeout-noisy-bin-session", {
        prompt: `standup timeout compact prompt ${promptSentinel}`,
        tools: ["Read"],
      });
      fixture[0].rawTraceSentinel = rawJsonlSentinel;
      fixture[1].message.content[0].text = `standup timeout assistant summary ${assistantSentinel}`;
      const sessionPath = writeClaudeJsonl(projectDir, "timeout-noisy-session.jsonl", fixture);
      writeFileSync(agentScript, [
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', () => {});",
        "process.stdin.resume();",
        "process.stdout.write('BIN_STDOUT_HEAD_' + 'o'.repeat(900) + 'BIN_STDOUT_MIDDLE_SHOULD_NOT_APPEAR_IN_DIAG' + 'o'.repeat(900) + 'BIN_STDOUT_TAIL_NO_NEWLINE');",
        "process.stderr.write('BIN_STDERR_HEAD_' + 'e'.repeat(900) + 'BIN_STDERR_MIDDLE_SHOULD_NOT_APPEAR_IN_DIAG' + 'e'.repeat(900) + 'BIN_STDERR_TAIL_NO_NEWLINE');",
        "setInterval(() => {}, 1000);",
      ].join("\n"));

      const { stdout, stderr } = await runBinWithEnv([
        "standup",
        project,
        "--limit",
        "1",
        "--agent-command",
        NODE,
        "--agent-arg",
        agentScript,
        "--agent-timeout-ms",
        "250",
      ], { env: { HOME: home }, expectCode: 1, timeoutMs: 10_000 });

      const visibleStderr = stripAnsi(stderr);
      assert.match(stdout, /BIN_STDOUT_HEAD_/);
      assert.match(stdout, /BIN_STDOUT_TAIL_NO_NEWLINE/);
      assert.match(visibleStderr, /BIN_STDERR_HEAD_/);
      assert.match(visibleStderr, /BIN_STDERR_TAIL_NO_NEWLINE\nError: Standup agent timed out after 250ms\./);

      const diagnosticStart = visibleStderr.lastIndexOf("Error: Standup agent timed out");
      assert.ok(diagnosticStart >= 0, `missing timeout diagnostic in stderr: ${visibleStderr}`);
      const diagnostic = visibleStderr.slice(diagnosticStart);
      const stdoutSnippet = (diagnostic.match(/Stdout: ([\s\S]*?)\nStderr:/)?.[1] || "").trimEnd();
      const stderrSnippet = (diagnostic.match(/Stderr: ([\s\S]*?)\n?$/)?.[1] || "").trimEnd();
      assert.ok(stdoutSnippet.length <= 700, `stdout diagnostic should stay bounded, got ${stdoutSnippet.length} chars`);
      assert.ok(stderrSnippet.length <= 700, `stderr diagnostic should stay bounded, got ${stderrSnippet.length} chars`);
      assert.match(diagnostic, /Stdout: BIN_STDOUT_HEAD_/);
      assert.match(diagnostic, /BIN_STDOUT_TAIL_NO_NEWLINE/);
      assert.doesNotMatch(diagnostic, /BIN_STDOUT_MIDDLE_SHOULD_NOT_APPEAR_IN_DIAG/);
      assert.match(diagnostic, /Stderr: BIN_STDERR_HEAD_/);
      assert.match(diagnostic, /BIN_STDERR_TAIL_NO_NEWLINE/);
      assert.doesNotMatch(diagnostic, /BIN_STDERR_MIDDLE_SHOULD_NOT_APPEAR_IN_DIAG/);
      assert.match(diagnostic, /\.\.\. \[truncated\] \.\.\./);

      const combinedOutput = `${stdout}\n${visibleStderr}`;
      for (const privateNeedle of [
        "# TraceQuest Standup Request",
        "Omitted: raw JSONL",
        promptSentinel,
        assistantSentinel,
        rawJsonlSentinel,
        "\"type\":\"user\"",
        sessionPath,
        projectDir,
      ]) {
        assert.equal(
          combinedOutput.includes(privateNeedle),
          false,
          `timeout e2e leaked ${privateNeedle}`,
        );
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("standup no-session and no-agent errors are stderr-only through real bin", async () => {
    const emptyHome = mkTmp("bin-e2e-standup-empty-home-");
    try {
      const { stdout, stderr } = await runBinWithEnv([
        "standup",
        "--print-input",
      ], {
        env: {
          HOME: emptyHome,
          TRACEQUEST_STANDUP_AGENT_COMMAND: NODE,
        },
        expectCode: 1,
      });

      assert.equal(stdout, "");
      assert.match(stderr, /Error: No sessions found\./);
      assert.doesNotMatch(stderr, /TraceQuest Standup Request|Running standup agent/);
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }

    const { home } = seedE2eHome();
    try {
      const { stdout, stderr } = await runBinWithEnv([
        "standup",
        "--limit",
        "1",
      ], {
        env: {
          HOME: home,
          PATH: "",
          TRACEQUEST_STANDUP_AGENT_COMMAND: "",
          TRACEQUEST_STANDUP_AGENT_ARGS: "",
          TRACEQUEST_STANDUP_AGENT_TIMEOUT_MS: "",
        },
        expectCode: 1,
      });

      assert.equal(stdout, "");
      assert.match(stderr, /Error: No prompt-mode agent command found\./);
      assert.match(stderr, /Tried: codex, claude, droid\./);
      assert.match(stderr, /--agent-command/);
      assert.doesNotMatch(stderr, /TraceQuest Standup Request|Running standup agent/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("standup missing agent is reported before selected sessions are parsed through real bin", async () => {
    const home = mkTmp("bin-e2e-standup-no-agent-invalid-");
    const project = "standup-no-agent-invalid-bin";
    const projectDir = join(home, ".claude", "projects", project);
    const poisonFilename = "poison-private-session.jsonl";
    const poisonContent = "not a valid jsonl private-parse-sentinel-bin\n";
    const sessionPath = join(projectDir, poisonFilename);

    try {
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(sessionPath, poisonContent);
      const now = Date.now() / 1000;
      utimesSync(sessionPath, now, now);
      chmodSync(sessionPath, 0o000);

      const { stdout, stderr } = await runBinWithEnv([
        "standup",
        project,
        "--limit",
        "1",
      ], {
        env: {
          HOME: home,
          PATH: "",
          TRACEQUEST_STANDUP_AGENT_COMMAND: "",
          TRACEQUEST_STANDUP_AGENT_ARGS: "",
          TRACEQUEST_STANDUP_AGENT_TIMEOUT_MS: "",
        },
        expectCode: 1,
      });

      assert.equal(stdout, "");
      assert.match(stderr, /Error: No prompt-mode agent command found\./);
      assert.match(stderr, /Tried: codex, claude, droid\./);
      assert.match(stderr, /--agent-command/);
      assert.doesNotMatch(
        stderr,
        /parseJsonlLine: malformed JSONL line|Failed to parse session|TraceQuest Standup Request|Omitted: raw JSONL|Sessions selected|Running standup agent/,
      );

      const combinedOutput = `${stdout}\n${stderr}`;
      for (const privateNeedle of [
        sessionPath,
        projectDir,
        home,
        poisonFilename,
        poisonContent.trim(),
        "private-parse-sentinel-bin",
      ]) {
        assert.equal(
          combinedOutput.includes(privateNeedle),
          false,
          `missing-agent e2e leaked ${privateNeedle}`,
        );
      }
    } finally {
      if (existsSync(sessionPath)) chmodSync(sessionPath, 0o600);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("standup help documents selection windows, env defaults, and prompt agents", async () => {
    const { stdout } = await runBin(["standup", "--help"]);
    assert.match(stdout, /standup Options:/);
    assert.match(stdout, /--print-input/);
    assert.match(stdout, /--profile/);
    assert.match(stdout, /--since/);
    assert.match(stdout, /--today/);
    assert.match(stdout, /--yesterday/);
    assert.match(stdout, /--workday/);
    assert.match(stdout, /--previous-workday/);
    assert.match(stdout, /--dry-run-agent-detection/);
    assert.match(stdout, /--probe-agents/);
    assert.match(stdout, /--agent-command/);
    assert.match(stdout, /--agent-timeout-ms/);
    assert.match(stdout, /TRACEQUEST_STANDUP_AGENT_COMMAND/);
    assert.match(stdout, /TRACEQUEST_STANDUP_AGENT_ARGS/);
    assert.match(stdout, /TRACEQUEST_STANDUP_AGENT_TIMEOUT_MS/);
    assert.match(stdout, /HOME\/\.tracequest\/standup-profiles\.json/);
    assert.match(stdout, /Profile keys:/);
    assert.match(stdout, /previousWorkday/);
    assert.match(stdout, /--agent-command selects a new agent identity/);
    assert.match(stdout, /does not reuse lower-source\s+agentArgs or params/);
    assert.match(stdout, /Built-in detection: codex exec --skip-git-repo-check -, claude --print, droid exec/);
    assert.match(stdout, /OpenCode must be configured explicitly/);
    assert.match(stdout, /without discovering\s+sessions, building compact input, invoking an agent,\s+or sending a prompt/);
    assert.match(stdout, /synthetic prompts only/);
    assert.match(stdout, /without\s+loading profiles, discovering sessions, real-trace\s+compact-input building, or private prompt sending/);
    assert.match(stdout, /empty temporary directory/);
    assert.match(stdout, /stderr preflight warning before invoking installed agents/);
    assert.match(stdout, /stdout as the JSON probe report/);
    assert.match(stdout, /sentinel as its own stdout line/);
    assert.match(stdout, /verifying stdin/);
    assert.match(stdout, /wrapper that reads stdin/);
    assert.match(stdout, /stdout\/stderr stream live/);
  });

  test("standup profile docs appear in help", async () => {
    const { stdout } = await runBin(["standup", "--help"]);
    assert.match(stdout, /--profile <name>/);
    assert.match(stdout, /HOME\/\.tracequest\/standup-profiles\.json/);
    assert.match(stdout, /previousWorkday/);
    assert.match(stdout, /agentCommand, agentArgs, agentTimeoutMs, params/);
  });

  test("standup previous-workday docs appear in help and README", async () => {
    const { stdout } = await runBin(["standup", "--help"]);
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    assert.match(stdout, /--previous-workday/);
    assert.match(stdout, /previous weekday's\s+local 09:00-17:00 workday/);
    assert.match(stdout, /previousWorkday/);
    assert.match(readme, /--previous-workday --print-input/);
    assert.match(readme, /`since`\/`today`\/`yesterday`\/`workday`\/`previousWorkday`/);
  });

  test("README documents standup windows, env defaults, and prompt agents", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    assert.match(readme, /\*\*standup\*\*/);
    assert.match(readme, /--print-input/);
    assert.match(readme, /--profile daily --print-input/);
    assert.match(readme, /--dry-run-agent-detection/);
    assert.match(readme, /--probe-agents/);
    assert.match(readme, /--since 4h/);
    assert.match(readme, /--workday --print-input/);
    assert.match(readme, /--previous-workday --print-input/);
    assert.match(readme, /--yesterday/);
    assert.match(readme, /TRACEQUEST_STANDUP_AGENT_COMMAND/);
    assert.match(readme, /TRACEQUEST_STANDUP_AGENT_ARGS/);
    assert.match(readme, /TRACEQUEST_STANDUP_AGENT_TIMEOUT_MS/);
    assert.match(readme, /HOME\/\.tracequest\/standup-profiles\.json/);
    assert.match(readme, /previousWorkday/);
    assert.match(readme, /Partial overrides are source-aware/);
    assert.match(readme, /`--agent-command` selects a new agent identity/);
    assert.match(readme, /`--agent-arg` alone can replace args for a profile-provided command/);
    assert.match(readme, /exactly what will be sent to the LLM/);
    assert.match(readme, /does not discover sessions, build compact input, invoke an agent, or send a prompt/);
    assert.match(readme, /npm run probe:standup-agents/);
    assert.match(readme, /empty temporary directory/);
    assert.match(readme, /reports passed, failed, missing, and skipped agents as JSON/);
    assert.match(readme, /Before invoking installed agents, it prints a stderr preflight warning/);
    assert.match(readme, /stdout remains the JSON report/);
    assert.match(readme, /sentinel as its own stdout line/);
    assert.match(readme, /exits 1 if any installed probe fails/);
    assert.match(readme, /missing or skipped optional agents remain JSON statuses/);
    assert.match(readme, /exits before profile loading, session discovery, real-trace compact-input building, or private prompt sending/);
    assert.match(readme, /stdout and stderr stream live/);
    assert.match(readme, /Built-in prompt-agent detection tries Codex \(`codex exec --skip-git-repo-check -`\), Claude \(`claude --print`\), then Droid \(`droid exec`\)/);
    assert.match(readme, /OpenCode is not a built-in default/);
    assert.match(readme, /verified reads the prompt from stdin/);
    assert.match(readme, /wrapper that reads stdin/);
    assert.match(readme, /not raw JSONL, full transcripts/);
  });

  test("standup agent arg docs cover dash-prefixed values", async () => {
    const { stdout: help } = await runBin(["standup", "--help"]);
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");

    assert.match(help, /Use --agent-arg=--flag for values that start with -/);
    assert.match(readme, /When an agent argv value itself starts with `-`/);
    assert.match(readme, /`--agent-arg=--safe-mode`/);
    assert.match(readme, /CLI parser treats the value as a TraceQuest option/);
  });

  test("installed prompt-agent smoke guide documents safe probes and wrappers", () => {
    const guide = readFileSync(join(ROOT, "tests/standup-handoff-smoke.md"), "utf8");
    assert.match(guide, /Optional Installed Agent Probe/);
    assert.match(guide, /npm run probe:standup-agents/);
    assert.match(guide, /tracequest standup --probe-agents/);
    assert.match(guide, /`passed`, `failed`, `missing`, and `skipped`/);
    assert.match(guide, /empty temporary directory/);
    assert.match(guide, /stderr preflight warning before invoking installed agents/);
    assert.match(guide, /Stdout remains parseable JSON/);
    assert.match(guide, /exits before profile loading, session discovery, real-trace compact-input building, or private prompt sending/);
    assert.match(guide, /sentinel as its own stdout line/);
    assert.match(guide, /missing or skipped optional built-in candidate remains a JSON status/);
    assert.match(guide, /exits 1 when any installed candidate fails/);
    assert.match(guide, /diagnostics that merely mention the sentinel/);
    assert.match(guide, /synthetic compact-input smoke only/);
    assert.match(guide, /Do not point manual probes at `HOME\/\.claude`/);
    assert.match(guide, /Do not.*raw JSONL.*private trace content/);
    assert.match(guide, /Passing an installed-agent probe does not add a new built-in default/);
    assert.match(guide, /Local finding on 2026-06-27: PASS/);
    assert.match(guide, /TQ_CLAUDE_STDIN_OK/);
    assert.match(guide, /TQ_DROID_STDIN_OK/);
    assert.match(guide, /TQ_OPENCODE_STDIN_OK/);
    assert.match(guide, /Local finding on 2026-06-27: FAIL/);
    assert.equal(guide.includes('claude --print --safe-mode --no-session-persistence --tools ""'), true);
    assert.equal(guide.includes('droid exec --cwd "$tmp"'), true);
    assert.equal(guide.includes('opencode run --pure --dir "$tmp"'), true);
    assert.match(guide, /Wrapper Guidance for Custom Agents/);
    assert.match(guide, /TraceQuest passes compact standup input.*stdin/);
    assert.match(guide, /custom-agent run --file "\$prompt_file"/);
    assert.match(guide, /custom-agent run "\$prompt"/);
  });

  test("standup probe docs cover help README smoke guide and npm probe:standup-agents script", async () => {
    const { stdout: help } = await runBin(["standup", "--help"]);
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const guide = readFileSync(join(ROOT, "tests/standup-handoff-smoke.md"), "utf8");
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

    assert.match(help, /--probe-agents/);
    assert.match(help, /synthetic prompts only/);
    assert.match(help, /without\s+loading profiles, discovering sessions, real-trace\s+compact-input building, or private prompt sending/);
    assert.match(help, /empty temporary directory/);
    assert.match(help, /stderr preflight warning before invoking installed agents/);
    assert.match(help, /stdout as the JSON probe report/);
    assert.match(help, /sentinel as its own stdout line/);
    assert.match(help, /snippets are bounded and redact paths, temp workdirs,\s+and session-looking identifiers/);
    assert.match(help, /Exit status is 1 if any installed probe fails/);
    assert.match(help, /missing\/skipped optional\s+candidates still report in JSON without making the command fail/);
    assert.match(readme, /tracequest standup --probe-agents/);
    assert.match(readme, /npm run probe:standup-agents/);
    assert.match(readme, /empty temporary directory/);
    assert.match(readme, /reports passed, failed, missing, and skipped agents as JSON/);
    assert.match(readme, /Before invoking installed agents, it prints a stderr preflight warning/);
    assert.match(readme, /stdout remains the JSON report/);
    assert.match(readme, /sentinel as its own stdout line/);
    assert.match(readme, /snippets are bounded and redact paths, temp workdirs, and session-looking identifiers/);
    assert.match(readme, /exits 1 if any installed probe fails/);
    assert.match(guide, /tracequest standup --probe-agents/);
    assert.match(guide, /`passed`, `failed`, `missing`, and `skipped`/);
    assert.match(guide, /empty temporary directory/);
    assert.match(guide, /stderr preflight warning before invoking installed agents/);
    assert.match(guide, /Stdout remains parseable JSON/);
    assert.match(guide, /sentinel as its own stdout line/);
    assert.match(guide, /snippets are bounded and redact paths, temp workdirs, and session-looking identifiers/);
    assert.match(guide, /exits 1 when any installed candidate fails/);
    assert.equal(pkg.scripts["probe:standup-agents"], "node bin/tracequest.js standup --probe-agents");
  });

  test("standup probe opt-in docs keep installed-agent probe out of routine examples", async () => {
    const { stdout: help } = await runBin(["standup", "--help"]);
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");

    const readmeStandupBlock = readme.match(/\*\*standup\*\*:[\s\S]*?```bash\n([\s\S]*?)\n```/)?.[1] ?? "";
    const helpExamples = help.match(/Examples:[\s\S]*?Supported agents:/)?.[0] ?? "";

    assert.doesNotMatch(readmeStandupBlock, /--probe-agents/);
    assert.doesNotMatch(helpExamples, /tracequest standup --probe-agents/);
    assert.match(readme, /Opt-in installed-agent validation:\s*```bash\s*tracequest standup --probe-agents/s);
    assert.match(help, /Opt-in installed-agent validation command:\s+tracequest standup --probe-agents/);
    assert.match(readme, /Use `tracequest standup --probe-agents` or `npm run probe:standup-agents` only when you explicitly want to probe installed built-in prompt agents/);
    assert.match(help, /--probe-agents is separate from normal standup execution/);
  });

  test("standup audit-mode privacy docs align help and README", async () => {
    const { stdout: help } = await runBin(["standup", "--help"]);
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");

    assert.match(help, /--dry-run-agent-detection/);
    assert.match(help, /without discovering\s+sessions, building compact input, invoking an agent,\s+or sending a prompt/);
    assert.match(readme, /does not discover sessions, build compact input, invoke an agent, or send a prompt/);

    assert.match(help, /--probe-agents/);
    assert.match(help, /synthetic prompts only/);
    assert.match(help, /without\s+loading profiles, discovering sessions, real-trace\s+compact-input building, or private prompt sending/);
    assert.match(help, /stderr preflight warning before invoking installed agents/);
    assert.match(help, /stdout as the JSON probe report/);
    assert.match(help, /sentinel as its own stdout line/);
    assert.match(help, /snippets are bounded and redact paths, temp workdirs,\s+and session-looking identifiers/);
    assert.match(help, /Exit status is 1 if any installed probe fails/);
    assert.match(readme, /exits before profile loading, session discovery, real-trace compact-input building, or private prompt sending/);
    assert.match(readme, /sentinel as its own stdout line/);
    assert.match(readme, /Before invoking installed agents, it prints a stderr preflight warning/);
    assert.match(readme, /stdout remains the JSON report/);
    assert.match(readme, /snippets are bounded and redact paths, temp workdirs, and session-looking identifiers/);
    assert.match(readme, /missing or skipped optional agents remain JSON statuses/);
    assert.match(readme, /It does not send raw JSONL, real prompts, assistant replies, tool outputs, or absolute session paths/);
  });

  test("standup and handoff release notes summarize shipped surface", () => {
    const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
    const releaseNotes = changelogReleaseSection(changelog, "0.1.2");

    assert.match(releaseNotes, /tracequest handoff <query>/);
    assert.match(releaseNotes, /tracequest search --format handoff/);
    assert.match(releaseNotes, /non-LLM Markdown handoff summaries/);
    assert.match(releaseNotes, /session hashes, capped privacy-conscious snippets, and concrete follow-up commands/);
    assert.match(releaseNotes, /Direct handoff and `tracequest search --format handoff` support `--sort recent` \/ `--sort date`/);
    assert.match(releaseNotes, /tracequest standup/);
    assert.match(releaseNotes, /compact bounded Markdown input/);
    assert.match(releaseNotes, /instead of raw JSONL, full transcripts, absolute session paths, or full tool outputs/);
    assert.match(releaseNotes, /--dry-run-agent-detection/);
    assert.match(releaseNotes, /--probe-agents/);
    assert.match(releaseNotes, /npm run probe:standup-agents/);
    assert.match(releaseNotes, /npm run smoke:standup-handoff/);
    assert.match(releaseNotes, /npm run smoke:standup-handoff-examples/);
    assert.match(releaseNotes, /npm run verify:standup-handoff/);
    assert.match(releaseNotes, /npm run release:standup-handoff/);
    assert.match(releaseNotes, /OpenCode remains explicit configuration only/);
  });

  test("README quick CLI usage lists standup and handoff commands", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const cliUsage = readme.match(/## CLI Usage[\s\S]*?### All Modes with Examples/)?.[0] ?? "";

    assert.match(cliUsage, /search <query>\s+Full-text search across all sessions/);
    assert.match(cliUsage, /handoff <query>\s+Paste Markdown search handoff without an LLM/);
    assert.match(cliUsage, /standup \[project\]\s+Summarize recent sessions with a local prompt-mode agent/);
    assert.match(cliUsage, /latest \[project\]\s+Render the most recent session/);
    assert.match(cliUsage, /share \[session\]\s+Share a session to Gist or Hugging Face/);
  });

  test("handoff command discoverability appears in help and README", async () => {
    const { stdout: help } = await runBin(["--help"]);
    const visibleHelp = stripAnsi(help);
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");

    assert.match(visibleHelp, /handoff <query>\s+Paste Markdown search handoff without an LLM/);
    assert.match(visibleHelp, /handoff Options:/);
    assert.match(visibleHelp, /With --format handoff: relevance \(default\) or recent\|date/);
    assert.match(visibleHelp, /Direct alias for search --format handoff with the same filter\/limit\/sort options/);
    assert.match(visibleHelp, /Sort by relevance \(default\) or recent\|date/);
    assert.match(visibleHelp, /tracequest handoff "error handling" --limit 5/);
    assert.match(visibleHelp, /tracequest search "error handling" --format handoff --filter "project:tracequest" --sort recent --limit 5/);
    assert.match(visibleHelp, /tracequest handoff "error handling" --sort recent --limit 5/);
    assert.match(visibleHelp, /tracequest handoff "error handling" --sort date --limit 5/);
    assert.match(visibleHelp, /tracequest search "error handling" --format handoff --sort date --limit 5/);
    assert.match(readme, /handoff <query>\s+Paste Markdown search handoff without an LLM/);
    assert.match(readme, /tracequest handoff "error handling" --limit 5/);
    assert.match(readme, /tracequest handoff "error handling" --sort recent --limit 5/);
    assert.match(readme, /tracequest handoff "error handling" --sort date --limit 5/);
    assert.match(readme, /search "error handling" --format handoff --limit 5/);
    assert.match(readme, /search "error handling" --format handoff --filter 'project:tracequest source:claude' --sort recent --limit 5/);
    assert.match(readme, /search "error handling" --format handoff --sort date --limit 5/);
  });

  test("handoff quoted phrase sort tradeoff is documented", async () => {
    const { stdout: help } = await runBin(["--help"]);
    const visibleHelp = stripAnsi(help);
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
    const releaseNotes = changelogReleaseSection(changelog, "0.1.2");

    assert.match(
      visibleHelp,
      /Quoted phrases with recent\/date return exact matches within a bounded scan;\s+older phrase matches may be omitted/,
    );
    assert.match(
      readme,
      /quoted-phrase `--sort recent\|date` keeps returned rows exact but may omit older phrase matches beyond the bounded scan cap/,
    );
    assert.match(
      releaseNotes,
      /quoted-phrase returned rows stay exact, but older phrase matches beyond the bounded scan cap may be omitted/,
    );
    assert.match(releaseNotes, /phrase\/position-aware index/);
  });

  test("standup/handoff maintainer verification script is documented and wired", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const guide = readFileSync(join(ROOT, "tests/standup-handoff-smoke.md"), "utf8");
    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");

    assert.equal(
      pkg.scripts["verify:standup-handoff"],
      "npm run test:standup-handoff-cli && npm run smoke:standup-handoff && npm run smoke:standup-handoff-examples",
    );
    assert.match(readme, /npm run verify:standup-handoff/);
    assert.match(readme, /serial direct CLI command tests, the synthetic standup\/handoff smoke, and the README\/help example smoke/);
    assert.match(readme, /without requiring real installed prompt agents/);
    assert.match(readme, /Run `npm run probe:standup-agents` separately only when installed-agent validation is intentional/);
    assert.match(guide, /npm run verify:standup-handoff/);
    assert.match(guide, /combines serial direct CLI command tests, the synthetic feature smoke, and README\/help example smoke/);
    assert.match(guide, /tracequest handoff <query> --filter <expr>/);
    assert.match(guide, /tracequest handoff <query> --sort recent/);
    assert.match(guide, /tracequest handoff <query> --sort date/);
    assert.match(guide, /tracequest search <query> --format handoff --sort date/);
    assert.match(guide, /--previous-workday --print-input/);
    assert.match(guide, /profile `previousWorkday` default/);
    assert.match(guide, /explicit CLI window overrides the profile previous-workday default/);
    assert.match(ci, /Verify standup\/handoff release surface/);
    assert.match(ci, /TRACEQUEST_SKIP_LR_WATCH=1 npm run verify:standup-handoff/);
    assert.doesNotMatch(ci, /probe:standup-agents|--probe-agents/);
  });

  test("standup/handoff release alias is documented and wired", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const guide = readFileSync(join(ROOT, "tests/standup-handoff-smoke.md"), "utf8");

    assert.equal(pkg.scripts["release:standup-handoff"], "npm run verify:standup-handoff");
    assert.match(readme, /npm run release:standup-handoff/);
    assert.match(readme, /alias for that same synthetic-only gate/);
    assert.match(guide, /npm run release:standup-handoff/);
    assert.match(guide, /release-checklist alias for the same synthetic-only gate/);
    assert.doesNotMatch(pkg.scripts["release:standup-handoff"], /probe:standup-agents|--probe-agents/);
  });

  test("standup/handoff release gate script chain stays synthetic-only", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const visited = new Set();
    const chain = [];

    function visit(scriptName) {
      if (visited.has(scriptName)) return;
      visited.add(scriptName);
      const script = pkg.scripts[scriptName];
      assert.ok(script, `missing package script ${scriptName}`);
      chain.push(`${scriptName}: ${script}`);
      for (const match of script.matchAll(/npm run ([\w:-]+)/g)) {
        visit(match[1]);
      }
    }

    visit("release:standup-handoff");
    const expanded = chain.join("\n");
    assert.match(expanded, /test:standup-handoff-cli/);
    assert.match(expanded, /smoke:standup-handoff/);
    assert.match(expanded, /smoke:standup-handoff-examples/);
    assert.doesNotMatch(expanded, /probe:standup-agents|--probe-agents/);
    assert.doesNotMatch(expanded, /\b(?:codex|claude|droid|opencode)\b/);
  });

  test("standup/handoff direct CLI verification script uses serial test concurrency", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const guide = readFileSync(join(ROOT, "tests/standup-handoff-smoke.md"), "utf8");

    assert.equal(
      pkg.scripts["test:standup-handoff-cli"],
      "TRACEQUEST_SKIP_LR_WATCH=1 node --test --test-concurrency=1 test/cli/cli-commands.test.js",
    );
    assert.match(pkg.scripts["verify:standup-handoff"], /^npm run test:standup-handoff-cli && /);
    assert.match(readme, /npm run test:standup-handoff-cli/);
    assert.match(readme, /--test-concurrency=1/);
    assert.match(readme, /patch stdout, stderr, `process\.exit`, and environment variables/);
    assert.match(guide, /npm run test:standup-handoff-cli/);
    assert.match(guide, /--test-concurrency=1/);
    assert.match(guide, /patch stdout, stderr, `process\.exit`, and environment variables/);
  });

  test("npm probe:standup-agents script is wired to standup --probe-agents", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    assert.equal(pkg.scripts["probe:standup-agents"], "node bin/tracequest.js standup --probe-agents");
  });

  test("standup profile docs appear in README", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    assert.match(readme, /--profile daily --print-input/);
    assert.match(readme, /HOME\/\.tracequest\/standup-profiles\.json/);
    assert.match(readme, /Supported keys are `project`, `filter`, `sort`, `limit`/);
    assert.match(readme, /`since`\/`today`\/`yesterday`\/`workday`/);
    assert.match(readme, /`agentCommand`, `agentArgs`, `agentTimeoutMs`, and `params`/);
    assert.match(readme, /Partial overrides are source-aware/);
  });
});

// ---------------------------------------------------------------------------
// E2E: tracequest list --filter
// ---------------------------------------------------------------------------

describe("bin/tracequest.js e2e list --filter", () => {
  test("list --filter 'source:claude' filters to claude sessions", async () => {
    const { home } = seedE2eHome();
    try {
      const { stdout } = await runBinWithEnv(["list", "--filter", "source:claude"], { env: { HOME: home } });
      const visible = stripAnsi(stdout);
      assert.match(visible, /Found \d+ session/);
      assert.match(visible, /claude/i);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("list --filter 'model:sonnet' shows only sonnet sessions", async () => {
    const { home } = seedE2eHome();
    try {
      const { stdout } = await runBinWithEnv(["list", "--filter", "model:sonnet"], { env: { HOME: home } });
      const visible = stripAnsi(stdout);
      assert.match(visible, /Found \d+ session/);
      assert.match(visible, /e2e-sonnet/);
      // opus project should not appear when filtering for sonnet
      assert.ok(!visible.includes("e2e-opus"), "opus sessions should be excluded by model:sonnet filter");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// E2E: tracequest latest --filter
// ---------------------------------------------------------------------------

describe("bin/tracequest.js e2e latest --filter", () => {
  test("latest --filter 'source:claude' renders an HTML file", async () => {
    const { home } = seedE2eHome();
    const out = join(home, "latest-filter-out.html");
    try {
      const { stdout } = await runBinWithEnv(
        ["latest", "--filter", "source:claude", "--out", out],
        { env: { HOME: home } },
      );
      const visible = stripAnsi(stdout);
      assert.match(visible, /Written:/);
      assert.ok(existsSync(out), "latest --filter should create HTML file");
      const html = readFileSync(out, "utf8");
      assert.match(html, /<html/i);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
