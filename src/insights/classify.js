/**
 * Pure classifiers for the insights layer (facts insec, instr): map one failed
 * tool result to an error class, and recognise the recurring traps a session
 * walks into. No I/O — everything here works on already-parsed text.
 */
import { hubConfig } from "../hub/config.js";

/**
 * Ordered: the first matching class wins, so the specific causes sit above the
 * catch-alls (a traceback that ends in FileNotFoundError is a missing path, not
 * "python exception").
 */
export const ERROR_CLASSES = Object.freeze([
  { id: "harness-block", label: "Blocked by the harness", re: /Blocked:|hook (?:blocked|error|denied)|was rejected|doesn't want to proceed|requires approval|permission to use|operation was aborted|interrupted by user/i },
  { id: "tool-input", label: "Invalid tool input", re: /InputValidationError|Invalid tool parameters|is not valid JSON|unknown tool|No such tool|missing required (?:parameter|argument)/i },
  { id: "edit-mismatch", label: "Edit did not apply", re: /String to replace not found|Found \d+ (?:matches|occurrences)|has not been read yet|modified since (?:it was )?read|old_str(?:ing)? (?:not found|must)|No changes to make|patch (?:failed|does not apply)|hunk .* failed/i },
  { id: "disk-full", label: "Disk full", re: /ENOSPC|No space left on device|Disk quota exceeded/i },
  { id: "timeout", label: "Timed out", re: /timed out|timeout (?:of|after|exceeded)|ETIMEDOUT|deadline exceeded|TimeoutError|Timeout \d+ms exceeded|\bTIMEOUT\b|^\s*(?:Exit code|exit:)\s*124\b/i },
  { id: "killed", label: "Killed or interrupted", re: /^\s*(?:Exit code|exit:)\s*(?:13[07]|14[34])\b|\bSIGKILL\b|\bSIGTERM\b|Killed\s*$|out of memory|OOMKilled/i },
  { id: "missing-path", label: "Missing file or directory", re: /No such file or directory|ENOENT|File does not exist|^Error: \/\S+ does not exist|FileNotFoundError|Path does not exist|cannot access|Not a directory|file or directory not found/i },
  { id: "permission", label: "Permission denied", re: /Permission denied|EACCES|Operation not permitted|EPERM/ },
  { id: "command-not-found", label: "Command not found", re: /command not found|\/which: no |is not recognized as|No such command|unknown (?:command|option|flag)|unrecognized (?:option|argument|subcommand)/i },
  { id: "missing-dep", label: "Missing module or dependency", re: /ModuleNotFoundError|No module named|Cannot find module|ImportError|Cannot find package|ERR_MODULE_NOT_FOUND|could not resolve dependenc/i },
  { id: "git", label: "Git error", re: /fatal: |not a git repository|CONFLICT \(|non-fast-forward|failed to push|needs merge|unmerged files/ },
  { id: "network-auth", label: "Network or auth", re: /\b(?:401|403|429)\b|Unauthorized|Forbidden|ECONNREFUSED|ECONNRESET|Connection refused|Could not resolve host|rate limit|HTTP (?:4|5)\d\d|gh auth login|Bad credentials/i },
  { id: "lint-type", label: "Lint or type check", re: /\bRUF\d{3}\b|\b[EFW]\d{3}\b |error TS\d+|\bmypy\b|\bpyright\b|\beslint\b|ruff (?:check|format)|Found \d+ errors?\b|would reformat/ },
  { id: "test-failure", label: "Test failure", re: /\b\d+ failed\b|AssertionError|=+ FAILURES =+|FAILED [\w./-]+::|Test Files .*failed|\bFAIL\b .*\.(?:test|spec)\.|not ok \d+|# fail [1-9]/ },
  { id: "syntax", label: "Syntax error", re: /SyntaxError|syntax error|Unexpected token|IndentationError|unexpected EOF|parse error/i },
  { id: "python-exception", label: "Python exception", re: /Traceback \(most recent call last\)/ },
  { id: "empty-exit", label: "Non-zero exit, no output", re: /^\s*(?:Exit code|exit:)\s*\d+\s*$/i },
  { id: "nonzero-exit", label: "Other non-zero exit", re: /Exit code \d+|exit(?:ed)?(?: with)?(?: code)?:? \d+|returned non-zero/i },
]);

export const OTHER_ERROR_CLASS = Object.freeze({ id: "other", label: "Other" });

const CLASS_LABELS = new Map([...ERROR_CLASSES, OTHER_ERROR_CLASS].map((c) => [c.id, c.label]));

export function errorClassLabel(id) {
  return CLASS_LABELS.get(id) || id;
}

const SUSPECT_ERROR_RE = /^\s*(?:<workspace_result\b|\d+\u2192|(?:Exit code|exit:)\s*0\b|Script completed\b)|has been (?:updated|created|written) successfully/i;

/**
 * True when a result the parser flagged as an error is really tool output that
 * merely contains error-looking words: file contents, search hits, an exit 0.
 * Insights count these apart so they do not inflate the error rate.
 */
export function isSuspectError(text) {
  return SUSPECT_ERROR_RE.test(String(text ?? ""));
}

/** Error class id for one failed tool result's text. */
export function classifyError(text) {
  const t = String(text ?? "");
  for (const cls of ERROR_CLASSES) {
    if (cls.re.test(t)) return cls.id;
  }
  return OTHER_ERROR_CLASS.id;
}

/** The recurring traps the insights view reports (fact instr). */
export const TRAPS = Object.freeze([
  { id: "wrong-folder", label: "Wrong folder", hint: "A command ran where the repo, manifest or test path it needs does not exist." },
  { id: "path-bleed", label: "Path bleed", hint: "The agent read or edited a different checkout of the same repo than the one it was started in." },
  { id: "test-hang", label: "Test-runner hang", hint: "A test command timed out or kept the agent waiting ten minutes or more." },
  { id: "ci-wait", label: "CI wait", hint: "The agent polled or watched CI instead of working." },
]);

const SHELL_TOOL_RE = /^(?:bash|shell|exec|exec_command|run_terminal_cmd|run_command|execute|local_shell|terminal|monitor)$/i;
const FILE_TOOL_RE = /^(?:read|edit|write|multiedit|notebookedit|create|str_replace|str_replace_editor|apply_patch|view|read_file|write_file|edit_file|search_replace)$/i;
const WRITE_TOOL_RE = /^(?:edit|write|multiedit|notebookedit|create|str_replace|str_replace_editor|apply_patch|write_file|edit_file|search_replace)$/i;

export function isShellTool(name) {
  return SHELL_TOOL_RE.test(String(name ?? ""));
}

/** Tools that can legitimately run for minutes: commands, sub-agents, fetches, MCP. */
export function isLongRunningTool(name) {
  const n = String(name ?? "");
  return isShellTool(n) || /^(?:agent|task|subagent|spawn_agent|skill|webfetch|web_fetch|websearch|web_search|wait|write_stdin)$/i.test(n) || /^mcp__/.test(n);
}

export function isFileTool(name) {
  return FILE_TOOL_RE.test(String(name ?? ""));
}

export function isWriteTool(name) {
  return WRITE_TOOL_RE.test(String(name ?? ""));
}

const WRONG_FOLDER_RE = /not a git repository|\bcd: .*No such file or directory|can't cd to|(?:package\.json|pyproject\.toml|Cargo\.toml|Makefile|go\.mod|uv\.lock)['"`]?[^\n]{0,60}(?:No such file|not found|ENOENT|does not exist)|(?:No such file|ENOENT|Could not (?:find|read))[^\n]{0,80}(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod)|No rule to make target|ERROR: file or directory not found|No (?:`?pyproject\.toml`?|package\.json) found|could not find `?Cargo\.toml`?|Missing script:/i;

/** True when a failed shell result says the command ran in the wrong directory. */
export function isWrongFolderError(text) {
  return WRONG_FOLDER_RE.test(String(text ?? ""));
}

const TEST_RUNNER_RE = /(?:^|[\s;&|(])(?:pytest|vitest|jest|playwright test|cargo test|go test|(?:npm|pnpm|yarn|bun)(?: run)? test\b|make test|node --test|tox|nox)\b|python3? -m (?:pytest|unittest)|uv run (?:--[\w-]+(?:[= ]\S+)? )*pytest/;

export function isTestRunnerCommand(command) {
  return TEST_RUNNER_RE.test(String(command ?? ""));
}

const CI_WAIT_RE = /\bgh (?:run (?:watch|view|list|rerun)|pr checks|workflow run)\b|\bgh api [^\n|;]*(?:check-runs|check-suites|actions\/runs|commits\/[^\s/]+\/status)/;

export function isCiWaitCommand(command) {
  return CI_WAIT_RE.test(String(command ?? ""));
}

/** Seconds a shell command asks to sleep (`sleep 90`, `sleep 2m`), summed. */
export function sleepSeconds(command) {
  let total = 0;
  const re = /\bsleep\s+(\d+(?:\.\d+)?)([smh]?)\b/g;
  let m;
  while ((m = re.exec(String(command ?? ""))) !== null) {
    const n = Number(m[1]);
    total += m[2] === "m" ? n * 60 : m[2] === "h" ? n * 3600 : n;
  }
  return total;
}

const CHECKOUT_PARENT_RE = /\/(?:\.cursor\/worktrees\/|\.claude\/worktrees\/|worktrees\/|\.worktrees\/)[^/]+\//;

/** The agent worktree a path sits in: its parent directory and repo folder. */
function checkoutOf(path) {
  const patterns = [CHECKOUT_PARENT_RE, ...(hubConfig()?.checkoutPatterns || []).map((p) => new RegExp(p))];
  const m = patterns.map((p) => path.match(p)).find(Boolean);
  if (!m) return null;
  const end = m.index + m[0].length;
  return { parent: path.slice(0, end), repo: path.slice(end).split("/")[0] || "" };
}

/**
 * True when `target` is an absolute path inside a different checkout of the
 * repo the session was started in: a sibling agent worktree, the main clone
 * seen from a worktree, or a worktree seen from the main clone.
 */
export function isPathBleed(cwd, target) {
  const root = String(cwd ?? "").replace(/\/+$/, "");
  const path = String(target ?? "");
  if (!root || !path.startsWith("/")) return false;
  if (path === root || path.startsWith(`${root}/`)) return false;
  const here = checkoutOf(`${root}/`);
  const there = checkoutOf(`${path}/`);
  if (here && there) return Boolean(here.repo) && here.repo === there.repo && here.parent !== there.parent;
  if (here) return Boolean(here.repo) && `${path}/`.includes(`/${here.repo}/`);
  if (there) return there.repo === root.slice(root.lastIndexOf("/") + 1);
  return false;
}

/** Absolute paths a shell command changes into (`cd /abs`, `git -C /abs`). */
export function shellTargetDirs(command) {
  const out = [];
  const re = /(?:\bcd|\bgit -C|--cwd|--prefix)\s+["']?(\/[^\s"';&|)]+)/g;
  let m;
  while ((m = re.exec(String(command ?? ""))) !== null) out.push(m[1]);
  return out;
}

/**
 * Repo area of a path relative to the session cwd: the top-level folder, or
 * the top two for the container folders that hold several products.
 */
export function repoArea(cwd, target) {
  const root = String(cwd ?? "").replace(/\/+$/, "");
  const path = String(target ?? "");
  if (!root || !path.startsWith(`${root}/`)) return null;
  const parts = path.slice(root.length + 1).split("/").filter(Boolean);
  if (parts.length < 2) return "(repo root)";
  if (/^(?:backend|frontend|packages|apps|services|src|tools|docs|infra|libs|crates)$/.test(parts[0]) && parts.length > 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}
