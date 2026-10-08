import fs from "node:fs";
import path from "node:path";
import { openOpenCodeDb, execOpenCodeIndexSchema } from "./opencode-db-fixtures.js";
import { writeJsonl } from "./fixtures.js";

/** Default turn count for large-session export/share integration tests. */
export const LARGE_SESSION_TURN_COUNT = 120;

/**
 * Turn count for HF preupload integration: rendered HTML must exceed HF_PREUPLOAD_THRESHOLD (1 MiB).
 * Each turn includes 2 KiB thinking blocks plus max-length user/assistant text (~3 KiB/event JSON).
 */
export const PREUPLOAD_SESSION_TURN_COUNT = 260;

/**
 * Build a single Claude JSONL session with many alternating user/assistant turns.
 * Used to stress render, serve export, and share pipelines without OOM.
 */
export function makeLargeClaudeTurnSessionLines(sessionId, opts = {}) {
  const {
    turnCount = LARGE_SESSION_TURN_COUNT,
    markerPrefix = "large-sess",
    cwd = "/home/dev/tracequest",
    model = "claude-sonnet-4-20250514",
    t0 = "2026-06-01T12:00:00.000Z",
  } = opts;
  const marker = `${markerPrefix}-turn`;
  const lines = [];
  const baseMs = Date.parse(t0);

  for (let i = 0; i < turnCount; i++) {
    const ts = new Date(baseMs + i * 1000).toISOString();
    lines.push({
      type: "user",
      sessionId,
      cwd,
      timestamp: ts,
      uuid: `u-${sessionId}-${i}`,
      isMeta: false,
      message: { content: [{ type: "text", text: `${marker} ${i} user prompt` }] },
    });
    lines.push({
      type: "assistant",
      sessionId,
      timestamp: ts,
      uuid: `a-${sessionId}-${i}`,
      message: {
        model,
        content: [{ type: "text", text: `${marker} ${i} assistant reply` }],
        usage: { input_tokens: 50, output_tokens: 25 },
      },
    });
  }

  return { lines, marker, turnCount };
}

/**
 * Build a Claude JSONL session sized to produce rendered HTML above HF preupload threshold.
 * Uses thinking blocks (2 KiB each, preserved in SESSION JSON) plus max-length turn text.
 */
export function makePreuploadClaudeSessionLines(sessionId, opts = {}) {
  const {
    turnCount = PREUPLOAD_SESSION_TURN_COUNT,
    markerPrefix = "preupload-sess",
    cwd = "/home/dev/tracequest",
    model = "claude-sonnet-4-20250514",
    t0 = "2026-06-01T12:00:00.000Z",
  } = opts;
  const marker = `${markerPrefix}-turn`;
  const lines = [];
  const baseMs = Date.parse(t0);
  const thinkingPad = "t".repeat(2000);
  const userPad = "u".repeat(500);
  const assistantPad = "a".repeat(500);

  for (let i = 0; i < turnCount; i++) {
    const ts = new Date(baseMs + i * 1000).toISOString();
    lines.push({
      type: "user",
      sessionId,
      cwd,
      timestamp: ts,
      uuid: `u-${sessionId}-${i}`,
      isMeta: false,
      message: { content: [{ type: "text", text: `${marker} ${i} ${userPad}` }] },
    });
    lines.push({
      type: "assistant",
      sessionId,
      timestamp: ts,
      uuid: `a-${sessionId}-${i}`,
      message: {
        model,
        content: [
          { type: "thinking", thinking: thinkingPad },
          { type: "text", text: `${marker} ${i} ${assistantPad}` },
        ],
        usage: { input_tokens: 50, output_tokens: 25 },
      },
    });
  }

  return { lines, marker, turnCount };
}

/**
 * Build realistic Claude JSONL lines for one synthetic session.
 * Includes progress/system filler, user prompts, assistant replies, and tool calls.
 * tool_use objects keep "type" before "name" so Rust TOOL_USE_NAME_RE can extract tools.
 */
export function makeClaudeSessionLines(sessionIndex, opts = {}) {
  const {
    fillerLines = 40,
    withError = false,
    markerPrefix = "perfneedle",
  } = opts;
  const marker = `${markerPrefix}-sess-${sessionIndex}`;
  const lines = [];

  for (let i = 0; i < fillerLines; i++) {
    lines.push({ type: "progress", data: "x".repeat(120) });
  }

  lines.push({
    type: "user",
    message: { content: [{ type: "text", text: `Deploy ${marker} to staging` }] },
  });

  lines.push({
    type: "assistant",
    message: {
      model: "claude-3-opus",
      content: [
        {
          type: "tool_use",
          name: "bash",
          input: { command: `npm run deploy-${sessionIndex}` },
        },
        { type: "text", text: `Running deploy for ${marker}` },
      ],
      usage: { input_tokens: 100, output_tokens: 50 },
    },
    timestamp: "2026-05-01T00:01:00Z",
  });

  const stderr = withError ? "Error: deployment failed exit code 1" : null;
  lines.push({
    type: "tool_result",
    tool_use_id: `toolu-${sessionIndex}`,
    content: [{ type: "text", text: withError ? stderr : "ok" }],
    ...(stderr ? { stderr, is_error: true } : {}),
  });

  for (let i = 0; i < 10; i++) {
    lines.push({ type: "system", subtype: "init", data: "y".repeat(80) });
  }

  lines.push({
    type: "user",
    message: { content: [{ type: "text", text: `Verify ${marker} health check` }] },
  });

  lines.push({
    type: "assistant",
    message: {
      content: [{ type: "text", text: `Health OK for ${marker}` }],
    },
  });

  return { lines, marker, withError };
}

/**
 * Write sessionCount synthetic Claude JSONL files under projDir.
 * Returns session descriptors and per-path marker metadata for search assertions.
 */
export function writeSyntheticClaudeSessions(projDir, opts = {}) {
  const {
    sessionCount = 120,
    fillerLines = 40,
    markerPrefix = "perfneedle",
  } = opts;

  fs.mkdirSync(projDir, { recursive: true });
  const project = path.basename(projDir);
  const sessions = Array.from({ length: sessionCount });
  const markerByPath = new Map();
  const baseMtime = Date.parse("2026-06-01T12:00:00Z");

  for (let i = 0; i < sessionCount; i++) {
    const fileName = `session-${i}.jsonl`;
    const filePath = path.join(projDir, fileName);
    const withError = i % 7 === 0;
    const { lines, marker } = makeClaudeSessionLines(i, { fillerLines, withError, markerPrefix });
    const body = lines.map((row) => JSON.stringify(row)).join("\n") + "\n";
    fs.writeFileSync(filePath, body);
    const stat = fs.statSync(filePath);
    sessions[i] = {
      path: filePath,
      source: "claude",
      project,
      file: fileName,
      mtime: new Date(baseMtime + i * 1000),
      size: stat.size,
    };
    markerByPath.set(filePath, { marker, withError });
  }

  return { sessions, markerByPath, project };
}

/**
 * Build realistic Factory JSONL lines for one synthetic session.
 * Uses message rows (indexed) plus heartbeat filler (skipped by index/scan).
 */
export function makeFactorySessionLines(sessionIndex, opts = {}) {
  const {
    fillerLines = 12,
    withError = false,
    markerPrefix = "factoryperf",
    diskOnlyCmd = null,
  } = opts;
  const marker = `${markerPrefix}-sess-${sessionIndex}`;
  const lines = [];

  for (let i = 0; i < fillerLines; i++) {
    lines.push({ type: "heartbeat", ts: `2026-05-01T00:00:${String(i).padStart(2, "0")}Z` });
  }

  lines.push({
    type: "message",
    message: { role: "user", content: [{ type: "text", text: `Deploy ${marker} to staging` }] },
  });

  const assistantBits = [
    { type: "text", text: `Running deploy for ${marker}` },
    {
      type: "tool_use",
      name: "Bash",
      input: { command: `npm run deploy-${sessionIndex}` },
    },
  ];
  if (diskOnlyCmd) {
    assistantBits.push({
      type: "tool_use",
      name: "Bash",
      input: { command: diskOnlyCmd },
    });
  }

  lines.push({
    type: "message",
    message: {
      role: "assistant",
      content: assistantBits,
    },
  });

  if (withError) {
    lines.push({
      type: "message",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: `factory-err-${sessionIndex}`,
            content: [{ type: "text", text: "Error: factory deployment failed exit code 1" }],
            is_error: true,
          },
        ],
      },
    });
  }

  for (let i = 0; i < 6; i++) {
    lines.push({ type: "heartbeat", ts: `2026-05-01T00:01:${String(i).padStart(2, "0")}Z` });
  }

  lines.push({
    type: "message",
    message: { role: "user", content: [{ type: "text", text: `Verify ${marker} health check` }] },
  });

  lines.push({
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: `Health OK for ${marker}` }],
    },
  });

  return { lines, marker, withError, diskOnlyCmd };
}

/**
 * Write sessionCount synthetic Factory JSONL files under tmpDir.
 * Layout mirrors ~/.factory/sessions/ws-home-dev-code-<project>/.
 */
export function writeSyntheticFactorySessions(tmpDir, opts = {}) {
  const {
    sessionCount = 120,
    fillerLines = 12,
    markerPrefix = "factoryperf",
    project = "perf-factory",
    workspaceSlug = `ws-home-dev-code-${project}`,
  } = opts;

  const wsDir = path.join(tmpDir, ".factory", "sessions", workspaceSlug);
  fs.mkdirSync(wsDir, { recursive: true });
  const sessions = Array.from({ length: sessionCount });
  const markerByPath = new Map();
  const baseMtime = Date.parse("2026-06-01T12:00:00Z");

  for (let i = 0; i < sessionCount; i++) {
    const fileName = `session-${i}.jsonl`;
    const filePath = path.join(wsDir, fileName);
    const withError = i % 7 === 0;
    const diskOnlyCmd = i === 5 ? `${markerPrefix}-deploy-cmd-5` : null;
    const { lines, marker } = makeFactorySessionLines(i, {
      fillerLines,
      withError,
      markerPrefix,
      diskOnlyCmd,
    });
    const body = lines.map((row) => JSON.stringify(row)).join("\n") + "\n";
    fs.writeFileSync(filePath, body);
    const stat = fs.statSync(filePath);
    sessions[i] = {
      path: filePath,
      source: "factory",
      project,
      file: fileName,
      mtime: new Date(baseMtime + i * 1000),
      size: stat.size,
    };
    markerByPath.set(filePath, { marker, withError, diskOnlyCmd });
  }

  return { sessions, markerByPath, project, wsDir };
}

/**
 * Build Grok chat_history + events lines for one synthetic session directory.
 */
export function makeGrokSessionFiles(sessionIndex, opts = {}) {
  const {
    fillerLines = 12,
    withError = false,
    markerPrefix = "grokperf",
    diskOnlyPhrase = null,
  } = opts;
  const marker = `${markerPrefix}-sess-${sessionIndex}`;
  const chatLines = [];

  for (let i = 0; i < fillerLines; i++) {
    chatLines.push({ type: "system", content: "x".repeat(120) });
  }

  chatLines.push({ type: "user", content: `Deploy ${marker} to staging` });
  chatLines.push({
    type: "assistant",
    content: `Running deploy for ${marker}`,
    tool_calls: [
      {
        name: "bash",
        arguments: JSON.stringify({ command: `npm run deploy-${sessionIndex}` }),
      },
    ],
  });

  if (diskOnlyPhrase) {
    chatLines.push({ type: "user", content: diskOnlyPhrase });
  }

  chatLines.push({ type: "user", content: `Verify ${marker} health check` });
  chatLines.push({ type: "assistant", content: `Health OK for ${marker}` });

  const eventLines = [
    { type: "turn_started", ts: "2026-05-01T00:01:00Z", model_id: "grok-3" },
    { type: "tool_started", ts: "2026-05-01T00:01:01Z", tool_name: "bash" },
  ];
  if (withError) {
    eventLines.push({
      type: "tool_completed",
      ts: "2026-05-01T00:01:02Z",
      outcome: "error",
    });
  }
  for (let i = 0; i < fillerLines; i++) {
    eventLines.push({ type: "stream_chunk", data: "y".repeat(80) });
  }

  return { chatLines, eventLines, marker, withError, diskOnlyPhrase };
}

/**
 * Write sessionCount synthetic Grok session dirs under tmpDir.
 * Each dir contains chat_history.jsonl and events.jsonl.
 */
export function writeSyntheticGrokSessions(tmpDir, opts = {}) {
  const {
    sessionCount = 120,
    fillerLines = 12,
    markerPrefix = "grokperf",
    project = "perf-grok",
    workspaceSlug = `ws-${project}`,
  } = opts;

  const wsDir = path.join(tmpDir, ".grok", "sessions", workspaceSlug);
  fs.mkdirSync(wsDir, { recursive: true });
  const sessions = Array.from({ length: sessionCount });
  const markerByPath = new Map();
  const baseMtime = Date.parse("2026-06-01T12:00:00Z");

  for (let i = 0; i < sessionCount; i++) {
    const sessName = `session-${i}`;
    const sessDir = path.join(wsDir, sessName);
    fs.mkdirSync(sessDir, { recursive: true });
    const withError = i % 7 === 0;
    const diskOnlyPhrase = i === 5 ? `${markerPrefix}-disk-phrase-5` : null;
    const { chatLines, eventLines, marker } = makeGrokSessionFiles(i, {
      fillerLines,
      withError,
      markerPrefix,
      diskOnlyPhrase,
    });
    const chatPath = path.join(sessDir, "chat_history.jsonl");
    const eventsPath = path.join(sessDir, "events.jsonl");
    writeJsonl(chatPath, chatLines);
    writeJsonl(eventsPath, eventLines);
    const stat = fs.statSync(chatPath);
    sessions[i] = {
      path: sessDir,
      source: "grok",
      project,
      file: sessName,
      mtime: new Date(baseMtime + i * 1000),
      size: stat.size,
    };
    markerByPath.set(sessDir, { marker, withError, diskOnlyPhrase });
  }

  return { sessions, markerByPath, project, wsDir };
}

/**
 * Build realistic Codex rollout JSONL lines for one synthetic session.
 * Uses stream_chunk filler (skipped by index/scan) plus indexed event/response rows.
 */
export function makeCodexSessionLines(sessionIndex, opts = {}) {
  const {
    fillerLines = 12,
    withError = false,
    markerPrefix = "codexperf",
    diskOnlyCmd = null,
    projectCwd = "/home/dev/perf-codex",
  } = opts;
  const marker = `${markerPrefix}-sess-${sessionIndex}`;
  const lines = [];

  lines.push({
    type: "session_meta",
    payload: { cwd: projectCwd, model_provider: "openai" },
    timestamp: "2026-05-01T00:00:00Z",
  });

  for (let i = 0; i < fillerLines; i++) {
    lines.push({ type: "stream_chunk", payload: { text: "x".repeat(120) } });
  }

  lines.push({
    type: "event_msg",
    payload: { type: "user_message", message: `Deploy ${marker} to staging` },
    timestamp: "2026-05-01T00:01:00Z",
  });

  lines.push({
    type: "response_item",
    payload: {
      role: "assistant",
      content: [
        { type: "output_text", text: `Running deploy for ${marker}` },
        {
          type: "function_call",
          name: "bash",
          arguments: JSON.stringify({ command: `npm run deploy-${sessionIndex}` }),
        },
      ],
    },
  });

  if (diskOnlyCmd) {
    lines.push({
      type: "event_msg",
      payload: {
        type: "exec_command_end",
        command: diskOnlyCmd,
        exit_code: 0,
      },
    });
  }

  if (withError) {
    lines.push({
      type: "event_msg",
      payload: {
        type: "exec_command_end",
        command: `npm run deploy-${sessionIndex}`,
        exit_code: 1,
      },
    });
    lines.push({
      type: "response_item",
      payload: {
        type: "function_call_output",
        exit_code: 1,
        output: "Error: codex deployment failed exit code 1",
      },
    });
  }

  for (let i = 0; i < 6; i++) {
    lines.push({ type: "stream_chunk", payload: { text: "y".repeat(80) } });
  }

  lines.push({
    type: "event_msg",
    payload: { type: "user_message", message: `Verify ${marker} health check` },
    timestamp: "2026-05-01T00:02:00Z",
  });

  lines.push({
    type: "turn_context",
    payload: {
      model: "gpt-5-codex",
      last_token_usage: { input_tokens: 100, output_tokens: 50 },
    },
    timestamp: "2026-05-01T00:03:00Z",
  });

  return { lines, marker, withError, diskOnlyCmd };
}

/**
 * Write sessionCount synthetic Codex rollout JSONL files under tmpDir.
 * Layout mirrors ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
 */
export function writeSyntheticCodexSessions(tmpDir, opts = {}) {
  const {
    sessionCount = 120,
    fillerLines = 12,
    markerPrefix = "codexperf",
    project = "perf-codex",
    projectCwd = `/home/dev/${project}`,
    datePath = "2026/06/07",
  } = opts;

  const codexDir = path.join(tmpDir, ".codex", "sessions", ...datePath.split("/"));
  fs.mkdirSync(codexDir, { recursive: true });
  const sessions = Array.from({ length: sessionCount });
  const markerByPath = new Map();
  const baseMtime = Date.parse("2026-06-01T12:00:00Z");

  for (let i = 0; i < sessionCount; i++) {
    const fileName = `rollout-${i}.jsonl`;
    const filePath = path.join(codexDir, fileName);
    const withError = i % 7 === 0;
    const diskOnlyCmd = i === 5 ? `${markerPrefix}-deploy-cmd-5` : null;
    const { lines, marker } = makeCodexSessionLines(i, {
      fillerLines,
      withError,
      markerPrefix,
      diskOnlyCmd,
      projectCwd,
    });
    const body = lines.map((row) => JSON.stringify(row)).join("\n") + "\n";
    fs.writeFileSync(filePath, body);
    const stat = fs.statSync(filePath);
    sessions[i] = {
      path: filePath,
      source: "codex",
      project,
      file: fileName,
      mtime: new Date(baseMtime + i * 1000),
      size: stat.size,
    };
    markerByPath.set(filePath, { marker, withError, diskOnlyCmd });
  }

  return { sessions, markerByPath, project, codexDir };
}

/**
 * Build OpenCode SQLite rows for one synthetic session (indexing-shaped schema).
 */
export function makeOpenCodeSessionRows(sessionIndex, opts = {}) {
  const {
    withError = false,
    markerPrefix = "opencodeperf",
    diskOnlyPhrase = null,
    projectDir = "/home/dev/perf-opencode",
  } = opts;
  const marker = `${markerPrefix}-sess-${sessionIndex}`;
  const id = `oc-perf-${sessionIndex}`;
  const t0 = 1_748_784_000_000 + sessionIndex * 1000;

  const messages = [
    {
      role: "user",
      modelID: "gpt-5-codex",
      time: String(t0),
      parts: [{ type: "text", text: `Deploy ${marker} to staging` }],
    },
    {
      role: "assistant",
      modelID: "gpt-5-codex",
      time: String(t0 + 1000),
      parts: [
        { type: "text", text: `Running deploy for ${marker}` },
        { type: "tool", tool: "bash" },
        ...(withError ? [{ type: "tool", status: "error" }] : []),
      ],
    },
    {
      role: "user",
      time: String(t0 + 2000),
      parts: [
        { type: "text", text: `Verify ${marker} health check` },
        ...(diskOnlyPhrase ? [{ type: "text", text: diskOnlyPhrase }] : []),
      ],
    },
    {
      role: "assistant",
      time: String(t0 + 3000),
      parts: [{ type: "text", text: `Health OK for ${marker}` }],
    },
  ];

  return {
    id,
    title: `OpenCode ${marker}`,
    directory: projectDir,
    time_created: t0,
    time_updated: t0 + 5000,
    messages,
    marker,
    withError,
    diskOnlyPhrase,
  };
}

/**
 * Write sessionCount synthetic OpenCode sessions into a single opencode.db under tmpDir.
 * Returns virtual opencode:// session descriptors for buildIndex/searchSessions.
 */
export async function writeSyntheticOpenCodeSessions(tmpDir, opts = {}) {
  const {
    sessionCount = 120,
    markerPrefix = "opencodeperf",
    project = "perf-opencode",
    projectDir = `/home/dev/${project}`,
  } = opts;

  const { db, dbPath } = await openOpenCodeDb(tmpDir, { wal: true });
  execOpenCodeIndexSchema(db);

  const insS = db.prepare(
    `INSERT INTO session (id, title, directory, version, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insMsg = db.prepare(
    `INSERT INTO message (id, session_id, data, time_created, time_updated) VALUES (?, ?, ?, ?, ?)`
  );
  const insPart = db.prepare(`INSERT INTO part (id, message_id, data, time_created) VALUES (?, ?, ?, ?)`);

  const sessions = Array.from({ length: sessionCount });
  const markerByPath = new Map();
  const baseMtime = Date.parse("2026-06-01T12:00:00Z");

  db.exec("BEGIN");
  try {
    for (let i = 0; i < sessionCount; i++) {
      const withError = i % 7 === 0;
      const diskOnlyPhrase = i === 5 ? `${markerPrefix}-disk-phrase-5` : null;
      const row = makeOpenCodeSessionRows(i, {
        withError,
        markerPrefix,
        diskOnlyPhrase,
        projectDir,
      });
      insS.run(row.id, row.title, row.directory, "1.0", row.time_created, row.time_updated);

      let msgSeq = 0;
      let partSeq = 0;
      for (const msg of row.messages) {
        const mid = `${row.id}-m${msgSeq++}`;
        insMsg.run(
          mid,
          row.id,
          JSON.stringify({ role: msg.role ?? "user", modelID: msg.modelID }),
          msg.time,
          msg.time,
        );
        for (const part of msg.parts ?? []) {
          insPart.run(`${row.id}-p${partSeq++}`, mid, JSON.stringify(part), row.time_created);
        }
      }

      const virtualPath = `opencode://${row.id}`;
      sessions[i] = {
        path: virtualPath,
        source: "opencode",
        project,
        file: row.id,
        title: row.title,
        mtime: new Date(baseMtime + i * 1000),
        size: row.messages.length * 1024,
      };
      markerByPath.set(virtualPath, {
        marker: row.marker,
        withError,
        diskOnlyPhrase,
      });
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    db.close();
  }

  return { sessions, markerByPath, project, dbPath };
}