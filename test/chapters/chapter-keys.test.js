import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { chapterFileKeys, chapterToolKeys } from "../../src/chapters/chapter-keys.js";

describe("chapter-keys", () => {
  test("chapterFileKeys prefers cached _fileKeys", () => {
    const ch = { _fileKeys: ["a.js"], files: { "b.js": {} } };
    assert.deepEqual(chapterFileKeys(ch), ["a.js"]);
  });

  test("chapterFileKeys falls back to Object.keys(ch.files)", () => {
    const ch = { files: { "x.js": {}, "y.js": {} } };
    assert.deepEqual(chapterFileKeys(ch), ["x.js", "y.js"]);
  });

  test("chapterToolKeys prefers cached _toolKeys", () => {
    const ch = { _toolKeys: ["Read"], toolCounts: { Bash: 2 } };
    assert.deepEqual(chapterToolKeys(ch), ["Read"]);
  });

  test("chapterToolKeys falls back to Object.keys(ch.toolCounts)", () => {
    const ch = { toolCounts: { Read: 1, Bash: 3 } };
    assert.deepEqual(chapterToolKeys(ch), ["Read", "Bash"]);
  });
});