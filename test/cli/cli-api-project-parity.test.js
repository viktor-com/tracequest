import "../helpers/skip-lr-watch-env.js";
import { afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cmdFind,
  cmdLatest,
  cmdList,
  cmdSearch,
  setCliSessionFinderForTests,
} from "../../src/cli/cli-commands.js";
import { setColorEnabled } from "../../src/cli/cli-color.js";
import { findSessions as discoverSessions, buildIndex } from "../../src/sessions.js";
import { handleApiSessions } from "../../src/routes/route-handlers-api.js";
import { clearRouteCache } from "../../src/routes/route-cache.js";
import { clearLiveSessionsCache } from "../../src/sessions/live-sessions.js";
import { setInitialFilter } from "../../src/server/server-state.js";
import { captureJsonHandler } from "../helpers/capture-json-handler.js";

// ---------------------------------------------------------------------------
// Regression test for the project-normalisation disagreement.
//
// `/api/sessions` normalises `project` with `normalizeProjectFolder` (via
// sessionToApiObject), while the CLI's list / find / latest / search printers
// used `projectLabel`. `projectLabel` only strips a `-code-` suffix or a
// `-home-<user>-` prefix, so an ABSOLUTE project path (the shape a Grok
// workspace directory produces) falls through UNCHANGED -- meaning the two
// surfaces printed DIFFERENT strings for the SAME record.
//
// Every assertion below compares the CLI's rendered project string against the
// string `/api/sessions` actually returned for the same session object. Nothing
// is hardcoded on the parity side: both halves are driven for real and the two
// observed strings are compared.
// ---------------------------------------------------------------------------

const ABS_PROJECT = "/srv/tq-parity/deploy-tools";

/** Discovery rows covering the defect case plus two already-correct controls. */
const CASES = [
  {
    name: "absolute project path (Grok workspace shape)",
    project: ABS_PROJECT,
    control: false,
  },
  {
    name: "plain project slug (control: must stay unchanged)",
    project: "handoff-filter-include",
    control: "handoff-filter-include",
  },
  {
    name: "claude workspace slug (control: must stay unchanged)",
    project: "ws-home-dev-code-tracequest",
    control: "tracequest",
  },
];

function fakeSession(project) {
  return {
    path: `/tmp/tq-project-parity/${encodeURIComponent(project)}.jsonl`,
    project,
    file: "parity-session.jsonl",
    size: 8192,
    mtime: new Date(1750000000000),
    source: "claude",
  };
}

function fakeIndex(session) {
  return new Map([[session.path, {
    firstPrompt: "project parity fixture prompt",
    model: "claude-sonnet-4-6",
    tools: [],
    toolCounts: {},
    chapters: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    durationMs: 0,
    errors: 0,
    files: 0,
    commits: 0,
  }]]);
}

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
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

function runCli(fn) {
  const result = captureExitWithStreams(fn);
  assert.equal(result.error, null, result.error && result.error.stack);
  assert.equal(result.code, 0);
  return result;
}

/**
 * Pull the rendered project column out of a CLI table row.
 * Both table layouts put the session path last and the project column directly
 * before it, separated by 2+ spaces:
 *   list/find/latest: date  source  hash  sizeKB  project  path
 *   search:           date  source  hash  project  path
 */
function projectColumnFor(stdout, sessionPath) {
  const line = stripAnsi(stdout)
    .split("\n")
    .find((l) => l.includes(sessionPath) && l.includes("  "));
  assert.ok(line, `no table row for ${sessionPath} in: ${JSON.stringify(stdout)}`);
  const cols = line.trim().split(/\s{2,}/);
  assert.ok(cols.length >= 3, `unexpected row layout: ${JSON.stringify(line)}`);
  return cols[cols.length - 2];
}

/** Drive the real /api/sessions handler and return its rendered session objects. */
async function apiSessions(deps) {
  clearRouteCache();
  clearLiveSessionsCache();
  const { res, parse } = captureJsonHandler();
  await handleApiSessions(
    {},
    res,
    new URL("http://localhost:7777/api/sessions?pageSize=200"),
    deps,
  );
  return parse().sessions;
}

before(() => setColorEnabled(false));

afterEach(() => {
  setCliSessionFinderForTests(null);
  clearRouteCache();
  clearLiveSessionsCache();
  setInitialFilter(null);
});

describe("CLI and /api/sessions agree on the project label", () => {
  for (const c of CASES) {
    test(`list/find/latest match the API for ${c.name}`, async (t) => {
      const session = fakeSession(c.project);
      const index = fakeIndex(session);

      const apiRows = await apiSessions({
        findSessions: () => [session],
        buildIndex: () => index,
        peekSession: () => ({}),
      });
      assert.equal(apiRows.length, 1);
      const apiProject = apiRows[0].project;
      assert.ok(apiProject, "the API must return a project string to compare against");

      setCliSessionFinderForTests(() => [session]);

      const textCases = [
        ["list", () => cmdList([], {})],
        ["find", () => cmdFind([], {})],
        ["latest", () => cmdLatest([], { limit: "5" })],
      ];
      for (const [label, invoke] of textCases) {
        const { stdout } = runCli(invoke);
        assert.equal(
          projectColumnFor(stdout, session.path),
          apiProject,
          `${label} must print the same project string as /api/sessions`,
        );
      }

      const jsonCases = [
        ["list --json", () => cmdList([], { json: true })],
        ["find --json", () => cmdFind([], { json: true })],
      ];
      for (const [label, invoke] of jsonCases) {
        const { stdout } = runCli(invoke);
        const records = JSON.parse(stripAnsi(stdout));
        assert.equal(records.length, 1);
        assert.equal(
          records[0].project,
          apiProject,
          `${label} must emit the same project string as /api/sessions`,
        );
      }

      if (c.control) {
        // Control: an already-correct record must render exactly as it does
        // today -- unifying on normalizeProjectFolder must not move it.
        assert.equal(apiProject, c.control, "control label changed");
      } else {
        assert.notEqual(apiProject, c.project, "defect case must actually be normalised");
        assert.ok(!apiProject.includes("/"), `project must not stay a path, got ${apiProject}`);
      }
      t.diagnostic(`${c.project} -> ${apiProject}`);
    });
  }
});

// ---------------------------------------------------------------------------
// `search` runs over a real corpus (it builds an index from disk), so it gets a
// seeded Grok workspace whose directory name is a URL-encoded absolute path --
// the discovery row then carries `project: "/abs/path"` verbatim.
// ---------------------------------------------------------------------------

const SEARCH_NEEDLE = "parityneedle";

function seedGrokWorkspaceSession(home) {
  const wsDir = join(home, ".grok", "sessions", encodeURIComponent(ABS_PROJECT));
  const sessDir = join(wsDir, "parity-session");
  mkdirSync(sessDir, { recursive: true });
  writeFileSync(
    join(sessDir, "chat_history.jsonl"),
    [
      JSON.stringify({ type: "user", content: `${SEARCH_NEEDLE} in a grok workspace` }),
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

async function withCliHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "tq-cli-project-parity-"));
  const oldHome = process.env.HOME;
  const oldNoSidecar = process.env.TRACEQUEST_NO_SIDECAR;
  process.env.HOME = home;
  process.env.TRACEQUEST_NO_SIDECAR = "1";
  try {
    return await fn(home);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldNoSidecar === undefined) delete process.env.TRACEQUEST_NO_SIDECAR;
    else process.env.TRACEQUEST_NO_SIDECAR = oldNoSidecar;
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

describe("search matches /api/sessions on the project label", () => {
  test("search text and --json print the API's project string, not the absolute path", async () => {
    await withCliHome(async () => {
      const sessDir = seedGrokWorkspaceSession(process.env.HOME);

      const apiRows = await apiSessions({
        findSessions: (filter) => discoverSessions(filter),
        buildIndex: (sessions, opts) => buildIndex(sessions, opts),
      });
      const apiRow = apiRows.find((r) => r.path === sessDir);
      assert.ok(apiRow, `seeded session missing from /api/sessions: ${JSON.stringify(apiRows.map((r) => r.path))}`);
      assert.equal(apiRow.projectRaw, ABS_PROJECT, "fixture must carry an absolute project path");
      const apiProject = apiRow.project;

      const text = runCli(() => cmdSearch([SEARCH_NEEDLE], { limit: "5" }));
      assert.equal(
        projectColumnFor(text.stdout, sessDir),
        apiProject,
        "search text output must print the same project string as /api/sessions",
      );

      const json = runCli(() => cmdSearch([SEARCH_NEEDLE], { limit: "5", json: true }));
      const records = JSON.parse(stripAnsi(json.stdout));
      const record = records.find((r) => r.path === sessDir);
      assert.ok(record, `search --json missed the seeded session: ${json.stdout}`);
      assert.equal(
        record.project,
        apiProject,
        "search --json must emit the same project string as /api/sessions",
      );
    });
  });
});
