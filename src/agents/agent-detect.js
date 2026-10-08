/**
 * Fixed launchable-agent registry + PATH detection.
 *
 * Each registry entry pins the binary name and the per-agent argv shape for
 * passing an optional initial prompt — always an argv ARRAY (positional or
 * flag per agent), never a concatenated command string. Detection means
 * exactly "the binary resolves on PATH" via a which-style spawnSync probe
 * (see commandExists in src/standup/agent-runner.js); the agent itself is
 * never executed. Agents outside the registry can never be detected.
 */
import { spawnSync } from "node:child_process";

// Positional prompts ride behind an end-of-options "--" marker so a
// dash-leading prompt ("- fix these bullets", "--some-flag") is always
// read as the prompt, never parsed as an agent CLI option. Verified safe:
// the positional-prompt agents use commander (claude, cursor-agent) or
// clap (codex, grok) style parsers, which all honor "--". An empty prompt
// emits no argv at all — never a bare "--".
const positionalPrompt = (prompt) => (prompt ? ["--", prompt] : []);

// Spawn-time session identity: agents whose CLI accepts a caller-chosen
// session UUID name their recording after it (<uuid>.jsonl / <uuid>/), so
// run↔session attribution is deterministic BEFORE the first byte is
// written — no fd-probing, no birth-time heuristics. Verified against the
// installed CLIs' --help output:
//   claude  --session-id <uuid>   "Use a specific session ID for the
//                                  conversation (must be a valid UUID)"
//   grok    -s, --session-id <ID> "Use a specific session UUID for a NEW
//                                  conversation (must be a valid UUID and
//                                  must not already exist)"
// codex, cursor-agent, opencode, droid, and gemini expose no such flag
// (cursor-agent's create-chat subcommand mints ids but needs a network
// round-trip, so it is not a spawn argv shape) — those agents omit
// sessionIdArgs and fall back to the fd-probe/heuristic attribution tiers.
const uuidSessionId = (sessionId) => (sessionId ? ["--session-id", sessionId] : []);

// Per-agent resume mechanisms, each verified against the INSTALLED CLI's
// --help output (never by launching a session):
//   claude        -r, --resume [value]  "Resume a conversation by session ID"
//                 --fork-session        "When resuming, create a new session
//                                        ID instead of reusing the original
//                                        (use with --resume or --continue)"
//                 --session-id <uuid>   "Use a specific session ID for the
//                                        conversation (must be a valid UUID)"
//   grok          -r, --resume [<SESSION_ID>] "Resume a session by ID";
//                 -s, --session-id      "With --resume/--continue, only valid
//                                        together with --fork-session (names
//                                        the forked session)"
//   codex         `codex resume [SESSION_ID] [PROMPT]` subcommand ("Resume a
//                 previous interactive session")
//   cursor-agent  --resume [chatId]     "Select a session to resume"
//   opencode      -s, --session <id>    "session id to continue"
// claude and grok resume as a FORK named by a launcher-minted uuid
// (--resume <src> --fork-session --session-id <new>), so the new run's
// recording identity is deterministic before its first byte — the fork
// begins with the source conversation and continues from there. droid and
// gemini expose no verifiable resume mechanism and carry NO resumeArgs:
// honest absence — they can never offer Continue.
const resumeFork = (resumeId) => ["--resume", resumeId, "--fork-session"];

/** The fixed registry — the only agents tracequest can ever launch. */
export const AGENT_REGISTRY = [
  { id: "claude", binary: "claude", promptArgs: positionalPrompt, sessionIdArgs: uuidSessionId, resumeArgs: resumeFork },
  { id: "codex", binary: "codex", promptArgs: positionalPrompt, resumeArgs: (resumeId) => ["resume", resumeId] },
  { id: "cursor-agent", binary: "cursor-agent", promptArgs: positionalPrompt, resumeArgs: (resumeId) => ["--resume", resumeId] },
  { id: "opencode", binary: "opencode", promptArgs: (prompt) => (prompt ? ["--prompt", prompt] : []), resumeArgs: (resumeId) => ["--session", resumeId] },
  { id: "grok", binary: "grok", promptArgs: positionalPrompt, sessionIdArgs: uuidSessionId, resumeArgs: resumeFork },
  { id: "droid", binary: "droid", promptArgs: positionalPrompt },
  { id: "gemini", binary: "gemini", promptArgs: positionalPrompt },
];

/**
 * Session source → registry agent able to continue that source's sessions.
 * The map is total over the file-backed sources tracequest discovers;
 * sources without a continuation story (cursor-cloud threads live in
 * Cursor's cloud, not behind a local CLI flag) are simply absent.
 */
export const SOURCE_AGENTS = {
  claude: "claude",
  cursor: "cursor-agent",
  codex: "codex",
  grok: "grok",
  opencode: "opencode",
  factory: "droid",
};

/** Registry agent able to continue sessions of `source`, or null. */
export function agentForSource(source) {
  return SOURCE_AGENTS[source] || null;
}

/**
 * True when registry agent `id` accepts a spawn-time session UUID — the
 * launcher then generates one, passes it via sessionIdArgs, and persists it
 * as the run's @tq_session_id so attribution is identity by construction.
 */
export function agentSupportsSessionId(id) {
  const entry = AGENT_REGISTRY.find((e) => e.id === id);
  return typeof entry?.sessionIdArgs === "function";
}

/**
 * True when registry agent `id` has an empirically verified resume
 * mechanism (resumeArgs). Agents without one — droid, gemini — can never
 * offer Continue: honest absence, not a guessed flag.
 */
export function agentSupportsResume(id) {
  const entry = AGENT_REGISTRY.find((e) => e.id === id);
  return typeof entry?.resumeArgs === "function";
}

/** Which-style probe: does `binary` resolve on PATH? Never runs the binary. */
export function commandOnPath(binary, deps = {}) {
  const spawnSyncImpl = deps.spawnSync || spawnSync;
  const result = spawnSyncImpl("which", [binary], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && String(result.stdout || "").trim().length > 0;
}

/**
 * Detect launchable agents: registry entries whose binary resolves on PATH.
 * Absent agents are simply not listed — no error, no partial entry.
 * `opts.probe` (binary → boolean) is injectable for tests.
 */
export function detectAgents(opts = {}) {
  const probe = opts.probe || ((binary) => commandOnPath(binary, opts));
  const detected = [];
  for (const entry of AGENT_REGISTRY) {
    if (probe(entry.binary)) {
      detected.push({
        id: entry.id,
        binary: entry.binary,
        // Resume capability rides along so the browser can gate Continue
        // affordances from the one /api/agents answer.
        resume: typeof entry.resumeArgs === "function",
      });
    }
  }
  return detected;
}

/**
 * Resolve `binary` to its ABSOLUTE path on the serve process's PATH, or
 * null when it does not resolve. Launch-time necessity: a tmux window's
 * environment comes from the tmux SERVER, not from the serve process, so
 * PATH entries visible to serve (and to detection) are not visible inside
 * a window — the launcher must exec an absolute argv[0].
 */
export function resolveAgentBinary(binary, deps = {}) {
  const spawnSyncImpl = deps.spawnSync || spawnSync;
  const result = spawnSyncImpl("which", [binary], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  const resolved = String(result.stdout || "").split("\n")[0].trim();
  return resolved.length > 0 ? resolved : null;
}

/**
 * Argv array launching registry agent `id` with an optional initial prompt
 * (the prompt stays one discrete argv element) and an optional spawn-time
 * session UUID. Identity args come FIRST — a positional prompt's "--"
 * end-of-options marker must trail every real flag. A sessionId for an
 * agent without sessionIdArgs is silently dropped (that agent has no such
 * flag; passing one would break its argv parsing). Null for unknown ids.
 */
export function buildLaunchArgv(id, prompt = null, { sessionId = null } = {}) {
  const entry = AGENT_REGISTRY.find((e) => e.id === id);
  if (!entry) return null;
  const idArgs = entry.sessionIdArgs ? entry.sessionIdArgs(sessionId) : [];
  return [entry.binary, ...idArgs, ...entry.promptArgs(prompt)];
}

/**
 * Argv array RESUMING an existing session `resumeId` with registry agent
 * `id` — [binary, ...resumeArgs, ...sessionIdArgs, ...promptArgs], every
 * request-derived value one discrete argv element. For claude/grok the
 * caller mints `sessionId` (the fork's uuid, persisted as @tq_session_id)
 * so the resumed run's recording identity is deterministic; agents without
 * sessionIdArgs silently drop it, exactly like buildLaunchArgv. Null for
 * unknown ids, agents without a resume mechanism, or a missing resumeId.
 */
export function buildResumeArgv(id, resumeId, { sessionId = null, prompt = null } = {}) {
  const entry = AGENT_REGISTRY.find((e) => e.id === id);
  if (!entry || typeof entry.resumeArgs !== "function") return null;
  if (typeof resumeId !== "string" || resumeId.length === 0) return null;
  const idArgs = entry.sessionIdArgs ? entry.sessionIdArgs(sessionId) : [];
  return [entry.binary, ...entry.resumeArgs(resumeId), ...idArgs, ...entry.promptArgs(prompt)];
}
