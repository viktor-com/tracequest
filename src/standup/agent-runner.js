import { spawn, spawnSync } from "node:child_process";

export const DEFAULT_AGENT_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_AGENT_PROBE_TIMEOUT_MS = 120 * 1000;
export const PROMPT_AGENT_PROBE_PREFLIGHT_NOTICE = [
  "TraceQuest standup agent probe: intentionally invoking installed built-in prompt-agent CLIs with synthetic sentinel prompts only.",
  "No sessions are discovered, no real-trace compact input is built, and no raw JSONL, real prompts, assistant replies, tool outputs, or absolute session paths are sent.",
  "JSON probe report will be written to stdout.",
].join(" ");

export const STANDUP_AGENT_ENV = {
  command: "TRACEQUEST_STANDUP_AGENT_COMMAND",
  args: "TRACEQUEST_STANDUP_AGENT_ARGS",
  timeoutMs: "TRACEQUEST_STANDUP_AGENT_TIMEOUT_MS",
};

export const DEFAULT_PROMPT_AGENT_CANDIDATES = [
  {
    id: "codex",
    command: "codex",
    // `--skip-git-repo-check` mirrors the probe: without it `codex exec` refuses
    // to run outside a trusted git repo (e.g. from /tmp) with "Not inside a
    // trusted directory", which turned a read-only standup into a hard failure.
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
  {
    id: "claude",
    command: "claude",
    args: ["--print"],
    input: "stdin",
  },
  {
    id: "droid",
    command: "droid",
    args: ["exec"],
    input: "stdin",
  },
];

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

export function parseEnvAgentArgs(value) {
  const text = String(value ?? "").trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`${STANDUP_AGENT_ENV.args} must be a JSON array or whitespace-separated argv: ${err.message}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`${STANDUP_AGENT_ENV.args} must be a JSON array or whitespace-separated argv.`);
    }
    return parsed.map((item) => String(item));
  }
  return text.split(/\s+/).filter(Boolean);
}

export function standupAgentDefaultsFromEnv(env = process.env) {
  return {
    command: env[STANDUP_AGENT_ENV.command] || null,
    args: parseEnvAgentArgs(env[STANDUP_AGENT_ENV.args]),
    timeoutMs: env[STANDUP_AGENT_ENV.timeoutMs] || null,
  };
}

function kebabKey(key) {
  return String(key)
    .replace(/_/g, "-")
    .replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)
    .replace(/^-+/, "");
}

export function paramsToArgs(params = {}) {
  const out = [];
  for (const [key, rawValue] of Object.entries(params || {})) {
    const flag = key.length === 1 ? `-${key}` : `--${kebabKey(key)}`;
    for (const value of asArray(rawValue)) {
      if (value === false || value == null) continue;
      out.push(flag);
      if (value !== true) out.push(String(value));
    }
  }
  return out;
}

export function commandExists(command, deps = {}) {
  const spawnSyncImpl = deps.spawnSync || spawnSync;
  const result = spawnSyncImpl("which", [command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && String(result.stdout || "").trim().length > 0;
}

export function detectPromptAgent(opts = {}) {
  const candidates = opts.candidates || DEFAULT_PROMPT_AGENT_CANDIDATES;
  const exists = opts.commandExists || ((command) => commandExists(command, opts));
  for (const candidate of candidates) {
    if (exists(candidate.command)) {
      return {
        id: candidate.id,
        command: candidate.command,
        args: [...(candidate.args || [])],
        promptArg: candidate.promptArg,
        input: candidate.input || "stdin",
        detected: true,
      };
    }
  }
  return null;
}

function promptAgentNotFoundMessage(candidates = DEFAULT_PROMPT_AGENT_CANDIDATES) {
  const tried = candidates
    .map((candidate) => candidate.command)
    .filter(Boolean)
    .join(", ");
  return [
    "No prompt-mode agent command found.",
    tried ? `Tried: ${tried}.` : "",
    "Install one of those CLIs or pass --agent-command <cmd>.",
    "Use repeated --agent-arg for argv items, repeated --param key=value for flags, and --print-input to audit the compact prompt without invoking an agent.",
  ].filter(Boolean).join(" ");
}

export function buildPromptAgentInvocation(opts = {}, deps = {}) {
  const configuredCommand = opts.command || opts.agentCommand || null;
  const configuredArgs = asArray(opts.args || opts.agentArgs);
  const params = opts.params || opts.agentParams || {};

  const base = configuredCommand
    ? {
      id: opts.id || "configured",
      command: configuredCommand,
      args: [],
      promptArg: null,
      input: "stdin",
      detected: false,
    }
    : detectPromptAgent({
      candidates: opts.candidates,
      commandExists: opts.commandExists,
      spawnSync: deps.spawnSync,
    });

  if (!base) {
    throw new Error(promptAgentNotFoundMessage(opts.candidates));
  }

  return {
    id: base.id,
    command: base.command,
    args: [
      ...(base.args || []),
      ...configuredArgs.map(String),
      ...paramsToArgs(params),
      ...(base.promptArg ? [base.promptArg] : []),
    ],
    input: "stdin",
    cwd: opts.cwd,
    env: opts.env,
    detected: base.detected,
  };
}

export function buildPromptAgentDetectionReport(invocation, opts = {}) {
  return {
    mode: "standup-agent-detection-dry-run",
    agent: {
      id: invocation.id,
      source: invocation.detected ? "detected" : "configured",
      command: invocation.command,
      args: [...(invocation.args || [])],
      input: invocation.input || "stdin",
    },
    timeoutMs: opts.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
    actions: {
      discoveredSessions: false,
      builtCompactInput: false,
      sentPrompt: false,
      invokedAgent: false,
    },
  };
}

function normalizeTimeoutMs(value, fallback = DEFAULT_AGENT_TIMEOUT_MS) {
  if (value == null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function sanitizeProbeId(value) {
  return String(value || "agent")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "AGENT";
}

export function buildPromptAgentProbeInput(agentId) {
  const sentinel = `TQ_AGENT_PROBE_${sanitizeProbeId(agentId)}_OK`;
  const input = [
    "# TraceQuest Standup Agent Probe",
    "",
    "Data policy: synthetic prompt-agent probe only.",
    "No sessions were discovered. No compact input was built from real traces.",
    "No private TraceQuest prompts, assistant replies, tool outputs, raw JSONL, or absolute session paths are included.",
    "Do not inspect files, run commands, or use tools.",
    "",
    "Synthetic session: tqsyntheticprobe001",
    "Progress: verify that this installed prompt-agent command can read a prompt from stdin.",
    "",
    `Reply with exactly ${sentinel} and nothing else.`,
  ].join("\n");
  return { input, sentinel };
}

function probeArgvForCandidate(candidate) {
  return [
    ...(candidate.probeArgs || candidate.args || []),
    ...(candidate.promptArg ? [candidate.promptArg] : []),
  ].map(String);
}

function compactProbeSnippet(value, max = 240) {
  const text = sanitizeProbeDiagnostic(value)
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function stripAnsi(value) {
  return String(value || "").replace(/\x1b\[[0-9;]*m/g, "");
}

function sanitizeProbeDiagnostic(value) {
  return stripAnsi(value)
    .replace(/\b([A-Za-z]:\\(?:[^\\\s"'<>|]+\\)*[^\\\s"'<>|]*)/g, "<path>")
    .replace(/(^|[\s"'([{:=,])(~\/[^\s"'<>)]*)/g, "$1<path>")
    .replace(/(^|[\s"'([{:=,])(\/(?!\/)[^\s"'<>)]*)/g, "$1<path>")
    .replace(/tracequest-standup-agent-probe-[A-Za-z0-9._-]+/g, "<temp-workdir>")
    .replace(/tq-(?:standup-agent|cli-probe-home|agent-probe)-[A-Za-z0-9._-]+/g, "<temp-workdir>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "<session-id>")
    .replace(/\b((?:session|conversation|thread)[-_ ]?(?:id)?\s*[:=]\s*)[A-Za-z0-9_.:-]{8,}\b/gi, "$1<session-id>")
    .replace(/\b(?:session|conversation|thread)[-_][A-Za-z0-9_.:-]{8,}\b/gi, "<session-id>");
}

function stdoutHasSentinelLine(stdout, sentinel) {
  return stripAnsi(stdout)
    .split(/\r?\n/)
    .some((line) => line.trim() === sentinel);
}

function summarizeProbeAgents(agents) {
  const summary = { passed: 0, failed: 0, missing: 0, skipped: 0 };
  for (const agent of agents) {
    if (Object.prototype.hasOwnProperty.call(summary, agent.status)) summary[agent.status] += 1;
  }
  return summary;
}

export async function probePromptAgents(opts = {}, deps = {}) {
  const candidates = opts.candidates || DEFAULT_PROMPT_AGENT_CANDIDATES;
  const exists = opts.commandExists || ((command) => commandExists(command, deps));
  const timeoutMs = normalizeTimeoutMs(
    opts.timeoutMs ?? opts.agentTimeoutMs,
    DEFAULT_AGENT_PROBE_TIMEOUT_MS,
  );
  const agents = [];

  for (const candidate of candidates) {
    const args = probeArgvForCandidate(candidate);
    const base = {
      id: candidate.id,
      command: candidate.command,
      args,
      input: candidate.input || "stdin",
    };

    if ((candidate.input || "stdin") !== "stdin") {
      agents.push({
        ...base,
        status: "skipped",
        reason: "candidate does not declare stdin prompt input",
      });
      continue;
    }

    if (!candidate.command || !exists(candidate.command)) {
      agents.push({
        ...base,
        status: "missing",
        reason: "command not found on PATH",
      });
      continue;
    }

    const { input, sentinel } = buildPromptAgentProbeInput(candidate.id);
    try {
      const result = await runPromptAgent(input, {
        invocation: {
          id: candidate.id,
          command: candidate.command,
          args,
          input: "stdin",
          cwd: opts.cwd,
          env: opts.env,
          detected: true,
        },
        timeoutMs,
      }, deps);

      const failedReason = result.timedOut
        ? `timed out after ${result.timeoutMs}ms`
        : result.signal
          ? `exited from signal ${result.signal}`
          : result.status && result.status !== 0
            ? `exited with status ${result.status}`
            : result.stdinError
              ? `stdin write failed: ${result.stdinError.message}`
            : !stdoutHasSentinelLine(result.stdout, sentinel)
              ? "sentinel line not found in stdout"
              : "";

      agents.push({
        ...base,
        status: failedReason ? "failed" : "passed",
        reason: compactProbeSnippet(failedReason || "sentinel line found in stdout"),
        sentinel,
        exitStatus: result.status,
        signal: result.signal,
        timedOut: result.timedOut,
        stdoutSnippet: compactProbeSnippet(result.stdout),
        stderrSnippet: compactProbeSnippet(result.stderr),
      });
    } catch (err) {
      agents.push({
        ...base,
        status: "failed",
        reason: compactProbeSnippet(err?.message || String(err)),
        sentinel,
        stdoutSnippet: "",
        stderrSnippet: "",
      });
    }
  }

  return {
    mode: "standup-agent-probe",
    dataPolicy: "synthetic prompts only; no sessions discovered, no compact input built from real traces, no raw JSONL, full transcripts, tool outputs, absolute session paths, or private TraceQuest data sent",
    timeoutMs,
    actions: {
      loadedProfile: false,
      discoveredSessions: false,
      builtCompactInputFromRealTraces: false,
      sentPrivateTraceData: false,
    },
    summary: summarizeProbeAgents(agents),
    agents,
  };
}

export function runPromptAgent(input, opts = {}, deps = {}) {
  const invocation = opts.invocation || buildPromptAgentInvocation(opts, deps);
  const timeoutMs = normalizeTimeoutMs(opts.timeoutMs ?? opts.agentTimeoutMs);
  const spawnImpl = deps.spawn || spawn;
  const onStdout = typeof opts.onStdout === "function" ? opts.onStdout : null;
  const onStderr = typeof opts.onStderr === "function" ? opts.onStderr : null;
  return new Promise((resolve, reject) => {
    const child = spawnImpl(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env ? { ...process.env, ...invocation.env } : process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdinError = null;
    let timedOut = false;
    let timer = null;
    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const recordStdinError = (err) => {
      if (stdinError) return;
      stdinError = {
        code: err?.code || null,
        message: err?.message || String(err),
      };
      const line = `Prompt agent stdin write failed: ${stdinError.message}`;
      stderr += `${stderr && !stderr.endsWith("\n") ? "\n" : ""}${line}\n`;
      onStderr?.(`${line}\n`);
    };
    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      onStdout?.(text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      onStderr?.(text);
    });
    child.on("error", (err) => {
      clearTimer();
      if (err?.code === "ENOENT") {
        err.message = `Failed to start prompt agent command "${invocation.command}": command not found. Check --agent-command or PATH.`;
      } else if (err?.message) {
        err.message = `Failed to start prompt agent command "${invocation.command}": ${err.message}`;
      }
      reject(err);
    });
    child.on("close", (status, signal) => {
      clearTimer();
      resolve({ ...invocation, status, signal, stdout, stderr, stdinError, timedOut, timeoutMs });
    });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill?.("SIGTERM");
      }, timeoutMs);
    }
    child.stdin?.on?.("error", recordStdinError);
    try {
      child.stdin?.end(String(input ?? ""));
    } catch (err) {
      recordStdinError(err);
    }
  });
}
