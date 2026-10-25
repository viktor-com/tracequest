/**
 * Near-words re-rank cache (search-perf facts): what the scan finds per
 * session file is cached by looked-for words and file stamp, and scores from
 * the cache are exactly the scores of the uncached scan of 29b56c6.
 */
import "../helpers/skip-lr-watch-env.js";
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, closeSync, openSync, readdirSync, rmSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { mkTmp } from "../helpers/fixtures.js";
import {
  CLAUDE_APPEND, NEAR_QUERY, NEAR_WEIGHTS, NEAR_WEIGHTS_2, bigClaudeBody, writeNearSessions,
} from "../helpers/near-cache-fixtures.js";
import { nearTermScorer } from "../../src/sessions/scan-queries.js";

// Scores of the fixtures from the uncached nearTermScorer of 29b56c6 (claude, codex, grok, partial claude).
const EXPECTED_W1 = [1.8027756377319946, 1.4142135623730951, 1.7320508075688772, 0.9235680407334498];
const EXPECTED_W2 = [1.8027756377319946, 1.4142135623730951, 1.7320508075688772, 1.2938549613200656];
const EXPECTED_APPENDED = [1.8708286933869707, 1.4142135623730951, 1.7320508075688772, 0.9235680407334498];

const Q = NEAR_QUERY;
const scorer = (weights) => nearTermScorer(Q.resolvedTerms, weights, Q.distinct, Q.finalToken, Q.verbatim);
const scoreAll = (sessions, weights) => {
  const s = scorer(weights);
  const scores = sessions.map((x) => s(x));
  s.flush();
  return scores;
};

let tmp;
const savedEnv = {};
beforeEach(() => {
  tmp = mkTmp("tracequest-near-cache-");
  for (const k of ["TRACEQUEST_CACHE_DIR", "TRACEQUEST_NEAR_CACHE"]) savedEnv[k] = process.env[k];
  process.env.TRACEQUEST_CACHE_DIR = join(tmp, "cache");
  delete process.env.TRACEQUEST_NEAR_CACHE;
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("near-words re-rank cache", () => {
  test("near-words cache scores are the uncached scores, and changed files are rescanned", () => {
    const sessions = writeNearSessions(join(tmp, "s"));
    process.env.TRACEQUEST_NEAR_CACHE = "0";
    assert.deepEqual(scoreAll(sessions, NEAR_WEIGHTS), EXPECTED_W1, "uncached scan");
    assert.throws(() => readdirSync(join(tmp, "cache", "near")), /ENOENT/, "TRACEQUEST_NEAR_CACHE=0 writes no cache");
    delete process.env.TRACEQUEST_NEAR_CACHE;

    assert.deepEqual(scoreAll(sessions, NEAR_WEIGHTS), EXPECTED_W1, "first scan (fills the cache)");
    assert.equal(readdirSync(join(tmp, "cache", "near")).filter((n) => n.endsWith(".json")).length, 1);
    assert.deepEqual(scoreAll(sessions, NEAR_WEIGHTS), EXPECTED_W1, "from the cache");
    assert.deepEqual(scoreAll(sessions, NEAR_WEIGHTS_2), EXPECTED_W2, "from the cache, other word weights");

    // An appended session file is scanned again.
    appendFileSync(sessions[0].path, CLAUDE_APPEND);
    assert.deepEqual(scoreAll(sessions, NEAR_WEIGHTS), EXPECTED_APPENDED, "after an append");
    assert.deepEqual(scoreAll(sessions, NEAR_WEIGHTS), EXPECTED_APPENDED, "after an append, from the cache");

    // A rewrite of the same size with a new modification time is scanned again.
    const partial = sessions[3].path;
    const rewrite = (text) => {
      const fd = openSync(partial, "r+");
      try { writeSync(fd, text, 0); } finally { closeSync(fd); }
    };
    utimesSync(partial, 1_700_000_000, 1_700_000_000);
    assert.equal(scoreAll(sessions, NEAR_WEIGHTS)[3], EXPECTED_W1[3]);
    rewrite("{\"type\":\"user\",\"x\":\"codex stop button\"}       ");
    utimesSync(partial, 1_700_000_000, 1_700_000_000);
    // Same size, inode and modification time: the cache answers without reading the file.
    assert.equal(scoreAll(sessions, NEAR_WEIGHTS)[3], EXPECTED_W1[3], "unchanged stamp is served from the cache");
    utimesSync(partial, 1_700_000_100, 1_700_000_100);
    process.env.TRACEQUEST_NEAR_CACHE = "0";
    const fresh = scoreAll(sessions, NEAR_WEIGHTS)[3];
    delete process.env.TRACEQUEST_NEAR_CACHE;
    assert.notEqual(fresh, EXPECTED_W1[3]);
    assert.equal(scoreAll(sessions, NEAR_WEIGHTS)[3], fresh, "new modification time is rescanned");

    // A corrupt cache file is ignored and rewritten.
    const near = join(tmp, "cache", "near");
    for (const name of readdirSync(near)) writeFileSync(join(near, name), "{not json");
    assert.deepEqual(scoreAll(sessions, NEAR_WEIGHTS).slice(0, 3), EXPECTED_APPENDED.slice(0, 3), "corrupt cache");
    assert.deepEqual(scoreAll(sessions, NEAR_WEIGHTS).slice(0, 3), EXPECTED_APPENDED.slice(0, 3), "rewritten cache");
  });

  test("near-words cache is fast for a repeated query", () => {
    const sessions = [];
    for (let i = 0; i < 6; i++) {
      const path = join(tmp, `big-${i}.jsonl`);
      writeFileSync(path, bigClaudeBody(2 * 1024 * 1024, i));
      sessions.push({ path, source: "claude" });
    }
    const time = (fn) => {
      const t = process.hrtime.bigint();
      const r = fn();
      return [Number(process.hrtime.bigint() - t) / 1e6, r];
    };
    scoreAll(sessions, NEAR_WEIGHTS); // fill the cache, warm the page cache
    process.env.TRACEQUEST_NEAR_CACHE = "0";
    let scan = Infinity;
    let scanned;
    for (let k = 0; k < 3; k++) {
      const [ms, r] = time(() => scoreAll(sessions, NEAR_WEIGHTS));
      scan = Math.min(scan, ms);
      scanned = r;
    }
    delete process.env.TRACEQUEST_NEAR_CACHE;
    let cached = Infinity;
    for (let k = 0; k < 3; k++) {
      const [ms, r] = time(() => scoreAll(sessions, NEAR_WEIGHTS));
      cached = Math.min(cached, ms);
      assert.deepEqual(r, scanned);
    }
    assert.ok(scanned.every((s) => s > 0));
    assert.ok(cached < scan / 10, `cached ${cached.toFixed(2)} ms vs scan ${scan.toFixed(2)} ms`);
  });
});
