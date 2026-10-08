/**
 * Recorded api2 payload shapes for the keyless `import cursor-cloud` route.
 *
 * Recorded READ-ONLY from Cursor's internal connect-rpc backend
 * (https://api2.cursor.sh/aiserver.v1.BackgroundComposerService/
 * ListBackgroundComposers and /GetBackgroundComposerConversation) on
 * 2026-07-28, then sanitized. What is VERBATIM as observed: the JSON
 * structure, every field name, the enum values (BACKGROUND_COMPOSER_STATUS_*,
 * BACKGROUND_COMPOSER_SOURCE_*, MESSAGE_TYPE_*, CLIENT_SIDE_TOOL_V2_*), the
 * `toolName` strings, and the inner key names of `toolCall`, `rawArgs`, and
 * `result`. What is REPLACED with obvious placeholders: every private value —
 * message text, thinking text, repository/branch/PR identifiers, workspace
 * paths, user ids, agent names, and all tool arguments and results. This file
 * contains no real conversation content and no credential of any kind.
 *
 * Used by test/bin/tracequest-cursor-cloud-import-integration.test.js
 * (facts ccfd, cctn, cctb).
 */

/** toolName values observed on api2 assistant messages, verbatim. */
export const RECORDED_TOOL_NAMES = [
  "run_terminal_cmd",
  "grep",
  "task_v2",
  "read_file",
  "mcp",
  "get_mcp_tools",
  "glob_file_search",
  "search_replace",
];

/** toolName -> the `toolCall.tool` enum observed beside it, verbatim. */
const RECORDED_TOOL_ENUMS = {
  run_terminal_cmd: "CLIENT_SIDE_TOOL_V2_RUN_TERMINAL_COMMAND_V2",
  grep: "CLIENT_SIDE_TOOL_V2_RIPGREP_SEARCH",
  task_v2: "CLIENT_SIDE_TOOL_V2_TASK_V2",
  read_file: "CLIENT_SIDE_TOOL_V2_READ_FILE",
  mcp: "CLIENT_SIDE_TOOL_V2_MCP",
  get_mcp_tools: "CLIENT_SIDE_TOOL_V2_GET_MCP_TOOLS",
  glob_file_search: "CLIENT_SIDE_TOOL_V2_GLOB_FILE_SEARCH",
  search_replace: "CLIENT_SIDE_TOOL_V2_EDIT_FILE",
};

/** Placeholder file path used wherever the recording carried a real path. */
export const FIXTURE_PATH = "placeholder/dir/placeholder-file.txt";

/**
 * One entry of the ListBackgroundComposers `composers` array with the full
 * observed key set (ms fields are JSON numbers, status/source are string
 * enums, repoUrl is observed both with and without a scheme).
 */
export function api2Composer(bcId, overrides = {}) {
  return {
    bcId,
    createdAtMs: 1785189945415,
    workspaceRootPath: "/placeholder/workspace",
    name: `placeholder agent ${bcId}`,
    branchName: `cursor/placeholder-${bcId}`,
    hasStartedVm: true,
    repoUrl: "https://github.com/placeholder-org/placeholder-repo",
    repoUrls: ["https://github.com/placeholder-org/placeholder-repo"],
    status: "BACKGROUND_COMPOSER_STATUS_FINISHED",
    source: "BACKGROUND_COMPOSER_SOURCE_GLASS",
    updatedAtMs: 1785236253467,
    prUrl: "https://github.com/placeholder-org/placeholder-repo/pull/1",
    prStatus: "placeholder-pr-status",
    linesAdded: 12,
    linesRemoved: 3,
    filesChanged: 2,
    modelDetails: { modelName: "placeholder-model", maxMode: false },
    requestedModel: { modelName: "placeholder-model" },
    visibility: "team",
    workflowId: "placeholder-workflow",
    lastMessageActivityAtMs: 1785236253131,
    participantUserIds: ["placeholder-user-id"],
    usePrivateWorker: false,
    isArchived: false,
    isPrMerged: false,
    isUnread: false,
    ...overrides,
  };
}

/** A ListBackgroundComposers response; hasMore/nextPageOffset omitted when
 * absent, exactly as proto3 serializes "no further pages". */
export function api2ListResponse(composers, extra = {}) {
  return {
    composers,
    didLoadStatus: true,
    participants: [
      { userId: "placeholder-user-id", displayName: "Placeholder User", email: "placeholder@example.invalid" },
    ],
    ...extra,
  };
}

/** A toolResults[] entry for one recorded toolName, with the observed
 * rawArgs / typed-params / result key names and placeholder values. */
export function api2ToolResult(toolName, index = 0) {
  const base = {
    toolCallId: `placeholder-tool-call-${index}`,
    toolName,
    toolIndex: index,
    startedAtMs: 1785189946000 + index,
    completedAtMs: 1785189947000 + index,
    toolCall: { tool: RECORDED_TOOL_ENUMS[toolName] || "CLIENT_SIDE_TOOL_V2_UNSPECIFIED", name: toolName },
  };
  switch (toolName) {
    case "run_terminal_cmd":
      base.rawArgs = JSON.stringify({ command: "git commit -m placeholder", is_background: false });
      base.toolCall.rawArgs = base.rawArgs;
      base.toolCall.runTerminalCommandV2Params = { command: "git commit -m placeholder" };
      base.result = { tool: RECORDED_TOOL_ENUMS[toolName], runTerminalCommandV2Result: { output: "placeholder output" } };
      break;
    case "grep":
      base.toolCall.ripgrepSearchParams = {
        patternInfo: { pattern: "placeholderPattern", isRegExp: false, isCaseSensitive: false, isMultiline: false },
      };
      base.result = { tool: RECORDED_TOOL_ENUMS[toolName], ripgrepSearchResult: { results: [] } };
      break;
    case "task_v2":
      base.rawArgs = JSON.stringify({
        name: "placeholder task",
        description: "placeholder description",
        prompt: "placeholder prompt",
        model: "placeholder-model",
        subagent_type: "placeholder-subagent",
      });
      base.toolCall.rawArgs = base.rawArgs;
      base.toolCall.taskV2Params = {
        name: "placeholder task",
        description: "placeholder description",
        prompt: "placeholder prompt",
        model: "placeholder-model",
        subagentType: "placeholder-subagent",
      };
      base.result = { tool: RECORDED_TOOL_ENUMS[toolName], taskV2Result: { summary: "placeholder summary" } };
      break;
    case "read_file":
      base.rawArgs = JSON.stringify({ target_file: FIXTURE_PATH });
      base.toolCall.rawArgs = base.rawArgs;
      base.toolCall.readFileParams = { relativeWorkspacePath: FIXTURE_PATH, readEntireFile: true };
      base.result = { tool: RECORDED_TOOL_ENUMS[toolName], readFileResult: { contents: "placeholder contents" } };
      break;
    case "mcp":
      base.toolCall.mcpParams = {
        tools: [{ name: "placeholder_mcp_tool", serverName: "placeholder-server", parameters: "{}" }],
      };
      base.result = { tool: RECORDED_TOOL_ENUMS[toolName], mcpResult: { selectedTool: "placeholder_mcp_tool" } };
      break;
    case "get_mcp_tools":
      base.toolCall.getMcpToolsParams = { server: "placeholder-server", pattern: "placeholder*" };
      base.result = { tool: RECORDED_TOOL_ENUMS[toolName], getMcpToolsResult: { tools: [] } };
      break;
    case "glob_file_search":
      base.toolCall.globFileSearchParams = { globPattern: "**/placeholder*" };
      base.result = { tool: RECORDED_TOOL_ENUMS[toolName], globFileSearchResult: { files: [] } };
      break;
    case "search_replace":
      base.toolCall.editFileParams = { relativeWorkspacePath: FIXTURE_PATH, blocking: true };
      base.result = { tool: RECORDED_TOOL_ENUMS[toolName], editFileResult: { linesAdded: 1 } };
      break;
    default:
      break;
  }
  return base;
}

/** A MESSAGE_TYPE_HUMAN bubble (observed key set for the first message). */
export function api2HumanMessage(text, index = 0) {
  return {
    text,
    type: "MESSAGE_TYPE_HUMAN",
    bubbleId: `placeholder-bubble-human-${index}`,
    serverBubbleId: `placeholder-server-bubble-human-${index}`,
    richText: JSON.stringify({ root: { children: [] } }),
    triggeringUserInfo: { authId: "placeholder-auth-id", userId: "placeholder-user-id" },
  };
}

/** A MESSAGE_TYPE_AI bubble: any of text, thinking, or toolResults may be
 * absent (about nine in ten recorded AI bubbles carry no text at all). */
export function api2AiMessage({ text, thinking, toolResults, index = 0 } = {}) {
  const message = {
    type: "MESSAGE_TYPE_AI",
    bubbleId: `placeholder-bubble-ai-${index}`,
    serverBubbleId: `placeholder-server-bubble-ai-${index}`,
    stepDurationMs: 1234,
  };
  if (text != null) message.text = text;
  if (thinking != null) {
    message.thinking = { text: thinking, isLastThinkingChunk: true };
    message.thinkingDurationMs = 4321;
  }
  if (toolResults) message.toolResults = toolResults;
  return message;
}

/**
 * A small representative conversation: one HUMAN bubble, one AI bubble with
 * text, one thinking-only AI bubble, one AI bubble per recorded toolName, one
 * empty AI bubble, plus a SYSTEM and an unknown-type bubble.
 */
export function api2Conversation({ humanText = "placeholder human prompt", aiText = "placeholder assistant answer" } = {}) {
  const conversation = [
    api2HumanMessage(humanText, 0),
    api2AiMessage({ text: aiText, index: 1 }),
    api2AiMessage({ thinking: "placeholder reasoning", index: 2 }),
  ];
  RECORDED_TOOL_NAMES.forEach((toolName, i) => {
    conversation.push(api2AiMessage({ toolResults: [api2ToolResult(toolName, i)], index: 3 + i }));
  });
  conversation.push(api2AiMessage({ index: 20 }));
  conversation.push({ type: "MESSAGE_TYPE_SYSTEM", bubbleId: "placeholder-bubble-system", text: "placeholder system note" });
  conversation.push({ type: "MESSAGE_TYPE_FUTURE_UNKNOWN", bubbleId: "placeholder-bubble-unknown", text: "placeholder future note" });
  return { conversation };
}
