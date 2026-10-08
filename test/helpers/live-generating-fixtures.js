import fs from "node:fs";
import path from "node:path";

export function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n";
  fs.writeFileSync(filePath, body);
}

/** Grok session dir currently generating (unmatched turn_started). */
export function writeGrokGenerating(sessionDir) {
  fs.mkdirSync(sessionDir, { recursive: true });
  writeJsonl(path.join(sessionDir, "events.jsonl"), [
    { ts: "2026-08-26T12:12:50.353Z", type: "turn_started", session_id: path.basename(sessionDir) },
  ]);
}

/** Grok session dir idle-open: last events record is turn_ended completed. */
export function writeGrokIdle(sessionDir, extras = {}) {
  fs.mkdirSync(sessionDir, { recursive: true });
  const events = extras.events ?? [
    { ts: "2026-08-26T12:08:17.509Z", type: "phase_changed", phase: "streaming_text" },
    { ts: "2026-08-26T12:08:17.984Z", type: "turn_ended", outcome: "completed" },
  ];
  const chat = extras.chat ?? [
    { type: "user", content: [{ type: "text", text: "<user_query>\nWhat runs on :7777 now?\n</user_query>" }] },
    {
      type: "assistant",
      content: "I stopped it. Port 7777 is free.",
      model_id: "grok-4.6-build",
    },
  ];
  writeJsonl(path.join(sessionDir, "events.jsonl"), events);
  writeJsonl(path.join(sessionDir, "chat_history.jsonl"), chat);
}

export function writeClaudeGenerating(filePath) {
  writeJsonl(filePath, [
    {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t-live", name: "Bash", input: { command: "ls" } }],
      },
    },
  ]);
}

export function writeClaudeIdle(filePath) {
  writeJsonl(filePath, [
    { type: "assistant", message: { stop_reason: "end_turn" }, timestamp: "2026-07-28T13:48:20.158Z" },
    { type: "system", subtype: "turn_duration", durationMs: 100, timestamp: "2026-07-28T13:48:20.202Z" },
    { type: "system", subtype: "away_summary", content: "Nothing is pending — next action is yours." },
  ]);
}

export function writeCursorGenerating(filePath) {
  writeJsonl(filePath, [
    { role: "user", message: { content: [{ type: "text", text: "go" }] } },
    { role: "assistant", message: { content: [{ type: "text", text: "working" }, { type: "tool_use", name: "Read", input: { path: "/tmp/x" } }] } },
  ]);
}

export function writeCursorIdle(filePath) {
  writeJsonl(filePath, [
    { role: "assistant", message: { content: [{ type: "text", text: "done" }] } },
    { type: "turn_ended", status: "success" },
  ]);
}

export function writeCodexGenerating(filePath, cwd) {
  writeJsonl(filePath, [
    { type: "session_meta", payload: { id: "gen", cwd } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn-gen" } },
  ]);
}

export function writeCodexIdle(filePath, cwd) {
  writeJsonl(filePath, [
    { type: "session_meta", payload: { id: "idle", cwd } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn-idle" } },
    { type: "response_item", payload: { type: "custom_tool_call", status: "completed", name: "exec" } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-idle" } },
  ]);
}

export function writeFactoryGenerating(filePath) {
  writeJsonl(filePath, [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "f1", name: "Bash", input: { command: "npm test" } }],
      },
    },
  ]);
}

export function writeFactoryIdle(filePath) {
  writeJsonl(filePath, [
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "deploy finished." }] },
    },
  ]);
}

/** Last user message: waiting for the model (factory / last-user generating). */
export function writeFactoryLastUser(filePath) {
  writeJsonl(filePath, [
    {
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "keep going" }] },
    },
  ]);
}

export function writeClaudeNoEndTurn(filePath) {
  writeJsonl(filePath, [
    { type: "user", message: { content: [{ type: "text", text: "go" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "working" }] } },
  ]);
}

export function writeClaudeLastUser(filePath) {
  writeJsonl(filePath, [
    { type: "assistant", message: { stop_reason: "end_turn" } },
    { type: "user", message: { content: [{ type: "text", text: "next" }] } },
  ]);
}

export function writeCodexPendingTool(filePath, cwd) {
  writeJsonl(filePath, [
    { type: "session_meta", payload: { id: "pend", cwd } },
    { type: "response_item", payload: { type: "custom_tool_call", status: "in_progress", name: "exec" } },
  ]);
}

export function writeCodexReasoningInFlight(filePath, cwd) {
  writeJsonl(filePath, [
    { type: "session_meta", payload: { id: "reason", cwd } },
    { type: "response_item", payload: { type: "reasoning" } },
  ]);
}

/** Append a truncated JSONL record so the last line does not parse (mid-write). */
export function appendIncompleteJsonl(filePath, fragment = '{"type":"in_flight","partial":') {
  fs.appendFileSync(filePath, fragment);
}

/** Bytes of filler so a start event falls outside the 128KB recording tail. */
export const TAIL_PAD_BYTES = 160 * 1024;

function appendJsonlPadding(filePath, fillerRows, padBytes = TAIL_PAD_BYTES) {
  const block = fillerRows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  let extra = "";
  while (Buffer.byteLength(extra) < padBytes) extra += block;
  fs.appendFileSync(filePath, extra);
}

/** Unmatched turn_started followed by >128KB of paired completed tools (start aged out of the tail). */
export function writeGrokGeneratingAgedStart(sessionDir, padBytes = TAIL_PAD_BYTES) {
  writeGrokGenerating(sessionDir);
  appendJsonlPadding(path.join(sessionDir, "events.jsonl"), [
    { ts: "2026-08-26T12:13:00.000Z", type: "tool_started", tool_name: "bash", tool_call_id: "pad" },
    { ts: "2026-08-26T12:13:00.010Z", type: "tool_completed", tool_name: "bash", tool_call_id: "pad", outcome: "success" },
  ], padBytes);
}

/** Unmatched task_started followed by >128KB of completed tools (start aged out of the tail). */
export function writeCodexGeneratingAgedStart(filePath, cwd, padBytes = TAIL_PAD_BYTES) {
  writeCodexGenerating(filePath, cwd);
  appendJsonlPadding(filePath, [
    { type: "response_item", payload: { type: "custom_tool_call", status: "completed", name: "exec" } },
  ], padBytes);
}

export function writeGrokUpdates(sessionDir, rows) {
  writeJsonl(path.join(sessionDir, "updates.jsonl"), rows);
}

/** Last JSONL record larger than the 128KB tail window (143KB payload). */
export const OVERSIZE_LAST_BYTES = 143 * 1024;

function oversizePad(padBytes = OVERSIZE_LAST_BYTES) {
  return "x".repeat(padBytes);
}

/** Claude unmatched tool_use whose last record exceeds the 128KB tail. */
export function writeClaudeGeneratingOversizeLast(filePath, padBytes = OVERSIZE_LAST_BYTES) {
  writeJsonl(filePath, [
    {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t-live", name: "Bash", input: { command: "ls", dump: oversizePad(padBytes) } }],
      },
    },
  ]);
}

/** Claude idle end_turn whose last record exceeds the 128KB tail. */
export function writeClaudeIdleOversizeLast(filePath, padBytes = OVERSIZE_LAST_BYTES) {
  writeJsonl(filePath, [
    { type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: oversizePad(padBytes) }] } },
  ]);
}

/** Grok events turn_ended + unmatched chat_history tool_calls last record > 128KB. */
export function writeGrokGeneratingOversizeToolCalls(sessionDir, padBytes = OVERSIZE_LAST_BYTES) {
  writeGrokIdle(sessionDir, {
    events: [{ ts: "2026-08-26T12:08:17.984Z", type: "turn_ended", outcome: "completed" }],
    chat: [
      { type: "user", content: "run it" },
      {
        type: "assistant",
        content: "",
        tool_calls: [{ id: "call-live", name: "run_terminal_command", arguments: oversizePad(padBytes) }],
      },
    ],
  });
}

/** Grok events turn_ended + completed assistant last record > 128KB (idle-open). */
export function writeGrokIdleOversizeAssistant(sessionDir, padBytes = OVERSIZE_LAST_BYTES) {
  writeGrokIdle(sessionDir, {
    events: [{ ts: "2026-08-26T12:08:17.984Z", type: "turn_ended", outcome: "completed" }],
    chat: [
      { type: "user", content: "done?" },
      { type: "assistant", content: oversizePad(padBytes), model_id: "grok-4.6-build" },
    ],
  });
}

const OPENCODE_T0 = 1_715_731_200_000;

/** OpenCode last assistant after a completed turn (idle-open TUI). */
export function openCodeIdleAssistant(overrides = {}) {
  return {
    id: "m-a",
    role: "assistant",
    finish: "stop",
    time: { created: OPENCODE_T0, completed: OPENCODE_T0 + 5000 },
    parts: [
      { type: "step-start" },
      { type: "text", text: "done", time: { start: OPENCODE_T0, end: OPENCODE_T0 + 4000 } },
      { type: "step-finish", reason: "stop", tokens: { input: 10, output: 4 } },
    ],
    ...overrides,
  };
}

/** OpenCode last assistant mid-stream (text still growing, no step-finish). */
export function openCodeStreamingTextAssistant(text = "Roses are", overrides = {}) {
  return {
    id: "m-a",
    role: "assistant",
    time: { created: OPENCODE_T0 },
    parts: [{ type: "text", text }],
    ...overrides,
  };
}
