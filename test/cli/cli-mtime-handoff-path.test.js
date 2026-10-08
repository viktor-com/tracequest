import "../helpers/skip-lr-watch-env.js";
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cmdFind,
  cmdHandoff,
  cmdLatest,
  cmdList,
  setCliSessionFinderForTests,
} from "../../src/cli/cli-commands.js";

// ---------------------------------------------------------------------------
// Regression tests for two CLI defects:
//   1. `s.mtime.toISOString()` called raw in cmdList / cmdFind / cmdLatest --
//      throws `TypeError: s.mtime.toISOString is not a function` mid-output when
//      a discovery row carries an epoch-ms mtime (the shape the sidecar scan and
//      the search index both use). search's printers already use `new Date(...)`.
//   2. `handoff` printed `- Project: /abs/path` while its own header promises
//      "no absolute paths" (projectLabel passes absolute paths through
//      unchanged; normalizeProjectFolder reduces them to a folder name).
// ---------------------------------------------------------------------------

const EPOCH_MS = 1750000000000;
const EPOCH_DATE_TEXT = "2025-06-15 15:06"; // new Date(EPOCH_MS).toISOString() === 2025-06-15T15:06:40.000Z

function fakeSession(mtime) {
  return {
    path: "/tmp/tq-mtime-regression/epoch-session.jsonl",
    project: "mtime-regression",
    file: "epoch-session.jsonl",
    size: 4096,
    mtime,
    source: "claude",
  };
}

function captureExitWithStreams(fn) {
  const origExit = process.exit;
  const origStdoutWrite = process.stdout.write;
  const origStderrWrite = process.stderr.write;
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  let code;
  let error = null;
  const stdout = [];
  const stderr = [];
  process.exit = (c) => {
    code = c;
    throw new Error("process.exit");
  };
  process.stdout.write = (data) => { stdout.push(String(data)); return true; };
  process.stderr.write = (data) => { stderr.push(String(data)); return true; };
  console.log = (...a) => stdout.push(`${a.join(" ")}\n`);
  console.error = (...a) => stderr.push(`${a.join(" ")}\n`);
  console.warn = (...a) => stderr.push(`${a.join(" ")}\n`);
  try {
    fn();
  } catch (err) {
    if (err.message !== "process.exit") error = err;
  } finally {
    process.exit = origExit;
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
  }
  return { code, error, stdout: stdout.join(""), stderr: stderr.join("") };
}

/** Run a command over a single injected discovery row and assert it did not throw. */
function runOverSession(session, fn) {
  setCliSessionFinderForTests(() => [session]);
  const result = captureExitWithStreams(fn);
  assert.equal(
    result.error,
    null,
    `command threw instead of rendering the session: ${result.error && result.error.stack}`,
  );
  assert.equal(result.code, 0);
  return result;
}

const MTIME_CASES = [
  ["cmdList", () => cmdList([], {})],
  ["cmdList --json", () => cmdList([], { json: true })],
  ["cmdFind", () => cmdFind([], {})],
  ["cmdFind --json", () => cmdFind([], { json: true })],
  ["cmdLatest --limit 5", () => cmdLatest([], { limit: "5" })],
];

afterEach(() => {
  setCliSessionFinderForTests(null);
});

describe("CLI renders epoch-ms mtimes without throwing", () => {
  for (const [label, invoke] of MTIME_CASES) {
    test(`${label} formats an epoch-ms mtime as a date`, () => {
      const { stdout } = runOverSession(fakeSession(EPOCH_MS), invoke);
      assert.ok(
        stdout.includes(EPOCH_DATE_TEXT),
        `${label} should render ${EPOCH_DATE_TEXT} for an epoch-ms mtime, got: ${JSON.stringify(stdout)}`,
      );
    });
  }

  // Control: a real Date mtime (the shape the JS discovery walk produces) must
  // keep rendering exactly the same string -- the fix must not regress it.
  for (const [label, invoke] of MTIME_CASES) {
    test(`${label} still formats a Date mtime as the same date (control)`, () => {
      const { stdout } = runOverSession(fakeSession(new Date(EPOCH_MS)), invoke);
      assert.ok(
        stdout.includes(EPOCH_DATE_TEXT),
        `${label} should render ${EPOCH_DATE_TEXT} for a Date mtime, got: ${JSON.stringify(stdout)}`,
      );
    });
  }

  test("cmdList --json emits the epoch-ms date in the JSON record", () => {
    const { stdout } = runOverSession(fakeSession(EPOCH_MS), () => cmdList([], { json: true }));
    const records = JSON.parse(stdout);
    assert.equal(records.length, 1);
    assert.equal(records[0].date, EPOCH_DATE_TEXT);
  });
});

// ---------------------------------------------------------------------------
// handoff must not print absolute paths (its own header promises it doesn't).
// A Grok workspace directory is a URL-encoded absolute path, so its discovery
// row carries `project: "/abs/path"` verbatim.
// ---------------------------------------------------------------------------

const ABS_PROJECT = "/srv/handoff-abs/deploy-tools";

function seedGrokWorkspaceSession(home, prompt) {
  const wsDir = join(home, ".grok", "sessions", encodeURIComponent(ABS_PROJECT));
  const sessDir = join(wsDir, "handoff-abs-session");
  mkdirSync(sessDir, { recursive: true });
  writeFileSync(
    join(sessDir, "chat_history.jsonl"),
    [
      JSON.stringify({ type: "user", content: prompt }),
      JSON.stringify({ type: "assistant", content: "acknowledged" }),
    ].join("\n") + "\n",
  );
  writeFileSync(
    join(sessDir, "events.jsonl"),
    JSON.stringify({ type: "turn_started", ts: "2026-06-03T12:00:00Z", model_id: "grok-4" }) + "\n",
  );
  const t = Date.now() / 1000;
  utimesSync(join(sessDir, "chat_history.jsonl"), t, t);
  utimesSync(sessDir, t, t);
  return sessDir;
}

function withCliHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "tq-cli-handoff-abs-"));
  const oldHome = process.env.HOME;
  const oldNoSidecar = process.env.TRACEQUEST_NO_SIDECAR;
  process.env.HOME = home;
  process.env.TRACEQUEST_NO_SIDECAR = "1";
  try {
    return fn(home);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldNoSidecar === undefined) delete process.env.TRACEQUEST_NO_SIDECAR;
    else process.env.TRACEQUEST_NO_SIDECAR = oldNoSidecar;
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

describe("handoff output honours its no-absolute-paths promise", () => {
  test("handoff prints a folder label, not the absolute project path", () => {
    withCliHome((home) => {
      seedGrokWorkspaceSession(home, "handoff absolute project needle in a grok workspace");

      const { code, error, stdout } = captureExitWithStreams(() => {
        cmdHandoff(["handoff", "absolute", "project", "needle"], { limit: "5" });
      });

      assert.equal(error, null, error && error.stack);
      assert.equal(code, 0);
      assert.match(stdout, /^# TraceQuest Search Handoff\n/);
      assert.match(stdout, /- Results: 1/);
      assert.match(stdout, /no full transcripts or absolute paths/);
      assert.equal(
        stdout.includes(ABS_PROJECT),
        false,
        `handoff must not print the absolute project path, got: ${JSON.stringify(stdout)}`,
      );
      assert.equal(stdout.includes(home), false, "handoff must not print absolute session paths");
      assert.match(stdout, /- Project: `deploy-tools`/);
    });
  });
});
