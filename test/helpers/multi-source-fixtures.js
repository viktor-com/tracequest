import fs from "node:fs";
import path from "node:path";
import { claudeProj, writeJsonl } from "./fixtures.js";
export { seedOpenCodeSearchSession as seedOpenCodeDb } from "./opencode-db-fixtures.js";

export const FIXED_NOW = Date.parse("2026-06-03T12:00:00Z");
export const SHARED_QUERY = "msrc-shared-needle";
/** Marker shared across all seven agent sources in multi-source search tests. */
export const SIX_WAY_MARKER = "multi-src-six-way-marker";
export const FIVE_WAY_MARKER = SIX_WAY_MARKER;
export const SEVEN_WAY_MARKER = SIX_WAY_MARKER;
/** BM25 ranking needle — dense Claude vs sparse OpenCode in one HOME. */
export const BM25_RANK_NEEDLE = "multi-src-bm25-rank-needle";
export const FACTORY_DISK_ONLY = "msrc-factory-disk-cmd-42";
export const GROK_DISK_ONLY = "msrc-grok-disk-phrase-99";
/** Post-edit disk-fallback needles (not present in baseline seed). */
export const FACTORY_POST_EDIT_DISK = "df-inv-factory-post-edit-cmd-77";
export const GROK_POST_EDIT_DISK = "df-inv-grok-post-edit-phrase-88";

function claudeRows({ prompt, bodyPhrase, withBash = false, withError = false }) {
  const phrase = bodyPhrase || prompt;
  const rows = [
    { type: "user", message: { content: [{ type: "text", text: prompt }] } },
    { type: "user", message: { content: [{ type: "text", text: "follow-up turn" }] } },
  ];
  const assistantBits = [{ type: "text", text: `${phrase} ${SHARED_QUERY}` }];
  if (withBash) {
    assistantBits.push({
      type: "tool_use",
      name: "Bash",
      input: { command: `grep ${SHARED_QUERY} src/` },
    });
  }
  rows.push({
    type: "assistant",
    message: {
      model: "claude-sonnet-4-20250514",
      content: assistantBits,
      usage: { input_tokens: 40, output_tokens: 12 },
    },
    timestamp: "2026-06-03T10:00:00Z",
  });
  if (withError) {
    rows.push({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            content: [{ type: "text", text: "Error: command failed with exit code 2" }],
            is_error: true,
          },
        ],
      },
    });
  }
  return rows;
}

/** Real Cursor JSONL rows: {"role":...} messages plus a turn_ended status row. */
function cursorRows({ prompt, bodyPhrase, withError = false }) {
  const phrase = bodyPhrase || prompt;
  const rows = [
    { role: "user", message: { content: [{ type: "text", text: prompt }] } },
    { role: "user", message: { content: [{ type: "text", text: "follow-up turn" }] } },
    {
      role: "assistant",
      message: {
        content: [
          { type: "text", text: `${phrase} ${SHARED_QUERY}` },
          { type: "tool_use", name: "Read", input: { path: "/home/dev/msrc-cursor/README.md" } },
        ],
      },
    },
    { type: "turn_ended", status: withError ? "error" : "success" },
  ];
  return rows;
}

/** Cursor discovery layout: .cursor/projects/<proj>/agent-transcripts/<uuid>/<uuid>.jsonl */
export function cursorSessionPath(home, project, uuid) {
  return path.join(home, ".cursor", "projects", project, "agent-transcripts", uuid, `${uuid}.jsonl`);
}

/** Cursor-cloud import layout: .local/share/tracequest/cursor-cloud/<slug>/<agentId>.jsonl */
export function cursorCloudSessionPath(home, slug, agentId) {
  return path.join(home, ".local", "share", "tracequest", "cursor-cloud", slug, `${agentId}.jsonl`);
}

/** Imported cursor-cloud file: session_meta first line + Cursor-shaped message rows. */
function cursorCloudRows({ prompt, bodyPhrase, name = "Cloud fixture run", model = "gpt-5-cursor" }) {
  const phrase = bodyPhrase || prompt;
  return [
    {
      type: "session_meta",
      bcId: "bc-msrc-fixture",
      name,
      status: "FINISHED",
      createdAt: "2026-06-03T09:00:00.000Z",
      updatedAt: "2026-06-03T10:00:00.000Z",
      repository: "https://github.com/msrc/cloud",
      model,
    },
    { role: "user", message: { content: [{ type: "text", text: prompt }] } },
    {
      role: "assistant",
      message: { content: [{ type: "text", text: `${phrase} ${SHARED_QUERY}` }] },
    },
    { type: "turn_ended", status: "success" },
  ];
}

export function factoryRows({ prompt, bodyPhrase, withBash = false, withError = false, diskOnlyCmd = null }) {
  const phrase = bodyPhrase || prompt;
  const rows = [
    {
      type: "message",
      message: { role: "user", content: [{ type: "text", text: prompt }] },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: `${phrase} ${SHARED_QUERY}` },
          ...(withBash
            ? [
                {
                  type: "tool_use",
                  name: "Bash",
                  input: { command: `npm run ${SHARED_QUERY}` },
                },
              ]
            : []),
          ...(diskOnlyCmd
            ? [
                {
                  type: "tool_use",
                  name: "Bash",
                  input: { command: diskOnlyCmd },
                },
              ]
            : []),
        ],
      },
    },
  ];
  if (withError) {
    rows.push({
      type: "message",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "factory-err-1",
            content: [{ type: "text", text: "Error: factory deploy failed" }],
            is_error: true,
          },
        ],
      },
    });
  }
  return rows;
}

export function grokChatLines({ prompt, bodyPhrase, diskOnlyPhrase = null }) {
  const phrase = bodyPhrase || prompt;
  const lines = [
    { type: "user", content: prompt },
    {
      type: "assistant",
      content: `${phrase} ${SHARED_QUERY}`,
      tool_calls: [{ name: "bash", arguments: JSON.stringify({ command: `echo ${SHARED_QUERY}` }) }],
    },
  ];
  if (diskOnlyPhrase) {
    lines.push({ type: "user", content: diskOnlyPhrase });
  }
  return lines;
}

/**
 * Write Claude-family, Codex, Factory, and Grok session files under tmpDir (temp HOME).
 * Returns absolute paths used by search assertions.
 */
export function seedMultiSourceFixture(tmpDir) {
  const alphaDir = claudeProj(tmpDir, "msrc-alpha");
  const alphaPath = path.join(alphaDir, "alpha.jsonl");
  writeJsonl(
    alphaPath,
    claudeRows({
      prompt: "alpha deploy-marker prompt",
      bodyPhrase: "alpha indexed body",
      withBash: true,
    })
  );

  const cursorPath = cursorSessionPath(tmpDir, "msrc-cursor", "msrc-cursor-uuid-1");
  writeJsonl(
    cursorPath,
    cursorRows({
      prompt: "cursor indexed prompt",
      bodyPhrase: "cursor indexed body",
    })
  );

  const cursorCloudPath = cursorCloudSessionPath(tmpDir, "msrc-cloud", "bc-msrc-fixture");
  writeJsonl(
    cursorCloudPath,
    cursorCloudRows({
      prompt: "cursor-cloud indexed prompt",
      bodyPhrase: "cursor-cloud indexed body",
    })
  );

  const codexDir = path.join(tmpDir, ".codex", "sessions", "2026", "06", "03");
  fs.mkdirSync(codexDir, { recursive: true });
  const codexPath = path.join(codexDir, "rollout-msrc.jsonl");
  writeJsonl(codexPath, [
    {
      type: "session_meta",
      payload: { cwd: "/home/dev/msrc-codex-proj", model_provider: "openai" },
    },
    // Real codex dialect: the FIRST user response_item is the injected
    // instruction context (AGENTS.md markdown + XML-wrapped blocks), never
    // the user's prompt — extraction must skip it (r8 dialect-drift fix).
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "# AGENTS.md instructions for /home/dev/msrc-codex-proj\n\n<INSTRUCTIONS>injected, not user speech</INSTRUCTIONS>" },
          { type: "input_text", text: "<environment_context>\n  <cwd>/home/dev/msrc-codex-proj</cwd>\n</environment_context>" },
        ],
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "user_message",
        message: `codex side ${SHARED_QUERY}`,
      },
    },
    { type: "turn_context", payload: { model: "gpt-5-codex" } },
  ]);

  const factoryWs = path.join(tmpDir, ".factory", "sessions", "ws-home-dev-code-msrc-factory");
  fs.mkdirSync(factoryWs, { recursive: true });
  const factoryPath = path.join(factoryWs, "run.jsonl");
  writeJsonl(
    factoryPath,
    factoryRows({
      prompt: "factory indexed prompt",
      bodyPhrase: "factory indexed body",
      withBash: true,
      diskOnlyCmd: `npm run ${FACTORY_DISK_ONLY}`,
    })
  );
  const factoryErrPath = path.join(factoryWs, "err.jsonl");
  writeJsonl(
    factoryErrPath,
    factoryRows({
      prompt: "factory error prompt",
      bodyPhrase: "factory error body",
      withError: true,
    })
  );

  const grokWs = path.join(tmpDir, ".grok", "sessions", "ws-msrc-grok");
  const grokSessDir = path.join(grokWs, "grok-sess-1");
  fs.mkdirSync(grokSessDir, { recursive: true });
  writeJsonl(
    path.join(grokSessDir, "chat_history.jsonl"),
    grokChatLines({
      prompt: "grok indexed prompt",
      bodyPhrase: "grok indexed body",
      diskOnlyPhrase: GROK_DISK_ONLY,
    })
  );
  writeJsonl(path.join(grokSessDir, "events.jsonl"), [
    { type: "turn_started", ts: "2026-06-03T10:00:00Z", model_id: "grok-3" },
  ]);

  const recent = new Date(FIXED_NOW - 2 * 3600000);
  for (const p of [alphaPath, cursorPath, cursorCloudPath, codexPath, factoryPath, factoryErrPath, path.join(grokSessDir, "chat_history.jsonl")]) {
    fs.utimesSync(p, recent, recent);
  }

  return {
    alphaPath,
    cursorPath,
    cursorCloudPath,
    codexPath,
    factoryPath,
    factoryErrPath,
    grokSessDir,
    factoryProject: "msrc-factory",
  };
}

const OC_SIX_WAY_ID = "ses_multiSrcSixWaySession01";
const OC_SIX_WAY_URI = `opencode://${OC_SIX_WAY_ID}`;

function claudeFamilySixWayRows(marker, source) {
  const ts = "2026-06-03T12:00:00.000Z";
  return [
    {
      type: "user",
      sessionId: `multi-six-${source}`,
      cwd: `/home/dev/multi-six-${source}`,
      timestamp: ts,
      uuid: `u-six-${source}`,
      isMeta: false,
      message: { content: [{ type: "text", text: `${source} six-way ${marker}` }] },
    },
    {
      type: "assistant",
      sessionId: `multi-six-${source}`,
      timestamp: ts,
      uuid: `a-six-${source}`,
      message: {
        model: "claude-sonnet-4-20250514",
        content: [{ type: "text", text: `six-way ${source} assistant reply` }],
      },
    },
    {
      type: "user",
      sessionId: `multi-six-${source}`,
      timestamp: ts,
      uuid: `u2-six-${source}`,
      isMeta: false,
      message: { content: [{ type: "text", text: "third turn for discovery msg-count threshold" }] },
    },
  ];
}

/**
 * Seed Claude, Cursor, Cursor-cloud, OpenCode, Codex, Factory, and Grok under one HOME
 * with a shared search marker.
 * @param {string} home
 * @param {string} [marker]
 */
export async function seedSevenSourceSearchHome(home, marker = SEVEN_WAY_MARKER) {
  const claudeDir = claudeProj(home, "multi-six-claude");
  const claudePath = path.join(claudeDir, "six-way-claude.jsonl");
  writeJsonl(claudePath, claudeFamilySixWayRows(marker, "claude"));

  const cursorPath = cursorSessionPath(home, "multi-six-cursor", "six-way-cursor");
  writeJsonl(cursorPath, [
    { role: "user", message: { content: [{ type: "text", text: `cursor six-way ${marker}` }] } },
    { role: "assistant", message: { content: [{ type: "text", text: "six-way cursor assistant reply" }] } },
    { role: "user", message: { content: [{ type: "text", text: "third turn for discovery msg-count threshold" }] } },
    { type: "turn_ended", status: "success" },
  ]);

  const cursorCloudPath = cursorCloudSessionPath(home, "multi-seven-cloud", "bc-seven-way");
  writeJsonl(cursorCloudPath, [
    {
      type: "session_meta",
      bcId: "bc-seven-way",
      name: "Seven-way cloud run",
      status: "FINISHED",
      createdAt: "2026-06-03T11:00:00.000Z",
      updatedAt: "2026-06-03T12:00:00.000Z",
      repository: "https://github.com/multi/seven-cloud",
      model: "gpt-5-cursor",
    },
    { role: "user", message: { content: [{ type: "text", text: `cursor-cloud seven-way ${marker}` }] } },
    { role: "assistant", message: { content: [{ type: "text", text: "seven-way cursor-cloud assistant reply" }] } },
    { role: "user", message: { content: [{ type: "text", text: "third turn for discovery msg-count threshold" }] } },
    { type: "turn_ended", status: "success" },
  ]);

  const { seedOpenCodeIndexDb } = await import("./opencode-db-fixtures.js");
  await seedOpenCodeIndexDb(home, [
    {
      id: OC_SIX_WAY_ID,
      title: "Six-Way OpenCode",
      directory: "/home/dev/multi-six-oc",
      messages: [
        { role: "user", parts: [{ type: "text", text: `opencode six-way ${marker}` }] },
        {
          role: "assistant",
          modelID: "gpt-4o",
          parts: [{ type: "text", text: "six-way opencode assistant reply" }],
        },
        { role: "user", parts: [{ type: "text", text: "third turn for discovery msg-count threshold" }] },
      ],
    },
  ]);

  const codexDir = path.join(home, ".codex", "sessions", "2026", "06", "03");
  fs.mkdirSync(codexDir, { recursive: true });
  const codexPath = path.join(codexDir, "rollout-six-way.jsonl");
  writeJsonl(codexPath, [
    { type: "session_meta", payload: { cwd: "/home/dev/multi-six-codex", model_provider: "openai" } },
    { type: "event_msg", payload: { type: "user_message", message: `codex six-way ${marker}` } },
    {
      type: "response_item",
      payload: {
        role: "assistant",
        content: [{ type: "output_text", text: "six-way codex assistant reply" }],
      },
    },
  ]);

  const factoryWs = path.join(home, ".factory", "sessions", "ws-home-dev-code-multi-six-factory");
  fs.mkdirSync(factoryWs, { recursive: true });
  const factoryPath = path.join(factoryWs, "six-way.jsonl");
  writeJsonl(factoryPath, [
    {
      type: "message",
      message: { role: "user", content: [{ type: "text", text: `factory six-way ${marker}` }] },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "six-way factory assistant reply" }],
      },
    },
  ]);

  const grokWs = path.join(home, ".grok", "sessions", "ws-multi-six-grok");
  const grokSessDir = path.join(grokWs, "grok-six-way");
  fs.mkdirSync(grokSessDir, { recursive: true });
  writeJsonl(path.join(grokSessDir, "chat_history.jsonl"), [
    { type: "user", content: `grok six-way ${marker}` },
    { type: "assistant", content: "six-way grok assistant reply" },
  ]);
  writeJsonl(path.join(grokSessDir, "events.jsonl"), [
    { type: "turn_started", ts: "2026-06-03T12:00:00.000Z", model_id: "grok-3" },
  ]);

  return {
    claudePath,
    cursorPath,
    cursorCloudPath,
    ocUri: OC_SIX_WAY_URI,
    codexPath,
    factoryPath,
    grokSessDir,
    marker,
  };
}

export async function seedSixSourceSearchHome(home, marker = SEVEN_WAY_MARKER) {
  return seedSevenSourceSearchHome(home, marker);
}

export async function seedFiveSourceSearchHome(home, marker = SIX_WAY_MARKER) {
  return seedSevenSourceSearchHome(home, marker);
}

const OC_BM25_SPARSE_ID = "ses_multiSrcBm25Sparse01";
const OC_BM25_SPARSE_URI = `opencode://${OC_BM25_SPARSE_ID}`;

/**
 * Seed dense Claude (many needle occurrences) + sparse OpenCode (one occurrence) in one HOME.
 * @param {string} home
 * @param {string} [needle]
 */
export async function seedBm25RankMultiSourceHome(home, needle = BM25_RANK_NEEDLE) {
  const denseDir = claudeProj(home, "multi-bm25-rank");
  const densePath = path.join(denseDir, "dense-claude.jsonl");
  const densePrompt = `${needle} ${needle} ${needle} dense claude session`;
  const denseAssistant = `${needle} ${needle} ${needle} dense claude reply`;
  writeJsonl(
      densePath,
    claudeFamilySixWayRows(needle, "claude").map((row, i) => {
      if (i === 0) {
        return {
          ...row,
          message: { content: [{ type: "text", text: densePrompt }] },
        };
      }
      if (i === 1) {
        return {
          ...row,
          message: {
            ...row.message,
            content: [{ type: "text", text: denseAssistant }],
          },
        };
      }
      return row;
    }),
  );

  const { seedOpenCodeIndexDb } = await import("./opencode-db-fixtures.js");
  await seedOpenCodeIndexDb(home, [
    {
      id: OC_BM25_SPARSE_ID,
      title: "BM25 Sparse OpenCode",
      directory: "/home/dev/multi-bm25-sparse-oc",
      messages: [
        { role: "user", parts: [{ type: "text", text: `only one ${needle} in opencode sparse` }] },
        {
          role: "assistant",
          modelID: "gpt-4o",
          parts: [{ type: "text", text: "sparse opencode reply without extra terms" }],
        },
        { role: "user", parts: [{ type: "text", text: "third turn for discovery msg-count threshold" }] },
      ],
    },
  ]);

  return { densePath, sparseOcUri: OC_BM25_SPARSE_URI, needle };
}
