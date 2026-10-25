/**
 * search.bin: the binary, lazily decoded copy of search.idx (facts 82g, ohy, un4).
 * The index opened from search.bin must look exactly like the one parsed from
 * search.idx — same terms, postings, counts and iteration orders — because
 * BM25 tie-breaks follow those orders.
 */
import "../helpers/skip-lr-watch-env.js";
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync, truncateSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mkTmp } from "../helpers/fixtures.js";
import {
  SearchIndex,
  flushSearchIdxWriteForTests,
  getSearchIndex,
  loadSearchIndex,
  resetSearchIndexForTests,
  searchBinPath,
  searchIdxPath,
} from "../../src/sessions/search-index.js";
import { prefixExpand, resolveQueryToken } from "../../src/sessions/scan-queries.js";

const savedCacheDir = process.env.TRACEQUEST_CACHE_DIR;
afterEach(() => {
  resetSearchIndexForTests();
  if (savedCacheDir === undefined) delete process.env.TRACEQUEST_CACHE_DIR;
  else process.env.TRACEQUEST_CACHE_DIR = savedCacheDir;
});

/** Deterministic pseudo-random generator. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const WORDS = ["codex", "code", "coder", "stop", "stopped", "button", "buttons", "search", "index", "zebra", "élan", "日本", "a1", "co"];

/** Fill the singleton with sessions, re-upserting some so posting orders differ from doc order. */
function buildIndex(docs, vocabSize, termsPerDoc, seed = 1) {
  const r = rng(seed);
  const si = getSearchIndex();
  const vocab = [...WORDS];
  for (let i = vocab.length; i < vocabSize; i++) vocab.push(`t${Math.floor(r() * vocabSize * 4).toString(36)}x${i % 97}`);
  const batch = [];
  for (let d = 0; d < docs; d++) {
    const tf = new Map();
    const n = d % 50 === 7 ? 0 : termsPerDoc;
    for (let k = 0; k < n; k++) {
      const term = vocab[Math.floor(r() ** 2 * vocab.length)];
      tf.set(term, (tf.get(term) || 0) + 1 + Math.floor(r() * 300));
    }
    batch.push([`/home/dev/.claude/projects/p${d % 13}/session-${d}.jsonl`, tf]);
  }
  si.upsertMany(batch);
  // Replace a few sessions one by one (an active session being re-indexed).
  for (let d = 0; d < docs; d += 17) {
    si.upsert(batch[d][0], new Map([...batch[(d * 7) % docs][1]].slice(0, 5)));
  }
  return si;
}

function loadFresh() {
  resetSearchIndexForTests();
  assert.equal(loadSearchIndex(), true);
  return getSearchIndex();
}

function parsedFromJson() {
  return SearchIndex.deserialize(readFileSync(searchIdxPath(), "utf8"));
}

function assertSameIndex(lazy, ref) {
  assert.equal(lazy.docCount, ref.docCount);
  assert.equal(lazy.avgDocLen, ref.avgDocLen);
  assert.equal(lazy.postings.size, ref.postings.size);
  assert.deepEqual([...lazy.docLens], [...ref.docLens]);
  assert.deepEqual([...lazy.postings.keys()], [...ref.postings.keys()]);
  for (const [term, posting] of ref.postings) {
    assert.ok(lazy.postings.has(term), term);
    assert.deepEqual([...lazy.postings.get(term)], [...posting], `posting order of ${term}`);
  }
  assert.equal(lazy.postings.has("not-a-term"), false);
  assert.equal(lazy.postings.get("not-a-term"), undefined);
}

test("binary search index opened from search.bin equals search.idx, before and after it is changed", () => {
  process.env.TRACEQUEST_CACHE_DIR = mkTmp("tq-searchbin-eq-");
  buildIndex(400, 3000, 40);
  flushSearchIdxWriteForTests();
  assert.ok(existsSync(searchBinPath()), "search.bin written next to search.idx");

  const lazy = loadFresh();
  assert.equal(lazy.isUnchangedFromBinary, true, "opened from search.bin");
  const ref = parsedFromJson();
  // Prefix expansion and query resolution see the same terms in the same order.
  for (const prefix of ["co", "cod", "stop", "but", "t", "é", "日", "zz", "codex"]) {
    assert.deepEqual(prefixExpand(prefix, lazy.postings), prefixExpand(prefix, ref.postings), prefix);
  }
  for (const [token, isFinal] of [["codex", false], ["buton", false], ["sto", true], ["button", true]]) {
    assert.deepEqual(resolveQueryToken(token, isFinal, lazy), resolveQueryToken(token, isFinal, ref), token);
  }
  assertSameIndex(lazy, ref);

  // Changing the opened index behaves as changing the parsed one.
  const change = (si) => {
    si.upsertMany([["/new/session.jsonl", new Map([["codex", 3], ["fresh", 1]])], [[...ref.docLens.keys()][3], new Map([["stop", 2]])]]);
    si.removeMany([[...ref.docLens.keys()][5]]);
    si.pruneRemovedSessions(new Set([...si.docLens.keys()].filter((_, i) => i % 9 !== 4)));
  };
  change(lazy);
  change(ref);
  assert.equal(lazy.isUnchangedFromBinary, false);
  assert.equal(lazy.serialize(), ref.serialize());

  // The changed index is written to both files and reopens equal.
  flushSearchIdxWriteForTests();
  const reopened = loadFresh();
  assert.equal(reopened.isUnchangedFromBinary, true);
  assertSameIndex(reopened, parsedFromJson());
});

test("binary search index: a search.bin that no longer matches search.idx is ignored and rewritten", () => {
  process.env.TRACEQUEST_CACHE_DIR = mkTmp("tq-searchbin-stale-");
  buildIndex(60, 300, 20);
  flushSearchIdxWriteForTests();

  // search.idx rewritten by something that did not write search.bin (an older version).
  const obj = JSON.parse(readFileSync(searchIdxPath(), "utf8"));
  const vi = obj.vocab.indexOf("codex");
  obj.postings[vi] = [];
  writeFileSync(searchIdxPath(), JSON.stringify(obj));
  let si = loadFresh();
  assert.equal(si.isUnchangedFromBinary, false, "parsed from search.idx");
  assert.equal(si.postings.has("codex"), false, "content of the new search.idx, not of the old search.bin");
  si = loadFresh();
  assert.equal(si.isUnchangedFromBinary, true, "search.bin rewritten for the new search.idx");
  assert.equal(si.postings.has("codex"), false);
  assertSameIndex(si, parsedFromJson());

  // Another binary format version is ignored.
  const bin = readFileSync(searchBinPath());
  bin.writeUInt32LE(999, 4);
  writeFileSync(searchBinPath(), bin);
  si = loadFresh();
  assert.equal(si.isUnchangedFromBinary, false);
  assertSameIndex(loadFresh(), parsedFromJson());

  // A truncated search.bin is ignored.
  truncateSync(searchBinPath(), 100);
  si = loadFresh();
  assert.equal(si.isUnchangedFromBinary, false);
  assertSameIndex(loadFresh(), parsedFromJson());

  // A corrupt search.idx fails to load even when search.bin exists.
  writeFileSync(searchIdxPath(), "{not json");
  resetSearchIndexForTests();
  assert.equal(loadSearchIndex(), false);
});

test("unchanged index opened from search.bin is not rewritten on flush", () => {
  process.env.TRACEQUEST_CACHE_DIR = mkTmp("tq-searchbin-flush-");
  buildIndex(50, 200, 10);
  flushSearchIdxWriteForTests();
  loadFresh();
  const before = [statSync(searchIdxPath(), { bigint: true }).mtimeNs, statSync(searchBinPath(), { bigint: true }).mtimeNs];
  flushSearchIdxWriteForTests();
  const after = [statSync(searchIdxPath(), { bigint: true }).mtimeNs, statSync(searchBinPath(), { bigint: true }).mtimeNs];
  assert.deepEqual(after, before);
});

test("search.bin opens fast: a 3,000-session index opens and resolves a query in a tenth of the search.idx load time", () => {
  process.env.TRACEQUEST_CACHE_DIR = mkTmp("tq-searchbin-perf-");
  buildIndex(3000, 60000, 300);
  flushSearchIdxWriteForTests();

  const words = ["codex", "stop", "button"];
  const query = (si) => {
    let entries = 0;
    for (let i = 0; i < words.length; i++) {
      for (const { term } of resolveQueryToken(words[i], i === words.length - 1, si)) entries += si.postings.get(term).size;
    }
    return entries;
  };
  const best = (fn) => {
    let ms = Infinity;
    let out;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      out = fn();
      ms = Math.min(ms, performance.now() - t);
    }
    return { ms, out };
  };
  const json = best(() => {
    const si = SearchIndex.deserialize(readFileSync(searchIdxPath(), "utf8"));
    return query(si);
  });
  const bin = best(() => query(loadFresh()));
  assert.equal(getSearchIndex().isUnchangedFromBinary, true);
  assert.equal(bin.out, json.out, "same postings found");
  assert.ok(bin.ms * 10 < json.ms, `search.bin ${bin.ms.toFixed(1)} ms vs search.idx ${json.ms.toFixed(1)} ms`);
});
