import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeSession, STALL_MS } from "../../src/insights/analyze.js";

const T0 = Date.parse("2026-10-01T10:00:00.000Z");
const at = (min) => new Date(T0 + min * 60_000).toISOString();

let seq = 0;
function call(min, name, input) {
  const id = `c${++seq}`;
  return [{ type: "assistant", timestamp: at(min), text: "", toolCalls: [{ id, name, input }] }, id];
}
function result(min, id, text, isError = false) {
  return { type: "tool_result", timestamp: at(min), toolUseId: id, text, isError };
}

function session(events, cwd = "/home/u/worktrees/a_1/sample-app") {
  const stamped = events.filter((e) => e.timestamp);
  return { cwd, events, startTime: stamped[0].timestamp, endTime: stamped[stamped.length - 1].timestamp };
}

test("analyzeSession counts tool calls, errors by class, and a redacted example", () => {
  const [a1, id1] = call(0, "Bash", "cat /nope");
  const [a2, id2] = call(1, "Bash", "echo ok");
  const [a3, id3] = call(2, "Bash", "curl -H 'Authorization: Bearer abcdefghijklmnop12345678' https://x");
  const r = analyzeSession(session([
    { type: "user", timestamp: at(0), text: "go" },
    a1, result(0.1, id1, "Exit code 1\ncat: /nope: No such file or directory", true),
    a2, result(1.1, id2, "ok"),
    a3, result(2.1, id3, "Exit code 22\ntoken sk-proj-abcdefghijklmnopqrstuvwxyz012345 rejected: 401 Unauthorized", true),
  ]));
  assert.equal(r.calls, 3);
  assert.equal(r.errors, 2);
  assert.deepEqual(r.classes, { "missing-path": 1, "network-auth": 1 });
  assert.match(r.examples["missing-path"], /No such file/);
  assert.doesNotMatch(JSON.stringify(r), /sk-proj-abcdefghijklmnopqrstuvwxyz012345|abcdefghijklmnop12345678/);
});

test("analyzeSession sets suspect results apart from errors", () => {
  const [a1, id1] = call(0, "Read", "/home/u/worktrees/a_1/sample-app/a.md");
  const r = analyzeSession(session([a1, result(0.1, id1, "1→# notes about error handling", true)]));
  assert.equal(r.errors, 0);
  assert.equal(r.suspect, 1);
});

test("analyzeSession counts retries of a failed call and loops of a repeated call", () => {
  const events = [];
  const [a1, id1] = call(0, "Bash", "make build");
  events.push(a1, result(0.1, id1, "Exit code 2\nmake: *** No rule to make target 'build'", true));
  const [a2, id2] = call(1, "Bash", "make build");
  events.push(a2, result(1.1, id2, "Exit code 2\nmake: *** No rule to make target 'build'", true));
  for (let i = 0; i < 4; i++) {
    const [a, id] = call(2 + i, "Bash", "gh pr checks 7");
    events.push(a, result(2.1 + i, id, "pending"));
  }
  const r = analyzeSession(session(events));
  assert.equal(r.retries, 1);
  assert.equal(r.loops, 1);
  assert.equal(r.loopCalls, 4);
  assert.match(r.loopExample, /gh pr checks 7/);
  assert.equal(r.traps["wrong-folder"].count, 2);
});

test("analyzeSession separates agent stalls from a person being away", () => {
  const [a1, id1] = call(0, "Bash", "uv run pytest -q");
  const [a2, id2] = call(60, "Read", "/home/u/worktrees/a_1/sample-app/backend/service/x.py");
  const r = analyzeSession(session([
    { type: "user", timestamp: at(0), text: "run tests" },
    a1,
    result(12, id1, "Command timed out after 10m 0s", true),
    { type: "assistant", timestamp: at(12.1), text: "done", toolCalls: [] },
    { type: "user", timestamp: at(59), text: "now read it" },
    a2,
    result(75, id2, "contents"),
  ]));
  assert.equal(r.stalls, 1, "only the 12 min test run is the agent waiting");
  assert.equal(r.stallMs, 12 * 60_000);
  assert.match(r.longestStall.after, /pytest/);
  // The 47 min before the second prompt and the 15 min held read are idle.
  assert.equal(r.idleMs, (47 - 0.1 + 15) * 60_000);
  assert.equal(r.activeMs, r.durationMs - r.idleMs);
  assert.equal(r.traps["test-hang"].count, 1);
  assert.ok(STALL_MS === 5 * 60_000);
  assert.equal(r.area, "backend/service");
});

test("analyzeSession measures CI waiting between polls and flags path bleed", () => {
  const [a1, id1] = call(0, "Bash", "gh pr checks 9 --watch=false");
  const [a2, id2] = call(4, "Bash", "sleep 120; gh pr checks 9 --watch=false");
  const [a3, id3] = call(7, "Edit", "/home/u/worktrees/b_2/sample-app/backend/x.py");
  const [a4, id4] = call(8, "Bash", "cd /home/u/code/sample-app/sample-app && git status");
  const r = analyzeSession(session([
    a1, result(0.5, id1, "pending"),
    a2, result(6.5, id2, "pass"),
    a3, result(7.1, id3, "ok"),
    a4, result(8.1, id4, "clean"),
  ]));
  const ci = r.traps["ci-wait"];
  assert.equal(ci.count, 2);
  assert.equal(ci.sleepSec, 120);
  // 0.5 min first poll + 3.5 min until the next poll + 2.5 min inside it.
  assert.equal(ci.ms, 6.5 * 60_000);
  assert.equal(r.traps["path-bleed"].count, 2);
  assert.equal(r.traps["path-bleed"].writes, 1);
});

test("analyzeSession tolerates an empty or timestamp-free session", () => {
  const r = analyzeSession({ events: [{ type: "user", timestamp: null, text: "hi" }] });
  assert.equal(r.calls, 0);
  assert.equal(r.durationMs, 0);
  assert.equal(analyzeSession(null).errors, 0);
});

test("analyzeSession never counts a gap twice when events are logged out of order", () => {
  const [a1, id1] = call(0, "Bash", "make all");
  const [a2, id2] = call(2, "Bash", "make lint");
  const r = analyzeSession({
    cwd: "/r",
    events: [a1, result(20, id1, "ok"), a2, result(21, id2, "ok")],
  });
  assert.equal(r.durationMs, 21 * 60_000, "bounds fall back to the event span");
  assert.equal(r.stalls, 1);
  assert.equal(r.stallMs, 20 * 60_000);
  assert.ok(r.stallMs + r.idleMs <= r.durationMs);
});
