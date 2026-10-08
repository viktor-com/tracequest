import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildStandupInput } from "../../src/standup/compact-input.js";

function sessionFixture(id, opts = {}) {
  const ts = opts.ts || "2026-06-03T12:00:00.000Z";
  const prompt = opts.prompt || "Implement the compact standup input builder with enough detail for a status update.";
  const reply = opts.reply || "Built the module, added tests, and left CLI wiring for the next step.";
  return {
    sessionHash: id,
    path: `/home/dev/.claude/projects/tracequest/${id}.jsonl`,
    sessionId: id,
    source: "claude",
    model: "claude-sonnet-4-20250514",
    cwd: "/home/dev/code/tracequest",
    startTime: ts,
    durationMs: 95_000,
    eventCount: 3,
    stats: {
      userMessages: 1,
      assistantTurns: 1,
      totalInputTokens: 1200,
      totalOutputTokens: 400,
      totalCacheHit: 300,
      errors: opts.error ? 1 : 0,
      toolCounts: opts.toolCounts || { Bash: 1, Read: 1 },
    },
    events: [
      {
        type: "user",
        timestamp: ts,
        text: prompt,
      },
      {
        type: "assistant",
        timestamp: ts,
        text: reply,
        toolCalls: [
          {
            id: `${id}-bash`,
            name: "Bash",
            input: "npm test -- --runInBand /home/dev/code/tracequest/private-output.log",
          },
          {
            id: `${id}-read`,
            name: "Read",
            input: "/home/dev/code/tracequest/src/standup/compact-input.js",
          },
        ],
        tokens: { input: 1200, output: 400, cacheHit: 300, cacheWrite: 0 },
      },
      {
        type: "tool_result",
        timestamp: ts,
        toolUseId: `${id}-bash`,
        isError: !!opts.error,
        text: opts.toolOutput || "PASS\n".repeat(200),
      },
    ],
  };
}

describe("standup compact input", () => {
  test("summarizes selected sessions with capped snippets and no raw tool output", () => {
    const longPrompt = "Plan the release ".repeat(40) + "RAW_PROMPT_TAIL_SHOULD_NOT_APPEAR";
    const longReply = "Implemented the feature and verified behavior. ".repeat(30) + "RAW_REPLY_TAIL_SHOULD_NOT_APPEAR";
    const toolOutput = "TOOL_OUTPUT_SHOULD_NOT_APPEAR\n".repeat(100);
    const md = buildStandupInput(
      [{
        session: sessionFixture("abc12345", {
          prompt: longPrompt,
          reply: longReply,
          toolOutput,
          error: true,
        }),
        discovery: {
          path: "/home/dev/.claude/projects/tracequest/abc12345.jsonl",
          project: "-home-dev-code-tracequest",
          source: "claude",
          mtime: new Date("2026-06-03T12:00:00.000Z"),
        },
      }],
      {
        generatedAt: "2026-06-04T00:00:00.000Z",
        limits: {
          maxPromptChars: 90,
          maxAssistantChars: 100,
          maxCommandChars: 80,
        },
      },
    );

    assert.match(md, /# TraceQuest Standup Request/);
    assert.match(md, /Session abc12345/);
    assert.match(md, /Source: claude/);
    assert.match(md, /Project: tracequest/);
    assert.match(md, /Model: claude-sonnet-4-20250514/);
    assert.match(md, /Counts: 1 prompt, 1 assistant turn, 2 tool calls, 1 error/);
    assert.match(md, /Top tools: Bash x1, Read x1/);
    assert.match(md, /Chapters shown: 1 of 1/);
    assert.match(md, /Data Policy/);
    assert.match(md, /Omitted: raw JSONL/);
    assert.match(md, /Assistant outcome snippet:/);
    assert.match(md, /\.\.\./, "long snippets should be visibly truncated");

    assert.doesNotMatch(md, /RAW_PROMPT_TAIL_SHOULD_NOT_APPEAR/);
    assert.doesNotMatch(md, /RAW_REPLY_TAIL_SHOULD_NOT_APPEAR/);
    assert.doesNotMatch(md, /TOOL_OUTPUT_SHOULD_NOT_APPEAR/);
    assert.doesNotMatch(md, /\/home\/dev/);
    assert.ok(md.length < 5000, `compact input should stay small, got ${md.length} bytes`);
  });

  test("standup compact input privacy regression omits adversarial private sentinels while keeping capped summaries", () => {
    const usefulPrompt = "Investigate compact-input privacy regression and keep a standup-safe progress summary.";
    const usefulReply = "Added focused regression coverage and preserved useful capped standup signal.";
    const promptTail = "FULL_PRIVATE_PROMPT_TAIL_SENTINEL_9MQW";
    const replyTail = "FULL_PRIVATE_ASSISTANT_TAIL_SENTINEL_B7RD";
    const rawJsonlSentinel = "RAW_JSONL_RECORD_SENTINEL_X4KD";
    const absPathSentinel = "ABSOLUTE_SESSION_PATH_SENTINEL_Q8PL";
    const toolOutputSentinel = "FULL_TOOL_OUTPUT_SENTINEL_Z2NV";
    const absoluteSessionPath = `/tmp/${absPathSentinel}/claude/projects/privacy-regression/session.jsonl`;
    const absoluteCwd = `/tmp/${absPathSentinel}/workspace/tracequest`;
    const absoluteCommandPath = `/tmp/${absPathSentinel}/workspace/tracequest/private/secret-output.log`;
    const rawJsonlRecord = `{"type":"user","sessionId":"privacy-direct","message":{"content":"${rawJsonlSentinel}"}}`;
    const session = sessionFixture("privacy-direct", {
      prompt: `${usefulPrompt} ${"private prompt detail ".repeat(24)} ${promptTail}`,
      reply: `${usefulReply} ${"private assistant detail ".repeat(24)} ${replyTail}`,
      toolOutput: `first private tool line ${toolOutputSentinel}\n`.repeat(40),
      toolCounts: { Bash: 1, Read: 1 },
    });
    session.path = absoluteSessionPath;
    session.cwd = absoluteCwd;
    session.rawJsonl = rawJsonlRecord;
    session.events[0].rawLine = rawJsonlRecord;
    session.events[1].rawLine = rawJsonlRecord;
    session.events[1].toolCalls[0].input = `npm run test:privacy -- --log ${absoluteCommandPath}`;
    session.events[1].toolCalls[1].input = `/tmp/${absPathSentinel}/workspace/tracequest/private/config.secret`;

    const md = buildStandupInput(
      [{
        session,
        discovery: {
          path: absoluteSessionPath,
          project: "-tmp-workspace-tracequest",
          source: "claude",
          mtime: new Date("2026-06-03T12:00:00.000Z"),
        },
      }],
      {
        generatedAt: "2026-06-04T00:00:00.000Z",
        limits: {
          maxPromptChars: 110,
          maxAssistantChars: 110,
          maxCommandChars: 120,
        },
      },
    );

    assert.match(md, /# TraceQuest Standup Request/);
    assert.match(md, /Omitted: raw JSONL/);
    assert.match(md, new RegExp(usefulPrompt));
    assert.match(md, new RegExp(usefulReply));
    assert.match(md, /Bash x1, Read x1/);
    assert.match(md, /Commands: \[ok\] npm run test:privacy -- --log \.\.\.\/secret-output\.log/);
    assert.match(md, /Files: private\/config\.secret \(Read\)/);
    assert.match(md, /\.\.\./);

    for (const privateNeedle of [
      rawJsonlSentinel,
      rawJsonlRecord,
      promptTail,
      replyTail,
      absPathSentinel,
      absoluteSessionPath,
      absoluteCwd,
      absoluteCommandPath,
      toolOutputSentinel,
      "\"type\":\"user\"",
      "\"sessionId\":\"privacy-direct\"",
    ]) {
      assert.ok(!md.includes(privateNeedle), `compact input leaked ${privateNeedle}`);
    }
  });

  test("standup compact input agent instructions constrain output to compact summaries", () => {
    const md = buildStandupInput(
      [{ session: sessionFixture("instructions") }],
      { generatedAt: "2026-06-04T00:00:00.000Z" },
    );

    assert.match(md, /## Prompt-Agent Instructions/);
    assert.match(md, /Use sections: Progress, Risks\/Blockers, and Next Steps/);
    assert.match(md, /Use only the compact summaries below/);
    assert.match(md, /snippets are capped signals, not complete transcripts/);
    assert.match(md, /Do not request, infer, or reconstruct raw JSONL, transcripts, full tool outputs, absolute paths, or omitted private details/);
    assert.ok(
      md.indexOf("## Prompt-Agent Instructions") < md.indexOf("## Data Policy"),
      "prompt-agent instructions should appear before the data policy and session summaries",
    );
  });

  test("caps session and chapter counts", () => {
    const sessions = [
      { session: sessionFixture("s1") },
      { session: sessionFixture("s2") },
      { session: sessionFixture("s3") },
    ];
    const md = buildStandupInput(sessions, {
      generatedAt: "2026-06-04T00:00:00.000Z",
      limits: { maxSessions: 2, maxChaptersPerSession: 1 },
    });

    assert.match(md, /Sessions selected: 2 of 3/);
    assert.match(md, /Sessions omitted by cap: 1/);
    assert.match(md, /Session s1/);
    assert.match(md, /Session s2/);
    assert.doesNotMatch(md, /Session s3/);
    assert.match(md, /Chapter cap per session: 1/);
  });
});
