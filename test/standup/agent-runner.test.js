import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import {
  buildPromptAgentProbeInput,
  buildPromptAgentDetectionReport,
  buildPromptAgentInvocation,
  DEFAULT_AGENT_PROBE_TIMEOUT_MS,
  DEFAULT_PROMPT_AGENT_CANDIDATES,
  detectPromptAgent,
  parseEnvAgentArgs,
  paramsToArgs,
  probePromptAgents,
  runPromptAgent,
  standupAgentDefaultsFromEnv,
} from "../../src/standup/agent-runner.js";

async function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "tq-standup-agent-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("standup agent runner", () => {
  test("standup --probe-agents reports synthetic-only pass, fail, missing, and skipped results", async () => {
    await withTmpDir(async (dir) => {
      const script = join(dir, "probe-agent.mjs");
      writeFileSync(script, `
const expected = process.argv[2];
const mode = process.argv[3] || "pass";
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  if (!stdin.includes("synthetic prompt-agent probe only") || !stdin.includes(expected)) {
    process.stderr.write("unexpected probe input");
    process.exit(3);
  }
  if (mode === "fail") {
    process.stderr.write("synthetic failure");
    process.exit(7);
  }
  process.stdout.write(expected + "\\n");
});
`);

      const report = await probePromptAgents({
        candidates: [
          { id: "codex", command: process.execPath, args: [script, "TQ_AGENT_PROBE_CODEX_OK"] },
          { id: "claude", command: process.execPath, args: [script, "TQ_AGENT_PROBE_CLAUDE_OK", "fail"] },
          { id: "missing", command: "missing-agent", args: ["run"] },
          { id: "argv-only", command: process.execPath, args: [script], input: "argv" },
        ],
        commandExists: (command) => command === process.execPath,
        timeoutMs: 1000,
      });

      assert.equal(report.mode, "standup-agent-probe");
      assert.equal(report.timeoutMs, 1000);
      assert.deepEqual(report.actions, {
        loadedProfile: false,
        discoveredSessions: false,
        builtCompactInputFromRealTraces: false,
        sentPrivateTraceData: false,
      });
      assert.deepEqual(report.summary, { passed: 1, failed: 1, missing: 1, skipped: 1 });
      assert.deepEqual(report.agents.map((agent) => [agent.id, agent.status]), [
        ["codex", "passed"],
        ["claude", "failed"],
        ["missing", "missing"],
        ["argv-only", "skipped"],
      ]);
      assert.match(report.agents[0].stdoutSnippet, /TQ_AGENT_PROBE_CODEX_OK/);
      assert.match(report.agents[0].reason, /sentinel line found/);
      assert.match(report.agents[1].reason, /status 7/);
      assert.match(report.agents[2].reason, /command not found/);
      assert.match(report.agents[3].reason, /stdin/);
    });
  });

  test("standup --probe-agents requires exact sentinel stdout line", async () => {
    await withTmpDir(async (dir) => {
      const script = join(dir, "probe-sentinel-line-agent.mjs");
      writeFileSync(script, `
const sentinel = process.argv[2];
const mode = process.argv[3] || "exact";
process.stdin.resume();
process.stdin.on("end", () => {
  if (mode === "mention") {
    process.stdout.write("Declining. This output mentions " + sentinel + " but is not the requested exact reply.\\n");
    return;
  }
  process.stdout.write("status header\\n" + sentinel + "\\n");
});
`);

      const report = await probePromptAgents({
        candidates: [
          { id: "exact", command: process.execPath, args: [script, "TQ_AGENT_PROBE_EXACT_OK"] },
          { id: "mention", command: process.execPath, args: [script, "TQ_AGENT_PROBE_MENTION_OK", "mention"] },
        ],
        commandExists: (command) => command === process.execPath,
        timeoutMs: 1000,
      });

      assert.deepEqual(report.summary, { passed: 1, failed: 1, missing: 0, skipped: 0 });
      assert.deepEqual(report.agents.map((agent) => [agent.id, agent.status, agent.reason]), [
        ["exact", "passed", "sentinel line found in stdout"],
        ["mention", "failed", "sentinel line not found in stdout"],
      ]);
      assert.match(report.agents[1].stdoutSnippet, /TQ_AGENT_PROBE_MENTION_OK/);
    });
  });

  test("standup --probe-agents synthetic prompt omits real trace data categories", () => {
    const { input, sentinel } = buildPromptAgentProbeInput("codex");
    assert.equal(sentinel, "TQ_AGENT_PROBE_CODEX_OK");
    assert.match(input, /synthetic prompt-agent probe only/);
    assert.match(input, /No sessions were discovered/);
    assert.match(input, /No compact input was built from real traces/);
    assert.doesNotMatch(input, /\.jsonl\b|\/home\/|\/tmp\/|RAW_TRACE_SENTINEL|PRIVATE_PROMPT_SENTINEL/);
    assert.equal(DEFAULT_AGENT_PROBE_TIMEOUT_MS, 120_000);
  });

  test("standup --probe-agents redacts public-paste-sensitive diagnostics", async () => {
    await withTmpDir(async (dir) => {
      const script = join(dir, "probe-private-diagnostics-agent.mjs");
      writeFileSync(script, `
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write("cwd /tmp/tracequest-standup-agent-probe-secret/session-abcdef1234567890/private.jsonl\\n");
  process.stdout.write("TQ_AGENT_PROBE_CODEX_OK\\n");
  process.stderr.write("home=/home/alice/.claude/projects/tracequest/session-123e4567-e89b-12d3-a456-426614174000.jsonl\\n");
  process.stderr.write("conversation_id=conv_private_1234567890 temp tracequest-standup-agent-probe-private999\\n");
  process.exit(9);
});
`);

      const report = await probePromptAgents({
        candidates: [
          { id: "codex", command: process.execPath, args: [script] },
        ],
        commandExists: (command) => command === process.execPath,
        timeoutMs: 1000,
      });

      const agent = report.agents[0];
      const diagnosticText = [
        agent.reason,
        agent.stdoutSnippet,
        agent.stderrSnippet,
      ].join("\n");
      assert.deepEqual(report.summary, { passed: 0, failed: 1, missing: 0, skipped: 0 });
      assert.equal(agent.reason, "exited with status 9");
      assert.match(agent.stdoutSnippet, /TQ_AGENT_PROBE_CODEX_OK/);
      assert.match(agent.stdoutSnippet, /<path>|<temp-workdir>/);
      assert.match(agent.stderrSnippet, /<path>/);
      assert.match(agent.stderrSnippet, /<session-id>/);
      assert.doesNotMatch(diagnosticText, /\/tmp\/|\/home\/|\.jsonl\b|tracequest-standup-agent-probe-secret|tracequest-standup-agent-probe-private999/);
      assert.doesNotMatch(diagnosticText, /123e4567-e89b-12d3-a456-426614174000|conv_private_1234567890|session-abcdef1234567890/);
    });
  });

  test("standup dry-run agent detection report records skipped side effects", () => {
    const invocation = buildPromptAgentInvocation({
      candidates: [{ id: "codex", command: "codex", args: ["exec"], promptArg: "-" }],
      commandExists: () => true,
      params: { model: "gpt-5" },
    });
    const report = buildPromptAgentDetectionReport(invocation, { timeoutMs: 1234 });

    assert.deepEqual(report, {
      mode: "standup-agent-detection-dry-run",
      agent: {
        id: "codex",
        source: "detected",
        command: "codex",
        args: ["exec", "--model", "gpt-5", "-"],
        input: "stdin",
      },
      timeoutMs: 1234,
      actions: {
        discoveredSessions: false,
        builtCompactInput: false,
        sentPrompt: false,
        invokedAgent: false,
      },
    });
  });

  test("default prompt-agent candidates include Codex, Claude, and Droid only", () => {
    assert.deepEqual(DEFAULT_PROMPT_AGENT_CANDIDATES.map((candidate) => ({
      id: candidate.id,
      command: candidate.command,
      args: candidate.args,
      probeArgs: candidate.probeArgs || null,
      promptArg: candidate.promptArg || null,
      input: candidate.input,
    })), [
      {
        id: "codex",
        command: "codex",
        args: ["exec", "--skip-git-repo-check"],
        probeArgs: [
          "exec",
          "--skip-git-repo-check",
          "--ephemeral",
          "--ignore-user-config",
          "--ignore-rules",
        ],
        promptArg: "-",
        input: "stdin",
      },
      { id: "claude", command: "claude", args: ["--print"], probeArgs: null, promptArg: null, input: "stdin" },
      { id: "droid", command: "droid", args: ["exec"], probeArgs: null, promptArg: null, input: "stdin" },
    ]);

    const detected = detectPromptAgent({
      candidates: DEFAULT_PROMPT_AGENT_CANDIDATES,
      commandExists: (command) => command === "droid",
    });
    assert.deepEqual(detected, {
      id: "droid",
      command: "droid",
      args: ["exec"],
      promptArg: undefined,
      input: "stdin",
      detected: true,
    });
  });

  test("OpenCode is configurable but not a built-in prompt-agent default", () => {
    assert.equal(
      DEFAULT_PROMPT_AGENT_CANDIDATES.some((candidate) => candidate.id === "opencode" || candidate.command === "opencode"),
      false,
    );

    const invocation = buildPromptAgentInvocation({
      command: "opencode",
      args: ["run"],
      params: { model: "anthropic/claude-sonnet-4.6" },
    });

    assert.deepEqual(invocation, {
      id: "configured",
      command: "opencode",
      args: ["run", "--model", "anthropic/claude-sonnet-4.6"],
      input: "stdin",
      cwd: undefined,
      env: undefined,
      detected: false,
    });
  });

  test("standup --probe-agents can use Codex-specific probe argv without changing normal detection argv", async () => {
    await withTmpDir(async (dir) => {
      const script = join(dir, "probe-argv-agent.mjs");
      writeFileSync(script, `
const expected = process.argv[2];
const argv = process.argv.slice(3);
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  if (!argv.includes("--skip-git-repo-check") || !argv.includes("--ephemeral") || !argv.includes("--ignore-user-config") || !argv.includes("--ignore-rules") || !argv.includes("-")) {
    process.stderr.write(JSON.stringify(argv));
    process.exit(4);
  }
  if (!stdin.includes(expected)) {
    process.stderr.write("missing sentinel in synthetic input");
    process.exit(5);
  }
  process.stdout.write(expected + "\\n");
});
`);

      const codex = DEFAULT_PROMPT_AGENT_CANDIDATES.find((candidate) => candidate.id === "codex");
      assert.deepEqual(codex.args, ["exec", "--skip-git-repo-check"]);
      assert.deepEqual(codex.probeArgs, [
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
      ]);

      const report = await probePromptAgents({
        candidates: [{
          ...codex,
          command: process.execPath,
          args: [script, "TQ_AGENT_PROBE_CODEX_OK", "normal-arg"],
          probeArgs: [script, "TQ_AGENT_PROBE_CODEX_OK", ...codex.probeArgs],
        }],
        commandExists: (command) => command === process.execPath,
        timeoutMs: 1000,
      });

      assert.deepEqual(report.summary, { passed: 1, failed: 0, missing: 0, skipped: 0 });
      assert.deepEqual(report.agents[0].args, [
        script,
        "TQ_AGENT_PROBE_CODEX_OK",
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "-",
      ]);
    });
  });

  test("detectPromptAgent picks the first available prompt-mode candidate", () => {
    const agent = detectPromptAgent({
      candidates: [
        { id: "missing", command: "missing-agent", args: ["run"] },
        { id: "present", command: "present-agent", args: ["exec"], promptArg: "-" },
        { id: "also-present", command: "also-present-agent", args: ["exec"] },
      ],
      commandExists(command) {
        return command !== "missing-agent";
      },
    });

    assert.deepEqual(agent, {
      id: "present",
      command: "present-agent",
      args: ["exec"],
      promptArg: "-",
      input: "stdin",
      detected: true,
    });
  });

  test("buildPromptAgentInvocation combines configured command, args, and params", () => {
    const invocation = buildPromptAgentInvocation({
      command: "custom-agent",
      args: ["run"],
      params: {
        model: "standup-model",
        dryRun: true,
        skip: false,
        config: ["a=b", "c=d"],
      },
    });

    assert.equal(invocation.command, "custom-agent");
    assert.deepEqual(invocation.args, [
      "run",
      "--model",
      "standup-model",
      "--dry-run",
      "--config",
      "a=b",
      "--config",
      "c=d",
    ]);
    assert.equal(invocation.input, "stdin");
  });

  test("buildPromptAgentInvocation explains missing prompt agent detection", () => {
    assert.throws(
      () => buildPromptAgentInvocation({
        candidates: [
          { id: "missing-a", command: "missing-a", args: ["run"] },
          { id: "missing-b", command: "missing-b", args: ["exec"], promptArg: "-" },
        ],
        commandExists: () => false,
      }),
      /No prompt-mode agent command found\. Tried: missing-a, missing-b\..*--agent-command.*--print-input/,
    );
  });

  test("detected codex invocation inserts params before stdin prompt marker", () => {
    const invocation = buildPromptAgentInvocation({
      candidates: [{ id: "codex", command: "codex", args: ["exec"], promptArg: "-" }],
      commandExists: () => true,
      params: { model: "gpt-5" },
    });

    assert.deepEqual(invocation.args, ["exec", "--model", "gpt-5", "-"]);
  });

  test("paramsToArgs handles booleans, arrays, and single-letter flags", () => {
    assert.deepEqual(paramsToArgs({
      m: "gpt-5",
      json: true,
      quiet: false,
      config: ["x=1", "y=2"],
    }), ["-m", "gpt-5", "--json", "--config", "x=1", "--config", "y=2"]);
  });

  test("standupAgentDefaultsFromEnv reads command, JSON args, and timeout defaults", () => {
    assert.deepEqual(standupAgentDefaultsFromEnv({
      TRACEQUEST_STANDUP_AGENT_COMMAND: "codex",
      TRACEQUEST_STANDUP_AGENT_ARGS: "[\"exec\",\"--model\",\"gpt-5\"]",
      TRACEQUEST_STANDUP_AGENT_TIMEOUT_MS: "120000",
    }), {
      command: "codex",
      args: ["exec", "--model", "gpt-5"],
      timeoutMs: "120000",
    });
    assert.deepEqual(parseEnvAgentArgs("exec --quiet"), ["exec", "--quiet"]);
    assert.throws(() => parseEnvAgentArgs("[1"), /TRACEQUEST_STANDUP_AGENT_ARGS/);
  });

  test("runPromptAgent passes compact input on stdin and avoids shell interpolation", async () => {
    await withTmpDir(async (dir) => {
      const script = join(dir, "fake-agent.mjs");
      writeFileSync(script, `
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), stdin }));
});
`);

      const result = await runPromptAgent("compact standup input", {
        command: process.execPath,
        args: [script, "literal;echo SHOULD_NOT_RUN"],
        params: { model: "local;echo ALSO_NOT_RUN" },
      });
      const parsed = JSON.parse(result.stdout);

      assert.equal(result.status, 0);
      assert.deepEqual(parsed.argv, [
        "literal;echo SHOULD_NOT_RUN",
        "--model",
        "local;echo ALSO_NOT_RUN",
      ]);
      assert.equal(parsed.stdin, "compact standup input");
      assert.doesNotMatch(result.stdout, /\nSHOULD_NOT_RUN\b/);
      assert.doesNotMatch(result.stdout, /\nALSO_NOT_RUN\b/);
    });
  });

  test("runPromptAgent streams stdout and stderr before exit while retaining captures", async () => {
    await withTmpDir(async (dir) => {
      const script = join(dir, "streaming-agent.mjs");
      writeFileSync(script, `
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write("stdout-first\\n");
  process.stderr.write("stderr-first\\n");
  setTimeout(() => {
    process.stdout.write("stdout-last\\n");
    process.stderr.write("stderr-last\\n");
  }, 60);
  setTimeout(() => { process.exit(0); }, 140);
});
`);

      let resolveFirstStdout;
      let resolveFirstStderr;
      const firstStdout = new Promise((resolve) => { resolveFirstStdout = resolve; });
      const firstStderr = new Promise((resolve) => { resolveFirstStderr = resolve; });
      const stdoutChunks = [];
      const stderrChunks = [];
      const resultPromise = runPromptAgent("compact standup input", {
        command: process.execPath,
        args: [script],
        onStdout(chunk) {
          stdoutChunks.push(chunk);
          if (chunk.includes("stdout-first")) resolveFirstStdout();
        },
        onStderr(chunk) {
          stderrChunks.push(chunk);
          if (chunk.includes("stderr-first")) resolveFirstStderr();
        },
      });

      await Promise.all([
        Promise.race([firstStdout, delay(1000).then(() => { throw new Error("stdout did not stream"); })]),
        Promise.race([firstStderr, delay(1000).then(() => { throw new Error("stderr did not stream"); })]),
      ]);
      const earlyState = await Promise.race([
        resultPromise.then(() => "closed"),
        delay(30).then(() => "still-running"),
      ]);
      assert.equal(earlyState, "still-running");

      const result = await resultPromise;
      assert.equal(result.status, 0);
      assert.equal(stdoutChunks.join(""), "stdout-first\nstdout-last\n");
      assert.equal(stderrChunks.join(""), "stderr-first\nstderr-last\n");
      assert.equal(result.stdout, "stdout-first\nstdout-last\n");
      assert.equal(result.stderr, "stderr-first\nstderr-last\n");
    });
  });

  test("runPromptAgent reports stdin write errors without unhandled process errors", async () => {
    class FakeStream extends EventEmitter {
      setEncoding() {}
    }

    const child = new EventEmitter();
    child.stdout = new FakeStream();
    child.stderr = new FakeStream();
    child.stdin = new FakeStream();
    child.kill = () => {};
    child.stdin.end = () => {
      setImmediate(() => {
        const err = new Error("write EPIPE");
        err.code = "EPIPE";
        child.stdin.emit("error", err);
        setImmediate(() => child.emit("close", 0, null));
      });
    };

    const result = await runPromptAgent("compact standup input", {
      command: "fake-agent",
    }, {
      spawn: () => child,
    });

    assert.equal(result.status, 0);
    assert.deepEqual(result.stdinError, { code: "EPIPE", message: "write EPIPE" });
    assert.match(result.stderr, /Prompt agent stdin write failed: write EPIPE/);
  });

  test("runPromptAgent reports agent timeout and terminates the child", async () => {
    await withTmpDir(async (dir) => {
      const script = join(dir, "slow-agent.mjs");
      writeFileSync(script, `
process.stdin.resume();
setInterval(() => {}, 1000);
`);

      const result = await runPromptAgent("compact standup input", {
        command: process.execPath,
        args: [script],
        timeoutMs: 50,
      });

      assert.equal(result.timedOut, true);
      assert.equal(result.timeoutMs, 50);
      assert.equal(result.status, null);
      assert.equal(result.signal, "SIGTERM");
    });
  });
});
