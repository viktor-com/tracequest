import { parseSession } from "../parse.js";
import { sumToolCounts } from "../parse/parse-utils.js";
import { renderHTML } from "../render.js";
import { exportMessages } from "../export/messages-export.js";
import { findSessions as discoverCliSessions, buildIndex, peekSession, searchSessions, sortSessionsByMtimeDesc } from "../sessions.js";
import { detectLiveSessions, stampLive } from "../sessions/live-sessions.js";
import { serve } from "../server.js";
// normalizeProjectFolder (not projectLabel) is the single project-normalisation
// used by every CLI printer, so `list` / `find` / `latest` / `search` render the
// exact same project string that /api/sessions returns for the same record.
// projectLabel alone leaves an absolute project path (Grok workspace shape)
// unchanged; normalizeProjectFolder wraps it and collapses to the folder name.
import { isSessionPath, normalizeProjectFolder } from "../server/server-session-path.js";
import { sessionToApiObject, getSessionMeta } from "../server/server-helpers.js";
import { isSessionHash, resolveSessionHandle, sessionHash } from "../sessions/session-hash.js";
import { applyExprToApiObjects, evalFilterExpr, parseFilterExpr, FilterParseError } from "../filter/filter.js";

import { writeFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, basename, join } from "node:path";
import { execFileSync } from "node:child_process";
import { die, formatCliError } from "./cli-die.js";
import { k } from "./cli-color.js";
import { discoverAgentSidecarPaths, loadAgentHistoryForSession } from "../server/agent-history.js";
import { loadSecretRules } from "../share/secret-rules.js";
import { scanSessionForSecrets } from "../share/scanner.js";
import { runSharePipeline, printFindings, confirmShareSync } from "../share/pipeline.js";
import { buildStandupInput, DEFAULT_STANDUP_LIMITS, selectStandupEntries } from "../standup/compact-input.js";
import {
  DEFAULT_AGENT_PROBE_TIMEOUT_MS,
  buildPromptAgentDetectionReport,
  buildPromptAgentInvocation,
  DEFAULT_AGENT_TIMEOUT_MS,
  PROMPT_AGENT_PROBE_PREFLIGHT_NOTICE,
  probePromptAgents,
  runPromptAgent,
  STANDUP_AGENT_ENV,
  standupAgentDefaultsFromEnv,
} from "../standup/agent-runner.js";
import { loadStandupProfile, mergeStandupProfileOptions } from "../standup/profile.js";
import { applyStandupSelectionWindow, resolveStandupSelectionWindow } from "../standup/selection-window.js";
import {
  getPreset,
  mergePresetOptions,
  resolveServePortOrDie,
  RENDER_PRESET_KEYS,
} from "./cli-presets.js";
import {
  RENDER_OUTPUT_OPTIONS,
  showHelp,
  showShareHelp,
} from "./cli-help.js";

export { die } from "./cli-die.js";
export {
  buildHelp,
  RENDER_OUTPUT_HELP,
  RENDER_OUTPUT_OPTIONS,
  SHARE_OPTIONS_HELP,
  showHelp,
  showShareHelp,
  showVersion,
  version,
} from "./cli-help.js";
export {
  parseSimpleYaml,
  loadPreset,
  getPreset,
  mergePresetOptions,
  resolveServePort,
  resolveServePortOrDie,
  isValidServePort,
  invalidServePortMessage,
  RENDER_PRESET_KEYS,
  cmdPresets,
} from "./cli-presets.js";


const DISCOVERY_FILTER_KEYS = new Set(["project", "source", "host", "size", "age", "live"]);
const EMPTY_DISCOVERY_META = {};
let detectLiveSessionsForCliFilter = detectLiveSessions;
// Discovery seam (same shape as detectLiveSessionsForCliFilter): tests inject a
// fixed session list to cover discovery-row shapes the local filesystem cannot
// produce, e.g. an epoch-ms mtime from a sidecar scan or index row.
let findSessions = discoverCliSessions;

function isRecentSort(sort) {
  return !sort || sort === "recent" || sort === "date";
}

function usesOnlyDiscoveryFilterFields(node) {
  if (!node) return true;
  switch (node.type) {
    case "term": return DISCOVERY_FILTER_KEYS.has(node.key);
    case "and":
    case "or": return usesOnlyDiscoveryFilterFields(node.left) && usesOnlyDiscoveryFilterFields(node.right);
    case "not": return usesOnlyDiscoveryFilterFields(node.child);
    default: return false;
  }
}

export function setCliLiveSessionDetectorForTests(detector) {
  detectLiveSessionsForCliFilter = detector || detectLiveSessions;
}

export function setCliSessionFinderForTests(finder) {
  findSessions = finder || discoverCliSessions;
}

function filterUsesField(node, key) {
  if (!node) return false;
  switch (node.type) {
    case "term": return node.key === key;
    case "and":
    case "or": return filterUsesField(node.left, key) || filterUsesField(node.right, key);
    case "not": return filterUsesField(node.child, key);
    default: return false;
  }
}

function buildLivePathSetForFilter(sessions, ast) {
  if (!filterUsesField(ast, "live")) return null;
  return new Set(detectLiveSessionsForCliFilter(sessions));
}

function sessionToCliFilterObject(session, meta, livePathSet) {
  const obj = sessionToApiObject(session, meta);
  if (livePathSet) stampLive(obj, livePathSet);
  return obj;
}

/**
 * Apply --filter expression and --sort to a discovered session list.
 * Returns an array of session-discovery objects (same shape as findSessions
 * output) so callers can still use .path / .mtime / .project / .size etc.
 *
 * When expr is set, we build the index, convert to API objects (so the filter
 * evaluator has access to model, tools, tokens, etc.), filter, sort, then map
 * back to the original session objects (preserving order).
 */
function applyExprFilter(sessions, expr, sort) {
  try {
    return applyExprFilterUnsafe(sessions, expr, sort);
  } catch (err) {
    if (err instanceof FilterParseError) die(err.message);
    throw err;
  }
}

function applyExprFilterUnsafe(sessions, expr, sort) {
  const exprTrimmed = expr && String(expr).trim();
  const ast = exprTrimmed ? parseFilterExpr(exprTrimmed) : null;
  const livePathSet = buildLivePathSetForFilter(sessions, ast);
  if (!exprTrimmed && (sort === "recent" || sort === "date")) {
    return sortSessionsByMtimeDesc([...sessions]);
  }
  if (exprTrimmed && isRecentSort(sort)) {
    if (usesOnlyDiscoveryFilterFields(ast)) {
      if (!ast) return sortSessionsByMtimeDesc([...sessions]);
      const now = Date.now();
      const filtered = [];
      for (const session of sessions) {
        if (evalFilterExpr(sessionToCliFilterObject(session, EMPTY_DISCOVERY_META, livePathSet), ast, now, null)) {
          filtered.push(session);
        }
      }
      return sortSessionsByMtimeDesc(filtered);
    }
  }

  const index = buildIndex(sessions);
  const apiObjects = sessions.map((s) => {
    const meta = getSessionMeta(index, s, peekSession);
    const obj = sessionToCliFilterObject(s, meta, livePathSet);
    obj._origSession = s;
    return obj;
  });

  return applyExprToApiObjects(apiObjects, expr, sort).map((obj) => obj._origSession);
}

function markdownInlineCode(value) {
  const text = String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "`(none)`";
  const runs = text.match(/`+/g) || [""];
  const fence = "`".repeat(Math.max(...runs.map((run) => run.length)) + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function shellQuote(value) {
  const text = String(value ?? "");
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function compactHandoffText(value, max = 160) {
  const text = String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function asCliArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeHandoffSort(sort) {
  const value = String(sort || "relevance").trim().toLowerCase();
  if (!value || value === "relevance" || value === "score") return "relevance";
  if (value === "recent" || value === "date") return value;
  die(`Invalid handoff sort: ${sort}\nSupported sorts: relevance, recent, date`);
}

function sortSearchHandoffResults(results, sort) {
  if (sort !== "recent" && sort !== "date") return results;
  return [...results].sort((a, b) => (Number(b.mtime) || 0) - (Number(a.mtime) || 0));
}

function parseCliParams(values) {
  const params = {};
  for (const raw of asCliArray(values.param)) {
    const text = String(raw);
    const idx = text.indexOf("=");
    const key = idx >= 0 ? text.slice(0, idx).trim() : text.trim();
    if (!key) continue;
    const value = idx >= 0 ? text.slice(idx + 1) : true;
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      if (!Array.isArray(params[key])) params[key] = [params[key]];
      params[key].push(value);
    } else {
      params[key] = value;
    }
  }
  return params;
}

function parseAgentTimeoutMs(values, envDefaults = {}) {
  const hasCliTimeout = values["agent-timeout-ms"] != null || values.agentTimeoutMs != null;
  const raw = hasCliTimeout
    ? (values["agent-timeout-ms"] ?? values.agentTimeoutMs)
    : envDefaults.timeoutMs;
  if (raw == null) return DEFAULT_AGENT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) {
    const source = hasCliTimeout ? "--agent-timeout-ms" : STANDUP_AGENT_ENV.timeoutMs;
    die(`Invalid ${source}: ${raw}\nUse a positive integer number of milliseconds.`);
  }
  return n;
}

function parseAgentProbeTimeoutMs(values) {
  const raw = values["agent-timeout-ms"] ?? values.agentTimeoutMs;
  if (raw == null) return DEFAULT_AGENT_PROBE_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) {
    die(`Invalid --agent-timeout-ms: ${raw}\nUse a positive integer number of milliseconds.`);
  }
  return n;
}

function firstOptionValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function formatArgv(command, args = []) {
  return [command, ...args].map(shellQuote).join(" ");
}

function compactDiagnosticSnippet(value, max = 700) {
  const text = String(value || "")
    .replace(/\r/g, "")
    .trim();
  if (!text) return "(empty)";
  if (text.length <= max) return text;
  const marker = "\n... [truncated] ...\n";
  if (max <= marker.length + 2) {
    return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
  }
  const available = max - marker.length;
  const headLength = Math.ceil(available * 0.45);
  const tailLength = available - headLength;
  const head = text.slice(0, headLength).trimEnd();
  const tail = text.slice(text.length - tailLength).trimStart();
  return `${head}${marker}${tail}`;
}

/**
 * Turn a raw agent failure into an actionable tracequest hint when the output
 * matches a known, fixable cause. Returns "" when nothing specific applies.
 */
function standupFailureHint(result) {
  const blob = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (/trusted directory|skip-git-repo-check|not inside a trusted/i.test(blob)) {
    return "Hint: the agent refused to run outside a trusted git repo. Run standup from inside a git repository, or pass --agent-arg=--skip-git-repo-check, or select a different agent with --agent-command <cmd>.";
  }
  if (/not logged in|unauthorized|authentication|api key|login/i.test(blob)) {
    return "Hint: the agent appears unauthenticated. Log the agent CLI in (e.g. `codex login` / `claude login`), or select another with --agent-command <cmd>.";
  }
  return "";
}

function exitStandupAgentFailure(result) {
  const command = formatArgv(result.command, result.args);
  const stdoutSnippet = compactDiagnosticSnippet(result.stdout);
  const stderrSnippet = compactDiagnosticSnippet(result.stderr);
  const code = Number.isInteger(result.status) && result.status > 0 ? result.status : 1;
  const summary = result.timedOut
    ? `Standup agent timed out after ${result.timeoutMs}ms.`
    : result.stdinError
      ? `Standup agent stdin write failed: ${result.stdinError.message}.`
      : result.signal
      ? `Standup agent exited from signal ${result.signal}.`
      : `Standup agent failed with exit code ${result.status}.`;
  if (result.stderr && !result.stderr.endsWith("\n")) process.stderr.write("\n");
  const hint = standupFailureHint(result);
  console.error(formatCliError([
    summary,
    `Command: ${command}`,
    `Stdout: ${stdoutSnippet}`,
    `Stderr: ${stderrSnippet}`,
    ...(hint ? [hint] : []),
  ].join("\n")));
  process.exit(code);
}

function resolveStandupAgentOptions(values) {
  let envAgentDefaults;
  try {
    envAgentDefaults = standupAgentDefaultsFromEnv();
  } catch (err) {
    die(err.message || String(err));
  }
  const configuredAgentCommand = firstOptionValue(values["agent-command"], values.agentCommand);
  const hasConfiguredAgentCommand = configuredAgentCommand !== undefined;
  const hasCliAgentArgs = values["agent-arg"] != null || values.agentArg != null;
  const agentCommand = hasConfiguredAgentCommand
    ? configuredAgentCommand
    : envAgentDefaults.command;
  const agentArgs = hasCliAgentArgs
    ? asCliArray(values["agent-arg"] || values.agentArg)
    : hasConfiguredAgentCommand
      ? []
      : envAgentDefaults.args;
  const params = parseCliParams(values);
  const timeoutMs = parseAgentTimeoutMs(values, envAgentDefaults);
  let invocation;
  try {
    invocation = buildPromptAgentInvocation({
      command: agentCommand,
      args: agentArgs,
      params,
      cwd: process.cwd(),
    });
  } catch (err) {
    die(err.message || String(err));
  }
  return { invocation, timeoutMs };
}

function formatSearchHandoff(query, results, { limit, entryCommand = "search", filter = "", sort = "relevance" }) {
  const refreshParts = entryCommand === "handoff"
    ? ["tracequest", "handoff", shellQuote(query)]
    : ["tracequest", "search", shellQuote(query), "--format", "handoff"];
  if (filter) refreshParts.push("--filter", shellQuote(filter));
  if (sort && sort !== "relevance") refreshParts.push("--sort", shellQuote(sort));
  refreshParts.push("--limit", String(limit));
  const refreshCommand = refreshParts.join(" ");
  const lines = [
    "# TraceQuest Search Handoff",
    "",
    `- Query: ${markdownInlineCode(query)}`,
    `- Sort: ${markdownInlineCode(sort || "relevance")}`,
    `- Results: ${results.length}`,
    "- Privacy: includes session hashes, metadata, and capped TraceQuest search snippets; no full transcripts or absolute paths.",
    "",
    "## Follow-up Commands",
    "",
    `- Refresh this handoff: ${markdownInlineCode(refreshCommand)}`,
    "",
    "## Matches",
    "",
  ];

  if (!results.length) {
    lines.push("No matching sessions found.", "");
    return lines.join("\n");
  }

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const hash = r.id || r.sessionHash || sessionHash(r.path);
    const date = r.mtime ? new Date(r.mtime).toISOString().slice(0, 16).replace("T", " ") : "(unknown)";
    const source = r.source || "claude";
    // normalizeProjectFolder (not projectLabel) so an absolute project path
    // collapses to a folder name — the header promises no absolute paths.
    const project = normalizeProjectFolder(r.project);
    const prompt = compactHandoffText(r.prompt, 120);
    const matches = Array.isArray(r.matches) ? r.matches : [];

    lines.push(`${i + 1}. Session ${markdownInlineCode(hash)}`);
    lines.push(`   - Date: ${markdownInlineCode(date)}`);
    lines.push(`   - Source: ${markdownInlineCode(source)}`);
    lines.push(`   - Project: ${markdownInlineCode(project)}`);
    if (prompt) {
      lines.push(`   - First prompt: ${markdownInlineCode(prompt)}`);
    }
    lines.push("   - Snippets:");
    if (!matches.length) {
      lines.push("     - `(no snippets returned)`");
    } else {
      for (const m of matches) {
        const tag = m.type === "text" ? "match" : (m.type || "match");
        lines.push(`     - ${markdownInlineCode(tag)}: ${markdownInlineCode(compactHandoffText(m.snippet))}`);
      }
    }
    lines.push("   - Commands:");
    lines.push(`     - ${markdownInlineCode(`tracequest render ${shellQuote(hash)}`)}`);
    lines.push(`     - ${markdownInlineCode(`tracequest messages ${shellQuote(hash)} --pretty`)}`);
    lines.push("");
  }

  return lines.join("\n");
}

/** Structured JSON record for a discovered session (find/list --json). */
function sessionJsonRecord(s) {
  const rec = {
    date: new Date(s.mtime).toISOString().slice(0, 16).replace("T", " "),
    source: s.source || "claude",
    sessionHash: sessionHash(s.path),
    sizeKB: (s.size / 1024) | 0,
    project: normalizeProjectFolder(s.project),
    path: s.path,
  };
  if (s.host) rec.host = s.host;
  return rec;
}

function formatSourceColumn(s) {
  const src = s.source || "claude";
  return s.host ? `${src}@${s.host}` : src;
}

/** Emit compact JSON to stdout with a trailing newline (machine-readable output). */
function emitJson(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

function printSessionStats(session) {
  const toolCalls = sumToolCounts(session.stats.toolCounts);
  console.log(k.dim(`  ${session.eventCount} events, ${session.stats.assistantTurns} turns, ${toolCalls} tool calls`));
  if (session.eventCount === 0) {
    console.warn(k.yellow("  Warning: 0 events parsed — is this a valid agent session file?"));
  }
}

export function openInBrowser(target) {
  // TRACEQUEST_OPEN_CMD overrides the platform launcher (a single executable
  // path/name resolved via PATH) so tests can stub browser opening.
  const cmd = process.env.TRACEQUEST_OPEN_CMD || (process.platform === "darwin" ? "open" : "xdg-open");
  try {
    // Pass the target as a literal argument (no shell) so paths containing
    // spaces or shell metacharacters cannot trigger command injection.
    execFileSync(cmd, [target], { stdio: "ignore" });
  } catch (err) {
    console.warn(k.yellow(`Warning: could not open browser: ${err.message}`));
  }
}

export function renderAndWrite(session, outPath, shouldOpen) {
  console.log(k.dim("Rendering..."));
  const html = renderHTML(session);
  const output = outPath || `tracequest-${session.sessionHash || session.sessionId?.slice(0, 8) || "session"}.html`;
  try {
    writeFileSync(output, html);
    console.log(k.green(`Written: ${output} (${(Buffer.byteLength(html) / 1024) | 0}KB)`));
  } catch (err) {
    die(`Failed to write output to ${output}: ${err.message}`);
  }
  if (shouldOpen) {
    openInBrowser(output);
  }
}

export function parseAndRender(inputFile, values) {
  console.log(k.dim("Parsing session..."));
  let session;
  try {
    session = parseSession(inputFile);
  } catch (err) {
    die(`Failed to parse session ${inputFile}: ${err.message}`);
  }
  printSessionStats(session);
  renderAndWrite(session, values.out, values.open);
}

function resolveCliSessionInputInfo(inputFile) {
  if (!inputFile) return null;
  if (inputFile.startsWith("opencode://")) {
    if (!isSessionPath(inputFile)) {
      die(`Invalid OpenCode session path: ${inputFile}`);
    }
    return { path: inputFile, discovery: null };
  }
  const resolved = resolve(inputFile);
  if (existsSync(resolved)) {
    let st;
    try {
      st = statSync(resolved);
    } catch (e) {
      die(`File not accessible: ${resolved}: ${e.message}`);
    }
    if (st.isDirectory()) {
      const base = basename(resolved);
      if (base === "sessions" || base === "projects") {
        die(`Expected a specific session file or session directory, not top-level agent dir '${base}': ${resolved}`);
      }
      if (!existsSync(join(resolved, "chat_history.jsonl"))) {
        die(`Not a session file: '${resolved}' is a directory.\nPass a .jsonl session file (or a Grok session directory containing chat_history.jsonl).`);
      }
    }
    return { path: resolved, discovery: null };
  }
  if (isSessionHash(inputFile)) {
    const sessions = findSessions(null);
    const resolved = resolveSessionHandle(inputFile, sessions);
    if (resolved.status === "ok") return { path: resolved.session.path, discovery: resolved.session };
    if (resolved.status === "ambiguous") die(`Ambiguous session hash: ${inputFile}. Pass the full session path.`);
    die(`Session hash not found: ${inputFile}`);
  }
  die(`File not found: ${resolved}`);
}

/** Resolve CLI session input: filesystem paths, opencode:// virtual URIs, or session hashes. */
export function resolveCliSessionInput(inputFile) {
  return resolveCliSessionInputInfo(inputFile)?.path ?? null;
}

export function cmdRender(positionals, values) {
  if (values.help) showHelp();
  const preset = getPreset(values.preset);
  const opts = mergePresetOptions(values, preset, RENDER_PRESET_KEYS);
  const inputFile = positionals[0];
  if (!inputFile) die("tracequest render <session.jsonl>\nPass a session file path.");
  parseAndRender(resolveCliSessionInput(inputFile), opts);
}

export function cmdLatest(positionals, values) {
  if (values.help) showHelp();
  const preset = getPreset(values.preset);
  const opts = mergePresetOptions(values, preset, RENDER_PRESET_KEYS);
  const filter = positionals[0] || null;
  let sessions = findSessions(filter);
  if (!sessions.length) die("No sessions found.");
  if (values.filter || values.sort) {
    sessions = applyExprFilter(sessions, values.filter, values.sort);
    if (!sessions.length) die("No sessions match the filter expression.");
  }
  const rawLimit = values.limit ? Number(values.limit) : 1;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 1;
  if (limit === 1) {
    const inputFile = sessions[0].path;
    console.log(k.dim(`Latest: ${sessionHash(inputFile)} ${basename(inputFile)}`));
    parseAndRender(inputFile, opts);
  } else {
    const shown = sessions.slice(0, limit);
    console.log(k.bold(`Top ${shown.length} latest sessions:\n`));
    for (const s of shown) {
      const sizeKB = (s.size / 1024) | 0;
      const date = new Date(s.mtime).toISOString().slice(0, 16).replace("T", " ");
      const proj = normalizeProjectFolder(s.project);
      const src = formatSourceColumn(s).padEnd(8);
      console.log(`  ${k.dim(date)}  ${k.cyan(src)}  ${k.bold(sessionHash(s.path))}  ${String(sizeKB).padStart(6)}KB  ${k.bold(proj.padEnd(24))}  ${k.dim(s.path)}`);
    }
    if (sessions.length > limit) {
      console.log(k.dim(`\n  ... and ${sessions.length - limit} more`));
    }
    process.exit(0);
  }
}

export function cmdList(positionals, values) {
  if (values.help) showHelp();
  const asJson = Boolean(values.json);
  const status = asJson ? console.error : console.log;
  const filter = positionals[0] || null;
  let sessions = findSessions(filter);
  if (!sessions.length) {
    status(k.yellow("No sessions found."));
    if (asJson) emitJson([]);
    process.exit(0);
  }
  if (values.filter || values.sort) {
    sessions = applyExprFilter(sessions, values.filter, values.sort);
    if (!sessions.length) {
      status(k.yellow("No sessions match the filter expression."));
      if (asJson) emitJson([]);
      process.exit(0);
    }
  }
  const rawLimit = values.limit ? Number(values.limit) : 20;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 20;
  const shown = sessions.slice(0, limit);
  if (asJson) {
    emitJson(shown.map(sessionJsonRecord));
    process.exit(0);
  }
  console.log(k.bold(`Found ${sessions.length} sessions:\n`));
  for (const s of shown) {
    const sizeKB = (s.size / 1024) | 0;
    const date = new Date(s.mtime).toISOString().slice(0, 16).replace("T", " ");
    const proj = normalizeProjectFolder(s.project);
    const src = formatSourceColumn(s).padEnd(8);
    console.log(`  ${k.dim(date)}  ${k.cyan(src)}  ${k.bold(sessionHash(s.path))}  ${String(sizeKB).padStart(6)}KB  ${k.bold(proj.padEnd(24))}  ${k.dim(s.path)}`);
  }
  if (sessions.length > limit) {
    console.log(k.dim(`\n  ... and ${sessions.length - limit} more (use --limit N to show more, or 'tracequest serve' for full browser)`));
  }
  process.exit(0);
}

export function cmdFind(positionals, values) {
  if (values.help) showHelp();
  const asJson = Boolean(values.json);
  const status = asJson ? console.error : console.log;
  const positionalFilter = positionals.join(" ").trim();
  const flagFilter = values.filter ? String(values.filter).trim() : "";
  const filter = positionalFilter && flagFilter
    ? `(${positionalFilter}) AND (${flagFilter})`
    : positionalFilter || flagFilter;
  const hasFilter = Boolean(filter);
  const defaultLimit = hasFilter ? 20 : 10;
  const rawLimit = values.limit ? Number(values.limit) : defaultLimit;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : defaultLimit;
  let sessions = findSessions(null);
  if (!sessions.length) {
    status(k.yellow("No sessions found."));
    if (asJson) emitJson([]);
    process.exit(0);
  }
  if (hasFilter) {
    sessions = applyExprFilter(sessions, filter, values.sort || "recent");
    if (!sessions.length) {
      status(k.yellow("No sessions match the expression."));
      if (asJson) emitJson([]);
      process.exit(0);
    }
  } else {
    // findSessions already returns mtime-desc order; copy to avoid mutating discovery list.
    sessions = [...sessions];
  }
  const shown = sessions.slice(0, limit);
  if (asJson) {
    emitJson(shown.map(sessionJsonRecord));
    process.exit(0);
  }
  console.log(k.bold(`Found ${sessions.length} sessions:\n`));
  for (const s of shown) {
    const sizeKB = (s.size / 1024) | 0;
    const date = new Date(s.mtime).toISOString().slice(0, 16).replace("T", " ");
    const proj = normalizeProjectFolder(s.project);
    const src = formatSourceColumn(s).padEnd(8);
    console.log(`  ${k.dim(date)}  ${k.cyan(src)}  ${k.bold(sessionHash(s.path))}  ${String(sizeKB).padStart(6)}KB  ${k.bold(proj.padEnd(24))}  ${k.dim(s.path)}`);
  }
  if (sessions.length > limit) {
    console.log(k.dim(`\n  ... and ${sessions.length - limit} more (use --limit N to show more, or 'tracequest serve' for full browser)`));
  }
  process.exit(0);
}

export function cmdSearch(positionals, values) {
  if (values.help) showHelp();
  const query = positionals.join(" ").trim() || null;
  const usageCommand = values.usageCommand || "search";
  if (!query) {
    const usage = usageCommand === "handoff"
      ? "tracequest handoff <query>\nProvide a search query. Examples:\n  tracequest handoff \"error handling\"\n  tracequest handoff \"deploy\" --sort recent --limit 5"
      : "tracequest search <query>\nProvide a search query. Examples:\n  tracequest search \"parseSession\"\n  tracequest search \"error handling\" --limit 5";
    die(usage);
  }
  const format = values.format || "text";
  if (format !== "text" && format !== "handoff") {
    die(`Invalid search format: ${format}\nSupported formats: text, handoff`);
  }
  const isHandoff = format === "handoff";
  if (!isHandoff && values.sort) {
    die("search --sort is only supported with --format handoff\nUse tracequest handoff <query> --sort recent for Markdown handoffs.");
  }
  const handoffSort = isHandoff ? normalizeHandoffSort(values.sort) : "relevance";
  const asJson = Boolean(values.json) && !isHandoff;
  const status = (isHandoff || asJson) ? console.error : console.log;
  const rawLimit = values.limit ? Number(values.limit) : 20;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 20;
  status(k.dim("Discovering sessions..."));
  let sessions = findSessions(null);
  if (!sessions.length) {
    if (isHandoff) {
      process.stdout.write(formatSearchHandoff(query, [], {
        limit,
        entryCommand: values.handoffEntryCommand,
        filter: values.filter || "",
        sort: handoffSort,
      }) + "\n");
      process.exit(0);
    }
    status(k.yellow("No sessions found."));
    if (asJson) emitJson([]);
    process.exit(0);
  }
  if (values.filter) {
    status(k.dim("Filtering sessions..."));
    sessions = applyExprFilter(sessions, values.filter, "recent");
    if (!sessions.length) {
      if (isHandoff) {
        process.stdout.write(formatSearchHandoff(query, [], {
          limit,
          entryCommand: values.handoffEntryCommand,
          filter: values.filter || "",
          sort: handoffSort,
        }) + "\n");
        process.exit(0);
      }
      status(k.yellow("No sessions match the filter expression."));
      if (asJson) emitJson([]);
      process.exit(0);
    }
  }
  status(k.dim(`Building index for ${sessions.length} sessions...`));
  const index = buildIndex(sessions);
  const isHandoffRecentSort = isHandoff && (handoffSort === "recent" || handoffSort === "date");
  const rawResults = searchSessions(
    sessions,
    index,
    query,
    limit,
    isHandoffRecentSort ? { sort: handoffSort } : undefined,
  );
  const results = isHandoff
    ? sortSearchHandoffResults(rawResults, handoffSort).slice(0, limit)
    : rawResults;
  if (isHandoff) {
    process.stdout.write(formatSearchHandoff(query, results, {
      limit,
      entryCommand: values.handoffEntryCommand,
      filter: values.filter || "",
      sort: handoffSort,
    }) + "\n");
    process.exit(0);
  }
  if (asJson) {
    const sizeByPath = new Map(sessions.map((s) => [s.path, s.size]));
    const records = results.map((r) => ({
      date: new Date(r.mtime).toISOString().slice(0, 16).replace("T", " "),
      source: r.source || "claude",
      ...(r.host ? { host: r.host } : {}),
      sessionHash: r.id || r.sessionHash || sessionHash(r.path),
      sizeKB: ((sizeByPath.get(r.path) || 0) / 1024) | 0,
      project: normalizeProjectFolder(r.project),
      path: r.path,
      prompt: r.prompt || "",
      matches: (r.matches || []).map((m) => ({ field: m.type, snippet: m.snippet })),
    }));
    status(k.dim(`Found ${records.length} result${records.length === 1 ? "" : "s"} for "${query}"`));
    emitJson(records);
    process.exit(0);
  }
  if (!results.length) {
    console.log(k.yellow(`No sessions match query: "${query}"`));
    process.exit(0);
  }
  console.log(k.bold(`Found ${results.length} result${results.length === 1 ? "" : "s"} for "${query}":\n`));
  for (const r of results) {
    const date = new Date(r.mtime).toISOString().slice(0, 16).replace("T", " ");
    const src = formatSourceColumn(r).padEnd(8);
    const proj = normalizeProjectFolder(r.project);
    const prompt = r.prompt ? r.prompt.slice(0, 80).replace(/\n/g, " ") : "";
    console.log(`  ${k.dim(date)}  ${k.cyan(src)}  ${k.bold(r.id || r.sessionHash || sessionHash(r.path))}  ${k.bold(proj.padEnd(24))}  ${k.dim(r.path)}`);
    if (prompt) {
      console.log(`    ${k.dim("prompt:")} ${prompt}${r.prompt.length > 80 ? "..." : ""}`);
    }
    for (const m of r.matches) {
      const tag = m.type === "text" ? "match" : m.type;
      const color = m.type === "error" ? k.red : m.type === "file" ? k.cyan : m.type === "command" ? k.yellow : k.dim;
      console.log(`    ${k.dim(tag + ":")} ${color(m.snippet)}`);
    }
    console.log("");
  }
  process.exit(0);
}

export function cmdHandoff(positionals, values) {
  if (values.help) showHelp();
  cmdSearch(positionals, {
    ...values,
    format: "handoff",
    handoffEntryCommand: "handoff",
    usageCommand: "handoff",
  });
}

export async function cmdStandup(positionals, values) {
  if (values.help) showHelp();
  if (values["probe-agents"] || values.probeAgents) {
    process.stderr.write(`${PROMPT_AGENT_PROBE_PREFLIGHT_NOTICE}\n`);
    const probeCwd = mkdtempSync(join(tmpdir(), "tracequest-standup-agent-probe-"));
    let report;
    try {
      report = await probePromptAgents({
        cwd: probeCwd,
        timeoutMs: parseAgentProbeTimeoutMs(values),
      });
    } finally {
      rmSync(probeCwd, { recursive: true, force: true });
    }
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    process.exit(report.summary.failed > 0 ? 1 : 0);
  }
  if (values.profile) {
    try {
      const profile = loadStandupProfile(values.profile);
      values = mergeStandupProfileOptions(values, profile.values);
    } catch (err) {
      die(err.message || String(err));
    }
  }

  if (values["dry-run-agent-detection"] || values.dryRunAgentDetection) {
    const { invocation, timeoutMs } = resolveStandupAgentOptions(values);
    process.stdout.write(JSON.stringify(buildPromptAgentDetectionReport(invocation, { timeoutMs }), null, 2) + "\n");
    process.exit(0);
  }

  const projectFilter = positionals[0] || values.project || null;
  const rawLimit = values.limit ? Number(values.limit) : DEFAULT_STANDUP_LIMITS.maxSessions;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_STANDUP_LIMITS.maxSessions;
  let selectionWindow;
  try {
    selectionWindow = resolveStandupSelectionWindow(values);
  } catch (err) {
    die(err.message || String(err));
  }

  let sessions = findSessions(projectFilter);
  if (!sessions.length) die("No sessions found.");
  if (selectionWindow) {
    sessions = applyStandupSelectionWindow(sessions, selectionWindow);
    if (!sessions.length) die(`No sessions match standup selection window: ${selectionWindow.label}.`);
  }

  const printInput = values["print-input"] || values.printInput;
  const agentOptions = printInput ? null : resolveStandupAgentOptions(values);

  if (values.filter || values.sort) {
    sessions = applyExprFilter(sessions, values.filter, values.sort || "recent");
    if (!sessions.length) die("No sessions match the filter expression.");
  } else {
    sessions = selectStandupEntries(sessions, { maxSessions: limit });
  }

  const selected = sessions.slice(0, limit);
  const entries = [];
  for (const discovery of selected) {
    let session;
    try {
      session = parseSession(discovery.path, discovery.source);
    } catch (err) {
      die(`Failed to parse session ${discovery.path}: ${err.message}`);
    }
    entries.push({ session, discovery });
  }

  const input = buildStandupInput(entries, {
    project: projectFilter,
    filter: values.filter || "",
    window: selectionWindow?.label || "",
    limits: { maxSessions: limit },
  });

  if (printInput) {
    process.stdout.write(input + "\n");
    process.exit(0);
  }

  const { invocation, timeoutMs } = agentOptions;

  console.error(k.dim(`Running standup agent: ${formatArgv(invocation.command, invocation.args)} (timeout ${timeoutMs}ms)`));

  let result;
  try {
    result = await runPromptAgent(input, {
      invocation,
      timeoutMs,
      onStdout: (chunk) => { process.stdout.write(chunk); },
      onStderr: (chunk) => { process.stderr.write(chunk); },
    });
  } catch (err) {
    die(err.message || String(err));
  }

  if (result.timedOut || result.stdinError || result.signal || (result.status && result.status !== 0)) {
    exitStandupAgentFailure(result);
  }
}

export function cmdMessages(positionals, values) {
  if (values.help) showHelp();
  const latest = values.latest || values["latest"];
  if (!latest && (values.filter || values.sort)) {
    die("tracequest messages --latest [project] --filter <expr>\n--filter and --sort require --latest because positional input is a session path.");
  }
  const resolved = latest
    ? resolveLatestSessionForMessages(positionals, values)
    : resolveExplicitMessageSession(positionals);
  const format = values.format || "anthropic";
  if (format !== "anthropic" && format !== "openai") {
    die(`Invalid format: ${format}\nSupported formats: anthropic, openai`);
  }
  const full = Boolean(values.full || values["no-truncate"]);
  console.error(k.dim(full ? "Parsing session (untruncated)..." : "Parsing session..."));
  let session;
  try {
    session = parseSession(resolved, undefined, { full });
  } catch (err) {
    die(`Failed to parse session ${resolved}: ${err.message}`);
  }
  const result = exportMessages(session, { format });
  const json = values.pretty
    ? JSON.stringify(result, null, 2)
    : JSON.stringify(result);
  if (values.out) {
    const outPath = resolve(values.out);
    try {
      writeFileSync(outPath, json + "\n");
    } catch (err) {
      die(`Failed to write output to ${outPath}: ${err.message}`);
    }
    console.error(k.green(`Written: ${outPath} (${(Buffer.byteLength(json) / 1024) | 0}KB)`));
  } else {
    process.stdout.write(json + "\n");
  }
}

function resolveExplicitMessageSession(positionals) {
  const inputFile = positionals[0];
  if (!inputFile) die("tracequest messages <session.jsonl>\nPass a session file path, or use --latest.");
  return resolveCliSessionInput(inputFile);
}

function resolveLatestSessionForMessages(positionals, values) {
  const projectFilter = positionals[0] || null;
  let sessions = findSessions(projectFilter);
  if (!sessions.length) die("No sessions found.");
  if (values.filter || values.sort) {
    sessions = applyExprFilter(sessions, values.filter, values.sort);
    if (!sessions.length) die("No sessions match the filter expression.");
  }
  return sessions[0].path;
}

function resolveShareSession(positionals, values) {
  if (values.latest || values.filter) {
    const projectFilter = positionals[0] || null;
    let sessions = findSessions(projectFilter);
    if (!sessions.length) die("No sessions found.");
    if (values.filter || values.sort) {
      sessions = applyExprFilter(sessions, values.filter, values.sort);
      if (!sessions.length) die("No sessions match the filter expression.");
    }
    return { path: sessions[0].path, discovery: sessions[0] };
  }

  const inputFile = positionals[0];
  if (!inputFile) {
    die("tracequest share <session.jsonl>\nPass a session file path, or use --latest / --filter.");
  }
  return resolveCliSessionInputInfo(inputFile);
}

export async function cmdShare(positionals, values) {
  if (values.help) showShareHelp();

  const target = values.target || "gist";
  if (target !== "gist" && target !== "hf") {
    die(`Invalid --target: ${target}\nUse gist or hf.`);
  }

  const { path: sessionPath, discovery } = resolveShareSession(positionals, values);

  console.error(k.dim("Parsing session..."));
  let session;
  try {
    session = parseSession(sessionPath);
  } catch (err) {
    die(`Failed to parse session ${sessionPath}: ${err.message}`);
  }

  const sidecars = discoverAgentSidecarPaths(sessionPath);
  if (sidecars.length) {
    const agentHistory = loadAgentHistoryForSession(sessionPath, sidecars);
    if (agentHistory) {
      session.agentHistory = agentHistory;
      session.agentSidecarCount = sidecars.length;
    }
  }

  const rules = loadSecretRules();
  const findings = scanSessionForSecrets(session, rules);
  if (findings.length) {
    console.error(k.yellow(`Scanning session for secrets... ${findings.length} finding(s)`));
    printFindings(findings, k);
    if (!confirmShareSync(findings, values.force)) {
      console.error(k.yellow("Share aborted."));
      process.exit(1);
    }
  } else {
    console.error(k.dim("Scanning session for secrets... none found"));
  }

  let result;
  try {
    result = await runSharePipeline({
      session,
      findings,
      discovery,
      target,
      isPrivate: !!values.private,
      hfRepo: values["hf-repo"] || values.hfRepo || null,
    });
  } catch (err) {
    die(err.message || String(err));
  }

  if (values.json) {
    const out = {
      sessionId: result.sessionId,
      sessionHash: result.sessionHash,
      source: result.source,
      model: result.model,
      project: result.project,
      firstPrompt: result.firstPrompt,
      chapterCount: result.chapterCount,
      target: result.target,
      url: result.url,
      findings: result.findings,
      private: result.private,
    };
    if (result.gistUrl) out.gistUrl = result.gistUrl;
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(k.green(`Shared: ${result.url}`));
    if (result.gistUrl) {
      console.log(k.dim(`  Gist: ${result.gistUrl}`));
    }
    if (result.findings.length) {
      console.log(k.dim(`  (${result.findings.length} secret(s) redacted before upload)`));
    }
  }

  if (values.open && result.url) {
    openInBrowser(result.url);
  }
}

function printImportSummary(summary, dryRun) {
  const prefix = dryRun ? "dry-run summary" : "import summary";
  console.log(
    `${prefix}: ${summary.checked} checked, ${summary.fetched} fetched, ` +
      `${summary.imported} imported, ${summary.updated} updated, ${summary.skipped} skipped, ${summary.failed} failed`,
  );
  if (summary.failed > 0) process.exit(1);
}

export async function cmdLimits(_positionals, values) {
  if (values.help) showHelp();
  const host = values.host || null;
  let snapshot;
  try {
    if (host) {
      const { readUsageSnapshot } = await import("../usage/snapshot.js");
      snapshot = readUsageSnapshot(host);
      if (!snapshot) {
        die(`No usage-limits snapshot for host ${host}.\nRun: tracequest import ssh ${host}`);
      }
    } else {
      const { collectUsageLimits } = await import("../usage/collect.js");
      snapshot = await collectUsageLimits();
    }
  } catch (err) {
    die(err?.message || String(err));
  }
  if (values.json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  const { formatUsageLimits } = await import("../usage/format.js");
  console.log(formatUsageLimits(snapshot));
}

export async function cmdImport(positionals, values) {
  if (values.help) showHelp();

  const source = positionals[0];
  if (!source) {
    die("tracequest import <source>\nSupported import sources: cursor-cloud, ssh");
  }
  const dryRun = Boolean(values["dry-run"]);
  const full = Boolean(values.full);

  if (source === "ssh") {
    const {
      assertIdentityPath,
      loadImportHostsFile,
      parseSshPort,
      runSshImport,
    } = await import("../import/ssh-import.js");
    let identity;
    let port;
    try {
      identity = assertIdentityPath(values.identity);
      port = parseSshPort(values.port);
    } catch (err) {
      die(err?.message || String(err));
    }
    let hosts = positionals.slice(1);
    if (!hosts.length) hosts = loadImportHostsFile();
    if (!hosts.length) {
      die("tracequest import ssh <host> [host...]\nOr list hosts in ~/.tracequest/import-hosts (one per line).");
    }
    let summary;
    try {
      summary = await runSshImport({
        hosts,
        dryRun,
        full,
        identity,
        port,
        as: values.as || null,
        out: (line) => console.log(line),
        warn: (line) => console.error(k.yellow(line)),
      });
    } catch (err) {
      die(err?.message || String(err));
    }
    printImportSummary(summary, dryRun);
    return;
  }

  if (source !== "cursor-cloud") {
    die(`Unknown import source: ${source}\nSupported import sources: cursor-cloud, ssh`);
  }

  // An explicit dashboard key (--api-key first, then CURSOR_API_KEY) selects
  // the documented v0 route; with neither the importer reads this machine's
  // local Cursor session token and takes the keyless api2 route, dying only
  // when that token cannot be read either (facts cckey, ccax).
  const apiKey = values["api-key"] || process.env.CURSOR_API_KEY || null;

  // Lazy-load the importer (cmdShare pattern): Cursor network code stays out
  // of every other command's module graph (facts ccim, ccng, ccni).
  const { runCursorCloudImport } = await import("../import/cursor-cloud-import.js");
  let summary;
  try {
    summary = await runCursorCloudImport({
      apiKey,
      dryRun,
      full,
      out: (line) => console.log(line),
      warn: (line) => console.error(k.yellow(line)),
    });
  } catch (err) {
    die(err?.message || String(err));
  }

  printImportSummary(summary, dryRun);
}

/**
 * `tracequest insights [expr]` — cross-host summary of where agents fail and
 * wait. `--refresh` analyses new and changed sessions first; without it the
 * command only reads the cache, exactly like the /insights page.
 */
export async function cmdInsights(positionals, values) {
  if (values.help) showHelp();
  const { loadInsightsData, parseInsightsQuery } = await import("../insights/load.js");
  const sessions = findSessions(null);
  const index = buildIndex(sessions);
  if (values.refresh) {
    const { refreshInsights } = await import("../insights/store.js");
    const r = await refreshInsights({ sessions, parseSession });
    console.error(
      `insights refresh: ${r.analyzed} analysed, ${r.reused} unchanged, ${r.failed} failed, ${r.removed} removed`,
    );
  }
  const params = new URLSearchParams();
  if (positionals.length) params.set("expr", positionals.join(" "));
  if (values.days) params.set("days", values.days);
  if (values.host) params.set("host", values.host);
  const data = loadInsightsData({ sessions, index, query: parseInsightsQuery(params) });
  if (data.exprError) die(data.exprError);
  if (values.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  const { formatInsights } = await import("../insights/format.js");
  console.log(formatInsights(data));
}

export function cmdServe(positionals, values) {
  if (values.help) showHelp();
  const preset = getPreset(values.preset);
  const port = resolveServePortOrDie(values, preset);

  const filter = values.filter || null;
  if (filter) {
    const filteredSessions = findSessions(filter);
    if (!filteredSessions.length) {
      console.log(k.yellow(`No sessions match filter: ${filter}`));
    } else {
      console.log(k.dim(`Found ${filteredSessions.length} sessions for filter '${filter}'`));
    }
  }
  if (values["usage-limits"]) process.env.TRACEQUEST_USAGE_LIMITS = "1";
  serve(port, filter, { bind: values.bind || "127.0.0.1", hub: Boolean(values.hub) });
}
