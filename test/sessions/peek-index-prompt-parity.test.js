/**
 * peek* and index*Jsonl must agree on firstPrompt for the same on-disk session data.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { peekClaude, peekFactory, peekGrok, peekOpenCode } from "../../src/sessions/session-peek.js";
import {
  indexClaudeJsonl,
  indexFactoryJsonl,
  indexGrokJsonl,
} from "../../src/sessions/session-index-jsonl.js";
import { indexOpenCode } from "../../src/sessions/session-index-opencode.js";
import { seedOpenCodeIndexDb } from "../helpers/opencode-db-fixtures.js";
import { mkTmp, writeJsonl } from "../helpers/fixtures.js";

/** Same shape as test/sidecar-parity.test.js MINIMAL_PARITY_LINES. */
const CLAUDE_PROMPT_PARITY_LINES = [
  {
    type: "user",
    message: { content: "parity probe prompt" },
    timestamp: "2026-06-03T10:00:00.000Z",
  },
  {
    type: "assistant",
    message: {
      model: "claude-3-sonnet",
      content: [
        { type: "tool_use", name: "bash", input: { command: "git commit -m parity" } },
        { type: "text", text: "assistant reply text" },
      ],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20 },
    },
    timestamp: "2026-06-03T10:01:00.000Z",
  },
];

function assertFirstPromptParity(filePath, label) {
  const size = fs.statSync(filePath).size;
  const peek = peekClaude(filePath, size).firstPrompt;
  const index = indexClaudeJsonl(filePath).firstPrompt;
  assert.equal(
    peek,
    index,
    `${label}: peekClaude firstPrompt must match indexClaudeJsonl (peek=${peek}, index=${index})`,
  );
}

describe("peekClaude × indexClaudeJsonl firstPrompt parity", () => {
  test("minimal Claude fixture", () => {
    const tmpDir = mkTmp("tq-peek-index-parity-");
    const filePath = path.join(tmpDir, "session.jsonl");
    writeJsonl(filePath, CLAUDE_PROMPT_PARITY_LINES);
    try {
      assertFirstPromptParity(filePath, "minimal");
      assert.equal(peekClaude(filePath, fs.statSync(filePath).size).firstPrompt, "parity probe prompt");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("skips meta and angle-bracket user lines like peek", () => {
    const tmpDir = mkTmp("tq-peek-index-parity-skip-");
    const filePath = path.join(tmpDir, "skip.jsonl");
    writeJsonl(filePath, [
      { type: "user", isMeta: true, message: { content: [{ type: "text", text: "Meta preamble" }] } },
      { type: "user", message: { content: [{ type: "text", text: "<system>hidden</system>" }] } },
      { type: "user", message: { content: [{ type: "text", text: "Real user question" }] } },
    ]);
    try {
      assertFirstPromptParity(filePath, "skip-meta-bracket");
      assert.equal(indexClaudeJsonl(filePath).firstPrompt, "Real user question");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("user line with nested type assistant content block", () => {
    const tmpDir = mkTmp("tq-peek-index-parity-nested-");
    const filePath = path.join(tmpDir, "nested.jsonl");
    writeJsonl(filePath, [
      {
        type: "user",
        message: {
          content: [
            { type: "assistant", text: "embedded assistant block" },
            { type: "text", text: "Real prompt" },
          ],
        },
      },
    ]);
    try {
      assertFirstPromptParity(filePath, "nested-assistant-block");
      assert.equal(peekClaude(filePath, fs.statSync(filePath).size).firstPrompt, "Real prompt");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("user_query tags via extractPrompt", () => {
    const tmpDir = mkTmp("tq-peek-index-parity-tags-");
    const filePath = path.join(tmpDir, "tags.jsonl");
    writeJsonl(filePath, [
      {
        type: "user",
        message: {
          content: [{ type: "text", text: "<user_query>\nPeek index parity\n</user_query>" }],
        },
      },
    ]);
    try {
      assertFirstPromptParity(filePath, "user_query");
      assert.equal(indexClaudeJsonl(filePath).firstPrompt, "Peek index parity");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

const FACTORY_PROMPT_PARITY_LINES = [
  {
    type: "message",
    message: { role: "user", content: [{ type: "text", text: "factory parity probe" }] },
  },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", name: "Read" },
        { type: "text", text: "factory assistant reply" },
      ],
    },
  },
];

function assertFactoryFirstPromptParity(filePath, label) {
  const size = fs.statSync(filePath).size;
  const peek = peekFactory(filePath, size).firstPrompt;
  const index = indexFactoryJsonl(filePath).firstPrompt;
  assert.equal(
    peek,
    index,
    `${label}: peekFactory firstPrompt must match indexFactoryJsonl (peek=${peek}, index=${index})`,
  );
}

describe("peekFactory × indexFactoryJsonl firstPrompt parity", () => {
  test("minimal factory fixture", () => {
    const tmpDir = mkTmp("tq-peek-index-factory-parity-");
    const filePath = path.join(tmpDir, "factory.jsonl");
    writeJsonl(filePath, FACTORY_PROMPT_PARITY_LINES);
    try {
      assertFactoryFirstPromptParity(filePath, "minimal");
      assert.equal(peekFactory(filePath, fs.statSync(filePath).size).firstPrompt, "factory parity probe");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("user message with nested type assistant content block", () => {
    const tmpDir = mkTmp("tq-peek-index-factory-nested-");
    const filePath = path.join(tmpDir, "nested.jsonl");
    writeJsonl(filePath, [
      {
        type: "message",
        message: {
          role: "user",
          content: [
            { type: "assistant", text: "embedded assistant block" },
            { type: "text", text: "Real factory prompt" },
          ],
        },
      },
    ]);
    try {
      assertFactoryFirstPromptParity(filePath, "nested-assistant-block");
      assert.equal(indexFactoryJsonl(filePath).firstPrompt, "Real factory prompt");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("skips angle-bracket user text like peek", () => {
    const tmpDir = mkTmp("tq-peek-index-factory-skip-");
    const filePath = path.join(tmpDir, "skip.jsonl");
    writeJsonl(filePath, [
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "<system>hidden</system>" }] },
      },
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "Visible factory question" }] },
      },
    ]);
    try {
      assertFactoryFirstPromptParity(filePath, "skip-angle-bracket");
      assert.equal(indexFactoryJsonl(filePath).firstPrompt, "Visible factory question");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

function assertGrokFirstPromptParity(sessionDir, label) {
  const peek = peekGrok(sessionDir).firstPrompt;
  const index = indexGrokJsonl(sessionDir).firstPrompt;
  assert.equal(
    peek,
    index,
    `${label}: peekGrok firstPrompt must match indexGrokJsonl (peek=${peek}, index=${index})`,
  );
}

describe("peekGrok × indexGrokJsonl firstPrompt parity", () => {
  test("minimal grok chat_history fixture", () => {
    const tmpDir = mkTmp("tq-peek-index-grok-parity-");
    const sessionDir = path.join(tmpDir, "sess-1");
    fs.mkdirSync(sessionDir, { recursive: true });
    writeJsonl(path.join(sessionDir, "chat_history.jsonl"), [
      { type: "user", content: "grok parity probe" },
      { type: "assistant", content: "grok assistant reply" },
    ]);
    try {
      assertGrokFirstPromptParity(sessionDir, "minimal");
      assert.equal(peekGrok(sessionDir).firstPrompt, "grok parity probe");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("user_query tags via extractPrompt", () => {
    const tmpDir = mkTmp("tq-peek-index-grok-tags-");
    const sessionDir = path.join(tmpDir, "tag-sess");
    fs.mkdirSync(sessionDir, { recursive: true });
    writeJsonl(path.join(sessionDir, "chat_history.jsonl"), [
      {
        type: "user",
        content: "<user_query>\nGrok peek index parity\n</user_query>",
      },
    ]);
    try {
      assertGrokFirstPromptParity(sessionDir, "user_query");
      assert.equal(indexGrokJsonl(sessionDir).firstPrompt, "Grok peek index parity");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("skips angle-bracket user content before first real prompt", () => {
    const tmpDir = mkTmp("tq-peek-index-grok-skip-");
    const sessionDir = path.join(tmpDir, "skip-sess");
    fs.mkdirSync(sessionDir, { recursive: true });
    writeJsonl(path.join(sessionDir, "chat_history.jsonl"), [
      { type: "user", content: "<system>hidden grok preamble</system>" },
      { type: "user", content: "Real grok question" },
    ]);
    try {
      assertGrokFirstPromptParity(sessionDir, "skip-angle-bracket");
      assert.equal(indexGrokJsonl(sessionDir).firstPrompt, "Real grok question");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

function withOpenCodeParityHome(fn) {
  const tmpDir = mkTmp("tq-peek-index-oc-parity-");
  const originalHome = process.env.HOME;
  process.env.HOME = tmpDir;
  return (async () => {
    try {
      return await fn(tmpDir);
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  })();
}

function opencodeSessionRow(id, title = id) {
  return {
    source: "opencode",
    file: id,
    title,
    path: `opencode://${id}`,
  };
}

function assertOpenCodeFirstPromptParity(session, label) {
  const peek = peekOpenCode(session).firstPrompt;
  const index = indexOpenCode(session).firstPrompt;
  assert.equal(
    peek,
    index,
    `${label}: peekOpenCode firstPrompt must match indexOpenCode (peek=${peek}, index=${index})`,
  );
}

describe("peekOpenCode × indexOpenCode firstPrompt parity", () => {
  test("minimal opencode SQLite fixture", async () =>
    withOpenCodeParityHome(async (home) => {
      await seedOpenCodeIndexDb(
        home,
        [
        {
          id: "oc-parity-1",
          messages: [
            { role: "user", modelID: "gpt-4o", parts: [{ type: "text", text: "opencode parity probe" }] },
            {
              role: "assistant",
              modelID: "gpt-4o-mini",
              parts: [
                { type: "tool", tool: "bash" },
                { type: "text", text: "opencode assistant reply" },
              ],
            },
          ],
        },
      ],
        { includeSessionTable: false },
      );
      const session = opencodeSessionRow("oc-parity-1", "OpenCode Parity Title");
      assertOpenCodeFirstPromptParity(session, "minimal");
      assert.equal(peekOpenCode(session).firstPrompt, "opencode parity probe");
    }));

  test("skips angle-bracket user text before first real prompt", async () =>
    withOpenCodeParityHome(async (home) => {
      await seedOpenCodeIndexDb(
        home,
        [
        {
          id: "oc-skip",
          messages: [
            { role: "user", parts: [{ type: "text", text: "<system>hidden opencode preamble</system>" }] },
            { role: "user", parts: [{ type: "text", text: "Real opencode question" }] },
          ],
        },
      ],
        { includeSessionTable: false },
      );
      const session = opencodeSessionRow("oc-skip");
      assertOpenCodeFirstPromptParity(session, "skip-angle-bracket");
      assert.equal(indexOpenCode(session).firstPrompt, "Real opencode question");
    }));

  test("title fallback when user messages have no text parts", async () =>
    withOpenCodeParityHome(async (home) => {
      await seedOpenCodeIndexDb(
        home,
        [
        {
          id: "oc-title",
          messages: [{ role: "user", parts: [{ type: "tool", tool: "Read" }] }],
        },
      ],
        { includeSessionTable: false },
      );
      const session = opencodeSessionRow("oc-title", "Title Becomes First Prompt");
      assertOpenCodeFirstPromptParity(session, "title-fallback");
      assert.equal(peekOpenCode(session).firstPrompt, "Title Becomes First Prompt");
    }));
});