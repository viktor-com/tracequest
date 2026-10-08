import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { joinBundleParts } from "../../src/render/join-bundle.js";

describe("joinBundleParts", () => {
  const parts = [
    { id: "a", source: "const a = 1;" },
    { id: "b", source: "const b = 2;" },
  ];

  test("spaced join wraps segments with blank lines (default)", () => {
    assert.equal(
      joinBundleParts(parts),
      "\nconst a = 1;\n\nconst b = 2;\n",
    );
  });

  test("spaced: false concatenates sources with no separators", () => {
    assert.equal(joinBundleParts(parts, { spaced: false }), "const a = 1;const b = 2;");
  });

  test("empty parts list yields empty string when spaced", () => {
    assert.equal(joinBundleParts([]), "");
  });

  test("empty parts list yields empty string when not spaced", () => {
    assert.equal(joinBundleParts([], { spaced: false }), "");
  });

  test("single segment spaced wraps one source with leading and trailing blank lines", () => {
    assert.equal(
      joinBundleParts([{ id: "only", source: "const only = 1;" }]),
      "\nconst only = 1;\n",
    );
  });

  test("single segment unspaced returns source verbatim", () => {
    assert.equal(
      joinBundleParts([{ id: "x", source: "(() => {})();" }], { spaced: false }),
      "(() => {})();",
    );
  });

  test("preserves part order for three or more segments", () => {
    const ordered = [
      { id: "first", source: "// 1" },
      { id: "second", source: "// 2" },
      { id: "third", source: "// 3" },
    ];
    assert.equal(
      joinBundleParts(ordered, { spaced: false }),
      "// 1// 2// 3",
    );
    assert.equal(
      joinBundleParts(ordered),
      "\n// 1\n\n// 2\n\n// 3\n",
    );
  });

  test("ignores part id — only source is joined", () => {
    const mixedIds = [
      { id: "", source: "alpha();" },
      { id: "duplicate-id", source: "beta();" },
      { id: "duplicate-id", source: "gamma();" },
    ];
    assert.equal(
      joinBundleParts(mixedIds, { spaced: false }),
      "alpha();beta();gamma();",
    );
  });

  test("empty source strings still get blank-line separators when spaced", () => {
    assert.equal(
      joinBundleParts([
        { id: "a", source: "" },
        { id: "b", source: "tail();" },
      ]),
      "\n\n\ntail();\n",
    );
  });

  test("multiline source keeps internal newlines when spaced", () => {
    const multiline = { id: "fn", source: "function f() {\n  return 1;\n}" };
    assert.equal(
      joinBundleParts([multiline]),
      "\nfunction f() {\n  return 1;\n}\n",
    );
    assert.equal(
      joinBundleParts([multiline], { spaced: false }),
      "function f() {\n  return 1;\n}",
    );
  });

  test("explicit spaced: true matches default join shape", () => {
    const out = joinBundleParts(parts, { spaced: true });
    assert.equal(out, joinBundleParts(parts));
    assert.match(out, /^\nconst a = 1;\n\nconst b = 2;\n$/);
  });

  test("segment source with trailing newline yields extra blank line before next part", () => {
    assert.equal(
      joinBundleParts([
        { id: "a", source: "const a = 1;\n" },
        { id: "b", source: "const b = 2;" },
      ]),
      "\nconst a = 1;\n\n\nconst b = 2;\n",
    );
  });

  test("matches production CHAPTERS bundle join contract (leading newline, blank between)", () => {
    const mini = [
      { id: "open", source: "(function() {" },
      { id: "body", source: "  var x = 1;" },
      { id: "close", source: "})();" },
    ];
    const joined = joinBundleParts(mini);
    assert.ok(joined.startsWith("\n(function() {"), "chapter-style bundles lead with newline");
    assert.ok(joined.includes("\n\n  var x = 1;\n\n"), "segments separated by blank line");
    assert.ok(joined.endsWith("})();\n"), "chapter-style bundles end with trailing newline");
  });
});