/**
 * A failed process probe is not evidence that nothing is running (fact 3w6).
 *
 * pgrep is spawned with a 2s cap. On a loaded machine that cap is routinely
 * missed, and a killed pgrep exits with a null status and no stdout — which
 * reads exactly like "matched nothing". Flattening the two made every running
 * agent blink out of the dashboard and back again on the next poll.
 */
import "../helpers/skip-lr-watch-env.js";
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  detectLiveSessions,
  clearLiveSessionsCache,
  setFindLiveClaudeDepsForTests,
  liveProbeDegradedForTests,
} from "../../src/sessions/live-sessions.js";

let tmpHome;
let recording;

/** A claude recording in the project dir matching `cwd`, left mid-turn so it reads generating. */
function seedGeneratingRecording(home, cwd) {
  const slug = cwd.replace(/\//g, "-");
  const projDir = path.join(home, ".claude", "projects", slug);
  fs.mkdirSync(projDir, { recursive: true });
  const file = path.join(projDir, "live.jsonl");
  fs.writeFileSync(
    file,
    JSON.stringify({
      type: "user",
      cwd,
      message: { content: [{ type: "text", text: "do the thing" }] },
    }) + "\n",
  );
  return file;
}

/** spawnSync stub: `mode` picks whether pgrep answers, matches nothing, or times out. */
function spawnStub(mode, pid = "4242") {
  return () => {
    if (mode === "match") return { status: 0, stdout: `${pid}\n` };
    if (mode === "empty") return { status: 1, stdout: "" };
    // A killed probe: this is the shape spawnSync returns on timeout.
    return { status: null, stdout: "", error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) };
  };
}

function depsFor(mode, cwd, pid = "4242") {
  return {
    spawnSync: spawnStub(mode, pid),
    platform: "linux",
    readdirSync: fs.readdirSync,
    statSync: fs.statSync,
    readlinkSync: () => cwd,
    procCwds: new Map([[pid, cwd]]),
  };
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tq-degraded-"));
  process.env.HOME = tmpHome;
  clearLiveSessionsCache();
});

afterEach(() => {
  setFindLiveClaudeDepsForTests(null);
  clearLiveSessionsCache();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("degraded process probes", () => {
  test("a timed-out probe is recorded as degraded, a clean miss is not", () => {
    setFindLiveClaudeDepsForTests(depsFor("empty", "/w/proj"));
    detectLiveSessions([]);
    assert.equal(liveProbeDegradedForTests(), false, "pgrep exit 1 is an honest negative");

    clearLiveSessionsCache();
    setFindLiveClaudeDepsForTests(depsFor("timeout", "/w/proj"));
    detectLiveSessions([]);
    assert.equal(liveProbeDegradedForTests(), true, "a killed pgrep is inconclusive");
  });

  test("a clean pass that matches nothing reports nothing live", () => {
    setFindLiveClaudeDepsForTests(depsFor("empty", "/w/proj"));
    const live = detectLiveSessions([]);
    assert.deepEqual(live, [], "an honest negative still means nothing is running");
  });

  test("a degraded pass keeps the previous live set instead of collapsing to empty", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tq-cwd-"));
    try {
      recording = seedGeneratingRecording(tmpHome, cwd);

      setFindLiveClaudeDepsForTests(depsFor("match", cwd));
      const first = detectLiveSessions([]);
      assert.ok(first.includes(recording), `clean pass should see ${recording}, got ${JSON.stringify(first)}`);

      // Same situation, but now every probe times out.
      clearLiveSessionsCacheKeepingHistory();
      setFindLiveClaudeDepsForTests(depsFor("timeout", cwd));
      const second = detectLiveSessions([]);
      assert.ok(
        second.includes(recording),
        "a timed-out probe must not blink the running session out of the list",
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a carried-forward path whose recording is gone is dropped", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tq-cwd2-"));
    try {
      recording = seedGeneratingRecording(tmpHome, cwd);
      setFindLiveClaudeDepsForTests(depsFor("match", cwd));
      assert.ok(detectLiveSessions([]).includes(recording));

      fs.rmSync(recording);
      clearLiveSessionsCacheKeepingHistory();
      setFindLiveClaudeDepsForTests(depsFor("timeout", cwd));
      const after = detectLiveSessions([]);
      assert.ok(
        !after.includes(recording),
        "a deleted recording must not be resurrected by a degraded pass",
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a later clean pass replaces the carried-forward set", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tq-cwd3-"));
    try {
      recording = seedGeneratingRecording(tmpHome, cwd);
      setFindLiveClaudeDepsForTests(depsFor("match", cwd));
      assert.ok(detectLiveSessions([]).includes(recording));

      clearLiveSessionsCacheKeepingHistory();
      setFindLiveClaudeDepsForTests(depsFor("timeout", cwd));
      assert.ok(detectLiveSessions([]).includes(recording), "carried forward while degraded");

      clearLiveSessionsCacheKeepingHistory();
      setFindLiveClaudeDepsForTests(depsFor("empty", cwd));
      assert.deepEqual(
        detectLiveSessions([]),
        [],
        "once a probe answers honestly, its answer wins",
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

/**
 * Expire the 5s memo without also forgetting the last clean result — which is
 * what a real poll two seconds later does.
 */
function clearLiveSessionsCacheKeepingHistory() {
  expireLiveMemoForTests();
}

import { expireLiveMemoForTests } from "../../src/sessions/live-sessions.js";

describe("carry-forward is gated on the recording, not just its existence", () => {
  test("a session that finished during a degraded pass is not carried forward", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tq-cwd4-"));
    try {
      const file = seedGeneratingRecording(tmpHome, cwd);
      setFindLiveClaudeDepsForTests(depsFor("match", cwd));
      assert.ok(detectLiveSessions([]).includes(file), "live while mid-turn");

      // The agent finishes: the transcript now ends on a completed assistant turn.
      fs.appendFileSync(
        file,
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "text", text: "done" }],
            stop_reason: "end_turn",
          },
        }) + "\n",
      );

      expireLiveMemoForTests();
      setFindLiveClaudeDepsForTests(depsFor("timeout", cwd));
      const after = detectLiveSessions([]);
      assert.ok(
        !after.includes(file),
        "a finished recording must not be kept live by a failing probe",
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
