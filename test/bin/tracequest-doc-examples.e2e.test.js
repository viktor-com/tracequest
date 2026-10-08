/**
 * Focused smoke for CLI reference/help standup and handoff examples.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import {
  mkTmp,
  writeClaudeJsonl,
} from "../helpers/fixtures.js";
import {
  TRACEQUEST_NODE as NODE,
  TRACEQUEST_ROOT as ROOT,
  richClaudeFixture,
  runTracequestBin,
  writeFakePromptAgentPath,
  writeStandupProfiles,
} from "../helpers/standup-handoff-fixtures.js";

const EXAMPLES_SCRIPT = "TRACEQUEST_SKIP_LR_WATCH=1 node --test --test-concurrency=1 test/bin/tracequest-doc-examples.e2e.test.js";

function runBin(args, { timeoutMs = 30_000, expectCode = 0 } = {}) {
  return runTracequestBin(args, { timeoutMs, expectCode });
}

function splitExampleCommand(command) {
  const out = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (const ch of command.trim()) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = "";
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (escaped) current += "\\";
  if (quote) throw new Error(`unterminated quote in example command: ${command}`);
  if (current) out.push(current);
  return out;
}

function stripAnsi(s) {
  return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function documentedStandupHandoffExamples({ reference, help }) {
  const commands = new Set();
  for (const text of [reference, help]) {
    for (const line of text.split(/\r?\n/)) {
      const command = line.trim();
      if (!command.startsWith("tracequest ")) continue;
      if (command.startsWith("tracequest standup ")) commands.add(command);
      if (command.startsWith("tracequest handoff ")) commands.add(command);
      if (command.startsWith("tracequest search ") && command.includes("--format handoff")) {
        commands.add(command);
      }
    }
  }
  return [...commands].sort();
}

function previousWeekdayAt(hour) {
  const now = new Date();
  const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, hour, 0, 0, 0);
  while (candidate.getDay() === 0 || candidate.getDay() === 6) {
    candidate.setDate(candidate.getDate() - 1);
  }
  return candidate;
}

test("CLI reference and help standup/handoff examples parse through the real bin with synthetic data", async () => {
  const home = mkTmp("bin-e2e-doc-examples-");
  const project = "tracequest";
  const projectDir = join(home, ".claude", "projects", project);
  const fakeBin = writeFakePromptAgentPath(home);
  const defaultAgentCode = [
    "let stdin = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { stdin += chunk; });",
    "process.stdin.on('end', () => {",
    "  if (!stdin.includes('# TraceQuest Standup Request')) process.exit(4);",
    "  process.stdout.write('FAKE_DEFAULT_AGENT_OK\\n');",
    "});",
  ].join("\n");

  try {
    mkdirSync(projectDir, { recursive: true });
    const nowPath = writeClaudeJsonl(projectDir, "now.jsonl",
      richClaudeFixture("doc-example-now", { prompt: "error handling parseSession current standup example prompt" }));
    const workdayPath = writeClaudeJsonl(projectDir, "workday.jsonl",
      richClaudeFixture("doc-example-workday", { prompt: "documented workday standup example prompt" }));
    const yesterdayPath = writeClaudeJsonl(projectDir, "yesterday.jsonl",
      richClaudeFixture("doc-example-yesterday", { prompt: "documented yesterday standup example prompt" }));
    const previousWorkdayPath = writeClaudeJsonl(projectDir, "previous-workday.jsonl",
      richClaudeFixture("doc-example-previous-workday", { prompt: "documented previous-workday standup example prompt" }));

    const now = new Date();
    const nowMtime = new Date();
    const todayTen = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0, 0);
    const yesterdayNoon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12, 0, 0);
    const previousWorkdayNoon = previousWeekdayAt(12);
    utimesSync(nowPath, nowMtime, nowMtime);
    utimesSync(workdayPath, todayTen, todayTen);
    utimesSync(yesterdayPath, yesterdayNoon, yesterdayNoon);
    utimesSync(previousWorkdayPath, previousWorkdayNoon, previousWorkdayNoon);

    writeStandupProfiles(home, {
      daily: {
        project,
        limit: 1,
        agentCommand: "my-agent",
        agentArgs: ["run"],
      },
    });

    const { stdout: help } = await runBin(["standup", "--help"]);
    const reference = readFileSync(join(ROOT, "docs/cli-reference.md"), "utf8");
    const examples = documentedStandupHandoffExamples({ reference, help });
    assert.ok(examples.length >= 12, `expected documented standup/handoff examples, got ${examples.join("\n")}`);

    const env = {
      HOME: home,
      PATH: fakeBin,
      TRACEQUEST_FAKE_BIN: fakeBin,
      TRACEQUEST_STANDUP_AGENT_COMMAND: NODE,
      TRACEQUEST_STANDUP_AGENT_ARGS: JSON.stringify(["-e", defaultAgentCode, "--"]),
      TRACEQUEST_STANDUP_AGENT_TIMEOUT_MS: "5000",
    };

    for (const command of examples) {
      const tokens = splitExampleCommand(command);
      assert.equal(tokens[0], "tracequest", command);
      const args = tokens.slice(1);
      const { stdout, stderr } = await runTracequestBin(args, { env, timeoutMs: 20_000 });
      const combined = `${stdout}\n${stderr}`;
      assert.equal(combined.includes(home), false, `${command} leaked synthetic HOME`);
      assert.doesNotMatch(combined, /Unknown option|Run 'tracequest --help' for usage/, command);

      if (args[0] === "search" || args[0] === "handoff") {
        assert.match(stdout, /^# TraceQuest Search Handoff\n/, command);
        assert.match(stderr, /Discovering sessions/, command);
      } else if (args.includes("--print-input")) {
        assert.match(stdout, /^# TraceQuest Standup Request\n/, command);
        assert.equal(stderr, "", command);
      } else if (args.includes("--dry-run-agent-detection")) {
        const report = JSON.parse(stdout);
        assert.equal(report.mode, "standup-agent-detection-dry-run", command);
        assert.equal(stderr, "", command);
      } else if (args.includes("--probe-agents")) {
        const report = JSON.parse(stdout);
        assert.equal(report.mode, "standup-agent-probe", command);
        assert.equal(report.summary.failed, 0, command);
        assert.match(stderr, /TraceQuest standup agent probe:/, command);
        assert.match(stderr, /synthetic sentinel prompts only/, command);
        assert.match(stderr, /JSON probe report will be written to stdout/, command);
      } else {
        assert.match(stdout, /FAKE_(DEFAULT_)?PROMPT_AGENT_OK|FAKE_DEFAULT_AGENT_OK/, command);
        assert.match(stderr, /Running standup agent:/, command);
      }
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("CLI reference documents current command-specific options", async () => {
  const reference = readFileSync(join(ROOT, "docs/cli-reference.md"), "utf8");
  const cliUsage = reference.match(/## CLI Usage[\s\S]*?### All Modes with Examples/)?.[0] ?? "";
  const { stdout: help } = await runBin(["--help"]);
  const visibleHelp = stripAnsi(help);

  const required = [
    /messages Options:[\s\S]*--format <fmt>[\s\S]*--pretty[\s\S]*-o, --out <path>/,
    /find Options:[\s\S]*-f, --filter <expr>[\s\S]*-l, --limit <N>[\s\S]*-s, --sort <key>/,
    /search Options:[\s\S]*-f, --filter <expr>[\s\S]*-l, --limit <N>[\s\S]*--format <fmt>[\s\S]*-s, --sort <key>/,
    /handoff Options:[\s\S]*-f, --filter <expr>[\s\S]*-l, --limit <N>[\s\S]*-s, --sort <key>/,
    /standup Options:[\s\S]*--profile <name>[\s\S]*--previous-workday[\s\S]*--print-input[\s\S]*--dry-run-agent-detection[\s\S]*--probe-agents[\s\S]*--agent-command <cmd>[\s\S]*--agent-arg <v>[\s\S]*--agent-timeout-ms <N>[\s\S]*--param <k=v>/,
    /list Options:[\s\S]*-l, --limit <N>[\s\S]*-f, --filter <expr>[\s\S]*-s, --sort <key>/,
    /latest Options:[\s\S]*-l, --limit <N>[\s\S]*-f, --filter <expr>[\s\S]*-s, --sort <key>/,
    /share Options:[\s\S]*--target <t>[\s\S]*--latest[\s\S]*-f, --filter <expr>[\s\S]*--json[\s\S]*--private[\s\S]*--force[\s\S]*--hf-repo <repo>/,
    /serve Options:[\s\S]*-p, --port <N>[\s\S]*-f, --filter <name>[\s\S]*--preset <name>/,
    /limits Options:[\s\S]*--json[\s\S]*--host <id>/,
  ];

  assert.notEqual(cliUsage, "", "CLI reference section should be present");
  for (const pattern of required) {
    assert.match(visibleHelp, pattern, `built-in help missing expected option group: ${pattern}`);
    assert.match(cliUsage, pattern, `CLI reference missing expected option group: ${pattern}`);
  }
});

test("npm smoke:standup-handoff-examples is wired and documented", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const guide = readFileSync(join(ROOT, "tests/standup-handoff-smoke.md"), "utf8");

  assert.equal(pkg.scripts["smoke:standup-handoff-examples"], EXAMPLES_SCRIPT);
  assert.match(guide, /npm run smoke:standup-handoff-examples/);
  assert.match(guide, /CLI reference\/help standup and handoff examples/);
});
