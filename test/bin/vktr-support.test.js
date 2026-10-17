import "../helpers/skip-lr-watch-env.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkTmp, writeJsonl } from "../helpers/fixtures.js";
import {
  GROK_FAMILY,
  grokFamilySourceForPath,
  grokSessionDir,
  isGrokFamily,
  vktrSessionsRoot,
} from "../../src/sessions/session-layout.js";
import { discoverSessions } from "../../src/sessions/session-discovery.js";
import { parseSession } from "../../src/parse/index.js";
import { indexSession, KNOWN_SESSION_SOURCES } from "../../src/sessions/session-index-core.js";
import { peekSession } from "../../src/sessions/session-peek.js";
import { scanSessionForQuery } from "../../src/sessions/scan-queries.js";
import {
  AGENT_REGISTRY,
  agentForSource,
  agentSupportsResume,
  agentSupportsSessionId,
  buildLaunchArgv,
  buildResumeArgv,
} from "../../src/agents/agent-detect.js";
import { expectedSessionPaths, runSessionCandidates } from "../../src/sessions/run-session-link.js";
import { isSessionPath, sourceForSessionPath, agentSessionRootPrefixes } from "../../src/server/server-session-path.js";
import { collectUsageLimits, UNAVAILABLE_HARNESSES } from "../../src/usage/collect.js";
import { SSH_IMPORT_SOURCES } from "../../src/import/ssh-import.js";
import { loadHubConfig } from "../../src/hub/config.js";
import { sourceHueVar, TOKENS_CSS } from "../../src/ui/tokens.js";
import { SOURCE_COLORS } from "../../src/browser/app-chrome.js";

const ROOT = new URL("../../", import.meta.url).pathname;
const CWD = "/home/dev/vk";
const SID = "01a120b4-324e-7e70-8bfe-a7af41b40a2b";

let home;
let prevHome;
let vktrDir;
let grokDir;

/** One vktr 1.0.38-shaped session: rows copied from the real ~/.vktr field set. */
function writeVktrSession(dir, { modelId = "viktor" } = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "prompt_context.json"), JSON.stringify({ working_directory: CWD, version: "1.0.38" }));
  writeJsonl(join(dir, "chat_history.jsonl"), [
    { type: "system", content: "You are vktr." },
    { type: "user", content: [{ type: "text", text: "<user_query>\nlist the vktr fixture files\n</user_query>" }], prompt_index: 0 },
    {
      type: "assistant",
      content: "Listing them now.",
      ...(modelId ? { model_id: modelId } : {}),
      tool_calls: [{ id: "call-1", name: "run_terminal_cmd", arguments: JSON.stringify({ command: "ls vktr-needle-dir" }) }],
    },
    { type: "tool_result", tool_call_id: "call-1", content: "a.txt\nvktr-only-phrase-31" },
    { type: "assistant", content: "Two entries.", ...(modelId ? { model_id: modelId } : {}), tool_calls: [] },
  ]);
  writeJsonl(join(dir, "events.jsonl"), [
    { type: "turn_started", ts: "2026-10-13T22:20:00Z", session_id: SID, ...(modelId ? { model_id: modelId } : {}), turn_number: 1 },
    { type: "tool_started", ts: "2026-10-13T22:20:05Z", tool_name: "run_terminal_cmd" },
    { type: "tool_completed", ts: "2026-10-13T22:20:06Z", tool_name: "run_terminal_cmd", outcome: "success", duration_ms: 900, tool_call_id: "call-1" },
    { type: "turn_ended", ts: "2026-10-13T22:21:00Z", outcome: "completed", cancellation_category: null, cancellation_context: null },
  ]);
  writeFileSync(join(dir, "signals.json"), JSON.stringify({ contextTokensUsed: 2358 }));
}

before(() => {
  home = mkTmp("tq-vktr-");
  prevHome = process.env.HOME;
  process.env.HOME = home;
  vktrDir = grokSessionDir(home, CWD, SID, "vktr");
  writeVktrSession(vktrDir);
  grokDir = grokSessionDir(home, CWD, "grok-sess", "grok");
  writeJsonl(join(grokDir, "chat_history.jsonl"), [{ type: "user", content: "a grok prompt" }]);
});

after(() => {
  process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

test("vktr grok family registry names each agent's home dir and binary", () => {
  assert.deepEqual(GROK_FAMILY.map((m) => [m.id, m.homeDir, m.binary]), [["grok", ".grok", "grok"], ["vktr", ".vktr", "vktr"]]);
  assert.ok(isGrokFamily("vktr") && isGrokFamily("grok") && !isGrokFamily("claude"));
  assert.equal(vktrSessionsRoot(home), join(home, ".vktr", "sessions"));
  assert.equal(vktrDir, join(home, ".vktr", "sessions", encodeURIComponent(CWD), SID));
  assert.equal(grokFamilySourceForPath(vktrDir), "vktr");
  assert.equal(grokFamilySourceForPath(grokDir), "grok");
  assert.equal(grokFamilySourceForPath("/home/x/.claude/projects/a.jsonl"), null);
});

test("vktr sessions are discovered with source vktr next to grok sessions", () => {
  const found = discoverSessions();
  const vktr = found.filter((s) => s.source === "vktr");
  assert.equal(vktr.length, 1);
  assert.equal(vktr[0].path, vktrDir);
  assert.equal(vktr[0].file, SID);
  assert.match(vktr[0].project, /vk$/);
  assert.equal(found.filter((s) => s.source === "grok").length, 1);
});

test("vktr session parses with prompts, tool calls, tool results, tokens and source vktr", () => {
  const session = parseSession(vktrDir);
  assert.equal(session.source, "vktr");
  assert.equal(session.model, "viktor");
  const users = session.events.filter((e) => e.type === "user");
  assert.deepEqual(users.map((e) => e.text), ["list the vktr fixture files"]);
  const assistants = session.events.filter((e) => e.type === "assistant");
  assert.equal(assistants.length, 2);
  assert.equal(assistants[0].toolCalls.length, 1);
  assert.equal(assistants[0].toolCalls[0].id, "call-1");
  const results = session.events.filter((e) => e.type === "tool_result");
  assert.equal(results.length, 1);
  assert.equal(results[0].isError, false);
  assert.equal(assistants.reduce((n, e) => n + e.tokens.input, 0), 2358);
});

test("vktr session parses with model fallback vktr when no model_id is recorded", () => {
  const dir = grokSessionDir(home, "/home/dev/nomodel", "no-model", "vktr");
  writeVktrSession(dir, { modelId: null });
  try {
    assert.equal(parseSession(dir).model, "vktr");
    assert.equal(indexSession({ path: dir, source: "vktr" }).model, "vktr");
  } finally {
    rmSync(join(home, ".vktr", "sessions", encodeURIComponent("/home/dev/nomodel")), { recursive: true, force: true });
  }
});

test("vktr sessions index, peek and search through the grok code paths", () => {
  assert.ok(KNOWN_SESSION_SOURCES.includes("vktr"));
  const entry = indexSession({ path: vktrDir, source: "vktr" });
  assert.equal(entry.model, "viktor");
  assert.equal(entry.firstPrompt, "list the vktr fixture files");
  const peek = peekSession({ path: vktrDir, source: "vktr" });
  assert.equal(peek.firstPrompt, "list the vktr fixture files");
  const hits = scanSessionForQuery({ path: vktrDir, source: "vktr" }, "vktr-only-phrase-31");
  assert.ok(hits.length >= 1);
});

test("vktr launch registry, resume and run attribution use the grok argv and the ~/.vktr layout", () => {
  const entry = AGENT_REGISTRY.find((e) => e.id === "vktr");
  assert.equal(entry.binary, "vktr");
  assert.equal(agentForSource("vktr"), "vktr");
  assert.ok(agentSupportsSessionId("vktr") && agentSupportsResume("vktr"));
  assert.deepEqual(buildLaunchArgv("vktr", "-fix it", { sessionId: "u-1" }), ["vktr", "--session-id", "u-1", "--", "-fix it"]);
  assert.deepEqual(buildResumeArgv("vktr", SID, { sessionId: "u-2" }), ["vktr", "--resume", SID, "--fork-session", "--session-id", "u-2"]);
  assert.deepEqual(expectedSessionPaths({ agent: "vktr", cwd: CWD, sessionId: SID, home }), [vktrDir]);
  assert.deepEqual(runSessionCandidates({ agent: "vktr", cwd: CWD, home }).map((c) => c.path), [vktrDir]);
  assert.deepEqual(runSessionCandidates({ agent: "grok", cwd: CWD, home }).map((c) => c.path), [grokDir]);
});

test("vktr surfaces: server paths, hue tokens, hub config, ssh import and help", () => {
  assert.equal(sourceForSessionPath(vktrDir), "vktr");
  assert.ok(agentSessionRootPrefixes(home).includes(`${home}/.vktr/`));
  assert.equal(isSessionPath(vktrDir), true);
  assert.equal(sourceHueVar("vktr"), "var(--hue-vktr)");
  assert.equal((TOKENS_CSS.match(/--hue-vktr:/g) || []).length >= 2, true);
  assert.equal(SOURCE_COLORS.vktr, "var(--hue-vktr)");
  assert.deepEqual(SSH_IMPORT_SOURCES.find((s) => s.id === "vktr")?.rel, [".vktr", "sessions"]);
  const cfg = join(home, "hub.json");
  writeFileSync(cfg, JSON.stringify({ hosts: [{ spec: "gpu", hostId: "gpu", sources: { vktr: "~/.vktr/sessions" } }] }));
  assert.equal(loadHubConfig(cfg).hosts[0].sources.vktr, "~/.vktr/sessions");
  const help = execFileSync(process.execPath, ["bin/tracequest.js", "--help"], { cwd: ROOT, encoding: "utf8" });
  assert.match(help, /Supported agents: .*vktr/);
  assert.match(readFileSync(join(ROOT, "README.md"), "utf8"), /vktr/);
  assert.match(readFileSync(join(ROOT, "docs/cli-reference.md"), "utf8"), /~\/\.vktr\/sessions/);
});

test("vktr usage limits are an unavailable row, never a grok subscription fetch", async () => {
  assert.ok(UNAVAILABLE_HARNESSES.includes("vktr"));
  const fetched = [];
  const snap = await collectUsageLimits({
    home,
    readFile: () => null,
    readCursorToken: async () => null,
    fetchImpl: async (url) => { fetched.push(String(url)); return new Response("{}", { status: 401 }); },
  });
  const row = snap.harnesses.find((h) => h.id === "vktr");
  assert.equal(row.status, "unavailable");
  assert.equal(row.message, "no remaining-window collector");
  assert.equal(snap.harnesses.filter((h) => h.id === "vktr").length, 1);
  // No credential on disk: neither grok's subscription endpoint nor any Viktor URL is called.
  assert.deepEqual(fetched.filter((u) => /grok|viktor/i.test(u)), []);
});
