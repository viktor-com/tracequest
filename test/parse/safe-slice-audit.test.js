import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CHAPTERS_HELPERS_JS } from "../../src/render/render-assemble.js";
import { safeSlice } from "../../src/parse/parse-utils.js";

const ROOT = join(import.meta.dirname, "../..");
const SRC = join(ROOT, "src");

/** Walk all .js files under src/ and collect paths. */
function walkJs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkJs(p, out);
    else if (p.endsWith(".js")) out.push(p);
  }
  return out;
}

describe("safeSlice shared usage audit", () => {
  test("parse-utils.js is the sole server-side safeSlice definition", () => {
    const dupRe = /export function safeSlice|function safeSlice\s*\(/;
    const hits = [];
    for (const file of walkJs(SRC)) {
      if (file.endsWith("parse-utils.js")) continue;
      const src = readFileSync(file, "utf8");
      if (dupRe.test(src)) hits.push(file.replace(ROOT + "/", ""));
    }
    assert.deepEqual(hits, [], `duplicate safeSlice definitions: ${hits.join(", ")}`);
  });

  test("session index, peek, parse-enrich, index-writers, and markdown-export use truncateFirstPrompt for 200-char truncation", () => {
    for (const rel of [
      "src/sessions/session-peek.js",
      "src/sessions/session-index-jsonl.js",
      "src/sessions/session-index-opencode.js",
      "src/parse/parse-enrich.js",
      "src/sessions/index-writers.js",
      "src/export/markdown-export.js",
    ]) {
      const src = readFileSync(join(ROOT, rel), "utf8");
      assert.ok(src.includes("truncateFirstPrompt"), `${rel} should import/use truncateFirstPrompt`);
      if (rel.includes("session")) {
        assert.ok(!/firstPrompt\s*=\s*clean\.slice\(0,\s*200\)/.test(src), `${rel} should not use raw slice for firstPrompt`);
      }
    }
  });
});

describe("safeSlice behavioral edges", () => {
  test("empty string stays empty for zero and positive maxLen", () => {
    assert.equal(safeSlice("", 0), "");
    assert.equal(safeSlice("", 200), "");
    assert.equal(safeSlice("", 1), "");
  });

  test("non-empty string with maxLen 0 yields empty", () => {
    assert.equal(safeSlice("hello", 0), "");
  });

  test("null and undefined coerce to empty without throwing", () => {
    assert.equal(safeSlice(null, 10), "");
    assert.equal(safeSlice(undefined, 10), "");
  });

  test("negative maxLen follows slice end-index semantics", () => {
    assert.equal(safeSlice("hello", -1), "hell");
    assert.equal(safeSlice("", -1), "");
  });

  test("single emoji with maxLen 1 does not leave a lone high surrogate", () => {
    const globe = "🌍";
    assert.equal(safeSlice(globe, 1), "");
    assert.equal(safeSlice(globe, 2), globe);
  });

  test("truncation between two emoji keeps only complete first pair", () => {
    const pair = "🌍🌎";
    const cut = safeSlice(pair, 3);
    assert.equal(cut, "🌍");
    assert.ok(!cut.endsWith("\uD83C"), "must not end on high surrogate");
    assert.equal([...cut].length, 1, "one scalar emoji preserved");
  });

  test("text plus emoji boundary avoids splitting surrogate pair", () => {
    const text = "hello 🌍 end";
    const cut = safeSlice(text, 8);
    assert.ok(!/\uD83C$/.test(cut), "must not end on high surrogate");
    assert.equal(cut, "hello 🌍");
  });
});