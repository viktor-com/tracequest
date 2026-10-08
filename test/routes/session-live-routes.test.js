/**
 * GET /api/sessions/live — the session-keyed live parsed-session endpoint
 * (unified-live): the /api/runs/session machinery (etag memoized parse,
 * state) generalized to ANY session, launched or external. Read-only, so
 * the id follows resolveSessionPathForRequest semantics (400/403/404/409)
 * and paths outside the agent session roots can never resolve.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { handleApiSessionsLive, clearRunSessionMemo } from "../../src/routes/route-handlers-launch.js";
import { sessionHash } from "../../src/sessions/session-hash.js";
import { ROUTE_MAP } from "../../src/routes.js";
import { mockHttpResponse } from "../helpers/capture-json-handler.js";

const P = "/home/dev/.codex/sessions/2026/08/11/rollout-live.jsonl";
const HASH = sessionHash(P);

const SESSION_OBJ = { path: P, source: "codex", project: "-home-dev-proj", size: 1024, mtime: new Date() };

function baseDeps(overrides = {}) {
  return {
    findSessions: () => [SESSION_OBJ],
    detectLiveSessions: () => [P],
    statSync: () => ({ mtimeMs: 111_222.9, size: 333 }),
    parseSession: (path, source) => ({ path, source: source || "codex", cwd: "/home/dev/proj", events: [{ type: "user", text: "hi" }] }),
    buildSessionChapters: () => [{ title: "ch1" }],
    muxAvailable: () => false,
    ...overrides,
  };
}

function urlFor(qs) {
  return new URL(`http://localhost/api/sessions/live${qs}`);
}

beforeEach(() => clearRunSessionMemo());

describe("GET /api/sessions/live — id validation (read-endpoint semantics)", () => {
  test("missing id answers 400", async () => {
    const res = mockHttpResponse();
    await handleApiSessionsLive(null, res, urlFor(""), baseDeps());
    assert.equal(res.status, 400);
  });

  test("a non-session path answers 403 and never touches the filesystem", async () => {
    const res = mockHttpResponse();
    let statCalled = false;
    await handleApiSessionsLive(null, res, urlFor("?id=/etc/passwd"), baseDeps({
      statSync: () => { statCalled = true; return { mtimeMs: 1, size: 1 }; },
    }));
    assert.equal(res.status, 403);
    assert.equal(statCalled, false, "rejected handle must not reach stat");
  });

  test("an unknown session hash answers 404", async () => {
    const res = mockHttpResponse();
    await handleApiSessionsLive(null, res, urlFor("?id=00000000"), baseDeps());
    assert.equal(res.status, 404);
  });

  test("a vanished recording answers 404 JSON", async () => {
    const res = mockHttpResponse();
    await handleApiSessionsLive(null, res, urlFor(`?id=${HASH}`), baseDeps({
      statSync: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
    }));
    assert.equal(res.status, 404);
    assert.match(JSON.parse(res.body).error, /not found/);
  });
});

describe("GET /api/sessions/live — live session body", () => {
  test("a live session answers the full unified-session body with state running", async () => {
    const res = mockHttpResponse();
    await handleApiSessionsLive(null, res, urlFor(`?id=${HASH}`), baseDeps());
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.sessionHash, HASH);
    assert.equal(data.sessionPath, P);
    assert.equal(data.source, "codex");
    assert.equal(data.live, true);
    assert.equal(data.state, "running");
    assert.equal(data.run, null, "no run window claims this recording");
    assert.equal(data.etag, "111222-333");
    assert.equal(data.session.cwd, "/home/dev/proj");
    assert.equal(data.session.events.length, 1);
    assert.deepEqual(data.chapters, [{ title: "ch1" }]);
  });

  test("the parse receives the session's source (non-claude recordings parse correctly)", async () => {
    const res = mockHttpResponse();
    let seenSource = null;
    await handleApiSessionsLive(null, res, urlFor(`?id=${HASH}`), baseDeps({
      parseSession: (path, source) => { seenSource = source; return { path, events: [] }; },
    }));
    assert.equal(res.status, 200);
    assert.equal(seenSource, "codex");
  });

  test("live parse requests a full untruncated session (fact clft)", async () => {
    const res = mockHttpResponse();
    let seenOpts = undefined;
    await handleApiSessionsLive(null, res, urlFor(`?id=${HASH}`), baseDeps({
      parseSession: (path, source, opts) => {
        seenOpts = opts;
        return { path, source, events: [] };
      },
    }));
    assert.equal(res.status, 200);
    assert.equal(seenOpts?.full, true, "chat poll parse must disable capContent");
  });

  test("source correctness: a .cursor recording without an indexed source reports the PATH-derived source, never claude", async () => {
    // The r4 wrinkle: a .cursor/projects recording whose session-list entry
    // carries no source (or is too fresh to be indexed) was labeled — and
    // parsed as — "claude". The path itself names the agent family.
    // REAL cursor layout (dashless project slug + agent-transcripts/<uuid>/<uuid>.jsonl).
    const CUUID = "9f1c2d3e-4444-4000-8000-aaaabbbbcccc";
    const CP = `/home/dev/.cursor/projects/home-dev-proj/agent-transcripts/${CUUID}/${CUUID}.jsonl`;
    const CHASH = sessionHash(CP);
    const res = mockHttpResponse();
    let seenSource = null;
    await handleApiSessionsLive(null, res, urlFor(`?id=${CHASH}`), baseDeps({
      // Discovered, but without a source field — the fallback must not
      // invent "claude" for a cursor recording.
      findSessions: () => [{ path: CP, project: "home-dev-proj", size: 10, mtime: new Date() }],
      detectLiveSessions: () => [CP],
      parseSession: (path, source) => { seenSource = source; return { path, events: [] }; },
    }));
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.source, "cursor", "a .cursor recording is never labeled claude");
    assert.equal(seenSource, "cursor", "the parser gets the path-derived source too");
  });

  test("a session no longer detected live answers state idle — the transcript stays served", async () => {
    const res = mockHttpResponse();
    await handleApiSessionsLive(null, res, urlFor(`?id=${HASH}`), baseDeps({
      detectLiveSessions: () => [],
    }));
    const data = JSON.parse(res.body);
    assert.equal(data.live, false);
    assert.equal(data.state, "idle");
    assert.ok(data.session, "idle is not an error — the session body is still served");
  });

  test("repeating the current etag answers unchanged without a session body", async () => {
    const deps = baseDeps();
    const first = mockHttpResponse();
    await handleApiSessionsLive(null, first, urlFor(`?id=${HASH}`), deps);
    const etag = JSON.parse(first.body).etag;
    const res = mockHttpResponse();
    await handleApiSessionsLive(null, res, urlFor(`?id=${HASH}&etag=${etag}`), deps);
    const data = JSON.parse(res.body);
    assert.equal(data.unchanged, true);
    assert.equal(data.session, null);
    assert.equal(data.chapters, null);
    assert.equal(data.state, "running");
  });

  test("the parse is memoized behind the etag — an unchanged file is parsed once", async () => {
    let parses = 0;
    const deps = baseDeps({
      parseSession: (path) => { parses++; return { path, events: [] }; },
    });
    await handleApiSessionsLive(null, mockHttpResponse(), urlFor(`?id=${HASH}`), deps);
    await handleApiSessionsLive(null, mockHttpResponse(), urlFor(`?id=${HASH}`), deps);
    assert.equal(parses, 1, "same etag, one parse");
  });

  test("a recording that belongs to a run answers the run cross-link", async () => {
    const win = { id: "@5", dead: false, options: { tq_agent: "claude" } };
    const res = mockHttpResponse();
    await handleApiSessionsLive(null, res, urlFor(`?id=${HASH}`), baseDeps({
      muxAvailable: () => true,
      listWindows: () => [win],
      linkRunSession: (w, _windows, opts) => {
        assert.equal(opts?.persist, false, "observer requests never persist a link");
        return { path: P, link: "linked", attribution: "sid" };
      },
    }));
    const data = JSON.parse(res.body);
    assert.equal(data.state, "running", "D1: generating state is running, not live");
    assert.deepEqual(data.run, { id: "@5", status: "running" });
    assert.equal(data.state, data.run.status, "D1: /api/sessions/live state equals nested run.status");
  });

  test("D1: nested run.status is idle for a tmux-alive settled recording, not running", async () => {
    const win = { id: "@5", dead: false, options: { tq_agent: "claude" } };
    const res = mockHttpResponse();
    await handleApiSessionsLive(null, res, urlFor(`?id=${HASH}`), baseDeps({
      detectLiveSessions: () => [],
      muxAvailable: () => true,
      listWindows: () => [win],
      linkRunSession: (w, _windows, opts) => {
        assert.equal(opts?.persist, false, "observer requests never persist a link");
        return { path: P, link: "linked", attribution: "sid" };
      },
    }));
    const data = JSON.parse(res.body);
    assert.equal(data.live, false);
    assert.equal(data.state, "idle");
    assert.deepEqual(data.run, { id: "@5", status: "idle" },
      "D1: GET /api/sessions/live nested run.status follows generating, not tmux-alive");
    assert.equal(data.state, data.run.status, "D1: idle G1 state equals nested run.status");
  });

  test("D1: nested run.status is exited when the linked pane is dead", async () => {
    const win = { id: "@5", dead: true, options: { tq_agent: "claude" } };
    const res = mockHttpResponse();
    await handleApiSessionsLive(null, res, urlFor(`?id=${HASH}`), baseDeps({
      detectLiveSessions: () => [],
      muxAvailable: () => true,
      listWindows: () => [win],
      linkRunSession: () => ({ path: P, link: "linked", attribution: "sid" }),
    }));
    const data = JSON.parse(res.body);
    assert.deepEqual(data.run, { id: "@5", status: "exited" });
  });

  test("a parse failure answers 500 JSON {error}", async () => {
    const res = mockHttpResponse();
    await handleApiSessionsLive(null, res, urlFor(`?id=${HASH}`), baseDeps({
      parseSession: () => { throw new Error("boom"); },
    }));
    assert.equal(res.status, 500);
    assert.match(JSON.parse(res.body).error, /boom/);
  });

  test("an opencode live session answers the full body — freshness stats the opencode DB, never a virtual path", async () => {
    // opencode sessions are db rows behind an opencode:// URI: there is no
    // file at the session path, so the etag stat must land on the resolved
    // opencode.db file (sessionFreshnessPath) or the endpoint would 404
    // every opencode session.
    const OC = "ses_live0123456789abcdefghij";
    const OP = `opencode://${OC}`;
    const OHASH = sessionHash(OP);
    const res = mockHttpResponse();
    const statPaths = [];
    let seenSource = null;
    await handleApiSessionsLive(null, res, urlFor(`?id=${OHASH}`), baseDeps({
      findSessions: () => [{ path: OP, source: "opencode", project: "ocproj", size: 3072, mtime: new Date() }],
      detectLiveSessions: () => [OP],
      statSync: (p) => { statPaths.push(p); return { mtimeMs: 500_000.4, size: 64 }; },
      parseSession: (path, source) => { seenSource = source; return { path, source, events: [{ type: "user", text: "oc" }] }; },
    }));
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.sessionPath, OP);
    assert.equal(data.source, "opencode");
    assert.equal(data.live, true);
    assert.equal(data.state, "running");
    assert.equal(data.session.events.length, 1);
    assert.equal(seenSource, "opencode");
    assert.ok(statPaths.length >= 1, "freshness stat happened");
    assert.ok(statPaths.every((p) => !String(p).startsWith("opencode://")), `never stats the virtual path: ${statPaths}`);
    assert.ok(statPaths.every((p) => String(p).endsWith("opencode.db")), `stats the resolved opencode db: ${statPaths}`);
  });
});

describe("route registration", () => {
  test("/api/sessions/live is registered in ROUTE_MAP", () => {
    assert.equal(ROUTE_MAP["/api/sessions/live"], handleApiSessionsLive);
  });
});

describe("GET /api/sessions/live — one discovery scan per request (fact oiw)", () => {
  test("a hash id triggers a single scan, not one per resolution step", async () => {
    let scans = 0;
    const res = mockHttpResponse();
    await handleApiSessionsLive(
      null,
      res,
      urlFor(`?id=${HASH}`),
      baseDeps({
        findSessions: () => {
          scans++;
          return [SESSION_OBJ];
        },
      }),
    );
    assert.equal(res.status ?? 200, 200);
    assert.equal(scans, 1, "hash resolution and liveness must share one scan");
  });

  test("a path outside the session roots is refused after at most one scan", async () => {
    let scans = 0;
    const res = mockHttpResponse();
    await handleApiSessionsLive(
      null,
      res,
      urlFor(`?id=${encodeURIComponent(P)}`),
      baseDeps({
        findSessions: () => {
          scans++;
          return [SESSION_OBJ];
        },
      }),
    );
    // A non-session path is refused (fact ulep); resolution consults the
    // session list once to tell "unknown hash" from "not a session path".
    assert.equal(res.status, 403);
    assert.ok(scans <= 1, `a refused handle must not cost two tree walks, got ${scans}`);
  });

  test("an unknown hash still answers 404 after a single scan", async () => {
    let scans = 0;
    const res = mockHttpResponse();
    await handleApiSessionsLive(
      null,
      res,
      urlFor("?id=deadbeef"),
      baseDeps({
        findSessions: () => {
          scans++;
          return [SESSION_OBJ];
        },
      }),
    );
    assert.equal(res.status, 404);
    assert.equal(scans, 1);
  });
});
