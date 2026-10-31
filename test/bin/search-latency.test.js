/**
 * Search that never stalls (facts sidx3, sidx4, flt1, flt2, sd1): the phrase
 * pre-check and the sliced filter give the unsliced answers, sliced index
 * changes reach the unsliced state, and the resident search answers byte for
 * byte what the in-process search prints.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkTmp, writeJsonl } from "../helpers/fixtures.js";
import { scanSessionForQuery, sessionHasPhrase, phraseMayOccurInFile } from "../../src/sessions/scan-queries.js";
import { SearchIndex } from "../../src/sessions/search-index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");

function claudeLines(name, texts, extra = []) {
  return [
    { type: "user", sessionId: name, cwd: "/home/dev/app", timestamp: "2026-05-01T00:00:00Z", uuid: `u-${name}`, message: { content: [{ type: "text", text: `Session ${name}` }] } },
    ...texts.map((text, i) => ({ type: "assistant", sessionId: name, timestamp: "2026-05-01T00:00:01Z", uuid: `a-${name}-${i}`, message: { model: "claude-sonnet-4-20250514", content: [{ type: "text", text }], usage: { input_tokens: 5, output_tokens: 5 } } })),
    ...extra,
  ];
}

describe("quoted phrase verification (flt2)", () => {
  const dir = mkTmp("tq-phrase-check-");
  const file = (name, lines) => {
    const path = join(dir, `${name}.jsonl`);
    writeJsonl(path, lines);
    return { path, source: "claude" };
  };
  const sessions = [
    file("plain", claudeLines("plain", ["You're Absolutely RIGHT about that"])),
    file("absent", claudeLines("absent", ["nothing to see here, right?"])),
    // The phrase only appears once a \u escape is decoded (JSON.stringify never writes these).
    { path: join(dir, "escaped.jsonl"), source: "claude" },
    // U+212A KELVIN SIGN lowercases to "k".
    file("kelvin", claudeLines("kelvin", ["the Key thing"])),
    // A command field: decoded before matching.
    file("command", claudeLines("command", ["ok"], [{ type: "assistant", sessionId: "command", uuid: "c1", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "echo let\tme in" } }] } }])),
    file("split", claudeLines("split", ["let", "me"])),
  ];
  writeFileSync(sessions[2].path, claudeLines("escaped", ["placeholder"])
    .map((line) => JSON.stringify(line).replace("placeholder", "you\\u0027re absolutely right")).join("\n") + "\n");

  for (const phrase of ["you're absolutely right", "absolutely right", "key thing", "let\tme", "let me", "right", "missing words", "\"text\"", "über", "k"]) {
    test(`same answer as a full scan: ${JSON.stringify(phrase)}`, () => {
      for (const session of sessions) {
        assert.equal(sessionHasPhrase(session, phrase), scanSessionForQuery(session, phrase, 1).length > 0, `${session.path} ${phrase}`);
      }
    });
  }

  test("the sidecar's byte test answers what phraseMayOccurInFile answers (flt7)", async (t) => {
    const sidecar = join(ROOT, "sidecar/target/release/tracequest-sidecar");
    if (!existsSync(sidecar)) return t.skip("no sidecar build");
    const files = sessions.map((s) => s.path);
    for (const phrase of ["you're absolutely right", "absolutely right", "key thing", "let me", "right", "missing words", "k", "re abs"]) {
      const r = spawnSync(sidecar, ["phrase"], { input: JSON.stringify({ phrase, files }) });
      assert.equal(r.status, 0, r.stderr.toString());
      const answers = JSON.parse(r.stdout);
      assert.deepEqual(answers.map(([from]) => from >= 0), files.map((f) => phraseMayOccurInFile(f, phrase)), phrase);
      sessions.forEach((session, k) => {
        const [from, size, mtimeNs] = answers[k];
        if (from >= 0) assert.equal(sessionHasPhrase(session, phrase, from, { size, mtimeNs }), sessionHasPhrase(session, phrase), `${session.path} ${phrase} from ${from}`);
      });
    }
  });

  test("an aborted phrase check stops the sidecar's byte test at once (flt7)", async () => {
    const { runSidecarAsync } = await import("../../src/sessions/index-writers.js");
    const marker = join(dir, "slow-sidecar-finished");
    const fake = join(dir, "slow-sidecar.sh");
    writeFileSync(fake, `#!/bin/sh\ncat >/dev/null\nsleep 2\ntouch ${marker}\necho '[]'\n`, { mode: 0o755 });
    const before = process.env.TRACEQUEST_SIDECAR_PATH;
    process.env.TRACEQUEST_SIDECAR_PATH = fake;
    try {
      const ac = new AbortController();
      const started = performance.now();
      const pending = runSidecarAsync("phrase", ["phrase"], (r) => JSON.parse(r.stdout), { input: "{}", signal: ac.signal });
      setTimeout(() => ac.abort(), 50);
      assert.equal(await pending, null);
      assert.ok(performance.now() - started < 1000, "resolved soon after the abort");
      await new Promise((r) => setTimeout(r, 2500));
      assert.equal(existsSync(marker), false, "the sidecar was stopped, not left to finish");
    } finally {
      if (before === undefined) delete process.env.TRACEQUEST_SIDECAR_PATH;
      else process.env.TRACEQUEST_SIDECAR_PATH = before;
    }
  });

  test("a file rewritten after the byte test is scanned from its start (flt7)", async (t) => {
    const sidecar = join(ROOT, "sidecar/target/release/tracequest-sidecar");
    if (!existsSync(sidecar)) return t.skip("no sidecar build");
    const path = join(dir, "rewritten.jsonl");
    const lines = claudeLines("rewritten", ["filler ".repeat(100), "the moved phrase"]);
    writeJsonl(path, lines);
    const r = spawnSync(sidecar, ["phrase"], { input: JSON.stringify({ phrase: "the moved phrase", files: [path] }) });
    const [[from, size, mtimeNs]] = JSON.parse(r.stdout);
    assert.ok(from > 0, "the phrase is past the first line");
    // Compacted between the byte test and the line scan: the phrase now starts the file.
    writeJsonl(path, [lines[2]]);
    const session = { path, source: "claude" };
    assert.equal(sessionHasPhrase(session, "the moved phrase", from, { size, mtimeNs }), true);
    assert.equal(sessionHasPhrase(session, "the moved phrase"), true);
  });

  test("a file without the phrase bytes is ruled out without a line scan", () => {
    assert.equal(phraseMayOccurInFile(sessions[1].path, "absolutely right"), false);
    assert.equal(phraseMayOccurInFile(sessions[0].path, "absolutely right"), true);
    assert.equal(phraseMayOccurInFile(sessions[2].path, "you're absolutely right"), true, "a \\u escape of a phrase character keeps the file");
    assert.equal(phraseMayOccurInFile(sessions[3].path, "key"), true, "a character that lowercases to k keeps the file");
  });
});

describe("scan-line cache bounded by characters (mem1)", () => {
  test("lines beyond the character bound are evicted or not kept, and scans answer the same", async () => {
    const { setScanLineCacheSize, scanSessionForQuery } = await import("../../src/sessions/scan-queries.js");
    const dir = mkTmp("tq-mem1-");
    const sessions = [0, 1, 2].map((i) => {
      const path = join(dir, `m${i}.jsonl`);
      writeJsonl(path, claudeLines(`m${i}`, [`needle ${i} ` + "x".repeat(20000)]));
      return { path, source: "claude", size: 1, mtime: i };
    });
    const before = sessions.map((s) => scanSessionForQuery(s, "needle", 3));
    try {
      setScanLineCacheSize(50, 30000);
      for (const s of sessions) scanSessionForQuery(s, "needle", 3);
      // Each session's lines are about 20,000 characters: only the latest one fits.
      for (const s of sessions) writeFileSync(s.path, "");
      assert.deepEqual(scanSessionForQuery(sessions[2], "needle", 3), before[2], "the latest session is served from the cache");
      assert.deepEqual(scanSessionForQuery(sessions[0], "needle", 3), [], "an evicted session is read from its file again");
      setScanLineCacheSize(50, 100);
      assert.deepEqual(scanSessionForQuery(sessions[2], "needle", 3), [], "lowering the bound evicts");
    } finally {
      setScanLineCacheSize(50, 128 * 1024 * 1024);
    }
  });
});

describe("prefix matches of a short last word (rq1)", () => {
  test("thousands of prefix terms resolve in linear time, same matches in the same order", async () => {
    const { resolveQueryToken } = await import("../../src/sessions/scan-queries.js");
    const si = new SearchIndex();
    const terms = Array.from({ length: 40000 }, (_, i) => `t${i.toString(36)}`);
    si.upsertMany([["/doc/a.jsonl", new Map(terms.map((t) => [t, 1]))]]);
    const started = performance.now();
    const matches = resolveQueryToken("t", true, si);
    const ms = performance.now() - started;
    const naive = [];
    for (const m of [...resolveQueryToken("t", false, si), ...terms.filter((t) => t !== "t").map((term) => ({ term, weight: 1.0 }))]) {
      if (!naive.some((n) => n.term === m.term)) naive.push(m);
    }
    assert.deepEqual(matches.map((m) => m.term), naive.map((m) => m.term));
    assert.ok(ms < 1000, `${Math.round(ms)} ms for 40,000 prefix terms`);
  });
});

describe("sliced filter evaluation (flt1)", () => {
  test("applyExprToApiObjectsAsync returns what applyExprToApiObjects returns, and null once aborted", async () => {
    const { applyExprToApiObjects, applyExprToApiObjectsAsync } = await import("../../src/filter/filter.js");
    const now = Date.now();
    const objects = Array.from({ length: 300 }, (_, i) => ({
      path: `/s/${i}.jsonl`, id: `id${i}`, source: i % 3 ? "claude" : "codex", project: i % 2 ? "app" : "web",
      prompt: i % 5 ? `fix the build ${i}` : `deploy ${i}`, model: "m", mtime: now - i * 1000, errors: i % 7, tools: [],
    }));
    for (const expr of ["project:app", "fix", "source:codex errors:>2", "deploy OR project:web", ""]) {
      const want = applyExprToApiObjects(objects.slice(), expr, "recent").map((o) => o.id);
      const got = (await applyExprToApiObjectsAsync(objects.slice(), expr, "recent", { sliceMs: 0 })).map((o) => o.id);
      assert.deepEqual(got, want, expr);
    }
    const ac = new AbortController();
    ac.abort();
    assert.equal(await applyExprToApiObjectsAsync(objects.slice(), "fix", "recent", { signal: ac.signal, sliceMs: 0 }), null);
  });
});

describe("sliced search index changes (sidx3)", () => {
  const terms = (seed, n) => new Map(Array.from({ length: n }, (_, i) => [`t${(seed * 7 + i * 13) % 500}`, 1 + ((seed + i) % 4)]));
  const build = () => {
    const si = new SearchIndex();
    si.upsertMany(Array.from({ length: 120 }, (_, d) => [`/d/${d}`, terms(d, 40)]));
    // Loaded from disk: no remembered terms, as in a fresh process.
    si._docTerms.clear();
    return si;
  };

  test("prepareUpsertAsync then upsertMany reaches the unprepared state", async () => {
    const change = [["/d/3", terms(900, 30)], ["/d/77", terms(901, 10)], ["/d/new", terms(902, 20)]];
    const plain = build();
    plain.upsertMany(change);
    const prepared = build();
    await prepared.prepareUpsertAsync(change.map(([p]) => p), 0);
    assert.ok(prepared._planned, "old terms found ahead of the change");
    prepared.upsertMany(change);
    assert.deepEqual(prepared._snapshot(), plain._snapshot());
  });

  test("terms that come and go during a sliced trigram build are caught up, not restarted (sidx5)", async () => {
    const same = (kept, rebuilt) => {
      assert.deepEqual([...kept.keys()].sort(), [...rebuilt.keys()].sort());
      for (const [tg, bucket] of rebuilt) assert.deepEqual([...kept.get(tg)], [...bucket], tg);
    };
    for (const finishSync of [false, true]) {
      const si = build();
      const building = si.buildTrigramsAsync(0);
      const started = si._trigramBuild;
      si.upsertMany([["/d/5", new Map([["brandnew", 2], ["t1", 1]])], ["/d/6", null]]);
      si.removeMany(["/d/7"]);
      si.upsertMany([["/d/8", new Map([["laterterm", 1]])]]);
      assert.equal(si._trigramBuild, started, "the build in progress goes on");
      if (finishSync) si.trigramIndex();
      await building;
      const kept = si._trigrams;
      assert.ok(kept, "built");
      si._trigrams = null;
      same(kept, si.trigramIndex());
    }
  });

  test("the trigram index stays what a rebuild gives as terms come and go", () => {
    const si = build();
    si.trigramIndex();
    si.upsertMany([["/d/5", new Map([["brandnew", 2], ["t1", 1]])], ["/d/6", null]]);
    si.removeMany(["/d/7"]);
    const kept = si._trigrams;
    si._trigrams = null;
    const rebuilt = si.trigramIndex();
    assert.deepEqual([...kept.keys()].sort(), [...rebuilt.keys()].sort());
    for (const [tg, bucket] of rebuilt) assert.deepEqual([...kept.get(tg)], [...bucket], tg);
  });
});

describe("resident search (sd1)", () => {
  test("a second search is answered by the resident search with the in-process output, byte for byte", async () => {
    const home = mkTmp("tq-resident-");
    for (let i = 0; i < 6; i++) {
      writeJsonl(join(home, ".claude/projects/-home-dev-app", `s${i}.jsonl`), claudeLines(`s${i}`, [
        i % 2 ? "you're absolutely right, let me fix the build" : "the build is broken again",
        `note ${i} about the sidecar timeout`,
      ]));
    }
    const env = { ...process.env, HOME: home, TRACEQUEST_CACHE_DIR: join(home, "cache"), TRACEQUEST_NO_SIDECAR: "1", NO_COLOR: "1" };
    delete env.TRACEQUEST_SKIP_LR_WATCH;
    delete env.TRACEQUEST_SIDECAR_PATH;
    const run = (args, extra = {}) => {
      const r = spawnSync(process.execPath, [BIN, ...args], { cwd: home, env: { ...env, ...extra }, encoding: "utf8", timeout: 60_000 });
      assert.equal(r.status, 0, r.stderr);
      return r;
    };
    const socket = () => (existsSync(join(home, "cache")) ? readdirSync(join(home, "cache")).find((n) => n.endsWith(".sock")) : undefined);
    try {
      run(["search", "build"]);
      const deadline = Date.now() + 20_000;
      while (!socket() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      assert.ok(socket(), "the first search started a resident search");
      for (const args of [["search", "absolutely right", "--json"], ["search", "sidecar timeout"], ["handoff", "let me fix"], ["handoff", "build", "--sort", "recent"]]) {
        const resident = run(args);
        const inProcess = run(args, { TRACEQUEST_NO_SEARCH_DAEMON: "1" });
        assert.equal(resident.stdout, inProcess.stdout, args.join(" "));
        assert.equal(resident.stderr, inProcess.stderr, args.join(" "));
      }
    } finally {
      const pids = spawnSync("pgrep", ["-f", `search-daemon-main.js ${join(home, "cache")}`], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
      for (const pid of pids) process.kill(Number(pid), "SIGTERM");
    }
  });
});

describe("a searching process that leaves (sd3)", () => {
  test("the resident search sees the client go while it searches, and answers a client that stays", async () => {
    const { serveSearchSocket } = await import("../../src/cli/search-daemon.js");
    const net = await import("node:net");
    let sawGone = null;
    const server = net.createServer({ allowHalfOpen: true }, (sock) => serveSearchSocket(sock, async (req, isGone) => {
      if (req.q === "stay") return { ok: true, q: req.q };
      const started = performance.now();
      while (!isGone() && performance.now() - started < 3000) await new Promise((r) => setTimeout(r, 5));
      sawGone = isGone() ? performance.now() - started : null;
      return { ok: false };
    }));
    const path = join(mkTmp("tq-sd3-"), "s.sock");
    await new Promise((r) => server.listen(path, r));
    try {
      const leaving = net.connect(path);
      await new Promise((r) => leaving.on("connect", r));
      leaving.write(JSON.stringify({ q: "leave" }) + "\n");
      await new Promise((r) => setTimeout(r, 50));
      leaving.destroy();
      const deadline = Date.now() + 3000;
      while (sawGone === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      assert.ok(sawGone !== null && sawGone < 1000, `the search saw its client go (${sawGone} ms)`);
      const staying = net.connect(path);
      let reply = "";
      staying.setEncoding("utf8");
      staying.on("data", (c) => { reply += c; });
      await new Promise((r) => staying.on("connect", r));
      staying.write(JSON.stringify({ q: "stay" }) + "\n");
      await new Promise((r) => staying.on("end", r));
      staying.end();
      assert.deepEqual(JSON.parse(reply), { ok: true, q: "stay" });
    } finally {
      server.close();
    }
  });
});

describe("index as it is while the resident search catches up (sd2)", () => {
  test("deferStale returns changed sessions as last indexed, leaves new ones out and changes nothing", async () => {
    const home = mkTmp("tq-defer-stale-");
    const saved = { HOME: process.env.HOME, CACHE: process.env.TRACEQUEST_CACHE_DIR, NO_SIDECAR: process.env.TRACEQUEST_NO_SIDECAR };
    process.env.HOME = home;
    process.env.TRACEQUEST_CACHE_DIR = join(home, "cache");
    process.env.TRACEQUEST_NO_SIDECAR = "1";
    try {
      const dir = join(home, ".claude/projects/-home-dev-app");
      for (let i = 0; i < 6; i++) writeJsonl(join(dir, `s${i}.jsonl`), claudeLines(`s${i}`, [`first words ${i}`]));
      const { findSessions, buildIndex } = await import("../../src/sessions.js");
      const writers = await import("../../src/sessions/index-writers.js");
      const first = buildIndex(findSessions(null));
      writers.flushDeferredIndexWriteForTests();
      writers.flushDeferredSearchIdxWriteForTests();
      const { getSearchIndex } = await import("../../src/sessions/search-index.js");
      const generation = getSearchIndex()._generation;
      const oldMeta = first.get(join(dir, "s0.jsonl"));
      await new Promise((r) => setTimeout(r, 20));
      writeJsonl(join(dir, "s0.jsonl"), claudeLines("s0", ["first words 0", "a later reply"]));
      writeJsonl(join(dir, "s9.jsonl"), claudeLines("s9", ["a new session"]));
      const deferred = buildIndex(findSessions(null), { deferStale: true });
      assert.equal(deferred.deferredStale, 2);
      assert.equal(deferred.get(join(dir, "s0.jsonl")), oldMeta, "a changed session as last indexed");
      assert.equal(deferred.has(join(dir, "s9.jsonl")), false, "a new session is not indexed yet");
      assert.equal(getSearchIndex()._generation, generation, "the search index is left as it is");
      assert.equal(getSearchIndex().has(join(dir, "s9.jsonl")), false);
    } finally {
      process.env.HOME = saved.HOME;
      if (saved.CACHE === undefined) delete process.env.TRACEQUEST_CACHE_DIR; else process.env.TRACEQUEST_CACHE_DIR = saved.CACHE;
      if (saved.NO_SIDECAR === undefined) delete process.env.TRACEQUEST_NO_SIDECAR; else process.env.TRACEQUEST_NO_SIDECAR = saved.NO_SIDECAR;
    }
  });
});

describe("an empty index is built, not deferred (sd2)", () => {
  test("deferStale on a cache with nothing indexed indexes in place", async () => {
    const home = mkTmp("tq-defer-empty-");
    const saved = { HOME: process.env.HOME, CACHE: process.env.TRACEQUEST_CACHE_DIR, NO_SIDECAR: process.env.TRACEQUEST_NO_SIDECAR };
    process.env.HOME = home;
    process.env.TRACEQUEST_CACHE_DIR = join(home, "cache-empty");
    process.env.TRACEQUEST_NO_SIDECAR = "1";
    try {
      const dir = join(home, ".claude/projects/-home-dev-app");
      for (let i = 0; i < 3; i++) writeJsonl(join(dir, `e${i}.jsonl`), claudeLines(`e${i}`, [`empty cache words ${i}`]));
      const { findSessions, buildIndex } = await import("../../src/sessions.js");
      const writers = await import("../../src/sessions/index-writers.js");
      writers.resetIndexWritersForTests();
      const built = buildIndex(findSessions(null), { deferStale: true });
      assert.equal(built.deferredStale, undefined);
      assert.equal(built.size, 3);
    } finally {
      process.env.HOME = saved.HOME;
      if (saved.CACHE === undefined) delete process.env.TRACEQUEST_CACHE_DIR; else process.env.TRACEQUEST_CACHE_DIR = saved.CACHE;
      if (saved.NO_SIDECAR === undefined) delete process.env.TRACEQUEST_NO_SIDECAR; else process.env.TRACEQUEST_NO_SIDECAR = saved.NO_SIDECAR;
    }
  });
});

describe("escapes across the 1 MB read boundary (flt2)", () => {
  test("a \\u escape of a phrase character split by the read boundary keeps the file", () => {
    const dir = mkTmp("tq-escape-boundary-");
    const path = join(dir, "s.jsonl");
    const CHUNK = 1 << 20;
    for (const [phrase, raw] of [["i'll", "i\\u0027ll"], ["let me", "let\\u0020me"], ["right", "\\u0072ight"], ["ab", "a\\u0062"], ["key", "\\u212aey"]]) {
      const [pre, post] = JSON.stringify({ type: "assistant", sessionId: "e", uuid: "e1", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "MARK" } }] } }).split("MARK");
      const at = raw.indexOf("\\u");
      for (let off = -7; off <= 7; off++) {
        writeFileSync(path, "z".repeat(CHUNK + off - at - pre.length - 1) + "\n" + pre + raw + post + "\n");
        assert.equal(scanSessionForQuery({ path, source: "claude" }, phrase, 1).length > 0, true, "fixture: the phrase is in the decoded command");
        assert.equal(phraseMayOccurInFile(path, phrase), true, `${phrase} escape at ${off} from the boundary`);
        assert.equal(sessionHasPhrase({ path, source: "claude" }, phrase), true);
      }
    }
  });
});

describe("quoted phrases checked off the event loop (flt1, flt3)", () => {
  const dir = mkTmp("tq-offthread-");
  const objects = [];
  const texts = ["you're absolutely right about it", "let me check that", "absolutely right", "nothing here", "let it be, me too"];
  for (let i = 0; i < 25; i++) {
    const path = join(dir, `o${i}.jsonl`);
    writeJsonl(path, claudeLines(`o${i}`, [texts[i % texts.length], `extra ${i}`]));
    objects.push({ path, source: "claude", id: `o${i}`, project: i % 2 ? "app" : "web", prompt: `Session o${i}`, model: "m", mtime: Date.now() - i * 1000, errors: 0, tools: [] });
  }

  test("the same sessions as the synchronous filter, phrases inside and/or/not", async () => {
    const { tokenize } = await import("../../src/sessions/search-tokenizer.js");
    const si = await import("../../src/sessions/search-index.js");
    // A search index over the fixture, so the phrases' words have match sets.
    const idx = si.getSearchIndex();
    idx.upsertMany(objects.map((o, i) => [o.path, new Map(tokenize(`${texts[i % texts.length]} extra ${i}`).map((t) => [t, 1]))]));
    const { applyExprToApiObjects, applyExprToApiObjectsAsync } = await import("../../src/filter/filter.js");
    const { verifyPhraseOffThread } = await import("../../src/server/phrase-check.js");
    for (const expr of ['"absolutely right"', '"let me"', 'project:app "let me"', '"let me" OR "absolutely right"', '-"absolutely right"', 'project:web -"let me"', '"you\'re absolutely right"']) {
      const want = applyExprToApiObjects(objects.slice(), expr, "recent").map((o) => o.id);
      const got = (await applyExprToApiObjectsAsync(objects.slice(), expr, "recent", { sliceMs: 0, verifyPhrase: verifyPhraseOffThread })).map((o) => o.id);
      assert.deepEqual(got, want, expr);
    }
    const ac = new AbortController();
    const pending = applyExprToApiObjectsAsync(objects.slice(), '"let me"', "recent", { signal: ac.signal, verifyPhrase: verifyPhraseOffThread });
    ac.abort();
    assert.equal(await pending, null, "an aborted filter stops");
  });

  test("a first page checked in list order holds exactly the complete answer's first rows (flt5)", async () => {
    const { applyExprToApiObjects, applyExprFirstResultsAsync } = await import("../../src/filter/filter.js");
    const { verifyPhraseOffThread } = await import("../../src/server/phrase-check.js");
    for (const sort of ["recent", "recent-asc", "errors", "cost"]) {
      for (const expr of ['"let me"', '"absolutely right"', 'project:app "let me"', '"let me" OR "absolutely right"', '-"absolutely right"', '"nowhere at all"', 'o3 "let me"']) {
        const want = applyExprToApiObjects(objects.slice(), expr, sort).map((o) => o.id);
        for (const firstResults of [1, 2, 3, 7, 50]) {
          const answer = await applyExprFirstResultsAsync(objects.slice(), expr, sort, { sliceMs: 0, verifyPhrase: verifyPhraseOffThread, firstResults });
          const got = answer.objects.map((o) => o.id);
          assert.deepEqual(got, answer.partial ? want.slice(0, firstResults) : want, `${expr} ${sort} ${firstResults}`);
          if (answer.partial) assert.equal(got.length, firstResults, `${expr} ${sort} ${firstResults}`);
        }
      }
    }
    const partial = await applyExprFirstResultsAsync(objects.slice(), '"let me"', "recent", { sliceMs: 0, verifyPhrase: verifyPhraseOffThread, firstResults: 1 });
    assert.equal(partial.partial, true, "one row of many answers early");
  });

  test("a large session file does not hold the event loop while it is checked", async () => {
    const big = join(dir, "big.jsonl");
    const line = JSON.stringify({ type: "assistant", sessionId: "big", uuid: "b", message: { content: [{ type: "text", text: "x".repeat(4000) }] } }) + "\n";
    writeFileSync(big, line.repeat(15000) + JSON.stringify(claudeLines("big", ["let me check the end"])[1]) + "\n");
    const { verifyPhraseOffThread } = await import("../../src/server/phrase-check.js");
    let worst = 0;
    let last = performance.now();
    const timer = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; }, 5);
    const found = await verifyPhraseOffThread("let me check the end", [{ path: big, source: "claude", size: 0, mtime: 0 }]);
    clearInterval(timer);
    assert.ok(found.has(big), "found at the end of a 60 MB file");
    assert.ok(worst < 100, `the event loop kept turning (longest gap ${worst.toFixed(0)} ms)`);
  });
});

describe("quoted top-bar searches checked in workers (hsw1)", () => {
  test("the same results as the in-process search, without holding the event loop on a large session", async () => {
    const dir = mkTmp("tq-hsw1-");
    const { tokenize } = await import("../../src/sessions/search-tokenizer.js");
    const si = await import("../../src/sessions/search-index.js");
    const { searchSessions, searchSessionsAsync } = await import("../../src/sessions/scan-queries.js");
    const { searchStepRunner } = await import("../../src/server/search-steps.js");
    const texts = ["you're absolutely right about it", "let me check that", "absolutely right", "let it be, me too"];
    const sessions = [];
    const meta = new Map();
    const idx = si.getSearchIndex();
    for (let i = 0; i < 12; i++) {
      const path = join(dir, `h${i}.jsonl`);
      writeJsonl(path, claudeLines(`h${i}`, [texts[i % texts.length], `extra ${i}`]));
      sessions.push({ path, source: "claude", mtime: new Date(Date.now() - i * 1000) });
      meta.set(path, { firstPrompt: `Session h${i}`, model: "m" });
      idx.upsertMany([[path, new Map(tokenize(`${texts[i % texts.length]} extra ${i}`).map((t) => [t, 1]))]]);
    }
    // Three 60 MB sessions whose phrase is on their last line: checked on the event loop they hold it for hundreds of ms.
    const filler = JSON.stringify({ type: "assistant", sessionId: "big", uuid: "b", message: { content: [{ type: "text", text: "let " + "x".repeat(4000) + " me" }] } }) + "\n";
    for (let b = 0; b < 3; b++) {
      const big = join(dir, `big${b}.jsonl`);
      writeFileSync(big, filler.repeat(15000) + JSON.stringify(claudeLines("big", ["let me see the end"])[1]) + "\n");
      sessions.push({ path: big, source: "claude", mtime: new Date() });
      meta.set(big, { firstPrompt: "Big", model: "m" });
      idx.upsertMany([[big, new Map([["let", 50], ["me", 50], ["see", 1], ["end", 1]])]]);
    }
    for (const q of ['"let me"', '"absolutely right"', 'right "let me"', '"you\'re absolutely right"', "let me"]) {
      const want = JSON.stringify(searchSessions(sessions, meta, q, 10, { snippets: true }));
      let worst = 0;
      let last = performance.now();
      const timer = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; }, 5);
      const got = JSON.stringify(await searchSessionsAsync(sessions, meta, q, 10, { snippets: true }, searchStepRunner(() => false)));
      // A search that never let the timer run held the loop the whole time.
      worst = Math.max(worst, performance.now() - last);
      clearInterval(timer);
      assert.equal(got, want, q);
      assert.ok(worst < 100, `${q}: event loop held ${Math.round(worst)} ms`);
    }
  });
});

describe("search file work whose worker fails (hsw1)", () => {
  test("is retried in a worker and then fails the search, never done on the event loop", async () => {
    const { searchStepRunner } = await import("../../src/server/search-steps.js");
    // A candidate the worker's phraseCandidateScan throws on, every time.
    const step = { phraseScans: [{ path: "/nowhere/x.jsonl", session: null, phrases: ["let me"], docTerms: [] }] };
    await assert.rejects(searchStepRunner(() => false)(step), /failed in its worker/);
  });
});

describe("a quoted phrase whose worker fails (flt4)", () => {
  test("is retried in a worker and then reported, never read on the event loop", async () => {
    const { verifyPhraseOffThread } = await import("../../src/server/phrase-check.js");
    // A directory where a session file should be: reading it fails in the worker, every time.
    const dir = mkTmp("tq-phrase-fail-");
    await assert.rejects(verifyPhraseOffThread("let me", [{ path: dir, source: "claude", size: 0, mtime: 0 }]), /failed in its worker/);
    const source = (await import("node:fs")).readFileSync(join(ROOT, "src/server/phrase-check.js"), "utf8");
    assert.doesNotMatch(source, /from "\.\.\/sessions\/scan-queries\.js"/, "the hub-side checker has no file scanner to fall back on");
  });
});

describe("quoted /sessions?expr= page loads (flt4)", () => {
  test("the hub keeps answering while the page's quoted phrase is checked", async () => {
    const home = mkTmp("tq-page-expr-");
    const dir = join(home, ".claude/projects/-home-dev-app");
    for (let i = 0; i < 3; i++) writeJsonl(join(dir, `p${i}.jsonl`), claudeLines(`p${i}`, [`small session ${i} about the end`]));
    const filler = JSON.stringify({ type: "assistant", sessionId: "big", uuid: "b", message: { content: [{ type: "text", text: "check ".repeat(700) }] } }) + "\n";
    writeFileSync(join(dir, "big.jsonl"), JSON.stringify(claudeLines("big", ["let me check the end"])[0]) + "\n" + filler.repeat(14000) + JSON.stringify(claudeLines("big", ["let me check the end"])[1]) + "\n");
    const { createServer } = await import("node:net");
    const port = await new Promise((resolve) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    const { spawn } = await import("node:child_process");
    const env = { ...process.env, HOME: home, TRACEQUEST_CACHE_DIR: join(home, "cache"), TRACEQUEST_NO_SIDECAR: "1", TRACEQUEST_SKIP_TMUX: "1", TRACEQUEST_TMUX_BIN: "/nonexistent-tracequest-tmux", TRACEQUEST_SKIP_LR_WATCH: "1" };
    const child = spawn(process.execPath, [BIN, "serve", "--port", String(port)], { cwd: ROOT, env, stdio: "ignore" });
    const get = async (path) => { const t = performance.now(); const r = await fetch(`http://127.0.0.1:${port}${path}`); const body = await r.text(); return { ms: performance.now() - t, status: r.status, body }; };
    try {
      for (let i = 0; i < 200; i++) {
        try { if ((await get("/api/sessions")).status === 200) break; } catch { /* starting */ }
        await new Promise((r) => setTimeout(r, 100));
      }
      let slowest = 0;
      let done = false;
      const page = get(`/sessions?expr=${encodeURIComponent('"let me check the end"')}`).finally(() => { done = true; });
      while (!done) {
        slowest = Math.max(slowest, (await get("/api/agents")).ms);
        await new Promise((r) => setTimeout(r, 10));
      }
      const { body } = await page;
      assert.match(body, /big\.jsonl/, "the page lists the session holding the phrase");
      assert.ok(slowest < 100, `other requests answered while the phrase was checked (slowest ${slowest.toFixed(0)} ms)`);
    } finally {
      child.kill("SIGKILL");
    }
  });
});
