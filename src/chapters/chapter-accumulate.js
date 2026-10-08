import {
  FIRST_PROMPT_MAX_LEN,
  safeSlice,
  shortToolPath,
  parseWebSearchLinks,
  countNonEmptyLines,
  joinFirstNonEmptyLines,
  joinFirstLines,
} from "../parse/parse-utils.js";
import { detectGitOp } from "../utils/git-op.js";

/** Fresh chapter object for HTML buildChapters or markdown export. */
export function newChapter(prompt, timestamp, variant = "html") {
  const ch = {
    prompt,
    timestamp,
    endTimestamp: timestamp,
    turns: 0,
    toolCounts: {},
    files: {},
    commands: [],
    searches: [],
    webOps: [],
    mcpOps: [],
    diffs: [],
    agents: [],
    errors: 0,
    corrected: false,
    lastAssistantText: "",
    gitOps: [],
    thinking: [],
    standaloneErrors: [],
  };
  if (variant === "markdown") {
    ch.outcome = "clean";
  } else {
    ch.errorTools = {};
    ch.tokens = { input: 0, output: 0, cacheHit: 0, cacheWrite: 0 };
    ch._callSeq = [];
  }
  return ch;
}

/** Single-pass prefetch: tool_result map + tool_use id -> name for errorTools. */
export function buildChapterEventMaps(events) {
  const resultMap = {};
  const toolNameMap = {};
  for (const e of events) {
    if (e.type === "tool_result") {
      // Null/undefined ids (e.g. Cursor's synthesized session-level errors) must not
      // become a shared map key that every null-id tool call would resolve against.
      if (e.toolUseId != null) resultMap[e.toolUseId] = e;
    } else if (e.type === "assistant" && e.toolCalls) {
      for (const tc of e.toolCalls) {
        if (tc.id != null) toolNameMap[tc.id] = tc.name;
      }
    }
  }
  return { resultMap, toolNameMap };
}

/** Accumulate one assistant tool call into a chapter (shared by HTML + markdown builders). */
export function accumulateAssistantToolCall(chapter, tc, resultMap, opts = {}) {
  const trackCallSeq = !!opts.trackCallSeq;
  const searchOutput = !!opts.searchOutput;
  const agentResult = !!opts.agentResult;
  const webFetchPreview = !!opts.webFetchPreview;

  chapter.toolCounts[tc.name] = (chapter.toolCounts[tc.name] || 0) + 1;
  const result = tc.id == null ? undefined : resultMap[tc.id];
  const output = result ? result.text || "" : "";
  const isError = result ? result.isError : false;

  let filePath;
  if ((tc.name === "Read" || tc.name === "Edit" || tc.name === "Write" || tc.name === "Delete") && tc.input) {
    filePath = shortToolPath(tc.input);
    if (!chapter.files[filePath]) chapter.files[filePath] = { ops: [], output: "" };
    chapter.files[filePath].ops.push(tc.name);
    if (tc.name === "Read" && output && !chapter.files[filePath].output) {
      chapter.files[filePath].output = safeSlice(joinFirstLines(output, 3), FIRST_PROMPT_MAX_LEN);
    }
    if (tc.diffInfo && chapter.diffs.length < 12) {
      chapter.diffs.push({ path: filePath, name: tc.name, diffInfo: tc.diffInfo });
    }
  }
  if (trackCallSeq) {
    const entry = { name: tc.name, input: tc.input || "", isError, id: tc.id };
    if (filePath) entry._path = filePath;
    chapter._callSeq.push(entry);
  }
  if (tc.name === "Bash" && tc.input) {
    chapter.commands.push({ cmd: tc.input, ok: !isError, output: safeSlice(output, 300) });
    const gitOp = detectGitOp(tc.input, output);
    if (gitOp && chapter.gitOps.length < 20) chapter.gitOps.push(gitOp);
  }
  if (tc.name === "Grep" && tc.input) {
    const matchCount = countNonEmptyLines(output);
    const entry = { query: tc.input, matches: matchCount, ok: !isError };
    if (searchOutput) entry.output = safeSlice(output, FIRST_PROMPT_MAX_LEN);
    chapter.searches.push(entry);
  }
  if (tc.webInfo && chapter.webOps.length < 10) {
    const webOp = {
      type: tc.webInfo.type,
      url: tc.webInfo.url || "",
      query: tc.webInfo.query || "",
      prompt: tc.webInfo.prompt || "",
      ok: !isError,
      output: safeSlice(output, 500),
    };
    if (tc.webInfo.type === "search" && output) {
      const parsedLinks = parseWebSearchLinks(output);
      if (parsedLinks.length) {
        webOp.results = parsedLinks.slice(0, 5);
        webOp.resultCount = parsedLinks.length;
      }
    }
    if (tc.webInfo.type === "fetch" && output) {
      if (webFetchPreview) {
        webOp.preview = safeSlice(joinFirstNonEmptyLines(output, 4), 300);
      }
      const titleMatch = output.match(/^#\s+(.+)/m);
      if (titleMatch) webOp.pageTitle = safeSlice(titleMatch[1], 100);
    }
    chapter.webOps.push(webOp);
  }
  if (tc.agentInfo && chapter.agents.length < 10) {
    const agent = {
      description: tc.agentInfo.description || "",
      prompt: tc.agentInfo.prompt || "",
      subagentType: tc.agentInfo.subagentType || "",
      toolName: tc.agentInfo.toolName || tc.name,
      completed: !!result,
      isError,
    };
    if (agentResult) agent.result = safeSlice(output, 400);
    chapter.agents.push(agent);
  }
  if (tc.mcpInfo && chapter.mcpOps.length < 15) {
    chapter.mcpOps.push({
      server: tc.mcpInfo.server || "",
      tool: tc.mcpInfo.tool || "",
      rawName: tc.mcpInfo.rawName || tc.name,
      params: tc.mcpInfo.params || {},
      ok: !isError,
      output: safeSlice(output, 400),
    });
  }
}