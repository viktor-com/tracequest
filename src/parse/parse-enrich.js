import { safeSlice, truncateFirstPrompt } from "./parse-utils.js";

export const errorPattern = /^(?:Error:|exit code [1-9]|command failed|ENOENT|EACCES|SyntaxError|TypeError|ReferenceError)/im;

const NORMALIZED_TOOL_MAP = {
  bash: "Bash", shell: "Bash", exec_command: "Bash", execute: "Bash", run_command: "Bash", run_terminal_command: "Bash",
  read_file: "Read", read: "Read",
  write_file: "Write", write: "Write", create_file: "Write",
  edit_file: "Edit", edit: "Edit", apply_patch: "Edit", patch: "Edit",
  grep: "Grep", ripgrep: "Grep",
  glob: "Glob", list_dir: "Glob", ls: "Glob",
  agent: "Agent", task: "Agent", taskcreate: "Agent", taskupdate: "Agent",
  dispatch_agent: "Agent", spawn_subagent: "Agent", wait_commands_or_subagents: "Agent",
  get_command_or_subagent_output: "Agent", kill_command_or_subagent: "Agent",
  web_search: "WebSearch", websearch: "WebSearch",
  web_fetch: "WebFetch", webfetch: "WebFetch",
  browser_tab: "WebFetch",
  todo_write: "TodoWrite", todowrite: "TodoWrite",
  search_replace: "Edit", strreplace: "Edit", enter_plan_mode: "Plan", exit_plan_mode: "Plan",
  askquestion: "Ask",
  write_stdin: "Bash",
  memory_get: "Memory", memory_search: "Memory",
  ask_user_question: "Ask",
};

export function normalizeToolName(name) {
  if (!name) return "unknown";
  // Preserve MCP tool names as-is so renderers can parse server/tool
  if (isMcpTool(name)) return name;
  const lower = name.toLowerCase();
  return NORMALIZED_TOOL_MAP[lower] || name.charAt(0).toUpperCase() + name.slice(1);
}

export function summarizeInput(toolName, input) {
  if (!input) return "";
  // For MCP tools, build a summary from known parameter patterns
  if (isMcpTool(toolName)) {
    return input.path || input.file_path || input.url || input.query ||
      input.subject || input.command || input.cmd || input.title ||
      input.pattern || input.message || safeSlice(input.content || "", 100) ||
      safeSlice(JSON.stringify(input), 150);
  }
  switch (toolName) {
    case "Bash": return input.command || input.cmd || "";
    case "Read": return input.file_path || input.path || input.target_file || "";
    case "Write": return input.file_path || input.path || input.filePath || "";
    case "Edit": return input.file_path || input.path || "";
    case "Grep": return `${input.pattern || ""} ${input.path || ""}`;
    case "Glob": return input.pattern || input.folder || input.target_directory || "";
    case "Agent": return input.description || safeSlice(input.prompt || "", 100) || "";
    case "Skill": return input.skill || "";
    case "TaskCreate": return input.description || input.subject || "";
    case "TaskUpdate": return `${input.id || input.taskId || ""} → ${input.status || ""}`;
    case "WebFetch": return input.url || "";
    case "WebSearch": return input.query || "";
    case "ToolSearch": return input.query || "";
    case "SemanticSearch": return input.query || "";
    case "Delete": return input.path || input.file_path || "";
    case "Await": return input.task_id ? `task ${input.task_id}` :
      (input.block_until_ms != null ? `wait ${input.block_until_ms}ms` : "");
    case "Ask": {
      const q = Array.isArray(input.questions) ? input.questions.find(x => x && x.question) : null;
      return (q && q.question) || input.question || "";
    }
    case "CallMcpTool": {
      const label = [input.server, input.toolName].filter(Boolean).join("/");
      const args = parseCursorMcpArguments(input.arguments);
      const argSummary = args ? safeSlice(JSON.stringify(args), 80) : "";
      return label ? (argSummary ? `${label} ${argSummary}` : label) : safeSlice(JSON.stringify(input), 150);
    }
    default: return safeSlice(JSON.stringify(input), 150);
  }
}

const TEXT_BLOCK_TYPES = new Set(["text", "input_text", "output_text"]);

/** Text from a Claude `text` or Codex `input_text`/`output_text` content block. */
function textFromContentBlock(block) {
  if (!block || typeof block !== "object") return "";
  if (!TEXT_BLOCK_TYPES.has(block.type)) return "";
  return typeof block.text === "string" ? block.text : "";
}

/** Join text-bearing blocks from assistant/tool content arrays without filter+map alloc. */
export function joinTextContentBlocks(content) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const b of content) {
    const t = textFromContentBlock(b);
    if (t) parts.push(t);
  }
  return parts.join("\n");
}

export function extractToolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return joinTextContentBlocks(content);
  return textFromContentBlock(content);
}

export function isMcpTool(name) {
  return typeof name === "string" && name.startsWith("mcp__");
}

function parseMcpName(name) {
  // mcp__server__toolname or mcp__org_server__toolname
  // Split after the first mcp__ prefix, then split on the next __ to get server and tool
  const rest = name.slice(5); // remove "mcp__"
  const idx = rest.indexOf("__");
  if (idx < 0) return { server: rest, tool: rest };
  return { server: rest.slice(0, idx), tool: rest.slice(idx + 2) };
}

/** Pick interesting parameters from an MCP tool input based on known patterns. */
function pickMcpParams(input) {
  const params = {};
  if (!input || typeof input !== "object") return params;
  if (input.path || input.file_path) params.path = truncateFirstPrompt(input.path || input.file_path);
  if (input.query) params.query = truncateFirstPrompt(input.query);
  if (input.url) params.url = truncateFirstPrompt(input.url);
  if (input.subject) params.subject = truncateFirstPrompt(input.subject);
  if (input.recipient || input.to) params.recipient = truncateFirstPrompt(input.recipient || input.to);
  if (input.content && !input.path) params.content = safeSlice(input.content, 150);
  if (input.command || input.cmd) params.command = truncateFirstPrompt(input.command || input.cmd);
  if (input.title) params.title = truncateFirstPrompt(input.title);
  if (input.calendar_id) params.calendar = safeSlice(input.calendar_id, 100);
  if (input.pattern) params.pattern = truncateFirstPrompt(input.pattern);
  if (input.body) params.body = safeSlice(input.body, 150);
  if (input.message) params.message = safeSlice(input.message, 150);
  // If no specific params were found, grab first 3 keys with short values
  if (Object.keys(params).length === 0) {
    const keys = Object.keys(input).slice(0, 3);
    for (const k of keys) {
      const v = input[k];
      if (typeof v === "string" && v.length <= 200) params[k] = v;
      else if (typeof v === "number" || typeof v === "boolean") params[k] = String(v);
    }
  }
  return params;
}

export function extractMcpInfo(name, input) {
  if (!input || !isMcpTool(name)) return null;
  const parsed = parseMcpName(name);
  return {
    server: parsed.server,
    tool: parsed.tool,
    rawName: name,
    params: pickMcpParams(input),
  };
}

/** Cursor's CallMcpTool carries arguments as an object or a JSON string. */
function parseCursorMcpArguments(args) {
  if (args && typeof args === "object") return args;
  if (typeof args === "string" && args) {
    try {
      const parsed = JSON.parse(args);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** True when a Cursor CallMcpTool call names an MCP server/tool via its input. */
export function isCursorMcpCall(rawName, input) {
  return rawName === "CallMcpTool" && !!input &&
    (typeof input.server === "string" || typeof input.toolName === "string");
}

/** mcpInfo for Cursor's CallMcpTool: server/tool from input, params from input.arguments. */
export function extractCursorMcpInfo(rawName, input) {
  if (!isCursorMcpCall(rawName, input)) return null;
  return {
    server: input.server || "",
    tool: input.toolName || "",
    rawName,
    params: pickMcpParams(parseCursorMcpArguments(input.arguments)),
  };
}

export function isWebTool(name) {
  const n = (name || "").toLowerCase();
  return n === "webfetch" || n === "web_fetch" || n === "websearch" || n === "web_search";
}

export function extractWebInfo(toolName, input) {
  if (!input) return null;
  const normalized = (toolName || "").replace(/_/g, "").toLowerCase();
  if (normalized === "webfetch") {
    return { type: "fetch", url: input.url || "", prompt: truncateFirstPrompt(input.prompt || "") };
  }
  if (normalized === "websearch") {
    return { type: "search", query: input.query || "" };
  }
  return null;
}

export function isAgentTool(name) {
  const lower = (name || "").toLowerCase();
  return lower === "agent" || lower === "taskcreate" || lower === "task" ||
    lower === "dispatch_agent" || lower === "spawn_subagent" ||
    lower === "skill" || lower === "taskcreate";
}

export function extractAgentInfo(toolName, input) {
  if (!input) return null;
  const info = {};
  // For TaskCreate, 'subject' is the short title and 'description' is the detailed prompt
  // For Agent, 'description' is the short title and 'prompt' is the detailed prompt
  // For Skill, 'skill' is the name and 'args' is the input
  if (input.subject) {
    info.description = input.subject;
    info.prompt = safeSlice(input.description || "", 300);
  } else {
    info.description = input.description || input.skill || "";
    info.prompt = safeSlice(input.prompt || input.args || "", 300);
  }
  info.subagentType = input.subagent_type || input.type || "";
  info.toolName = toolName;
  return info;
}

/**
 * Build a normalized tool-call record with summarized input and optional enrichment fields.
 */
export function enrichToolEvent({ id, rawName, input, normalize = true }) {
  const name = normalize ? normalizeToolName(rawName) : (rawName || "unknown");
  const tc = { id, name, input: summarizeInput(name, input) };
  if (name === "Edit" && input) {
    tc.diffInfo = { oldStr: safeSlice(input.old_string || "", 300), newStr: safeSlice(input.new_string || "", 300) };
  } else if (name === "Write" && input) {
    tc.diffInfo = { content: safeSlice(input.content || input.contents || "", 300) };
  }
  if (isAgentTool(rawName) && input) {
    tc.agentInfo = extractAgentInfo(rawName, input);
  }
  if (isWebTool(name) && input) {
    tc.webInfo = extractWebInfo(name, input);
  }
  if (isMcpTool(rawName) && input) {
    tc.mcpInfo = extractMcpInfo(rawName, input);
  } else if (isCursorMcpCall(rawName, input)) {
    tc.mcpInfo = extractCursorMcpInfo(rawName, input);
  }
  return tc;
}