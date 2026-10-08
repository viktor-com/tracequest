#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;

function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, "");
}

function runTracequest(args, { env = {}, expectCode = 0, timeoutMs = 30_000 } = {}) {
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
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`tracequest ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const visibleStdout = stripAnsi(stdout);
      const visibleStderr = stripAnsi(stderr);
      if (code !== expectCode) {
        reject(new Error([
          `tracequest ${args.join(" ")} expected exit ${expectCode}, got ${code}`,
          `stdout:\n${visibleStdout}`,
          `stderr:\n${visibleStderr}`,
        ].join("\n")));
        return;
      }
      resolve({ code, stdout: visibleStdout, stderr: visibleStderr });
    });
  });
}

function claudeRows(sessionId, prompt, {
  assistant = "smoke assistant reply",
  toolName = "Bash",
  rawJsonlMarker = "",
} = {}) {
  const ts = "2026-06-27T10:15:00.000Z";
  const toolId = `toolu_${sessionId}`;
  return [
    {
      type: "user",
      sessionId,
      cwd: "/tmp/tracequest-smoke-project",
      timestamp: ts,
      uuid: `u-${sessionId}`,
      isMeta: false,
      ...(rawJsonlMarker ? { tracequestSmokeRawMarker: rawJsonlMarker } : {}),
      message: { content: [{ type: "text", text: prompt }] },
    },
    {
      type: "assistant",
      sessionId,
      timestamp: ts,
      uuid: `a-${sessionId}`,
      message: {
        model: "claude-sonnet-4-20250514",
        content: [
          { type: "text", text: assistant },
          { type: "tool_use", id: toolId, name: toolName, input: { command: "printf smoke" } },
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
        content: [{
          type: "tool_result",
          tool_use_id: toolId,
          content: [{ type: "text", text: "synthetic smoke tool result" }],
        }],
      },
    },
    {
      type: "assistant",
      sessionId,
      timestamp: ts,
      uuid: `a2-${sessionId}`,
      message: {
        model: "claude-sonnet-4-20250514",
        content: [{ type: "text", text: "processed synthetic smoke result" }],
      },
    },
  ];
}

function writeJsonl(path, rows) {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function setMtime(path, date) {
  utimesSync(path, date, date);
}

function previousWeekdayAt(reference, hour, minute = 30) {
  const date = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate() - 1, hour, minute, 0, 0);
  while (date.getDay() === 0 || date.getDay() === 6) {
    date.setDate(date.getDate() - 1);
  }
  return date;
}

function assertNoPrivatePaths(text, home, label) {
  assert.equal(text.includes(home), false, `${label} must not include temp HOME`);
  assert.equal(/\.jsonl\b/.test(text), false, `${label} must not include session filenames`);
}

function createAgentTrap(home) {
  const trapDir = join(home, "agent-trap-bin");
  const marker = join(home, "handoff-agent-trap.log");
  mkdirSync(trapDir, { recursive: true });
  for (const name of ["which", "codex", "claude", "droid", "opencode", "factory"]) {
    const path = join(trapDir, name);
    writeFileSync(path, [
      "#!/bin/sh",
      "if [ -n \"${TRACEQUEST_HANDOFF_AGENT_TRAP:-}\" ]; then",
      `  printf '%s\\n' '${name}' >> "$TRACEQUEST_HANDOFF_AGENT_TRAP"`,
      "fi",
      "exit 97",
      "",
    ].join("\n"));
    chmodSync(path, 0o755);
  }
  return { trapDir, marker };
}

async function main() {
  const home = mkdtemp("tracequest-standup-handoff-smoke-");
  let keepTmp = process.env.TRACEQUEST_SMOKE_KEEP_TMP === "1";
  try {
    const project = "smoke-standup-handoff";
    const projectDir = join(home, ".claude", "projects", project);
    mkdirSync(projectDir, { recursive: true });

    const today = new Date();
    const insideWorkday = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 10, 30, 0);
    const afterWorkday = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 18, 30, 0);
    const yesterdayAfterHours = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 18, 30, 0);
    const previousWorkdayInside = previousWeekdayAt(today, 10, 30);
    const previousWorkdayEarly = previousWeekdayAt(today, 8, 30);

    const workdayPath = join(projectDir, "workday.jsonl");
    const afterWorkPath = join(projectDir, "after-work.jsonl");
    const yesterdayPath = join(projectDir, "yesterday.jsonl");
    const previousWorkdayPath = join(projectDir, "previous-workday.jsonl");
    const previousWorkdayEarlyPath = join(projectDir, "previous-workday-early.jsonl");
    const directFilterIncludeProject = "releasegate-filter-include";
    const directFilterExcludeProject = "releasegate-filter-exclude";
    const directSortOldProject = "releasegate-sort-old";
    const directSortNewProject = "releasegate-sort-new";
    const directFilterIncludeDir = join(home, ".claude", "projects", directFilterIncludeProject);
    const directFilterExcludeDir = join(home, ".claude", "projects", directFilterExcludeProject);
    const directSortOldDir = join(home, ".claude", "projects", directSortOldProject);
    const directSortNewDir = join(home, ".claude", "projects", directSortNewProject);
    mkdirSync(directFilterIncludeDir, { recursive: true });
    mkdirSync(directFilterExcludeDir, { recursive: true });
    mkdirSync(directSortOldDir, { recursive: true });
    mkdirSync(directSortNewDir, { recursive: true });
    const rawJsonlMarker = "RAW_JSONL_PRIVATE_RECORD_SMOKE_8HZK";
    const transcriptTailMarker = "RAW_TRANSCRIPT_PRIVATE_TAIL_SMOKE_7QXJ";
    writeJsonl(workdayPath, claudeRows(
      "smoke-workday-session",
      `smoke handoff needle and workday standup checkpoint ${"bounded summary filler ".repeat(20)}${transcriptTailMarker}`,
      {
        assistant: "completed the synthetic workday checkpoint",
        rawJsonlMarker,
      },
    ));
    writeJsonl(afterWorkPath, claudeRows(
      "smoke-after-work-session",
      "after workday prompt should be filtered from workday standup",
    ));
    writeJsonl(yesterdayPath, claudeRows(
      "smoke-yesterday-session",
      "yesterday after-hours prompt should be filtered from workday standup",
    ));
    writeJsonl(previousWorkdayPath, claudeRows(
      "smoke-previous-workday-session",
      "previous workday standup checkpoint should be included",
      { assistant: "completed the synthetic previous-workday checkpoint" },
    ));
    writeJsonl(previousWorkdayEarlyPath, claudeRows(
      "smoke-previous-workday-early-session",
      "early previous workday prompt should be filtered from previous-workday standup",
    ));
    const directFilterIncludePath = join(directFilterIncludeDir, "include.jsonl");
    const directFilterExcludePath = join(directFilterExcludeDir, "exclude.jsonl");
    const directSortOldPath = join(directSortOldDir, "old.jsonl");
    const directSortNewPath = join(directSortNewDir, "new.jsonl");
    writeJsonl(directFilterIncludePath, claudeRows(
      "releasegate-filter-include-session",
      "releasegate filter sentinel include match",
      { assistant: "included direct handoff filter result" },
    ));
    writeJsonl(directFilterExcludePath, claudeRows(
      "releasegate-filter-exclude-session",
      "releasegate filter sentinel exclude match",
      { assistant: "excluded direct handoff filter result" },
    ));
    writeJsonl(directSortOldPath, claudeRows(
      "releasegate-sort-old-session",
      `${"releasegate recency sentinel ".repeat(40)}older high relevance direct handoff match`,
      { assistant: "older direct handoff relevance result" },
    ));
    writeJsonl(directSortNewPath, claudeRows(
      "releasegate-sort-new-session",
      "releasegate recency sentinel newer low relevance direct handoff match",
      { assistant: "newer direct handoff recency result" },
    ));
    setMtime(workdayPath, insideWorkday);
    setMtime(afterWorkPath, afterWorkday);
    setMtime(yesterdayPath, yesterdayAfterHours);
    setMtime(previousWorkdayPath, previousWorkdayInside);
    setMtime(previousWorkdayEarlyPath, previousWorkdayEarly);
    setMtime(directFilterIncludePath, afterWorkday);
    setMtime(directFilterExcludePath, afterWorkday);
    setMtime(directSortOldPath, yesterdayAfterHours);
    setMtime(directSortNewPath, afterWorkday);

    const baseEnv = { HOME: home };
    const agentTrap = createAgentTrap(home);
    const handoffEnv = {
      ...baseEnv,
      PATH: [agentTrap.trapDir, process.env.PATH || ""].filter(Boolean).join(delimiter),
      TRACEQUEST_HANDOFF_AGENT_TRAP: agentTrap.marker,
    };
    const handoff = await runTracequest(
      ["search", "smoke handoff needle", "--format", "handoff", "--limit", "3"],
      { env: handoffEnv },
    );
    assert.match(handoff.stdout, /# TraceQuest Search Handoff/);
    assert.match(handoff.stdout, /- Query: `smoke handoff needle`/);
    assert.match(handoff.stdout, /smoke handoff needle/);
    assertNoPrivatePaths(handoff.stdout, home, "handoff stdout");
    assert.doesNotMatch(handoff.stderr, /# TraceQuest Search Handoff/);

    const directFilter = await runTracequest(
      [
        "handoff",
        "releasegate filter sentinel",
        "--filter",
        `project:${directFilterIncludeProject}`,
        "--limit",
        "5",
      ],
      { env: handoffEnv },
    );
    assert.match(directFilter.stdout, /^# TraceQuest Search Handoff\n/);
    assert.match(directFilter.stdout, /- Results: 1/);
    assert.match(directFilter.stdout, /Project: `releasegate-filter-include`/);
    assert.doesNotMatch(directFilter.stdout, /releasegate-filter-exclude/);
    assert.doesNotMatch(directFilter.stdout, /Discovering sessions|Filtering sessions|Building index|Running standup agent/);
    assert.match(directFilter.stderr, /Discovering sessions/);
    assert.match(directFilter.stderr, /Filtering sessions/);
    assert.match(directFilter.stderr, /Building index/);
    assertNoPrivatePaths(directFilter.stdout, home, "direct handoff --filter stdout");

    const relevanceHandoff = await runTracequest(
      ["handoff", "releasegate recency sentinel", "--limit", "1"],
      { env: handoffEnv },
    );
    assert.match(relevanceHandoff.stdout, /- Sort: `relevance`/);
    assert.match(relevanceHandoff.stdout, /Project: `releasegate-sort-old`/);
    assert.doesNotMatch(relevanceHandoff.stdout, /Project: `releasegate-sort-new`/);
    assertNoPrivatePaths(relevanceHandoff.stdout, home, "direct handoff relevance stdout");

    const directRecent = await runTracequest(
      ["handoff", "releasegate recency sentinel", "--sort", "recent", "--limit", "1"],
      { env: handoffEnv },
    );
    assert.match(directRecent.stdout, /^# TraceQuest Search Handoff\n/);
    assert.match(directRecent.stdout, /- Sort: `recent`/);
    assert.match(directRecent.stdout, /- Results: 1/);
    assert.match(directRecent.stdout, /Project: `releasegate-sort-new`/);
    assert.doesNotMatch(directRecent.stdout, /Project: `releasegate-sort-old`/);
    assert.doesNotMatch(directRecent.stdout, /Discovering sessions|Building index|Running standup agent/);
    assert.match(directRecent.stderr, /Discovering sessions/);
    assert.match(directRecent.stderr, /Building index/);
    assertNoPrivatePaths(directRecent.stdout, home, "direct handoff --sort recent stdout");

    const directDate = await runTracequest(
      ["handoff", "releasegate recency sentinel", "--sort", "date", "--limit", "1"],
      { env: handoffEnv },
    );
    assert.match(directDate.stdout, /^# TraceQuest Search Handoff\n/);
    assert.match(directDate.stdout, /- Sort: `date`/);
    assert.match(directDate.stdout, /- Results: 1/);
    assert.match(directDate.stdout, /Project: `releasegate-sort-new`/);
    assert.doesNotMatch(directDate.stdout, /Project: `releasegate-sort-old`/);
    assert.doesNotMatch(directDate.stdout, /Discovering sessions|Building index|Running standup agent/);
    assert.match(directDate.stderr, /Discovering sessions/);
    assert.match(directDate.stderr, /Building index/);
    assertNoPrivatePaths(directDate.stdout, home, "direct handoff --sort date stdout");

    const legacySearchDate = await runTracequest(
      [
        "search",
        "releasegate recency sentinel",
        "--format",
        "handoff",
        "--sort",
        "date",
        "--limit",
        "1",
      ],
      { env: handoffEnv },
    );
    assert.match(legacySearchDate.stdout, /^# TraceQuest Search Handoff\n/);
    assert.match(legacySearchDate.stdout, /- Sort: `date`/);
    assert.match(legacySearchDate.stdout, /- Results: 1/);
    assert.match(legacySearchDate.stdout, /Project: `releasegate-sort-new`/);
    assert.doesNotMatch(legacySearchDate.stdout, /Project: `releasegate-sort-old`/);
    assert.match(
      legacySearchDate.stdout,
      /Refresh this handoff: `tracequest search 'releasegate recency sentinel' --format handoff --sort date --limit 1`/,
    );
    assert.doesNotMatch(legacySearchDate.stdout, /Discovering sessions|Building index|Running standup agent/);
    assert.match(legacySearchDate.stderr, /Discovering sessions/);
    assert.match(legacySearchDate.stderr, /Building index/);
    assertNoPrivatePaths(legacySearchDate.stdout, home, "search --format handoff --sort date stdout");
    assert.equal(existsSync(agentTrap.marker), false, "handoff smoke must not execute prompt-agent detection or probe commands");

    const printInput = await runTracequest(
      ["standup", "--workday", "--print-input", "--limit", "5"],
      { env: baseEnv },
    );
    assert.match(printInput.stdout, /TraceQuest Standup Request/);
    assert.match(printInput.stdout, /Window: workday/);
    assert.match(printInput.stdout, /smoke handoff needle and workday standup checkpoint/);
    assert.doesNotMatch(printInput.stdout, /after workday prompt should be filtered/);
    assert.doesNotMatch(printInput.stdout, /yesterday after-hours prompt should be filtered/);
    assert.doesNotMatch(printInput.stdout, /previous workday standup checkpoint should be included/);
    assertNoPrivatePaths(printInput.stdout, home, "standup --print-input stdout");
    assert.doesNotMatch(printInput.stderr, /Running standup agent:/);

    const previousPrintInput = await runTracequest(
      ["standup", "--previous-workday", "--print-input", "--limit", "5"],
      { env: baseEnv },
    );
    assert.match(previousPrintInput.stdout, /TraceQuest Standup Request/);
    assert.match(previousPrintInput.stdout, /Window: previous workday/);
    assert.match(previousPrintInput.stdout, /previous workday standup checkpoint should be included/);
    assert.doesNotMatch(previousPrintInput.stdout, /early previous workday prompt should be filtered/);
    assert.doesNotMatch(previousPrintInput.stdout, /smoke handoff needle and workday standup checkpoint/);
    assert.doesNotMatch(previousPrintInput.stdout, /after workday prompt should be filtered/);
    assertNoPrivatePaths(previousPrintInput.stdout, home, "standup --previous-workday --print-input stdout");
    assert.doesNotMatch(previousPrintInput.stderr, /Running standup agent:/);

    const agentCapture = join(home, "fixture-agent-capture.json");
    const fixtureAgent = join(home, "fixture-standup-agent.mjs");
    writeFileSync(fixtureAgent, [
      "#!/usr/bin/env node",
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "const input = readFileSync(0, 'utf8');",
      "const contract = {",
      "  hasHeader: input.includes('# TraceQuest Standup Request'),",
      "  hasInstructions: input.includes('## Prompt-Agent Instructions'),",
      "  hasSectionContract: input.includes('Use sections: Progress, Risks/Blockers, and Next Steps'),",
      "  hasSummariesOnly: input.includes('Use only the compact summaries below'),",
      "  hasPrivacyDiscipline: input.includes('Do not request, infer, or reconstruct raw JSONL'),",
      "  hasPrivacyBoundary: input.includes('Omitted: raw JSONL'),",
      "  hasRawJsonlSyntax: input.includes('\\\"type\\\":\\\"user\\\"'),",
      `  hasRawJsonlMarker: input.includes(${JSON.stringify(rawJsonlMarker)}),`,
      `  hasTranscriptTailMarker: input.includes(${JSON.stringify(transcriptTailMarker)}),`,
      "};",
      "writeFileSync(process.env.TRACEQUEST_SMOKE_AGENT_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), input, contract }, null, 2));",
      "if (!contract.hasHeader || !contract.hasInstructions || !contract.hasSectionContract || !contract.hasSummariesOnly || !contract.hasPrivacyDiscipline || !contract.hasPrivacyBoundary || contract.hasRawJsonlSyntax || contract.hasRawJsonlMarker || contract.hasTranscriptTailMarker) {",
      "  process.stderr.write(`TRACEQUEST_FIXTURE_AGENT_CONTRACT_FAIL ${JSON.stringify(contract)}\\n`);",
      "  process.exit(7);",
      "}",
      "process.stdout.write('TRACEQUEST_FIXTURE_AGENT_OK\\n');",
      "",
    ].join("\n"));
    chmodSync(fixtureAgent, 0o755);

    const profilesDir = join(home, ".tracequest");
    mkdirSync(profilesDir, { recursive: true });
    writeFileSync(join(profilesDir, "standup-profiles.json"), JSON.stringify({
      daily: {
        project,
        workday: true,
        limit: 5,
        agentCommand: fixtureAgent,
        agentArgs: ["--fixture-agent"],
        params: { model: "synthetic-smoke" },
      },
      previousDaily: {
        project,
        previousWorkday: true,
        limit: 5,
        agentCommand: fixtureAgent,
        agentArgs: ["--fixture-agent"],
        params: { model: "synthetic-smoke" },
      },
    }, null, 2));

    const profileAudit = await runTracequest(
      ["standup", "--profile", "daily", "--print-input"],
      { env: { ...baseEnv, TRACEQUEST_SMOKE_AGENT_CAPTURE: agentCapture } },
    );
    assert.match(profileAudit.stdout, /Window: workday/);
    assert.match(profileAudit.stdout, /smoke handoff needle and workday standup checkpoint/);
    assert.equal(existsSync(agentCapture), false, "--print-input must not invoke profile agent");

    const previousProfileAudit = await runTracequest(
      ["standup", "--profile", "previousDaily", "--print-input"],
      { env: { ...baseEnv, TRACEQUEST_SMOKE_AGENT_CAPTURE: agentCapture } },
    );
    assert.match(previousProfileAudit.stdout, /Window: previous workday/);
    assert.match(previousProfileAudit.stdout, /previous workday standup checkpoint should be included/);
    assert.doesNotMatch(previousProfileAudit.stdout, /smoke handoff needle and workday standup checkpoint/);
    assert.equal(existsSync(agentCapture), false, "--print-input must not invoke previous-workday profile agent");

    const previousProfileOverride = await runTracequest(
      ["standup", "--profile", "previousDaily", "--workday", "--print-input"],
      { env: { ...baseEnv, TRACEQUEST_SMOKE_AGENT_CAPTURE: agentCapture } },
    );
    assert.match(previousProfileOverride.stdout, /Window: workday/);
    assert.match(previousProfileOverride.stdout, /smoke handoff needle and workday standup checkpoint/);
    assert.doesNotMatch(previousProfileOverride.stdout, /previous workday standup checkpoint should be included/);

    const missingAgent = await runTracequest(
      ["standup", "--workday", "--limit", "1"],
      {
        env: { ...baseEnv, PATH: "/usr/bin:/bin" },
        expectCode: 1,
      },
    );
    assert.equal(missingAgent.stdout, "");
    assert.match(missingAgent.stderr, /No prompt-mode agent command found/);
    assert.doesNotMatch(missingAgent.stderr, /TraceQuest Standup Request|Running standup agent/);

    const agentRun = await runTracequest(
      ["standup", "--profile", "daily"],
      { env: { ...baseEnv, TRACEQUEST_SMOKE_AGENT_CAPTURE: agentCapture } },
    );
    assert.match(agentRun.stdout, /TRACEQUEST_FIXTURE_AGENT_OK/);
    assert.match(agentRun.stderr, /Running standup agent:/);
    const captured = JSON.parse(readFileSync(agentCapture, "utf8"));
    assert.deepEqual(captured.argv, ["--fixture-agent", "--model", "synthetic-smoke"]);
    assert.match(captured.input, /TraceQuest Standup Request/);
    assert.match(captured.input, /## Prompt-Agent Instructions/);
    assert.match(captured.input, /Use sections: Progress, Risks\/Blockers, and Next Steps/);
    assert.match(captured.input, /Use only the compact summaries below/);
    assert.match(captured.input, /Do not request, infer, or reconstruct raw JSONL/);
    assert.match(captured.input, /Omitted: raw JSONL/);
    assert.match(captured.input, /smoke handoff needle and workday standup checkpoint/);
    assert.doesNotMatch(captured.input, /after workday prompt should be filtered/);
    assert.equal(captured.contract.hasRawJsonlSyntax, false);
    assert.equal(captured.contract.hasRawJsonlMarker, false);
    assert.equal(captured.contract.hasTranscriptTailMarker, false);
    assertNoPrivatePaths(captured.input, home, "fixture agent stdin");

    console.log("standup/handoff synthetic CLI smoke passed");
  } catch (err) {
    keepTmp = true;
    console.error(`standup/handoff synthetic CLI smoke failed; temp HOME kept at ${home}`);
    throw err;
  } finally {
    if (!keepTmp) {
      rmSync(home, { recursive: true, force: true });
    }
  }
}

function mkdtemp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
