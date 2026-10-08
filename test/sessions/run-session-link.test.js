import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, utimesSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { mkTmp } from "../helpers/fixtures.js";
import {
  CANDIDATE_SLACK_MS,
  RUN_LEDGER_OPTION,
  TOMBSTONE_MAX,
  TOMBSTONE_OPTION,
  attributeRunSession,
  claudeProjectSlug,
  compactTombstones,
  expectedSessionPaths,
  linkRunSession,
  promptCorroborates,
  readRunLedger,
  readRunTombstones,
  recordRunTombstone,
  resolveRunSessionPath,
  runSessionCandidates,
  sessionFreshnessPath,
  spawnIdentitySessionPath,
  syncRunLedger,
} from "../../src/sessions/run-session-link.js";
import { AGENT_REGISTRY, agentSupportsSessionId } from "../../src/agents/agent-detect.js";
import { cursorMainRecording, cursorProjectSlug, cursorTranscriptsDir } from "../../src/sessions/session-layout.js";
import { findCursorSessions } from "../../src/sessions/session-discovery.js";

/** Run `fn` with HOME pointed at `home` (discovery reads homedir() lazily). */
function withHome(home, fn) {
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn();
  } finally {
    process.env.HOME = prev;
  }
}

/**
 * A cursor-agent recording path in the REAL Cursor CLI layout:
 * <home>/.cursor/projects/<DASHLESS slug>/agent-transcripts/<id>/<id>.jsonl.
 * Round 6's fixtures wrote root-level files under a leading-dash slug — a
 * layout no Cursor build has ever used — which is exactly why five rounds
 * of green tests never noticed that attribution could not see a single real
 * cursor recording. Every cursor fixture in this file goes through here.
 */
function cursorRecording(home, cwd, id) {
  return cursorMainRecording(cursorTranscriptsDir(home, cwd), id);
}

/**
 * Dir-AWARE fake readdir over a virtual path set: answers the direct child
 * names of `dir` (ENOENT when it has none), so nested layouts (cursor's
 * uuid dirs, codex's dated tree) are walked exactly as on disk instead of
 * every directory answering every basename.
 */
function fakeReaddir(pathsOf) {
  return (dir, opts) => {
    const prefix = dir.endsWith("/") ? dir : `${dir}/`;
    const names = new Set();
    for (const p of pathsOf()) {
      if (!p.startsWith(prefix)) continue;
      names.add(p.slice(prefix.length).split("/")[0]);
    }
    if (!names.size) {
      const err = new Error(`ENOENT: ${dir}`);
      err.code = "ENOENT";
      throw err;
    }
    const list = [...names];
    return opts?.withFileTypes
      ? list.map((name) => ({ name, isDirectory: () => !name.endsWith(".jsonl") }))
      : list;
  };
}

/** Write a session .jsonl and pin BOTH times so the birth/mtime gate is deterministic. */
function writeSessionFile(dir, name, whenMs) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, '{"type":"user","message":{"content":"hi"}}\n');
  utimesSync(path, new Date(whenMs), new Date(whenMs));
  return path;
}

const START = Date.parse("2026-08-11T10:00:00.000Z");
const STARTED_AT = new Date(START).toISOString();

/**
 * utimes cannot rewind birthtime, so gate tests inject statSync to control
 * creation times exactly; other fs deps stay real.
 */
function statWithBirth(bornByPath) {
  return (path) => {
    const st = { birthtimeMs: bornByPath.get(path) ?? 0, mtimeMs: bornByPath.get(path) ?? 0, size: 10, isFile: () => true };
    if (!bornByPath.has(path)) {
      const err = new Error(`ENOENT: ${path}`);
      err.code = "ENOENT";
      throw err;
    }
    return st;
  };
}

describe("run-session-link — candidates", () => {
  test("claude candidates come from the project dir slug of the run cwd (literal + realpath spellings)", () => {
    const home = mkTmp("tq-rsl-home-");
    const cwd = mkTmp("tq-rsl-cwd-");
    const real = realpathSync(cwd);
    // The agent records realpath'd getcwd() while tmux stores the literal cwd.
    const projDir = join(home, ".claude", "projects", claudeProjectSlug(real));
    const path = writeSessionFile(projDir, "abc.jsonl", START + 1000);
    writeSessionFile(projDir, "not-a-session.txt".replace(".txt", ".log"), START + 1000);

    const got = runSessionCandidates({ agent: "claude", cwd, home });
    assert.deepEqual(got.map((c) => c.path), [path]);
    assert.equal(got[0].probePath, path);
    assert.ok(got[0].bornMs > 0);
  });

  test("candidate bornMs uses mtime when birthtime is later than mtime (Linux utimes)", () => {
    const home = mkTmp("tq-rsl-birth-");
    const cwd = mkTmp("tq-rsl-birth-cwd-");
    const real = realpathSync(cwd);
    const projDir = join(home, ".claude", "projects", claudeProjectSlug(real));
    const past = Date.now() - 86_400_000;
    const path = writeSessionFile(projDir, "old.jsonl", past);
    const got = runSessionCandidates({ agent: "claude", cwd, home });
    assert.equal(got[0].path, path);
    assert.ok(
      got[0].bornMs < Date.now() - 3_600_000,
      `bornMs must follow utimes mtime when birthtime cannot rewind, got ${got[0].bornMs}`,
    );
  });

  test("grok candidates are session DIRECTORIES timed by chat_history.jsonl, probed via the file", () => {
    const home = mkTmp("tq-rsl-grok-home-");
    const cwd = mkTmp("tq-rsl-grok-cwd-");
    const real = realpathSync(cwd);
    const sessionDir = join(home, ".grok", "sessions", encodeURIComponent(real), "sess-1");
    const chat = writeSessionFile(sessionDir, "chat_history.jsonl", START + 500);

    const got = runSessionCandidates({ agent: "grok", cwd, home });
    assert.deepEqual(got.map((c) => c.path), [sessionDir]);
    assert.equal(got[0].probePath, chat);
  });

  test("codex candidates are found recursively under dated session dirs", () => {
    const home = mkTmp("tq-rsl-codex-home-");
    const rollout = writeSessionFile(
      join(home, ".codex", "sessions", "2026", "08", "11"),
      "rollout-1.jsonl",
      START + 800,
    );
    const got = runSessionCandidates({ agent: "codex", cwd: "/anywhere", home });
    assert.deepEqual(got.map((c) => c.path), [rollout]);
  });

  test("codex candidates ignore non-rollout .jsonl files (discovery indexes rollout-* only)", () => {
    const home = mkTmp("tq-rsl-codex-filter-home-");
    const dated = join(home, ".codex", "sessions", "2026", "08", "11");
    const rollout = writeSessionFile(dated, "rollout-2.jsonl", START + 800);
    writeSessionFile(dated, "history.jsonl", START + 900);
    const got = runSessionCandidates({ agent: "codex", cwd: "/anywhere", home });
    assert.deepEqual(got.map((c) => c.path), [rollout], "a file discovery never surfaces can never be served");
  });

  test("cursor-agent candidates use the REAL CLI layout: <dashless slug>/agent-transcripts/<uuid>/<uuid>.jsonl", () => {
    // The round-6 defect: attribution scanned root-level *.jsonl under a
    // LEADING-DASH slug, so every real cursor-agent run had zero candidates
    // and pended forever with its transcript on disk.
    const home = mkTmp("tq-rsl-cursor-home-");
    const cwd = mkTmp("tq-rsl-cursor-cwd-");
    const real = realpathSync(cwd);
    const uuid = "2dee89e0-dc77-4582-a230-66bec018fc19";
    const main = writeSessionFile(
      join(home, ".cursor", "projects", cursorProjectSlug(real), "agent-transcripts", uuid),
      `${uuid}.jsonl`,
      START + 1000,
    );
    // Decoys: a subagent transcript (a session's CHILD, never the run's own
    // recording) and the layout round 6 believed in (dash slug, root file).
    writeSessionFile(
      join(home, ".cursor", "projects", cursorProjectSlug(real), "agent-transcripts", uuid, "subagents"),
      "sub-1.jsonl",
      START + 1100,
    );
    writeSessionFile(join(home, ".cursor", "projects", claudeProjectSlug(real)), "sess-legacy.jsonl", START + 1200);

    const got = runSessionCandidates({ agent: "cursor-agent", cwd, home });
    assert.deepEqual(got.map((c) => c.path), [main]);
    assert.equal(got[0].probePath, main);

    // …and discovery sees exactly the same recording as the run's MAIN one.
    const discovered = withHome(home, () => findCursorSessions(null, []));
    assert.ok(
      discovered.some((s) => s.path === main && !s.parentSession),
      "attribution's candidate is discovery's main cursor session",
    );
  });

  test("droid candidates are workspace-root recordings (<root>/ws<slug>/*.jsonl), like findFactorySessions", () => {
    const home = mkTmp("tq-rsl-factory-home-");
    const ws = join(home, ".factory", "sessions", "ws-w-proj");
    const rec = writeSessionFile(ws, "sess-1.jsonl", START + 400);
    // Nested files are not part of the factory layout — discovery never
    // indexes them, so attribution must not admit them either.
    writeSessionFile(join(ws, "nested"), "deep.jsonl", START + 500);
    const got = runSessionCandidates({ agent: "droid", cwd: "/w/proj", home });
    assert.deepEqual(got.map((c) => c.path), [rec]);
  });

  test("agents without a followable file recording answer no candidates", () => {
    const home = mkTmp("tq-rsl-none-home-");
    // opencode's rows live in ONE shared SQLite file (no per-session birth
    // time, one fd held for every session at once) — honest [] beats a
    // birth/pid tier that would fire for unrelated sessions.
    for (const agent of ["opencode", "gemini", "unknown"]) {
      assert.deepEqual(runSessionCandidates({ agent, cwd: "/w", home }), []);
    }
  });
});

describe("run-session-link — resolution", () => {
  test("only recordings created at/after the run start survive the gate (slack allowed)", () => {
    const home = "/h";
    const projDir = join(home, ".claude", "projects", claudeProjectSlug("/w"));
    const oldSession = join(projDir, "old.jsonl");
    const newSession = join(projDir, "new.jsonl");
    const born = new Map([
      [oldSession, START - CANDIDATE_SLACK_MS - 60_000], // the user's own pre-existing session
      [newSession, START + 1500],
    ]);
    const deps = {
      readdirSync: () => ["old.jsonl", "new.jsonl"],
      statSync: statWithBirth(born),
      realpathSync: (p) => p,
    };
    const got = resolveRunSessionPath({ agent: "claude", cwd: "/w", startedAt: STARTED_AT, home }, deps);
    assert.equal(got, newSession);
  });

  test("no candidate after the gate resolves to null (run stays pending)", () => {
    const home = "/h";
    const projDir = join(home, ".claude", "projects", claudeProjectSlug("/w"));
    const oldSession = join(projDir, "old.jsonl");
    const deps = {
      readdirSync: () => ["old.jsonl"],
      statSync: statWithBirth(new Map([[oldSession, START - 60_000]])),
      realpathSync: (p) => p,
    };
    assert.equal(
      resolveRunSessionPath({ agent: "claude", cwd: "/w", startedAt: STARTED_AT, home }, deps),
      null,
    );
  });

  test("an unparsable or missing tq_started never links", () => {
    for (const startedAt of ["", "not-a-time", undefined]) {
      assert.equal(
        resolveRunSessionPath({ agent: "claude", cwd: "/w", startedAt, home: "/h" }, { readdirSync: () => [] }),
        null,
      );
    }
  });

  test("two unvouched candidates select NOTHING — a guess needs a sole candidate (the r5 ambiguity rule)", () => {
    const home = "/h";
    const projDir = join(home, ".claude", "projects", claudeProjectSlug("/w"));
    const a = join(projDir, "a.jsonl");
    const b = join(projDir, "b.jsonl");
    const c = join(projDir, "c.jsonl");
    const born = new Map([
      [a, START + 100],
      [b, START + 200],
      [c, START + 300],
    ]);
    const base = {
      readdirSync: () => ["a.jsonl", "b.jsonl", "c.jsonl"],
      statSync: statWithBirth(born),
      realpathSync: (p) => p,
    };

    // Three files born after the run start, none vouched for by any
    // process tree: birth order is not identity, an anonymous fd holder
    // is not identity — nothing may be guessed. Prefer pending over wrong.
    const ambiguous = resolveRunSessionPath(
      { agent: "claude", cwd: "/w", startedAt: STARTED_AT, home },
      { ...base, openPathHolders: (paths) => new Map(paths.filter((p) => p === c).map((p) => [p, new Set(["999"])])) },
    );
    assert.equal(ambiguous, null, "two+ eligible candidates: birth order selects nothing");

    // Excluding all but one restores the guess: claims by other runs carve
    // the candidate space down to a sole honest candidate.
    const sole = resolveRunSessionPath(
      { agent: "claude", cwd: "/w", startedAt: STARTED_AT, home, exclude: new Set([a, b]) },
      { ...base, openPathHolders: () => new Map() },
    );
    assert.equal(sole, c);
  });
});

describe("run-session-link — pid attribution (identity, not heuristics)", () => {
  const home = "/h";
  const projDir = join(home, ".claude", "projects", claudeProjectSlug("/w"));
  const file = (name) => join(projDir, name);

  /** deps with injectable holder map and per-root process trees. */
  function attDeps(born, { holders = new Map(), trees = new Map() } = {}) {
    return {
      readdirSync: () => [...born.keys()].map((p) => p.split("/").pop()),
      statSync: statWithBirth(born),
      realpathSync: (p) => p,
      openPathHolders: () => holders,
      descendantPids: (pid) => trees.get(String(pid)) ?? new Set([String(pid)]),
    };
  }

  test("a candidate held open by THIS run's process tree is pid-confirmed", () => {
    const mine = file("mine.jsonl");
    const born = new Map([[mine, START + 500]]);
    const att = attributeRunSession(
      { agent: "claude", cwd: "/w", startedAt: STARTED_AT, home, panePid: "100" },
      attDeps(born, {
        holders: new Map([[mine, new Set(["101"])]]),
        trees: new Map([["100", new Set(["100", "101"])]]),
      }),
    );
    assert.equal(att.confirmed, mine);
    assert.equal(att.foreign.size, 0);
  });

  test("a candidate held open by a RIVAL run's tree is foreign — never linkable here", () => {
    const theirs = file("theirs.jsonl");
    const born = new Map([[theirs, START + 1500]]);
    const att = attributeRunSession(
      {
        agent: "claude", cwd: "/w", startedAt: STARTED_AT, home, panePid: "100",
        rivals: [{ startedMs: START + 1000, panePid: "200" }],
      },
      attDeps(born, {
        holders: new Map([[theirs, new Set(["201"])]]),
        trees: new Map([
          ["100", new Set(["100", "101"])],
          ["200", new Set(["200", "201"])],
        ]),
      }),
    );
    assert.equal(att.confirmed, null);
    assert.ok(att.foreign.has(theirs));
    assert.equal(att.heuristic, null, "a foreign file must never even be a guess");
  });

  test("a contested candidate (rival's birth gate also admits it) needs pid evidence — no guess", () => {
    const ambiguous = file("ambiguous.jsonl");
    const born = new Map([[ambiguous, START + 1500]]);
    const att = attributeRunSession(
      {
        agent: "claude", cwd: "/w", startedAt: STARTED_AT, home, panePid: "100",
        rivals: [{ startedMs: START + 1000, panePid: "200" }],
      },
      attDeps(born, { holders: new Map() }),
    );
    assert.equal(att.confirmed, null);
    assert.equal(att.heuristic, null, "nobody may claim a contested file on birth time alone");
    assert.equal(att.eligible.size, 0);
  });

  test("a file born BEFORE every rival's gate stays an uncontested heuristic", () => {
    const mine = file("mine.jsonl");
    const born = new Map([[mine, START + 500]]);
    const att = attributeRunSession(
      {
        agent: "claude", cwd: "/w", startedAt: STARTED_AT, home,
        // The rival started long after this file was created — its own birth
        // gate excludes the file, so it cannot contest.
        rivals: [{ startedMs: START + 60_000, panePid: "200" }],
      },
      attDeps(born, { holders: new Map() }),
    );
    assert.equal(att.heuristic, mine);
  });
});

describe("run-session-link — linkRunSession", () => {
  const win = (options = {}, extra = {}) => ({
    id: "@5",
    name: "claude",
    dead: false,
    panePid: "",
    options: { tq_agent: "claude", tq_cwd: "/w", tq_started: STARTED_AT, tq_session: "", tq_session_attr: "", ...options },
    ...extra,
  });

  test("a pid-confirmed persisted tq_session wins without any resolution or persist call", () => {
    const persistCalls = [];
    const got = linkRunSession(
      win({ tq_session: "/h/.claude/projects/-w/s.jsonl", tq_session_attr: "pid" }),
      [],
      {
        deps: {
          isSessionPath: () => true,
          setWindowOption: (...args) => persistCalls.push(args),
          readdirSync: () => {
            throw new Error("resolution must not run");
          },
        },
      },
    );
    assert.deepEqual(got, { path: "/h/.claude/projects/-w/s.jsonl", link: "linked", attribution: "pid" });
    assert.equal(persistCalls.length, 0);
  });

  test("a persisted HEURISTIC link is re-validated every poll while the run lives", () => {
    const home = "/h";
    const projDir = join(home, ".claude", "projects", claudeProjectSlug("/w"));
    const s = join(projDir, "s.jsonl");
    // Still the only uncontested candidate: the guess keeps being served…
    const kept = linkRunSession(win({ tq_session: s, tq_session_attr: "heur" }), [], {
      home,
      deps: {
        isSessionPath: () => true,
        readdirSync: () => ["s.jsonl"],
        statSync: statWithBirth(new Map([[s, START + 100]])),
        realpathSync: (p) => p,
        setWindowOption: () => {},
      },
    });
    assert.deepEqual(kept, { path: s, link: "linked", attribution: "heuristic" });

    // …and UPGRADED to pid identity the moment the run's own tree is seen
    // holding the recording open.
    const persistCalls = [];
    const upgraded = linkRunSession(win({ tq_session: s, tq_session_attr: "heur" }, { panePid: "100" }), [], {
      home,
      deps: {
        isSessionPath: () => true,
        readdirSync: () => ["s.jsonl"],
        statSync: statWithBirth(new Map([[s, START + 100]])),
        realpathSync: (p) => p,
        openPathHolders: () => new Map([[s, new Set(["100"])]]),
        descendantPids: (pid) => new Set([String(pid)]),
        setWindowOption: (...args) => persistCalls.push(args),
      },
    });
    assert.deepEqual(upgraded, { path: s, link: "linked", attribution: "pid" });
    assert.deepEqual(persistCalls, [["@5", "tq_session", s], ["@5", "tq_session_attr", "pid"]]);
  });

  test("a persisted heuristic link on an EXITED run is final while it was unambiguous at death", () => {
    const home = "/h";
    const projDir = join(home, ".claude", "projects", claudeProjectSlug("/w"));
    const s = join(projDir, "s.jsonl");
    const ENDED = new Date(START + 5000).toISOString();
    const persisted = [];
    const got = linkRunSession(
      win({ tq_session: s, tq_session_attr: "heur", tq_ended: ENDED }, { dead: true }),
      [],
      {
        home,
        deps: {
          isSessionPath: () => true,
          readdirSync: () => ["s.jsonl"],
          statSync: statWithBirth(new Map([[s, START + 100]])),
          realpathSync: (p) => p,
          setWindowOption: (...args) => persisted.push(args),
        },
      },
    );
    assert.deepEqual(got, { path: s, link: "linked", attribution: "heuristic" });
    assert.equal(persisted.length, 0, "an already-stamped unambiguous final answer persists nothing new");
  });

  test("the exit boundary is stamped once (tq_ended) and later-born candidates never demote the settled guess", () => {
    const home = "/h";
    const projDir = join(home, ".claude", "projects", claudeProjectSlug("/w"));
    const s = join(projDir, "s.jsonl");
    const late = join(projDir, "late.jsonl");
    const ENDED = new Date(START + 5000).toISOString();

    // First poll that observes the death stamps tq_ended.
    const stamped = [];
    const w1 = win({ tq_session: s, tq_session_attr: "heur" }, { dead: true });
    const got1 = linkRunSession(w1, [], {
      home,
      deps: {
        isSessionPath: () => true,
        readdirSync: () => ["s.jsonl"],
        statSync: statWithBirth(new Map([[s, START + 100]])),
        realpathSync: (p) => p,
        setWindowOption: (...args) => stamped.push(args),
      },
    });
    assert.deepEqual(got1, { path: s, link: "linked", attribution: "heuristic" });
    assert.equal(stamped.length, 1);
    assert.deepEqual(stamped[0].slice(0, 2), ["@5", "tq_ended"]);
    assert.ok(Date.parse(stamped[0][2]) > 0, "the boundary is an ISO time");

    // A rival candidate born AFTER the boundary (the user opens a session
    // an hour later) is OUT of the dead run's candidate space: the guess
    // that was unique for the whole live window stays the final answer.
    const persisted = [];
    const got2 = linkRunSession(
      win({ tq_session: s, tq_session_attr: "heur", tq_ended: ENDED }, { dead: true }),
      [],
      {
        home,
        deps: {
          isSessionPath: () => true,
          readdirSync: () => ["s.jsonl", "late.jsonl"],
          statSync: statWithBirth(new Map([[s, START + 100], [late, START + 3_600_000]])),
          realpathSync: (p) => p,
          setWindowOption: (...args) => persisted.push(args),
        },
      },
    );
    assert.deepEqual(got2, { path: s, link: "linked", attribution: "heuristic" },
      "a post-exit candidate must never demote a settled unique guess");
    assert.equal(persisted.length, 0);
  });

  test("a guess that was AMBIGUOUS at death is never finalized — cleared and pending, even seen only after the exit", () => {
    const home = "/h";
    const projDir = join(home, ".claude", "projects", claudeProjectSlug("/w"));
    const s = join(projDir, "s.jsonl");
    const other = join(projDir, "other.jsonl");
    const ENDED = new Date(START + 5000).toISOString();
    // Both candidates born within the run's live window [started, ended]:
    // the persisted guess could just as well be the other file's twin.
    const persisted = [];
    const got = linkRunSession(
      win({ tq_session: s, tq_session_attr: "heur", tq_ended: ENDED }, { dead: true }),
      [],
      {
        home,
        deps: {
          isSessionPath: () => true,
          readdirSync: () => ["s.jsonl", "other.jsonl"],
          statSync: statWithBirth(new Map([[s, START + 100], [other, START + 900]])),
          realpathSync: (p) => p,
          setWindowOption: (...args) => persisted.push(args),
        },
      },
    );
    assert.deepEqual(got, { path: null, link: "pending", attribution: null },
      "an exited run must not finalize a guess that was ambiguous at death");
    assert.deepEqual(persisted, [["@5", "tq_session", ""], ["@5", "tq_session_attr", ""]],
      "the ambiguous claim is cleared from tmux, not kept");
  });

  test("a fresh uncontested resolution is persisted as a GUESS (@tq_session + attr heur)", () => {
    const home = "/h";
    const projDir = join(home, ".claude", "projects", claudeProjectSlug("/w"));
    const s = join(projDir, "s.jsonl");
    const persistCalls = [];
    const got = linkRunSession(win(), [], {
      home,
      deps: {
        isSessionPath: () => false,
        readdirSync: () => ["s.jsonl"],
        statSync: statWithBirth(new Map([[s, START + 100]])),
        realpathSync: (p) => p,
        setWindowOption: (...args) => persistCalls.push(args),
      },
    });
    assert.deepEqual(got, { path: s, link: "linked", attribution: "heuristic" });
    assert.deepEqual(persistCalls, [["@5", "tq_session", s], ["@5", "tq_session_attr", "heur"]]);
  });

  test("a pid-confirmed resolution is persisted as identity (attr pid)", () => {
    const home = "/h";
    const projDir = join(home, ".claude", "projects", claudeProjectSlug("/w"));
    const s = join(projDir, "s.jsonl");
    const persistCalls = [];
    const got = linkRunSession(win({}, { panePid: "100" }), [], {
      home,
      deps: {
        isSessionPath: () => false,
        readdirSync: () => ["s.jsonl"],
        statSync: statWithBirth(new Map([[s, START + 100]])),
        realpathSync: (p) => p,
        openPathHolders: () => new Map([[s, new Set(["101"])]]),
        descendantPids: (pid) => (String(pid) === "100" ? new Set(["100", "101"]) : new Set()),
        setWindowOption: (...args) => persistCalls.push(args),
      },
    });
    assert.deepEqual(got, { path: s, link: "linked", attribution: "pid" });
    assert.deepEqual(persistCalls, [["@5", "tq_session", s], ["@5", "tq_session_attr", "pid"]]);
  });

  test("a stale persisted path is ignored and other runs' pid-claims are excluded", () => {
    const home = "/h";
    const projDir = join(home, ".claude", "projects", claudeProjectSlug("/w"));
    const claimed = join(projDir, "claimed.jsonl");
    const mine = join(projDir, "mine.jsonl");
    const other = { id: "@9", options: { tq_agent: "claude", tq_cwd: "/w", tq_started: STARTED_AT, tq_session: claimed, tq_session_attr: "pid" } };
    const got = linkRunSession(win({ tq_session: "/gone/stale.jsonl" }), [other], {
      home,
      deps: {
        isSessionPath: () => false, // the stale persisted path no longer validates
        readdirSync: () => ["claimed.jsonl", "mine.jsonl"],
        statSync: statWithBirth(new Map([[claimed, START + 100], [mine, START + 200]])),
        realpathSync: (p) => p,
        openPathHolders: () => new Map(),
        setWindowOption: () => {},
      },
    });
    assert.deepEqual(got, { path: mine, link: "linked", attribution: "heuristic" });
  });

  test("no resolvable recording answers a pending link and persists nothing", () => {
    const persistCalls = [];
    const got = linkRunSession(win(), [], {
      home: "/h",
      deps: {
        isSessionPath: () => false,
        readdirSync: () => [],
        setWindowOption: (...args) => persistCalls.push(args),
      },
    });
    assert.deepEqual(got, { path: null, link: "pending", attribution: null });
    assert.equal(persistCalls.length, 0);
  });

  test("a failed persist still answers the link (best-effort persistence)", () => {
    const home = "/h";
    const projDir = join(home, ".claude", "projects", claudeProjectSlug("/w"));
    const s = join(projDir, "s.jsonl");
    const got = linkRunSession(win(), [], {
      home,
      deps: {
        isSessionPath: () => false,
        readdirSync: () => ["s.jsonl"],
        statSync: statWithBirth(new Map([[s, START + 100]])),
        realpathSync: (p) => p,
        setWindowOption: () => {
          throw new Error("tmux gone");
        },
      },
    });
    assert.deepEqual(got, { path: s, link: "linked", attribution: "heuristic" });
  });
});

describe("run-session-link — two runs, one cwd (round-1 mislink regression)", () => {
  const home = "/h";
  const projDir = join(home, ".claude", "projects", claudeProjectSlug("/w"));
  const fileA = join(projDir, "slow-agent.jsonl");
  const fileB = join(projDir, "fast-agent.jsonl");
  const A_STARTED = STARTED_AT; // run A starts first…
  const B_STARTED = new Date(START + 1000).toISOString(); // …run B one second later

  const winA = (options = {}) => ({
    id: "@1",
    dead: false,
    panePid: "100",
    options: { tq_agent: "claude", tq_cwd: "/w", tq_started: A_STARTED, tq_session: "", tq_session_attr: "", ...options },
  });
  const winB = (options = {}) => ({
    id: "@2",
    dead: false,
    panePid: "200",
    options: { tq_agent: "claude", tq_cwd: "/w", tq_started: B_STARTED, tq_session: "", tq_session_attr: "", ...options },
  });
  const trees = new Map([
    ["100", new Set(["100", "101"])],
    ["200", new Set(["200", "201"])],
  ]);

  /** deps for a given on-disk state (files + holders); persists into `persisted`. */
  function mkDeps({ files, holders, persisted }) {
    return {
      isSessionPath: (p) => files.has(p),
      readdirSync: () => [...files.keys()].map((p) => p.split("/").pop()),
      statSync: statWithBirth(files),
      realpathSync: (p) => p,
      openPathHolders: () => holders,
      descendantPids: (pid) => trees.get(String(pid)) ?? new Set([String(pid)]),
      setWindowOption: (id, name, value) => persisted.push([id, name, value]),
    };
  }

  test("the slow run NEVER claims the fast run's recording; both resolve to their own", () => {
    // Phase 1: only B's recording exists (A's agent is slow to write —
    // trust prompt, MCP handshake). B's process holds it open.
    const phase1 = {
      files: new Map([[fileB, START + 1200]]),
      holders: new Map([[fileB, new Set(["201"])]]),
      persisted: [],
    };
    const a1 = linkRunSession(winA(), [winA(), winB()], { home, deps: mkDeps(phase1) });
    assert.deepEqual(a1, { path: null, link: "pending", attribution: null },
      "run A must stay pending — B's recording is foreign, not A's earliest candidate");

    const b1 = linkRunSession(winB(), [winA(), winB()], { home, deps: mkDeps(phase1) });
    assert.deepEqual(b1, { path: fileB, link: "linked", attribution: "pid" });
    assert.deepEqual(phase1.persisted, [["@2", "tq_session", fileB], ["@2", "tq_session_attr", "pid"]],
      "only B's pid-confirmed link is persisted — A persists nothing");

    // Phase 2: A's recording finally appears (held by A's tree); B's link is
    // already settled as identity.
    const phase2 = {
      files: new Map([[fileB, START + 1200], [fileA, START + 5000]]),
      holders: new Map([[fileB, new Set(["201"])], [fileA, new Set(["101"])]]),
      persisted: [],
    };
    const bLinked = winB({ tq_session: fileB, tq_session_attr: "pid" });
    const a2 = linkRunSession(winA(), [winA(), bLinked], { home, deps: mkDeps(phase2) });
    assert.deepEqual(a2, { path: fileA, link: "linked", attribution: "pid" },
      "run A links its OWN recording once its agent writes it");
    const b2 = linkRunSession(bLinked, [winA(), bLinked], { home, deps: mkDeps(phase2) });
    assert.deepEqual(b2, { path: fileB, link: "linked", attribution: "pid" });
  });

  test("contested without pid evidence: NOBODY guesses (correctness beats availability)", () => {
    // B's recording exists but no process holds it open at probe time.
    const state = {
      files: new Map([[fileB, START + 1200]]),
      holders: new Map(),
      persisted: [],
    };
    const a = linkRunSession(winA(), [winA(), winB()], { home, deps: mkDeps(state) });
    const b = linkRunSession(winB(), [winA(), winB()], { home, deps: mkDeps(state) });
    assert.equal(a.link, "pending", "A may not birth-time-guess a contested file");
    assert.equal(b.link, "pending", "B may not either — pid evidence decides");
    assert.equal(state.persisted.length, 0);
  });

  test("a round-1 poisoned link (legacy sticky guess) heals instead of surviving forever", () => {
    // Round-1 state: A sticky-persisted B's recording with no attr; B unlinked.
    const state = {
      files: new Map([[fileB, START + 1200]]),
      holders: new Map([[fileB, new Set(["201"])]]),
      persisted: [],
    };
    const poisonedA = winA({ tq_session: fileB, tq_session_attr: "" });
    const a = linkRunSession(poisonedA, [poisonedA, winB()], { home, deps: mkDeps(state) });
    assert.deepEqual({ path: a.path, link: a.link }, { path: null, link: "pending" },
      "the poisoned link is dropped, not served");
    assert.deepEqual(state.persisted, [["@1", "tq_session", ""], ["@1", "tq_session_attr", ""]],
      "the poisoned claim is cleared from tmux so the true owner can claim it");

    const b = linkRunSession(winB(), [poisonedA, winB()], { home, deps: mkDeps(state) });
    assert.equal(b.path, fileB, "B claims its own recording despite A's stale claim");
    assert.equal(b.attribution, "pid");
  });
});

describe("run-session-link — spawn identity (tq_session_id, the r2 fd-holding fix)", () => {
  const home = "/h";
  const UUID = "3f2b8a10-1111-4222-8333-444455556666";
  const projDir = join(home, ".claude", "projects", claudeProjectSlug("/w"));
  const ownFile = join(projDir, `${UUID}.jsonl`);
  const userFile = join(projDir, "users-own-chat.jsonl");

  const idWin = (options = {}, extra = {}) => ({
    id: "@5",
    dead: false,
    panePid: "100",
    options: {
      tq_agent: "claude", tq_cwd: "/w", tq_started: STARTED_AT,
      tq_session: "", tq_session_attr: "", tq_session_id: UUID, ...options,
    },
    ...extra,
  });

  /** deps for on-disk state; NOTHING holds any fd open (real claude behavior). */
  function mkDeps(files, persisted) {
    return {
      isSessionPath: (p) => files.has(p),
      readdirSync: () => [...files.keys()].map((p) => p.split("/").pop()),
      statSync: statWithBirth(files),
      realpathSync: (p) => p,
      openPathHolders: () => new Map(),
      descendantPids: (pid) => new Set([String(pid)]),
      setWindowOption: (id, name, value) => persisted.push([id, name, value]),
    };
  }

  test("every agent with a session-id launch flag has a determined recording layout", () => {
    // The tier-0 guarantee only holds while these two stay in sync: an
    // agent handed a uuid at spawn must have a computable expected path.
    for (const entry of AGENT_REGISTRY) {
      if (!agentSupportsSessionId(entry.id)) continue;
      const paths = expectedSessionPaths(
        { agent: entry.id, cwd: "/w", sessionId: UUID, home },
        { realpathSync: (p) => p },
      );
      assert.ok(paths.length > 0, `${entry.id} accepts --session-id but has no expected-path layout`);
    }
  });

  test("expectedSessionPaths covers both cwd spellings for claude and grok", () => {
    const deps = { realpathSync: (p) => (p === "/w" ? "/private/w" : p) };
    assert.deepEqual(
      expectedSessionPaths({ agent: "claude", cwd: "/w", sessionId: UUID, home }, deps),
      [
        join(home, ".claude", "projects", claudeProjectSlug("/w"), `${UUID}.jsonl`),
        join(home, ".claude", "projects", claudeProjectSlug("/private/w"), `${UUID}.jsonl`),
      ],
    );
    assert.deepEqual(
      expectedSessionPaths({ agent: "grok", cwd: "/w", sessionId: UUID, home }, deps),
      [
        join(home, ".grok", "sessions", encodeURIComponent("/w"), UUID),
        join(home, ".grok", "sessions", encodeURIComponent("/private/w"), UUID),
      ],
    );
    // No uuid, no cwd, or an unmapped agent answer [] — never a throw.
    assert.deepEqual(expectedSessionPaths({ agent: "claude", cwd: "/w", sessionId: "", home }, deps), []);
    assert.deepEqual(expectedSessionPaths({ agent: "claude", cwd: "", sessionId: UUID, home }, deps), []);
    assert.deepEqual(expectedSessionPaths({ agent: "codex", cwd: "/w", sessionId: UUID, home }, deps), []);
  });

  test("spawnIdentitySessionPath answers the uuid recording once it exists, null before", () => {
    const none = spawnIdentitySessionPath(
      { agent: "claude", cwd: "/w", sessionId: UUID, home },
      { realpathSync: (p) => p, statSync: statWithBirth(new Map()) },
    );
    assert.equal(none, null);
    const found = spawnIdentitySessionPath(
      { agent: "claude", cwd: "/w", sessionId: UUID, home },
      { realpathSync: (p) => p, statSync: statWithBirth(new Map([[ownFile, START + 900]])) },
    );
    assert.equal(found, ownFile);
  });

  test("an identified run links ONLY its uuid recording — with NO process holding any fd", () => {
    // Both the run's own recording and the user's session exist; nothing is
    // held open (real claude appends open/write/close). Identity still
    // resolves deterministically.
    const persisted = [];
    const files = new Map([[userFile, START + 400], [ownFile, START + 900]]);
    const got = linkRunSession(idWin(), [], { home, deps: mkDeps(files, persisted) });
    assert.deepEqual(got, { path: ownFile, link: "linked", attribution: "sid" });
    assert.deepEqual(persisted, [["@5", "tq_session", ownFile], ["@5", "tq_session_attr", "sid"]]);
  });

  test("the user's own session in the same cwd is NEVER served: the run stays pending until ITS file appears", () => {
    // r2 scenario (b): a user session born AFTER the run's start in the
    // same cwd used to be heuristic-linked. With spawn identity the run
    // has exactly one possible recording; anything else is untouchable.
    const persisted = [];
    const onlyUsers = new Map([[userFile, START + 400]]);
    const got = linkRunSession(idWin(), [], { home, deps: mkDeps(onlyUsers, persisted) });
    assert.deepEqual(got, { path: null, link: "pending", attribution: null });
    assert.equal(persisted.length, 0, "nothing may be persisted while pending");
  });

  test("two identified runs in one cwd, neither holding an fd: both link their own recording", () => {
    // r2 scenario (a): two concurrent non-holding runs in one cwd used to
    // deadlock as contested-forever. Identity makes both deterministic.
    const UUID_B = "9d1c0e20-2222-4333-8444-555566667777";
    const ownB = join(projDir, `${UUID_B}.jsonl`);
    const winA = idWin();
    const winB = idWin({ tq_session_id: UUID_B, tq_started: new Date(START + 300).toISOString() }, { id: "@6" });
    const files = new Map([[ownFile, START + 900], [ownB, START + 1000]]);
    const a = linkRunSession(winA, [winA, winB], { home, deps: mkDeps(files, []) });
    const b = linkRunSession(winB, [winA, winB], { home, deps: mkDeps(files, []) });
    assert.deepEqual({ path: a.path, attribution: a.attribution }, { path: ownFile, attribution: "sid" });
    assert.deepEqual({ path: b.path, attribution: b.attribution }, { path: ownB, attribution: "sid" });
  });

  test("a persisted sid link is sticky — no re-resolution, no persist call", () => {
    const persisted = [];
    const got = linkRunSession(
      idWin({ tq_session: ownFile, tq_session_attr: "sid" }),
      [],
      {
        home,
        deps: {
          isSessionPath: () => true,
          realpathSync: (p) => p,
          setWindowOption: (...args) => persisted.push(args),
          readdirSync: () => {
            throw new Error("resolution must not run");
          },
        },
      },
    );
    assert.deepEqual(got, { path: ownFile, link: "linked", attribution: "sid" });
    assert.equal(persisted.length, 0);
  });

  test("a stale pre-upgrade heuristic claim on an identified run is dropped and cleared — even on an exited run", () => {
    // r2 restart-survival scenario: a poisoned heur link (the user's
    // session) persisted before the upgrade must not be served for one
    // more poll, and must not "finalize" on exit either.
    for (const dead of [false, true]) {
      const persisted = [];
      const poisoned = idWin({ tq_session: userFile, tq_session_attr: "heur" }, { dead });
      const got = linkRunSession(poisoned, [], { home, deps: mkDeps(new Map([[userFile, START + 400]]), persisted) });
      assert.deepEqual(got, { path: null, link: "pending", attribution: null },
        `dead=${dead}: the poisoned claim must be dropped, not served`);
      // A freshly observed exit stamps its boundary first (tq_ended).
      const linkCalls = persisted.filter(([, name]) => name !== "tq_ended");
      assert.deepEqual(linkCalls, [["@5", "tq_session", ""], ["@5", "tq_session_attr", ""]],
        `dead=${dead}: the poisoned claim is cleared from tmux`);
    }
  });

  test("a non-identified run can never steal an identified run's determined recording — even before it links", () => {
    // Legacy window (no tq_session_id) races an identified rival whose
    // recording already exists but is claimed by nobody's fd. The legacy
    // run must not heuristically grab the uuid file.
    const persisted = [];
    const legacy = idWin({ tq_session_id: "" }, { id: "@9" });
    const identified = idWin();
    const files = new Map([[ownFile, START + 900]]);
    const got = linkRunSession(legacy, [legacy, identified], { home, deps: mkDeps(files, persisted) });
    assert.deepEqual(got, { path: null, link: "pending", attribution: null },
      "the identified rival's uuid recording is excluded from the legacy run's candidates");
    assert.equal(persisted.length, 0);
  });

  test("identified rivals do not contest a legacy run's OWN uncontested candidate", () => {
    // The identified rival can only ever own its uuid file, so a different
    // candidate stays claimable by the legacy run instead of being
    // contested into pending-forever.
    const legacyFile = join(projDir, "legacy-agent.jsonl");
    const legacy = idWin({ tq_session_id: "" }, { id: "@9" });
    const identified = idWin();
    const files = new Map([[legacyFile, START + 700], [ownFile, START + 900]]);
    const got = linkRunSession(legacy, [legacy, identified], { home, deps: mkDeps(files, []) });
    assert.deepEqual({ path: got.path, attribution: got.attribution },
      { path: legacyFile, attribution: "heuristic" });
  });
});

describe("run-session-link — prompt corroboration (content identity)", () => {
  test("promptCorroborates: exact match for unclipped prompts, prefix for clipped, never empty", () => {
    assert.equal(promptCorroborates("fix the bug", "fix the bug"), true);
    assert.equal(promptCorroborates("  fix   the\tbug ", "fix the bug"), true, "whitespace collapses");
    assert.equal(promptCorroborates("fix the bug please", "fix the bug"), false, "unclipped needs EXACT");
    assert.equal(promptCorroborates("fix the bugs", "fix the bug"), false);
    const long = "x".repeat(139);
    assert.equal(promptCorroborates(`${long} and much more tail`, `${long}…`), true, "clipped prompt matches by prefix");
    assert.equal(promptCorroborates("totally different", `${long}…`), false);
    assert.equal(promptCorroborates("", "fix"), false);
    assert.equal(promptCorroborates("fix", ""), false);
    assert.equal(promptCorroborates(null, null), false);
    assert.equal(promptCorroborates("anything", "…"), false, "a bare ellipsis prompt matches nothing");
  });

  const home = "/h";
  // cursor-agent: NON-identity (no --session-id), cwd-scoped claude-style layout.
  // REAL cursor layout: <dashless slug>/agent-transcripts/<id>/<id>.jsonl
  const rec = (id) => cursorRecording(home, "/w", id);
  const file = (name) => rec(name.replace(/\.jsonl$/, ""));
  const A_STARTED = STARTED_AT;
  const B_STARTED = new Date(START + 200).toISOString();

  const mkWin = (id, prompt, startedAt, options = {}, extra = {}) => ({
    id,
    dead: false,
    panePid: "",
    options: {
      tq_agent: "cursor-agent", tq_cwd: "/w", tq_started: startedAt,
      tq_session: "", tq_session_attr: "", tq_prompt: prompt, ...options,
    },
    ...extra,
  });

  /** deps: no fd holders anywhere (real non-holding CLIs); first prompts injected. */
  function mkDeps({ files, firsts, persisted }) {
    return {
      isSessionPath: (p) => files.has(p),
      readdirSync: fakeReaddir(() => files.keys()),
      statSync: statWithBirth(files),
      realpathSync: (p) => p,
      openPathHolders: () => new Map(),
      descendantPids: (pid) => new Set([String(pid)]),
      firstUserPrompt: (c) => firsts.get(c.path) ?? null,
      setWindowOption: (id, name, value) => persisted.push([id, name, value]),
    };
  }

  test("two live prompted runs, one cwd: prompt content disambiguates — both link their OWN recording", () => {
    // The exact Cursor reference scenario for non-identity agents: both
    // recordings are contested by birth time, but each one's first user
    // message matches exactly one run's prompt.
    const fA = file("sess-slow.jsonl");
    const fB = file("sess-fast.jsonl");
    const state = {
      files: new Map([[fB, START + 1200], [fA, START + 4000]]),
      firsts: new Map([[fB, "fast-beta"], [fA, "slow-alpha"]]),
      persisted: [],
    };
    const winA = mkWin("@1", "slow-alpha", A_STARTED);
    const winB = mkWin("@2", "fast-beta", B_STARTED);
    const a = linkRunSession(winA, [winA, winB], { home, deps: mkDeps(state), tombstones: [] });
    const b = linkRunSession(winB, [winA, winB], { home, deps: mkDeps(state), tombstones: [] });
    assert.deepEqual(a, { path: fA, link: "linked", attribution: "prompt" });
    assert.deepEqual(b, { path: fB, link: "linked", attribution: "prompt" });
  });

  test("identical prompts prove nothing: both runs stay pending (prefer pending over wrong)", () => {
    const fB = file("sess-fast.jsonl");
    const state = {
      files: new Map([[fB, START + 1200]]),
      firsts: new Map([[fB, "same-prompt"]]),
      persisted: [],
    };
    const winA = mkWin("@1", "same-prompt", A_STARTED);
    const winB = mkWin("@2", "same-prompt", B_STARTED);
    const a = linkRunSession(winA, [winA, winB], { home, deps: mkDeps(state), tombstones: [] });
    const b = linkRunSession(winB, [winA, winB], { home, deps: mkDeps(state), tombstones: [] });
    assert.equal(a.link, "pending");
    assert.equal(b.link, "pending");
    assert.equal(state.persisted.length, 0);
  });

  test("a prompted run never links a recording whose first message mismatches its own prompt — even with no rival in sight", () => {
    // The tombstone-less launder path (window killed directly in tmux):
    // self-recognition alone must refuse the foreign transcript.
    const fB = file("sess-fast.jsonl");
    const state = {
      files: new Map([[fB, START + 1200]]),
      firsts: new Map([[fB, "fast-beta"]]),
      persisted: [],
    };
    const winA = mkWin("@1", "slow-alpha", A_STARTED);
    const a = linkRunSession(winA, [winA], { home, deps: mkDeps(state), tombstones: [] });
    assert.deepEqual(a, { path: null, link: "pending", attribution: null });
    assert.equal(state.persisted.length, 0);
  });

  test("a recording with NO user message yet stays heuristically linkable (then re-validated each poll)", () => {
    const fA = file("sess-own.jsonl");
    const state = {
      files: new Map([[fA, START + 1200]]),
      firsts: new Map([[fA, null]]),
      persisted: [],
    };
    const winA = mkWin("@1", "slow-alpha", A_STARTED);
    const a = linkRunSession(winA, [winA], { home, deps: mkDeps(state), tombstones: [] });
    assert.deepEqual({ path: a.path, attribution: a.attribution }, { path: fA, attribution: "heuristic" });
  });

  test("bare run + prompted rival: the rival's recording is FOREIGN, the bare run's own file links once the rival's prompt disowns it", () => {
    const fA = file("sess-user-typed.jsonl");
    const fB = file("sess-fast.jsonl");
    const state = {
      files: new Map([[fB, START + 1200], [fA, START + 4000]]),
      firsts: new Map([[fB, "fast-beta"], [fA, "typed interactively"]]),
      persisted: [],
    };
    const winA = mkWin("@1", "", A_STARTED); // bare launch — no prompt identity
    const winB = mkWin("@2", "fast-beta", B_STARTED);
    const a = linkRunSession(winA, [winA, winB], { home, deps: mkDeps(state), tombstones: [] });
    assert.deepEqual({ path: a.path, attribution: a.attribution }, { path: fA, attribution: "heuristic" },
      "B's prompt mismatch lifts its contest of A's file; fB itself is foreign to A");
    const b = linkRunSession(winB, [winA, winB], { home, deps: mkDeps(state), tombstones: [] });
    assert.deepEqual({ path: b.path, attribution: b.attribution }, { path: fB, attribution: "prompt" });
  });

  test("a persisted prompt link is final on an exited run and re-validated (kept) on a live one", () => {
    const fA = file("sess-own.jsonl");
    // Exited: settled content identity — no resolution runs at all.
    const dead = linkRunSession(
      mkWin("@1", "slow-alpha", A_STARTED, { tq_session: fA, tq_session_attr: "prompt" }, { dead: true }),
      [],
      {
        deps: {
          isSessionPath: () => true,
          setWindowOption: () => {},
          readdirSync: () => { throw new Error("must not resolve"); },
        },
        tombstones: [],
      },
    );
    assert.deepEqual(dead, { path: fA, link: "linked", attribution: "prompt" });

    // Live: still corroborated — kept with NO persist call.
    const state = {
      files: new Map([[fA, START + 1200]]),
      firsts: new Map([[fA, "slow-alpha"]]),
      persisted: [],
    };
    const live = linkRunSession(
      mkWin("@1", "slow-alpha", A_STARTED, { tq_session: fA, tq_session_attr: "prompt" }),
      [],
      { home, deps: mkDeps(state), tombstones: [] },
    );
    assert.deepEqual(live, { path: fA, link: "linked", attribution: "prompt" });
    assert.equal(state.persisted.length, 0);
  });

  test("a rival that CAN'T own the file (born before its gate) never spoils corroboration; one that can, with the same prompt, drops the link to pending", () => {
    const fA = file("sess-own.jsonl");
    const winA = mkWin("@1", "same-prompt", A_STARTED, { tq_session: fA, tq_session_attr: "prompt" });

    // A same-prompt rival started long AFTER fA was born: its birth gate
    // excludes the file, so content identity still holds — link kept.
    const late = {
      files: new Map([[fA, START + 100]]),
      firsts: new Map([[fA, "same-prompt"]]),
      persisted: [],
    };
    const lateRival = mkWin("@2", "same-prompt", new Date(START + 60_000).toISOString());
    const kept = linkRunSession(winA, [winA, lateRival], { home, deps: mkDeps(late), tombstones: [] });
    assert.deepEqual(kept, { path: fA, link: "linked", attribution: "prompt" });
    assert.equal(late.persisted.length, 0);

    // A same-prompt rival whose gate ADMITS the file makes content identity
    // genuinely ambiguous: the persisted claim is dropped and CLEARED —
    // pending beats wrong.
    const ambiguous = {
      files: new Map([[fA, START + 1200]]),
      firsts: new Map([[fA, "same-prompt"]]),
      persisted: [],
    };
    const earlyRival = mkWin("@2", "same-prompt", new Date(START + 200).toISOString());
    const dropped = linkRunSession(winA, [winA, earlyRival], { home, deps: mkDeps(ambiguous), tombstones: [] });
    assert.deepEqual(dropped, { path: null, link: "pending", attribution: null });
    assert.deepEqual(ambiguous.persisted, [["@1", "tq_session", ""], ["@1", "tq_session_attr", ""]]);
  });
});

describe("run-session-link — tombstones (claims outlive windows, the r3 kill-launder fix)", () => {
  const home = "/h";
  // REAL cursor layout: <dashless slug>/agent-transcripts/<id>/<id>.jsonl
  const rec = (id) => cursorRecording(home, "/w", id);
  const fA = rec("sess-slow");
  const fB = rec("sess-fast");
  const A_STARTED = STARTED_AT;
  const B_STARTED = new Date(START + 200).toISOString();
  const B_KILLED = new Date(START + 1500).toISOString();

  const mkWin = (id, prompt, startedAt, options = {}, extra = {}) => ({
    id,
    dead: false,
    panePid: "",
    options: {
      tq_agent: "cursor-agent", tq_cwd: "/w", tq_started: startedAt,
      tq_session: "", tq_session_attr: "", tq_prompt: prompt, ...options,
    },
    ...extra,
  });

  function mkDeps({ files, firsts = new Map(), persisted = [] }) {
    return {
      isSessionPath: (p) => files.has(p),
      readdirSync: fakeReaddir(() => files.keys()),
      statSync: statWithBirth(files),
      realpathSync: (p) => p,
      openPathHolders: () => new Map(),
      descendantPids: (pid) => new Set([String(pid)]),
      firstUserPrompt: (c) => firsts.get(c.path) ?? null,
      setWindowOption: (id, name, value) => persisted.push([id, name, value]),
    };
  }

  const bTombstone = (overrides = {}) => ({
    id: "@2", agent: "cursor-agent", cwd: "/w", started: B_STARTED, killed: B_KILLED,
    prompt: "fast-beta", sessionId: "", session: "", attr: "", ...overrides,
  });

  test("r3 regression: killing the fast rival can NEVER launder its recording into the survivor — prompt evidence keeps it foreign", () => {
    // Exactly the critic's repro: A "slow-alpha" (writes late) + B
    // "fast-beta" (writes at once), same cwd, both contested-pending; B is
    // killed (dismissed). Its tombstone keeps its transcript out of A.
    const winA = mkWin("@1", "slow-alpha", A_STARTED);

    // Phase 1: only fB exists, B is dead-and-gone, tombstone present.
    const p1 = { files: new Map([[fB, START + 1200]]), firsts: new Map([[fB, "fast-beta"]]), persisted: [] };
    const a1 = linkRunSession(winA, [winA], { home, deps: mkDeps(p1), tombstones: [bTombstone()] });
    assert.deepEqual(a1, { path: null, link: "pending", attribution: null },
      "the survivor NEVER links the dismissed run's transcript");
    assert.equal(p1.persisted.length, 0);

    // Phase 2: A's own recording appears — it links THAT, corroborated.
    const p2 = {
      files: new Map([[fB, START + 1200], [fA, START + 4000]]),
      firsts: new Map([[fB, "fast-beta"], [fA, "slow-alpha"]]),
      persisted: [],
    };
    const a2 = linkRunSession(winA, [winA], { home, deps: mkDeps(p2), tombstones: [bTombstone()] });
    assert.deepEqual(a2, { path: fA, link: "linked", attribution: "prompt" });
    assert.deepEqual(p2.persisted, [["@1", "tq_session", fA], ["@1", "tq_session_attr", "prompt"]]);
  });

  test("bare survivor vs bare tombstone: the dismissed file stays contested forever, the survivor's late file links (born after the death window)", () => {
    const winA = mkWin("@1", "", A_STARTED);
    const stone = bTombstone({ prompt: "" }); // B was a bare launch too
    // fB born within B's life: contested by the tombstone — pending, not wrong.
    const p1 = { files: new Map([[fB, START + 1200]]), firsts: new Map(), persisted: [] };
    const a1 = linkRunSession(winA, [winA], { home, deps: mkDeps(p1), tombstones: [stone] });
    assert.deepEqual(a1, { path: null, link: "pending", attribution: null });

    // fA born AFTER killed+slack: a dead process wrote nothing that late —
    // the tombstone cannot own it, so the survivor links its own file.
    const bornLate = Date.parse(B_KILLED) + CANDIDATE_SLACK_MS + 1000;
    const p2 = { files: new Map([[fB, START + 1200], [fA, bornLate]]), firsts: new Map(), persisted: [] };
    const a2 = linkRunSession(winA, [winA], { home, deps: mkDeps(p2), tombstones: [stone] });
    assert.deepEqual({ path: a2.path, attribution: a2.attribution }, { path: fA, attribution: "heuristic" });
  });

  test("a tombstone's claimed path is excluded outright — whatever its attr", () => {
    for (const attr of ["heur", "prompt", "pid"]) {
      const winA = mkWin("@1", "", A_STARTED);
      const p = { files: new Map([[fB, START + 1200]]), firsts: new Map(), persisted: [] };
      const a = linkRunSession(winA, [winA], {
        home, deps: mkDeps(p),
        tombstones: [bTombstone({ prompt: "", session: fB, attr })],
      });
      assert.equal(a.link, "pending", `attr=${attr}: the dismissed run's served file may never resurface`);
    }
  });

  test("a tombstone whose window still lives is ignored (failed kill must not haunt its own run)", () => {
    const winB = mkWin("@2", "fast-beta", B_STARTED);
    const p = { files: new Map([[fB, START + 1200]]), firsts: new Map([[fB, "fast-beta"]]), persisted: [] };
    const b = linkRunSession(winB, [winB], { home, deps: mkDeps(p), tombstones: [bTombstone()] });
    assert.deepEqual({ path: b.path, attribution: b.attribution }, { path: fB, attribution: "prompt" },
      "the run still owns its recording — its own premature tombstone changes nothing");
  });

  test("recordRunTombstone/readRunTombstones round-trip through the session option (base64 JSON, capped, id-replacing)", () => {
    let stored = "";
    const deps = {
      getSessionOption: () => stored,
      setSessionOption: (name, value) => {
        assert.equal(name, TOMBSTONE_OPTION);
        stored = value;
      },
    };
    recordRunTombstone(mkWin("@2", "fast-beta", B_STARTED, { tq_session: fB, tq_session_attr: "heur" }), deps);
    let got = readRunTombstones(deps);
    assert.equal(got.length, 1);
    assert.deepEqual(
      { id: got[0].id, agent: got[0].agent, cwd: got[0].cwd, started: got[0].started, prompt: got[0].prompt, session: got[0].session, attr: got[0].attr },
      { id: "@2", agent: "cursor-agent", cwd: "/w", started: B_STARTED, prompt: "fast-beta", session: fB, attr: "heur" },
    );
    assert.ok(Date.parse(got[0].killed) > 0, "the death time bounds the ownable window");
    assert.match(stored, /^[A-Za-z0-9+/=]+$/, "stored value is locale-proof base64 ASCII");

    // Re-tombstoning the same window replaces, never duplicates.
    recordRunTombstone(mkWin("@2", "fast-beta take 2", B_STARTED), deps);
    got = readRunTombstones(deps);
    assert.equal(got.length, 1);
    assert.equal(got[0].prompt, "fast-beta take 2");

    // The list caps at TOMBSTONE_MAX newest entries.
    for (let i = 0; i < TOMBSTONE_MAX + 10; i++) {
      recordRunTombstone(mkWin(`@${100 + i}`, `p${i}`, B_STARTED), deps);
    }
    got = readRunTombstones(deps);
    assert.equal(got.length, TOMBSTONE_MAX);
    assert.equal(got[got.length - 1].id, `@${100 + TOMBSTONE_MAX + 9}`);
  });

  test("a tombstone that died WITH a claim only bars that path — it never contests the survivor's other candidates", () => {
    // The dismissed run's link was its final answer (dead runs never
    // re-link), so files born within its lifetime stay claimable.
    const winA = mkWin("@1", "", A_STARTED);
    const p = {
      files: new Map([[fB, START + 1200], [fA, START + 1300]]),
      firsts: new Map(),
      persisted: [],
    };
    const a = linkRunSession(winA, [winA], {
      home, deps: mkDeps(p),
      tombstones: [bTombstone({ prompt: "", session: fB, attr: "heur" })],
    });
    assert.deepEqual({ path: a.path, attribution: a.attribution }, { path: fA, attribution: "heuristic" },
      "fB is barred, fA (born inside the tombstone's lifetime) links — no contested-forever");
  });

  test("an EXITED-but-listed run's final claim is excluded for survivors and contests nothing", () => {
    const winA = mkWin("@1", "", A_STARTED);
    const deadLinked = mkWin("@2", "", B_STARTED, { tq_session: fB, tq_session_attr: "heur" }, { dead: true });
    const p = {
      files: new Map([[fB, START + 1200], [fA, START + 1300]]),
      firsts: new Map(),
      persisted: [],
    };
    const a = linkRunSession(winA, [winA, deadLinked], { home, deps: mkDeps(p), tombstones: [] });
    assert.deepEqual({ path: a.path, attribution: a.attribution }, { path: fA, attribution: "heuristic" },
      "the dead run's served file may never double as the survivor's chat; its final answer contests nothing else");
    // A dead run that died PENDING still contests (it might own either file).
    const deadPending = mkWin("@2", "", B_STARTED, {}, { dead: true });
    const contested = linkRunSession(winA, [winA, deadPending], { home, deps: mkDeps(p), tombstones: [] });
    assert.equal(contested.link, "pending");
  });

  test("a RESUMED run's content identity is the SOURCE conversation's first message: the fork corroborates, unrelated files never link", () => {
    // Fork recordings begin with the SOURCE session's first message —
    // persisted at resume time as tq_fork_prompt — so the fork recording
    // is RECOGNIZED (content identity), while an unrelated fresh file can
    // never be bare-guessed into a resumed run's chat (the r5 fix).
    const fork = rec("sess-fork");
    const userOwn = rec("sess-user-own");
    const winR = mkWin("@3", "follow-up question", A_STARTED, {
      tq_resumed_from: "abcd1234",
      tq_fork_prompt: "the ORIGINAL prompt of the source session",
    });

    // Phase 1: only the USER's unrelated session exists — a bare run would
    // have guessed it (sole candidate); a resumed run must not.
    const p0 = {
      files: new Map([[userOwn, START + 800]]),
      firsts: new Map([[userOwn, "users own unrelated chat"]]),
      persisted: [],
    };
    const r0 = linkRunSession(winR, [winR], { home, deps: mkDeps(p0), tombstones: [] });
    assert.deepEqual(r0, { path: null, link: "pending", attribution: null },
      "a resumed run never links a recording that does not open with its source conversation");
    assert.equal(p0.persisted.length, 0);

    // Phase 2: the fork recording lands beside it — content identity picks
    // exactly the fork, user session untouched.
    const p1 = {
      files: new Map([[userOwn, START + 800], [fork, START + 1200]]),
      firsts: new Map([[userOwn, "users own unrelated chat"], [fork, "the ORIGINAL prompt of the source session"]]),
      persisted: [],
    };
    const r1 = linkRunSession(winR, [winR], { home, deps: mkDeps(p1), tombstones: [] });
    assert.deepEqual({ path: r1.path, attribution: r1.attribution }, { path: fork, attribution: "prompt" },
      "the fork recording is recognized by the source conversation's first message");

    // A resumed run WITHOUT a persisted fork prompt (source had no user
    // message) stays honestly pending rather than guessing.
    const bare = mkWin("@3", "", A_STARTED, { tq_resumed_from: "abcd1234" });
    const r2 = linkRunSession(bare, [bare], { home, deps: mkDeps({ ...p1, persisted: [] }), tombstones: [] });
    assert.equal(r2.link, "pending");

    // And as a rival: the follow-up prompt is still no content identity —
    // a fresh run whose recording opens with the SAME text as a resumed
    // rival's follow-up stays corroborated (the rival's recording opens
    // with the source conversation, never with that follow-up).
    const winA = mkWin("@1", "shared wording", A_STARTED);
    const own = rec("sess-own");
    const p2 = {
      files: new Map([[own, START + 1200]]),
      firsts: new Map([[own, "shared wording"]]),
      persisted: [],
    };
    const rivalR = mkWin("@3", "shared wording", B_STARTED, { tq_resumed_from: "abcd1234" });
    const a = linkRunSession(winA, [winA, rivalR], { home, deps: mkDeps(p2), tombstones: [] });
    assert.deepEqual({ path: a.path, attribution: a.attribution }, { path: own, attribution: "prompt" },
      "a resumed rival's follow-up prompt must not fake ambiguity against a fresh run's content identity");
  });

  test("a RESUMED run falls back to its SOURCE recording once its freshness moves inside the run's lifetime", () => {
    // cursor-agent --resume continues IN the source recording (no fork
    // file): the source path (tq_resumed_path) linking as a guess is the
    // only way "recordings that exist get served" holds for it — and it
    // can never be the wrong conversation (it IS the resumed session).
    const src = rec("sess-source");
    const winR = mkWin("@3", "", A_STARTED, {
      tq_resumed_from: "abcd1234",
      tq_resumed_path: src,
      tq_fork_prompt: "the ORIGINAL prompt of the source session",
    });

    // Source untouched since before the run started → no evidence yet.
    const stale = {
      files: new Map([[src, START - 60_000]]),
      firsts: new Map(),
      persisted: [],
    };
    const r0 = linkRunSession(winR, [winR], { home, deps: mkDeps(stale), tombstones: [] });
    assert.equal(r0.link, "pending", "an idle source recording proves nothing");

    // Source mtime moved after the run start → the resumed agent is
    // (most plausibly) appending there: linked as a re-validated guess.
    const fresh = {
      files: new Map([[src, START + 1500]]),
      firsts: new Map(),
      persisted: [],
    };
    const r1 = linkRunSession(winR, [winR], { home, deps: mkDeps(fresh), tombstones: [] });
    assert.deepEqual({ path: r1.path, attribution: r1.attribution }, { path: src, attribution: "heuristic" });
    assert.deepEqual(fresh.persisted, [["@3", "tq_session", src], ["@3", "tq_session_attr", "heur"]]);

    // A dead resumed run's established source claim is final — the source
    // conversation can never be the wrong transcript.
    const deadDeps = mkDeps({ files: new Map([[src, START + 1500]]), firsts: new Map(), persisted: [] });
    const dead = linkRunSession(
      mkWin("@3", "", A_STARTED, {
        tq_resumed_from: "abcd1234",
        tq_resumed_path: src,
        tq_session: src,
        tq_session_attr: "heur",
        tq_ended: new Date(START + 9000).toISOString(),
      }, { dead: true }),
      [],
      { home, deps: deadDeps, tombstones: [] },
    );
    assert.deepEqual(dead, { path: src, link: "linked", attribution: "heuristic" });
  });

  test("readRunTombstones degrades to [] on absent/garbage state", () => {
    assert.deepEqual(readRunTombstones({ getSessionOption: () => "" }), []);
    assert.deepEqual(readRunTombstones({ getSessionOption: () => "not-base64!!!" }), []);
    assert.deepEqual(readRunTombstones({ getSessionOption: () => Buffer.from("{\"not\":\"array\"}").toString("base64") }), []);
    assert.deepEqual(readRunTombstones({ getSessionOption: () => { throw new Error("tmux gone"); } }), []);
  });
});

describe("run-session-link — tombstone retention (relevance beats recency, the r4 contest-memory fix)", () => {
  const home = "/h";
  // REAL cursor layout: <dashless slug>/agent-transcripts/<id>/<id>.jsonl
  const rec = (id) => cursorRecording(home, "/w", id);
  const fA = rec("sess-slow");
  const fB = rec("sess-fast");
  const A_STARTED = STARTED_AT;
  const B_STARTED = new Date(START + 200).toISOString();
  const B_KILLED = new Date(START + 1500).toISOString();

  const mkWin = (id, prompt, startedAt, options = {}, extra = {}) => ({
    id,
    dead: false,
    panePid: "",
    options: {
      tq_agent: "cursor-agent", tq_cwd: "/w", tq_started: startedAt,
      tq_session: "", tq_session_attr: "", tq_prompt: prompt, ...options,
    },
    ...extra,
  });

  function mkDeps({ files, firsts = new Map(), persisted = [] }) {
    return {
      isSessionPath: (p) => files.has(p),
      readdirSync: fakeReaddir(() => files.keys()),
      statSync: statWithBirth(files),
      realpathSync: (p) => p,
      openPathHolders: () => new Map(),
      descendantPids: (pid) => new Set([String(pid)]),
      firstUserPrompt: (c) => firsts.get(c.path) ?? null,
      setWindowOption: (id, name, value) => persisted.push([id, name, value]),
    };
  }

  /** In-memory session-option store standing in for the tmux session. */
  function optionStore(initial = {}) {
    const store = new Map(Object.entries(initial));
    return {
      getSessionOption: (name) => store.get(name) ?? "",
      setSessionOption: (name, value) => store.set(name, value),
      store,
    };
  }

  const encode = (list) => Buffer.from(JSON.stringify(list), "utf8").toString("base64");

  const twinStone = {
    id: "@2", agent: "cursor-agent", cwd: "/w", started: B_STARTED, killed: B_KILLED,
    prompt: "same-task", sessionId: "", session: "", attr: "",
  };

  test("r4 regression: 32+ routine dismissals never evict the tombstone keeping an older contest honest — distinct prompts fold to a coarse stone, never to nothing", () => {
    // The critic's exact vector: survivor @1 pending with the twin's prompt,
    // twin @2 dismissed (claimless stone), then a flood of create+kill
    // cycles in the SAME cwd, each pushing a stone (worst case: all with
    // distinct prompts, so nothing merges).
    const survivor = mkWin("@1", "same-task", A_STARTED);
    const opts = optionStore({ [TOMBSTONE_OPTION]: encode([twinStone]) });
    for (let i = 0; i < TOMBSTONE_MAX + 8; i++) {
      recordRunTombstone(mkWin(`@${100 + i}`, `cycle-${i}`, B_STARTED), opts, { windows: [survivor] });
    }
    const stones = readRunTombstones(opts);
    assert.ok(stones.length <= TOMBSTONE_MAX * 2, "the list stays bounded");

    // The twin's recording (born within its life, opening with the shared
    // prompt) must STILL be unclaimable by the survivor — pre-fix, the
    // 33rd push evicted the twin's stone and the survivor linked it attr
    // "prompt".
    const p = { files: new Map([[fB, START + 1200]]), firsts: new Map([[fB, "same-task"]]), persisted: [] };
    const a = linkRunSession(survivor, [survivor], { home, deps: mkDeps(p), tombstones: stones });
    assert.deepEqual(a, { path: null, link: "pending", attribution: null },
      "a dismissal flood must never launder the twin's transcript into the survivor");
    assert.equal(p.persisted.length, 0);

    // The survivor's OWN recording — born after every stone's death window
    // (the cycle stones died at the REAL clock's now) — still links,
    // prompt-corroborated: coverage was kept, only precision folded.
    const bornLate = Date.now() + CANDIDATE_SLACK_MS + 60_000;
    const p2 = {
      files: new Map([[fB, START + 1200], [fA, bornLate]]),
      firsts: new Map([[fB, "same-task"], [fA, "same-task"]]),
      persisted: [],
    };
    const a2 = linkRunSession(survivor, [survivor], { home, deps: mkDeps(p2), tombstones: stones });
    assert.deepEqual({ path: a2.path, attribution: a2.attribution }, { path: fA, attribution: "prompt" },
      "the survivor's late-born recording is outside every stone's ownable window");
  });

  test("routine same-space dismissals MERGE into one stone instead of pushing toward the cap", () => {
    const survivor = mkWin("@1", "same-task", A_STARTED);
    const opts = optionStore({ [TOMBSTONE_OPTION]: encode([twinStone]) });
    for (let i = 0; i < TOMBSTONE_MAX + 8; i++) {
      // Bare launches (no prompt) — the UI's routine dismissal of finished runs.
      recordRunTombstone(mkWin(`@${100 + i}`, "", B_STARTED), opts, { windows: [survivor] });
    }
    const stones = readRunTombstones(opts);
    assert.ok(stones.length <= 3, `same-space claimless stones merge (got ${stones.length})`);
    assert.ok(stones.some((t) => t.id === "@2" && t.prompt === "same-task"),
      "the twin's PRECISE stone survives the flood untouched");
  });

  test("stones no unsettled run's candidate space overlaps are dropped as inert", () => {
    // Every window started way after the stone's death (+slack): the stone
    // can no longer change any attribution — birth gates exclude every
    // file the dead run could have written.
    const lateWin = mkWin("@9", "x", new Date(START + 3_600_000).toISOString());
    const compacted = compactTombstones([twinStone], [lateWin], { realpathSync: (p) => p });
    assert.deepEqual(compacted, []);

    // A settled window (pid identity) does not keep stones alive either…
    const settled = mkWin("@9", "x", A_STARTED, { tq_session: fA, tq_session_attr: "pid" });
    assert.deepEqual(compactTombstones([twinStone], [settled], { realpathSync: (p) => p }), []);

    // …but a pending overlapping run does, and so does a heur-linked one
    // (both re-validated every poll).
    const pending = mkWin("@9", "x", A_STARTED);
    assert.equal(compactTombstones([twinStone], [pending], { realpathSync: (p) => p }).length, 1);
    const heur = mkWin("@9", "x", A_STARTED, { tq_session: fA, tq_session_attr: "heur" });
    assert.equal(compactTombstones([twinStone], [heur], { realpathSync: (p) => p }).length, 1);
  });

  test("a COARSE stone contests its interval but only DEGRADES unique corroboration to guess-grade (the r5 secondary fix)", () => {
    const coarse = {
      id: "", coarse: true, agent: "cursor-agent", cwd: "/w",
      started: B_STARTED, killed: B_KILLED, prompt: "", sessionId: "", session: "", attr: "",
    };
    const winA = mkWin("@1", "same-task", A_STARTED);
    // Candidate born inside the coarse interval, first message = MY prompt
    // and nobody else's: the stone has no prompt to contradict affirmative
    // content evidence, so the recording SERVES — but only as a
    // re-validated guess (attr heuristic), never settled content identity.
    const p1 = { files: new Map([[fB, START + 1200]]), firsts: new Map([[fB, "same-task"]]), persisted: [] };
    const a1 = linkRunSession(winA, [winA], { home, deps: mkDeps(p1), tombstones: [coarse] });
    assert.deepEqual({ path: a1.path, link: a1.link, attribution: a1.attribution },
      { path: fB, link: "linked", attribution: "heuristic" },
      "a uniquely-corroborable recording is served under a coarse stone — recordings that exist get served");

    // An equal-prompt collider (e.g. a laundering run's own recording
    // appearing with the same first message) demotes it again: two
    // matching recordings select nothing, so the launder is never final.
    const p1b = {
      files: new Map([[fB, START + 1200], [fA, START + 1400]]),
      firsts: new Map([[fB, "same-task"], [fA, "same-task"]]),
      persisted: [],
    };
    const poisoned = mkWin("@1", "same-task", A_STARTED, { tq_session: fB, tq_session_attr: "heur" });
    const a1b = linkRunSession(poisoned, [poisoned], { home, deps: mkDeps(p1b), tombstones: [coarse] });
    assert.deepEqual(a1b, { path: null, link: "pending", attribution: null },
      "a second matching recording demotes the coarse-stone guess — never wrong forever");
    assert.deepEqual(p1b.persisted, [["@1", "tq_session", ""], ["@1", "tq_session_attr", ""]]);

    // A BARE candidate (no content match — a promptless run's guess) stays
    // fully contested inside the interval: only content evidence unlocks.
    const bare = mkWin("@2", "", A_STARTED);
    const p1c = { files: new Map([[fB, START + 1200]]), firsts: new Map(), persisted: [] };
    const a1c = linkRunSession(bare, [bare], { home, deps: mkDeps(p1c), tombstones: [coarse] });
    assert.deepEqual(a1c, { path: null, link: "pending", attribution: null });

    // Born after the interval (+slack): out of the dead runs' reach —
    // links as settled content identity, the stone is no owner at all.
    const bornLate = Date.parse(B_KILLED) + CANDIDATE_SLACK_MS + 1000;
    const p2 = { files: new Map([[fA, bornLate]]), firsts: new Map([[fA, "same-task"]]), persisted: [] };
    const a2 = linkRunSession(winA, [winA], { home, deps: mkDeps(p2), tombstones: [coarse] });
    assert.deepEqual({ path: a2.path, attribution: a2.attribution }, { path: fA, attribution: "prompt" });
  });

  test("a stone whose prompt matches a live unsettled run is NEVER folded to coarse — the twin's contest survives any flood", () => {
    // The launder-through-relaxation guard: fold the same-prompt twin's
    // stone away and its recording would soft-corroborate as the
    // survivor's own under the prompt-unknown coarse stone.
    const survivor = mkWin("@1", "same-task", A_STARTED);
    const flood = [twinStone];
    for (let i = 0; i < TOMBSTONE_MAX + 20; i++) {
      flood.push({
        id: `@${200 + i}`, agent: "cursor-agent", cwd: "/w",
        started: B_STARTED, killed: B_KILLED, prompt: `cycle-${i}`,
        sessionId: "", session: "", attr: "",
      });
    }
    const compacted = compactTombstones(flood, [survivor], { realpathSync: (p) => p });
    assert.ok(compacted.length <= TOMBSTONE_MAX * 2, "the list stays bounded");
    assert.ok(compacted.some((t) => t.id === "@2" && t.prompt === "same-task" && !t.coarse),
      "the twin's precise stone is prompt-protected from coarse folding");

    // …so the twin's recording still cannot be soft-corroborated into the
    // survivor after the flood.
    const p = { files: new Map([[fB, START + 1200]]), firsts: new Map([[fB, "same-task"]]), persisted: [] };
    const a = linkRunSession(survivor, [survivor], { home, deps: mkDeps(p), tombstones: compacted });
    assert.deepEqual(a, { path: null, link: "pending", attribution: null });
  });

  test("a stone whose window still LIVES is kept verbatim and never merged or folded", () => {
    const liveWin = mkWin("@2", "fast-beta", B_STARTED);
    const compacted = compactTombstones(
      [twinStone, { ...twinStone, id: "@3" }],
      [liveWin, mkWin("@1", "same-task", A_STARTED)],
      { realpathSync: (p) => p },
    );
    assert.ok(compacted.some((t) => t.id === "@2" && !t.coarse), "the failed-kill stone stays intact");
  });
});

describe("run-session-link — equal-prompt collision (prompt equality is corroboration, not identity)", () => {
  const home = "/h";
  // REAL cursor layout: <dashless slug>/agent-transcripts/<id>/<id>.jsonl
  const rec = (id) => cursorRecording(home, "/w", id);
  const userFile = rec("sess-users-own");
  const ownFile = rec("sess-own");

  const mkWin = (options = {}, extra = {}) => ({
    id: "@1",
    dead: false,
    panePid: "",
    options: {
      tq_agent: "cursor-agent", tq_cwd: "/w", tq_started: STARTED_AT,
      tq_session: "", tq_session_attr: "", tq_prompt: "deploy the fix", ...options,
    },
    ...extra,
  });

  function mkDeps({ files, firsts, persisted }) {
    return {
      isSessionPath: (p) => files.has(p),
      readdirSync: fakeReaddir(() => files.keys()),
      statSync: statWithBirth(files),
      realpathSync: (p) => p,
      openPathHolders: () => new Map(),
      descendantPids: (pid) => new Set([String(pid)]),
      firstUserPrompt: (c) => firsts.get(c.path) ?? null,
      setWindowOption: (id, name, value) => persisted.push([id, name, value]),
    };
  }

  test("the r4 vector: a user session opening with the run's exact prompt is DROPPED the moment the run's own recording appears — ambiguous, pending, cleared", () => {
    // Phase 1: only the user's session exists and opens with the launch
    // prompt — indistinguishable from the run's own, so it links (the
    // information to refuse it does not exist yet).
    const win = mkWin();
    const p1 = {
      files: new Map([[userFile, START + 400]]),
      firsts: new Map([[userFile, "deploy the fix"]]),
      persisted: [],
    };
    const a1 = linkRunSession(win, [win], { home, deps: mkDeps(p1), tombstones: [] });
    assert.deepEqual({ path: a1.path, attribution: a1.attribution }, { path: userFile, attribution: "prompt" });

    // Phase 2: the run's REAL recording lands, also opening with the
    // prompt. Equality now exists twice — it selects nothing. The
    // persisted claim is dropped AND cleared; pre-fix it was kept forever.
    const poisoned = mkWin({ tq_session: userFile, tq_session_attr: "prompt" });
    const p2 = {
      files: new Map([[userFile, START + 400], [ownFile, START + 900]]),
      firsts: new Map([[userFile, "deploy the fix"], [ownFile, "deploy the fix"]]),
      persisted: [],
    };
    const a2 = linkRunSession(poisoned, [poisoned], { home, deps: mkDeps(p2), tombstones: [] });
    assert.deepEqual(a2, { path: null, link: "pending", attribution: null },
      "two recordings with the same first message: content identity is ambiguous");
    assert.deepEqual(p2.persisted, [["@1", "tq_session", ""], ["@1", "tq_session_attr", ""]],
      "the wrong-transcript claim is cleared from tmux, not kept");

    // Neither collider may sneak back in as a heuristic guess either.
    const a3 = linkRunSession(mkWin(), [mkWin()], { home, deps: mkDeps({ ...p2, persisted: [] }), tombstones: [] });
    assert.equal(a3.link, "pending");

    // Phase 3: pid identity disambiguates — the run's own tree holds one.
    const p4 = {
      files: new Map([[userFile, START + 400], [ownFile, START + 900]]),
      firsts: new Map([[userFile, "deploy the fix"], [ownFile, "deploy the fix"]]),
      persisted: [],
    };
    const deps4 = {
      ...mkDeps(p4),
      openPathHolders: () => new Map([[ownFile, new Set(["101"])]]),
      descendantPids: (pid) => (String(pid) === "100" ? new Set(["100", "101"]) : new Set([String(pid)])),
    };
    const a4 = linkRunSession(mkWin({}, { panePid: "100" }), [mkWin({}, { panePid: "100" })], {
      home, deps: deps4, tombstones: [],
    });
    assert.deepEqual({ path: a4.path, attribution: a4.attribution }, { path: ownFile, attribution: "pid" });

    // Phase 4: a collider disappearing restores unique corroboration.
    const p5 = {
      files: new Map([[ownFile, START + 900]]),
      firsts: new Map([[ownFile, "deploy the fix"]]),
      persisted: [],
    };
    const a5 = linkRunSession(mkWin(), [mkWin()], { home, deps: mkDeps(p5), tombstones: [] });
    assert.deepEqual({ path: a5.path, attribution: a5.attribution }, { path: ownFile, attribution: "prompt" });
  });
});

describe("run-session-link — heuristic ambiguity (the r5 promptless mislink fix)", () => {
  const home = "/h";
  // REAL cursor layout: <dashless slug>/agent-transcripts/<id>/<id>.jsonl
  const rec = (id) => cursorRecording(home, "/w", id);
  const userFile = rec("sess-user-own");
  const ownFile = rec("sess-own");

  const mkWin = (options = {}, extra = {}) => ({
    id: "@1",
    dead: false,
    panePid: "",
    options: {
      tq_agent: "cursor-agent", tq_cwd: "/w", tq_started: STARTED_AT,
      tq_session: "", tq_session_attr: "", tq_prompt: "", ...options,
    },
    ...extra,
  });

  function mkDeps({ files, firsts = new Map(), persisted = [] }) {
    return {
      isSessionPath: (p) => files.has(p),
      readdirSync: fakeReaddir(() => files.keys()),
      statSync: statWithBirth(files),
      realpathSync: (p) => p,
      openPathHolders: () => new Map(),
      descendantPids: (pid) => new Set([String(pid)]),
      firstUserPrompt: (c) => firsts.get(c.path) ?? null,
      setWindowOption: (id, name, value) => persisted.push([id, name, value]),
    };
  }

  test("the r5 vector: a promptless run's guess is DEMOTED the moment its own recording appears beside the user's — and never finalized at exit", () => {
    // Phase 1 (+1s): only the user's own session exists — a sole candidate
    // links as an honest guess (the information to refuse it does not
    // exist yet).
    const win = mkWin();
    const p1 = { files: new Map([[userFile, START + 1000]]), persisted: [] };
    const a1 = linkRunSession(win, [win], { home, deps: mkDeps(p1), tombstones: [] });
    assert.deepEqual({ path: a1.path, attribution: a1.attribution }, { path: userFile, attribution: "heuristic" });

    // Phase 2 (+8s): the run's OWN recording lands. Two unvouched files
    // born after the start are indistinguishable — the persisted guess
    // (the user's private chat!) is demoted to pending and CLEARED.
    // Pre-fix it was kept forever ("persisted guess wins while eligible").
    const poisoned = mkWin({ tq_session: userFile, tq_session_attr: "heur" });
    const p2 = {
      files: new Map([[userFile, START + 1000], [ownFile, START + 8000]]),
      persisted: [],
    };
    const a2 = linkRunSession(poisoned, [poisoned], { home, deps: mkDeps(p2), tombstones: [] });
    assert.deepEqual(a2, { path: null, link: "pending", attribution: null },
      "a second eligible candidate demotes the guess — the user's chat is never kept");
    assert.deepEqual(p2.persisted, [["@1", "tq_session", ""], ["@1", "tq_session_attr", ""]],
      "the wrong-transcript guess is cleared from tmux");

    // Phase 3: the run exits while ambiguous — the guess is NEVER
    // finalized (pre-fix: "on an exited run it is the final answer").
    const deadPoisoned = mkWin(
      { tq_session: userFile, tq_session_attr: "heur", tq_ended: new Date(START + 9000).toISOString() },
      { dead: true },
    );
    const p3 = { ...p2, persisted: [] };
    const a3 = linkRunSession(deadPoisoned, [deadPoisoned], { home, deps: mkDeps(p3), tombstones: [] });
    assert.deepEqual(a3, { path: null, link: "pending", attribution: null },
      "an exited run must not finalize a guess that was ambiguous at death");

    // Phase 4: the user's session gets CLAIMED elsewhere (a settled link
    // of another run) — the candidate space collapses back to one honest
    // candidate and the run's own recording finally links.
    const rival = mkWin(
      { tq_session: userFile, tq_session_attr: "pid", tq_started: new Date(START - 60_000).toISOString() },
      { id: "@9" },
    );
    const p4 = { ...p2, persisted: [] };
    const a4 = linkRunSession(mkWin(), [mkWin(), rival], { home, deps: mkDeps(p4), tombstones: [] });
    assert.deepEqual({ path: a4.path, attribution: a4.attribution }, { path: ownFile, attribution: "heuristic" },
      "once the rival file is claimed, the sole remaining candidate serves — recordings that exist get served");
  });

  test("a promptless codex run stays pending while ANY concurrent codex recording shares its machine-wide candidate space", () => {
    // codex/droid candidate spaces are the whole dated session tree with
    // rivalry ignoring cwd — the r5 blast radius. Two recordings born
    // after the run start (its own + any other codex session on the
    // machine) must select nothing.
    const codexDir = join(home, ".codex", "sessions", "2026", "08", "11");
    const own = join(codexDir, "rollout-own.jsonl");
    const elsewhere = join(codexDir, "rollout-elsewhere.jsonl");
    const win = mkWin({ tq_agent: "codex", tq_cwd: "/w" });
    const files = new Map([[own, START + 1000], [elsewhere, START + 1500]]);
    const deps = {
      isSessionPath: (p) => files.has(p),
      readdirSync: (dir, opts) => {
        if (String(dir).endsWith("11")) {
          return opts ? [] : ["rollout-own.jsonl", "rollout-elsewhere.jsonl"];
        }
        if (opts) {
          const next = { "sessions": "2026", "2026": "08", "08": "11" }[String(dir).split("/").pop()];
          return next ? [{ name: next, isDirectory: () => true }] : [];
        }
        return [];
      },
      statSync: statWithBirth(files),
      realpathSync: (p) => p,
      openPathHolders: () => new Map(),
      descendantPids: (pid) => new Set([String(pid)]),
      firstUserPrompt: () => null,
      setWindowOption: () => {},
    };
    const got = linkRunSession(win, [win], { home, deps, tombstones: [] });
    assert.deepEqual(got, { path: null, link: "pending", attribution: null },
      "any concurrent machine-wide codex session makes a promptless run's guess ambiguous");
  });
});

describe("run-session-link — bare-guess probation & the death rule (the r7 zero-evidence fix)", () => {
  const home = "/h";
  const rec = (id) => cursorRecording(home, "/w", id);
  const userFile = rec("sess-user-own");
  const ownFile = rec("sess-own");

  const mkWin = (options = {}, extra = {}) => ({
    id: "@1",
    dead: false,
    panePid: "",
    options: {
      tq_agent: "cursor-agent", tq_cwd: "/w", tq_started: STARTED_AT,
      tq_session: "", tq_session_attr: "", tq_prompt: "", ...options,
    },
    ...extra,
  });

  function mkDeps({ files, firsts = new Map(), persisted = [], now = null }) {
    return {
      isSessionPath: (p) => files.has(p),
      readdirSync: fakeReaddir(() => files.keys()),
      statSync: statWithBirth(files),
      realpathSync: (p) => p,
      openPathHolders: () => new Map(),
      descendantPids: (pid) => new Set([String(pid)]),
      firstUserPrompt: (c) => firsts.get(c.path) ?? null,
      setWindowOption: (id, name, value) => persisted.push([id, name, value]),
      ...(now === null ? {} : { now: () => now }),
    };
  }

  test("a bare guess is NOT served during its probation window, and is served once it matures", () => {
    // The r6 residual: a foreign file that is briefly the sole candidate
    // gets served within one poll of the run's birth. Uniqueness alone is
    // the weakest evidence tracequest has; it must hold for a while before
    // it is worth serving.
    const win = mkWin();
    const files = new Map([[userFile, START + 1000]]);
    const early = { files, persisted: [], now: START + 2000 };
    assert.deepEqual(
      linkRunSession(win, [win], { home, deps: mkDeps(early), tombstones: [] }),
      { path: null, link: "pending", attribution: null },
      "1s-old sole candidate: honest pending, not a transient wrong serve",
    );
    assert.deepEqual(early.persisted, [], "nothing is persisted while a guess is on probation");

    const matured = { files, persisted: [], now: START + 4001 };
    const got = linkRunSession(win, [win], { home, deps: mkDeps(matured), tombstones: [] });
    assert.deepEqual({ path: got.path, attribution: got.attribution }, { path: userFile, attribution: "heuristic" });
    assert.deepEqual(matured.persisted, [["@1", "tq_session", userFile], ["@1", "tq_session_attr", "heur"]]);
  });

  test("a promptless run that crashes before writing anything ends PENDING — a session born in its window is never bound", () => {
    // Zero affirmative evidence: no pid holder, no prompt, nothing the run
    // itself wrote. Its 400ms of life cannot make a stranger's recording
    // its transcript, at this poll or any later one.
    const files = new Map([[userFile, START + 200]]);
    const dead = mkWin({ tq_ended: new Date(START + 400).toISOString() }, { dead: true });
    const state = { files, persisted: [], now: START + 60_000 };
    assert.deepEqual(
      linkRunSession(dead, [dead], { home, deps: mkDeps(state), tombstones: [] }),
      { path: null, link: "pending", attribution: null },
    );
    assert.deepEqual(state.persisted, [], "no claim is ever written for a run that proved nothing");
    // …and it stays pending on every subsequent poll (no late finalization).
    const later = { files, persisted: [], now: START + 600_000 };
    assert.deepEqual(
      linkRunSession(dead, [dead], { home, deps: mkDeps(later), tombstones: [] }),
      { path: null, link: "pending", attribution: null },
    );
  });

  test("a guess that DID mature inside the run's lifetime is still final at death (recordings that exist get served)", () => {
    const files = new Map([[ownFile, START + 1000]]);
    const dead = mkWin({ tq_ended: new Date(START + 30_000).toISOString() }, { dead: true });
    const state = { files, persisted: [], now: START + 40_000 };
    const got = linkRunSession(dead, [dead], { home, deps: mkDeps(state), tombstones: [] });
    assert.deepEqual({ path: got.path, attribution: got.attribution }, { path: ownFile, attribution: "heuristic" },
      "unique for 29s of the run's own life is a meaningful window",
    );
  });

  test("probation applies ONLY to bare guesses — prompt corroboration and a resumed run's source link on the first poll", () => {
    // Content identity: a recording born 100ms ago whose first message is
    // this run's prompt is served immediately (affirmative evidence).
    const fresh = rec("sess-fresh");
    const promptWin = mkWin({ tq_prompt: "deploy the fix" });
    const state = {
      files: new Map([[fresh, START + 1000]]),
      firsts: new Map([[fresh, "deploy the fix"]]),
      persisted: [],
      now: START + 1100,
    };
    const got = linkRunSession(promptWin, [promptWin], { home, deps: mkDeps(state), tombstones: [] });
    assert.deepEqual({ path: got.path, attribution: got.attribution }, { path: fresh, attribution: "prompt" });

    // Resumed-run SOURCE fallback: serving the very conversation the run
    // continues can never be the wrong transcript — no probation.
    const src = rec("sess-source");
    const resumed = mkWin({
      tq_resumed_from: "abcd1234",
      tq_resumed_path: src,
      tq_prompt: "keep going",
    });
    const rState = { files: new Map([[src, START + 500]]), persisted: [], now: START + 600 };
    const rGot = linkRunSession(resumed, [resumed], { home, deps: mkDeps(rState), tombstones: [] });
    assert.deepEqual({ path: rGot.path, attribution: rGot.attribution }, { path: src, attribution: "heuristic" });
  });
});

describe("run-session-link — run ledger (synthesized tombstones for windows killed outside the API)", () => {
  const home = "/h";
  // REAL cursor layout: <dashless slug>/agent-transcripts/<id>/<id>.jsonl
  const rec = (id) => cursorRecording(home, "/w", id);
  const fB = rec("sess-fast");
  const fA = rec("sess-slow");
  const B_STARTED = new Date(START + 200).toISOString();

  const mkWin = (id, prompt, startedAt, options = {}, extra = {}) => ({
    id,
    dead: false,
    panePid: "",
    options: {
      tq_agent: "cursor-agent", tq_cwd: "/w", tq_started: startedAt,
      tq_session: "", tq_session_attr: "", tq_session_id: "", tq_resumed_from: "",
      tq_prompt: prompt, ...options,
    },
    ...extra,
  });

  function optionStore(initial = {}) {
    const store = new Map(Object.entries(initial));
    return {
      getSessionOption: (name) => store.get(name) ?? "",
      setSessionOption: (name, value) => store.set(name, value),
      store,
    };
  }

  const encode = (list) => Buffer.from(JSON.stringify(list), "utf8").toString("base64");

  test("syncRunLedger persists every run window's attribution facts and round-trips", () => {
    const opts = optionStore();
    const winB = mkWin("@2", "fast-beta", B_STARTED, { tq_session: fB, tq_session_attr: "prompt" });
    const bare = { id: "@0", options: null }; // non-run windows never enter the ledger
    syncRunLedger([winB, bare], opts);
    const ledger = readRunLedger(opts);
    assert.equal(ledger.length, 1);
    assert.deepEqual(ledger[0], {
      id: "@2", agent: "cursor-agent", cwd: "/w", started: B_STARTED, ended: "",
      prompt: "fast-beta", sessionId: "", session: fB, attr: "prompt",
    });
    assert.match(opts.store.get(RUN_LEDGER_OPTION), /^[A-Za-z0-9+/=]+$/, "locale-proof base64 ASCII");

    // Unchanged windows: the second sync writes nothing new.
    const before = opts.store.get(RUN_LEDGER_OPTION);
    syncRunLedger([winB, bare], opts);
    assert.equal(opts.store.get(RUN_LEDGER_OPTION), before);
  });

  test("a ledgered window that VANISHES without a tombstone gets one synthesized — claim, prompt and lifetime intact", () => {
    const winA = mkWin("@1", "slow-alpha", STARTED_AT);
    const opts = optionStore({
      [RUN_LEDGER_OPTION]: encode([
        { id: "@1", agent: "cursor-agent", cwd: "/w", started: STARTED_AT, prompt: "slow-alpha", sessionId: "", session: "", attr: "" },
        { id: "@2", agent: "cursor-agent", cwd: "/w", started: B_STARTED, prompt: "fast-beta", sessionId: "", session: fB, attr: "prompt" },
      ]),
    });
    // @2 was killed directly in tmux (kill-window / prefix-&): gone from
    // the window list, no tombstone anywhere.
    syncRunLedger([winA], opts);
    const stones = readRunTombstones(opts);
    assert.equal(stones.length, 1);
    assert.deepEqual(
      { id: stones[0].id, agent: stones[0].agent, cwd: stones[0].cwd, started: stones[0].started, prompt: stones[0].prompt, session: stones[0].session, attr: stones[0].attr },
      { id: "@2", agent: "cursor-agent", cwd: "/w", started: B_STARTED, prompt: "fast-beta", session: fB, attr: "prompt" },
    );
    assert.ok(Date.parse(stones[0].killed) > 0, "killed = detection time bounds the ownable window");
    assert.deepEqual(readRunLedger(opts).map((e) => e.id), ["@1"], "the vanished entry leaves the ledger");

    // The synthesized stone's claim bars the file from the survivor — the
    // tmux-direct kill can no longer launder @2's transcript into @1.
    const p = {
      isSessionPath: (x) => x === fB,
      readdirSync: fakeReaddir(() => [fB]),
      statSync: statWithBirth(new Map([[fB, START + 1200]])),
      realpathSync: (x) => x,
      openPathHolders: () => new Map(),
      descendantPids: (pid) => new Set([String(pid)]),
      firstUserPrompt: () => "fast-beta",
      setWindowOption: () => {},
    };
    const a = linkRunSession(winA, [winA], { home, deps: p, tombstones: stones });
    assert.deepEqual(a, { path: null, link: "pending", attribution: null });
  });

  test("an API-killed run (already tombstoned) is never double-tombstoned by the ledger diff", () => {
    const winA = mkWin("@1", "slow-alpha", STARTED_AT);
    const existing = {
      id: "@2", agent: "cursor-agent", cwd: "/w", started: B_STARTED,
      killed: new Date(START + 1500).toISOString(), prompt: "fast-beta", sessionId: "", session: "", attr: "",
    };
    const opts = optionStore({
      [TOMBSTONE_OPTION]: encode([existing]),
      [RUN_LEDGER_OPTION]: encode([
        { id: "@1", agent: "cursor-agent", cwd: "/w", started: STARTED_AT, prompt: "slow-alpha", sessionId: "", session: "", attr: "" },
        { id: "@2", agent: "cursor-agent", cwd: "/w", started: B_STARTED, prompt: "fast-beta", sessionId: "", session: "", attr: "" },
      ]),
    });
    syncRunLedger([winA], opts);
    const stones = readRunTombstones(opts);
    assert.equal(stones.length, 1, "the kill-API stone already answers for @2");
    assert.equal(stones[0].killed, existing.killed, "the original death time is kept");

    // A MERGED stone that absorbed the id counts as known too.
    const merged = { ...existing, id: "@7", ids: ["@2"] };
    const opts2 = optionStore({
      [TOMBSTONE_OPTION]: encode([merged]),
      [RUN_LEDGER_OPTION]: encode([
        { id: "@2", agent: "cursor-agent", cwd: "/w", started: B_STARTED, prompt: "fast-beta", sessionId: "", session: "", attr: "" },
      ]),
    });
    syncRunLedger([winA], opts2);
    assert.equal(readRunTombstones(opts2).length, 1, "no duplicate for an absorbed id");
  });

  test("readRunLedger degrades to [] on absent/garbage state", () => {
    assert.deepEqual(readRunLedger({ getSessionOption: () => "" }), []);
    assert.deepEqual(readRunLedger({ getSessionOption: () => "not-base64!!!" }), []);
    assert.deepEqual(readRunLedger({ getSessionOption: () => Buffer.from("{}").toString("base64") }), []);
    assert.deepEqual(readRunLedger({ getSessionOption: () => { throw new Error("tmux gone"); } }), []);
  });

  test("a resumed run's ledger entry carries NO content prompt (fork recordings never open with the follow-up)", () => {
    const opts = optionStore();
    const fork = mkWin("@3", "follow-up", STARTED_AT, { tq_resumed_from: "abcd1234" });
    syncRunLedger([fork], opts);
    assert.equal(readRunLedger(opts)[0].prompt, "", "the follow-up prompt is not content identity");
    // …so its synthesized stone can never disown a fresh run's recording
    // that happens to open with the same wording. (A pending survivor in
    // the same space keeps the stone relevant.)
    const survivor = mkWin("@1", "shared wording", STARTED_AT);
    syncRunLedger([survivor], opts);
    const stones = readRunTombstones(opts);
    assert.equal(stones.length, 1);
    assert.equal(stones[0].prompt, "");
    void fA;
  });
});

describe("run-session-link — freshness path", () => {
  test("jsonl recordings stat themselves; grok session dirs stat chat_history.jsonl", () => {
    assert.equal(sessionFreshnessPath("/h/.claude/projects/-w/s.jsonl"), "/h/.claude/projects/-w/s.jsonl");
    assert.equal(
      sessionFreshnessPath("/h/.grok/sessions/%2Fw/sess-1"),
      join("/h/.grok/sessions/%2Fw/sess-1", "chat_history.jsonl"),
    );
  });
});

/**
 * r8 regression lane — the CODEX dialect, through the REAL extraction path.
 *
 * Every prompt-corroboration test above injects deps.firstUserPrompt, which is
 * exactly the stub-drift mechanism that hid r6 for five rounds and r7 for one:
 * the real peekCodex was never exercised against the real rollout dialect.
 * These tests write REAL rollout lines (verified against 757 rollouts on a
 * live machine: the FIRST user response_item is the injected instruction
 * context — "# AGENTS.md instructions for <path>" markdown plus XML-wrapped
 * blocks — and the true prompt arrives later as an event_msg user_message
 * plus its own user response_item) and let recordingFirstPrompt/peekSession
 * do the extraction.
 */
describe("run-session-link — codex dialect (real extraction, r8)", () => {
  const CODEX_TS = "2026-08-12T13:00:00.000Z";

  /** Real-dialect rollout lines: injection first, true prompt later. */
  function codexRolloutContent(prompt, { replayOf = null } = {}) {
    const lines = [
      { timestamp: CODEX_TS, type: "session_meta", payload: { id: `sess-${prompt}`, cwd: "/w", model_provider: "openai" } },
      {
        timestamp: CODEX_TS,
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "<recommended_plugins>\nplugins…\n</recommended_plugins>" },
            { type: "input_text", text: "# AGENTS.md instructions for /w\n\n<INSTRUCTIONS>injected, identical in EVERY rollout</INSTRUCTIONS>" },
            { type: "input_text", text: "<environment_context>\n  <cwd>/w</cwd>\n</environment_context>" },
          ],
        },
      },
    ];
    // A fork rollout replays the SOURCE conversation before new turns; a
    // fresh rollout carries its own prompt.
    const firstUser = replayOf ?? prompt;
    lines.push({ timestamp: CODEX_TS, type: "event_msg", payload: { type: "user_message", message: firstUser } });
    lines.push({
      timestamp: CODEX_TS,
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: firstUser }] },
    });
    lines.push({
      timestamp: CODEX_TS,
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `REPLY to ${firstUser}` }] },
    });
    return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  }

  /** Write a real-dialect rollout into the REAL dated layout under `home`. */
  function writeRollout(home, name, prompt, whenMs, opts = {}) {
    const dir = join(home, ".codex", "sessions", "2026", "08", "12");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, codexRolloutContent(prompt, opts));
    utimesSync(path, new Date(whenMs), new Date(whenMs));
    return path;
  }

  const mkCodexWin = (id, prompt, startedAt, options = {}) => ({
    id,
    dead: false,
    panePid: "",
    options: {
      tq_agent: "codex", tq_cwd: "/w", tq_started: startedAt,
      tq_session: "", tq_session_attr: "", tq_prompt: prompt, ...options,
    },
  });

  /** Real fs + REAL peekSession; only tmux/probe layers are stubbed. */
  function realPeekDeps(persisted) {
    return {
      isSessionPath: () => true,
      openPathHolders: () => new Map(),
      descendantPids: () => new Set(),
      setWindowOption: (id, name, value) => persisted.push([id, name, value]),
    };
  }

  test("a prompted codex run links its OWN rollout despite the AGENTS.md injection opening the file (r7 regression)", async () => {
    const { clearFirstPromptMemo } = await import("../../src/sessions/run-session-link.js");
    clearFirstPromptMemo();
    const home = mkTmp("tq-rsl-codex-dialect-");
    // Real files carry today's birthtime; place the run start safely before it.
    const nowMs = Date.now();
    const startedAt = new Date(nowMs - 60_000).toISOString();
    const own = writeRollout(home, "rollout-own.jsonl", "fix the flaky auth test", nowMs - 30_000);
    const persisted = [];
    const win = mkCodexWin("@1", "fix the flaky auth test", startedAt);
    const got = linkRunSession(win, [win], { home, deps: realPeekDeps(persisted), tombstones: [] });
    assert.deepEqual(got, { path: own, link: "linked", attribution: "prompt" },
      "peekCodex must surface the TRUE prompt, not the AGENTS.md injection — or self-recognition skips the run's own rollout forever");
  });

  test("two prompted codex runs disambiguate by REAL first prompts — the shared AGENTS.md injection is not an equal-prompt collision", async () => {
    const { clearFirstPromptMemo } = await import("../../src/sessions/run-session-link.js");
    clearFirstPromptMemo();
    const home = mkTmp("tq-rsl-codex-two-");
    const nowMs = Date.now();
    const startedAt = new Date(nowMs - 60_000).toISOString();
    const fA = writeRollout(home, "rollout-a.jsonl", "alpha task", nowMs - 30_000);
    const fB = writeRollout(home, "rollout-b.jsonl", "beta task", nowMs - 20_000);
    const winA = mkCodexWin("@1", "alpha task", startedAt);
    const winB = mkCodexWin("@2", "beta task", new Date(nowMs - 59_000).toISOString());
    const a = linkRunSession(winA, [winA, winB], { home, deps: realPeekDeps([]), tombstones: [] });
    const b = linkRunSession(winB, [winA, winB], { home, deps: realPeekDeps([]), tombstones: [] });
    assert.deepEqual(a, { path: fA, link: "linked", attribution: "prompt" });
    assert.deepEqual(b, { path: fB, link: "linked", attribution: "prompt" });
  });

  test("a RESUMED codex run corroborates its fork rollout via tq_fork_prompt — the source's true first prompt, not the injection", async () => {
    const { clearFirstPromptMemo } = await import("../../src/sessions/run-session-link.js");
    clearFirstPromptMemo();
    const home = mkTmp("tq-rsl-codex-resume-");
    const nowMs = Date.now();
    // The SOURCE rollout predates the run — never a candidate.
    const src = writeRollout(home, "rollout-src.jsonl", "original conversation opener", nowMs - 300_000);
    const startedAt = new Date(nowMs - 60_000).toISOString();
    // codex resume writes a NEW rollout replaying the source conversation
    // (injection first, then the source's first user message).
    const fork = writeRollout(home, "rollout-fork.jsonl", "follow-up question", nowMs - 30_000, {
      replayOf: "original conversation opener",
    });
    const persisted = [];
    const win = mkCodexWin("@1", "follow-up question", startedAt, {
      tq_resumed_from: "cafe1234",
      tq_resumed_path: src,
      tq_fork_prompt: "original conversation opener",
    });
    const got = linkRunSession(win, [win], { home, deps: realPeekDeps(persisted), tombstones: [] });
    assert.deepEqual(got, { path: fork, link: "linked", attribution: "prompt" },
      "tq_fork_prompt (the source's REAL first prompt) must recognize the fork rollout; before r8 every rollout answered the identical AGENTS.md text and resumes were dead");
  });
});
