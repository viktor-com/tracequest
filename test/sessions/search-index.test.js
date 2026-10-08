import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  SearchIndex,
  SEARCH_IDX_VERSION,
  getSearchIndex,
  loadSearchIndex,
  flushSearchIdxWriteForTests,
  resetSearchIndexForTests,
  searchIdxPath,
} from "../../src/sessions/search-index.js";

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("SearchIndex: upsert / remove", () => {
  test("upsert inserts postings and docLen", () => {
    const si = new SearchIndex();
    const tf = new Map([["foo", 2], ["bar", 1]]);
    si.upsert("/a", tf);
    assert.equal(si.docCount, 1);
    assert.equal(si.has("/a"), true);
    assert.equal(si.postings.get("foo").get("/a"), 2);
    assert.equal(si.postings.get("bar").get("/a"), 1);
    assert.equal(si.docLens.get("/a"), 3); // 2 + 1
  });

  test("upsert replaces existing postings on mtime change", () => {
    const si = new SearchIndex();
    si.upsert("/a", new Map([["foo", 5], ["baz", 1]]));
    si.upsert("/a", new Map([["foo", 2], ["bar", 1]]));
    // Old "baz" posting should be gone
    assert.equal(si.postings.has("baz"), false);
    assert.equal(si.postings.get("foo").get("/a"), 2);
    assert.equal(si.postings.get("bar").get("/a"), 1);
    assert.equal(si.docCount, 1);
  });

  test("remove clears postings and docLen", () => {
    const si = new SearchIndex();
    si.upsert("/a", new Map([["foo", 1]]));
    si.upsert("/b", new Map([["foo", 2], ["bar", 1]]));
    si.remove("/a");
    assert.equal(si.has("/a"), false);
    assert.equal(si.postings.get("foo").has("/a"), false);
    assert.equal(si.postings.get("foo").get("/b"), 2);
  });

  test("remove drops empty posting lists", () => {
    const si = new SearchIndex();
    si.upsert("/a", new Map([["solo", 1]]));
    si.remove("/a");
    assert.equal(si.postings.has("solo"), false);
  });

  test("avgDocLen reflects all sessions", () => {
    const si = new SearchIndex();
    si.upsert("/a", new Map([["foo", 4]])); // docLen = 4
    si.upsert("/b", new Map([["bar", 6]])); // docLen = 6
    assert.equal(si.avgDocLen, 5);
  });
});

describe("SearchIndex: pruneRemovedSessions", () => {
  test("removes sessions not in validPaths (fact 03w)", () => {
    const si = new SearchIndex();
    si.upsert("/a", new Map([["foo", 1]]));
    si.upsert("/b", new Map([["foo", 2], ["bar", 1]]));
    si.pruneRemovedSessions(new Set(["/a"]));
    assert.equal(si.has("/b"), false);
    assert.equal(si.has("/a"), true);
    // "bar" posting list should be dropped (empty)
    assert.equal(si.postings.has("bar"), false);
    // "foo" posting still has /a
    assert.equal(si.postings.get("foo").get("/a"), 1);
  });
});

describe("SearchIndex: serialize / deserialize (round-trip)", () => {
  test("serializes and deserializes correctly", () => {
    const si = new SearchIndex();
    si.upsert("/a", new Map([["foo", 3], ["bar", 1]]));
    si.upsert("/b", new Map([["foo", 2]]));
    const raw = si.serialize();
    const obj = JSON.parse(raw);
    assert.equal(obj._sv, SEARCH_IDX_VERSION);
    assert.ok(Array.isArray(obj.vocab));
    assert.ok(obj.vocab.includes("foo"));
    assert.ok(obj.vocab.includes("bar"));

    const si2 = SearchIndex.deserialize(raw);
    assert.ok(si2 !== null);
    assert.equal(si2.docCount, 2);
    assert.equal(si2.postings.get("foo").get("/a"), 3);
    assert.equal(si2.postings.get("foo").get("/b"), 2);
    assert.equal(si2.postings.get("bar").get("/a"), 1);
    assert.equal(si2.docLens.get("/a"), 4); // 3 + 1
    assert.equal(si2.docLens.get("/b"), 2);
  });

  test("deserialize returns null on version mismatch", () => {
    const si = new SearchIndex();
    si.upsert("/a", new Map([["foo", 1]]));
    const raw = si.serialize();
    const obj = JSON.parse(raw);
    obj._sv = 999;
    const result = SearchIndex.deserialize(JSON.stringify(obj));
    assert.equal(result, null);
  });

  test("deserialize returns null on corrupt input", () => {
    assert.equal(SearchIndex.deserialize("not json"), null);
    assert.equal(SearchIndex.deserialize("{}"), null);
  });

  test("serialize vocab is sorted", () => {
    const si = new SearchIndex();
    si.upsert("/a", new Map([["zzz", 1], ["aaa", 2], ["mmm", 1]]));
    const obj = JSON.parse(si.serialize());
    assert.deepEqual(obj.vocab, ["aaa", "mmm", "zzz"]);
  });
});

describe("SearchIndex: persistence round-trip", () => {
  test("flush and load restores SearchIndex from disk", () => {
    const tmpDir = mkTmp("tq-si-persist-");
    const origHome = process.env.HOME;
    process.env.HOME = tmpDir;
    resetSearchIndexForTests();
    try {
      const si = getSearchIndex();
      si.upsert("/a", new Map([["hello", 2], ["world", 1]]));
      si.upsert("/b", new Map([["hello", 1]]));

      flushSearchIdxWriteForTests();
      const p = searchIdxPath();
      assert.ok(fs.existsSync(p), "search.idx should exist after flush");

      resetSearchIndexForTests();
      const loaded = loadSearchIndex();
      assert.equal(loaded, true);
      const si2 = getSearchIndex();
      assert.equal(si2.docCount, 2);
      assert.equal(si2.postings.get("hello").get("/a"), 2);
      assert.equal(si2.postings.get("hello").get("/b"), 1);
      assert.equal(si2.postings.get("world").get("/a"), 1);
    } finally {
      process.env.HOME = origHome;
      resetSearchIndexForTests();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("loadSearchIndex returns false when file absent", () => {
    const tmpDir = mkTmp("tq-si-nofile-");
    const origHome = process.env.HOME;
    process.env.HOME = tmpDir;
    resetSearchIndexForTests();
    try {
      const loaded = loadSearchIndex();
      assert.equal(loaded, false);
    } finally {
      process.env.HOME = origHome;
      resetSearchIndexForTests();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
