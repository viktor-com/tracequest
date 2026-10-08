import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAUDE_FIXTURE_CWD,
  CLAUDE_FIXTURE_MODEL,
} from "./fixtures.js";

export const TRACEQUEST_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TRACEQUEST_BIN = join(TRACEQUEST_ROOT, "bin/tracequest.js");
export const TRACEQUEST_NODE = process.execPath;

export function runTracequestBin(args, {
  cwd = TRACEQUEST_ROOT,
  env = {},
  timeoutMs = 30_000,
  expectCode = 0,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(TRACEQUEST_NODE, [TRACEQUEST_BIN, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TRACEQUEST_NO_SIDECAR: "1", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`bin timeout after ${timeoutMs}ms: ${args.join(" ")}`));
    }, timeoutMs);
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== expectCode) {
        reject(new Error(
          `bin ${args.join(" ")} expected exit ${expectCode}, got ${code}\nstdout: ${stdout}\nstderr: ${stderr}`,
        ));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

export function writeStandupProfiles(home, profiles) {
  const configDir = join(home, ".tracequest");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "standup-profiles.json"), JSON.stringify(profiles));
}

export function writeFakeStandupProbePath(home) {
  const binDir = join(home, "fake-probe-bin");
  mkdirSync(binDir, { recursive: true });
  const fakeWhich = join(binDir, "which");
  writeFileSync(fakeWhich, [
    "#!/bin/sh",
    "case \"$1\" in",
    "  codex)",
    "    if [ -x \"$TRACEQUEST_FAKE_BIN/codex\" ]; then",
    "      printf '%s\\n' \"$TRACEQUEST_FAKE_BIN/codex\"",
    "      exit 0",
    "    fi",
    "    ;;",
    "esac",
    "exit 1",
    "",
  ].join("\n"));
  chmodSync(fakeWhich, 0o755);
  const fakeCodex = join(binDir, "codex");
  writeFileSync(fakeCodex, [
    "#!/bin/sh",
    "input=''",
    "while IFS= read -r line || [ -n \"$line\" ]; do",
    "  input=\"${input}${line}",
    "\"",
    "done",
    "case \"$input\" in",
    "  *TQ_AGENT_PROBE_CODEX_OK*)",
    "    printf '%s\\n' TQ_AGENT_PROBE_CODEX_OK",
    "    exit 0",
    "    ;;",
    "esac",
    "printf '%s\\n' 'synthetic sentinel missing' >&2",
    "exit 3",
    "",
  ].join("\n"));
  chmodSync(fakeCodex, 0o755);
  return binDir;
}

export function writeFakePromptAgentPath(home) {
  const binDir = join(home, "fake-prompt-agent-bin");
  mkdirSync(binDir, { recursive: true });

  const fakeWhich = join(binDir, "which");
  writeFileSync(fakeWhich, [
    "#!/bin/sh",
    "case \"$1\" in",
    "  codex|claude|droid|opencode|my-agent)",
    "    if [ -x \"$TRACEQUEST_FAKE_BIN/$1\" ]; then",
    "      printf '%s\\n' \"$TRACEQUEST_FAKE_BIN/$1\"",
    "      exit 0",
    "    fi",
    "    ;;",
    "esac",
    "exit 1",
    "",
  ].join("\n"));
  chmodSync(fakeWhich, 0o755);

  const agentScript = [
    "#!/bin/sh",
    "input=''",
    "while IFS= read -r line || [ -n \"$line\" ]; do",
    "  input=\"${input}${line}",
    "\"",
    "done",
    "case \"$input\" in",
    "  *TQ_AGENT_PROBE_CODEX_OK*) printf '%s\\n' TQ_AGENT_PROBE_CODEX_OK; exit 0 ;;",
    "  *TQ_AGENT_PROBE_CLAUDE_OK*) printf '%s\\n' TQ_AGENT_PROBE_CLAUDE_OK; exit 0 ;;",
    "  *TQ_AGENT_PROBE_DROID_OK*) printf '%s\\n' TQ_AGENT_PROBE_DROID_OK; exit 0 ;;",
    "  *TQ_AGENT_PROBE_OPENCODE_OK*) printf '%s\\n' TQ_AGENT_PROBE_OPENCODE_OK; exit 0 ;;",
    "  *'TraceQuest Standup Request'*) printf '%s\\n' FAKE_PROMPT_AGENT_OK; exit 0 ;;",
    "esac",
    "printf '%s\\n' 'fake prompt agent did not receive expected synthetic input' >&2",
    "exit 3",
    "",
  ].join("\n");
  for (const name of ["codex", "claude", "droid", "opencode", "my-agent"]) {
    const path = join(binDir, name);
    writeFileSync(path, agentScript);
    chmodSync(path, 0o755);
  }
  return binDir;
}

export function richClaudeFixture(sessionId, {
  model = CLAUDE_FIXTURE_MODEL,
  prompt = "e2e test prompt",
  tools = [],
} = {}) {
  const ts = "2026-06-03T12:00:00.000Z";
  const assistantContent = [{ type: "text", text: "e2e assistant reply" }];
  for (const t of tools) {
    assistantContent.push({
      type: "tool_use",
      id: `toolu_e2e_${t}`,
      name: t,
      input: { file_path: `/src/${t.toLowerCase()}.js` },
    });
  }
  const lines = [
    {
      type: "user",
      sessionId,
      cwd: CLAUDE_FIXTURE_CWD,
      timestamp: ts,
      uuid: `u-${sessionId}`,
      isMeta: false,
      message: { content: [{ type: "text", text: prompt }] },
    },
    {
      type: "assistant",
      sessionId,
      timestamp: ts,
      uuid: `a-${sessionId}`,
      message: { model, content: assistantContent },
    },
  ];
  for (const t of tools) {
    lines.push({
      type: "user",
      sessionId,
      timestamp: ts,
      uuid: `tr-${sessionId}-${t}`,
      isMeta: false,
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: `toolu_e2e_${t}`,
          content: [{ type: "text", text: `Result from ${t}` }],
        }],
      },
    });
    lines.push({
      type: "assistant",
      sessionId,
      timestamp: ts,
      uuid: `a2-${sessionId}-${t}`,
      message: { model, content: [{ type: "text", text: `Processed ${t} result.` }] },
    });
  }
  return lines;
}
