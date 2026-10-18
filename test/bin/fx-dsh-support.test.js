import "../helpers/skip-lr-watch-env.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { cpSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import zlib from "node:zlib";
import { mkTmp, writeJsonl } from "../helpers/fixtures.js";
import { decodeZstdFrames, readZstdFrames } from "../../src/parse/zstd-frames.js";
import { discoverSessions } from "../../src/sessions/session-discovery.js";
import { parseSession } from "../../src/parse/index.js";
import { indexSession, KNOWN_SESSION_SOURCES } from "../../src/sessions/session-index-core.js";
import { peekSession } from "../../src/sessions/session-peek.js";
import { scanSessionForQuery } from "../../src/sessions/scan-queries.js";
import { findLiveAgentSessions, setFindLiveClaudeDepsForTests } from "../../src/sessions/live-sessions.js";
import { recordingIsGenerating } from "../../src/sessions/live-session-generating.js";
import { isSessionPath, sourceForSessionPath, agentSessionRootPrefixes } from "../../src/server/server-session-path.js";
import { SSH_IMPORT_SOURCES, runSshImport } from "../../src/import/ssh-import.js";
import { loadHubConfig } from "../../src/hub/config.js";
import { sourceHueVar, TOKENS_CSS } from "../../src/ui/tokens.js";
import { SOURCE_COLORS } from "../../src/browser/app-chrome.js";
import { createHandle } from "../../src/server/server-http.js";
import { isImportedHostSession } from "../../src/sessions/session-discovery-paths.js";
import { handleApiSearch } from "../../src/routes/route-handlers-api.js";
import { resetIndexWritersForTests } from "../../src/sessions/index-writers.js";
import { clearRunSessionMemo, handleApiSessionsLive } from "../../src/routes/route-handlers-launch.js";
import { sessionFreshnessPath } from "../../src/sessions/run-session-link.js";
import { isRelevantDataFilename } from "../../src/server/server-live-reload.js";
import { sessionHash } from "../../src/sessions/session-hash.js";
import { mockHttpResponse } from "../helpers/capture-json-handler.js";

const ROOT = new URL("../../", import.meta.url).pathname;
const FIXTURES = join(ROOT, "test/fixtures/fx-dsh");
/** Real fx session (scrubbed): two turns, a failing test run, edits. */
const FX_MAIN = "J1awiyS7sSqf";
/** Real fx session that delegated to the subagent child FX_CHILD. */
const FX_PARENT = "CBwLZxqkuY5v";
const FX_CHILD = "HWr-N-WJc8XG";
const DSH_ID = "session-51fc1afe-8d30-4f77-98a3-7c7a5e9d67fc";
const CWD = "/home/dev/calc";

let home;
let prevHome;

/** ~/.dsh/sessions/<slug>/<dir>/session.v4.jsonl.zstd written as dsh does: one zstd frame per row. */
function writeDshRecording(dir, rows) {
  mkdirSync(dir, { recursive: true });
  const frames = rows.map((r) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(r) + "\n")));
  const path = join(dir, "session.v4.jsonl.zstd");
  writeFileSync(path, Buffer.concat(frames));
  return path;
}

function fxDir(id) {
  return join(home, ".fx", "sessions", id);
}

function dshMainPath() {
  return join(home, ".dsh", "sessions", "-home-dev-calc-", DSH_ID, "session.v4.jsonl.zstd");
}

before(() => {
  prevHome = process.env.HOME;
  home = mkTmp("tq-fx-dsh-");
  process.env.HOME = home;
  cpSync(join(FIXTURES, "fx"), join(home, ".fx", "sessions"), { recursive: true });
  mkdirSync(join(home, ".dsh", "sessions", "-home-dev-calc-", DSH_ID), { recursive: true });
  cpSync(join(FIXTURES, "dsh", "session.v4.jsonl.zstd"), dshMainPath());
});

after(() => {
  process.env.HOME = prevHome;
  setFindLiveClaudeDepsForTests(null);
  rmSync(home, { recursive: true, force: true });
});

/* ── zstd ─────────────────────────────────────────────────────────────── */

test("zstd frames: every concatenated frame decodes, where zlib stops after the first", () => {
  const path = join(FIXTURES, "dsh", "session.v4.jsonl.zstd");
  const buf = readFileSync(path);
  const firstOnly = zlib.zstdDecompressSync(buf).toString().trim().split("\n");
  const all = readZstdFrames(path).trim().split("\n");
  assert.equal(firstOnly.length, 1);
  assert.equal(all.length, 75);
  assert.equal(JSON.parse(all[0]).type, "session");
  assert.equal(JSON.parse(all[74]).type, "turn/end");
  assert.equal(readZstdFrames(path, 1).trim().split("\n").length, 1);
});

test("zstd frames: a truncated trailing frame is dropped and skippable frames are stepped over", () => {
  const a = zlib.zstdCompressSync(Buffer.from('{"n":1}\n'));
  const b = zlib.zstdCompressSync(Buffer.from('{"n":2}\n'));
  const skippable = Buffer.alloc(12);
  skippable.writeUInt32LE(0x184d2a50, 0);
  skippable.writeUInt32LE(4, 4);
  assert.equal(decodeZstdFrames(Buffer.concat([a, skippable, b])), '{"n":1}\n{"n":2}\n');
  assert.equal(decodeZstdFrames(Buffer.concat([a, b.subarray(0, b.length - 3)])), '{"n":1}\n');
});

/* ── discovery ────────────────────────────────────────────────────────── */

test("fx sessions are discovered with their workspace project and subagent parent", () => {
  const fx = discoverSessions(null, []).filter((s) => s.source === "fx");
  assert.deepEqual(fx.map((s) => s.file).sort(), [FX_PARENT, FX_CHILD, FX_MAIN].sort());
  const main = fx.find((s) => s.file === FX_MAIN);
  assert.equal(main.path, join(fxDir(FX_MAIN), "events.jsonl"));
  assert.equal(main.project, "calc");
  assert.equal(main.parentSession, undefined);
  assert.equal(fx.find((s) => s.file === FX_CHILD).parentSession, FX_PARENT);
});

test("dsh sessions are discovered from CLI session-<uuid> and ACP <uuid> dirs", () => {
  const acp = writeDshRecording(join(home, ".dsh", "sessions", "-tmp-acp-", "5957ddfd-343b-4293-ac80-e6df4ea35147"), [
    { type: "session", version: 4, id: "5957ddfd-343b-4293-ac80-e6df4ea35147", createdAt: 1792351747715, cwd: "/tmp/acp" },
  ]);
  try {
    const dsh = discoverSessions(null, []).filter((s) => s.source === "dsh");
    const main = dsh.find((s) => s.path === dshMainPath());
    assert.ok(main, "CLI session listed");
    assert.equal(main.project, "calc");
    const bare = dsh.find((s) => s.path === acp);
    assert.ok(bare, "ACP session listed");
    assert.equal(bare.project, "acp");
  } finally {
    rmSync(join(home, ".dsh", "sessions", "-tmp-acp-"), { recursive: true, force: true });
  }
});

/* ── parse ────────────────────────────────────────────────────────────── */

test("fx session parses: tools paired with results, failures, turn times and tokens", () => {
  const dir = join(home, "synthetic-fx", "s1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.json"), JSON.stringify({ id: "s1", workspace_root: CWD, model: "m-1", subagent_child: false }));
  const ev = (seq, ts, event) => ({ schema_version: 1, seq, timestamp_ms: ts, event });
  const shell = (exit, out) => JSON.stringify({ state: "completed", exit_code: exit, output_delta: out });
  writeJsonl(join(dir, "events.jsonl"), [
    ev(1, 2000, { user: { text: "run the checks" } }),
    ev(2, 2000, { assistant: { text: "Running.", provider_replay: { source: { model: "m-2" }, parts_json: JSON.stringify({ reasoning: "think first" }) } } }),
    ev(3, 2000, { tool_call: { call_id: "c1", tool_name: "shell", arguments_json: JSON.stringify({ command: "make test" }) } }),
    ev(4, 2000, { tool_call: { call_id: "c2", tool_name: "grep_files", arguments_json: JSON.stringify({ pattern: "TODO" }) } }),
    ev(5, 2000, { tool_result: { call_id: "c1", tool_name: "shell", status: "success", preview: shell(2, "boom\n") } }),
    ev(6, 2000, { tool_result: { call_id: "c2", tool_name: "grep_files", status: "failure", preview: "bad pattern" } }),
    ev(7, 2000, { assistant: { text: "Both failed." } }),
    ev(8, 2000, { turn_completed: { turn_summary: { started_at_ms: 1000, completed_at_ms: 2000, turn_duration_ms: 1000, token_progress: { input_tokens: 11, output_tokens: 22 } } } }),
  ]);
  const s = parseSession(join(dir, "events.jsonl"), "fx");
  assert.equal(s.source, "fx");
  assert.equal(s.sessionId, "s1");
  assert.equal(s.cwd, CWD);
  assert.equal(s.model, "m-2");
  const [user, a1, r1, r2, a2] = s.events;
  assert.equal(user.type, "user");
  assert.equal(user.timestamp, new Date(1000).toISOString());
  assert.deepEqual(a1.toolCalls.map((t) => [t.id, t.name, t.input]), [["c1", "Bash", "make test"], ["c2", "Grep", "TODO "]]);
  assert.deepEqual(a1.thinking, ["think first"]);
  assert.equal(a1.timestamp, new Date(2000).toISOString());
  assert.equal(r1.toolUseId, "c1");
  assert.equal(r1.text, "boom\n[exit code: 2]");
  assert.equal(r1.isError, true);
  assert.equal(r2.isError, true);
  assert.deepEqual(a1.tokens, { input: 0, output: 0, cacheHit: 0, cacheWrite: 0 });
  assert.equal(a2.tokens.input, 11);
  assert.equal(a2.tokens.output, 22);
  assert.equal(s.stats.errors, 2);
});

test("fx in-flight prompt shows while owner.live is current, not when it is stale", () => {
  const dir = join(home, "synthetic-fx", "running");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.json"), JSON.stringify({ id: "running", workspace_root: CWD }));
  writeFileSync(join(dir, "events.jsonl"), "");
  writeFileSync(join(dir, "recovery.json"), JSON.stringify({ checkpoint: { user: { text: "keep going" } } }));
  writeFileSync(join(dir, "owner.live"), "");
  const events = join(dir, "events.jsonl");
  const old = new Date(Date.now() - 60_000);
  utimesSync(events, old, old);
  let s = parseSession(events, "fx");
  assert.deepEqual(s.events.map((e) => [e.type, e.text]), [["user", "keep going"]]);
  assert.equal(recordingIsGenerating("fx", events), true);
  // A later events.jsonl write (the turn ended remotely, the marker copy survived) wins.
  utimesSync(join(dir, "owner.live"), new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
  s = parseSession(events, "fx");
  assert.equal(s.events.length, 0);
  assert.equal(recordingIsGenerating("fx", events), false);
});

test("dsh session parses: prompts only from the user, tool errors, usage and failed turns", () => {
  const path = writeDshRecording(join(home, "synthetic-dsh", "session-x"), [
    { type: "session", version: 4, id: "session-x", createdAt: 1000, cwd: CWD },
    { type: "user/message", seq: 1, time: 1100, data: { content: [{ type: "text", text: "fix it" }], source: { kind: "user" }, role: "user" } },
    { type: "user/message", seq: 2, time: 1100, data: { content: [{ type: "text", text: "Current runtime context." }], source: { kind: "runtime-context" }, role: "user" } },
    { type: "turn/start", seq: 3, time: 1100, data: { turn: 1 } },
    {
      type: "assistant/message", seq: 4, time: 1500,
      data: {
        message: { role: "assistant", content: [{ type: "reasoning", text: "hmm" }, { type: "text", text: "Checking." }, { type: "tool-call", id: "t1", name: "bash", arguments: JSON.stringify({ command: "ls nope" }) }], source: { kind: "model", model: "deepseek/x" } },
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 90 },
      },
    },
    { type: "tool/call", seq: 5, time: 1501, data: { callId: "t1", name: "bash", arguments: "{}" } },
    { type: "tool/result", seq: 6, time: 1600, data: { message: { role: "tool", toolCallId: "t1", content: [{ type: "text", text: "[stderr]\nls: nope: No such file\n[exit code: 1]" }], isError: false } } },
    { type: "turn/end", seq: 7, time: 1700, data: { turn: 1, reason: { kind: "error", error: { message: "rate limited" } } } },
  ]);
  const s = parseSession(path, "dsh");
  assert.equal(s.source, "dsh");
  assert.equal(s.sessionId, "session-x");
  assert.equal(s.cwd, CWD);
  assert.equal(s.model, "deepseek/x");
  assert.deepEqual(s.events.filter((e) => e.type === "user").map((e) => e.text), ["fix it"]);
  const a = s.events.find((e) => e.type === "assistant");
  assert.equal(a.text, "Checking.");
  assert.deepEqual(a.thinking, ["hmm"]);
  assert.deepEqual(a.toolCalls.map((t) => [t.id, t.name, t.input]), [["t1", "Bash", "ls nope"]]);
  assert.deepEqual(a.tokens, { input: 100, output: 5, cacheHit: 90, cacheWrite: 0 });
  const results = s.events.filter((e) => e.type === "tool_result");
  assert.equal(results[0].toolUseId, "t1");
  assert.equal(results[0].isError, true);
  assert.equal(results[1].text, "Error: rate limited");
  assert.equal(results[1].isError, true);
  assert.equal(s.startTime, new Date(1100).toISOString());
});

test("real recording: fx and dsh fixtures parse to what the harness recorded", () => {
  const fx = parseSession(join(fxDir(FX_MAIN), "events.jsonl"));
  assert.equal(fx.source, "fx");
  assert.equal(fx.model, "deepseek/deepseek-v4.1-flash-1017");
  assert.equal(fx.cwd, CWD);
  assert.equal(fx.stats.userMessages, 2);
  assert.deepEqual(fx.stats.toolCounts, { Read: 4, Bash: 3, Edit: 3 });
  assert.equal(fx.stats.errors, 1);
  const failed = fx.events.find((e) => e.type === "tool_result" && e.isError);
  assert.match(failed.text, /AssertionError\n\[exit code: 1\]$/);
  assert.equal(fx.stats.totalOutputTokens, 461 + 540);
  assert.equal(fx.durationMs, 27913);
  const parent = parseSession(join(fxDir(FX_PARENT), "events.jsonl"));
  const agentCall = parent.events.flatMap((e) => e.toolCalls || []).find((t) => t.name === "Agent");
  assert.match(agentCall.input, /count the number of lines in the file calc\.py/);

  const dsh = parseSession(dshMainPath());
  assert.equal(dsh.source, "dsh");
  assert.equal(dsh.sessionId, DSH_ID);
  assert.equal(dsh.cwd, CWD);
  assert.equal(dsh.stats.userMessages, 2);
  assert.equal(dsh.stats.assistantTurns, 10);
  assert.deepEqual(dsh.stats.toolCounts, { Read: 4, Bash: 4, Edit: 3 });
  assert.equal(dsh.stats.errors, 2);
  assert.equal(dsh.stats.totalOutputTokens, 994);
  assert.equal(dsh.stats.totalCacheHit, 60288);
  assert.equal(dsh.stats.totalInputTokens, 7361 + 60288);
});

test("kandev preamble: fx and dsh prompts drop Kandev's <kandev-system> blocks", () => {
  const preamble = "<kandev-system>KANDEV MCP TOOLS\nKandev Task ID: t-1</kandev-system>\n\n";
  const fxDirK = join(home, "synthetic-fx", "kandev");
  mkdirSync(fxDirK, { recursive: true });
  writeFileSync(join(fxDirK, "session.json"), JSON.stringify({ id: "kandev", workspace_root: CWD }));
  writeJsonl(join(fxDirK, "events.jsonl"), [
    { seq: 1, timestamp_ms: 1000, event: { user: { text: `${preamble}fix the flaky test` } } },
    { seq: 2, timestamp_ms: 1000, event: { turn_completed: { turn_summary: { started_at_ms: 900, completed_at_ms: 1000, turn_duration_ms: 100 } } } },
  ]);
  const fxPath = join(fxDirK, "events.jsonl");
  assert.deepEqual(parseSession(fxPath, "fx").events.map((e) => e.text), ["fix the flaky test"]);
  assert.equal(indexSession({ path: fxPath, source: "fx" }).firstPrompt, "fix the flaky test");

  const dshPath = writeDshRecording(join(home, "synthetic-dsh", "kandev"), [
    { type: "session", version: 4, id: "kandev", createdAt: 1, cwd: CWD },
    { type: "user/message", seq: 1, time: 2, data: { content: [{ type: "text", text: `${preamble}rename the module` }], source: { kind: "user" }, role: "user" } },
  ]);
  assert.deepEqual(parseSession(dshPath, "dsh").events.map((e) => e.text), ["rename the module"]);
  assert.equal(indexSession({ path: dshPath, source: "dsh" }).firstPrompt, "rename the module");
});

/* ── index, peek, search ──────────────────────────────────────────────── */

test("fx and dsh index entries carry what the parse reports", () => {
  assert.ok(KNOWN_SESSION_SOURCES.includes("fx"));
  assert.ok(KNOWN_SESSION_SOURCES.includes("dsh"));
  const fx = indexSession({ path: join(fxDir(FX_MAIN), "events.jsonl"), source: "fx" });
  assert.match(fx.firstPrompt, /^Read calc\.py and test_calc\.py/);
  assert.equal(fx.model, "deepseek/deepseek-v4.1-flash-1017");
  assert.equal(fx.chapters, 2);
  assert.deepEqual(fx.toolCounts, { Read: 4, Bash: 3, Edit: 3 });
  assert.equal(fx.errors, 1);
  assert.equal(fx.outputTokens, 1001);
  assert.equal(fx.files, 2);
  assert.equal(fx.durationMs, 9065 + 5434);
  const dsh = indexSession({ path: dshMainPath(), source: "dsh" });
  assert.match(dsh.firstPrompt, /^Read calc\.py and test_calc\.py/);
  assert.equal(dsh.chapters, 2);
  assert.deepEqual(dsh.toolCounts, { Read: 4, Bash: 4, Edit: 3 });
  assert.equal(dsh.errors, 2);
  assert.equal(dsh.inputTokens, 7361);
  assert.equal(dsh.cacheReadTokens, 60288);
  assert.equal(dsh.totalTokens, 7361 + 60288 + 994);
  assert.ok(dsh.durationMs > 15000 && dsh.durationMs < 20000, `dsh worked time ${dsh.durationMs}`);
  assert.ok(dsh.termFreqs.size > 0);

  const peek = peekSession({ path: dshMainPath(), source: "dsh" });
  assert.equal(peek.firstPrompt, dsh.firstPrompt);
  assert.deepEqual(peek.tools, ["Read", "Bash", "Edit"]);
});

test("fx and dsh search scan finds text inside the recordings", () => {
  const fxHits = scanSessionForQuery({ path: join(fxDir(FX_MAIN), "events.jsonl"), source: "fx" }, "extending", 3);
  assert.ok(fxHits.length >= 1);
  const dshHits = scanSessionForQuery({ path: dshMainPath(), source: "dsh" }, "confirmed failure", 3);
  assert.ok(dshHits.length >= 1);
  // The elided system prompt and tool schemas are not searchable conversation.
  assert.deepEqual(scanSessionForQuery({ path: dshMainPath(), source: "dsh" }, "elided", 3), []);
});

test("fx and dsh search through /api/search returns each phrase with its source", async () => {
  const prevNoSidecar = process.env.TRACEQUEST_NO_SIDECAR;
  process.env.TRACEQUEST_NO_SIDECAR = "1";
  const server = http.createServer();
  try {
    resetIndexWritersForTests();
    const { findSessions, buildIndex } = await import(new URL(`../../src/sessions.js?fxdsh=${Date.now()}`, import.meta.url).href);
    const handle = createHandle({ "/api/search": (req, res, url) => handleApiSearch(req, res, url, { findSessions, buildIndex }) });
    server.on("request", handle);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const get = (q) => new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${server.address().port}/api/search?q=${encodeURIComponent(q)}`, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(JSON.parse(body)));
      }).on("error", reject);
    });
    const fx = await get("extending");
    assert.deepEqual(fx.results.map((r) => r.source), ["fx"]);
    assert.equal(fx.results[0].path, join(fxDir(FX_MAIN), "events.jsonl"));
    const dsh = await get("Confirmed failure");
    assert.ok(dsh.results.some((r) => r.source === "dsh" && r.path === dshMainPath()));
  } finally {
    server.close();
    if (prevNoSidecar === undefined) delete process.env.TRACEQUEST_NO_SIDECAR;
    else process.env.TRACEQUEST_NO_SIDECAR = prevNoSidecar;
  }
});

/* ── live ─────────────────────────────────────────────────────────────── */

test("fx and dsh live: a probed process maps to its cwd's recording while a turn is open", () => {
  const fxRun = fxDir("liveFx");
  mkdirSync(fxRun, { recursive: true });
  writeFileSync(join(fxRun, "session.json"), JSON.stringify({ id: "liveFx", workspace_root: "/home/dev/live-fx" }));
  writeFileSync(join(fxRun, "events.jsonl"), "");
  writeFileSync(join(fxRun, "owner.live"), "");
  const dshOpen = writeDshRecording(join(home, ".dsh", "sessions", "-home-dev-live-dsh-", "session-open"), [
    { type: "session", version: 4, id: "session-open", createdAt: 1, cwd: "/home/dev/live-dsh" },
    { type: "turn/start", seq: 1, time: 2, data: { turn: 1 } },
  ]);
  const pids = { fx: "101", dsh: "202" };
  const cwds = { 101: "/home/dev/live-fx", 202: "/home/dev/live-dsh" };
  setFindLiveClaudeDepsForTests({
    platform: "linux",
    spawnSync: (_cmd, args) => {
      const pattern = args[args.length - 1];
      const hit = Object.entries(pids).find(([bin]) => pattern === bin || pattern.includes(`/)${bin}(`));
      return hit ? { status: 0, stdout: `${hit[1]}\n` } : { status: 1, stdout: "" };
    },
    readlinkSync: (p) => cwds[p.split("/")[2]],
  });
  try {
    const sessions = discoverSessions(null, []);
    const live = findLiveAgentSessions(sessions);
    assert.ok(live.includes(join(fxRun, "events.jsonl")), "fx running turn is live");
    assert.ok(live.includes(dshOpen), "dsh open turn is live");
    // Closing the turns makes them idle.
    rmSync(join(fxRun, "owner.live"));
    writeDshRecording(join(home, ".dsh", "sessions", "-home-dev-live-dsh-", "session-open"), [
      { type: "session", version: 4, id: "session-open", createdAt: 1, cwd: "/home/dev/live-dsh" },
      { type: "turn/start", seq: 1, time: 2, data: { turn: 1 } },
      { type: "turn/end", seq: 2, time: 3, data: { turn: 1, reason: { kind: "completed" } } },
    ]);
    assert.deepEqual(findLiveAgentSessions(discoverSessions(null, [])), []);
  } finally {
    setFindLiveClaudeDepsForTests(null);
    rmSync(fxRun, { recursive: true, force: true });
    rmSync(join(home, ".dsh", "sessions", "-home-dev-live-dsh-"), { recursive: true, force: true });
  }
});

test("dsh live endpoint serves the recording and the watchers see dsh and fx writes", async () => {
  assert.equal(sessionFreshnessPath(dshMainPath()), dshMainPath());
  assert.equal(isRelevantDataFilename("session.v4.jsonl.zstd"), true);
  assert.equal(isRelevantDataFilename(join("J1awiyS7sSqf", "owner.live")), true);
  clearRunSessionMemo();
  const row = discoverSessions(null, []).find((x) => x.path === dshMainPath());
  const res = mockHttpResponse();
  await handleApiSessionsLive(null, res, new URL(`http://localhost/api/sessions/live?id=${sessionHash(dshMainPath())}`), {
    findSessions: () => [row],
    detectLiveSessions: () => [],
    parseSession,
    buildSessionChapters: () => [],
    muxAvailable: () => false,
  });
  assert.equal(res.status, 200, res.body);
  const data = JSON.parse(res.body);
  assert.equal(data.source, "dsh");
  assert.equal(data.state, "idle");
  assert.equal(data.session.events.filter((e) => e.type === "user").length, 2);
});

/* ── surfaces ─────────────────────────────────────────────────────────── */

test("fx and dsh import ssh copies both trees and lists them under the host", async () => {
  const fixtureRoot = mkTmp("tq-fx-dsh-ssh-");
  const hostsDir = mkTmp("tq-fx-dsh-hosts-");
  const prevHosts = process.env.TRACEQUEST_HOSTS_DIR;
  process.env.TRACEQUEST_HOSTS_DIR = hostsDir;
  try {
    cpSync(join(FIXTURES, "fx"), join(fixtureRoot, "box", ".fx", "sessions"), { recursive: true });
    mkdirSync(join(fixtureRoot, "box", ".dsh", "sessions", "-home-dev-calc-", DSH_ID), { recursive: true });
    cpSync(join(FIXTURES, "dsh", "session.v4.jsonl.zstd"), join(fixtureRoot, "box", ".dsh", "sessions", "-home-dev-calc-", DSH_ID, "session.v4.jsonl.zstd"));
    assert.ok(SSH_IMPORT_SOURCES.some((s) => s.id === "fx" && s.rel.join("/") === ".fx/sessions"));
    assert.ok(SSH_IMPORT_SOURCES.some((s) => s.id === "dsh" && s.rel.join("/") === ".dsh/sessions"));
    await runSshImport({ hosts: ["box"], fixtureRoot, out: () => {}, warn: () => {} });
    const imported = discoverSessions(null, []).filter((s) => s.path.startsWith(hostsDir));
    assert.deepEqual([...new Set(imported.map((s) => s.source))].sort(), ["dsh", "fx"]);
    assert.ok(imported.every((s) => isImportedHostSession(s.path) && s.path.startsWith(join(hostsDir, "box"))));
    assert.equal(parseSession(imported.find((s) => s.source === "dsh").path).stats.errors, 2);
  } finally {
    if (prevHosts === undefined) delete process.env.TRACEQUEST_HOSTS_DIR;
    else process.env.TRACEQUEST_HOSTS_DIR = prevHosts;
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(hostsDir, { recursive: true, force: true });
  }
});

test("fx and dsh surfaces: hues, session paths, hub sources, help and docs", () => {
  for (const source of ["fx", "dsh"]) {
    assert.equal(sourceHueVar(source), `var(--hue-${source})`);
    assert.equal(SOURCE_COLORS[source], `var(--hue-${source})`);
    // One definition per theme block, like every other source hue.
    const count = (name) => (TOKENS_CSS.match(new RegExp(`--hue-${name}:`, "g")) || []).length;
    assert.equal(count(source), count("vktr"));
  }
  const prefixes = agentSessionRootPrefixes(home);
  assert.ok(prefixes.includes(`${home}/.fx/`) && prefixes.includes(`${home}/.dsh/`));
  assert.equal(sourceForSessionPath(join(fxDir(FX_MAIN), "events.jsonl")), "fx");
  assert.equal(sourceForSessionPath(dshMainPath()), "dsh");
  assert.equal(isSessionPath(dshMainPath()), true);
  assert.equal(isSessionPath(join(fxDir(FX_MAIN), "session.json")), false);

  const cfgPath = join(home, "hub.json");
  writeFileSync(cfgPath, JSON.stringify({ hosts: [{ spec: "box", hostId: "box", sources: { fx: ".fx/sessions", dsh: ".dsh/sessions" } }] }));
  assert.doesNotThrow(() => loadHubConfig(cfgPath));

  const help = readFileSync(join(ROOT, "src/cli/cli-help.js"), "utf-8");
  assert.match(help, /Supported agents: .*fx, DeepSeek Harness/);
  for (const doc of ["README.md", "docs/cli-reference.md", "CHANGELOG.md"]) {
    const text = readFileSync(join(ROOT, doc), "utf-8");
    assert.match(text, /\bfx\b/, `${doc} names fx`);
    assert.match(text, /DeepSeek Harness/, `${doc} names DeepSeek Harness`);
  }
});
