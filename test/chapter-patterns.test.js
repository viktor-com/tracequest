import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import {
  CORRECTION_HINT_RE,
  bashSplitFirstToken,
  bashFirstTwoTokens,
  markUserPromptCorrections,
  countSelfCorrections,
  isSameTarget,
  isSimilarInput,
} from "../src/chapters/chapter-patterns.js";
import { CHAPTERS_JS } from "../src/render/render-chapters.js";
import { CHAPTERS_HELPERS_JS } from "../src/render/render-assemble.js";

describe("chapter-patterns CORRECTION_HINT_RE", () => {
  test("matches explicit correction phrases", () => {
    assert.equal(CORRECTION_HINT_RE.test("No, revert that change"), true);
    assert.equal(CORRECTION_HINT_RE.test("that is not what I asked"), true);
    assert.equal(CORRECTION_HINT_RE.test("WRONG approach — undo it"), true);
    assert.equal(CORRECTION_HINT_RE.test("Actually, use the other file instead"), true);
  });

  test("avoids false positives on node/nothing/knowledge/cannot", () => {
    assert.equal(CORRECTION_HINT_RE.test("use node modules"), false);
    assert.equal(CORRECTION_HINT_RE.test("nothing to see"), false);
    assert.equal(CORRECTION_HINT_RE.test("expand your knowledge base"), false);
    assert.equal(CORRECTION_HINT_RE.test("cannot reproduce locally"), false);
  });

  test("does not match bare negation without hint words", () => {
    assert.equal(CORRECTION_HINT_RE.test("please fix the tests"), false);
    assert.equal(CORRECTION_HINT_RE.test("not applicable here"), false);
  });
});

describe("chapter-patterns markUserPromptCorrections", () => {
  test("flags prior chapter on corrective next prompt", () => {
    const chapters = [
      { prompt: "fix the bug", corrected: false },
      { prompt: "No, undo that", corrected: false },
    ];
    markUserPromptCorrections(chapters);
    assert.equal(chapters[0].corrected, true);
    assert.equal(chapters[1].corrected, false);
  });

  test("no-op on empty or single-chapter arrays", () => {
    markUserPromptCorrections([]);
    const one = [{ prompt: "No, wrong", corrected: false }];
    markUserPromptCorrections(one);
    assert.equal(one[0].corrected, false);
  });

  test("marks multiple prior chapters when successive prompts correct", () => {
    const chapters = [
      { prompt: "a", corrected: false },
      { prompt: "b", corrected: false },
      { prompt: "undo everything", corrected: false },
    ];
    markUserPromptCorrections(chapters);
    assert.equal(chapters[0].corrected, false);
    assert.equal(chapters[1].corrected, true);
    assert.equal(chapters[2].corrected, false);
  });

  test("last chapter is never marked corrected by a following prompt", () => {
    const chapters = [
      { prompt: "step one", corrected: false },
      { prompt: "step two", corrected: false },
    ];
    markUserPromptCorrections(chapters);
    assert.equal(chapters[1].corrected, false);
  });

  test("does not mark when next prompt lacks correction hints", () => {
    const chapters = [
      { prompt: "edit foo.js", corrected: false },
      { prompt: "also update bar.js", corrected: false },
    ];
    markUserPromptCorrections(chapters);
    assert.equal(chapters[0].corrected, false);
  });
});

describe("chapter-patterns markUserPromptCorrections browser injection", () => {
  const VM_CTX = { Object, Array, String, Math, Date, Set };

  function runInjectedMarkUserPromptCorrections(chapters) {
    const script = new Script(`
      ${CHAPTERS_HELPERS_JS}
      markUserPromptCorrections(chapters);
      chapters;
    `);
    return script.runInNewContext({ chapters, ...VM_CTX });
  }

  test("injected bundle exposes markUserPromptCorrections and CORRECTION_HINT_RE", () => {
    const script = new Script(`
      ${CHAPTERS_HELPERS_JS}
      ({
        hasFn: typeof markUserPromptCorrections === 'function',
        hasRe: typeof CORRECTION_HINT_RE !== 'undefined' && CORRECTION_HINT_RE.test('undo that'),
      });
    `);
    const out = script.runInNewContext(VM_CTX);
    assert.equal(out.hasFn, true);
    assert.equal(out.hasRe, true);
  });

  test("VM marks prior chapter when next prompt says undo", () => {
    const chapters = [
      { prompt: "fix the bug", corrected: false },
      { prompt: "No, undo that", corrected: false },
    ];
    const result = runInjectedMarkUserPromptCorrections(chapters);
    assert.equal(result[0].corrected, true);
    assert.equal(result[1].corrected, false);
  });

  test("VM no-op on empty chapter list", () => {
    const chapters = [];
    const result = runInjectedMarkUserPromptCorrections(chapters);
    assert.deepEqual(result, []);
  });

  test("VM no-op on single chapter even with correction hint", () => {
    const chapters = [{ prompt: "No, wrong", corrected: false }];
    const result = runInjectedMarkUserPromptCorrections(chapters);
    assert.equal(result[0].corrected, false);
  });

  test("VM marks penultimate chapter in three-chapter corrective chain", () => {
    const chapters = [
      { prompt: "a", corrected: false },
      { prompt: "b", corrected: false },
      { prompt: "undo everything", corrected: false },
    ];
    const result = runInjectedMarkUserPromptCorrections(chapters);
    assert.equal(result[0].corrected, false);
    assert.equal(result[1].corrected, true);
    assert.equal(result[2].corrected, false);
  });

  test("VM never marks last chapter without a following prompt", () => {
    const chapters = [
      { prompt: "step one", corrected: false },
      { prompt: "step two", corrected: false },
    ];
    const result = runInjectedMarkUserPromptCorrections(chapters);
    assert.equal(result[1].corrected, false);
  });

  test("VM leaves chapters uncorrected when next prompt has no hint", () => {
    const chapters = [
      { prompt: "edit foo.js", corrected: false },
      { prompt: "also update bar.js", corrected: false },
    ];
    const result = runInjectedMarkUserPromptCorrections(chapters);
    assert.equal(result[0].corrected, false);
    assert.equal(result[1].corrected, false);
  });

  test("VM matches Actually/instead hints via injected CORRECTION_HINT_RE", () => {
    const chapters = [
      { prompt: "use file A", corrected: false },
      { prompt: "Actually, use file B instead", corrected: false },
    ];
    const result = runInjectedMarkUserPromptCorrections(chapters);
    assert.equal(result[0].corrected, true);
  });
});

describe("chapter-patterns countSelfCorrections", () => {
  test("counts error then successful same-file Edit", () => {
    const seq = [
      { name: "Edit", input: "/proj/src/foo.js", isError: true },
      { name: "Edit", input: "/proj/src/foo.js", isError: false },
    ];
    assert.equal(countSelfCorrections(seq), 1);
  });

  test("returns 0 when sequence has no errors", () => {
    const seq = [
      { name: "Read", input: "/a.js", isError: false },
      { name: "Edit", input: "/a.js", isError: false },
    ];
    assert.equal(countSelfCorrections(seq), 0);
  });

  test("returns 0 when retry is beyond the 3-step lookahead window", () => {
    const seq = [
      { name: "Bash", input: "npm test", isError: true },
      { name: "Read", input: "/x", isError: false },
      { name: "Read", input: "/y", isError: false },
      { name: "Read", input: "/z", isError: false },
      { name: "Bash", input: "npm test", isError: false },
    ];
    assert.equal(countSelfCorrections(seq), 0);
  });

  test("counts Bash retry when first token matches", () => {
    const seq = [
      { name: "Bash", input: "cargo build --release", isError: true },
      { name: "Bash", input: "cargo test", isError: false },
    ];
    assert.equal(countSelfCorrections(seq), 1);
  });

  test("does not count when follow-up targets a different file", () => {
    const seq = [
      { name: "Edit", input: "/proj/a.js", isError: true },
      { name: "Edit", input: "/proj/b.js", isError: false },
    ];
    assert.equal(countSelfCorrections(seq), 0);
  });

  test("does not double-count when multiple errors share one fix", () => {
    const seq = [
      { name: "Edit", input: "/f/x.js", isError: true },
      { name: "Edit", input: "/f/x.js", isError: true },
      { name: "Edit", input: "/f/x.js", isError: false },
    ];
    assert.equal(countSelfCorrections(seq), 2);
  });
});

describe("chapter-patterns bash token scanners", () => {
  test("bashSplitFirstToken matches split(/\\s+/)[0] || ''", () => {
    const legacy = (s) => (s ? s.split(/\s+/)[0] : "") || "";
    const samples = ["npm test", "  npm run lint", "", "cargo\tbuild", "git\nstatus"];
    for (const s of samples) {
      assert.equal(bashSplitFirstToken(s), legacy(s), JSON.stringify(s));
    }
  });

  test("bashFirstTwoTokens matches trim().split(/\\s+/).slice(0, 2).join(' ')", () => {
    const legacy = (s) => {
      if (!s) return "";
      return s
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .join(" ");
    };
    const samples = [
      "npm run test",
      "  npm   run   lint  ",
      "single",
      "",
      "a\tb\nc",
      "one two three",
    ];
    for (const s of samples) {
      assert.equal(bashFirstTwoTokens(s), legacy(s), JSON.stringify(s));
    }
  });
});

describe("chapter-patterns isSameTarget", () => {
  test("matches Edit paths via shortToolPath semantics", () => {
    assert.equal(
      isSameTarget("/proj/src/foo.js", "/other/proj/src/foo.js", "Edit"),
      true
    );
    assert.equal(isSameTarget("/a/x.js", "/b/y.js", "Edit"), false);
  });

  test("Write and Read use path keys like Edit", () => {
    assert.equal(isSameTarget("/p/a/b.js", "/q/a/b.js", "Write"), true);
    assert.equal(isSameTarget("/only.js", "/other/only.js", "Read"), false);
  });

  test("returns false when either input is missing", () => {
    assert.equal(isSameTarget("", "/a.js", "Edit"), false);
    assert.equal(isSameTarget("/a.js", null, "Edit"), false);
  });

  test("Bash compares first command token only", () => {
    assert.equal(isSameTarget("npm test", "npm run lint", "Bash"), true);
    assert.equal(isSameTarget("npm test", "yarn test", "Bash"), false);
  });

  test("generic tools compare first 30 characters", () => {
    const a = "x".repeat(30);
    const b = "x".repeat(30) + "extra";
    assert.equal(isSameTarget(a, b, "Grep"), true);
    assert.equal(isSameTarget(a, "y" + a.slice(1), "Grep"), false);
  });
});

describe("chapter-patterns isSimilarInput", () => {
  test("treats repeated Bash command as retry", () => {
    assert.equal(isSimilarInput("npm test", "npm test --watch", "Bash"), true);
    assert.equal(isSimilarInput("npm test", "cargo build", "Bash"), false);
  });

  test("both empty inputs are similar; one empty is not", () => {
    assert.equal(isSimilarInput("", "", "Read"), true);
    assert.equal(isSimilarInput("npm test", "", "Bash"), false);
  });

  test("identical inputs always similar regardless of tool", () => {
    assert.equal(isSimilarInput("same", "same", "Grep"), true);
  });

  test("Edit paths similar when shortToolPath matches", () => {
    assert.equal(
      isSimilarInput("/big/proj/src/foo.js", "/other/proj/src/foo.js", "Edit"),
      true
    );
    assert.equal(isSimilarInput("/a/x.js", "/b/y.js", "Edit"), false);
  });

  test("Bash similar when first two tokens match", () => {
    assert.equal(isSimilarInput("npm run test", "npm run lint", "Bash"), true);
    assert.equal(isSimilarInput("npm ci", "npm install", "Bash"), false);
  });

  test("generic prefix similarity requires >50% character match in first 40 chars", () => {
    assert.equal(isSimilarInput("abcdex", "abcdey", "Grep"), true);
    assert.equal(isSimilarInput("abcdef", "zzzzef", "Grep"), false);
  });
});

describe("chapter-patterns browser injection", () => {
  test("buildChapters marks corrected and selfCorrections via injected helpers", () => {
    const events = [
      { type: "user", text: "edit foo", timestamp: "2026-01-01T00:00:00.000Z" },
      {
        type: "assistant",
        toolCalls: [
          { id: "e1", name: "Edit", input: "/proj/src/foo.js" },
          { id: "e2", name: "Edit", input: "/proj/src/foo.js" },
        ],
        timestamp: "2026-01-01T00:00:01.000Z",
      },
      { type: "tool_result", toolUseId: "e1", isError: true, timestamp: "2026-01-01T00:00:02.000Z" },
      { type: "tool_result", toolUseId: "e2", text: "ok", timestamp: "2026-01-01T00:00:03.000Z" },
      { type: "user", text: "No, wrong file", timestamp: "2026-01-01T00:00:04.000Z" },
    ];
    const script = new Script(`
      const session = { startTime: '2026-01-01T00:00:00.000Z' };
      ${CHAPTERS_HELPERS_JS}
      ${CHAPTERS_JS}
      buildChapters();
    `);
    const chapters = script.runInNewContext({ events, Object, Array, String, Math, Date, Set });
    assert.equal(chapters.length, 2);
    assert.equal(chapters[0].corrected, true);
    assert.equal(chapters[0].selfCorrections, 1);
  });

  test("buildChapters leaves selfCorrections at 0 without error-then-success pair", () => {
    const events = [
      { type: "user", text: "read file", timestamp: "2026-01-01T00:00:00.000Z" },
      {
        type: "assistant",
        toolCalls: [{ id: "r1", name: "Read", input: "/proj/a.js" }],
        timestamp: "2026-01-01T00:00:01.000Z",
      },
      { type: "tool_result", toolUseId: "r1", text: "ok", timestamp: "2026-01-01T00:00:02.000Z" },
    ];
    const script = new Script(`
      const session = { startTime: '2026-01-01T00:00:00.000Z' };
      ${CHAPTERS_HELPERS_JS}
      ${CHAPTERS_JS}
      buildChapters();
    `);
    const chapters = script.runInNewContext({ events, Object, Array, String, Math, Date, Set });
    assert.equal(chapters.length, 1);
    assert.equal(chapters[0].selfCorrections, 0);
    assert.equal(chapters[0].corrected, false);
  });
});