import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildShareMetadata, publicFindings } from "../../src/share/metadata.js";
import { minimalSession } from "../helpers/minimal-session.js";

describe("share metadata", () => {
  test("buildShareMetadata assembles session fields", () => {
    const session = minimalSession({
      sessionId: "abcdef12-3456-7890-abcd-ef1234567890",
      model: "claude-3-5-sonnet",
      gitBranch: "main",
      stats: {
        toolCounts: { Read: 2, Bash: 1 },
        totalInputTokens: 1000,
        totalOutputTokens: 500,
        totalCacheHit: 200,
        errors: 1,
        userMessages: 1,
        assistantTurns: 1,
      },
    });
    const meta = buildShareMetadata(session);
    assert.equal(meta.sessionId, session.sessionId);
    assert.equal(meta.source, "claude");
    assert.equal(meta.model, session.model);
    assert.equal(meta.gitBranch, "main");
    assert.equal(meta.inputTokens, 1000);
    assert.equal(meta.errorCount, 1);
    assert.deepEqual(meta.tools, ["Read", "Bash"]);
    assert.ok(meta.chapterCount >= 1);
    assert.ok(meta.firstPrompt.length <= 200);
    assert.equal(meta.tokensEstimated, false);
    assert.equal(meta.timesEstimated, false);
  });

  test("buildShareMetadata carries estimated flags for cursor sessions (fact oix)", () => {
    const session = minimalSession({
      source: "cursor",
      model: "cursor",
      timesEstimated: true,
      stats: {
        toolCounts: {},
        totalInputTokens: 0,
        totalOutputTokens: 400,
        totalCacheHit: 0,
        errors: 0,
        userMessages: 1,
        assistantTurns: 1,
        tokensEstimated: true,
      },
    });
    const meta = buildShareMetadata(session);
    assert.equal(meta.tokensEstimated, true);
    assert.equal(meta.timesEstimated, true);
  });

  test("publicFindings strips raw secret", () => {
    const findings = [{
      ruleId: "x",
      description: "test",
      match: "sk-f…cdef",
      secret: "sk-fake1234567890abcdef",
      location: { chapterIndex: 0, eventIndex: 0, eventType: "user", toolName: null },
    }];
    const pub = publicFindings(findings);
    assert.equal(pub[0].ruleId, "x");
    assert.equal(pub[0].secret, undefined);
  });
});