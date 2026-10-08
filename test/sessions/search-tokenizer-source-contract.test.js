import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  indexClaudeJsonl,
  indexCodexJsonl,
  indexCursorJsonl,
  indexCursorCloudJsonl,
  indexFactoryJsonl,
  indexGrokJsonl,
} from "../../src/sessions/session-index-jsonl.js";
import { indexOpenCode } from "../../src/sessions/session-index-opencode.js";
import { loadDatabaseSync } from "../../src/sessions/session-discovery-paths.js";
import { mkTmp, writeJsonl } from "../helpers/fixtures.js";
import { seedOpenCodeIndexDb } from "../helpers/opencode-db-fixtures.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

function readSource(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf-8");
}

function expectTerms(meta, terms, label) {
  assert.ok(meta.termFreqs instanceof Map, `${label}: termFreqs must be a Map`);
  for (const term of terms) {
    assert.ok(meta.termFreqs.has(term), `${label}: expected term ${term}`);
  }
}

describe("search tokenizer source contracts", () => {
  test("query parsing and JS indexers share search-tokenizer.js (fact 85b)", () => {
    assert.match(
      readSource("src/sessions/scan-queries.js"),
      /import \{ tokenize \} from "\.\/search-tokenizer\.js";/,
      "query parsing must import tokenize from the shared tokenizer",
    );

    for (const relPath of [
      "src/sessions/session-meta.js",
      "src/sessions/session-peek.js",
      "src/sessions/session-index-opencode.js",
    ]) {
      assert.match(
        readSource(relPath),
        /import \{ accumulateTermFreqs, TOKENIZER_INPUT_CAP \} from "\.\/search-tokenizer\.js";/,
        `${relPath} must import the shared term-frequency tokenizer`,
      );
    }

    const duplicateTokenizerFiles = fs
      .readdirSync(path.join(ROOT, "src/sessions"))
      .filter((name) => name.endsWith(".js") && name !== "search-tokenizer.js")
      .filter((name) => {
        const src = readSource(`src/sessions/${name}`);
        return /\b(?:export\s+)?function\s+tokenize\b|\bfunction\s+splitTokens\b|\bconst\s+TOKENIZER_INPUT_CAP\s*=/.test(src);
      });

    assert.deepEqual(duplicateTokenizerFiles, []);
  });

  test("source indexers tokenize source content into per-session termFreqs (fact d7k)", async () => {
    const tmpDir = mkTmp("tq-search-tokenizer-source-");
    try {
      const claudePath = path.join(tmpDir, "claude.jsonl");
      writeJsonl(claudePath, [
        { type: "user", message: { content: [{ type: "text", text: "claudealpha user prompt" }] } },
        {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "claudebravo assistant text" },
              { type: "thinking", thinking: "claudecharlie private thinking" },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                content: [
                  {
                    type: "text",
                    text: "claudedelta tool result searchable output content with enough length",
                  },
                ],
              },
            ],
          },
        },
      ]);
      expectTerms(
        indexClaudeJsonl(claudePath),
        ["claudealpha", "claudebravo", "claudecharlie", "claudedelta"],
        "claude",
      );

      const cursorPath = path.join(tmpDir, "cursor.jsonl");
      writeJsonl(cursorPath, [
        { role: "user", message: { content: [{ type: "text", text: "cursoralpha user prompt" }] } },
        {
          role: "assistant",
          message: {
            content: [
              { type: "text", text: "cursorbravo assistant text" },
              { type: "thinking", thinking: "cursorcharlie private thinking" },
            ],
          },
        },
      ]);
      expectTerms(
        indexCursorJsonl(cursorPath),
        ["cursoralpha", "cursorbravo", "cursorcharlie"],
        "cursor",
      );

      const cursorCloudPath = path.join(tmpDir, "bc-source.jsonl");
      writeJsonl(cursorCloudPath, [
        {
          type: "session_meta",
          bcId: "bc-source",
          name: "cursorcloudmeta contract session",
          status: "FINISHED",
          createdAt: "2026-07-01T00:00:00Z",
        },
        { role: "user", message: { content: [{ type: "text", text: "cursorcloudalpha user prompt" }] } },
        {
          role: "assistant",
          message: {
            content: [
              { type: "text", text: "cursorcloudbravo assistant text" },
              { type: "thinking", thinking: "cursorcloudcharlie private thinking" },
            ],
          },
        },
      ]);
      expectTerms(
        indexCursorCloudJsonl(cursorCloudPath),
        ["cursorcloudalpha", "cursorcloudbravo", "cursorcloudcharlie"],
        "cursor-cloud",
      );

      const codexPath = path.join(tmpDir, "codex.jsonl");
      writeJsonl(codexPath, [
        { type: "event_msg", payload: { type: "user_message", message: "codexalpha user prompt" } },
        {
          type: "response_item",
          payload: {
            role: "assistant",
            content: [{ type: "output_text", text: "codexbravo assistant text" }],
          },
        },
      ]);
      expectTerms(indexCodexJsonl(codexPath), ["codexalpha", "codexbravo"], "codex");

      const factoryPath = path.join(tmpDir, "factory.jsonl");
      writeJsonl(factoryPath, [
        {
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "factoryalpha user prompt" }] },
        },
        {
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "factorybravo assistant text" }] },
        },
      ]);
      expectTerms(indexFactoryJsonl(factoryPath), ["factoryalpha", "factorybravo"], "factory");

      const grokDir = path.join(tmpDir, "grok-session");
      fs.mkdirSync(grokDir);
      writeJsonl(path.join(grokDir, "chat_history.jsonl"), [
        { type: "user", content: "grokalpha user prompt" },
        { type: "assistant", content: "grokbravo assistant text" },
        { type: "tool_result", content: "grokcharlie tool result searchable content with enough length" },
      ]);
      expectTerms(indexGrokJsonl(grokDir), ["grokalpha", "grokbravo", "grokcharlie"], "grok");

      const opencodeDbPath = await seedOpenCodeIndexDb(tmpDir, [
        {
          id: "oc-source",
          messages: [
            { role: "user", parts: [{ type: "text", text: "opencodealpha user prompt" }] },
            {
              role: "assistant",
              parts: [
                { type: "text", text: "opencodebravo assistant text" },
                { type: "reasoning", text: "opencodecharlie reasoning text" },
              ],
            },
          ],
        },
      ]);
      const db = new (loadDatabaseSync())(opencodeDbPath, { readOnly: true });
      try {
        expectTerms(
          indexOpenCode({ source: "opencode", file: "oc-source", title: "OC Source", path: "opencode://oc-source" }, db),
          ["opencodealpha", "opencodebravo", "opencodecharlie"],
          "opencode",
        );
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
