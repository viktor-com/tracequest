import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { parseFilterExpr, evalFilterExpr, buildBm25FilterContext, FilterParseError } from "../src/filter/filter.js";
import * as filterModule from "../src/filter/filter.js";
import { searchSessions } from "../src/sessions/scan-queries.js";
import { getSearchIndex, resetSearchIndexForTests } from "../src/sessions/search-index.js";
import { assertPerf } from "./helpers/perf-assert.js";

const NOW = Date.parse("2026-06-03T12:00:00Z");

const FMT_EXPORTS = [
  "fmtTokens",
  "fmtCost",
  "fmtMcpName",
  "fmtPct",
  "fmtCacheHitPct",
  "formatDuration",
  "estimateCost",
  "getModelRates",
  "shortModel",
  "sortSessionList",
];

describe("filter.js expr-only surface", () => {
  test("does not export fmt* or other format helpers", () => {
    for (const name of FMT_EXPORTS) {
      assert.equal(filterModule[name], undefined, `must not export ${name}`);
    }
    assert.equal(filterModule.fmtTokens, undefined);
  });

  test("exports only parseFilterExpr and evalFilterExpr", () => {
    // buildBm25FilterContext and collectTextTermValues added with BM25 filter integration (0oy/cw8)
    assert.deepEqual(Object.keys(filterModule).sort(), [
      "FilterParseError",
      "applyExprToApiObjects",
      "buildBm25FilterContext",
      "collectTextTermValues",
      "evalFilterExpr",
      "parseFilterExpr",
    ]);
  });
});

function session(overrides = {}) {
  return {
    project: "my-app",
    source: "claude",
    tools: ["Bash", "Read"],
    model: "claude-sonnet-4-6",
    id: "abc12345",
    prompt: "fix the login bug",
    sizeKB: 512,
    mtime: NOW - 2 * 3600000,
    errors: 2,
    chapters: 5,
    inputTokens: 1000,
    cacheReadTokens: 200,
    toolCounts: { Bash: 3 },
    live: false,
    ...overrides,
  };
}

describe("filter parseFilterExpr", () => {
  test("empty input returns null", () => {
    assert.equal(parseFilterExpr(""), null);
    assert.equal(parseFilterExpr("   "), null);
  });

  test("bare word becomes text term", () => {
    const ast = parseFilterExpr("login");
    assert.equal(ast.type, "term");
    assert.equal(ast.key, "text");
    assert.equal(ast.value, "login");
    assert.equal(ast.negated, false);
  });

  test("key:value terms for known filter keys", () => {
    const ast = parseFilterExpr('project:my-app source:claude model:sonnet');
    assert.equal(ast.type, "and");
    assert.equal(ast.left.type, "and");
    assert.equal(ast.left.left.key, "project");
    assert.equal(ast.left.left.value, "my-app");
    assert.equal(ast.left.right.key, "source");
    assert.equal(ast.right.key, "model");
  });

  test("unknown key before colon falls back to text term", () => {
    const ast = parseFilterExpr("foo:bar");
    assert.equal(ast.key, "text");
    assert.equal(ast.value, "foo:bar");
  });

  test("negation prefix on terms", () => {
    const ast = parseFilterExpr("-project:other");
    assert.equal(ast.key, "project");
    assert.equal(ast.negated, true);
  });

  test("quoted term values", () => {
    const ast = parseFilterExpr('"exact phrase"');
    assert.equal(ast.key, "text");
    assert.equal(ast.value, "exact phrase");
    assert.equal(ast.quoted, true);
  });

  test("AND OR NOT with parentheses", () => {
    const ast = parseFilterExpr("project:a OR (source:claude AND NOT live:1)");
    assert.equal(ast.type, "or");
    assert.equal(ast.left.key, "project");
    assert.equal(ast.right.type, "and");
    assert.equal(ast.right.right.type, "not");
    assert.equal(ast.right.right.child.key, "live");
  });

  test("implicit AND between adjacent terms", () => {
    const ast = parseFilterExpr("project:foo errors:>0");
    assert.equal(ast.type, "and");
    assert.equal(ast.left.key, "project");
    assert.equal(ast.right.key, "errors");
  });
});

describe("filter evalFilterExpr", () => {
  test("text search matches prompt, project, id, model", () => {
    const s = session();
    const ast = parseFilterExpr("login");
    assert.equal(evalFilterExpr(s, ast, NOW), true);
    assert.equal(evalFilterExpr(session({ prompt: "other" }), ast, NOW), false);
  });

  test("project and source filters", () => {
    assert.equal(evalFilterExpr(session(), parseFilterExpr("project:my"), NOW), true);
    assert.equal(evalFilterExpr(session(), parseFilterExpr("source:claude"), NOW), true);
    assert.equal(evalFilterExpr(session(), parseFilterExpr("source:codex"), NOW), false);
  });

  test("host:gpu matches only sessions from that host", () => {
    const gpu = session({ host: "gpu", source: "claude" });
    const laptop = session({ host: "laptop", source: "claude" });
    const local = session({ source: "claude" });
    const list = [gpu, laptop, local];
    assert.deepEqual(filterSessions(list, "host:gpu"), [gpu]);
    assert.deepEqual(filterSessions(list, "host:laptop"), [laptop]);
    assert.deepEqual(filterSessions(list, "source:claude"), list);
    assert.equal(evalFilterExpr(local, parseFilterExpr("host:gpu"), NOW), false);
    assert.equal(evalFilterExpr(gpu, parseFilterExpr("host:GPU"), NOW), true);
  });

  test("source:cursor-cloud matches only cursor-cloud sessions", () => {
    // Source comparison is exact lowercase equality, not a prefix match (fact ccfl):
    // source:cursor must never pull in cursor-cloud sessions, and vice versa.
    const cloud = session({ source: "cursor-cloud" });
    const local = session({ source: "cursor" });
    const list = [cloud, local, session()];
    assert.deepEqual(filterSessions(list, "source:cursor-cloud"), [cloud]);
    assert.deepEqual(filterSessions(list, "source:cursor"), [local]);
    assert.equal(evalFilterExpr(cloud, parseFilterExpr("source:cursor"), NOW), false);
    assert.equal(evalFilterExpr(local, parseFilterExpr("source:cursor-cloud"), NOW), false);
  });

  test("tool filter matches tool name case-insensitively", () => {
    assert.equal(evalFilterExpr(session(), parseFilterExpr("tool:Bash"), NOW), true);
    assert.equal(evalFilterExpr(session(), parseFilterExpr("tool:bash"), NOW), true);
    assert.equal(evalFilterExpr(session(), parseFilterExpr("tool:Write"), NOW), false);
  });

  test("model filter is substring match", () => {
    assert.equal(evalFilterExpr(session(), parseFilterExpr("model:sonnet-4"), NOW), true);
    assert.equal(evalFilterExpr(session(), parseFilterExpr("model:opus"), NOW), false);
  });

  test("grade filter uses computeGrade letter", () => {
    const s = session({
      chapters: 10,
      errors: 0,
      inputTokens: 50_000,
      cacheReadTokens: 40_000,
      toolCounts: { Bash: 5 },
    });
    const letter = "a";
    assert.equal(evalFilterExpr(s, parseFilterExpr(`grade:${letter}`), NOW), true);
  });

  test("errors comparisons", () => {
    assert.equal(evalFilterExpr(session({ errors: 5 }), parseFilterExpr("errors:>2"), NOW), true);
    assert.equal(evalFilterExpr(session({ errors: 1 }), parseFilterExpr("errors:>=2"), NOW), false);
    // A bare errors value with no operator is a malformed filter, not "any errors".
    assert.throws(() => parseFilterExpr("errors:0"), FilterParseError);
  });

  test("size comparisons on sizeKB", () => {
    assert.equal(evalFilterExpr(session({ sizeKB: 100 }), parseFilterExpr("size:<200"), NOW), true);
    assert.equal(evalFilterExpr(session({ sizeKB: 300 }), parseFilterExpr("size:>=512"), NOW), false);
  });

  test("age comparisons with h d w units", () => {
    const twoHoursAgo = NOW - 2 * 3600000;
    const s = session({ mtime: twoHoursAgo });
    assert.equal(evalFilterExpr(s, parseFilterExpr("age:<3h"), NOW), true);
    assert.equal(evalFilterExpr(s, parseFilterExpr("age:>1h"), NOW), true);
    assert.equal(evalFilterExpr(s, parseFilterExpr("age:<1h"), NOW), false);
  });

  test("live filter", () => {
    assert.equal(evalFilterExpr(session({ live: true }), parseFilterExpr("live:1"), NOW), true);
    assert.equal(evalFilterExpr(session({ live: false }), parseFilterExpr("live:1"), NOW), false);
  });

  test("negated term inverts match", () => {
    const ast = parseFilterExpr("-source:codex");
    assert.equal(evalFilterExpr(session(), ast, NOW), true);
    assert.equal(evalFilterExpr(session({ source: "codex" }), ast, NOW), false);
  });

  test("boolean AND OR NOT composition", () => {
    const ast = parseFilterExpr("project:missing OR source:claude");
    assert.equal(evalFilterExpr(session(), ast, NOW), true);

    const andAst = parseFilterExpr("source:claude AND model:opus");
    assert.equal(evalFilterExpr(session(), andAst, NOW), false);

    const notAst = parseFilterExpr("NOT live:1");
    assert.equal(evalFilterExpr(session({ live: true }), notAst, NOW), false);
  });
});

/** Apply expr like route-handlers-api: empty/whitespace → no filter. */
function filterSessions(sessions, expr, now = NOW) {
  const trimmed = (expr ?? "").trim();
  if (!trimmed) return sessions;
  const ast = parseFilterExpr(trimmed);
  if (!ast) return sessions;
  return sessions.filter((s) => evalFilterExpr(s, ast, now));
}

describe("filter parseFilterExpr edge cases", () => {
  test("nested AND groups inside OR", () => {
    const ast = parseFilterExpr("(project:alpha AND source:claude) OR (project:beta AND source:codex)");
    assert.equal(ast.type, "or");
    assert.equal(ast.left.type, "and");
    assert.equal(ast.right.type, "and");
    assert.equal(ast.left.left.key, "project");
    assert.equal(ast.right.right.key, "source");
    assert.equal(ast.right.right.value, "codex");
  });

  test("OR binds looser than AND without parentheses", () => {
    const ast = parseFilterExpr("project:zzz OR source:claude AND model:opus");
    assert.equal(ast.type, "or");
    assert.equal(ast.left.key, "project");
    assert.equal(ast.right.type, "and");
    assert.equal(ast.right.left.key, "source");
    assert.equal(ast.right.right.key, "model");
  });

  test("triple-nested parentheses with NOT", () => {
    const ast = parseFilterExpr("NOT (source:codex OR (tool:Write AND live:1))");
    assert.equal(ast.type, "not");
    assert.equal(ast.child.type, "or");
    assert.equal(ast.child.right.type, "and");
    assert.equal(ast.child.right.right.key, "live");
  });

  test("unknown tokens: comparator becomes text term", () => {
    const ast = parseFilterExpr("tokens:>50000");
    assert.equal(ast.key, "text");
    assert.equal(ast.value, "tokens:>50000");
  });

  test("unknown chapters field becomes text term", () => {
    const ast = parseFilterExpr("chapters:>=10");
    assert.equal(ast.key, "text");
    assert.equal(ast.value, "chapters:>=10");
  });

  test("known key with empty value falls back to text", () => {
    const ast = parseFilterExpr("project:");
    assert.equal(ast.key, "text");
    assert.equal(ast.value, "project:");
  });

  test("colon at start is a text term", () => {
    const ast = parseFilterExpr(":leading");
    assert.equal(ast.key, "text");
    assert.equal(ast.value, ":leading");
  });

  test("explicit AND keyword between terms", () => {
    const ast = parseFilterExpr("tool:Bash AND tool:Read");
    assert.equal(ast.type, "and");
    assert.equal(ast.left.key, "tool");
    assert.equal(ast.right.key, "tool");
  });

  test("boolean keywords are case-insensitive", () => {
    const ast = parseFilterExpr("project:a or source:claude and not live:1");
    assert.equal(ast.type, "or");
    assert.equal(ast.right.type, "and");
    assert.equal(ast.right.right.type, "not");
  });
});

describe("filter evalFilterExpr edge cases", () => {
  test("empty filter expression leaves all sessions", () => {
    const list = [session(), session({ project: "other" })];
    assert.deepEqual(filterSessions(list, ""), list);
    assert.deepEqual(filterSessions(list, "   "), list);
    assert.deepEqual(filterSessions(list, null), list);
  });

  test("null parse result does not filter (whitespace-only tokens)", () => {
    assert.equal(parseFilterExpr("\t"), null);
    const list = [session({ errors: 99 })];
    assert.deepEqual(filterSessions(list, "\t"), list);
  });

  test("errors less-than and less-than-or-equal boundaries", () => {
    assert.equal(evalFilterExpr(session({ errors: 0 }), parseFilterExpr("errors:<1"), NOW), true);
    assert.equal(evalFilterExpr(session({ errors: 1 }), parseFilterExpr("errors:<1"), NOW), false);
    assert.equal(evalFilterExpr(session({ errors: 2 }), parseFilterExpr("errors:<=2"), NOW), true);
    assert.equal(evalFilterExpr(session({ errors: 3 }), parseFilterExpr("errors:<=2"), NOW), false);
  });

  test("errors with a non-comparison value is rejected loudly", () => {
    // Previously "errors:yes"/"errors:0" silently meant "errors > 0"; now malformed
    // comparison values throw so the typo can't degrade into a wrong-but-plausible result.
    assert.throws(() => parseFilterExpr("errors:yes"), FilterParseError);
    assert.throws(() => parseFilterExpr("errors:0"), FilterParseError);
    // The explicit "any errors" form still works.
    assert.equal(evalFilterExpr(session({ errors: 0 }), parseFilterExpr("errors:>0"), NOW), false);
    assert.equal(evalFilterExpr(session({ errors: 1 }), parseFilterExpr("errors:>0"), NOW), true);
  });

  test("errors exactly zero via greater-than", () => {
    assert.equal(evalFilterExpr(session({ errors: 0 }), parseFilterExpr("errors:>0"), NOW), false);
    assert.equal(evalFilterExpr(session({ errors: 1 }), parseFilterExpr("errors:>0"), NOW), true);
  });

  test("size comparator; bare size value is rejected loudly", () => {
    assert.equal(evalFilterExpr(session({ sizeKB: 512 }), parseFilterExpr("size:>=512"), NOW), true);
    assert.equal(evalFilterExpr(session({ sizeKB: 511 }), parseFilterExpr("size:>=512"), NOW), false);
    // Previously "size:100" silently matched nothing; now it throws (coherent with errors/age).
    assert.throws(() => parseFilterExpr("size:100"), FilterParseError);
  });

  test("age day and week units", () => {
    const oneDayAgo = NOW - 86400000;
    const twoWeeksAgo = NOW - 14 * 86400000;
    assert.equal(evalFilterExpr(session({ mtime: oneDayAgo }), parseFilterExpr("age:<2d"), NOW), true);
    assert.equal(evalFilterExpr(session({ mtime: twoWeeksAgo }), parseFilterExpr("age:>1w"), NOW), true);
    assert.equal(evalFilterExpr(session({ mtime: twoWeeksAgo }), parseFilterExpr("age:<1w"), NOW), false);
  });

  test("age with invalid unit or format is rejected loudly", () => {
    // Previously these silently matched nothing; now they throw so a typo surfaces.
    assert.throws(() => parseFilterExpr("age:3x"), FilterParseError);
    assert.throws(() => parseFilterExpr("age:recent"), FilterParseError);
    assert.throws(() => parseFilterExpr("age:1"), FilterParseError);
  });

  test("nested OR inside AND matches second branch", () => {
    const ast = parseFilterExpr("(project:missing OR source:claude) AND tool:Bash");
    assert.equal(evalFilterExpr(session(), ast, NOW), true);
    assert.equal(
      evalFilterExpr(session({ source: "codex", tools: ["Bash"] }), ast, NOW),
      false,
    );
  });

  test("nested NOT excludes OR branch", () => {
    const ast = parseFilterExpr("NOT (source:codex OR model:opus)");
    assert.equal(evalFilterExpr(session(), ast, NOW), true);
    assert.equal(evalFilterExpr(session({ source: "codex" }), ast, NOW), false);
    assert.equal(evalFilterExpr(session({ model: "claude-opus-4" }), ast, NOW), false);
  });

  test("text search hits prompt and session id", () => {
    assert.equal(
      evalFilterExpr(session({ prompt: "graphql resolver schema" }), parseFilterExpr("graphql"), NOW),
      true,
    );
    assert.equal(
      evalFilterExpr(session({ id: "deadbeef", prompt: "" }), parseFilterExpr("dead"), NOW),
      true,
    );
  });

  test("text filter matches prompt needle", () => {
    assert.equal(
      evalFilterExpr(
        session({ prompt: "PROMPTONLYMARKER start" }),
        parseFilterExpr("promptonlymarker"),
        NOW,
      ),
      true,
    );
  });

  test("unknown tokens: term matches when literal appears in prompt", () => {
    const ast = parseFilterExpr("tokens:>50000");
    assert.equal(ast.key, "text");
    assert.equal(
      evalFilterExpr(session({ prompt: "used tokens:>50000 in summary" }), ast, NOW),
      true,
    );
    assert.equal(evalFilterExpr(session({ prompt: "small session" }), ast, NOW), false);
  });

  test("input token counts discoverable via bare numeric text", () => {
    const ast = parseFilterExpr("50000");
    assert.equal(
      evalFilterExpr(session({ inputTokens: 50000, prompt: "run used 50000 tokens" }), ast, NOW),
      true,
    );
    assert.equal(evalFilterExpr(session({ inputTokens: 100, prompt: "tiny" }), ast, NOW), false);
  });

  test("tool filter with empty tools list", () => {
    assert.equal(evalFilterExpr(session({ tools: [] }), parseFilterExpr("tool:Bash"), NOW), false);
    assert.equal(evalFilterExpr(session({ tools: null }), parseFilterExpr("tool:Read"), NOW), false);
  });

  test("negated errors comparison", () => {
    const ast = parseFilterExpr("-errors:>0");
    assert.equal(evalFilterExpr(session({ errors: 0 }), ast, NOW), true);
    assert.equal(evalFilterExpr(session({ errors: 2 }), ast, NOW), false);
  });

  test("NOT negates parenthesized AND group", () => {
    const ast = parseFilterExpr("NOT (source:claude AND model:sonnet)");
    assert.equal(ast.type, "not");
    assert.equal(ast.child.type, "and");
    assert.equal(evalFilterExpr(session(), ast, NOW), false);
    assert.equal(evalFilterExpr(session({ source: "codex" }), ast, NOW), true);
  });

  test("grade filter rejects wrong letter", () => {
    const s = session({
      chapters: 10,
      errors: 0,
      inputTokens: 50_000,
      cacheReadTokens: 40_000,
      toolCounts: { Bash: 5 },
    });
    assert.equal(evalFilterExpr(s, parseFilterExpr("grade:a"), NOW), true);
    assert.equal(evalFilterExpr(s, parseFilterExpr("grade:f"), NOW), false);
    assert.equal(evalFilterExpr(s, parseFilterExpr("-grade:a"), NOW), false);
  });

  test("live filter is boolean not string match", () => {
    assert.equal(evalFilterExpr(session({ live: true }), parseFilterExpr("live:0"), NOW), true);
    assert.equal(evalFilterExpr(session({ live: false }), parseFilterExpr("live:yes"), NOW), false);
  });

  test("source filter is case-insensitive on session value", () => {
    assert.equal(
      evalFilterExpr(session({ source: "Claude" }), parseFilterExpr("source:claude"), NOW),
      true,
    );
    assert.equal(
      evalFilterExpr(session({ source: "CODEX" }), parseFilterExpr("source:codex"), NOW),
      true,
    );
    assert.equal(
      evalFilterExpr(session({ source: "Claude" }), parseFilterExpr("source:codex"), NOW),
      false,
    );
  });

  test("text search matches session id case-insensitively", () => {
    assert.equal(
      evalFilterExpr(session({ id: "ABC12345", prompt: "" }), parseFilterExpr("abc"), NOW),
      true,
    );
    assert.equal(
      evalFilterExpr(session({ id: "ABC12345", prompt: "" }), parseFilterExpr("xyz"), NOW),
      false,
    );
  });

  test("age greater-equal and less-equal boundaries", () => {
    const exactlyTwoHours = NOW - 2 * 3600000;
    const s = session({ mtime: exactlyTwoHours });
    assert.equal(evalFilterExpr(s, parseFilterExpr("age:>=2h"), NOW), true);
    assert.equal(evalFilterExpr(s, parseFilterExpr("age:<=2h"), NOW), true);
    assert.equal(evalFilterExpr(s, parseFilterExpr("age:<2h"), NOW), false);
    assert.equal(evalFilterExpr(s, parseFilterExpr("age:>2h"), NOW), false);
  });

  test("size greater-than and less-equal comparators", () => {
    assert.equal(evalFilterExpr(session({ sizeKB: 101 }), parseFilterExpr("size:>100"), NOW), true);
    assert.equal(evalFilterExpr(session({ sizeKB: 100 }), parseFilterExpr("size:>100"), NOW), false);
    assert.equal(evalFilterExpr(session({ sizeKB: 100 }), parseFilterExpr("size:<=100"), NOW), true);
    assert.equal(evalFilterExpr(session({ sizeKB: 101 }), parseFilterExpr("size:<=100"), NOW), false);
  });

  test("three-term implicit AND requires all clauses", () => {
    const ast = parseFilterExpr("source:claude tool:Bash model:sonnet");
    assert.equal(ast.type, "and");
    assert.equal(ast.left.type, "and");
    assert.equal(evalFilterExpr(session(), ast, NOW), true);
    assert.equal(
      evalFilterExpr(session({ tools: ["Bash"], model: "claude-opus-4" }), ast, NOW),
      false,
    );
  });

  test("chained OR matches any branch", () => {
    const ast = parseFilterExpr("source:codex OR source:factory OR source:claude");
    assert.equal(ast.type, "or");
    assert.equal(ast.left.type, "or");
    assert.equal(evalFilterExpr(session(), ast, NOW), true);
    assert.equal(evalFilterExpr(session({ source: "factory" }), ast, NOW), true);
    assert.equal(evalFilterExpr(session({ source: "grok" }), ast, NOW), false);
  });

  test("double NOT restores live match", () => {
    const ast = parseFilterExpr("NOT NOT live:1");
    assert.equal(ast.type, "not");
    assert.equal(ast.child.type, "not");
    assert.equal(evalFilterExpr(session({ live: true }), ast, NOW), true);
    assert.equal(evalFilterExpr(session({ live: false }), ast, NOW), false);
  });

  test("negated quoted single-token text term", () => {
    const ast = parseFilterExpr('-"exactphrase"');
    assert.equal(ast.negated, true);
    assert.equal(ast.quoted, true);
    assert.equal(ast.value, "exactphrase");
    assert.equal(
      evalFilterExpr(session({ prompt: "has exactphrase here" }), ast, NOW),
      false,
    );
    assert.equal(evalFilterExpr(session({ prompt: "other words" }), ast, NOW), true);
  });

  test("evalFilterExpr default branch returns true for unknown node type", () => {
    assert.equal(evalFilterExpr(session(), { type: "legacy" }, NOW), true);
    assert.equal(
      evalFilterExpr(session({ source: "codex" }), { type: "placeholder" }, NOW),
      true,
    );
  });

  test("evalFilterExpr default branch in AND does not block matching sibling", () => {
    const codexTerm = { type: "term", key: "source", value: "codex", negated: false };
    const ast = { type: "and", left: { type: "unknown" }, right: codexTerm };
    assert.equal(evalFilterExpr(session({ source: "codex" }), ast, NOW), true);
    assert.equal(evalFilterExpr(session({ source: "claude" }), ast, NOW), false);
  });
});

describe("filter parseFilterExpr tokenizer boundaries", () => {
  test("single-quoted phrase token", () => {
    const ast = parseFilterExpr("'multi word'");
    assert.equal(ast.key, "text");
    assert.equal(ast.value, "multi word");
    assert.equal(ast.quoted, true);
  });

  test("boolean keywords do not split words sharing prefixes", () => {
    const ast = parseFilterExpr("ANDROID");
    assert.equal(ast.key, "text");
    assert.equal(ast.value, "ANDROID");
    const orAst = parseFilterExpr("ORACLE");
    assert.equal(orAst.key, "text");
    assert.equal(orAst.value, "ORACLE");
  });
});

describe("filter parseFilterExpr malformed input", () => {
  test("unclosed parenthesis still parses inner term", () => {
    const ast = parseFilterExpr("(project:a");
    assert.equal(ast.type, "term");
    assert.equal(ast.key, "project");
    assert.equal(ast.value, "a");
  });

  test("stray closing paren after term is discarded", () => {
    const ast = parseFilterExpr("project:a)");
    assert.equal(ast.type, "term");
    assert.equal(ast.key, "project");
    assert.equal(ast.value, "a");
  });

  test("lone NOT binds to empty text operand", () => {
    const ast = parseFilterExpr("NOT");
    assert.equal(ast.type, "not");
    assert.equal(ast.child.type, "term");
    assert.equal(ast.child.key, "text");
    assert.equal(ast.child.value, "");
  });

  test("empty parentheses collapse to empty text term", () => {
    const ast = parseFilterExpr("()");
    assert.equal(ast.type, "term");
    assert.equal(ast.key, "text");
    assert.equal(ast.value, "");
  });

  test("trailing AND leaves empty right operand", () => {
    const ast = parseFilterExpr("source:claude AND");
    assert.equal(ast.type, "and");
    assert.equal(ast.left.key, "source");
    assert.equal(ast.left.value, "claude");
    assert.equal(ast.right.type, "term");
    assert.equal(ast.right.key, "text");
    assert.equal(ast.right.value, "");
  });

  test("leading OR consumes empty left operand before term", () => {
    const ast = parseFilterExpr("OR project:a");
    assert.equal(ast.type, "and");
    assert.equal(ast.left.key, "text");
    assert.equal(ast.left.value, "");
    assert.equal(ast.right.key, "project");
    assert.equal(ast.right.value, "a");
  });

  test("extra colons in known-key value are preserved", () => {
    const ast = parseFilterExpr("project:foo:bar");
    assert.equal(ast.key, "project");
    assert.equal(ast.value, "foo:bar");
  });

  test("bare minus is a text term not a negation prefix", () => {
    const ast = parseFilterExpr("-");
    assert.equal(ast.key, "text");
    assert.equal(ast.value, "-");
    assert.equal(ast.negated, false);
  });

  test("unclosed double-quote still yields quoted text term", () => {
    const ast = parseFilterExpr('"unclosed');
    assert.equal(ast.key, "text");
    assert.equal(ast.value, "unclosed");
    assert.equal(ast.quoted, true);
  });

  test("lone AND keyword becomes empty text term", () => {
    const ast = parseFilterExpr("AND");
    assert.equal(ast.type, "term");
    assert.equal(ast.key, "text");
    assert.equal(ast.value, "");
  });
});

describe("filter typo detection (fact filter-typo)", () => {
  test("known key with operator outside value throws (age<1d)", () => {
    assert.throws(() => parseFilterExpr("age<1d"), FilterParseError);
    assert.throws(() => parseFilterExpr("size>100"), FilterParseError);
    assert.throws(() => parseFilterExpr("errors>=2"), FilterParseError);
    assert.throws(() => parseFilterExpr("grade=a"), FilterParseError);
    assert.throws(() => parseFilterExpr("live=1"), FilterParseError);
    assert.throws(() => parseFilterExpr("host=gpu"), FilterParseError);
  });

  test("negated mistyped token still throws (-age<1d)", () => {
    assert.throws(() => parseFilterExpr("-age<1d"), FilterParseError);
  });

  test("error message suggests the corrected key:operator form", () => {
    try {
      parseFilterExpr("age<1d");
      assert.fail("expected throw");
    } catch (err) {
      assert.ok(err instanceof FilterParseError);
      assert.match(err.message, /age:<1d/);
    }
    try {
      parseFilterExpr("grade=a");
      assert.fail("expected throw");
    } catch (err) {
      assert.match(err.message, /grade:a/); // leading '=' stripped in suggestion
    }
  });

  test("correct colon form is unaffected", () => {
    assert.equal(parseFilterExpr("age:<1d").key, "age");
    assert.equal(parseFilterExpr("size:>100").key, "size");
    assert.equal(parseFilterExpr("errors:>=2").key, "errors");
  });

  test("quoting is an explicit free-text escape hatch (no throw)", () => {
    const ast = parseFilterExpr('"age<1d"');
    assert.equal(ast.key, "text");
    assert.equal(ast.value, "age<1d");
    assert.equal(ast.quoted, true);
  });

  test("legitimate free-text with a colon is not a typo", () => {
    // 'error: foo' -> tokenizes to two tokens; neither is a mistyped structured filter.
    const ast = parseFilterExpr("error: foo");
    assert.equal(ast.type, "and");
    assert.equal(ast.left.key, "text");
    assert.equal(ast.left.value, "error:");
    assert.equal(ast.right.value, "foo");
  });

  test("plain free-text words that merely start with a key prefix are fine", () => {
    assert.equal(parseFilterExpr("ROCm").key, "text");
    assert.equal(parseFilterExpr("ageless").key, "text");
    assert.equal(parseFilterExpr("sizes").key, "text");
    assert.equal(parseFilterExpr("liveness").key, "text");
  });

  test("unknown key with colon still degrades to free text (foo:bar, tokens:>50000)", () => {
    assert.equal(parseFilterExpr("foo:bar").key, "text");
    assert.equal(parseFilterExpr("tokens:>50000").key, "text");
    assert.equal(parseFilterExpr("chapters:>=10").key, "text");
  });
});

describe("filter evalFilterExpr performance", () => {
  test("text filter matches prompt needle across many sessions", async () => {
    const list = [];
    for (let i = 0; i < 50; i++) {
      list.push(
        session({
          prompt: `prompt-${i} sharedneedle extra`,
        }),
      );
    }
    const ast = parseFilterExpr("sharedneedle");

    const ITERS = 30;
    const t0 = performance.now();
    for (let i = 0; i < ITERS; i++) {
      for (const s of list) evalFilterExpr(s, ast, NOW);
    }
    const ms = (performance.now() - t0) / ITERS;
    assertPerf(
      ms < 50,
      `expected text evalFilterExpr under 50ms/op with 50 sessions prompt hits, got ${ms.toFixed(2)}ms`,
    );
    assert.equal(list.filter((s) => evalFilterExpr(s, ast, NOW)).length, 50);
  });

  test("source/tool/grade filters cache session toLowerCase across evals", async () => {
    const long = "x".repeat(200);
    const list = [];
    for (let i = 0; i < 500; i++) {
      list.push(
        session({
          source: "claude",
          tools: ["Bash", long + "Read", long + "Write"],
          chapters: 10,
          errors: 0,
          inputTokens: 50_000,
          cacheReadTokens: 40_000,
        }),
      );
    }
    const ast = parseFilterExpr("source:claude AND tool:Bash AND grade:a");

    const ITERS = 40;
    const t0 = performance.now();
    for (let i = 0; i < ITERS; i++) {
      for (const s of list) evalFilterExpr(s, ast, NOW);
    }
    const ms = (performance.now() - t0) / ITERS;
    assertPerf(
      ms < 8,
      `expected source/tool/grade evalFilterExpr under 8ms/op with 500×long-field sessions, got ${ms.toFixed(2)}ms`,
    );
    assert.equal(list.filter((s) => evalFilterExpr(s, ast, NOW)).length, 500);
  });

  test("project/model filters cache session toLowerCase across evals", async () => {
    const long = "x".repeat(200);
    const list = [];
    for (let i = 0; i < 2000; i++) {
      list.push(
        session({
          project: long + "my-app-" + i,
          model: long + "claude-sonnet-4-6",
                prompt: long + " unrelated",
        }),
      );
    }
    const ast = parseFilterExpr("project:my-app AND model:sonnet");

    const ITERS = 30;
    const t0 = performance.now();
    for (let i = 0; i < ITERS; i++) {
      for (const s of list) evalFilterExpr(s, ast, NOW);
    }
    const ms = (performance.now() - t0) / ITERS;
    assertPerf(
      ms < 0.5,
      `expected project/model evalFilterExpr under 0.5ms/op with 2000×long-field sessions, got ${ms.toFixed(2)}ms`,
    );
    assert.equal(list.filter((s) => evalFilterExpr(s, ast, NOW)).length, 2000);
  });
});

// ---------------------------------------------------------------------------
// BM25 filter/searchSessions parity tests (fact 0oy)
// ---------------------------------------------------------------------------

/**
 * Build a synthetic SearchIndex from termFreqs and return the populated singleton.
 * Caller must call resetSearchIndexForTests() after the test.
 */
function buildSyntheticSearchIndex(termFreqsByPath) {
  resetSearchIndexForTests();
  const si = getSearchIndex();
  for (const [p, tf] of Object.entries(termFreqsByPath)) {
    const m = tf instanceof Map ? tf : new Map(Object.entries(tf));
    si.upsert(p, m);
  }
  return si;
}

function metaFor(paths) {
  const m = new Map();
  for (const p of paths) {
    m.set(p, { firstPrompt: "test", model: "claude", tools: [], toolCounts: {},
      chapters: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, durationMs: 0, errors: 0, files: 0, commits: 0 });
  }
  return m;
}

function sessionObj(p) {
  return { path: p, source: "claude", project: "parity-test", file: p.split("/").pop(), mtime: new Date(), size: 100 };
}

describe("BM25 filter/searchSessions parity (fact 0oy)", () => {
  test("prefix expansion: expr=token matches same sessions as searchSessions('token')", () => {
    // Index two sessions: one has 'tokenizer', another has 'token'
    const pFull = "/tmp/parity-prefix-full.jsonl";
    const pExact = "/tmp/parity-prefix-exact.jsonl";
    buildSyntheticSearchIndex({
      [pFull]: { tokenizer: 3, other: 1 },
      [pExact]: { token: 2, other: 1 },
    });
    try {
      const sessions = [sessionObj(pFull), sessionObj(pExact)];
      const index = metaFor([pFull, pExact]);

      // searchSessions with 'token' as final term: prefix-expands to 'tokenizer', hits pFull too
      const searchHits = searchSessions(sessions, index, "token", 1000);

      // buildBm25FilterContext with 'token' should match the same set
      const ast = parseFilterExpr("token");
      const ctx = buildBm25FilterContext(ast);
      const filterHits = sessions.filter((s) => evalFilterExpr(s, ast, NOW, ctx));

      const searchPaths = new Set(searchHits.map((h) => h.path));
      const filterPaths = new Set(filterHits.map((s) => s.path));

      assert.deepEqual(searchPaths, filterPaths,
        `prefix parity: searchSessions=${[...searchPaths].join(",")} filter=${[...filterPaths].join(",")}`);
      // Both must include the 'tokenizer' session (prefix expansion)
      assert.ok(filterPaths.has(pFull), "prefix expansion should match 'tokenizer' session for query 'token'");
    } finally {
      resetSearchIndexForTests();
    }
  });

  test("fuzzy expansion: expr=misspelling matches same sessions as searchSessions('misspelling')", () => {
    // Index a session with 'tokenizer'; query with 'tokenizr' (typo, high Jaccard)
    const pFull = "/tmp/parity-fuzzy-full.jsonl";
    buildSyntheticSearchIndex({
      [pFull]: { tokenizer: 5 },
    });
    try {
      const sessions = [sessionObj(pFull)];
      const index = metaFor([pFull]);

      const query = "tokenizr"; // OOV misspelling — should fuzzy-expand to 'tokenizer'
      const searchHits = searchSessions(sessions, index, query, 1000);

      const ast = parseFilterExpr(query);
      const ctx = buildBm25FilterContext(ast);
      const filterHits = sessions.filter((s) => evalFilterExpr(s, ast, NOW, ctx));

      assert.equal(
        filterHits.length, searchHits.length,
        `fuzzy parity: searchSessions=${searchHits.length} filter=${filterHits.length} for query '${query}'`
      );
    } finally {
      resetSearchIndexForTests();
    }
  });

  test("quoted phrase: filter does not prefix-expand tokens, 'tokenizer' session excluded for quoted 'token'", () => {
    // Quoted phrase tokenizes to ['token', 'parser'].
    // 'token' is in vocab; 'tokenizer' is a different vocab term.
    // Without prefix expansion, pPrefix (only has 'tokenizer') must NOT match.
    // pExact (has 'token' and 'parser' AND the verbatim phrase) must match.
    // Phrase scan (yd3) requires real files so sessions contain the verbatim phrase.
    const pExact = "/tmp/parity-quote-exact.jsonl";
    const pPrefix = "/tmp/parity-quote-prefix.jsonl";
    // Write minimal JSONL files: pExact contains verbatim "token parser", pPrefix does not.
    const makeRow = (text) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 1 } } });
    writeFileSync(pExact, makeRow("This is a token parser implementation.") + "\n");
    writeFileSync(pPrefix, makeRow("This tokenizer and parser are separate.") + "\n");
    buildSyntheticSearchIndex({
      [pExact]: { token: 2, parser: 1 },
      [pPrefix]: { tokenizer: 2, parser: 1 },
    });
    try {
      const sessions = [sessionObj(pExact), sessionObj(pPrefix)];
      const index = metaFor([pExact, pPrefix]);

      const ast = parseFilterExpr('"token parser"');
      const ctx = buildBm25FilterContext(ast);
      const filterHits = sessions.filter((s) => evalFilterExpr(s, ast, NOW, ctx));
      const filterPaths = new Set(filterHits.map((s) => s.path));

      // pPrefix has 'tokenizer' but NOT 'token' in vocab — quoted phrase must not prefix-expand
      assert.ok(!filterPaths.has(pPrefix),
        "quoted 'token parser' must not include session with only 'tokenizer' (no prefix expansion for quoted phrases)");
      // pExact has both 'token' and 'parser' AND the verbatim phrase — must match
      assert.ok(filterPaths.has(pExact),
        "quoted 'token parser' must include session with exact tokens 'token' and 'parser'");

      // Unquoted 'token parser' SHOULD prefix-expand 'parser' (final token) and include pPrefix
      // (both 'tokenizer'... actually 'parser' is final token here, and pPrefix has 'parser')
      // This just verifies the quoted path is stricter than unquoted for token matching
      const astUnquoted = parseFilterExpr("token parser");
      const ctxUnquoted = buildBm25FilterContext(astUnquoted);
      const unquotedHits = sessions.filter((s) => evalFilterExpr(s, astUnquoted, NOW, ctxUnquoted));
      // pPrefix has 'tokenizer' (≠ 'token') so it still won't match the 'token' clause unquoted either
      // But the key point: quoted uses exact only for each token
      assert.ok(unquotedHits.some((s) => s.path === pExact),
        "unquoted 'token parser' still matches pExact");
    } finally {
      resetSearchIndexForTests();
      for (const p of [pExact, pPrefix]) { if (existsSync(p)) unlinkSync(p); }
    }
  });

  test("multi-token unquoted term: AND semantics, each token gets prefix/fuzzy independently", () => {
    const pBoth = "/tmp/parity-multi-both.jsonl";
    const pOne = "/tmp/parity-multi-one.jsonl";
    buildSyntheticSearchIndex({
      [pBoth]: { token: 2, parser: 3 },
      [pOne]: { token: 2, other: 1 },
    });
    try {
      const sessions = [sessionObj(pBoth), sessionObj(pOne)];
      const index = metaFor([pBoth, pOne]);

      // 'token parser' unquoted: AND of both tokens; pBoth has both, pOne only has token
      const query = "token parser";
      const searchHits = searchSessions(sessions, index, query, 1000);

      const ast = parseFilterExpr(query);
      const ctx = buildBm25FilterContext(ast);
      const filterHits = sessions.filter((s) => evalFilterExpr(s, ast, NOW, ctx));

      const searchPaths = new Set(searchHits.map((h) => h.path));
      const filterPaths = new Set(filterHits.map((s) => s.path));

      assert.deepEqual(searchPaths, filterPaths,
        `multi-token AND parity mismatch`);
      assert.ok(filterPaths.has(pBoth), "session with both tokens must match");
      assert.ok(!filterPaths.has(pOne), "session with only one token must not match");
    } finally {
      resetSearchIndexForTests();
    }
  });

  test("structured keys and booleans are evaluated outside BM25 context (fact cw8)", () => {
    const pMatch = "/tmp/parity-cw8-match.jsonl";
    const pNoText = "/tmp/parity-cw8-no-text.jsonl";
    const pWrongStructured = "/tmp/parity-cw8-wrong-structured.jsonl";
    const pFactory = "/tmp/parity-cw8-factory.jsonl";

    buildSyntheticSearchIndex({
      [pMatch]: { bm25only: 3 },
      [pNoText]: { other: 1 },
      [pWrongStructured]: { bm25only: 3 },
      [pFactory]: { other: 1 },
    });

    try {
      const goodMeta = {
        project: "alpha-app",
        source: "claude",
        tools: ["Bash"],
        model: "claude-sonnet-4-6",
        live: true,
        errors: 0,
        sizeKB: 768,
        mtime: NOW - 2 * 3600000,
        chapters: 10,
        inputTokens: 50_000,
        cacheReadTokens: 40_000,
        toolCounts: { Bash: 5 },
      };
      const sessions = [
        session({ ...goodMeta, path: pMatch }),
        session({ ...goodMeta, path: pNoText }),
        session({ ...goodMeta, path: pWrongStructured, source: "codex" }),
        session({ path: pFactory, source: "factory", project: "other" }),
      ];

      const ast = parseFilterExpr(
        "(project:alpha AND source:claude AND tool:Bash AND model:sonnet AND grade:a AND errors:<1 AND size:>=512 AND age:<3h AND live:1 AND bm25only) OR (source:factory AND NOT bm25only)"
      );
      const ctx = buildBm25FilterContext(ast);
      assert.deepEqual([...ctx.textMatchSets.keys()], ["bm25only"]);

      const hits = sessions.filter((s) => evalFilterExpr(s, ast, NOW, ctx)).map((s) => s.path);
      assert.deepEqual(hits.sort(), [pFactory, pMatch].sort());
    } finally {
      resetSearchIndexForTests();
    }
  });

  // Bug fix tests: camelCase query parity and quoted phrase yd3 parity

  test("camelCase query: tokenize('indexWriters') yields ['index','writers']", async () => {
    const { tokenize: tok } = await import("../src/sessions/search-tokenizer.js");
    assert.deepEqual(tok("indexWriters"), ["index", "writers"],
      "tokenize must split camelCase into component terms");
  });

  test("camelCase parity: 'indexWriters' searchSessions count equals filter context count", () => {
    // Two sessions: one has both 'index' and 'writers', one has only 'indexwriters' (lowercased before split — the bug)
    const pCamel = "/tmp/parity-camel-split.jsonl";
    const pLower = "/tmp/parity-camel-lower.jsonl";
    buildSyntheticSearchIndex({
      [pCamel]: { index: 2, writers: 1 },
      [pLower]: { indexwriters: 1 },
    });
    try {
      const sessions = [sessionObj(pCamel), sessionObj(pLower)];
      const index = metaFor([pCamel, pLower]);

      const query = "indexWriters";
      const searchHits = searchSessions(sessions, index, query, 1000);
      const ast = parseFilterExpr(query);
      const ctx = buildBm25FilterContext(ast);
      const filterHits = sessions.filter((s) => evalFilterExpr(s, ast, NOW, ctx));

      // Both search and filter should match pCamel (has 'index'+'writers') not pLower ('indexwriters')
      assert.equal(searchHits.length, filterHits.length,
        `camelCase parity: searchSessions=${searchHits.length} filter=${filterHits.length}`);
      const searchPaths = new Set(searchHits.map((h) => h.path));
      const filterPaths = new Set(filterHits.map((s) => s.path));
      assert.ok(searchPaths.has(pCamel), "searchSessions must match session with split camelCase tokens");
      assert.ok(filterPaths.has(pCamel), "filter must match session with split camelCase tokens");
      assert.ok(!searchPaths.has(pLower), "searchSessions must not match session with unsplit 'indexwriters'");
      assert.ok(!filterPaths.has(pLower), "filter must not match session with unsplit 'indexwriters'");
    } finally {
      resetSearchIndexForTests();
    }
  });

  test("yd3 parity: quoted phrase matches only verbatim session, not word-cooccurrence session", () => {
    // pVerbatim: words co-occur in order verbatim ("start understanding")
    // pOutOfOrder: same words present but NOT as verbatim phrase
    const pVerbatim = "/tmp/parity-yd3-verbatim.jsonl";
    const pOutOfOrder = "/tmp/parity-yd3-ooo.jsonl";
    const makeRow = (text) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 1 } } });
    writeFileSync(pVerbatim, makeRow("We start understanding the system by reading code.") + "\n");
    writeFileSync(pOutOfOrder, makeRow("Understanding comes first; only then do we start.") + "\n");
    buildSyntheticSearchIndex({
      [pVerbatim]: { start: 1, understanding: 1, the: 1 },
      [pOutOfOrder]: { start: 1, understanding: 1 },
    });
    try {
      const sessions = [sessionObj(pVerbatim), sessionObj(pOutOfOrder)];
      const index = metaFor([pVerbatim, pOutOfOrder]);

      const phrase = '"start understanding"';
      // searchSessions with quoted phrase
      const searchHits = searchSessions(sessions, index, phrase, 1000);

      // filter with quoted phrase
      const ast = parseFilterExpr(phrase);
      const ctx = buildBm25FilterContext(ast);
      const filterHits = sessions.filter((s) => evalFilterExpr(s, ast, NOW, ctx));

      const searchPaths = new Set(searchHits.map((h) => h.path));
      const filterPaths = new Set(filterHits.map((s) => s.path));

      assert.ok(searchPaths.has(pVerbatim), "searchSessions must match verbatim session");
      assert.ok(!searchPaths.has(pOutOfOrder), "searchSessions must not match out-of-order session");
      assert.ok(filterPaths.has(pVerbatim), "filter must match verbatim session");
      assert.ok(!filterPaths.has(pOutOfOrder), "filter must not match out-of-order session");
      assert.equal(filterHits.length, searchHits.length,
        `yd3 parity: searchSessions=${searchHits.length} filter=${filterHits.length}`);
    } finally {
      resetSearchIndexForTests();
      for (const p of [pVerbatim, pOutOfOrder]) { if (existsSync(p)) unlinkSync(p); }
    }
  });
});
