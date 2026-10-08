import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tokenize, accumulateTermFreqs, TOKENIZER_INPUT_CAP } from "../../src/sessions/search-tokenizer.js";
import { createIndexState, pushIndexSearchChunk } from "../../src/sessions/session-meta.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("tokenize", () => {
  test("lowercases input", () => {
    assert.deepEqual(tokenize("Hello World"), ["hello", "world"]);
  });

  test("splits on non-alphanumeric (path separators, punctuation)", () => {
    const terms = tokenize("src/index_writers.js");
    assert.ok(terms.includes("src"));
    assert.ok(terms.includes("index"));
    assert.ok(terms.includes("writers"));
    assert.ok(terms.includes("js"));
  });

  test("camelCase: indexWriters → index, writers (fact lvq example)", () => {
    const terms = tokenize("indexWriters");
    assert.deepEqual(terms, ["index", "writers"]);
  });

  test("path example from fact lvq: src/index_writers.js → index, writers", () => {
    const terms = tokenize("src/index_writers.js");
    assert.ok(terms.includes("index"), "should include 'index'");
    assert.ok(terms.includes("writers"), "should include 'writers'");
  });

  test("discards tokens shorter than 2 chars (fact nna)", () => {
    const terms = tokenize("a b cc ddd");
    assert.ok(!terms.includes("a"));
    assert.ok(!terms.includes("b"));
    assert.ok(terms.includes("cc"));
    assert.ok(terms.includes("ddd"));
  });

  test("discards tokens longer than 32 chars (fact nna)", () => {
    const long = "a".repeat(33);
    const edge = "a".repeat(32);
    const terms = tokenize(`${long} ${edge}`);
    assert.ok(!terms.includes(long));
    assert.ok(terms.includes(edge));
  });

  test("de-duplicates terms within one call", () => {
    const terms = tokenize("foo bar foo");
    assert.equal(terms.filter((t) => t === "foo").length, 1);
  });

  test("snake_case: build_index_meta → build, index, meta", () => {
    const terms = tokenize("build_index_meta");
    assert.ok(terms.includes("build"));
    assert.ok(terms.includes("index"));
    assert.ok(terms.includes("meta"));
  });

  test("handles empty string", () => {
    assert.deepEqual(tokenize(""), []);
  });

  test("handles null/undefined gracefully", () => {
    assert.deepEqual(tokenize(null), []);
    assert.deepEqual(tokenize(undefined), []);
  });

  test("consecutive delimiters do not produce empty tokens", () => {
    const terms = tokenize("  foo   bar  ");
    assert.deepEqual(terms, ["foo", "bar"]);
  });

  test("XMLParser: uppercase run + lowercase transition", () => {
    const terms = tokenize("XMLParser");
    // "XML" and "Parser" should both appear; "xml" and "parser"
    assert.ok(terms.includes("parser"), `terms: ${terms}`);
  });
});

describe("accumulateTermFreqs", () => {
  test("accumulates frequency counts", () => {
    const tf = new Map();
    const budget = [TOKENIZER_INPUT_CAP];
    accumulateTermFreqs("foo bar foo", tf, budget);
    assert.equal(tf.get("foo"), 2);
    assert.equal(tf.get("bar"), 1);
  });

  test("respects budget cap (fact 7et)", () => {
    const tf = new Map();
    const budget = [5];
    // Only first 5 chars ("hello") should be tokenized
    accumulateTermFreqs("hello world", tf, budget);
    assert.ok(tf.has("hello") || !tf.has("world"), "budget should limit input");
    assert.equal(budget[0], 0);
  });

  test("skips when budget is exhausted", () => {
    const tf = new Map();
    const budget = [0];
    accumulateTermFreqs("hello world", tf, budget);
    assert.equal(tf.size, 0);
  });

  test("accumulates across multiple calls", () => {
    const tf = new Map();
    const budget = [TOKENIZER_INPUT_CAP];
    accumulateTermFreqs("foo bar", tf, budget);
    accumulateTermFreqs("bar baz", tf, budget);
    assert.equal(tf.get("foo"), 1);
    assert.equal(tf.get("bar"), 2);
    assert.equal(tf.get("baz"), 1);
  });

  test("source index chunk budget uses shared TOKENIZER_INPUT_CAP (fact 7et)", () => {
    const state = createIndexState();
    pushIndexSearchChunk(state, "keep ".repeat(TOKENIZER_INPUT_CAP / 5));
    pushIndexSearchChunk(state, "aftercap");

    assert.equal(state._tfBudget[0], 0);
    assert.equal(state._termFreqs.get("keep"), TOKENIZER_INPUT_CAP / 5);
    assert.equal(state._termFreqs.has("aftercap"), false);
  });

  test("JS/Rust parity: accumulateTermFreqs over corpus fixture matches Rust termfreqs.json (fact ovv)", () => {
    const fixturesDir = join(__dirname, "../../test/fixtures");
    const corpusText = readFileSync(join(fixturesDir, "tokenizer-corpus.txt"), "utf-8");
    const expected = JSON.parse(readFileSync(join(fixturesDir, "tokenizer-corpus.termfreqs.json"), "utf-8"));

    // Apply accumulateTermFreqs over the entire corpus as one chunk (same as Rust: single call).
    const tf = new Map();
    const budget = [TOKENIZER_INPUT_CAP];
    accumulateTermFreqs(corpusText, tf, budget);

    // Compare: every key in expected must appear in tf with the same count.
    const missing = [];
    const wrong = [];
    for (const [term, count] of Object.entries(expected)) {
      const got = tf.get(term) ?? 0;
      if (got === 0) missing.push(term);
      else if (got !== count) wrong.push(`${term}: expected ${count}, got ${got}`);
    }
    // Check no extra terms in JS result that aren't in Rust fixture.
    const extra = [];
    for (const [term] of tf) {
      if (!(term in expected)) extra.push(term);
    }
    assert.deepEqual(missing, [], `Terms in Rust fixture missing from JS: ${missing.join(", ")}`);
    assert.deepEqual(wrong, [], `Count mismatches: ${wrong.join("; ")}`);
    assert.deepEqual(extra, [], `Terms in JS but not in Rust fixture: ${extra.join(", ")}`);
  });
});
