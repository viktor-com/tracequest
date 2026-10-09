import "../helpers/skip-lr-watch-env.js";
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  findLiveGrok,
  findLiveClaude,
  findLiveAgentSessions,
  detectLiveSessions,
  clearLiveSessionsCache,
  setFindLiveClaudeDepsForTests,
  stampLive,
  pathIsLive,
} from "../../src/sessions/live-sessions.js";
import { handleApiSessions } from "../../src/routes/route-handlers-api.js";
import { handleApiRuns, handleApiRunsSession, handleApiRunsSnapshot, handleApiSessionsLive } from "../../src/routes/route-handlers-launch.js";
import { handleView } from "../../src/routes/route-handlers-pages.js";
import { sessionHash } from "../../src/sessions/session-hash.js";
import { clearRouteCache } from "../../src/routes/route-cache.js";
import { captureJsonHandler } from "../helpers/capture-json-handler.js";
import { browserPage } from "../../src/browser/browser-page.js";
import {
  browserClientScript,
  BROWSER_CLIENT_BUNDLE_PARTS,
} from "../../src/browser/browser-client.js";
import vm from "node:vm";
import { assertChatRailLiveCount, renderChatRail } from "../helpers/render-rail-vm.js";
import { paintLaunchedRunIdentity } from "../helpers/render-run-identity-vm.js";
import { paintWatchIdentityAfterPoll } from "../helpers/render-watch-identity-vm.js";
import {
  cmdList,
  setCliSessionFinderForTests,
} from "../../src/cli/cli-commands.js";
import {
  claudeProjectDir,
  factoryWorkspaceDir,
  grokSessionDir,
} from "../../src/sessions/session-layout.js";
import {
  appendIncompleteJsonl,
  writeClaudeGenerating,
  writeClaudeGeneratingOversizeLast,
  writeClaudeIdleOversizeLast,
  writeClaudeLastUser,
  writeClaudeNoEndTurn,
  writeCodexGenerating,
  writeCodexGeneratingAgedStart,
  writeCodexIdle,
  writeCodexPendingTool,
  writeCodexReasoningInFlight,
  writeCursorGenerating,
  writeFactoryGenerating,
  writeFactoryIdle,
  writeFactoryLastUser,
  writeGrokGenerating,
  writeGrokGeneratingAgedStart,
  writeGrokGeneratingOversizeToolCalls,
  writeGrokIdle,
  writeGrokIdleOversizeAssistant,
  writeGrokUpdates,
  openCodeIdleAssistant,
  openCodeStreamingTextAssistant,
} from "../helpers/live-generating-fixtures.js";
import { seedOpenCodeIndexDb } from "../helpers/opencode-db-fixtures.js";
import { openCodeSessionIsGenerating } from "../../src/sessions/live-session-generating.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/live-finalisation");
const G1_SID = "01a03de0-dec6-7340-ae6c-e710001a70fa";
const G1_CWD = "/home/dev/code/sample-app/sample-app";
const G1_PID = "49168";
const OPEN_FD_SKIP = ["linux", "darwin"].includes(process.platform)
  ? false
  : "open-file probe unsupported on this platform";

const origHomeEnv = process.env.TRACEQUEST_LIVE_SESSIONS_HOME;

afterEach(() => {
  if (origHomeEnv === undefined) delete process.env.TRACEQUEST_LIVE_SESSIONS_HOME;
  else process.env.TRACEQUEST_LIVE_SESSIONS_HOME = origHomeEnv;
  setFindLiveClaudeDepsForTests(null);
  setCliSessionFinderForTests(null);
  clearLiveSessionsCache();
  clearRouteCache();
});

beforeEach(() => {
  clearLiveSessionsCache();
});

function deadPid() {
  const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  assert.equal(child.status, 0);
  return child.pid;
}

function writeClaudePidSidecar(home, pid, cwd, status = "idle") {
  const sidecarDir = path.join(home, ".claude", "sessions");
  fs.mkdirSync(sidecarDir, { recursive: true });
  fs.writeFileSync(path.join(sidecarDir, `${pid}.json`), JSON.stringify({
    pid: Number(pid),
    cwd,
    status,
    kind: "interactive",
    peerFeatures: ["notify_idle"],
  }));
}

function injectProbes({ cwds = {}, pgrep = {} } = {}) {
  setFindLiveClaudeDepsForTests({
    platform: "linux",
    spawnSync: (cmd, args) => {
      if (cmd !== "pgrep") return { status: 1, stdout: "" };
      const needle = args[args.length - 1];
      const pids = pgrep[needle];
      return pids?.length ? { status: 0, stdout: pids.join("\n") + "\n" } : { status: 1, stdout: "" };
    },
    readlinkSync: (target) => {
      const m = String(target).match(/^\/proc\/(\d+)\/cwd$/);
      if (m && cwds[m[1]]) return cwds[m[1]];
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  });
}

function copyG1Recording(sessionDir) {
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, "grok-idle", "events.jsonl"), path.join(sessionDir, "events.jsonl"));
  fs.copyFileSync(path.join(FIXTURES, "grok-idle", "chat_history.jsonl"), path.join(sessionDir, "chat_history.jsonl"));
  fs.copyFileSync(path.join(FIXTURES, "grok-idle", "updates.jsonl"), path.join(sessionDir, "updates.jsonl"));
}

function writeGrokActive(home, entries) {
  const grokDir = path.join(home, ".grok");
  fs.mkdirSync(grokDir, { recursive: true });
  fs.writeFileSync(path.join(grokDir, "active_sessions.json"), JSON.stringify(entries));
}

function asDiscovery(filePath, source, extras = {}) {
  return {
    path: filePath,
    source,
    project: extras.project || "sample-app",
    mtime: extras.mtime || new Date(),
    size: extras.size || 2048,
  };
}

function parseDashboardInit(html) {
  const marker = "var _INIT_DATA = ";
  const start = html.indexOf(marker);
  assert.ok(start >= 0, "dashboard embed has _INIT_DATA");
  const jsonStart = start + marker.length;
  const jsonEnd = html.indexOf(";\nvar ALL", jsonStart);
  assert.ok(jsonEnd > jsonStart, "dashboard embed _INIT_DATA terminator");
  return JSON.parse(html.slice(jsonStart, jsonEnd));
}

function extractClientFn(script, name) {
  const marker = `function ${name}(`;
  const start = script.indexOf(marker);
  assert.ok(start >= 0, `${name} should exist in client script`);
  const brace = script.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < script.length; i++) {
    if (script[i] === "{") depth++;
    else if (script[i] === "}") {
      depth--;
      if (depth === 0) return script.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const PREP_FOR_LIST_VM = BROWSER_CLIENT_BUNDLE_PARTS
  .find((p) => p.id === "prep-and-formats")
  .source;
const REST_ESC_H_LIST = BROWSER_CLIENT_BUNDLE_PARTS
  .find((p) => p.id === "pagination-and-rest")
  .source.match(/function escH\(s\) \{[\s\S]*?\n\}/)?.[0];

/** User-visible dashboard list + live counters from a browserPage _INIT_DATA snapshot. */
function renderDashboardListFromEmbed(embed) {
  const script = browserClientScript('{"sessions":[],"total":0,"stats":{}}');
  const collected = [];
  const sentinel = {
    style: { display: "" },
    insertAdjacentHTML(_pos, html) { collected.push(html); },
  };
  const sessionsEl = {
    innerHTML: "",
    insertAdjacentHTML(_pos, html) { collected.push(html); },
    appendChild() {},
  };
  const countEl = { textContent: "" };
  const appLiveEl = { hidden: true, textContent: "" };
  const dashboardEl = {
    innerHTML: "",
    style: { display: "block" },
    className: "",
    classList: { toggle() {} },
  };
  const liveSessions = (embed.liveSessions || []).map((s) => ({ ...s }));
  const ctx = {
    ALL: (embed.sessions || []).map((s) => ({ ...s })),
    SERVER_TOTAL: embed.total ?? (embed.sessions || []).length,
    SERVER_STATS: embed.stats || {},
    _liveSessions: liveSessions,
    _livePaths: new Set(liveSessions.filter((s) => s.live === true).map((s) => s.path)),
    _runs: (embed.runs || []).map((r) => ({ ...r })),
    _runsBySession: {},
    currentPage: 1,
    currentFilterExpr: null,
    dashboardCollapsed: false,
    dashboardEl,
    _fetchError: null,
    filtered: [],
    renderedCount: 0,
    sessionsEl,
    sentinel,
    collected,
    document: {
      getElementById(id) {
        if (id === "count") return countEl;
        if (id === "appLive") return appLiveEl;
        return null;
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(
    `${PREP_FOR_LIST_VM}
${REST_ESC_H_LIST}
var _agentsInfo = { mux: false, resumable: {} };
var SOURCE_AGENTS = { claude: 'claude', cursor: 'cursor-agent', codex: 'codex', grok: 'grok', opencode: 'opencode', factory: 'droid' };
${extractClientFn(script, "continueAgentForSource")}
${extractClientFn(script, "continueBtnHtml")}
${extractClientFn(script, "sessionStatChipsHtml")}
${extractClientFn(script, "sessionStatsHtml")}
${extractClientFn(script, "runIsLive")}
${extractClientFn(script, "liveNow")}
${extractClientFn(script, "indexedSessionForRun")}
${extractClientFn(script, "liveInfoForRun")}
${extractClientFn(script, "liveAgentRowHtml")}
${extractClientFn(script, "runSessionRowHtml")}
${extractClientFn(script, "externalLiveRowHtml")}
${extractClientFn(script, "externalLiveSessions")}
${extractClientFn(script, "renderRow")}
${extractClientFn(script, "renderPageBatch")}
${extractClientFn(script, "renderDashboard")}
function buildQfBar() {}
function renderPagination() {}
function updatePageUrl() {}
function restoreContinueForm() {}
${extractClientFn(script, "render")}
render();
listHtml = collected.join('');
liveN = liveNow();
dashboardHtml = dashboardEl.innerHTML;`,
    ctx,
  );
  return {
    html: ctx.listHtml,
    appLive: appLiveEl,
    dashboardHtml: ctx.dashboardHtml,
    liveN: ctx.liveN,
  };
}

function assertSnapshotLiveCount(shot, expected, msg) {
  assert.equal(shot.liveN, expected, msg || `liveNow() is ${expected} on this snapshot`);
  assert.equal(shot.appLive.hidden, expected === 0, "#appLive is hidden iff liveNow is 0");
  assert.match(shot.appLive.textContent, new RegExp(`${expected} running`));
  assert.doesNotMatch(shot.appLive.textContent, /\d+ live\b/, "#appLive does not say N live");
  if (expected) {
    assert.match(
      shot.dashboardHtml,
      new RegExp(`color:var\\(--ok\\)">${expected}</span></span><span class="dashboard-stat-label">running`),
      `overview running stat is ${expected}`,
    );
    assert.doesNotMatch(shot.dashboardHtml, /dashboard-stat-label">live/, "overview does not say live");
  } else {
    assert.doesNotMatch(shot.dashboardHtml, /dashboard-stat-label">(?:live|running)/, "overview has no running/live stat");
  }
}

/** Same snapshot as the dashboard render, executed through chat-page renderRail. */
function assertChatRailFromEmbed(embed, expected, msg) {
  const shot = renderChatRail({
    runs: embed.runs || [],
    sessions: embed.sessions || [],
    liveSessions: embed.liveSessions || [],
    stats: embed.stats || { totalSessions: embed.total ?? (embed.sessions || []).length },
    railExpr: embed.railExpr || "",
  });
  assertChatRailLiveCount(shot, expected, msg || "chat-page renderRail #appLive");
  return shot;
}

async function apiSessionsPayload(discovery) {
  clearRouteCache();
  clearLiveSessionsCache();
  const { res, parse } = captureJsonHandler();
  await handleApiSessions({}, res, new URL("http://localhost:7777/api/sessions?pageSize=50"), {
    findSessions: () => discovery,
    buildIndex: () => new Map(),
    peekSession: () => ({}),
  });
  return parse();
}

function cliLiveTrueOutput(discovery) {
  setCliSessionFinderForTests(() => discovery);
  const origExit = process.exit;
  const origLog = console.log;
  const origError = console.error;
  const logs = [];
  let code;
  process.exit = (c) => {
    code = c;
    throw new Error("process.exit");
  };
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => logs.push(a.join(" "));
  try {
    cmdList([], { filter: "live:true", sort: "recent", limit: "50" });
  } catch (err) {
    if (err.message !== "process.exit") throw err;
  } finally {
    process.exit = origExit;
    console.log = origLog;
    console.error = origError;
    setCliSessionFinderForTests(null);
  }
  assert.equal(code, 0, `CLI live:true exited ${code}: ${logs.join("\n")}`);
  return logs.join("\n");
}

function assertSurfacesAgree(discovery, livePaths) {
  const liveSet = new Set(livePaths);
  for (const s of discovery) {
    assert.equal(
      pathIsLive(s.path, livePaths),
      liveSet.has(s.path),
      `pathIsLive must match detectLiveSessions for ${s.path}`,
    );
  }
}

describe("live-sessions finalisation (idle-open vs generating)", { concurrency: false }, () => {
  describe("G1 idle-open grok TUI", () => {
    test("G1: live pid + cwd + completed turn_ended is not live", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-g1-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const sessionDir = grokSessionDir(home, G1_CWD, G1_SID);
      copyG1Recording(sessionDir);
      writeGrokActive(home, [{ session_id: G1_SID, cwd: G1_CWD, pid: Number(G1_PID) }]);
      injectProbes({ cwds: { [G1_PID]: G1_CWD } });

      try {
        assert.deepEqual(findLiveGrok(), []);
        assert.ok(!detectLiveSessions([]).includes(sessionDir), "G1 path must not be in detectLiveSessions");
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("G1: completed assistant last record larger than the 128KB tail is not live", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-g1-oversize-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const sessionDir = grokSessionDir(home, G1_CWD, G1_SID);
      writeGrokIdleOversizeAssistant(sessionDir);
      writeGrokActive(home, [{ session_id: G1_SID, cwd: G1_CWD, pid: Number(G1_PID) }]);
      injectProbes({ cwds: { [G1_PID]: G1_CWD } });

      try {
        assert.ok(fs.statSync(path.join(sessionDir, "chat_history.jsonl")).size > 128 * 1024);
        assert.deepEqual(findLiveGrok(), []);
        assert.ok(!detectLiveSessions([]).includes(sessionDir));
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("G1: completed turn_ended with updates turn_completed is not live", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-g1-upd-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const sessionDir = grokSessionDir(home, G1_CWD, G1_SID);
      writeGrokIdle(sessionDir);
      writeGrokUpdates(sessionDir, [
        {
          timestamp: 1787746098,
          method: "session/update",
          params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } },
        },
        {
          timestamp: 1787746098,
          method: "session/update",
          params: { update: { sessionUpdate: "turn_completed" } },
        },
      ]);
      writeGrokActive(home, [{ session_id: G1_SID, cwd: G1_CWD, pid: Number(G1_PID) }]);
      injectProbes({ cwds: { [G1_PID]: G1_CWD } });

      try {
        assert.deepEqual(findLiveGrok(), []);
        assert.ok(!detectLiveSessions([]).includes(sessionDir));
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  });

  describe("G2 generating grok", () => {
    test("G2: unmatched turn_started on the same TUI/pid/cwd is live", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-g2-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const sessionDir = grokSessionDir(home, G1_CWD, G1_SID);
      copyG1Recording(sessionDir);
      fs.appendFileSync(
        path.join(sessionDir, "events.jsonl"),
        JSON.stringify({ ts: "2026-08-26T12:12:50.353Z", type: "turn_started", session_id: G1_SID }) + "\n",
      );
      writeGrokActive(home, [{ session_id: G1_SID, cwd: G1_CWD, pid: Number(G1_PID) }]);
      injectProbes({ cwds: { [G1_PID]: G1_CWD } });

      try {
        assert.deepEqual(findLiveGrok(), [sessionDir]);
        assert.ok(detectLiveSessions([]).includes(sessionDir));
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("G2: running subagent meta.json is live even after turn_ended", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-g2-sub-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const sessionDir = grokSessionDir(home, G1_CWD, G1_SID);
      copyG1Recording(sessionDir);
      const metaDir = path.join(sessionDir, "subagents", "01a03dff-sub");
      fs.mkdirSync(metaDir, { recursive: true });
      fs.writeFileSync(path.join(metaDir, "meta.json"), JSON.stringify({ status: "running" }));
      writeGrokActive(home, [{ session_id: G1_SID, cwd: G1_CWD, pid: Number(G1_PID) }]);
      injectProbes({ cwds: { [G1_PID]: G1_CWD } });

      try {
        assert.deepEqual(findLiveGrok(), [sessionDir]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("G2: unmatched chat_history tool_calls is live", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-g2-tools-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const sessionDir = grokSessionDir(home, G1_CWD, G1_SID);
      writeGrokIdle(sessionDir, {
        events: [{ ts: "2026-08-26T12:08:17.984Z", type: "turn_ended", outcome: "completed" }],
        chat: [
          { type: "user", content: "run it" },
          {
            type: "assistant",
            content: "",
            tool_calls: [{ id: "call-live", name: "run_terminal_command", arguments: "{}" }],
          },
        ],
      });
      writeGrokActive(home, [{ session_id: G1_SID, cwd: G1_CWD, pid: Number(G1_PID) }]);
      injectProbes({ cwds: { [G1_PID]: G1_CWD } });

      try {
        assert.deepEqual(findLiveGrok(), [sessionDir]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("G2: unmatched chat_history tool_calls last record larger than the 128KB tail is live", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-g2-oversize-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const sessionDir = grokSessionDir(home, G1_CWD, G1_SID);
      writeGrokGeneratingOversizeToolCalls(sessionDir);
      writeGrokActive(home, [{ session_id: G1_SID, cwd: G1_CWD, pid: Number(G1_PID) }]);
      injectProbes({ cwds: { [G1_PID]: G1_CWD } });

      try {
        assert.ok(fs.statSync(path.join(sessionDir, "chat_history.jsonl")).size > 128 * 1024);
        assert.deepEqual(findLiveGrok(), [sessionDir]);
        assert.ok(detectLiveSessions([]).includes(sessionDir));
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("G2: unmatched events tool_started is live", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-g2-tstart-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const sessionDir = grokSessionDir(home, G1_CWD, G1_SID);
      writeGrokIdle(sessionDir, {
        events: [{ ts: "2026-08-26T12:13:00.000Z", type: "tool_started", tool_name: "bash" }],
      });
      writeGrokActive(home, [{ session_id: G1_SID, cwd: G1_CWD, pid: Number(G1_PID) }]);
      injectProbes({ cwds: { [G1_PID]: G1_CWD } });

      try {
        assert.deepEqual(findLiveGrok(), [sessionDir]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("G2: waiting_for_model phase without turn_ended is live", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-g2-phase-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const sessionDir = grokSessionDir(home, G1_CWD, G1_SID);
      writeGrokIdle(sessionDir, {
        events: [{ ts: "2026-08-26T12:12:51.000Z", type: "phase_changed", phase: "waiting_for_model" }],
      });
      writeGrokActive(home, [{ session_id: G1_SID, cwd: G1_CWD, pid: Number(G1_PID) }]);
      injectProbes({ cwds: { [G1_PID]: G1_CWD } });

      try {
        assert.deepEqual(findLiveGrok(), [sessionDir]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("G2: in-progress reasoning on chat_history is live", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-g2-reason-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const sessionDir = grokSessionDir(home, G1_CWD, G1_SID);
      writeGrokIdle(sessionDir, {
        events: [{ ts: "2026-08-26T12:08:17.984Z", type: "turn_ended", outcome: "completed" }],
        chat: [
          { type: "user", content: "think" },
          { type: "reasoning", id: "rs-live", status: "in_progress" },
        ],
      });
      writeGrokActive(home, [{ session_id: G1_SID, cwd: G1_CWD, pid: Number(G1_PID) }]);
      injectProbes({ cwds: { [G1_PID]: G1_CWD } });

      try {
        assert.deepEqual(findLiveGrok(), [sessionDir]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("G2: empty streaming assistant is live", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-g2-stream-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const sessionDir = grokSessionDir(home, G1_CWD, G1_SID);
      writeGrokIdle(sessionDir, {
        events: [{ ts: "2026-08-26T12:08:17.984Z", type: "turn_ended", outcome: "completed" }],
        chat: [
          { type: "user", content: "go" },
          { type: "assistant", content: "" },
        ],
      });
      writeGrokActive(home, [{ session_id: G1_SID, cwd: G1_CWD, pid: Number(G1_PID) }]);
      injectProbes({ cwds: { [G1_PID]: G1_CWD } });

      try {
        assert.deepEqual(findLiveGrok(), [sessionDir]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("G2: growing jsonl (incomplete last line) is live", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-g2-grow-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const sessionDir = grokSessionDir(home, G1_CWD, G1_SID);
      copyG1Recording(sessionDir);
      appendIncompleteJsonl(path.join(sessionDir, "events.jsonl"));
      writeGrokActive(home, [{ session_id: G1_SID, cwd: G1_CWD, pid: Number(G1_PID) }]);
      injectProbes({ cwds: { [G1_PID]: G1_CWD } });

      try {
        assert.deepEqual(findLiveGrok(), [sessionDir]);
        assert.ok(detectLiveSessions([]).includes(sessionDir));
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("G2: unmatched turn_started aged out of the 128KB tail is still live", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-g2-aged-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const sessionDir = grokSessionDir(home, G1_CWD, G1_SID);
      writeGrokGeneratingAgedStart(sessionDir);
      writeGrokActive(home, [{ session_id: G1_SID, cwd: G1_CWD, pid: Number(G1_PID) }]);
      injectProbes({ cwds: { [G1_PID]: G1_CWD } });

      try {
        assert.ok(fs.statSync(path.join(sessionDir, "events.jsonl")).size > 128 * 1024);
        assert.deepEqual(findLiveGrok(), [sessionDir]);
        assert.ok(detectLiveSessions([]).includes(sessionDir));
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("G2: updates.jsonl agent_message_chunk after events turn_ended is live", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-g2-upd-chunk-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const sessionDir = grokSessionDir(home, G1_CWD, G1_SID);
      writeGrokIdle(sessionDir);
      writeGrokUpdates(sessionDir, [
        {
          timestamp: 1787746490,
          method: "session/update",
          params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } },
        },
      ]);
      writeGrokActive(home, [{ session_id: G1_SID, cwd: G1_CWD, pid: Number(G1_PID) }]);
      injectProbes({ cwds: { [G1_PID]: G1_CWD } });

      try {
        assert.deepEqual(findLiveGrok(), [sessionDir]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("G2: updates.jsonl pending tool_call after events turn_ended is live", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-g2-upd-tool-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const sessionDir = grokSessionDir(home, G1_CWD, G1_SID);
      writeGrokIdle(sessionDir);
      writeGrokUpdates(sessionDir, [
        {
          timestamp: 1787746490,
          method: "session/update",
          params: { update: { sessionUpdate: "tool_call", toolCallId: "call-live" } },
        },
      ]);
      writeGrokActive(home, [{ session_id: G1_SID, cwd: G1_CWD, pid: Number(G1_PID) }]);
      injectProbes({ cwds: { [G1_PID]: G1_CWD } });

      try {
        assert.deepEqual(findLiveGrok(), [sessionDir]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("G2: last chat_history user after turn_ended is live", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-g2-last-user-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const sessionDir = grokSessionDir(home, G1_CWD, G1_SID);
      writeGrokIdle(sessionDir, {
        events: [{ ts: "2026-08-26T12:08:17.984Z", type: "turn_ended", outcome: "completed" }],
        chat: [
          { type: "assistant", content: "done" },
          { type: "user", content: "next" },
        ],
      });
      writeGrokActive(home, [{ session_id: G1_SID, cwd: G1_CWD, pid: Number(G1_PID) }]);
      injectProbes({ cwds: { [G1_PID]: G1_CWD } });

      try {
        assert.deepEqual(findLiveGrok(), [sessionDir]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  });

  describe("G3 dead pid / G4 cwd mismatch", () => {
    test("G3: leftover active_sessions.json row with a dead pid is not live", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-g3-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = "/home/dev/code/tracequest";
      const sid = "95708b29-2d68-407f-bc97-cc61e51f63c3";
      writeGrokGenerating(grokSessionDir(home, cwd, sid));
      writeGrokActive(home, [{ session_id: sid, cwd, pid: deadPid() }]);

      try {
        assert.deepEqual(findLiveGrok(), []);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("G4: live pid whose recorded cwd does not match /proc cwd is not live", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-g4-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const sid = "stale-cwd";
      writeGrokGenerating(grokSessionDir(home, "/definitely-not-this-cwd", sid));
      writeGrokActive(home, [{ session_id: sid, cwd: "/definitely-not-this-cwd", pid: process.pid }]);

      try {
        assert.deepEqual(findLiveGrok(), []);
        assert.deepEqual(detectLiveSessions([]), []);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  });

  describe("C1 idle-open claude / C2 generating claude", () => {
    test("C1: pgrep hit + idle jsonl + status idle sidecar is not live", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-c1-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = G1_CWD;
      const pid = "23928";
      const projDir = claudeProjectDir(home, cwd);
      const jsonl = path.join(projDir, "c232c8b3-idle.jsonl");
      fs.mkdirSync(projDir, { recursive: true });
      fs.copyFileSync(path.join(FIXTURES, "claude", "end-turn.jsonl"), jsonl);
      writeClaudePidSidecar(home, pid, cwd, "idle");
      injectProbes({ pgrep: { claude: [pid] }, cwds: { [pid]: cwd } });

      try {
        assert.ok(!findLiveClaude().includes(jsonl));
        assert.ok(!detectLiveSessions([]).includes(jsonl));
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("C1: idle end_turn last record larger than the 128KB tail is not live", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-c1-oversize-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = G1_CWD;
      const pid = "23929";
      const jsonl = path.join(claudeProjectDir(home, cwd), "c1-oversize-idle.jsonl");
      writeClaudeIdleOversizeLast(jsonl);
      writeClaudePidSidecar(home, pid, cwd, "idle");
      injectProbes({ pgrep: { claude: [pid] }, cwds: { [pid]: cwd } });

      try {
        assert.ok(fs.statSync(jsonl).size > 128 * 1024);
        assert.ok(!findLiveClaude().includes(jsonl));
        assert.ok(!detectLiveSessions([]).includes(jsonl));
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("C2: pgrep hit + unmatched tool_use jsonl is live even with idle sidecar", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-c2-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = G1_CWD;
      const pid = "24001";
      const jsonl = path.join(claudeProjectDir(home, cwd), "c2-generating.jsonl");
      writeClaudeGenerating(jsonl);
      writeClaudePidSidecar(home, pid, cwd, "idle");
      injectProbes({ pgrep: { claude: [pid] }, cwds: { [pid]: cwd } });

      try {
        assert.deepEqual(findLiveClaude(), [jsonl]);
        assert.ok(detectLiveSessions([]).includes(jsonl));
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("C2: unmatched tool_use last record larger than the 128KB tail is live", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-c2-oversize-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = G1_CWD;
      const pid = "24006";
      const jsonl = path.join(claudeProjectDir(home, cwd), "c2-oversize.jsonl");
      writeClaudeGeneratingOversizeLast(jsonl);
      writeClaudePidSidecar(home, pid, cwd, "idle");
      injectProbes({ pgrep: { claude: [pid] }, cwds: { [pid]: cwd } });

      try {
        assert.ok(fs.statSync(jsonl).size > 128 * 1024);
        assert.deepEqual(findLiveClaude(), [jsonl]);
        assert.ok(detectLiveSessions([]).includes(jsonl));
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("C2: last assistant without end_turn is live even with idle sidecar", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-c2-noend-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = G1_CWD;
      const pid = "24002";
      const jsonl = path.join(claudeProjectDir(home, cwd), "c2-no-end.jsonl");
      writeClaudeNoEndTurn(jsonl);
      writeClaudePidSidecar(home, pid, cwd, "idle");
      injectProbes({ pgrep: { claude: [pid] }, cwds: { [pid]: cwd } });

      try {
        assert.deepEqual(findLiveClaude(), [jsonl]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("C2: last user waiting for the model is live even with idle sidecar", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-c2-user-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = G1_CWD;
      const pid = "24003";
      const jsonl = path.join(claudeProjectDir(home, cwd), "c2-last-user.jsonl");
      writeClaudeLastUser(jsonl);
      writeClaudePidSidecar(home, pid, cwd, "idle");
      injectProbes({ pgrep: { claude: [pid] }, cwds: { [pid]: cwd } });

      try {
        assert.deepEqual(findLiveClaude(), [jsonl]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("C2: non-idle pid sidecar is live even when jsonl looks settled", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-c2-busy-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = G1_CWD;
      const pid = "24004";
      const jsonl = path.join(claudeProjectDir(home, cwd), "c2-busy.jsonl");
      fs.mkdirSync(path.dirname(jsonl), { recursive: true });
      fs.copyFileSync(path.join(FIXTURES, "claude", "end-turn.jsonl"), jsonl);
      writeClaudePidSidecar(home, pid, cwd, "busy");
      injectProbes({ pgrep: { claude: [pid] }, cwds: { [pid]: cwd } });

      try {
        assert.deepEqual(findLiveClaude(), [jsonl]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("C2: growing jsonl (incomplete last line) is live even with idle sidecar", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-c2-grow-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = G1_CWD;
      const pid = "24005";
      const jsonl = path.join(claudeProjectDir(home, cwd), "c2-grow.jsonl");
      fs.mkdirSync(path.dirname(jsonl), { recursive: true });
      fs.copyFileSync(path.join(FIXTURES, "claude", "end-turn.jsonl"), jsonl);
      appendIncompleteJsonl(jsonl);
      writeClaudePidSidecar(home, pid, cwd, "idle");
      injectProbes({ pgrep: { claude: [pid] }, cwds: { [pid]: cwd } });

      try {
        assert.deepEqual(findLiveClaude(), [jsonl]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  });

  describe("X1 agent families", () => {
    test("X1a: idle-open Codex (settled task) is not live", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-x1a-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = "/work/alpha/proj";
      const filePath = path.join(home, "rollout-idle.jsonl");
      writeCodexIdle(filePath, cwd);
      const sessions = [{ path: filePath, mtime: new Date(), source: "codex", project: "proj" }];
      injectProbes({ pgrep: { codex: ["99"] }, cwds: { 99: cwd } });

      try {
        assert.deepEqual(findLiveAgentSessions(sessions), []);
        assert.ok(!detectLiveSessions(sessions).includes(filePath), "X1a idle Codex is not live in the UI union");
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("X1a: idle-open Codex held-open fd is not live", {
      skip: OPEN_FD_SKIP,
    }, () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-x1a-fd-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = "/work/alpha/proj";
      const filePath = path.join(home, "rollout-idle.jsonl");
      writeCodexIdle(filePath, cwd);
      const sessions = [{ path: filePath, mtime: new Date(), source: "codex", project: "proj" }];
      injectProbes({ pgrep: { codex: ["99"] }, cwds: { 99: cwd } });
      const fd = fs.openSync(filePath, "r");

      try {
        assert.deepEqual(findLiveAgentSessions(sessions), []);
        assert.ok(!detectLiveSessions(sessions).includes(filePath), "settled Codex merely held open is not live");
      } finally {
        fs.closeSync(fd);
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("X1b: Codex unmatched task_started is live", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-x1b-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = "/work/alpha/proj";
      const filePath = path.join(home, "rollout-gen.jsonl");
      writeCodexGenerating(filePath, cwd);
      const sessions = [{ path: filePath, mtime: new Date(), source: "codex", project: "proj" }];
      injectProbes({ pgrep: { codex: ["99"] }, cwds: { 99: cwd } });

      try {
        assert.deepEqual(findLiveAgentSessions(sessions), [filePath]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("X1b: Codex pending custom_tool_call is live", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-x1b-pend-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = "/work/alpha/proj";
      const filePath = path.join(home, "rollout-pend.jsonl");
      writeCodexPendingTool(filePath, cwd);
      const sessions = [{ path: filePath, mtime: new Date(), source: "codex", project: "proj" }];
      injectProbes({ pgrep: { codex: ["99"] }, cwds: { 99: cwd } });

      try {
        assert.deepEqual(findLiveAgentSessions(sessions), [filePath]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("X1b: Codex trailing reasoning without task_complete is live", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-x1b-reason-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = "/work/alpha/proj";
      const filePath = path.join(home, "rollout-reason.jsonl");
      writeCodexReasoningInFlight(filePath, cwd);
      const sessions = [{ path: filePath, mtime: new Date(), source: "codex", project: "proj" }];
      injectProbes({ pgrep: { codex: ["99"] }, cwds: { 99: cwd } });

      try {
        assert.deepEqual(findLiveAgentSessions(sessions), [filePath]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("X1b: Codex growing jsonl (incomplete last line) is live", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-x1b-grow-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = "/work/alpha/proj";
      const filePath = path.join(home, "rollout-grow.jsonl");
      writeCodexIdle(filePath, cwd);
      appendIncompleteJsonl(filePath);
      const sessions = [{ path: filePath, mtime: new Date(), source: "codex", project: "proj" }];
      injectProbes({ pgrep: { codex: ["99"] }, cwds: { 99: cwd } });

      try {
        assert.deepEqual(findLiveAgentSessions(sessions), [filePath]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("X1b: unmatched task_started aged out of the 128KB tail is still live", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-x1b-aged-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = "/work/alpha/proj";
      const filePath = path.join(home, "rollout-aged.jsonl");
      writeCodexGeneratingAgedStart(filePath, cwd);
      const sessions = [{ path: filePath, mtime: new Date(), source: "codex", project: "proj" }];
      injectProbes({ pgrep: { codex: ["99"] }, cwds: { 99: cwd } });

      try {
        assert.ok(fs.statSync(filePath).size > 128 * 1024);
        assert.deepEqual(findLiveAgentSessions(sessions), [filePath]);
        assert.ok(detectLiveSessions(sessions).includes(filePath));
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("X1c: idle-open Cursor (turn_ended success) is not live", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-x1c-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = "/work/websh";
      const filePath = path.join(home, ".cursor", "projects", "work-websh", "agent-transcripts", "uuid-idle", "uuid-idle.jsonl");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.copyFileSync(path.join(FIXTURES, "cursor", "turn-ended.jsonl"), filePath);
      const sessions = [{ path: filePath, mtime: new Date(), source: "cursor" }];
      injectProbes({ pgrep: { "(^|/)cursor-agent($| )": ["77"] }, cwds: { 77: cwd } });

      try {
        assert.deepEqual(findLiveAgentSessions([]), []);
        assert.ok(!detectLiveSessions(sessions).includes(filePath), "X1c idle Cursor is not live in the UI union");
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("X1c: idle-open Cursor held-open fd is not live", {
      skip: OPEN_FD_SKIP,
    }, () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-x1c-fd-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = "/work/websh";
      const filePath = path.join(home, ".cursor", "projects", "work-websh", "agent-transcripts", "uuid-idle", "uuid-idle.jsonl");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.copyFileSync(path.join(FIXTURES, "cursor", "turn-ended.jsonl"), filePath);
      const sessions = [{ path: filePath, mtime: new Date(), source: "cursor" }];
      injectProbes({ pgrep: { "(^|/)cursor-agent($| )": ["77"] }, cwds: { 77: cwd } });
      const fd = fs.openSync(filePath, "r");

      try {
        assert.deepEqual(findLiveAgentSessions([]), []);
        assert.ok(!detectLiveSessions(sessions).includes(filePath), "settled Cursor merely held open is not live");
      } finally {
        fs.closeSync(fd);
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("X1d: Cursor without closing turn_ended is live", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-x1d-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = "/work/websh";
      const filePath = path.join(home, ".cursor", "projects", "work-websh", "agent-transcripts", "uuid-gen", "uuid-gen.jsonl");
      writeCursorGenerating(filePath);
      injectProbes({ pgrep: { "(^|/)cursor-agent($| )": ["77"] }, cwds: { 77: cwd } });

      try {
        assert.deepEqual(findLiveAgentSessions([]), [filePath]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("X1d: Cursor growing jsonl (incomplete last line) is live", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-x1d-grow-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = "/work/websh";
      const filePath = path.join(home, ".cursor", "projects", "work-websh", "agent-transcripts", "uuid-grow", "uuid-grow.jsonl");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.copyFileSync(path.join(FIXTURES, "cursor", "turn-ended.jsonl"), filePath);
      appendIncompleteJsonl(filePath);
      injectProbes({ pgrep: { "(^|/)cursor-agent($| )": ["77"] }, cwds: { 77: cwd } });

      try {
        assert.deepEqual(findLiveAgentSessions([]), [filePath]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("X1e: idle-open Factory complete jsonl is not live", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-x1e-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = "/work/api";
      const sessPath = path.join(factoryWorkspaceDir(home, cwd), "run.jsonl");
      writeFactoryIdle(sessPath);
      const sessions = [{ path: sessPath, mtime: new Date(), source: "factory" }];
      injectProbes({ pgrep: { droid: ["88"] }, cwds: { 88: cwd } });

      try {
        assert.deepEqual(findLiveAgentSessions([]), []);
        assert.ok(!detectLiveSessions(sessions).includes(sessPath), "X1e idle Factory is not live in the UI union");
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("X1e: idle-open Factory held-open fd with live droid pid/cwd is not live", {
      skip: OPEN_FD_SKIP,
    }, () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-x1e-fd-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = "/work/api";
      const sessPath = path.join(factoryWorkspaceDir(home, cwd), "run.jsonl");
      writeFactoryIdle(sessPath);
      const sessions = [{ path: sessPath, mtime: new Date(), source: "factory" }];
      injectProbes({ pgrep: { droid: ["88"] }, cwds: { 88: cwd } });
      const fd = fs.openSync(sessPath, "r");

      try {
        assert.deepEqual(findLiveAgentSessions(sessions), []);
        assert.ok(
          !detectLiveSessions(sessions).includes(sessPath),
          "idle Factory jsonl held open with live droid pid/cwd is not live",
        );
      } finally {
        fs.closeSync(fd);
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("X1f: Factory incomplete/generating jsonl is live", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-x1f-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = "/work/api";
      const sessPath = path.join(factoryWorkspaceDir(home, cwd), "run.jsonl");
      writeFactoryGenerating(sessPath);
      injectProbes({ pgrep: { droid: ["88"] }, cwds: { 88: cwd } });

      try {
        assert.deepEqual(findLiveAgentSessions([]), [sessPath]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("X1f: Factory last user waiting for the model is live", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-x1f-user-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = "/work/api";
      const sessPath = path.join(factoryWorkspaceDir(home, cwd), "run.jsonl");
      writeFactoryLastUser(sessPath);
      injectProbes({ pgrep: { droid: ["88"] }, cwds: { 88: cwd } });

      try {
        assert.deepEqual(findLiveAgentSessions([]), [sessPath]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("X1f: Factory growing jsonl (incomplete last line) is live", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-x1f-grow-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = "/work/api";
      const sessPath = path.join(factoryWorkspaceDir(home, cwd), "run.jsonl");
      writeFactoryIdle(sessPath);
      appendIncompleteJsonl(sessPath);
      injectProbes({ pgrep: { droid: ["88"] }, cwds: { 88: cwd } });

      try {
        assert.deepEqual(findLiveAgentSessions([]), [sessPath]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("X1g: idle-open OpenCode last assistant complete is not live", async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-x1g-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = "/srv/ocwork";
      await seedOpenCodeIndexDb(home, [
        {
          id: "oc-idle",
          directory: cwd,
          messages: [
            { id: "m-u", role: "user", parts: [{ type: "text", text: "hi" }] },
            openCodeIdleAssistant(),
          ],
        },
      ]);
      const sessions = [{ path: "opencode://oc-idle", mtime: new Date(), source: "opencode", project: "/srv/ocwork" }];
      injectProbes({ pgrep: { opencode: ["55"] }, cwds: { 55: cwd } });

      try {
        assert.equal(openCodeSessionIsGenerating("opencode://oc-idle", home), false);
        assert.deepEqual(findLiveAgentSessions(sessions), []);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("X1h: OpenCode last user (waiting for model) is live", async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-x1h-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = "/srv/ocwork";
      await seedOpenCodeIndexDb(home, [
        {
          id: "oc-gen",
          directory: cwd,
          messages: [
            { id: "m-u", role: "user", parts: [{ type: "text", text: "keep going" }] },
          ],
        },
      ]);
      const sessions = [{ path: "opencode://oc-gen", mtime: new Date(), source: "opencode", project: "/srv/ocwork" }];
      injectProbes({ pgrep: { opencode: ["55"] }, cwds: { 55: cwd } });

      try {
        assert.equal(openCodeSessionIsGenerating("opencode://oc-gen", home), true);
        assert.deepEqual(findLiveAgentSessions(sessions), ["opencode://oc-gen"]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("X1h: OpenCode in-progress tool part is live", async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-x1h-tool-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = "/srv/ocwork";
      await seedOpenCodeIndexDb(home, [
        {
          id: "oc-tool",
          directory: cwd,
          messages: [
            { id: "m-u", role: "user", parts: [{ type: "text", text: "run" }] },
            {
              id: "m-a",
              role: "assistant",
              parts: [{ type: "tool", tool: "bash", callID: "c1", state: { status: "running" } }],
            },
          ],
        },
      ]);
      const sessions = [{ path: "opencode://oc-tool", mtime: new Date(), source: "opencode", project: "/srv/ocwork" }];
      injectProbes({ pgrep: { opencode: ["55"] }, cwds: { 55: cwd } });

      try {
        assert.equal(openCodeSessionIsGenerating("opencode://oc-tool", home), true);
        assert.deepEqual(findLiveAgentSessions(sessions), ["opencode://oc-tool"]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("X1h: OpenCode last-assistant streaming text is live", async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-x1h-text-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = "/srv/ocwork";
      await seedOpenCodeIndexDb(home, [
        {
          id: "oc-stream",
          directory: cwd,
          messages: [
            { id: "m-u", role: "user", parts: [{ type: "text", text: "poem" }] },
            openCodeStreamingTextAssistant("Roses are"),
          ],
        },
      ]);
      const sessions = [{ path: "opencode://oc-stream", mtime: new Date(), source: "opencode", project: "/srv/ocwork" }];
      injectProbes({ pgrep: { opencode: ["55"] }, cwds: { 55: cwd } });

      try {
        assert.equal(openCodeSessionIsGenerating("opencode://oc-stream", home), true);
        assert.deepEqual(findLiveAgentSessions(sessions), ["opencode://oc-stream"]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("X1h: OpenCode still-open text part (no time.end) is live", async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-x1h-open-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = "/srv/ocwork";
      await seedOpenCodeIndexDb(home, [
        {
          id: "oc-open",
          directory: cwd,
          messages: [
            { id: "m-u", role: "user", parts: [{ type: "text", text: "poem" }] },
            openCodeStreamingTextAssistant("Roses are", {
              parts: [{ type: "text", text: "Roses are", time: { start: 1_715_731_200_000 } }],
            }),
          ],
        },
      ]);
      const sessions = [{ path: "opencode://oc-open", mtime: new Date(), source: "opencode", project: "/srv/ocwork" }];
      injectProbes({ pgrep: { opencode: ["55"] }, cwds: { 55: cwd } });

      try {
        assert.equal(openCodeSessionIsGenerating("opencode://oc-open", home), true);
        assert.deepEqual(findLiveAgentSessions(sessions), ["opencode://oc-open"]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("X1h: OpenCode unmatched step-start is live", async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-x1h-step-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = "/srv/ocwork";
      await seedOpenCodeIndexDb(home, [
        {
          id: "oc-step",
          directory: cwd,
          messages: [
            { id: "m-u", role: "user", parts: [{ type: "text", text: "go" }] },
            {
              id: "m-a",
              role: "assistant",
              time: { created: 1_715_731_200_000 },
              parts: [{ type: "step-start" }],
            },
          ],
        },
      ]);
      const sessions = [{ path: "opencode://oc-step", mtime: new Date(), source: "opencode", project: "/srv/ocwork" }];
      injectProbes({ pgrep: { opencode: ["55"] }, cwds: { 55: cwd } });

      try {
        assert.equal(openCodeSessionIsGenerating("opencode://oc-step", home), true);
        assert.deepEqual(findLiveAgentSessions(sessions), ["opencode://oc-step"]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("X1i: dead process leftover recordings are not live", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-x1i-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = "/work/api";
      writeFactoryGenerating(path.join(factoryWorkspaceDir(home, cwd), "run.jsonl"));
      injectProbes({ pgrep: {}, cwds: {} });

      try {
        assert.deepEqual(findLiveAgentSessions([]), []);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("X1j: process alive in a cwd with no recording contributes nothing", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-x1j-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      injectProbes({
        pgrep: { codex: ["11"], droid: ["12"], opencode: ["13"], "(^|/)cursor-agent($| )": ["14"] },
        cwds: { 11: "/nowhere/a", 12: "/nowhere/b", 13: "/nowhere/c", 14: "/nowhere/d" },
      });

      try {
        assert.deepEqual(findLiveAgentSessions([]), []);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  });

  describe("CC cursor-cloud never-live", () => {
    test("CC: recent mtime plus a held-open fd still yields no live entry", {
      skip: OPEN_FD_SKIP,
    }, () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-cc-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-cc-files-"));
      const ccPath = path.join(tmpDir, "bc-agent.jsonl");
      writeCursorGenerating(ccPath);
      const fd = fs.openSync(ccPath, "r");

      try {
        const live = detectLiveSessions([{ path: ccPath, mtime: new Date(), source: "cursor-cloud" }]);
        assert.ok(!live.includes(ccPath));
      } finally {
        fs.closeSync(fd);
        fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  });

  describe("D1 one live vocabulary", () => {
    test("D1: stampLive is membership of detectLiveSessions", () => {
      const livePaths = ["/gen"];
      assert.equal(pathIsLive("/gen", livePaths), true);
      assert.equal(pathIsLive("/idle", livePaths), false);
      assert.equal(stampLive({ path: "/idle" }, livePaths).live, false);
      assert.equal(stampLive({ path: "/gen" }, livePaths).live, true);
      assert.equal(stampLive({ path: "/gen" }, new Set(["/gen"])).live, true);
    });

    test("D1: session.live equals detectLiveSessions membership for mixed G1/G2", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-d1-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const idleSid = G1_SID;
      const genSid = "01a03de0-dec6-7340-ae6c-e710001a70fb";
      const idleDir = grokSessionDir(home, G1_CWD, idleSid);
      const genDir = grokSessionDir(home, G1_CWD, genSid);
      copyG1Recording(idleDir);
      writeGrokGenerating(genDir);
      writeGrokActive(home, [
        { session_id: idleSid, cwd: G1_CWD, pid: 49168 },
        { session_id: genSid, cwd: G1_CWD, pid: 49200 },
      ]);
      injectProbes({ cwds: { 49168: G1_CWD, 49200: G1_CWD } });

      try {
        const sessions = [
          asDiscovery(idleDir, "grok"),
          asDiscovery(genDir, "grok"),
        ];
        const livePaths = detectLiveSessions(sessions);
        const annotated = sessions.map((s) => stampLive({ ...s }, livePaths));
        assert.equal(annotated[0].live, false, "G1 idle-open is not live");
        assert.equal(annotated[1].live, true, "G2 generating is live");
        assert.equal(annotated[0].live, livePaths.includes(idleDir));
        assert.equal(annotated[1].live, livePaths.includes(genDir));
        assertSurfacesAgree(sessions, livePaths);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("D1: /api/sessions live, dashboard embed, CLI live:true agree with detectLiveSessions for mixed G1/G2", async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-d1-surf-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const idleSid = G1_SID;
      const genSid = "01a03de0-dec6-7340-ae6c-e710001a70fb";
      const idleDir = grokSessionDir(home, G1_CWD, idleSid);
      const genDir = grokSessionDir(home, G1_CWD, genSid);
      copyG1Recording(idleDir);
      writeGrokGenerating(genDir);
      writeGrokActive(home, [
        { session_id: idleSid, cwd: G1_CWD, pid: 49168 },
        { session_id: genSid, cwd: G1_CWD, pid: 49200 },
      ]);
      injectProbes({ cwds: { 49168: G1_CWD, 49200: G1_CWD } });
      const justFinished = new Date();
      const sessions = [
        asDiscovery(idleDir, "grok", { mtime: justFinished }),
        asDiscovery(genDir, "grok", { mtime: new Date(justFinished.getTime() - 60_000) }),
      ];

      try {
        clearLiveSessionsCache();
        const livePaths = detectLiveSessions(sessions);
        assert.ok(!livePaths.includes(idleDir), "G1 idle-open is not live");
        assert.ok(livePaths.includes(genDir), "G2 generating is live");

        const api = await apiSessionsPayload(sessions);
        const idleApi = api.sessions.find((s) => s.path === idleDir);
        const genApi = api.sessions.find((s) => s.path === genDir);
        assert.equal(idleApi.live, false, "/api/sessions live is false for G1");
        assert.equal(genApi.live, true, "/api/sessions live is true for G2");
        assert.equal(idleApi.live, livePaths.includes(idleDir));
        assert.equal(genApi.live, livePaths.includes(genDir));
        assert.deepEqual(
          (api.liveSessions || []).map((s) => s.path).sort(),
          livePaths.filter((p) => sessions.some((s) => s.path === p)).sort(),
        );
        assert.ok((api.liveSessions || []).every((s) => s.live === true));

        const embed = parseDashboardInit(browserPage(sessions, new Map(), null, sessions));
        const idleEmbed = embed.sessions.find((s) => s.path === idleDir);
        const genEmbed = embed.sessions.find((s) => s.path === genDir);
        assert.equal(idleEmbed.live, false, "dashboard embed live is false for G1");
        assert.equal(genEmbed.live, true, "dashboard embed live is true for G2");
        assert.deepEqual(
          (embed.liveSessions || []).map((s) => s.path).sort(),
          (api.liveSessions || []).map((s) => s.path).sort(),
        );

        const cliOut = cliLiveTrueOutput(sessions);
        assert.ok(cliOut.includes(genDir), "CLI live:true matches G2");
        assert.ok(!cliOut.includes(idleDir), "CLI live:true excludes G1");

        const shot = renderDashboardListFromEmbed(embed);
        const html = shot.html;
        const idleId = idleEmbed.id;
        const genId = genEmbed.id;
        assert.match(
          html,
          new RegExp(`data-live-session="${genId}"[\\s\\S]*class="run-state-badge" data-status="running">running`),
          "D1 G2 HTML from browserPage snapshot is run-state-badge running",
        );
        assert.doesNotMatch(
          html,
          new RegExp(`data-live-session="${idleId}"`),
          "D1 G1 is not a pinned external live row",
        );
        assert.match(
          html,
          new RegExp(`data-session-id="${idleId}"`),
          "D1 G1 stays an inventory row",
        );
        assert.doesNotMatch(
          html,
          new RegExp(`data-session-id="${idleId}"[\\s\\S]*class="live-indicator">running`),
          "D1 G1 inventory HTML has no live-indicator",
        );
        assert.doesNotMatch(
          html,
          new RegExp(`data-session-id="${idleId}"[\\s\\S]*class="run-state-badge" data-status="running">running`),
          "D1 G1 inventory HTML has no run-state-badge running",
        );
        assert.ok((embed.liveSessions || []).every((s) => s.live === true));
        assert.equal(idleEmbed.live, false);
        assert.equal(genEmbed.live, true);
        assertSnapshotLiveCount(shot, 1, "same G1/G2 snapshot: liveNow/#appLive/overview are 1 (G2 only)");
        const rail = assertChatRailFromEmbed(embed, 1, "same G1/G2 snapshot: chat-page renderRail #appLive is 1");
        assert.match(rail.html, new RegExp(`href="/run\\?session=${genId}"[^>]*><span class="rail-glyph" data-status="running"`));
        assert.doesNotMatch(rail.html, new RegExp(`href="/run\\?session=${idleId}"[^>]*><span class="rail-glyph" data-status="running"`));
        const railLeak = renderChatRail({
          sessions: embed.sessions,
          liveSessions: [idleEmbed, genEmbed],
        });
        assertChatRailLiveCount(railLeak, 1, "G1 live:false stuffed into liveSessions does not bump chat-page #appLive");
        assert.doesNotMatch(railLeak.html, new RegExp(`href="/run\\?session=${idleId}"[^>]*><span class="rail-glyph" data-status="running"`));
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("D1: idle launched G1 window is not RUNNING; generating launched G2 window is", async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-d1-launch-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const idleSid = G1_SID;
      const genSid = "01a03de0-dec6-7340-ae6c-e710001a70fb";
      const idleDir = grokSessionDir(home, G1_CWD, idleSid);
      const genDir = grokSessionDir(home, G1_CWD, genSid);
      copyG1Recording(idleDir);
      writeGrokGenerating(genDir);
      fs.writeFileSync(path.join(genDir, "chat_history.jsonl"), "\n");
      writeGrokActive(home, [
        { session_id: idleSid, cwd: G1_CWD, pid: 49168 },
        { session_id: genSid, cwd: G1_CWD, pid: 49200 },
      ]);
      injectProbes({ cwds: { 49168: G1_CWD, 49200: G1_CWD } });
      const sessions = [
        asDiscovery(idleDir, "grok"),
        asDiscovery(genDir, "grok"),
      ];

      try {
        clearLiveSessionsCache();
        const livePaths = detectLiveSessions(sessions);
        assert.ok(!livePaths.includes(idleDir), "G1 idle recording is not in detectLiveSessions");
        assert.ok(livePaths.includes(genDir), "G2 generating recording is in detectLiveSessions");

        const api = await apiSessionsPayload(sessions);
        const idleApi = api.sessions.find((s) => s.path === idleDir);
        const genApi = api.sessions.find((s) => s.path === genDir);
        assert.equal(idleApi.live, false, "/api/sessions live is false for idle launched recording");
        assert.equal(genApi.live, true, "/api/sessions live is true for generating launched recording");

        const embed = parseDashboardInit(browserPage(sessions, new Map(), null, sessions));
        const idleRun = {
          id: "@idle",
          status: "idle",
          sessionPath: idleDir,
          agent: "grok",
          cwd: G1_CWD,
          startedAt: new Date().toISOString(),
          prompt: "Send a follow-up",
        };
        const genRun = {
          id: "@gen",
          status: "running",
          sessionPath: genDir,
          agent: "grok",
          cwd: G1_CWD,
          startedAt: new Date().toISOString(),
          prompt: "generating now",
        };
        const idleOnly = {
          ...embed,
          sessions: embed.sessions.filter((s) => s.path === idleDir),
          liveSessions: [],
          runs: [idleRun],
        };
        const genOnly = {
          ...embed,
          sessions: embed.sessions.filter((s) => s.path === genDir),
          liveSessions: (embed.liveSessions || []).filter((s) => s.path === genDir),
          runs: [genRun],
        };

        const idleShot = renderDashboardListFromEmbed(idleOnly);
        assertSnapshotLiveCount(idleShot, 0, "idle launched G1: liveNow/#appLive/overview are 0");
        assert.match(
          idleShot.html,
          /data-run-id="@idle"[\s\S]*class="run-state-badge" data-status="idle">idle/,
          "idle launched G1 paints run-state-badge idle",
        );
        assert.doesNotMatch(
          idleShot.html,
          /class="run-state-badge" data-status="running">running/,
          "idle launched G1 does not paint running",
        );
        const idleRail = assertChatRailFromEmbed(idleOnly, 0, "idle launched G1: chat #appLive is 0");
        assert.match(idleRail.html, /href="\/run\?id=%40idle"[^>]*><span class="rail-glyph" data-status="idle"/);
        assert.doesNotMatch(idleRail.html, /data-status="running"/);

        const genShot = renderDashboardListFromEmbed(genOnly);
        assertSnapshotLiveCount(genShot, 1, "generating launched G2: liveNow/#appLive/overview are 1");
        assert.match(
          genShot.html,
          /data-run-id="@gen"[\s\S]*class="run-state-badge" data-status="running">running/,
          "generating launched G2 paints run-state-badge running",
        );
        const genRail = assertChatRailFromEmbed(genOnly, 1, "generating launched G2: chat #appLive is 1");
        assert.match(genRail.html, /href="\/run\?id=%40gen"[^>]*><span class="rail-glyph" data-status="running"/);

        const idleIdent = paintLaunchedRunIdentity({
          run: { ...idleRun, live: false },
          liveSessions: [{ path: idleDir, live: false, id: idleSid, source: "grok" }],
          sessionState: "idle",
        });
        assert.equal(idleIdent.ssr, "idle", "runPage() SSR of idle launched G1 #runStatus is idle");
        assert.equal(idleIdent.status, "idle", "setStatus after snapshot poll leaves idle launched G1 idle");
        assert.match(idleIdent.page, /data-run-state="idle"/, "D1: /run?id= idle G1 data-run-state is idle");
        assert.doesNotMatch(idleIdent.page, /data-run-state="live"/);
        assert.doesNotMatch(
          idleIdent.page,
          /id="runStatus" data-status="running">running/,
          "idle launched /run?id=@idle identity is not running",
        );
        assert.equal(idleIdent.terminalStatus, "running", "raw terminal may stay pane-alive");
        assert.equal(idleIdent.composer.state, "idle", "idle launched G1 #composerStatus is idle");
        assert.equal(idleIdent.composer.text, "Idle");
        assert.equal(idleIdent.composer.stopHidden, true, "idle launched G1 does not paint Stop as Running");
        assert.match(idleIdent.activity, /Not running/, "idle launched G1 activity is not Planning next moves");
        assert.doesNotMatch(idleIdent.activity, /Planning next moves/);
        assert.equal(idleIdent.pollComposer.state, "idle");

        const genIdent = paintLaunchedRunIdentity({
          run: { ...genRun, live: true },
          liveSessions: [{ path: genDir, live: true, id: genSid, source: "grok" }],
          sessionState: "running",
        });
        assert.equal(genIdent.ssr, "running", "runPage() SSR of generating launched G2 #runStatus is running");
        assert.equal(genIdent.status, "running", "setStatus after snapshot poll keeps generating launched G2 running");
        assert.match(genIdent.page, /id="runStatus" data-status="running">running/);
        assert.match(genIdent.page, /data-run-state="running"/,
          "D1: /run?id= generating G2 data-run-state is running, same word as #runStatus");
        assert.doesNotMatch(genIdent.page, /data-run-state="live"/,
          "D1: /run?id= does not write data-run-state live beside #runStatus running");
        assert.equal(genIdent.composer.state, "running", "generating launched G2 #composerStatus is running");
        assert.equal(genIdent.composer.text, "Running");
        assert.equal(genIdent.composer.stopHidden, false);
        assert.match(genIdent.activity, /Planning next moves/, "generating launched G2 keeps the in-progress marker");
        assert.equal(genIdent.pollComposer.state, "running");

        const idleWin = {
          id: "@8",
          name: "grok",
          dead: false,
          options: { tq_agent: "grok", tq_cwd: G1_CWD, tq_started: idleRun.startedAt },
        };
        const genWin = {
          id: "@9",
          name: "grok",
          dead: false,
          options: { tq_agent: "grok", tq_cwd: G1_CWD, tq_started: genRun.startedAt },
        };
        const idleSess = captureJsonHandler();
        await handleApiRunsSession(null, idleSess.res, new URL("http://localhost/api/runs/session?id=%408"), {
          listWindows: () => [idleWin],
          linkRunSession: () => ({ path: idleDir, link: "linked", attribution: "sid" }),
          readRunTombstones: () => [],
          findSessions: () => sessions,
          detectLiveSessions: (found) => detectLiveSessions(found),
        });
        const idleSessBody = idleSess.parse();
        assert.equal(idleSessBody.state, "idle", "/api/runs/session state is idle for launched G1");
        assert.equal(idleSessBody.run.status, "idle", "/api/runs/session run.status is idle for launched G1");
        assert.equal(idleSessBody.state, idleSessBody.run.status);

        const genSess = captureJsonHandler();
        await handleApiRunsSession(null, genSess.res, new URL("http://localhost/api/runs/session?id=%409"), {
          listWindows: () => [genWin],
          linkRunSession: () => ({ path: genDir, link: "linked", attribution: "sid" }),
          readRunTombstones: () => [],
          findSessions: () => sessions,
          detectLiveSessions: (found) => detectLiveSessions(found),
        });
        const genSessBody = genSess.parse();
        assert.equal(genSessBody.state, "running", "/api/runs/session state is running for launched G2");
        assert.equal(genSessBody.run.status, "running", "/api/runs/session run.status is running for launched G2");
        assert.equal(genSessBody.state, genSessBody.run.status);

        const list = captureJsonHandler();
        await handleApiRuns({ method: "GET" }, list.res, new URL("http://localhost/api/runs"), {
          listWindows: () => [idleWin, genWin],
          linkRunSession: (win) => win.id === "@9"
            ? { path: genDir, link: "linked", attribution: "sid" }
            : { path: idleDir, link: "linked", attribution: "sid" },
          readRunTombstones: () => [],
          findSessions: () => sessions,
          detectLiveSessions: (found) => detectLiveSessions(found),
        });
        const listed = list.parse().runs;
        assert.equal(listed.find((r) => r.id === "@8").status, "idle");
        assert.equal(listed.find((r) => r.id === "@8").state, "idle");
        assert.equal(listed.find((r) => r.id === "@9").status, "running");
        assert.equal(listed.find((r) => r.id === "@9").state, "running");

        const idleSnap = captureJsonHandler();
        await handleApiRunsSnapshot(null, idleSnap.res, new URL("http://localhost/api/runs/snapshot?id=%408"), {
          listWindows: () => [idleWin],
          linkRunSession: () => ({ path: idleDir, link: "linked", attribution: "sid" }),
          readRunTombstones: () => [],
          findSessions: () => sessions,
          detectLiveSessions: (found) => detectLiveSessions(found),
          capturePane: () => "idle pane",
        });
        assert.equal(idleSnap.parse().status, "idle", "/api/runs/snapshot status is idle for launched G1");

        const genSnap = captureJsonHandler();
        await handleApiRunsSnapshot(null, genSnap.res, new URL("http://localhost/api/runs/snapshot?id=%409"), {
          listWindows: () => [genWin],
          linkRunSession: () => ({ path: genDir, link: "linked", attribution: "sid" }),
          readRunTombstones: () => [],
          findSessions: () => sessions,
          detectLiveSessions: (found) => detectLiveSessions(found),
          capturePane: () => "generating pane",
        });
        assert.equal(genSnap.parse().status, "running", "/api/runs/snapshot status is running for launched G2");

        const idleHash = sessionHash(idleDir);
        const genHash = sessionHash(genDir);
        const liveSessionDeps = (win, path) => ({
          findSessions: () => sessions,
          detectLiveSessions: (found) => detectLiveSessions(found),
          muxAvailable: () => true,
          listWindows: () => [win],
          linkRunSession: () => ({ path, link: "linked", attribution: "sid" }),
          readRunTombstones: () => [],
          parseSession: (p) => ({ path: p, source: "grok", events: [] }),
          buildSessionChapters: () => [],
          statSync: () => ({ mtimeMs: 1, size: 1 }),
        });
        const idleNested = captureJsonHandler();
        await handleApiSessionsLive(null, idleNested.res, new URL(`http://localhost/api/sessions/live?id=${idleHash}`), liveSessionDeps(idleWin, idleDir));
        const idleNestedBody = idleNested.parse();
        assert.equal(idleNestedBody.live, false);
        assert.equal(idleNestedBody.state, "idle");
        assert.equal(idleNestedBody.run.status, "idle", "D1: GET /api/sessions/live nested run.status is idle for launched G1");

        const genNested = captureJsonHandler();
        await handleApiSessionsLive(null, genNested.res, new URL(`http://localhost/api/sessions/live?id=${genHash}`), liveSessionDeps(genWin, genDir));
        const genNestedBody = genNested.parse();
        assert.equal(genNestedBody.live, true);
        assert.equal(genNestedBody.state, "running", "D1: GET /api/sessions/live state is running, not live");
        assert.equal(genNestedBody.run.status, "running", "D1: GET /api/sessions/live nested run.status is running for launched G2");
        assert.equal(genNestedBody.state, genNestedBody.run.status,
          "D1: generating G2 state and nested run.status are the same word");

        const viewIdle = captureJsonHandler();
        await handleView(null, viewIdle.res, new URL(`http://localhost/view?id=${idleHash}`), {
          ...liveSessionDeps(idleWin, idleDir),
          renderHTML: () => "<!DOCTYPE html><html><body>G1 VIEW</body></html>",
        });
        assert.match(String(viewIdle.res.end.mock.calls[0].arguments[0]), /idle run &middot; open chat/,
          "D1: /view idle launched G1 chip is idle run");
        assert.doesNotMatch(String(viewIdle.res.end.mock.calls[0].arguments[0]), /live run &middot; open chat/);
        assert.doesNotMatch(String(viewIdle.res.end.mock.calls[0].arguments[0]), /running run &middot; open chat/);

        const viewGen = captureJsonHandler();
        await handleView(null, viewGen.res, new URL(`http://localhost/view?id=${genHash}`), {
          ...liveSessionDeps(genWin, genDir),
          renderHTML: () => "<!DOCTYPE html><html><body>G2 VIEW</body></html>",
        });
        assert.match(String(viewGen.res.end.mock.calls[0].arguments[0]), /running run &middot; open chat/,
          "D1: /view generating launched G2 chip is running run");
        assert.doesNotMatch(String(viewGen.res.end.mock.calls[0].arguments[0]), /live run &middot; open chat/,
          "D1: /view chip copy does not say live run beside data-status running");
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("D1: G1/G2 HTML from a real browserPage render uses s.live === true only", async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-d1-html-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const idleSid = G1_SID;
      const genSid = "01a03de0-dec6-7340-ae6c-e710001a70fb";
      const idleDir = grokSessionDir(home, G1_CWD, idleSid);
      const genDir = grokSessionDir(home, G1_CWD, genSid);
      copyG1Recording(idleDir);
      writeGrokGenerating(genDir);
      writeGrokActive(home, [
        { session_id: idleSid, cwd: G1_CWD, pid: 49168 },
        { session_id: genSid, cwd: G1_CWD, pid: 49200 },
      ]);
      injectProbes({ cwds: { 49168: G1_CWD, 49200: G1_CWD } });
      const justFinished = new Date();
      const sessions = [
        asDiscovery(idleDir, "grok", { mtime: justFinished }),
        asDiscovery(genDir, "grok", { mtime: new Date(justFinished.getTime() - 60_000) }),
      ];

      try {
        clearLiveSessionsCache();
        const page = browserPage(sessions, new Map(), null, sessions);
        const embed = parseDashboardInit(page);
        const idleEmbed = embed.sessions.find((s) => s.path === idleDir);
        const genEmbed = embed.sessions.find((s) => s.path === genDir);
        assert.equal(idleEmbed.live, false, "browserPage stamps G1 live:false");
        assert.equal(genEmbed.live, true, "browserPage stamps G2 live:true");
        assert.equal((embed.liveSessions || []).length, 1);
        assert.equal(embed.liveSessions[0].path, genDir);
        assert.equal(embed.liveSessions[0].live, true, "pinned liveSessions row is stampLive, not hardcoded");

        const shot = renderDashboardListFromEmbed(embed);
        const html = shot.html;
        assert.match(
          html,
          new RegExp(`data-live-session="${genEmbed.id}"[\\s\\S]*class="run-state-badge" data-status="running">running`),
          "G2 generating HTML is run-state-badge running from s.live",
        );
        assert.doesNotMatch(html, new RegExp(`data-live-session="${idleEmbed.id}"`));
        assert.match(html, new RegExp(`data-session-id="${idleEmbed.id}"`));
        assert.doesNotMatch(
          html,
          new RegExp(`data-session-id="${idleEmbed.id}"[\\s\\S]*class="live-indicator">running`),
        );
        assert.doesNotMatch(html, /class="live-indicator">running/, "G2 is not the inventory live-indicator path");
        assertSnapshotLiveCount(shot, 1, "same G1/G2 snapshot: #appLive and overview live stat equal liveNow()=1");
        const rail = assertChatRailFromEmbed(embed, 1, "same G1/G2 snapshot: chat-page renderRail #appLive is 1");
        assert.match(rail.html, new RegExp(`href="/run\\?session=${genEmbed.id}"[^>]*><span class="rail-glyph" data-status="running"`));
        assert.doesNotMatch(rail.html, new RegExp(`href="/run\\?session=${idleEmbed.id}"[^>]*><span class="rail-glyph" data-status="running"`));

        const g3Dead = renderDashboardListFromEmbed({
          sessions: [{ ...idleEmbed, live: false }],
          liveSessions: [{ ...genEmbed, live: false }],
          total: 1,
          stats: {},
        });
        assert.doesNotMatch(
          g3Dead.html,
          /class="run-state-badge" data-status="running">running/,
          "live:false cannot paint a running badge even if stuffed into liveSessions",
        );
        assertSnapshotLiveCount(g3Dead, 0, "live:false leak does not increment liveNow/#appLive/overview");
        const railDead = renderChatRail({
          sessions: [{ ...idleEmbed, live: false }],
          liveSessions: [{ ...genEmbed, live: false }, { ...idleEmbed, live: false }],
        });
        assertChatRailLiveCount(railDead, 0, "live:false leak does not increment chat-page renderRail #appLive");
        assert.doesNotMatch(railDead.html, /data-status="running"/);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("D1: G3 dead pid is not live on detector, API, CLI, or dashboard", async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-d1-g3-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = "/home/dev/code/tracequest";
      const sid = "95708b29-2d68-407f-bc97-cc61e51f63c3";
      const sessionDir = grokSessionDir(home, cwd, sid);
      writeGrokGenerating(sessionDir);
      writeGrokActive(home, [{ session_id: sid, cwd, pid: deadPid() }]);
      injectProbes({ cwds: {} });
      const sessions = [asDiscovery(sessionDir, "grok")];

      try {
        assert.deepEqual(findLiveGrok(), []);
        assert.ok(!detectLiveSessions(sessions).includes(sessionDir));
        const api = await apiSessionsPayload(sessions);
        assert.equal(api.sessions[0].live, false);
        assert.equal((api.liveSessions || []).length, 0);
        const embed = parseDashboardInit(browserPage(sessions, new Map(), null, sessions));
        assert.equal(embed.sessions[0].live, false);
        assert.equal((embed.liveSessions || []).length, 0);
        const shot = renderDashboardListFromEmbed(embed);
        assert.doesNotMatch(shot.html, /class="live-indicator">running/);
        assert.doesNotMatch(shot.html, /class="run-state-badge" data-status="running">running/);
        assertSnapshotLiveCount(shot, 0, "G3 dead pid: liveNow/#appLive/overview are 0");
        assertChatRailFromEmbed(embed, 0, "G3 dead pid: chat-page renderRail #appLive is 0");
        const cliOut = cliLiveTrueOutput(sessions);
        assert.ok(!cliOut.includes(sessionDir));
        assert.match(cliOut, /No sessions match the filter expression|Found 0 sessions/);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("D1: G4 cwd mismatch is not live on detector, API, CLI, or dashboard", async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-d1-g4-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const sid = "stale-cwd";
      const sessionDir = grokSessionDir(home, "/definitely-not-this-cwd", sid);
      writeGrokGenerating(sessionDir);
      writeGrokActive(home, [{ session_id: sid, cwd: "/definitely-not-this-cwd", pid: process.pid }]);
      injectProbes({ cwds: { [String(process.pid)]: process.cwd() } });
      const sessions = [asDiscovery(sessionDir, "grok")];

      try {
        assert.deepEqual(findLiveGrok(), []);
        assert.deepEqual(detectLiveSessions(sessions), []);
        const api = await apiSessionsPayload(sessions);
        assert.equal(api.sessions[0].live, false);
        const embed = parseDashboardInit(browserPage(sessions, new Map(), null, sessions));
        assert.equal(embed.sessions[0].live, false);
        const shot = renderDashboardListFromEmbed(embed);
        assert.doesNotMatch(shot.html, /class="live-indicator">running/);
        assert.doesNotMatch(shot.html, /class="run-state-badge" data-status="running">running/);
        assertSnapshotLiveCount(shot, 0, "G4 cwd mismatch: liveNow/#appLive/overview are 0");
        assertChatRailFromEmbed(embed, 0, "G4 cwd mismatch: chat-page renderRail #appLive is 0");
        const cliOut = cliLiveTrueOutput(sessions);
        assert.ok(!cliOut.includes(sessionDir));
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("D1: CC cursor-cloud is not live on detector, API, or dashboard even with recent mtime and a held-open fd", {
      skip: OPEN_FD_SKIP,
    }, async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-d1-cc-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-d1-cc-files-"));
      const ccPath = path.join(tmpDir, "bc-agent.jsonl");
      writeCursorGenerating(ccPath);
      const fd = fs.openSync(ccPath, "r");
      injectProbes({ pgrep: {}, cwds: {} });
      const sessions = [asDiscovery(ccPath, "cursor-cloud", { mtime: new Date() })];

      try {
        const live = detectLiveSessions(sessions);
        assert.ok(!live.includes(ccPath));
        const api = await apiSessionsPayload(sessions);
        assert.equal(api.sessions[0].live, false);
        assert.ok(!(api.liveSessions || []).some((s) => s.path === ccPath));
        const embed = parseDashboardInit(browserPage(sessions, new Map(), null, sessions));
        assert.equal(embed.sessions[0].live, false);
        const shot = renderDashboardListFromEmbed(embed);
        assert.doesNotMatch(shot.html, /class="live-indicator">running/);
        assert.doesNotMatch(shot.html, /class="run-state-badge" data-status="running">running/);
        assertSnapshotLiveCount(shot, 0, "CC never-live: liveNow/#appLive/overview are 0");
        assertChatRailFromEmbed(embed, 0, "CC never-live: chat-page renderRail #appLive is 0");
        const cliOut = cliLiveTrueOutput(sessions);
        assert.ok(!cliOut.includes(ccPath));
      } finally {
        fs.closeSync(fd);
        fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("D1: chat-page 4s quiet-window does not promote idle completed G1 to list-row live", async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-d1-quiet-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const idleDir = grokSessionDir(home, G1_CWD, G1_SID);
      copyG1Recording(idleDir);
      writeGrokActive(home, [{ session_id: G1_SID, cwd: G1_CWD, pid: Number(G1_PID) }]);
      injectProbes({ cwds: { [G1_PID]: G1_CWD } });
      const sessions = [asDiscovery(idleDir, "grok", { mtime: new Date() })];

      try {
        assert.ok(!detectLiveSessions(sessions).includes(idleDir));
        const api = await apiSessionsPayload(sessions);
        assert.equal(api.sessions[0].live, false, "recent mtime of a completed turn is not /api/sessions live");
        const embed = parseDashboardInit(browserPage(sessions, new Map(), null, sessions));
        assert.equal(embed.sessions[0].live, false, "dashboard embed does not take live from 4s quiet-window mtime");
        assert.equal((embed.liveSessions || []).length, 0);
        const shot = renderDashboardListFromEmbed(embed);
        assert.doesNotMatch(shot.html, /class="live-indicator">running/, "quiet-window mtime does not paint live-indicator");
        assert.doesNotMatch(shot.html, /class="run-state-badge" data-status="running">running/, "quiet-window mtime does not paint run-state-badge running");
        assertSnapshotLiveCount(shot, 0, "quiet-window idle G1: liveNow/#appLive/overview stay 0");
        const quietRail = renderChatRail({
          sessions: embed.sessions,
          liveSessions: [{ ...embed.sessions[0], live: false }],
        });
        assertChatRailLiveCount(quietRail, 0, "quiet-window idle G1: chat-page renderRail #appLive stays 0");
        assert.doesNotMatch(quietRail.html, /data-status="running"/);

        const insideQuiet = Date.now() - 500;
        const watch = paintWatchIdentityAfterPoll({
          live: false,
          etagMtime: insideQuiet,
          hash: sessionHash(idleDir),
        });
        assert.ok(!detectLiveSessions(sessions).includes(idleDir),
          "G1 completed turn is not detectLiveSessions inside QUIET_MS");
        assert.equal(watch.status, "idle",
          "D1: idle G1 /run?session= #runStatus stays idle inside QUIET_MS");
        assert.equal(watch.runState, "idle",
          "D1: idle G1 /run?session= data-run-state stays idle inside QUIET_MS");
        assert.match(watch.title, /idle session/,
          "D1: idle G1 /run?session= title stays idle session inside QUIET_MS");
        assert.equal(watch.observerTitle, "Watching an idle session",
          "D1: idle G1 observer heading stays idle inside QUIET_MS");
        assert.equal(watch.liveTail, "0",
          "D1: idle G1 data-live-tail stays 0 inside QUIET_MS (no Stop composer)");
        assert.equal(watch.liveTailFormHidden, true,
          "D1: idle G1 #liveTailForm is hidden (no Stop) inside QUIET_MS");
        assert.equal(watch.growth, false,
          "D1: idle G1 growth lastState follows identity inside QUIET_MS");
        assert.equal(watch.namedOutput, "leftover-snap",
          "D1: idle G1 leftover-snaps named-output inside QUIET_MS");
        assert.notEqual(watch.namedCardContained, "parked",
          "D1: leftover-occupying named card is not data-contained=parked");
        assert.equal(watch.namedCardInHistory, false,
          "D1: leftover-occupying named card is not split into #chatHistory");
        assert.equal(watch.namedCardMeta, "Lines 1-6",
          "D1: leftover-occupying named card keeps Lines 1-6 in the fold");
        assert.equal(watch.namedCardFold, true,
          "D1: named shell output occupies leftover");
        assert.equal(watch.namedOccupiesLeftover, true,
          "D1: named shell output occupies leftover pixels above the composer");
        assert.equal(watch.leftoverOpeningOnLeftover, true,
          "D1: leftover-owned pixels include opening prose occupying leftover");
        assert.equal(watch.leftoverClosingOnLeftover, true,
          "D1: leftover-owned pixels include closing prose occupying leftover");
        assert.match(watch.leftoverOpeningText || "", /I'll stop that process now/,
          "D1: leftover-owned opening is the screenshot opening prose");
        assert.match(watch.leftoverClosingText || "", /Port 7777 is free/,
          "D1: leftover-owned closing is the screenshot closing prose");
        assert.equal(watch.leftoverUserOnLeftover, false,
          "D1: user is off leftover inside QUIET_MS");
        assert.ok(watch.leftover === watch.leftoverComposerTop - watch.leftoverTop,
          "D1: leftover bounds are production leftover = composer.top − leftover.top");
        assert.equal(watch.leftover, watch.leftoverClientHeight,
          "D1: leftover occupancy of leftover is leftover.clientHeight leftover viewport");
        assert.notEqual(watch.leftover, 560,
          "D1: leftover is not a hardcoded 0–560 leftover box");
        assert.ok(watch.leftover > watch.leftoverOwned,
          "D1: leftover occupancy of leftover-owned content is not leftover occupancy of leftover");
        assert.ok(watch.leftoverAir === watch.leftover - watch.leftoverOwned,
          "D1: leftoverAir is leftover − leftoverOwned of leftover leftover viewport");
        assert.ok(watch.leftoverAir > 8,
          "D1: BAR leftover has leftover air under closing; leftoverAir ≤ 8 is leftover occupancy of leftover-owned");
        assert.equal(watch.leftoverSnapIsStale, false,
          "D1: production leftoverSnapIsStale does not treat G1 tool-then-prose as after-growth");
        assert.ok((watch.events || []).some((e) => e.type === "assistant" && (e.toolCalls || []).some((t) => t.name === "Bash")),
          "D1: real G1 fixture has named Bash/shell output, not a tool-less stub");
        assert.doesNotMatch(watch.activityHtml, /Planning next moves/,
          "D1: idle G1 does not shimmer Planning next moves inside QUIET_MS");
        assert.equal(watch.continueFormHidden, false,
          "D1: idle G1 paints a visible follow-up composer inside QUIET_MS");
        assert.equal(watch.continuePlaceholder, "Send a follow-up",
          "D1: idle G1 composer is Send a follow-up, not Stop");
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("D1: idle G1 /run?session= #runStatus stays idle inside QUIET_MS", () => {
      const insideQuiet = Date.now() - 500;
      assert.ok(insideQuiet > Date.now() - 4000, "poll etag is inside QUIET_MS");
      const watch = paintWatchIdentityAfterPoll({ live: false, etagMtime: insideQuiet });
      assert.equal(watch.status, "idle", "idle G1 #runStatus is idle while mtime is inside QUIET_MS");
      assert.equal(watch.text, "idle");
      assert.equal(watch.runState, "idle");
      assert.match(watch.title, /idle session/);
      assert.equal(watch.observerTitle, "Watching an idle session");
      assert.notEqual(watch.status, "running");
      assert.equal(watch.growth, false, "completed idle G1 lastState follows identity, not QUIET_MS");
      assert.equal(watch.liveTail, "0", "exclusive live-tail Stop is not QUIET_MS growth");
      assert.equal(watch.liveTailFormHidden, true, "D1: idle G1 #liveTailForm stays hidden (no Stop)");
      assert.equal(watch.namedOutput, "leftover-snap",
        "D1: idle G1 leftover-snaps named-output (not a parked generating trail)");
      assert.notEqual(watch.namedCardContained, "parked",
        "D1: leftover-occupying named card is not data-contained=parked");
      assert.equal(watch.namedCardInHistory, false,
        "D1: leftover-occupying named card is not split into #chatHistory");
      assert.equal(watch.namedCardMeta, "Lines 1-6",
        "D1: leftover-occupying named card keeps Lines 1-6 in the fold");
      assert.equal(watch.namedCardFold, true,
        "D1: named shell output occupies leftover");
      assert.equal(watch.namedOccupiesLeftover, true,
        "D1: named shell output occupies leftover pixels above the composer");
      assert.equal(watch.leftoverOpeningOnLeftover, true,
        "D1: leftover-owned pixels include opening prose occupying leftover");
      assert.equal(watch.leftoverClosingOnLeftover, true,
        "D1: leftover-owned pixels include closing prose occupying leftover");
      assert.match(watch.leftoverOpeningText || "", /I'll stop that process now/,
        "D1: leftover-owned opening is the screenshot opening prose");
      assert.match(watch.leftoverClosingText || "", /Port 7777 is free/,
        "D1: leftover-owned closing is the screenshot closing prose");
      assert.equal(watch.leftoverUserOnLeftover, false,
        "D1: user is off leftover");
      assert.ok(watch.leftover === watch.leftoverComposerTop - watch.leftoverTop,
        "D1: leftover bounds are production leftover = composer.top − leftover.top");
      assert.equal(watch.leftover, watch.leftoverClientHeight,
        "D1: leftover occupancy of leftover is leftover.clientHeight leftover viewport");
      assert.notEqual(watch.leftover, 560,
        "D1: leftover is not a hardcoded 0–560 leftover box");
      assert.ok(watch.leftover > watch.leftoverOwned,
        "D1: leftover occupancy of leftover-owned content is not leftover occupancy of leftover");
      assert.ok(watch.leftoverAir === watch.leftover - watch.leftoverOwned,
        "D1: leftoverAir is leftover − leftoverOwned of leftover leftover viewport");
      assert.ok(watch.leftoverAir > 8,
        "D1: BAR leftover has leftover air under closing; leftoverAir ≤ 8 is leftover occupancy of leftover-owned");
      assert.equal(watch.leftoverSnapIsStale, false,
        "D1: production leftoverSnapIsStale does not treat G1 tool-then-prose as after-growth");
      const g1Asst = (watch.events || []).filter((e) => e.type === "assistant");
      assert.ok(g1Asst.some((e) => (e.toolCalls || []).some((t) => t.name === "Bash")),
        "D1: real G1 fixture has named Bash/shell output, not a tool-less stub");
      assert.ok(/Port 7777 is free/.test((g1Asst[g1Asst.length - 1] || {}).text || ""),
        "D1: real G1 fixture has closing prose after the named shell output");
      assert.doesNotMatch(watch.activityHtml, /shimmer/,
        "D1: idle G1 activityHtml does not shimmer inside QUIET_MS");
      assert.doesNotMatch(watch.activityHtml, /Planning next moves/,
        "D1: idle G1 does not emit Planning next moves under an idle chip");
      assert.equal(watch.continueFormHidden, false,
        "D1: idle G1 paints the visible Send a follow-up composer");
      assert.equal(watch.continuePlaceholder, "Send a follow-up");
    });

    test("D1: dashboard and chat-page #appLive agree with _runs and rail filter", () => {
      const g1 = {
        path: "/tmp/g1-idle.jsonl",
        id: "g1-idle",
        source: "grok",
        project: "sample-app",
        prompt: "Send a follow-up",
        live: false,
        mtime: Date.now(),
      };
      const g2 = {
        ...g1,
        path: "/tmp/g2-gen.jsonl",
        id: "g2-gen",
        prompt: "generating now",
        live: true,
        activity: "Working",
      };
      const exited = {
        id: "@done",
        status: "exited",
        sessionPath: g2.path,
        agent: "grok",
        cwd: "/tmp/sample-app",
        startedAt: new Date().toISOString(),
        prompt: "was generating",
      };
      const linked = {
        sessions: [g1, g2],
        liveSessions: [g2],
        runs: [exited],
        total: 2,
        stats: { totalSessions: 2 },
      };

      const dashLinked = renderDashboardListFromEmbed(linked);
      assertSnapshotLiveCount(dashLinked, 1, "exited-run-linked G2: dashboard #appLive is 1");
      const railLinked = assertChatRailFromEmbed(linked, 1, "exited-run-linked G2: chat #appLive is 1");
      assert.equal(dashLinked.liveN, 1);
      assert.doesNotMatch(
        railLinked.html,
        /href="\/run\?session=g2-gen"[^>]*><span class="rail-glyph" data-status="running"/,
        "rail list still absorbs G2 into the exited run row",
      );
      assert.match(
        railLinked.html,
        /href="\/run\?id=%40done"[^>]*><span class="rail-glyph" data-status="done"/,
        "exited run stays a done rail row",
      );

      const filtered = { ...linked, railExpr: "source:claude" };
      const dashFiltered = renderDashboardListFromEmbed(filtered);
      assertSnapshotLiveCount(dashFiltered, 1, "rail expr does not change dashboard liveNow");
      const railFiltered = assertChatRailFromEmbed(filtered, 1, "source:claude vs grok G2: chat #appLive stays 1");
      assert.equal(dashFiltered.liveN, 1);
      assert.match(railFiltered.appLive.textContent, /1 running/);
      assert.doesNotMatch(railFiltered.appLive.textContent, /\d+ live\b/);
      assert.doesNotMatch(
        railFiltered.html,
        /data-status="running"/,
        "rail list filter stays local: grok G2 is not a visible running row",
      );

      const runningLinked = {
        ...linked,
        runs: [{ ...exited, id: "@1", status: "running" }],
      };
      assertSnapshotLiveCount(
        renderDashboardListFromEmbed(runningLinked),
        1,
        "generating launched run + own G2 still 1 (deduped)",
      );
      const railGen = assertChatRailFromEmbed(runningLinked, 1, "generating launched run + own G2 still 1 (deduped)");
      assert.match(
        railGen.html,
        /href="\/run\?id=%401"[^>]*><span class="rail-glyph" data-status="running"/,
        "generating launched rail glyph is running",
      );

      const idleLaunched = {
        sessions: [g1],
        liveSessions: [],
        runs: [{
          id: "@idle",
          status: "idle",
          sessionPath: g1.path,
          agent: "grok",
          cwd: "/tmp/sample-app",
          startedAt: new Date().toISOString(),
          prompt: "Send a follow-up",
        }],
        total: 1,
        stats: { totalSessions: 1 },
      };
      const dashIdle = renderDashboardListFromEmbed(idleLaunched);
      assertSnapshotLiveCount(dashIdle, 0, "idle launched window: dashboard #appLive is 0");
      assert.match(
        dashIdle.html,
        /data-run-id="@idle"[\s\S]*class="run-state-badge" data-status="idle">idle/,
        "idle launched dashboard badge is idle, not running",
      );
      assert.doesNotMatch(
        dashIdle.html,
        /class="run-state-badge" data-status="running">running/,
        "idle launched window does not paint run-state-badge running",
      );
      const railIdle = assertChatRailFromEmbed(idleLaunched, 0, "idle launched window: chat #appLive is 0");
      assert.match(
        railIdle.html,
        /href="\/run\?id=%40idle"[^>]*><span class="rail-glyph" data-status="idle"/,
        "idle launched rail glyph is idle",
      );
      assert.doesNotMatch(
        railIdle.html,
        /data-status="running"/,
        "idle launched window is not a running rail glyph",
      );
    });
  });
});
