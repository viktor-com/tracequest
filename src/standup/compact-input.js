import { basename } from "node:path";
import { buildSessionChapters } from "../chapters/session-chapters.js";
import { chapterFileKeys, chapterToolKeys } from "../chapters/chapter-keys.js";
import { formatDuration, fmtTokens, fmtMcpName } from "../filter/filter-formats.js";
import { collapseWhitespace, safeSlice, sumToolCounts } from "../parse/parse-utils.js";
import { sessionHash as hashSessionPath } from "../sessions/session-hash.js";
import { sessionMtimeMs } from "../sessions/session-list.js";
import { normalizeProjectFolder } from "../server/server-session-path.js";

export const DEFAULT_STANDUP_LIMITS = {
  maxSessions: 5,
  maxChaptersPerSession: 4,
  maxPromptChars: 180,
  maxAssistantChars: 220,
  maxCommandChars: 120,
  maxTools: 8,
  maxFiles: 8,
  maxCommands: 5,
  maxAgents: 4,
  maxIntegrations: 4,
};

function mergeLimits(opts = {}) {
  return { ...DEFAULT_STANDUP_LIMITS, ...(opts.limits || {}) };
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function compactText(value, max) {
  const clean = sanitizeAbsolutePaths(collapseWhitespace(String(value ?? "")));
  if (!clean || clean.length <= max) return clean;
  return `${safeSlice(clean, Math.max(0, max - 3)).trimEnd()}...`;
}

function sanitizeAbsolutePaths(text) {
  return String(text ?? "").replace(/(^|[\s([{<"'`])\/[^\s)\]}>,"'`]+/g, (match, prefix) => {
    const rawPath = match.slice(prefix.length);
    const leaf = basename(rawPath);
    return `${prefix}.../${leaf || "path"}`;
  });
}

function displayPath(value, max = 90) {
  return compactText(value, max);
}

function sessionIdFor(session, discovery) {
  if (session?.sessionHash) return session.sessionHash;
  const path = session?.path || discovery?.path;
  if (path) return hashSessionPath(path);
  if (session?.sessionId) return String(session.sessionId).slice(0, 12);
  return "unknown";
}

function sessionDate(session, discovery) {
  const value = session?.startTime || discovery?.mtime || null;
  if (!value) return "unknown";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "unknown";
  return d.toISOString().slice(0, 16).replace("T", " ");
}

function sessionProject(session, discovery) {
  return normalizeProjectFolder(discovery?.project || session?.project || session?.cwd || "");
}

function formatToolCounts(toolCounts, maxTools) {
  const entries = Object.entries(toolCounts || {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  if (!entries.length) return "none";
  const shown = entries.slice(0, maxTools).map(([name, n]) => `${fmtMcpName(name)} x${n}`);
  if (entries.length > maxTools) shown.push(`+${entries.length - maxTools} more`);
  return shown.join(", ");
}

function formatFiles(chapter, limits) {
  const keys = chapterFileKeys(chapter);
  if (!keys.length) return null;
  const shown = keys.slice(0, limits.maxFiles).map((p) => {
    const ops = chapter.files?.[p]?.ops || [];
    const suffix = ops.length ? ` (${ops.join(", ")})` : "";
    return `${displayPath(p)}${suffix}`;
  });
  if (keys.length > limits.maxFiles) shown.push(`+${keys.length - limits.maxFiles} more`);
  return shown.join(", ");
}

function formatChapterTools(chapter, limits) {
  const keys = chapterToolKeys(chapter)
    .sort((a, b) => (chapter.toolCounts[b] || 0) - (chapter.toolCounts[a] || 0));
  if (!keys.length) return null;
  const shown = keys.slice(0, limits.maxTools).map((name) => `${fmtMcpName(name)} x${chapter.toolCounts[name]}`);
  if (keys.length > limits.maxTools) shown.push(`+${keys.length - limits.maxTools} more`);
  return shown.join(", ");
}

function formatCommands(chapter, limits) {
  const commands = chapter.commands || [];
  if (!commands.length) return null;
  const shown = commands.slice(0, limits.maxCommands).map((cmd) => {
    const status = cmd.ok ? "ok" : "FAIL";
    return `[${status}] ${compactText(cmd.cmd, limits.maxCommandChars)}`;
  });
  if (commands.length > limits.maxCommands) shown.push(`+${commands.length - limits.maxCommands} more`);
  return shown.join("; ");
}

function formatAgents(chapter, limits) {
  const agents = chapter.agents || [];
  if (!agents.length) return null;
  const shown = agents.slice(0, limits.maxAgents).map((a) => {
    const status = a.isError ? "FAIL" : a.completed ? "ok" : "pending";
    const desc = compactText(a.description || a.subagentType || a.toolName || "subagent", 90);
    return `[${status}] ${desc}`;
  });
  if (agents.length > limits.maxAgents) shown.push(`+${agents.length - limits.maxAgents} more`);
  return shown.join("; ");
}

function formatIntegrations(chapter, limits) {
  const parts = [];
  for (const web of (chapter.webOps || []).slice(0, limits.maxIntegrations)) {
    if (web.type === "search") parts.push(`web search: ${compactText(web.query, 90)}`);
    else if (web.type === "fetch") parts.push(`web fetch: ${compactText(web.pageTitle || web.url, 90)}`);
  }
  for (const mcp of (chapter.mcpOps || []).slice(0, Math.max(0, limits.maxIntegrations - parts.length))) {
    const server = compactText(mcp.server || "mcp", 40);
    const tool = compactText(mcp.tool || "tool", 60);
    parts.push(`mcp ${server}: ${tool}`);
  }
  return parts.length ? parts.join("; ") : null;
}

function statsFor(session) {
  const s = session?.stats || {};
  return {
    prompts: s.userMessages || 0,
    turns: s.assistantTurns || 0,
    toolCalls: sumToolCounts(s.toolCounts || {}),
    errors: s.errors || 0,
    inputTokens: s.totalInputTokens || 0,
    outputTokens: s.totalOutputTokens || 0,
    cacheTokens: s.totalCacheHit || 0,
    toolCounts: s.toolCounts || {},
  };
}

function normalizeSelection(selection) {
  return (selection || []).map((entry) => {
    if (entry?.session) return { session: entry.session, discovery: entry.discovery || null };
    return { session: entry, discovery: null };
  }).filter((entry) => entry.session);
}

function appendChapter(lines, chapter, chapterIndex, totalChapters, limits) {
  const meta = [];
  if (chapter.turns > 0) meta.push(plural(chapter.turns, "turn"));
  if (chapter.errors > 0) meta.push(plural(chapter.errors, "error"));
  if (chapter.outcome && chapter.outcome !== "clean") meta.push(`outcome ${chapter.outcome}`);

  lines.push(`  ${chapterIndex + 1}. ${compactText(chapter.prompt, limits.maxPromptChars) || "(no prompt)"}`);
  if (meta.length) lines.push(`     - Chapter status: ${meta.join(", ")}`);

  const tools = formatChapterTools(chapter, limits);
  if (tools) lines.push(`     - Tools: ${tools}`);

  const files = formatFiles(chapter, limits);
  if (files) lines.push(`     - Files: ${files}`);

  const commands = formatCommands(chapter, limits);
  if (commands) lines.push(`     - Commands: ${commands}`);

  const agents = formatAgents(chapter, limits);
  if (agents) lines.push(`     - Subagents: ${agents}`);

  const integrations = formatIntegrations(chapter, limits);
  if (integrations) lines.push(`     - Integrations: ${integrations}`);

  if (chapter.lastAssistantText) {
    lines.push(`     - Assistant outcome snippet: ${compactText(chapter.lastAssistantText, limits.maxAssistantChars)}`);
  }

  if (chapterIndex + 1 === limits.maxChaptersPerSession && totalChapters > limits.maxChaptersPerSession) {
    lines.push(`     - More chapters omitted: ${totalChapters - limits.maxChaptersPerSession}`);
  }
}

function appendSession(lines, entry, index, limits) {
  const { session, discovery } = entry;
  const id = sessionIdFor(session, discovery);
  const stats = statsFor(session);
  const chapters = buildSessionChapters(session);
  const duration = formatDuration(session.durationMs || 0, { zeroLabel: "" });
  const tokenParts = [];
  if (stats.inputTokens || stats.outputTokens) {
    tokenParts.push(`${fmtTokens(stats.inputTokens, { zeroLabel: "0" })} in`);
    tokenParts.push(`${fmtTokens(stats.outputTokens, { zeroLabel: "0" })} out`);
  }
  if (stats.cacheTokens) tokenParts.push(`${fmtTokens(stats.cacheTokens)} cache`);

  lines.push(`### ${index + 1}. Session ${id}`);
  lines.push(`- Source: ${session.source || discovery?.source || "claude"}`);
  lines.push(`- Project: ${sessionProject(session, discovery)}`);
  lines.push(`- Date: ${sessionDate(session, discovery)}`);
  if (session.model) lines.push(`- Model: ${session.model}`);
  if (duration) lines.push(`- Duration: ${duration}`);
  lines.push(`- Counts: ${plural(stats.prompts, "prompt")}, ${plural(stats.turns, "assistant turn")}, ${plural(stats.toolCalls, "tool call")}, ${plural(stats.errors, "error")}`);
  if (tokenParts.length) lines.push(`- Tokens: ${tokenParts.join(", ")}`);
  lines.push(`- Top tools: ${formatToolCounts(stats.toolCounts, limits.maxTools)}`);
  lines.push(`- Chapters shown: ${Math.min(chapters.length, limits.maxChaptersPerSession)} of ${chapters.length}`);

  if (!chapters.length) {
    lines.push("- Chapter notes: none");
    lines.push("");
    return;
  }

  lines.push("- Chapter notes:");
  const shown = chapters.slice(0, limits.maxChaptersPerSession);
  for (let i = 0; i < shown.length; i++) {
    appendChapter(lines, shown[i], i, chapters.length, limits);
  }
  lines.push("");
}

export function buildStandupInput(selection, opts = {}) {
  const limits = mergeLimits(opts);
  const normalized = normalizeSelection(selection);
  const included = normalized.slice(0, limits.maxSessions);
  const generatedAt = opts.generatedAt
    ? new Date(opts.generatedAt)
    : new Date();
  const validGeneratedAt = Number.isNaN(generatedAt.getTime()) ? new Date(0) : generatedAt;

  const lines = [
    "# TraceQuest Standup Request",
    "",
    "Write a concise standup update from the compact TraceQuest session summaries below.",
    "",
    "## Prompt-Agent Instructions",
    "- Use sections: Progress, Risks/Blockers, and Next Steps. Keep each bullet tied to evidence from the session summaries.",
    "- Use only the compact summaries below; snippets are capped signals, not complete transcripts.",
    "- Do not request, infer, or reconstruct raw JSONL, transcripts, full tool outputs, absolute paths, or omitted private details.",
    "",
    "## Data Policy",
    "- Included: session hashes, source/project/date/model metadata, aggregate counts, capped chapter notes, capped tool/file/command/subagent summaries, and short assistant outcome snippets.",
    "- Omitted: raw JSONL, absolute session paths, full prompts, full assistant messages, full tool outputs, and uncapped transcripts.",
    "- Reason: standup only needs progress/risk/next-step signals; raw traces are bulky and can expose unnecessary private data.",
    "",
    "## Selection",
    `- Generated at: ${validGeneratedAt.toISOString()}`,
    `- Sessions selected: ${included.length} of ${normalized.length}`,
    `- Session cap: ${limits.maxSessions}`,
    `- Chapter cap per session: ${limits.maxChaptersPerSession}`,
  ];

  if (opts.filter) lines.push(`- Filter: ${compactText(opts.filter, 160)}`);
  if (opts.window) lines.push(`- Window: ${compactText(opts.window, 160)}`);
  if (opts.project) lines.push(`- Project filter: ${compactText(opts.project, 160)}`);
  if (normalized.length > included.length) {
    lines.push(`- Sessions omitted by cap: ${normalized.length - included.length}`);
  }
  lines.push("");
  lines.push("## Sessions");
  lines.push("");

  if (!included.length) {
    lines.push("No sessions selected.");
    lines.push("");
    return lines.join("\n");
  }

  for (let i = 0; i < included.length; i++) {
    appendSession(lines, included[i], i, limits);
  }
  return lines.join("\n");
}

export function selectStandupEntries(sessions, { maxSessions = DEFAULT_STANDUP_LIMITS.maxSessions } = {}) {
  const copy = [...(sessions || [])];
  copy.sort((a, b) => sessionMtimeMs(b) - sessionMtimeMs(a));
  return copy.slice(0, maxSessions);
}
