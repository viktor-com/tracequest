import "../helpers/skip-lr-watch-env.js";
import { describe, test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureJsonHandler, mockHttpResponse } from "../helpers/capture-json-handler.js";
import {
  handleApiAgents,
  handleApiRuns,
  handleApiRunsInput,
  handleApiRunsKill,
  handleApiRunsSession,
  handleApiRunsSnapshot,
  clearRunSessionMemo,
  BODY_LIMIT_BYTES,
  INPUT_KEYS,
  PROMPT_LIMIT_BYTES,
} from "../../src/routes/route-handlers-launch.js";
import { ROUTE_MAP } from "../../src/routes.js";
import { handleRun } from "../../src/routes/route-handlers-pages.js";
import { runPage } from "../../src/browser/run-page.js";
import { sessionHash } from "../../src/sessions/session-hash.js";

const SESSION = `tq-route-${process.pid}`;
const savedSession = process.env.TRACEQUEST_TMUX_SESSION;
const savedBin = process.env.TRACEQUEST_TMUX_BIN;

before(() => {
  process.env.TRACEQUEST_TMUX_SESSION = SESSION;
});

after(() => {
  if (savedSession === undefined) delete process.env.TRACEQUEST_TMUX_SESSION;
  else process.env.TRACEQUEST_TMUX_SESSION = savedSession;
  if (savedBin === undefined) delete process.env.TRACEQUEST_TMUX_BIN;
  else process.env.TRACEQUEST_TMUX_BIN = savedBin;
});

describe("launch routes — GET /api/agents", () => {
  test("api/agents reports mux status and detected agents", async () => {
    const { res, parse, headers } = captureJsonHandler();
    const deps = {
      muxAvailable: () => true,
      detectAgents: () => [
        { id: "claude", binary: "claude" },
        { id: "opencode", binary: "opencode" },
      ],
    };
    await handleApiAgents(null, res, new URL("http://localhost/api/agents"), deps);
    assert.equal(headers["Content-Type"], "application/json; charset=utf-8");
    const data = parse();
    assert.deepEqual(data.mux, { available: true, session: SESSION });
    assert.deepEqual(data.agents, [
      { id: "claude", binary: "claude" },
      { id: "opencode", binary: "opencode" },
    ]);
  });

  test("api/agents answers 200 with mux.available false when tmux is absent", async () => {
    const res = mockHttpResponse();
    const deps = {
      muxAvailable: () => false,
      detectAgents: () => [{ id: "claude", binary: "claude" }],
    };
    await handleApiAgents(null, res, new URL("http://localhost/api/agents"), deps);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.mux.available, false);
    assert.equal(data.mux.session, SESSION);
    assert.deepEqual(data.agents, [{ id: "claude", binary: "claude" }]);
  });

  test("api/agents default deps run real detection and never throw without tmux", async () => {
    process.env.TRACEQUEST_TMUX_BIN = "/nonexistent-tracequest-tmux";
    try {
      const res = mockHttpResponse();
      await handleApiAgents(null, res, new URL("http://localhost/api/agents"));
      assert.equal(res.status, 200);
      const data = JSON.parse(res.body);
      assert.equal(data.mux.available, false);
      assert.equal(data.mux.session, SESSION);
      assert.ok(Array.isArray(data.agents));
      for (const agent of data.agents) {
        assert.equal(typeof agent.id, "string");
        assert.equal(typeof agent.binary, "string");
      }
    } finally {
      if (savedBin === undefined) delete process.env.TRACEQUEST_TMUX_BIN;
      else process.env.TRACEQUEST_TMUX_BIN = savedBin;
    }
  });

  test("/api/agents is registered in ROUTE_MAP with the launch handler", () => {
    assert.equal(ROUTE_MAP["/api/agents"], handleApiAgents);
    assert.equal(typeof ROUTE_MAP["/api/agents"], "function");
  });
});

/** Mock IncomingMessage: async-iterable body + method + headers. */
function mockReq({ method = "POST", host = "localhost:7777", body = "" } = {}) {
  const req = Readable.from(body.length ? [Buffer.from(body)] : []);
  req.method = method;
  req.headers = host === null ? {} : { host };
  return req;
}

/** Fake tmux/agent deps — guards must be provable with zero tmux calls. */
function fakeDeps(overrides = {}) {
  return {
    muxAvailable: () => true,
    detectAgents: () => [{ id: "claude", binary: "claude" }],
    resolveAgentBinary: mock.fn(() => "/stub/bin/claude"),
    ensureSession: mock.fn(() => "tq"),
    newWindow: mock.fn(() => "@7"),
    listWindows: mock.fn(() => []),
    linkRunSession: mock.fn(() => ({ path: null, link: "pending" })),
    // Tombstone I/O talks to tmux session options — stubbed so unit tests
    // never touch a real tmux server.
    readRunTombstones: mock.fn(() => []),
    recordRunTombstone: mock.fn(() => {}),
    detectLiveSessions: mock.fn(() => []),
    ...overrides,
  };
}

function validBody(extra = {}) {
  return JSON.stringify({ agent: "claude", cwd: tmpdir(), prompt: "hello", ...extra });
}

describe("launch routes — /api/runs guards", () => {
  const url = new URL("http://localhost/api/runs");

  test("mutating run endpoints reject non-POST methods with 405 and no side effects", async () => {
    for (const method of ["PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]) {
      const res = mockHttpResponse();
      const deps = fakeDeps();
      await handleApiRuns(mockReq({ method, body: validBody() }), res, url, deps);
      assert.equal(res.status, 405, `${method} must answer 405`);
      assert.match(JSON.parse(res.body).error, /method/i);
      assert.equal(deps.newWindow.mock.calls.length, 0, `${method} must not create a window`);
      assert.equal(deps.ensureSession.mock.calls.length, 0);
    }
  });

  test("GET /api/runs stays a plain GET route (never 405) and lists runs from tmux windows", async () => {
    const res = mockHttpResponse();
    const deps = fakeDeps({
      listWindows: mock.fn(() => [
        {
          id: "@1",
          name: "claude",
          dead: false,
          options: { tq_agent: "claude", tq_cwd: "/w", tq_started: "2026-08-10T00:00:00.000Z" },
        },
        {
          id: "@2",
          name: "manual-window",
          dead: false,
          options: { tq_agent: "", tq_cwd: "", tq_started: "" },
        },
        {
          id: "@3",
          name: "codex",
          dead: true,
          options: { tq_agent: "codex", tq_cwd: "/x", tq_started: "2026-08-10T01:00:00.000Z" },
        },
      ]),
      // The linked run carries its session path; the exited one never linked.
      linkRunSession: mock.fn((win) =>
        win.id === "@1"
          ? { path: "/w/.claude/projects/-w/s.jsonl", link: "linked", attribution: "pid" }
          : { path: null, link: "pending", attribution: null },
      ),
    });
    await handleApiRuns(mockReq({ method: "GET" }), res, url, deps);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.deepEqual(data.runs, [
      {
        id: "@1",
        agent: "claude",
        cwd: "/w",
        prompt: null,
        startedAt: "2026-08-10T00:00:00.000Z",
        status: "idle",
        resumedFrom: null,
        sessionPath: "/w/.claude/projects/-w/s.jsonl",
        link: "linked",
        attribution: "pid",
        state: "idle",
        // The recording does not exist on disk — activity degrades to null.
        activity: null,
      },
      {
        id: "@3",
        agent: "codex",
        cwd: "/x",
        prompt: null,
        startedAt: "2026-08-10T01:00:00.000Z",
        status: "exited",
        resumedFrom: null,
        sessionPath: null,
        link: "pending",
        attribution: null,
        state: "exited",
        activity: null,
      },
    ]);
    assert.equal(deps.newWindow.mock.calls.length, 0);
  });

  test("GET /api/runs surfaces tq_prompt and a live activity line from the linked recording", async () => {
    const res = mockHttpResponse();
    const deps = fakeDeps({
      listWindows: mock.fn(() => [
        {
          id: "@1",
          name: "claude",
          dead: false,
          options: {
            tq_agent: "claude",
            tq_cwd: "/w",
            tq_started: "2026-08-10T00:00:00.000Z",
            tq_prompt: "fix the docs agent",
          },
        },
      ]),
      linkRunSession: mock.fn(() => ({ path: "/rec/s.jsonl", link: "linked", attribution: "pid" })),
      statSync: mock.fn(() => ({ mtimeMs: 1000, size: 42 })),
      parseSession: mock.fn(() => ({
        events: [
          { type: "user", text: "fix the docs agent" },
          {
            type: "assistant",
            text: "Looking at the prompt definition.",
            // Unified sessions carry the summarized STRING input.
            toolCalls: [{ id: "t1", name: "Bash", input: "npm test" }],
          },
        ],
      })),
      buildSessionChapters: mock.fn(() => []),
    });
    clearRunSessionMemo();
    await handleApiRuns(mockReq({ method: "GET" }), res, url, deps);
    const run = JSON.parse(res.body).runs[0];
    assert.equal(run.prompt, "fix the docs agent");
    // The newest assistant turn has an unresolved tool call -> in-progress line.
    assert.equal(run.activity, "Running npm test");
    clearRunSessionMemo();
  });

  test("runActivityLine derives in-progress tool lines and outcome snippets", async () => {
    const { runActivityLine } = await import("../../src/routes/route-handlers-launch.js");
    const pendingTool = {
      events: [
        { type: "user", text: "go" },
        {
          type: "assistant",
          text: "Editing now.",
          toolCalls: [{ id: "t1", name: "Edit", input: "/a/b/docs.js" }],
        },
      ],
    };
    assert.equal(runActivityLine(pendingTool, false), "Editing docs.js");
    // A dead run never reads as in-progress — the outcome text wins.
    assert.equal(runActivityLine(pendingTool, true), "Editing now.");
    const resolved = {
      events: [
        {
          type: "assistant",
          toolCalls: [{ id: "t1", name: "Bash", input: "npm test" }],
        },
        { type: "tool_result", toolUseId: "t1" },
        { type: "assistant", text: "Done.\nAll   green." },
      ],
    };
    assert.equal(runActivityLine(resolved, false), "Done. All green.", "whitespace collapses to one line");
    assert.equal(runActivityLine({ events: [] }, false), null);
    assert.equal(runActivityLine(null, false), null);
    const longText = { events: [{ type: "assistant", text: "x".repeat(400) }] };
    assert.ok(runActivityLine(longText, false).length <= 140, "activity clips to a glanceable line");
  });

  test("liveSessionActivity is the SAME derivation for ANY session, keyed by path + source", async () => {
    const { liveSessionActivity, clearRunSessionMemo } =
      await import("../../src/routes/route-handlers-launch.js");
    clearRunSessionMemo();
    const parseSession = mock.fn(() => ({
      events: [
        { type: "user", text: "migrate the ledger" },
        {
          type: "assistant",
          text: "Mapping call sites.",
          toolCalls: [{ id: "c1", name: "Bash", input: "rg -n LedgerClientV1 src" }],
        },
      ],
    }));
    const deps = {
      statSync: mock.fn(() => ({ mtimeMs: 1000, size: 64 })),
      parseSession,
      buildSessionChapters: mock.fn(() => []),
    };
    // An external codex recording gets the identical in-progress line a
    // launched run's row derives — and its discovered source picks the parser.
    assert.equal(liveSessionActivity("/x/rollout.jsonl", "codex", deps), "Running rg -n LedgerClientV1 src");
    assert.equal(parseSession.mock.calls[0].arguments[1], "codex", "source reaches the parser");
    // Degrades to null exactly like a run's line: stat failure means no line.
    const failing = { ...deps, statSync: mock.fn(() => { throw new Error("gone"); }) };
    assert.equal(liveSessionActivity("/x/vanished.jsonl", "codex", failing), null);
    assert.equal(liveSessionActivity(null, "codex", deps), null);
    clearRunSessionMemo();
  });

  test("mutating run endpoints reject a non-localhost Host header with 403 and no tmux operation", async () => {
    for (const host of ["evil.com", "evil.com:7777", "tracequest.evil.com", "203.0.113.5:7777", null]) {
      const res = mockHttpResponse();
      const deps = fakeDeps();
      await handleApiRuns(mockReq({ host, body: validBody() }), res, url, deps);
      assert.equal(res.status, 403, `Host ${host} must answer 403`);
      assert.match(JSON.parse(res.body).error, /localhost/i);
      assert.equal(deps.newWindow.mock.calls.length, 0, `Host ${host} must not touch tmux`);
      assert.equal(deps.ensureSession.mock.calls.length, 0);
      assert.equal(deps.listWindows.mock.calls.length, 0);
    }
  });

  test("localhost Host variants pass the host guard (port ignored)", async () => {
    for (const host of ["localhost", "localhost:7777", "127.0.0.1:7777", "[::1]:7777"]) {
      const res = mockHttpResponse();
      const deps = fakeDeps();
      await handleApiRuns(mockReq({ host, body: validBody() }), res, url, deps);
      assert.equal(res.status, 200, `Host ${host} must be allowed`);
      assert.equal(deps.newWindow.mock.calls.length, 1);
    }
  });

  test("POST /api/runs rejects malformed JSON with 400 and no tmux operation", async () => {
    for (const body of ["{not json", "[]", '"a string"', ""]) {
      const res = mockHttpResponse();
      const deps = fakeDeps();
      await handleApiRuns(mockReq({ body }), res, url, deps);
      assert.equal(res.status, 400, `body ${JSON.stringify(body)} must answer 400`);
      assert.match(JSON.parse(res.body).error, /JSON/);
      assert.equal(deps.newWindow.mock.calls.length, 0);
    }
  });

  test("POST /api/runs rejects a body over the size cap with 413", async () => {
    const res = mockHttpResponse();
    const deps = fakeDeps();
    const huge = JSON.stringify({ agent: "claude", prompt: "x".repeat(BODY_LIMIT_BYTES + 1) });
    await handleApiRuns(mockReq({ body: huge }), res, url, deps);
    assert.equal(res.status, 413);
    assert.equal(deps.newWindow.mock.calls.length, 0);
  });

  test("POST /api/runs rejects an unknown or undetected agent with 400", async () => {
    for (const agent of ["not-an-agent", "codex", 42, null, undefined]) {
      const res = mockHttpResponse();
      const deps = fakeDeps(); // detects only "claude"
      await handleApiRuns(mockReq({ body: validBody({ agent }) }), res, url, deps);
      assert.equal(res.status, 400, `agent ${String(agent)} must answer 400`);
      assert.match(JSON.parse(res.body).error, /agent/);
      assert.equal(deps.newWindow.mock.calls.length, 0, "no window for a rejected agent");
    }
  });

  test("POST /api/runs rejects a cwd that is not an existing directory with 400", async () => {
    const badCwds = ["/nonexistent-tracequest-dir", 42, null, undefined, `${tmpdir()}/no-such-sub/dir`];
    for (const cwd of badCwds) {
      const res = mockHttpResponse();
      const deps = fakeDeps();
      await handleApiRuns(mockReq({ body: validBody({ cwd }) }), res, url, deps);
      assert.equal(res.status, 400, `cwd ${String(cwd)} must answer 400`);
      assert.match(JSON.parse(res.body).error, /cwd/);
      assert.equal(deps.newWindow.mock.calls.length, 0, "no window for a rejected cwd");
    }
  });

  test("POST /api/runs answers 503 when the multiplexer is unavailable", async () => {
    const res = mockHttpResponse();
    const deps = fakeDeps({ muxAvailable: () => false });
    await handleApiRuns(mockReq({ body: validBody() }), res, url, deps);
    assert.equal(res.status, 503);
    assert.equal(deps.newWindow.mock.calls.length, 0);
  });

  test("POST /api/runs launches the resolved absolute binary with @tq_* metadata and answers the window id", async () => {
    const res = mockHttpResponse();
    const deps = fakeDeps();
    await handleApiRuns(mockReq({ body: validBody() }), res, url, deps);
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { id: "@7" });
    assert.equal(deps.ensureSession.mock.calls.length, 1);
    assert.equal(deps.newWindow.mock.calls.length, 1);
    const call = deps.newWindow.mock.calls[0].arguments[0];
    assert.equal(call.argv[0], "/stub/bin/claude", "argv[0] must be the ABSOLUTE resolved binary");
    // Spawn-time identity: claude accepts --session-id, so the launcher
    // generates a uuid, hands it to the agent, and persists it as
    // @tq_session_id — attribution is determined before the first byte.
    assert.equal(call.argv[1], "--session-id");
    const uuid = call.argv[2];
    assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "a fresh v4 uuid");
    assert.deepEqual(
      call.argv.slice(3),
      ["--", "hello"],
      'prompt travels as one discrete argv element behind an end-of-options "--"',
    );
    assert.equal(call.cwd, tmpdir());
    assert.equal(call.userOptions.tq_agent, "claude");
    assert.equal(call.userOptions.tq_cwd, tmpdir());
    assert.equal(call.userOptions.tq_session_id, uuid, "the SAME uuid handed to the agent is persisted");
    assert.ok(!Number.isNaN(Date.parse(call.userOptions.tq_started)), "tq_started is an ISO time");
    assert.equal(call.userOptions.tq_prompt, "hello", "prompt is stored for run-row identity");
  });

  test("POST /api/runs for an agent without a session-id flag passes no uuid and stores no tq_session_id", async () => {
    const res = mockHttpResponse();
    const deps = fakeDeps({
      detectAgents: () => [{ id: "codex", binary: "codex" }],
      resolveAgentBinary: mock.fn(() => "/stub/bin/codex"),
    });
    await handleApiRuns(mockReq({ body: validBody({ agent: "codex" }) }), res, url, deps);
    assert.equal(res.status, 200);
    const call = deps.newWindow.mock.calls[0].arguments[0];
    assert.deepEqual(call.argv, ["/stub/bin/codex", "--", "hello"], "no --session-id for codex");
    assert.ok(!("tq_session_id" in call.userOptions), "no tq_session_id without a spawn identity");
  });

  test("each POST /api/runs mints a FRESH uuid — two runs can never share a session identity", async () => {
    const uuids = [];
    for (let i = 0; i < 2; i++) {
      const res = mockHttpResponse();
      const deps = fakeDeps();
      await handleApiRuns(mockReq({ body: validBody() }), res, url, deps);
      uuids.push(deps.newWindow.mock.calls[0].arguments[0].userOptions.tq_session_id);
    }
    assert.ok(uuids[0] && uuids[1]);
    assert.notEqual(uuids[0], uuids[1]);
  });

  test("POST /api/runs stores tq_prompt as one clipped display line (newlines collapse)", async () => {
    const res = mockHttpResponse();
    const deps = fakeDeps();
    const prompt = `first line\nsecond\tline ${"y".repeat(300)}`;
    await handleApiRuns(mockReq({ body: validBody({ prompt }) }), res, url, deps);
    assert.equal(res.status, 200);
    const opts = deps.newWindow.mock.calls[0].arguments[0].userOptions;
    assert.match(opts.tq_prompt, /^first line second line y+…$/, "single line, clipped");
    assert.ok(opts.tq_prompt.length <= 140);
    // No prompt -> no tq_prompt option at all.
    const res2 = mockHttpResponse();
    const deps2 = fakeDeps();
    await handleApiRuns(mockReq({ body: JSON.stringify({ agent: "claude", cwd: tmpdir() }) }), res2, url, deps2);
    assert.ok(!("tq_prompt" in deps2.newWindow.mock.calls[0].arguments[0].userOptions));
  });

  test("POST /api/runs rejects a prompt over 8192 UTF-8 bytes with 400 JSON before any tmux call", async () => {
    // Bugbash F1: tmux respawn-window fails ("command too long") for prompt
    // argv over ~16.3KB while the 64KB body cap admits it — the prompt
    // byte-length cap must answer 400 before tmux is ever touched.
    const oversized = [
      "x".repeat(PROMPT_LIMIT_BYTES + 1), // 1 byte/char
      "€".repeat(3000), // 3 UTF-8 bytes/char = 9000 bytes, only 3000 chars
    ];
    for (const prompt of oversized) {
      const res = mockHttpResponse();
      const deps = fakeDeps();
      await handleApiRuns(mockReq({ body: validBody({ prompt }) }), res, url, deps);
      assert.equal(res.status, 400);
      assert.equal(JSON.parse(res.body).error, "prompt too long (max 8192 bytes)");
      assert.equal(deps.newWindow.mock.calls.length, 0, "no tmux call for an oversized prompt");
      assert.equal(deps.ensureSession.mock.calls.length, 0);
    }
    // At the limit the prompt is accepted.
    const res = mockHttpResponse();
    const deps = fakeDeps();
    await handleApiRuns(
      mockReq({ body: validBody({ prompt: "x".repeat(PROMPT_LIMIT_BYTES) }) }),
      res,
      url,
      deps,
    );
    assert.equal(res.status, 200);
  });

  test("POST /api/runs rejects NUL/control characters in prompt and cwd with 400 before any tmux call", async () => {
    // Bugbash F3: a NUL reaching execFileSync throws ERR_INVALID_ARG_VALUE
    // → plaintext 500. Any C0 control char except \n and \t is rejected.
    for (const prompt of ["a\u0000b", "a\u0007b", "a\rb", "a\u001b[31mb"]) {
      const res = mockHttpResponse();
      const deps = fakeDeps();
      await handleApiRuns(mockReq({ body: validBody({ prompt }) }), res, url, deps);
      assert.equal(res.status, 400, `prompt ${JSON.stringify(prompt)} must answer 400`);
      assert.match(JSON.parse(res.body).error, /prompt/);
      assert.equal(deps.newWindow.mock.calls.length, 0);
    }
    // \n and \t stay legal prompt characters.
    const okRes = mockHttpResponse();
    const okDeps = fakeDeps();
    await handleApiRuns(
      mockReq({ body: validBody({ prompt: "line one\n\tline two" }) }),
      okRes,
      url,
      okDeps,
    );
    assert.equal(okRes.status, 200);
    // NUL in cwd is rejected without ever reaching statSync/tmux.
    const cwdRes = mockHttpResponse();
    const cwdDeps = fakeDeps({ statSync: () => ({ isDirectory: () => true }) });
    await handleApiRuns(mockReq({ body: validBody({ cwd: `${tmpdir()}\u0000x` }) }), cwdRes, url, cwdDeps);
    assert.equal(cwdRes.status, 400);
    assert.match(JSON.parse(cwdRes.body).error, /cwd/);
    assert.equal(cwdDeps.newWindow.mock.calls.length, 0);
  });

  test("POST /api/runs answers 500 JSON — never plaintext — when the tmux spawn fails", async () => {
    const res = mockHttpResponse();
    const deps = fakeDeps({
      newWindow: mock.fn(() => {
        throw new Error("command too long");
      }),
    });
    await handleApiRuns(mockReq({ body: validBody() }), res, url, deps);
    assert.equal(res.status, 500);
    assert.match(res.headers["Content-Type"], /application\/json/);
    assert.match(JSON.parse(res.body).error, /command too long/);
  });

  test("/api/runs is registered in ROUTE_MAP with the method-dispatching handler", () => {
    assert.equal(ROUTE_MAP["/api/runs"], handleApiRuns);
  });
});

describe("launch routes — POST /api/runs resume mode (continue a session as a NEW run)", () => {
  const url = new URL("http://localhost/api/runs");
  const SRC_PATH = "/home/u/.claude/projects/-w/aaaaaaaa-1111-4222-8333-444455556666.jsonl";
  const SRC_HASH = sessionHash(SRC_PATH);
  const ORIG_ID = "aaaaaaaa-1111-4222-8333-444455556666";

  /** fakeDeps plus a resolvable source session + its parse. */
  function resumeDeps(overrides = {}) {
    return fakeDeps({
      findSessions: () => [{ path: SRC_PATH, source: "claude", project: "w" }],
      parseSession: mock.fn(() => ({ sessionId: ORIG_ID, cwd: tmpdir(), source: "claude" })),
      ...overrides,
    });
  }

  function resumeBody(extra = {}) {
    return JSON.stringify({ resumeSession: SRC_HASH, ...extra });
  }

  test("resume of an unknown session hash answers 404 JSON and never touches tmux", async () => {
    const res = mockHttpResponse();
    const deps = resumeDeps({ findSessions: () => [] });
    await handleApiRuns(mockReq({ body: resumeBody() }), res, url, deps);
    assert.equal(res.status, 404, `unknown session must answer 404 (got ${res.status}: ${res.body})`);
    assert.match(res.headers["Content-Type"], /application\/json/, "launch-style JSON error");
    assert.match(JSON.parse(res.body).error, /not found/i);
    assert.equal(deps.newWindow.mock.calls.length, 0);
    assert.equal(deps.ensureSession.mock.calls.length, 0);
  });

  test("resume of a non-session path answers 403 JSON", async () => {
    const res = mockHttpResponse();
    const deps = resumeDeps();
    await handleApiRuns(mockReq({ body: resumeBody({ resumeSession: "/etc/passwd" }) }), res, url, deps);
    assert.equal(res.status, 403);
    assert.match(JSON.parse(res.body).error, /not a session file/i);
    assert.equal(deps.newWindow.mock.calls.length, 0);
  });

  test("an empty or non-string resumeSession answers 400", async () => {
    for (const bad of ["", 42, null, {}]) {
      const res = mockHttpResponse();
      const deps = resumeDeps();
      await handleApiRuns(mockReq({ body: resumeBody({ resumeSession: bad }) }), res, url, deps);
      assert.equal(res.status, 400, `resumeSession ${JSON.stringify(bad)} must answer 400`);
      assert.match(JSON.parse(res.body).error, /resumeSession/);
      assert.equal(deps.newWindow.mock.calls.length, 0);
    }
  });

  test("an agent without a resume mechanism answers 400 naming the missing mechanism — before detection", async () => {
    // factory sessions map to droid, which has NO resume entry; the error
    // must name the mechanism even though droid is also undetected.
    const factoryPath = "/home/u/.factory/sessions/s-1.jsonl";
    const res = mockHttpResponse();
    const deps = resumeDeps({
      findSessions: () => [{ path: factoryPath, source: "factory", project: "w" }],
    });
    await handleApiRuns(
      mockReq({ body: JSON.stringify({ resumeSession: sessionHash(factoryPath) }) }),
      res,
      url,
      deps,
    );
    assert.equal(res.status, 400);
    assert.match(JSON.parse(res.body).error, /droid.*no resume mechanism/);
    assert.equal(deps.newWindow.mock.calls.length, 0);

    // Explicit agent override gets the same honest 400.
    const res2 = mockHttpResponse();
    const deps2 = resumeDeps();
    await handleApiRuns(mockReq({ body: resumeBody({ agent: "gemini" }) }), res2, url, deps2);
    assert.equal(res2.status, 400);
    assert.match(JSON.parse(res2.body).error, /gemini.*no resume mechanism/);
  });

  test("an UNINDEXED recording's source comes from its PATH, never the claude default (r7)", async () => {
    // The r6 residual: createResumedRun defaulted every path discovery had
    // not indexed to source "claude", so continuing a fresh .cursor
    // recording picked claude's resume mechanism (and 400'd on a claude
    // binary that never wrote it). sourceForSessionPath names the family.
    const home = fs.mkdtempSync(join(tmpdir(), "tq-resume-src-"));
    const prevHome = process.env.HOME;
    try {
      process.env.HOME = home;
      const uuid = "7c9a1b2d-5555-4000-8000-ffff00001111";
      const dir = join(home, ".cursor", "projects", "w-proj", "agent-transcripts", uuid);
      fs.mkdirSync(dir, { recursive: true });
      const path = join(dir, `${uuid}.jsonl`);
      fs.writeFileSync(path, '{"role":"user","message":{"content":[{"type":"text","text":"hi"}]}}\n');

      const res = mockHttpResponse();
      const deps = resumeDeps({
        // Not indexed yet — the fallback decides the source.
        findSessions: () => [],
        detectAgents: () => [{ id: "cursor-agent", binary: "cursor-agent" }],
        resolveAgentBinary: mock.fn(() => "/stub/bin/cursor-agent"),
        parseSession: mock.fn((_p, source) => ({ sessionId: uuid, cwd: tmpdir(), source })),
      });
      await handleApiRuns(mockReq({ body: JSON.stringify({ resumeSession: path }) }), res, url, deps);
      assert.equal(res.status, 200, `resume of an unindexed cursor recording must succeed: ${res.body}`);
      const argv = deps.newWindow.mock.calls[0].arguments[0].argv;
      assert.equal(argv[0], "/stub/bin/cursor-agent", "cursor-agent, not claude");
      assert.deepEqual(argv.slice(1, 3), ["--resume", uuid]);
      assert.equal(deps.parseSession.mock.calls[0].arguments[1], "cursor",
        "the source session is parsed in its own dialect");
    } finally {
      process.env.HOME = prevHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("a source with no mapped agent answers 400 naming the source", async () => {
    const ccPath = "/home/u/.local/share/tracequest/cursor-cloud/t-1.jsonl";
    const res = mockHttpResponse();
    const deps = resumeDeps({
      findSessions: () => [{ path: ccPath, source: "cursor-cloud", project: "w" }],
    });
    await handleApiRuns(
      mockReq({ body: JSON.stringify({ resumeSession: sessionHash(ccPath) }) }),
      res,
      url,
      deps,
    );
    assert.equal(res.status, 400);
    assert.match(JSON.parse(res.body).error, /cursor-cloud/);
    assert.equal(deps.newWindow.mock.calls.length, 0);
  });

  test("resume of an imported host session answers 400", async () => {
    const importedPath = "/tmp/hosts/gpu/.claude/projects/p/aaaaaaaa-1111-4222-8333-444455556666.jsonl";
    const res = mockHttpResponse();
    const deps = resumeDeps({
      findSessions: () => [{ path: importedPath, source: "claude", host: "gpu", project: "p" }],
    });
    await handleApiRuns(
      mockReq({ body: JSON.stringify({ resumeSession: sessionHash(importedPath) }) }),
      res,
      url,
      deps,
    );
    assert.equal(res.status, 400);
    assert.match(JSON.parse(res.body).error, /imported sessions cannot be continued/);
    assert.equal(deps.newWindow.mock.calls.length, 0);
  });

  test("a resume-capable agent that is not detected on PATH answers 400", async () => {
    const res = mockHttpResponse();
    const deps = resumeDeps({ detectAgents: () => [] });
    await handleApiRuns(mockReq({ body: resumeBody() }), res, url, deps);
    assert.equal(res.status, 400);
    assert.match(JSON.parse(res.body).error, /detected/);
    assert.equal(deps.newWindow.mock.calls.length, 0);
  });

  test("a source session exposing no sessionId answers 400 — nothing to hand the resume flag", async () => {
    const res = mockHttpResponse();
    const deps = resumeDeps({ parseSession: mock.fn(() => ({ sessionId: null, cwd: tmpdir() })) });
    await handleApiRuns(mockReq({ body: resumeBody() }), res, url, deps);
    assert.equal(res.status, 400);
    assert.match(JSON.parse(res.body).error, /session id/);
    assert.equal(deps.newWindow.mock.calls.length, 0);
  });

  test("claude resume: fork argv, fresh @tq_session_id, @tq_resumed_from provenance, cwd from the source session", async () => {
    const res = mockHttpResponse();
    const deps = resumeDeps();
    await handleApiRuns(mockReq({ body: resumeBody() }), res, url, deps);
    assert.equal(res.status, 200, `resume failed: ${res.body}`);
    assert.deepEqual(JSON.parse(res.body), { id: "@7", resumedFrom: SRC_HASH });
    assert.equal(deps.ensureSession.mock.calls.length, 1);
    const call = deps.newWindow.mock.calls[0].arguments[0];
    // Deterministic fork identity: --resume <orig> --fork-session
    // --session-id <freshUuid> — verified against claude --help.
    assert.equal(call.argv[0], "/stub/bin/claude", "absolute resolved binary");
    assert.deepEqual(call.argv.slice(1, 4), ["--resume", ORIG_ID, "--fork-session"]);
    assert.equal(call.argv[4], "--session-id");
    const fork = call.argv[5];
    assert.match(fork, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "a fresh uuid");
    assert.notEqual(fork, ORIG_ID, "the fork NEVER reuses the source session's uuid");
    assert.equal(call.cwd, tmpdir(), "cwd defaults to the source session's recorded cwd");
    assert.equal(call.userOptions.tq_agent, "claude");
    assert.equal(call.userOptions.tq_cwd, tmpdir());
    assert.equal(call.userOptions.tq_session_id, fork, "the fork uuid is persisted for tier-0 attribution");
    assert.equal(call.userOptions.tq_resumed_from, SRC_HASH, "provenance persisted in tmux");
    assert.ok(!Number.isNaN(Date.parse(call.userOptions.tq_started)));
  });

  test("an explicit cwd overrides the source session's cwd; a missing derivable cwd answers 400", async () => {
    const res = mockHttpResponse();
    const deps = resumeDeps({ parseSession: mock.fn(() => ({ sessionId: ORIG_ID, cwd: "/vanished-dir" })) });
    await handleApiRuns(mockReq({ body: resumeBody({ cwd: tmpdir() }) }), res, url, deps);
    assert.equal(res.status, 200, `explicit cwd must win: ${res.body}`);
    assert.equal(deps.newWindow.mock.calls[0].arguments[0].cwd, tmpdir());

    // No explicit cwd and the source's cwd does not exist → honest 400
    // carrying needs:"cwd" so UI surfaces can offer inline recovery.
    const res2 = mockHttpResponse();
    const deps2 = resumeDeps({ parseSession: mock.fn(() => ({ sessionId: ORIG_ID, cwd: "/vanished-dir" })) });
    await handleApiRuns(mockReq({ body: resumeBody() }), res2, url, deps2);
    assert.equal(res2.status, 400);
    const body2 = JSON.parse(res2.body);
    assert.match(body2.error, /cwd/);
    assert.equal(body2.needs, "cwd", "vanished-cwd 400 is machine-readable for inline recovery");
    assert.equal(deps2.newWindow.mock.calls.length, 0);

    // An explicit-but-invalid resume cwd carries the same recovery marker.
    const res3 = mockHttpResponse();
    const deps3 = resumeDeps({ parseSession: mock.fn(() => ({ sessionId: ORIG_ID, cwd: "/vanished-dir" })) });
    await handleApiRuns(mockReq({ body: resumeBody({ cwd: "/also-vanished" }) }), res3, url, deps3);
    assert.equal(res3.status, 400);
    assert.equal(JSON.parse(res3.body).needs, "cwd");
  });

  test("codex resume: subcommand argv, no spawn identity, provenance still persisted", async () => {
    const codexPath = "/home/u/.codex/sessions/2026/08/11/rollout-1.jsonl";
    const res = mockHttpResponse();
    const deps = resumeDeps({
      findSessions: () => [{ path: codexPath, source: "codex", project: "w" }],
      detectAgents: () => [{ id: "codex", binary: "codex", resume: true }],
      resolveAgentBinary: mock.fn(() => "/stub/bin/codex"),
      parseSession: mock.fn(() => ({ sessionId: "rollout-uuid-1", cwd: tmpdir() })),
    });
    await handleApiRuns(
      mockReq({ body: JSON.stringify({ resumeSession: sessionHash(codexPath), prompt: "carry on" }) }),
      res,
      url,
      deps,
    );
    assert.equal(res.status, 200, `codex resume failed: ${res.body}`);
    const call = deps.newWindow.mock.calls[0].arguments[0];
    assert.deepEqual(call.argv, ["/stub/bin/codex", "resume", "rollout-uuid-1", "--", "carry on"]);
    assert.ok(!("tq_session_id" in call.userOptions), "no spawn identity for codex — honest heuristic tiers");
    assert.equal(call.userOptions.tq_resumed_from, sessionHash(codexPath));
    assert.equal(call.userOptions.tq_prompt, "carry on");
  });

  test("resume mode persists the resolved source path and the source's first user message as attribution evidence", async () => {
    // @tq_resumed_path feeds the linker's source fallback (the resumed
    // agent may continue IN the source recording) and @tq_fork_prompt is
    // the resumed run's content identity (a fork recording opens with the
    // SOURCE conversation's first message, clipped like tq_prompt).
    const res = mockHttpResponse();
    const longFirst = "please refactor the session indexer ".repeat(8).trim(); // > 140 chars
    const deps = resumeDeps({
      peekSession: mock.fn(({ path, source }) => {
        assert.equal(path, SRC_PATH, "the SOURCE recording is peeked");
        assert.equal(source, "claude", "peeked in the source's own dialect");
        return { firstPrompt: longFirst };
      }),
    });
    await handleApiRuns(mockReq({ body: resumeBody() }), res, url, deps);
    assert.equal(res.status, 200, `resume failed: ${res.body}`);
    const opts = deps.newWindow.mock.calls[0].arguments[0].userOptions;
    assert.equal(opts.tq_resumed_path, SRC_PATH, "the source path is persisted for the linker's source fallback");
    assert.equal(opts.tq_fork_prompt.length, 140, "the fork prompt is clipped to one 140-char display line");
    assert.ok(opts.tq_fork_prompt.endsWith("…"));
    assert.ok(longFirst.startsWith(opts.tq_fork_prompt.slice(0, -1)), "clipping is a prefix of the source's first message");

    // A source with no extractable first message leaves tq_fork_prompt
    // unset (the linker then leans on the source fallback alone) — and a
    // peek failure never breaks the resume.
    for (const peek of [() => ({ firstPrompt: null }), () => { throw new Error("unreadable"); }]) {
      const res2 = mockHttpResponse();
      const deps2 = resumeDeps({ peekSession: mock.fn(peek) });
      await handleApiRuns(mockReq({ body: resumeBody() }), res2, url, deps2);
      assert.equal(res2.status, 200);
      const opts2 = deps2.newWindow.mock.calls[0].arguments[0].userOptions;
      assert.ok(!("tq_fork_prompt" in opts2), "no fabricated content identity");
      assert.equal(opts2.tq_resumed_path, SRC_PATH);
    }
  });

  test("resume answers 503 when the multiplexer is unavailable", async () => {
    const res = mockHttpResponse();
    const deps = resumeDeps({ muxAvailable: () => false });
    await handleApiRuns(mockReq({ body: resumeBody() }), res, url, deps);
    assert.equal(res.status, 503);
    assert.equal(deps.newWindow.mock.calls.length, 0);
  });

  test("GET /api/runs and /api/runs/session expose resumedFrom from the persisted tmux option", async () => {
    const win = {
      id: "@9",
      name: "claude",
      dead: true,
      options: {
        tq_agent: "claude",
        tq_cwd: "/w",
        tq_started: "2026-08-10T00:00:00.000Z",
        tq_resumed_from: SRC_HASH,
      },
    };
    const res = mockHttpResponse();
    const deps = fakeDeps({ listWindows: mock.fn(() => [win]) });
    await handleApiRuns(mockReq({ method: "GET" }), res, url, deps);
    assert.equal(JSON.parse(res.body).runs[0].resumedFrom, SRC_HASH);

    const res2 = mockHttpResponse();
    await handleApiRunsSession(
      mockReq({ method: "GET" }),
      res2,
      new URL("http://localhost/api/runs/session?id=%409"),
      fakeDeps({ listWindows: mock.fn(() => [win]) }),
    );
    assert.equal(JSON.parse(res2.body).run.resumedFrom, SRC_HASH);
  });
});

/** A run window as listWindows would report it. */
function runWindow(overrides = {}) {
  return {
    id: "@5",
    name: "claude",
    dead: false,
    options: { tq_agent: "claude", tq_cwd: "/w", tq_started: "2026-08-10T00:00:00.000Z" },
    ...overrides,
  };
}

describe("launch routes — GET /api/runs/snapshot", () => {
  const snapUrl = (id) =>
    new URL(`http://localhost/api/runs/snapshot${id === undefined ? "" : `?id=${encodeURIComponent(id)}`}`);

  test("snapshot rejects malformed ids with 400 before touching tmux", async () => {
    for (const id of [undefined, "", "5", "@", "@5x", "@5;rm", "%1", "../etc", "@-1"]) {
      const res = mockHttpResponse();
      const deps = fakeDeps();
      await handleApiRunsSnapshot(null, res, snapUrl(id), deps);
      assert.equal(res.status, 400, `id ${String(id)} must answer 400`);
      assert.match(JSON.parse(res.body).error, /id/);
      assert.equal(deps.listWindows.mock.calls.length, 0, `id ${String(id)} must not touch tmux`);
    }
  });

  test("snapshot answers 404 for an unknown id rather than an empty screen", async () => {
    const res = mockHttpResponse();
    const deps = fakeDeps({ listWindows: mock.fn(() => [runWindow({ id: "@1" })]) });
    await handleApiRunsSnapshot(null, res, snapUrl("@9"), deps);
    assert.equal(res.status, 404);
    assert.match(JSON.parse(res.body).error, /@9/);
  });

  test("snapshot answers 404 for a hand-opened window that is not a run", async () => {
    const res = mockHttpResponse();
    const deps = fakeDeps({
      listWindows: mock.fn(() => [
        runWindow({ id: "@2", options: { tq_agent: "", tq_cwd: "", tq_started: "" } }),
      ]),
      capturePane: mock.fn(() => "must not be called"),
    });
    await handleApiRunsSnapshot(null, res, snapUrl("@2"), deps);
    assert.equal(res.status, 404);
    assert.equal(deps.capturePane.mock.calls.length, 0);
  });

  test("snapshot of a running run captures the viewport and converts SGR to HTML", async () => {
    const res = mockHttpResponse();
    const capturePane = mock.fn(() => "\u001b[31mRED\u001b[0m <plain>\n");
    const deps = fakeDeps({ listWindows: mock.fn(() => [runWindow()]), capturePane });
    await handleApiRunsSnapshot(null, res, snapUrl("@5"), deps);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.status, "running");
    assert.equal(data.html, '<span class="ansi-fg-1">RED</span> &lt;plain&gt;\n');
    assert.equal(capturePane.mock.calls.length, 1);
    assert.deepEqual(capturePane.mock.calls[0].arguments, ["@5", { withHistory: false }]);
  });

  test("snapshot of an exited run reports exited and captures WITH history", async () => {
    const res = mockHttpResponse();
    const capturePane = mock.fn(() => "final output\nPane is dead\n");
    const deps = fakeDeps({ listWindows: mock.fn(() => [runWindow({ dead: true })]), capturePane });
    await handleApiRunsSnapshot(null, res, snapUrl("@5"), deps);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.status, "exited");
    assert.ok(data.html.includes("final output"));
    assert.deepEqual(capturePane.mock.calls[0].arguments, ["@5", { withHistory: true }]);
  });

  test("/api/runs/snapshot is registered in ROUTE_MAP", () => {
    assert.equal(ROUTE_MAP["/api/runs/snapshot"], handleApiRunsSnapshot);
  });
});

describe("launch routes — GET /api/runs/session", () => {
  const sessionUrl = (id, etag) => {
    const base = `http://localhost/api/runs/session${id === undefined ? "" : `?id=${encodeURIComponent(id)}`}`;
    return new URL(etag ? `${base}&etag=${encodeURIComponent(etag)}` : base);
  };

  /** A real claude-format recording on disk — the handler stats and parses it. */
  function writeRecording(lines) {
    const dir = fs.mkdtempSync(join(tmpdir(), "tq-runs-session-"));
    const path = join(dir, "rec.jsonl");
    fs.writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return path;
  }

  const userLine = (n) => ({
    type: "user",
    sessionId: "run-session-unit",
    cwd: "/w",
    timestamp: `2026-08-10T00:0${n}:00.000Z`,
    uuid: `u-${n}`,
    isMeta: false,
    message: { content: [{ type: "text", text: `prompt ${n}` }] },
  });
  const assistantLine = (n) => ({
    type: "assistant",
    sessionId: "run-session-unit",
    timestamp: `2026-08-10T00:0${n}:30.000Z`,
    uuid: `a-${n}`,
    message: {
      model: "claude-sonnet-4-20250514",
      content: [{ type: "text", text: `reply ${n}` }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 20 },
    },
  });

  test("run session rejects malformed ids with 400 before touching tmux", async () => {
    for (const id of [undefined, "", "5", "@", "@5x", "@5;rm"]) {
      const res = mockHttpResponse();
      const deps = fakeDeps();
      await handleApiRunsSession(null, res, sessionUrl(id), deps);
      assert.equal(res.status, 400, `id ${String(id)} must answer 400`);
      assert.equal(deps.listWindows.mock.calls.length, 0, `id ${String(id)} must not touch tmux`);
    }
  });

  test("run session answers 404 for an unknown id and for a hand-opened window", async () => {
    const res = mockHttpResponse();
    const deps = fakeDeps({ listWindows: mock.fn(() => [runWindow({ id: "@1" })]) });
    await handleApiRunsSession(null, res, sessionUrl("@9"), deps);
    assert.equal(res.status, 404);
    assert.match(JSON.parse(res.body).error, /@9/);

    const res2 = mockHttpResponse();
    const deps2 = fakeDeps({
      listWindows: mock.fn(() => [runWindow({ id: "@2", options: { tq_agent: "", tq_cwd: "", tq_started: "" } })]),
    });
    await handleApiRunsSession(null, res2, sessionUrl("@2"), deps2);
    assert.equal(res2.status, 404);
  });

  test("run session answers the pending shape while no recording is linked", async () => {
    const res = mockHttpResponse();
    const deps = fakeDeps({ listWindows: mock.fn(() => [runWindow()]) });
    await handleApiRunsSession(null, res, sessionUrl("@5"), deps);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.deepEqual(data.run, {
      id: "@5",
      agent: "claude",
      cwd: "/w",
      startedAt: "2026-08-10T00:00:00.000Z",
      status: "running",
      resumedFrom: null,
    });
    assert.equal(data.link, "pending");
    assert.equal(data.state, "running", "pending first recording is generating");
    assert.equal(data.run.status, "running");
    assert.equal(data.attribution, null);
    assert.equal(data.sessionPath, null);
    assert.equal(data.session, null);
    assert.equal(data.etag, null);
  });

  test("run session serves the unified session, honours etag, and reflects appended events", async () => {
    clearRunSessionMemo();
    const path = writeRecording([userLine(1), assistantLine(1)]);
    const deps = fakeDeps({
      listWindows: mock.fn(() => [runWindow()]),
      linkRunSession: mock.fn(() => ({ path, link: "linked", attribution: "pid" })),
    });

    const res = mockHttpResponse();
    await handleApiRunsSession(null, res, sessionUrl("@5"), deps);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.link, "linked");
    assert.equal(data.state, "idle", "linked settled recording is idle, not running merely because sessionPath exists");
    assert.equal(data.run.status, "idle");
    assert.equal(data.attribution, "pid", "the endpoint reports how the link was attributed");
    assert.equal(data.sessionPath, path);
    assert.match(data.etag, /^\d+-\d+$/);
    assert.equal(data.session.sessionId, "run-session-unit");
    assert.equal(data.session.eventCount, 2);
    assert.equal(data.session.stats.userMessages, 1);
    assert.equal(data.session.stats.assistantTurns, 1);
    assert.equal(data.chapters.length, 1);
    assert.equal(data.chapters[0].prompt, "prompt 1");

    // Same etag → unchanged, no session body reparsed or resent.
    const unchanged = mockHttpResponse();
    await handleApiRunsSession(null, unchanged, sessionUrl("@5", data.etag), deps);
    const unchangedData = JSON.parse(unchanged.body);
    assert.equal(unchangedData.unchanged, true);
    assert.equal(unchangedData.session, null);
    assert.equal(unchangedData.etag, data.etag);

    // The agent appends — the SAME request shape now answers fresh events.
    fs.appendFileSync(path, JSON.stringify(userLine(2)) + "\n" + JSON.stringify(assistantLine(2)) + "\n");
    const grown = mockHttpResponse();
    await handleApiRunsSession(null, grown, sessionUrl("@5", data.etag), deps);
    const grownData = JSON.parse(grown.body);
    assert.equal(grownData.unchanged, undefined);
    assert.notEqual(grownData.etag, data.etag);
    assert.equal(grownData.session.eventCount, 4);
    assert.equal(grownData.chapters.length, 2);
  });

  test("run session live parse requests a full untruncated session (fact clft)", async () => {
    clearRunSessionMemo();
    const path = writeRecording([userLine(1), assistantLine(1)]);
    let seenOpts = undefined;
    const deps = fakeDeps({
      listWindows: mock.fn(() => [runWindow()]),
      linkRunSession: mock.fn(() => ({ path, link: "linked", attribution: "pid" })),
      parseSession: (p, source, opts) => {
        seenOpts = opts;
        return { path: p, source, sessionId: "run-session-unit", eventCount: 2, events: [], stats: {} };
      },
    });
    const res = mockHttpResponse();
    await handleApiRunsSession(null, res, sessionUrl("@5"), deps);
    assert.equal(res.status, 200);
    assert.equal(seenOpts?.full, true, "chat poll parse must disable capContent");
  });

  test("run session body carries full untruncated assistant and tool_result text", async () => {
    clearRunSessionMemo();
    const assistant = `BAR_ASSISTANT_FULL_7f3c9e21\n${"A".repeat(2200)}`;
    const tool = `BAR_TOOL_RESULT_FULL_9a1e44b0\n${"T".repeat(2200)}`;
    const path = writeRecording([
      userLine(1),
      {
        type: "assistant",
        sessionId: "run-session-unit",
        timestamp: "2026-08-10T00:01:30.000Z",
        uuid: "a-long",
        message: {
          model: "claude-sonnet-4-20250514",
          content: [
            { type: "text", text: assistant },
            { type: "tool_use", id: "tool-long", name: "Bash", input: { command: "cat fixture" } },
          ],
          usage: { input_tokens: 10, output_tokens: 20 },
        },
      },
      {
        type: "user",
        sessionId: "run-session-unit",
        cwd: "/w",
        timestamp: "2026-08-10T00:02:00.000Z",
        uuid: "tr-long",
        isMeta: false,
        message: { content: [{ type: "tool_result", tool_use_id: "tool-long", content: tool }] },
      },
    ]);
    const deps = fakeDeps({
      listWindows: mock.fn(() => [runWindow()]),
      linkRunSession: mock.fn(() => ({ path, link: "linked", attribution: "pid" })),
    });
    const res = mockHttpResponse();
    await handleApiRunsSession(null, res, sessionUrl("@5"), deps);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    const events = data.session.events || [];
    const asst = events.find((e) => e.type === "assistant");
    const result = events.find((e) => e.type === "tool_result");
    assert.equal(asst?.text, assistant, "assistant body is not capContent-truncated");
    assert.equal(result?.text, tool, "tool_result body is not capContent-truncated");
    assert.doesNotMatch(asst.text, /truncated \d+ chars/);
    assert.doesNotMatch(result.text, /truncated \d+ chars/);
  });

  test("run session of an exited run stays served with state exited", async () => {
    clearRunSessionMemo();
    const path = writeRecording([userLine(1), assistantLine(1)]);
    const res = mockHttpResponse();
    const deps = fakeDeps({
      listWindows: mock.fn(() => [runWindow({ dead: true })]),
      linkRunSession: mock.fn(() => ({ path, link: "linked" })),
    });
    await handleApiRunsSession(null, res, sessionUrl("@5"), deps);
    const data = JSON.parse(res.body);
    assert.equal(data.run.status, "exited");
    assert.equal(data.state, "exited");
    assert.equal(data.link, "linked");
    assert.equal(data.session.eventCount, 2);
  });

  test("D1: GET /api/runs, /api/runs/session, and /api/runs/snapshot status is generating, not tmux-alive", async () => {
    clearRunSessionMemo();
    const idlePath = writeRecording([userLine(1), assistantLine(1)]);
    const genPath = writeRecording([userLine(1)]);
    const idleWin = runWindow({ id: "@8" });
    const genWin = runWindow({ id: "@9" });

    const idleSession = await (async () => {
      const res = mockHttpResponse();
      const deps = fakeDeps({
        listWindows: mock.fn(() => [idleWin]),
        linkRunSession: mock.fn(() => ({ path: idlePath, link: "linked", attribution: "sid" })),
        detectLiveSessions: mock.fn(() => []),
      });
      await handleApiRunsSession(null, res, sessionUrl("@8"), deps);
      return JSON.parse(res.body);
    })();
    assert.equal(idleSession.link, "linked");
    assert.equal(idleSession.state, "idle", "idle launched G1 is not running merely because sessionPath exists");
    assert.equal(idleSession.run.status, "idle");
    assert.equal(idleSession.state, idleSession.run.status);

    const genSession = await (async () => {
      const res = mockHttpResponse();
      const deps = fakeDeps({
        listWindows: mock.fn(() => [genWin]),
        linkRunSession: mock.fn(() => ({ path: genPath, link: "linked", attribution: "sid" })),
        detectLiveSessions: mock.fn(() => [genPath]),
      });
      await handleApiRunsSession(null, res, sessionUrl("@9"), deps);
      return JSON.parse(res.body);
    })();
    assert.equal(genSession.link, "linked");
    assert.equal(genSession.state, "running", "generating launched G2 is running");
    assert.equal(genSession.run.status, "running");
    assert.equal(genSession.state, genSession.run.status);

    const listRes = mockHttpResponse();
    await handleApiRuns(mockReq({ method: "GET" }), listRes, new URL("http://localhost/api/runs"), fakeDeps({
      listWindows: mock.fn(() => [idleWin, genWin]),
      linkRunSession: mock.fn((win) =>
        win.id === "@9"
          ? { path: genPath, link: "linked", attribution: "sid" }
          : { path: idlePath, link: "linked", attribution: "sid" },
      ),
      detectLiveSessions: mock.fn(() => [genPath]),
    }));
    const listed = JSON.parse(listRes.body).runs;
    assert.equal(listed.find((r) => r.id === "@8").status, "idle");
    assert.equal(listed.find((r) => r.id === "@8").state, "idle");
    assert.equal(listed.find((r) => r.id === "@9").status, "running");
    assert.equal(listed.find((r) => r.id === "@9").state, "running");

    const idleSnap = mockHttpResponse();
    await handleApiRunsSnapshot(null, idleSnap, new URL("http://localhost/api/runs/snapshot?id=%408"), fakeDeps({
      listWindows: mock.fn(() => [idleWin]),
      linkRunSession: mock.fn(() => ({ path: idlePath, link: "linked", attribution: "sid" })),
      detectLiveSessions: mock.fn(() => []),
      capturePane: mock.fn(() => "idle pane"),
    }));
    assert.equal(JSON.parse(idleSnap.body).status, "idle", "snapshot status is idle for launched G1");

    const genSnap = mockHttpResponse();
    await handleApiRunsSnapshot(null, genSnap, new URL("http://localhost/api/runs/snapshot?id=%409"), fakeDeps({
      listWindows: mock.fn(() => [genWin]),
      linkRunSession: mock.fn(() => ({ path: genPath, link: "linked", attribution: "sid" })),
      detectLiveSessions: mock.fn(() => [genPath]),
      capturePane: mock.fn(() => "generating pane"),
    }));
    assert.equal(JSON.parse(genSnap.body).status, "running", "snapshot status is running for launched G2");
  });

  test("run session degrades to pending when the linked recording vanished", async () => {
    const res = mockHttpResponse();
    const deps = fakeDeps({
      listWindows: mock.fn(() => [runWindow()]),
      linkRunSession: mock.fn(() => ({ path: join(tmpdir(), "tq-gone-recording.jsonl"), link: "linked" })),
    });
    await handleApiRunsSession(null, res, sessionUrl("@5"), deps);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.link, "pending");
    assert.equal(data.session, null);
  });

  test("/api/runs/session is registered in ROUTE_MAP", () => {
    assert.equal(ROUTE_MAP["/api/runs/session"], handleApiRunsSession);
  });
});

describe("launch routes — POST /api/runs/kill", () => {
  const url = new URL("http://localhost/api/runs/kill");

  function killDeps(overrides = {}) {
    return fakeDeps({
      listWindows: mock.fn(() => [runWindow()]),
      killWindow: mock.fn(() => {}),
      ...overrides,
    });
  }

  test("kill rejects non-POST methods with 405 and no side effects", async () => {
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const res = mockHttpResponse();
      const deps = killDeps();
      await handleApiRunsKill(mockReq({ method, body: JSON.stringify({ id: "@5" }) }), res, url, deps);
      assert.equal(res.status, 405, `${method} must answer 405`);
      assert.equal(deps.killWindow.mock.calls.length, 0);
    }
  });

  test("kill rejects a non-localhost Host header with 403 and no tmux operation", async () => {
    for (const host of ["evil.com", "evil.com:7777", null]) {
      const res = mockHttpResponse();
      const deps = killDeps();
      await handleApiRunsKill(mockReq({ host, body: JSON.stringify({ id: "@5" }) }), res, url, deps);
      assert.equal(res.status, 403, `Host ${host} must answer 403`);
      assert.equal(deps.killWindow.mock.calls.length, 0);
      assert.equal(deps.listWindows.mock.calls.length, 0);
    }
  });

  test("kill rejects a malformed id with 400 before touching tmux", async () => {
    for (const id of [undefined, "", "5", "@x", 42, null, ["@5"]]) {
      const res = mockHttpResponse();
      const deps = killDeps();
      await handleApiRunsKill(mockReq({ body: JSON.stringify({ id }) }), res, url, deps);
      assert.equal(res.status, 400, `id ${String(id)} must answer 400`);
      assert.equal(deps.killWindow.mock.calls.length, 0);
      assert.equal(deps.listWindows.mock.calls.length, 0);
    }
  });

  test("kill answers 404 for an unknown id without killing anything", async () => {
    const res = mockHttpResponse();
    const deps = killDeps();
    await handleApiRunsKill(mockReq({ body: JSON.stringify({ id: "@9" }) }), res, url, deps);
    assert.equal(res.status, 404);
    assert.match(JSON.parse(res.body).error, /@9/);
    assert.equal(deps.killWindow.mock.calls.length, 0, "unknown id must not touch tmux state");
  });

  test("kill kills the run window and answers {ok:true} — exited runs included", async () => {
    for (const dead of [false, true]) {
      const res = mockHttpResponse();
      const deps = killDeps({ listWindows: mock.fn(() => [runWindow({ dead })]) });
      await handleApiRunsKill(mockReq({ body: JSON.stringify({ id: "@5" }) }), res, url, deps);
      assert.equal(res.status, 200, `dead=${dead} must answer 200`);
      assert.deepEqual(JSON.parse(res.body), { ok: true });
      assert.equal(deps.killWindow.mock.calls.length, 1);
      assert.deepEqual(deps.killWindow.mock.calls[0].arguments, ["@5"]);
    }
  });

  test("kill answers 404 JSON when the window vanishes between check and kill (TOCTOU)", async () => {
    // API-002: killWindow throws because the window disappeared after the
    // findRunWindow check — the re-check maps the throw to a JSON 404,
    // never the generic plaintext 500.
    let listCalls = 0;
    const deps = killDeps({
      listWindows: mock.fn(() => (++listCalls === 1 ? [runWindow()] : [])),
      killWindow: mock.fn(() => {
        throw new Error("can't find window: @5");
      }),
    });
    const res = mockHttpResponse();
    await handleApiRunsKill(mockReq({ body: JSON.stringify({ id: "@5" }) }), res, url, deps);
    assert.equal(res.status, 404);
    assert.match(res.headers["Content-Type"], /application\/json/);
    assert.match(JSON.parse(res.body).error, /@5/);
  });

  test("kill tombstones the run BEFORE killing so its claim outlives the window", async () => {
    const calls = [];
    const win = runWindow({
      options: {
        tq_agent: "claude", tq_cwd: "/w", tq_started: "2026-08-10T00:00:00.000Z",
        tq_prompt: "fast-beta", tq_session: "/rec/fast.jsonl", tq_session_attr: "heur",
      },
    });
    const deps = killDeps({
      listWindows: mock.fn(() => [win]),
      recordRunTombstone: mock.fn((w) => calls.push(["tombstone", w.id])),
      killWindow: mock.fn((id) => calls.push(["kill", id])),
    });
    const res = mockHttpResponse();
    await handleApiRunsKill(mockReq({ body: JSON.stringify({ id: "@5" }) }), res, url, deps);
    assert.equal(res.status, 200);
    assert.deepEqual(calls, [["tombstone", "@5"], ["kill", "@5"]],
      "the tombstone must be written while the window still exists");
    assert.deepEqual(deps.recordRunTombstone.mock.calls[0].arguments[0], win,
      "the FULL window (options incl. prompt/claim) feeds the tombstone");
    assert.deepEqual(deps.recordRunTombstone.mock.calls[0].arguments[2], { windows: [win] },
      "the window list feeds relevance-based tombstone compaction");
  });

  test("run polls reconcile the ledger with the fetched window list (synthesized tombstones for tmux-direct kills)", async () => {
    // The sync hook is what turns a window vanished OUTSIDE the kill API
    // into a tombstone; both poll endpoints must drive it with the same
    // window list they link against.
    const win = runWindow();
    const syncCalls = [];
    const deps = fakeDeps({
      listWindows: mock.fn(() => [win]),
      syncRunLedger: (windows, d) => syncCalls.push([windows, typeof d]),
      linkRunSession: mock.fn(() => ({ path: null, link: "pending", attribution: null })),
    });
    await handleApiRuns(mockReq({ method: "GET" }), mockHttpResponse(), new URL("http://localhost/api/runs"), deps);
    assert.equal(syncCalls.length, 1, "GET /api/runs syncs the ledger once per poll");
    assert.deepEqual(syncCalls[0][0], [win], "the ledger sync sees the exact fetched window list");

    await handleApiRunsSession(
      mockReq({ method: "GET" }),
      mockHttpResponse(),
      new URL("http://localhost/api/runs/session?id=@5"),
      deps,
    );
    assert.equal(syncCalls.length, 2, "GET /api/runs/session syncs the ledger too");
  });

  test("a failed tombstone write never blocks the user's dismissal", async () => {
    const deps = killDeps({
      recordRunTombstone: mock.fn(() => {
        throw new Error("tmux option write failed");
      }),
    });
    const res = mockHttpResponse();
    await handleApiRunsKill(mockReq({ body: JSON.stringify({ id: "@5" }) }), res, url, deps);
    assert.equal(res.status, 200);
    assert.equal(deps.killWindow.mock.calls.length, 1);
  });

  test("kill answers 500 JSON when tmux fails with the window still present", async () => {
    const deps = killDeps({
      killWindow: mock.fn(() => {
        throw new Error("tmux server wedged");
      }),
    });
    const res = mockHttpResponse();
    await handleApiRunsKill(mockReq({ body: JSON.stringify({ id: "@5" }) }), res, url, deps);
    assert.equal(res.status, 500);
    assert.match(res.headers["Content-Type"], /application\/json/);
    assert.match(JSON.parse(res.body).error, /tmux server wedged/);
  });

  test("/api/runs/kill is registered in ROUTE_MAP", () => {
    assert.equal(ROUTE_MAP["/api/runs/kill"], handleApiRunsKill);
  });
});

describe("launch routes — POST /api/runs/input", () => {
  const url = new URL("http://localhost/api/runs/input");

  function inputDeps(overrides = {}) {
    return fakeDeps({
      listWindows: mock.fn(() => [runWindow()]),
      sendKeys: mock.fn(() => {}),
      ...overrides,
    });
  }

  function post(deps, payload, reqOverrides = {}) {
    const res = mockHttpResponse();
    return handleApiRunsInput(
      mockReq({ body: JSON.stringify(payload), ...reqOverrides }),
      res,
      url,
      deps,
    ).then(() => res);
  }

  test("input rejects non-POST methods with 405 and sends nothing", async () => {
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const deps = inputDeps();
      const res = await post(deps, { id: "@5", text: "hi" }, { method });
      assert.equal(res.status, 405, `${method} must answer 405`);
      assert.equal(deps.sendKeys.mock.calls.length, 0);
    }
  });

  test("input rejects a non-localhost Host header with 403 and no tmux operation", async () => {
    for (const host of ["evil.com", "evil.com:7777", null]) {
      const deps = inputDeps();
      const res = await post(deps, { id: "@5", text: "hi" }, { host });
      assert.equal(res.status, 403, `Host ${host} must answer 403`);
      assert.equal(deps.sendKeys.mock.calls.length, 0);
      assert.equal(deps.listWindows.mock.calls.length, 0);
    }
  });

  test("input rejects a malformed id with 400 before touching tmux", async () => {
    for (const id of [undefined, "", "5", "@x", 42, null]) {
      const deps = inputDeps();
      const res = await post(deps, { id, text: "hi" });
      assert.equal(res.status, 400, `id ${String(id)} must answer 400`);
      assert.match(JSON.parse(res.body).error, /id/);
      assert.equal(deps.sendKeys.mock.calls.length, 0);
      assert.equal(deps.listWindows.mock.calls.length, 0);
    }
  });

  test("input rejects a payload with neither text nor key with 400", async () => {
    const deps = inputDeps();
    const res = await post(deps, { id: "@5" });
    assert.equal(res.status, 400);
    assert.match(JSON.parse(res.body).error, /text or key/);
    assert.equal(deps.sendKeys.mock.calls.length, 0);
    assert.equal(deps.listWindows.mock.calls.length, 0);
  });

  test("input rejects empty or non-string text with 400", async () => {
    for (const text of ["", 42, null, ["x"]]) {
      const deps = inputDeps();
      const res = await post(deps, { id: "@5", text });
      assert.equal(res.status, 400, `text ${JSON.stringify(text)} must answer 400`);
      assert.match(JSON.parse(res.body).error, /text/);
      assert.equal(deps.sendKeys.mock.calls.length, 0);
    }
  });

  test("input rejects a key outside the closed set with 400 naming the allowed keys", async () => {
    for (const key of ["C-d", "enter", "F1", "C-c Enter", "", 42, null]) {
      const deps = inputDeps();
      const res = await post(deps, { id: "@5", key });
      assert.equal(res.status, 400, `key ${JSON.stringify(key)} must answer 400`);
      const error = JSON.parse(res.body).error;
      for (const allowed of INPUT_KEYS) {
        assert.ok(error.includes(allowed), `error must name allowed key ${allowed}`);
      }
      assert.equal(deps.sendKeys.mock.calls.length, 0, "nothing may be sent for a rejected key");
      assert.equal(deps.listWindows.mock.calls.length, 0, "rejected payloads never touch tmux");
    }
  });

  test("the key allowlist is exactly Enter, C-c, Escape, Up, Down, Tab", () => {
    assert.deepEqual(INPUT_KEYS, ["Enter", "C-c", "Escape", "Up", "Down", "Tab"]);
  });

  test("input answers 404 for an unknown id without sending anything", async () => {
    const deps = inputDeps();
    const res = await post(deps, { id: "@9", text: "hi" });
    assert.equal(res.status, 404);
    assert.match(JSON.parse(res.body).error, /@9/);
    assert.equal(deps.sendKeys.mock.calls.length, 0);
  });

  test("input answers 409 for an exited run without sending anything", async () => {
    const deps = inputDeps({ listWindows: mock.fn(() => [runWindow({ dead: true })]) });
    const res = await post(deps, { id: "@5", text: "hi" });
    assert.equal(res.status, 409);
    assert.match(JSON.parse(res.body).error, /exited/);
    assert.match(JSON.parse(res.body).error, /running run/, "error documents the running-run requirement");
    assert.equal(deps.sendKeys.mock.calls.length, 0);
  });

  test("text-only input is sent literally (send-keys -l semantics)", async () => {
    const deps = inputDeps();
    const res = await post(deps, { id: "@5", text: "Enter;-l" });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true });
    assert.equal(deps.sendKeys.mock.calls.length, 1);
    assert.deepEqual(deps.sendKeys.mock.calls[0].arguments, ["@5", ["Enter;-l"], { literal: true }]);
  });

  test("key-only input is sent as a non-literal key name", async () => {
    for (const key of INPUT_KEYS) {
      const deps = inputDeps();
      const res = await post(deps, { id: "@5", key });
      assert.equal(res.status, 200, `key ${key} must be accepted`);
      assert.equal(deps.sendKeys.mock.calls.length, 1);
      assert.deepEqual(deps.sendKeys.mock.calls[0].arguments, ["@5", [key]]);
    }
  });

  test("text plus key sends the literal text FIRST, then the key", async () => {
    const deps = inputDeps();
    const res = await post(deps, { id: "@5", text: "hello", key: "Enter" });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true });
    assert.equal(deps.sendKeys.mock.calls.length, 2);
    assert.deepEqual(deps.sendKeys.mock.calls[0].arguments, ["@5", ["hello"], { literal: true }]);
    assert.deepEqual(deps.sendKeys.mock.calls[1].arguments, ["@5", ["Enter"]]);
  });

  test("input rejects NUL/control characters in text with 400 and sends nothing", async () => {
    // Bugbash F3: a NUL reaching send-keys would throw out of execFileSync.
    for (const text of ["a\u0000b", "a\u0007b", "a\u001bb"]) {
      const deps = inputDeps();
      const res = await post(deps, { id: "@5", text });
      assert.equal(res.status, 400, `text ${JSON.stringify(text)} must answer 400`);
      assert.match(JSON.parse(res.body).error, /text/);
      assert.equal(deps.sendKeys.mock.calls.length, 0);
      assert.equal(deps.listWindows.mock.calls.length, 0, "rejected text never touches tmux");
    }
    // \t stays legal input text.
    const deps = inputDeps();
    const res = await post(deps, { id: "@5", text: "col1\tcol2" });
    assert.equal(res.status, 200);
    assert.equal(deps.sendKeys.mock.calls.length, 1);
  });

  test("input answers 404 JSON when the window vanishes between check and send (TOCTOU)", async () => {
    let listCalls = 0;
    const deps = inputDeps({
      listWindows: mock.fn(() => (++listCalls === 1 ? [runWindow()] : [])),
      sendKeys: mock.fn(() => {
        throw new Error("can't find window: @5");
      }),
    });
    const res = await post(deps, { id: "@5", text: "hi" });
    assert.equal(res.status, 404);
    assert.match(res.headers["Content-Type"], /application\/json/);
    assert.match(JSON.parse(res.body).error, /@5/);
  });

  test("input answers 500 JSON when tmux fails with the window still present", async () => {
    const deps = inputDeps({
      sendKeys: mock.fn(() => {
        throw new Error("tmux server wedged");
      }),
    });
    const res = await post(deps, { id: "@5", text: "hi" });
    assert.equal(res.status, 500);
    assert.match(res.headers["Content-Type"], /application\/json/);
    assert.match(JSON.parse(res.body).error, /tmux server wedged/);
  });

  test("/api/runs/input is registered in ROUTE_MAP", () => {
    assert.equal(ROUTE_MAP["/api/runs/input"], handleApiRunsInput);
  });
});

describe("launch routes — GET /run watch page handler", () => {
  const runUrl = (id) =>
    new URL(`http://localhost/run${id === undefined ? "" : `?id=${encodeURIComponent(id)}`}`);

  function pageDeps(overrides = {}) {
    return {
      runPage,
      listWindows: mock.fn(() => [runWindow()]),
      ...overrides,
    };
  }

  test("run page rejects malformed ids with a 400 error page before touching tmux", async () => {
    for (const id of ["5", "@", "@5x", "@5;rm", "%1", "../etc"]) {
      const res = mockHttpResponse();
      const deps = pageDeps();
      await handleRun(null, res, runUrl(id), deps);
      assert.equal(res.status, 400, `id ${String(id)} must answer 400`);
      assert.match(res.headers["Content-Type"], /text\/html/);
      assert.ok(String(res.body).includes('data-run-state="error"'));
      assert.ok(String(res.body).includes("HTTP 400"));
      assert.ok(String(res.body).includes('href="/sessions"'));
      assert.equal(deps.listWindows.mock.calls.length, 0, `id ${String(id)} must not touch tmux`);
    }
  });

  test("run page answers a 404 error page for an unknown or non-run id", async () => {
    const cases = [
      { id: "@9", deps: pageDeps() },
      {
        id: "@2",
        deps: pageDeps({
          listWindows: mock.fn(() => [
            runWindow({ id: "@2", options: { tq_agent: "", tq_cwd: "", tq_started: "" } }),
          ]),
        }),
      },
    ];
    for (const { id, deps } of cases) {
      const res = mockHttpResponse();
      await handleRun(null, res, runUrl(id), deps);
      assert.equal(res.status, 404, `id ${id} must answer 404`);
      assert.match(res.headers["Content-Type"], /text\/html/);
      assert.ok(String(res.body).includes('data-run-state="error"'));
      assert.ok(String(res.body).includes(id));
      assert.ok(String(res.body).includes('href="/sessions"'));
    }
  });

  test("run page serves the watch page with embedded metadata for a known run", async () => {
    const res = mockHttpResponse();
    await handleRun(null, res, runUrl("@5"), pageDeps());
    assert.equal(res.status, 200);
    assert.match(res.headers["Content-Type"], /text\/html/);
    const body = String(res.body);
    assert.ok(body.includes('<pre class="run-screen" id="runScreen">'));
    assert.ok(body.includes('var runId = "@5";'));
    assert.match(body, /<span class="session-source" style="--hue:#a78bfa">claude<\/span>/);
    assert.ok(body.includes(">/w</span>"), "cwd embedded");
    assert.ok(body.includes("2026-08-10T00:00:00.000Z"), "startedAt embedded");
    assert.ok(body.includes('data-status="running"'));
    assert.ok(body.includes("/__livereload"), "page is wrapped with live reload");
  });

  test("run page embeds the exited status for a dead run window", async () => {
    const res = mockHttpResponse();
    const deps = pageDeps({ listWindows: mock.fn(() => [runWindow({ dead: true })]) });
    await handleRun(null, res, runUrl("@5"), deps);
    assert.equal(res.status, 200);
    assert.ok(String(res.body).includes('id="runStatus" data-status="exited"'));
    assert.match(String(res.body), /id="killBtn" type="button"[^>]* hidden>/);
    assert.ok(String(res.body).includes('id="composerStatus" data-state="exited"'));
  });

  test("/run is registered in ROUTE_MAP", () => {
    assert.equal(ROUTE_MAP["/run"], handleRun);
  });
});
