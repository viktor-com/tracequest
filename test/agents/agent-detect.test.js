/**
 * Fixed agent registry + which-style PATH detection (probe injectable —
 * never touches the real PATH in these tests).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_REGISTRY,
  agentForSource,
  agentSupportsResume,
  agentSupportsSessionId,
  buildLaunchArgv,
  buildResumeArgv,
  commandOnPath,
  detectAgents,
} from "../../src/agents/agent-detect.js";

const REGISTRY_IDS = ["claude", "codex", "cursor-agent", "opencode", "grok", "droid", "gemini"];

describe("agent registry + detection", () => {
  test("registry pins exactly the seven launchable agents", () => {
    assert.deepEqual(AGENT_REGISTRY.map((e) => e.id), REGISTRY_IDS);
    for (const entry of AGENT_REGISTRY) {
      assert.equal(typeof entry.binary, "string");
      assert.ok(entry.binary.length > 0);
      assert.equal(typeof entry.promptArgs, "function");
    }
  });

  test("prompt argv shapes are arrays with the prompt as one discrete element", () => {
    const prompt = "fix the bug; rm -rf /";
    for (const entry of AGENT_REGISTRY) {
      const args = entry.promptArgs(prompt);
      assert.ok(Array.isArray(args), `${entry.id} promptArgs must return an array`);
      assert.ok(args.includes(prompt), `${entry.id} must carry the prompt as one argv element`);
    }
    assert.deepEqual(buildLaunchArgv("claude", prompt), ["claude", "--", prompt]);
    assert.deepEqual(buildLaunchArgv("opencode", prompt), ["opencode", "--prompt", prompt]);
  });

  test("positional prompts ride behind an end-of-options -- so dash-leading prompts stay prompts", () => {
    // MUX-002 regression: without "--" a prompt like "- fix these bullets"
    // (or a same-trust flag such as "--dangerously-skip-permissions") would
    // be parsed as agent CLI options instead of the prompt.
    const dashPrompt = "- dash-leading prompt";
    for (const entry of AGENT_REGISTRY) {
      if (entry.id === "opencode") continue; // flag-form agent, no positional
      assert.deepEqual(
        entry.promptArgs(dashPrompt),
        ["--", dashPrompt],
        `${entry.id} must emit ["--", prompt]`,
      );
      assert.deepEqual(entry.promptArgs(null), [], `${entry.id} must emit no bare "--" without a prompt`);
      assert.deepEqual(entry.promptArgs(""), [], `${entry.id} must emit nothing for an empty prompt`);
    }
    // opencode keeps its --prompt flag form (the flag consumes the value).
    assert.deepEqual(buildLaunchArgv("opencode", dashPrompt), ["opencode", "--prompt", dashPrompt]);
  });

  test("omitted prompt yields the bare binary argv", () => {
    for (const id of REGISTRY_IDS) {
      const argv = buildLaunchArgv(id);
      assert.deepEqual(argv, [AGENT_REGISTRY.find((e) => e.id === id).binary]);
    }
  });

  test("detectAgents lists only agents whose binary the probe resolves", () => {
    const present = new Set(["claude", "grok"]);
    const agents = detectAgents({ probe: (binary) => present.has(binary) });
    assert.deepEqual(agents, [
      { id: "claude", binary: "claude", resume: true },
      { id: "grok", binary: "grok", resume: true },
    ]);
  });

  test("absent agents are omitted entirely — no error, no partial entry", () => {
    const agents = detectAgents({ probe: () => false });
    assert.deepEqual(agents, []);
  });

  test("agents outside the registry can never be detected", () => {
    const probed = [];
    const agents = detectAgents({
      probe: (binary) => {
        probed.push(binary);
        return true;
      },
    });
    assert.deepEqual(agents.map((a) => a.id), REGISTRY_IDS);
    assert.deepEqual(probed.sort(), [...REGISTRY_IDS].sort(), "probe sees only registry binaries");
    assert.equal(agents.some((a) => !REGISTRY_IDS.includes(a.id)), false);
  });

  test("unknown launch id yields null argv", () => {
    assert.equal(buildLaunchArgv("rogue-agent"), null);
    assert.equal(buildLaunchArgv("rogue-agent", "p", { sessionId: "u-1" }), null);
  });

  test("spawn-time session identity: exactly claude and grok accept a session uuid", () => {
    // Verified against the installed CLIs' --help: claude --session-id
    // <uuid> and grok --session-id <uuid> start a NEW conversation under a
    // caller-chosen uuid (the recording is named after it). No other
    // registry agent documents such a flag.
    const supporters = AGENT_REGISTRY.filter((e) => agentSupportsSessionId(e.id)).map((e) => e.id);
    assert.deepEqual(supporters, ["claude", "grok"]);
    assert.equal(agentSupportsSessionId("rogue-agent"), false);
  });

  test("buildLaunchArgv places --session-id BEFORE the end-of-options prompt marker", () => {
    const uuid = "3f2b8a10-1111-4222-8333-444455556666";
    assert.deepEqual(
      buildLaunchArgv("claude", "fix it", { sessionId: uuid }),
      ["claude", "--session-id", uuid, "--", "fix it"],
    );
    assert.deepEqual(
      buildLaunchArgv("grok", "fix it", { sessionId: uuid }),
      ["grok", "--session-id", uuid, "--", "fix it"],
    );
    // Without a prompt the identity args stand alone — never a bare "--".
    assert.deepEqual(buildLaunchArgv("claude", null, { sessionId: uuid }), ["claude", "--session-id", uuid]);
    // A null/absent sessionId changes nothing.
    assert.deepEqual(buildLaunchArgv("claude", "fix it"), ["claude", "--", "fix it"]);
    assert.deepEqual(buildLaunchArgv("claude", "fix it", { sessionId: null }), ["claude", "--", "fix it"]);
  });

  test("agents without a session-id flag silently drop the uuid (their argv must stay parseable)", () => {
    const uuid = "3f2b8a10-1111-4222-8333-444455556666";
    for (const id of ["codex", "cursor-agent", "droid", "gemini"]) {
      assert.deepEqual(buildLaunchArgv(id, "go", { sessionId: uuid }), [id, "--", "go"]);
    }
    assert.deepEqual(buildLaunchArgv("opencode", "go", { sessionId: uuid }), ["opencode", "--prompt", "go"]);
  });

  test("resume mechanisms: exactly claude, codex, cursor-agent, opencode, grok — droid and gemini are honest absences", () => {
    // Verified against the installed CLIs' --help output: claude
    // (-r/--resume + --fork-session + --session-id), grok (same trio,
    // explicitly documented as the fork-naming combination), codex
    // (`resume [SESSION_ID] [PROMPT]` subcommand), cursor-agent
    // (--resume [chatId]), opencode (-s/--session). droid and gemini were
    // not verifiable, so they carry NO resume entry and can never offer
    // Continue.
    const supporters = AGENT_REGISTRY.filter((e) => agentSupportsResume(e.id)).map((e) => e.id);
    assert.deepEqual(supporters, ["claude", "codex", "cursor-agent", "opencode", "grok"]);
    assert.equal(agentSupportsResume("droid"), false);
    assert.equal(agentSupportsResume("gemini"), false);
    assert.equal(agentSupportsResume("rogue-agent"), false);
    assert.equal(buildResumeArgv("droid", "some-id"), null);
    assert.equal(buildResumeArgv("gemini", "some-id"), null);
    assert.equal(buildResumeArgv("rogue-agent", "some-id"), null);
  });

  test("buildResumeArgv shapes per agent — resume flags, fork identity, end-of-options prompt", () => {
    const orig = "aaaaaaaa-1111-4222-8333-444455556666";
    const fork = "bbbbbbbb-1111-4222-8333-444455556666";
    // claude/grok: deterministic fork — resume the source, fork under a
    // launcher-minted uuid, prompt behind the end-of-options marker.
    assert.deepEqual(
      buildResumeArgv("claude", orig, { sessionId: fork, prompt: "keep going" }),
      ["claude", "--resume", orig, "--fork-session", "--session-id", fork, "--", "keep going"],
    );
    assert.deepEqual(
      buildResumeArgv("grok", orig, { sessionId: fork }),
      ["grok", "--resume", orig, "--fork-session", "--session-id", fork],
    );
    // codex: the resume subcommand with the session id positional.
    assert.deepEqual(buildResumeArgv("codex", orig), ["codex", "resume", orig]);
    assert.deepEqual(
      buildResumeArgv("codex", orig, { prompt: "go on" }),
      ["codex", "resume", orig, "--", "go on"],
    );
    // cursor-agent: --resume <chatId>.
    assert.deepEqual(buildResumeArgv("cursor-agent", orig), ["cursor-agent", "--resume", orig]);
    // opencode: --session <id> with the flag-form prompt.
    assert.deepEqual(
      buildResumeArgv("opencode", orig, { prompt: "go" }),
      ["opencode", "--session", orig, "--prompt", "go"],
    );
    // Agents without sessionIdArgs silently drop a sessionId, like launch.
    assert.deepEqual(buildResumeArgv("codex", orig, { sessionId: fork }), ["codex", "resume", orig]);
    // A missing resumeId can never produce an argv.
    assert.equal(buildResumeArgv("claude", ""), null);
    assert.equal(buildResumeArgv("claude", null), null);
  });

  test("resume source mapping covers every continuable source and nothing else", () => {
    assert.equal(agentForSource("claude"), "claude");
    assert.equal(agentForSource("cursor"), "cursor-agent");
    assert.equal(agentForSource("codex"), "codex");
    assert.equal(agentForSource("grok"), "grok");
    assert.equal(agentForSource("opencode"), "opencode");
    // factory maps to droid, which has no resume mechanism — the API then
    // answers the honest 400, and the UI never offers Continue.
    assert.equal(agentForSource("factory"), "droid");
    // cursor-cloud threads live in Cursor's cloud — no local resume path.
    assert.equal(agentForSource("cursor-cloud"), null);
    assert.equal(agentForSource("unknown"), null);
  });

  test("commandOnPath follows the which-style spawnSync probe", () => {
    const calls = [];
    const spawnSyncStub = (found) => (cmd, args) => {
      calls.push([cmd, args]);
      return found
        ? { status: 0, stdout: "/usr/local/bin/claude\n" }
        : { status: 1, stdout: "" };
    };
    assert.equal(commandOnPath("claude", { spawnSync: spawnSyncStub(true) }), true);
    assert.equal(commandOnPath("droid", { spawnSync: spawnSyncStub(false) }), false);
    assert.deepEqual(calls, [
      ["which", ["claude"]],
      ["which", ["droid"]],
    ]);
  });
});
