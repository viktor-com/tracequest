import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import {
  grokProcCwdMatches,
  findLiveGrok,
  findLiveClaude,
  findLiveByOpenFd,
  findLiveAgentSessions,
  agentPgrepInvocations,
  cursorProjectSlug,
  factoryWorkspaceSlug,
  detectLiveSessions,
  clearLiveSessionsCache,
  setFindLiveClaudeDepsForTests,
} from "../../src/sessions/live-sessions.js";
import {
  writeGrokGenerating,
  writeCursorGenerating,
  writeCursorIdle,
  writeFactoryGenerating,
  writeFactoryIdle,
  writeCodexGenerating,
  writeCodexIdle,
} from "../helpers/live-generating-fixtures.js";

const origHomeEnv = process.env.TRACEQUEST_LIVE_SESSIONS_HOME;
const LIVE_CACHE_TTL_MS = 5000;
/** Open-file detection is implemented for /proc (linux) and lsof (darwin) only. */
const OPEN_FD_SKIP = ["linux", "darwin"].includes(process.platform)
  ? false
  : "open-file probe unsupported on this platform";

/** Restore Date.now after tests that advance fake time. */
function withFakeNow(startMs, fn) {
  const realNow = Date.now;
  let t = startMs;
  Date.now = () => t;
  try {
    return fn(() => {
      t += 1;
    }, (ms) => {
      t += ms;
    });
  } finally {
    Date.now = realNow;
  }
}

afterEach(() => {
  if (origHomeEnv === undefined) delete process.env.TRACEQUEST_LIVE_SESSIONS_HOME;
  else process.env.TRACEQUEST_LIVE_SESSIONS_HOME = origHomeEnv;
  setFindLiveClaudeDepsForTests(null);
  clearLiveSessionsCache();
});

beforeEach(() => {
  clearLiveSessionsCache();
});

function liveSessionErrorCalls(spy, prefix) {
  return spy.mock.calls.filter((call) => String(call.arguments[0]).includes(prefix));
}

/** PID guaranteed dead after spawnSync returns (avoids flaky magic high PIDs). */
function deadPid() {
  const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  assert.equal(child.status, 0);
  return child.pid;
}

describe("live-sessions module", { concurrency: false }, () => {
describe("grokProcCwdMatches", () => {
  test("accepts exact cwd and deleted-directory suffix", () => {
    assert.equal(grokProcCwdMatches("/proj", "/proj"), true);
    assert.equal(grokProcCwdMatches("/proj", "/proj (deleted)"), true);
    assert.equal(grokProcCwdMatches("/proj", "/other"), false);
  });
});

describe("findLiveGrok", () => {
  test("live pid + cwd match is not live when the last turn is complete", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-grok-home-"));
    process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
    const cwd = process.cwd();
    const sessionId = "test-session-abc";
    const grokDir = path.join(home, ".grok");
    const sessionsDir = path.join(grokDir, "sessions", encodeURIComponent(cwd));
    const sessionDir = path.join(sessionsDir, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "events.jsonl"),
      JSON.stringify({ ts: "2026-08-26T12:08:17.984Z", type: "turn_ended", outcome: "completed" }) + "\n",
    );
    fs.writeFileSync(
      path.join(grokDir, "active_sessions.json"),
      JSON.stringify([{ session_id: sessionId, cwd, pid: process.pid }])
    );

    try {
      assert.deepEqual(findLiveGrok(), []);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("live pid + cwd match is live when events end on unmatched turn_started", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-grok-gen-"));
    process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
    const cwd = process.cwd();
    const sessionId = "test-session-gen";
    const grokDir = path.join(home, ".grok");
    const sessionsDir = path.join(grokDir, "sessions", encodeURIComponent(cwd));
    const sessionDir = path.join(sessionsDir, sessionId);
    writeGrokGenerating(sessionDir);
    fs.writeFileSync(
      path.join(grokDir, "active_sessions.json"),
      JSON.stringify([{ session_id: sessionId, cwd, pid: process.pid }])
    );

    try {
      assert.deepEqual(findLiveGrok(), [sessionDir]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("skips entries with dead pid (ENOENT on /proc cwd)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-grok-dead-"));
    process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
    const grokDir = path.join(home, ".grok");
    fs.mkdirSync(grokDir, { recursive: true });
    fs.writeFileSync(
      path.join(grokDir, "active_sessions.json"),
      JSON.stringify([{ session_id: "x", cwd: "/tmp", pid: deadPid() }])
    );

    try {
      assert.deepEqual(findLiveGrok(), []);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("does not log proc race ENOENT when pid vanished before /proc cwd read", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-grok-race-"));
    process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
    const grokDir = path.join(home, ".grok");
    fs.mkdirSync(grokDir, { recursive: true });
    fs.writeFileSync(
      path.join(grokDir, "active_sessions.json"),
      JSON.stringify([{ session_id: "gone", cwd: "/tmp", pid: deadPid() }])
    );
    const errorSpy = mock.method(console, "error", () => {});

    try {
      assert.deepEqual(findLiveGrok(), []);
      assert.equal(liveSessionErrorCalls(errorSpy, "findLiveGrok").length, 0);
    } finally {
      errorSpy.mock.restore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("does not log ENOENT when active_sessions.json is missing", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-grok-no-active-"));
    process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
    fs.mkdirSync(path.join(home, ".grok"), { recursive: true });
    const errorSpy = mock.method(console, "error", () => {});

    try {
      assert.deepEqual(findLiveGrok(), []);
      assert.equal(liveSessionErrorCalls(errorSpy, "findLiveGrok").length, 0);
    } finally {
      errorSpy.mock.restore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("returns empty array when active_sessions.json is missing or invalid", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-grok-bad-json-"));
    process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
    const grokDir = path.join(home, ".grok");
    fs.mkdirSync(grokDir, { recursive: true });
    fs.writeFileSync(path.join(grokDir, "active_sessions.json"), "{not json");
    const errorSpy = mock.method(console, "error", () => {});

    try {
      assert.deepEqual(findLiveGrok(), []);
      assert.equal(liveSessionErrorCalls(errorSpy, "findLiveGrok").length, 1);
      fs.rmSync(path.join(grokDir, "active_sessions.json"), { force: true });
      assert.deepEqual(findLiveGrok(), []);
      assert.equal(liveSessionErrorCalls(errorSpy, "findLiveGrok").length, 1);
    } finally {
      errorSpy.mock.restore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("skips live pid when recorded cwd does not match /proc cwd", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-grok-cwd-mismatch-"));
    process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
    const grokDir = path.join(home, ".grok");
    fs.mkdirSync(grokDir, { recursive: true });
    fs.writeFileSync(
      path.join(grokDir, "active_sessions.json"),
      JSON.stringify([{ session_id: "stale", cwd: "/definitely-not-this-cwd", pid: process.pid }])
    );

    try {
      assert.deepEqual(findLiveGrok(), []);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("skips entries missing session_id, cwd, or pid", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-grok-skip-"));
    process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
    const grokDir = path.join(home, ".grok");
    fs.mkdirSync(grokDir, { recursive: true });
    fs.writeFileSync(
      path.join(grokDir, "active_sessions.json"),
      JSON.stringify([
        { session_id: "a", cwd: "/tmp" },
        { session_id: "b", pid: process.pid },
        { cwd: "/tmp", pid: process.pid },
      ])
    );

    try {
      assert.deepEqual(findLiveGrok(), []);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("findLiveClaude", () => {
  test("returns an array without throwing when no claude processes match", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-claude-empty-"));
    process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
    setFindLiveClaudeDepsForTests({
      platform: "linux",
      spawnSync: () => ({ status: 1, stdout: "" }),
    });
    const errorSpy = mock.method(console, "error", () => {});

    try {
      const live = findLiveClaude();
      assert.ok(Array.isArray(live));
      assert.equal(liveSessionErrorCalls(errorSpy, "findLiveClaude").length, 0);
    } finally {
      errorSpy.mock.restore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("does not log ENOENT when claude cwd has no project dir yet", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-claude-no-proj-"));
    process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
    const cwd = "/tmp/tracequest-missing-claude-proj";
    setFindLiveClaudeDepsForTests({
      platform: "linux",
      spawnSync: () => ({ status: 0, stdout: "501\n" }),
      readlinkSync: (target) => {
        if (String(target) === "/proc/501/cwd") return cwd;
        return fs.readlinkSync(target);
      },
    });
    const errorSpy = mock.method(console, "error", () => {});

    try {
      assert.deepEqual(findLiveClaude(), []);
      assert.equal(liveSessionErrorCalls(errorSpy, "findLiveClaude").length, 0);
    } finally {
      errorSpy.mock.restore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("agentPgrepInvocations", () => {
  test("exact-name and anchored argv invocations, darwin prepends -a (BSD ancestor rule)", () => {
    assert.deepEqual(agentPgrepInvocations("droid", "linux"), [
      ["-x", "droid"],
      ["-f", "(^|/)droid($| )"],
    ]);
    assert.deepEqual(agentPgrepInvocations("cursor-agent", "darwin"), [
      ["-a", "-x", "cursor-agent"],
      ["-a", "-f", "(^|/)cursor-agent($| )"],
    ]);
  });

  test("slug helpers mirror the observed on-disk layouts", () => {
    assert.equal(cursorProjectSlug("/Users/dev/code/proj"), "Users-dev-code-proj");
    assert.equal(factoryWorkspaceSlug("/home/user/code/myproj"), "ws-home-user-code-myproj");
  });
});

describe("findLiveAgentSessions (per-agent process detection)", () => {
  /**
   * Injected probe layer: `procs` maps a pgrep needle (the -x binary or -f
   * pattern) to pids; readlinkSync answers /proc/<pid>/cwd from `cwds`.
   * platform "linux" keeps cwd resolution on the readlink path.
   */
  function injectProcs(procs, cwds) {
    setFindLiveClaudeDepsForTests({
      platform: "linux",
      spawnSync: (cmd, args) => {
        if (cmd !== "pgrep") return { status: 1, stdout: "" };
        const needle = args[args.length - 1];
        const pids = procs[needle];
        return pids?.length ? { status: 0, stdout: pids.join("\n") + "\n" } : { status: 1, stdout: "" };
      },
      readlinkSync: (target) => {
        const m = String(target).match(/^\/proc\/(\d+)\/cwd$/);
        if (m && cwds[m[1]]) return cwds[m[1]];
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });
  }

  test("a cursor-agent process maps to the newest cursor recording of its cwd", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-agent-cursor-"));
    process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
    const cwd = "/work/websh";
    const tDir = path.join(home, ".cursor", "projects", "work-websh", "agent-transcripts");
    const oldPath = path.join(tDir, "uuid-old", "uuid-old.jsonl");
    const newPath = path.join(tDir, "uuid-new", "uuid-new.jsonl");
    writeCursorGenerating(oldPath);
    writeCursorGenerating(newPath);
    const past = new Date(Date.now() - 3_600_000);
    fs.utimesSync(oldPath, past, past);
    injectProcs({ "(^|/)cursor-agent($| )": ["77"] }, { 77: cwd });

    try {
      assert.deepEqual(findLiveAgentSessions([]), [newPath]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("a droid process maps to the newest factory recording of its ws<slug> workspace", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-agent-factory-"));
    process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
    const cwd = "/work/api";
    const wsDir = path.join(home, ".factory", "sessions", "ws-work-api");
    fs.mkdirSync(wsDir, { recursive: true });
    const sessPath = path.join(wsDir, "run.jsonl");
    writeFactoryGenerating(sessPath);
    injectProcs({ droid: ["88"] }, { 88: cwd });

    try {
      assert.deepEqual(findLiveAgentSessions([]), [sessPath]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("a codex process maps to the session whose session_meta cwd equals the probed cwd exactly", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-agent-codex-"));
    process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-agent-codex-files-"));
    // Two directories with the SAME basename — the lossy project label
    // cannot tell them apart; only the exact session_meta cwd may decide.
    const cwdA = "/work/alpha/proj";
    const cwdB = "/work/beta/proj";
    const fileA = path.join(dir, "rollout-a.jsonl");
    const fileB = path.join(dir, "rollout-b.jsonl");
    writeCodexGenerating(fileA, cwdA);
    writeCodexGenerating(fileB, cwdB);
    const now = Date.now();
    const sessions = [
      { path: fileA, mtime: new Date(now - 1000), source: "codex", project: "proj" },
      { path: fileB, mtime: new Date(now), source: "codex", project: "proj" },
    ];
    injectProcs({ codex: ["99"] }, { 99: cwdA });

    try {
      assert.deepEqual(findLiveAgentSessions(sessions), [fileA]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an opencode process maps to the newest opencode:// session of its cwd's project label", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-agent-oc-"));
    process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
    const cwd = "/srv/ocwork";
    const now = Date.now();
    const { seedOpenCodeIndexDb } = await import("../helpers/opencode-db-fixtures.js");
    await seedOpenCodeIndexDb(home, [
      {
        id: "oc-old",
        directory: cwd,
        messages: [
          { id: "m-old-u", role: "user", parts: [{ type: "text", text: "old" }] },
          { id: "m-old-a", role: "assistant", parts: [{ type: "text", text: "done" }] },
        ],
      },
      {
        id: "oc-new",
        directory: cwd,
        messages: [
          { id: "m-new-u", role: "user", parts: [{ type: "text", text: "keep going" }] },
        ],
      },
    ]);
    const sessions = [
      { path: "opencode://oc-old", mtime: new Date(now - 5000), source: "opencode", project: "/srv/ocwork" },
      { path: "opencode://oc-new", mtime: new Date(now), source: "opencode", project: "/srv/ocwork" },
      { path: "opencode://oc-other", mtime: new Date(now), source: "opencode", project: "/srv/other" },
    ];
    injectProcs({ opencode: ["55"] }, { 55: cwd });

    try {
      assert.deepEqual(findLiveAgentSessions(sessions), ["opencode://oc-new"]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("a process whose cwd has no recording contributes nothing", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-agent-none-"));
    process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
    injectProcs(
      { codex: ["11"], droid: ["12"], opencode: ["13"], "(^|/)cursor-agent($| )": ["14"] },
      { 11: "/nowhere/a", 12: "/nowhere/b", 13: "/nowhere/c", 14: "/nowhere/d" },
    );

    try {
      assert.deepEqual(findLiveAgentSessions([]), []);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("pgrep failure degrades to empty without throwing", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-agent-fail-"));
    process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
    setFindLiveClaudeDepsForTests({
      platform: "linux",
      spawnSync: () => { throw new Error("spawn EPERM"); },
    });
    const errorSpy = mock.method(console, "error", () => {});

    try {
      assert.deepEqual(findLiveAgentSessions([]), []);
      assert.ok(liveSessionErrorCalls(errorSpy, "findLiveAgentSessions").length >= 1);
    } finally {
      errorSpy.mock.restore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("one pid matched by both the -x and -f invocations resolves its session once", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-agent-dedup-"));
    process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
    const cwd = "/work/dup";
    const wsDir = path.join(home, ".factory", "sessions", "ws-work-dup");
    fs.mkdirSync(wsDir, { recursive: true });
    const sessPath = path.join(wsDir, "run.jsonl");
    writeFactoryGenerating(sessPath);
    injectProcs({ droid: ["21"], "(^|/)droid($| )": ["21", "22"] }, { 21: cwd, 22: cwd });

    try {
      assert.deepEqual(findLiveAgentSessions([]), [sessPath]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("findLiveByOpenFd", () => {
  test("finds paths held open by this process via /proc fd scan", { skip: OPEN_FD_SKIP }, () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-live-fd-"));
    const filePath = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(filePath, "{}");
    const fd = fs.openSync(filePath, "r");

    try {
      const found = findLiveByOpenFd([filePath]);
      assert.ok(found.includes(filePath), `expected ${filePath} in ${JSON.stringify(found)}`);
    } finally {
      fs.closeSync(fd);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns empty array when no targets", () => {
    assert.deepEqual(findLiveByOpenFd([]), []);
  });

  test("does not log proc race errors while scanning /proc for absent targets", { skip: OPEN_FD_SKIP }, () => {
    const ghost = path.join(os.tmpdir(), `tq-live-ghost-${process.pid}-${Date.now()}.jsonl`);
    const errorSpy = mock.method(console, "error", () => {});

    try {
      assert.deepEqual(findLiveByOpenFd([ghost]), []);
      assert.deepEqual(errorSpy.mock.calls.map((c) => String(c.arguments[0])), []);
    } finally {
      errorSpy.mock.restore();
    }
  });

  test("stops scanning once every target path is matched", { skip: OPEN_FD_SKIP }, () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-live-fd-stop-"));
    const a = path.join(tmpDir, "a.jsonl");
    const b = path.join(tmpDir, "b.jsonl");
    fs.writeFileSync(a, "{}");
    fs.writeFileSync(b, "{}");
    const fdA = fs.openSync(a, "r");
    const fdB = fs.openSync(b, "r");

    try {
      const found = findLiveByOpenFd([a, b]);
      assert.ok(found.includes(a));
      assert.ok(found.includes(b));
    } finally {
      fs.closeSync(fdA);
      fs.closeSync(fdB);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("detectLiveSessions", () => {
  test("only scans codex/factory paths newer than 120s for open-fd detection", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-live-detect-"));
    const recentPath = path.join(tmpDir, "recent.jsonl");
    fs.writeFileSync(recentPath, "{}");
    const now = Date.now();
    const sessions = [
      { path: recentPath, mtime: new Date(now), source: "codex" },
      { path: path.join(tmpDir, "stale.jsonl"), mtime: new Date(now - 200_000), source: "codex" },
      { path: path.join(tmpDir, "claude.jsonl"), mtime: new Date(now), source: "claude" },
    ];

    try {
      const live = detectLiveSessions(sessions);
      assert.ok(Array.isArray(live));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("empty sessions list returns [] when live home has no grok/claude signals", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-detect-empty-"));
    process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;

    try {
      const live = detectLiveSessions([]);
      assert.ok(Array.isArray(live));
      assert.deepEqual(live, []);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("includes grok session path from temp active_sessions.json", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-detect-grok-"));
    process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
    const cwd = process.cwd();
    const sessionId = "detect-live-grok";
    const grokDir = path.join(home, ".grok");
    const sessionsDir = path.join(grokDir, "sessions", encodeURIComponent(cwd));
    const sessionDir = path.join(sessionsDir, sessionId);
    writeGrokGenerating(sessionDir);
    fs.writeFileSync(
      path.join(grokDir, "active_sessions.json"),
      JSON.stringify([{ session_id: sessionId, cwd, pid: process.pid }])
    );

    try {
      const live = detectLiveSessions([]);
      assert.deepEqual(live, [sessionDir]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("120s mtime boundary: inclusive at 120000ms, exclusive past threshold", {
    skip: OPEN_FD_SKIP,
  }, () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-detect-mtime-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-detect-mtime-home-"));
    process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
    const filePath = path.join(tmpDir, "boundary.jsonl");
    writeCodexGenerating(filePath, "/work/boundary");
    const fd = fs.openSync(filePath, "r");

    try {
      withFakeNow(6_000_000, () => {
        const now = Date.now();
        const atBoundary = [
          { path: filePath, mtime: new Date(now - 120_000), source: "codex" },
        ];
        const pastBoundary = [
          { path: filePath, mtime: new Date(now - 120_001), source: "codex" },
        ];

        clearLiveSessionsCache();
        const liveAt = detectLiveSessions(atBoundary);
        assert.ok(liveAt.includes(filePath), "exactly 120s old generating recording remains an fd candidate");

        clearLiveSessionsCache();
        const livePast = detectLiveSessions(pastBoundary);
        assert.ok(!livePast.includes(filePath), "older than 120s should skip fd scan");
      });
    } finally {
      fs.closeSync(fd);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("factory source generating recording is fd-scanned within 120s like codex", {
    skip: OPEN_FD_SKIP,
  }, () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-detect-factory-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-detect-factory-home-"));
    process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
    const filePath = path.join(tmpDir, "factory.jsonl");
    writeFactoryGenerating(filePath);
    const fd = fs.openSync(filePath, "r");
    const now = Date.now();

    try {
      const live = detectLiveSessions([
        { path: filePath, mtime: new Date(now), source: "factory" },
      ]);
      assert.ok(live.includes(filePath), "generating factory jsonl held open is mid-write recall");
    } finally {
      fs.closeSync(fd);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("factory source idle-open held-open fd is not live", {
    skip: OPEN_FD_SKIP,
  }, () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-detect-factory-idle-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-detect-factory-idle-home-"));
    process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
    const filePath = path.join(tmpDir, "factory-idle.jsonl");
    writeFactoryIdle(filePath);
    const fd = fs.openSync(filePath, "r");
    const now = Date.now();

    try {
      const live = detectLiveSessions([
        { path: filePath, mtime: new Date(now), source: "factory" },
      ]);
      assert.ok(!live.includes(filePath), "completed idle factory jsonl merely held open is not live");
    } finally {
      fs.closeSync(fd);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("codex/cursor idle-open held-open fd is not live", {
    skip: OPEN_FD_SKIP,
  }, () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-detect-idle-fd-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-detect-idle-fd-home-"));
    process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
    const codexPath = path.join(tmpDir, "codex-idle.jsonl");
    const cursorPath = path.join(tmpDir, "cursor-idle.jsonl");
    writeCodexIdle(codexPath, "/work/idle");
    writeCursorIdle(cursorPath);
    const fdCodex = fs.openSync(codexPath, "r");
    const fdCursor = fs.openSync(cursorPath, "r");
    const now = Date.now();

    try {
      const live = detectLiveSessions([
        { path: codexPath, mtime: new Date(now), source: "codex" },
        { path: cursorPath, mtime: new Date(now), source: "cursor" },
      ]);
      assert.ok(!live.includes(codexPath), "completed idle Codex jsonl merely held open is not live");
      assert.ok(!live.includes(cursorPath), "completed idle Cursor jsonl merely held open is not live");
    } finally {
      fs.closeSync(fdCodex);
      fs.closeSync(fdCursor);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("unions an agent-process detection (droid) into the live snapshot", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-detect-agent-"));
    process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
    const wsDir = path.join(home, ".factory", "sessions", "ws-work-live");
    fs.mkdirSync(wsDir, { recursive: true });
    const sessPath = path.join(wsDir, "run.jsonl");
    writeFactoryGenerating(sessPath);
    setFindLiveClaudeDepsForTests({
      platform: "linux",
      spawnSync: (cmd, args) => {
        if (cmd === "pgrep" && args[args.length - 1] === "droid") return { status: 0, stdout: "31\n" };
        return { status: 1, stdout: "" };
      },
      readlinkSync: (target) => {
        if (String(target) === "/proc/31/cwd") return "/work/live";
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });

    try {
      const live = detectLiveSessions([
        { path: sessPath, mtime: new Date(Date.now() - 900_000), source: "factory" },
      ]);
      assert.ok(live.includes(sessPath), "process-detected factory session is live despite stale mtime");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("cursor-cloud is never live: recent mtime plus a held-open fd still yields no live entry", {
    skip: OPEN_FD_SKIP,
  }, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-detect-cc-"));
    process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-detect-cc-files-"));
    const ccPath = path.join(tmpDir, "bc-agent.jsonl");
    fs.writeFileSync(ccPath, "{}");
    const fd = fs.openSync(ccPath, "r");

    try {
      const live = detectLiveSessions([
        { path: ccPath, mtime: new Date(), source: "cursor-cloud" },
      ]);
      assert.ok(!live.includes(ccPath), "a cloud agent has no local process — imported recordings never fake RUNNING");
    } finally {
      fs.closeSync(fd);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("unions grok session path and open-fd codex path in one snapshot", {
    skip: OPEN_FD_SKIP,
  }, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-detect-multi-"));
    process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
    const cwd = process.cwd();
    const sessionId = "multi-live";
    const grokDir = path.join(home, ".grok");
    const grokSessionsDir = path.join(grokDir, "sessions", encodeURIComponent(cwd));
    const grokPath = path.join(grokSessionsDir, sessionId);
    writeGrokGenerating(grokPath);
    fs.writeFileSync(
      path.join(grokDir, "active_sessions.json"),
      JSON.stringify([{ session_id: sessionId, cwd, pid: process.pid }])
    );

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-detect-multi-fd-"));
    const codexPath = path.join(tmpDir, "open.jsonl");
    writeCodexGenerating(codexPath, "/work/multi");
    const fd = fs.openSync(codexPath, "r");
    const now = Date.now();

    try {
      const live = detectLiveSessions([
        { path: codexPath, mtime: new Date(now), source: "codex" },
      ]);
      assert.equal(new Set(live).size, 2);
      assert.ok(live.includes(grokPath));
      assert.ok(live.includes(codexPath));
    } finally {
      fs.closeSync(fd);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

});

describe("detectLiveSessions cache TTL", () => {
  let cacheHome = null;

  beforeEach(() => {
    cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), "tq-live-cache-home-"));
    process.env.TRACEQUEST_LIVE_SESSIONS_HOME = cacheHome;
  });

  afterEach(() => {
    if (cacheHome) {
      fs.rmSync(cacheHome, { recursive: true, force: true });
      cacheHome = null;
    }
  });

  test("returns identical array reference on cache hit within TTL", () => {
    const first = detectLiveSessions([]);
    const second = detectLiveSessions([]);
    assert.strictEqual(first, second);
  });

  test("caches empty live set and reuses the same snapshot", () => {
    const a = detectLiveSessions([]);
    const b = detectLiveSessions([]);
    assert.deepEqual(a, []);
    assert.strictEqual(a, b);
  });

  test("ignores updated sessions argument while cache is warm", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-live-cache-warm-"));
    const filePath = path.join(tmpDir, "open.jsonl");
    fs.writeFileSync(filePath, "{}");
    const fd = fs.openSync(filePath, "r");
    const now = Date.now();
    const warm = [
      { path: filePath, mtime: new Date(now), source: "codex" },
    ];

    try {
      const first = detectLiveSessions(warm);
      const second = detectLiveSessions([
        { path: path.join(tmpDir, "other.jsonl"), mtime: new Date(now), source: "codex" },
      ]);
      assert.strictEqual(second, first);
    } finally {
      fs.closeSync(fd);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("clearLiveSessionsCache forces recomputation before TTL elapses", () => {
    const first = detectLiveSessions([]);
    clearLiveSessionsCache();
    const second = detectLiveSessions([]);
    assert.notStrictEqual(second, first);
    assert.deepEqual(second, first);
  });

  test("expires after 5000ms and returns a new array reference", () => {
    withFakeNow(1_000_000, (tick, advance) => {
      const first = detectLiveSessions([]);
      advance(LIVE_CACHE_TTL_MS);
      tick();
      const second = detectLiveSessions([]);
      assert.notStrictEqual(second, first);
      assert.deepEqual(second, first);
    });
  });

  test("boundary: still hits cache at TTL minus 1ms", () => {
    withFakeNow(2_000_000, (_tick, advance) => {
      const first = detectLiveSessions([]);
      advance(LIVE_CACHE_TTL_MS - 1);
      const second = detectLiveSessions([]);
      assert.strictEqual(second, first);
    });
  });

  test("boundary: misses cache at exactly TTL ms", () => {
    withFakeNow(3_000_000, (_tick, advance) => {
      const first = detectLiveSessions([]);
      advance(LIVE_CACHE_TTL_MS);
      const second = detectLiveSessions([]);
      assert.notStrictEqual(second, first);
    });
  });

  test("concurrent detectLiveSessions calls share one cached snapshot", async () => {
    const sessions = [];
    const results = await Promise.all(
      Array.from({ length: 24 }, () => Promise.resolve(detectLiveSessions(sessions)))
    );
    assert.ok(results.length >= 8);
    assert.ok(results.every((r) => r === results[0]));
  });

  test("grok active_sessions.json changes are not visible until cache expires", () => {
    const home = cacheHome;
    const cwd = process.cwd();
    const grokDir = path.join(home, ".grok");
    const sessionsDir = path.join(grokDir, "sessions", encodeURIComponent(cwd));
    const sessionA = "session-a";
    const sessionB = "session-b";
    writeGrokGenerating(path.join(sessionsDir, sessionA));
    writeGrokGenerating(path.join(sessionsDir, sessionB));
    const activePath = path.join(grokDir, "active_sessions.json");
    fs.writeFileSync(
      activePath,
      JSON.stringify([{ session_id: sessionA, cwd, pid: process.pid }])
    );

    withFakeNow(4_000_000, (_tick, advance) => {
      const first = detectLiveSessions([]);
      assert.deepEqual(first, [path.join(sessionsDir, sessionA)]);

      fs.writeFileSync(
        activePath,
        JSON.stringify([{ session_id: sessionB, cwd, pid: process.pid }])
      );
      const cached = detectLiveSessions([]);
      assert.strictEqual(cached, first);
      assert.deepEqual(cached, [path.join(sessionsDir, sessionA)]);

      advance(LIVE_CACHE_TTL_MS);
      const afterExpiry = detectLiveSessions([]);
      assert.notStrictEqual(afterExpiry, first);
      assert.deepEqual(afterExpiry, [path.join(sessionsDir, sessionB)]);
    });
  });

  test("open-fd live path drops only after cache expires when fd is closed", { skip: OPEN_FD_SKIP }, () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-live-cache-fd-"));
    const filePath = path.join(tmpDir, "held.jsonl");
    writeCodexGenerating(filePath, "/work/held");
    const fd = fs.openSync(filePath, "r");
    const now = Date.now();
    const sessions = [{ path: filePath, mtime: new Date(now), source: "codex" }];

    try {
      withFakeNow(5_000_000, (tick, advance) => {
        const whileOpen = detectLiveSessions(sessions);
        assert.ok(whileOpen.includes(filePath));

        fs.closeSync(fd);
        const stillCached = detectLiveSessions(sessions);
        assert.strictEqual(stillCached, whileOpen);
        assert.ok(stillCached.includes(filePath));

        advance(LIVE_CACHE_TTL_MS);
        tick();
        const afterExpiry = detectLiveSessions(sessions);
        assert.notStrictEqual(afterExpiry, whileOpen);
        assert.ok(!afterExpiry.includes(filePath));
      });
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed in test */
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

}); // live-sessions module (serial)