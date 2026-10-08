import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyError,
  errorClassLabel,
  isCiWaitCommand,
  isPathBleed,
  isSuspectError,
  isTestRunnerCommand,
  isWrongFolderError,
  repoArea,
  sleepSeconds,
  TRAPS,
} from "../../src/insights/classify.js";

test("classifyError maps failed tool results to one error class", () => {
  const cases = [
    ["Exit code 1", "empty-exit"],
    ["Exit code 124", "timeout"],
    ["Exit code 137", "killed"],
    ["Command timed out after 2m 0s", "timeout"],
    ["ENOSPC: no space left on device, open '/proc/self/fd/30/x.output'", "disk-full"],
    ["Exit code 1\nTraceback (most recent call last):\nFileNotFoundError: [Errno 2] No such file or directory: '/tmp/x.json'", "missing-path"],
    ["Error: /repo/tools/missing.md does not exist. Note: your current working directory is /repo", "missing-path"],
    ["<tool_use_error>String to replace not found in file.</tool_use_error>", "edit-mismatch"],
    ["<tool_use_error>InputValidationError: Monitor failed</tool_use_error>", "tool-input"],
    ["<tool_use_error>Blocked: sleep 90 followed by: grep</tool_use_error>", "harness-block"],
    ["/usr/bin/which: no op in (/usr/bin)", "command-not-found"],
    ["ModuleNotFoundError: No module named 'service'", "missing-dep"],
    ["fatal: not a git repository (or any of the parent directories): .git", "git"],
    ["Exit code 1\nRUF100 [*] Unused `noqa` directive", "lint-type"],
    ["Exit code 1\n===== FAILURES =====\n3 failed, 10 passed", "test-failure"],
    ["Exit code 1\nTraceback (most recent call last):\nValueError: bad", "python-exception"],
    ["Exit code 2\nsome tool printed this", "nonzero-exit"],
    ["something unusual went wrong", "other"],
  ];
  for (const [text, expected] of cases) assert.equal(classifyError(text), expected, text);
  assert.equal(errorClassLabel("missing-path"), "Missing file or directory");
});

test("isSuspectError recognises ordinary output the parser flagged as an error", () => {
  assert.equal(isSuspectError('<workspace_result workspace_path="/x"> Found 11 matching lines'), true);
  assert.equal(isSuspectError("1→--- name: credentials description: errors and failures"), true);
  assert.equal(isSuspectError("exit: 0 Usage: codex exec review"), true);
  assert.equal(isSuspectError("Exit code 1\nboom"), false);
});

test("trap detectors recognise wrong folder, test runners, CI waits and sleeps", () => {
  assert.deepEqual(TRAPS.map((t) => t.id), ["wrong-folder", "path-bleed", "test-hang", "ci-wait"]);
  assert.equal(isWrongFolderError("fatal: not a git repository (or any of the parent directories): .git"), true);
  assert.equal(isWrongFolderError("/bin/bash: line 1: cd: /nope/dir: No such file or directory"), true);
  assert.equal(isWrongFolderError("npm error enoent Could not read package.json: Error: ENOENT"), true);
  assert.equal(isWrongFolderError("FileNotFoundError: /tmp/data.json"), false);
  assert.equal(isTestRunnerCommand("cd backend && uv run pytest tests/unit -q"), true);
  assert.equal(isTestRunnerCommand("npm test -- --watch=false"), true);
  assert.equal(isTestRunnerCommand("git status"), false);
  assert.equal(isCiWaitCommand("gh pr checks 123 --watch"), true);
  assert.equal(isCiWaitCommand("gh run watch 99"), true);
  assert.equal(isCiWaitCommand("gh pr view 123"), false);
  assert.equal(sleepSeconds("sleep 90; gh pr checks 1; sleep 2m"), 210);
});

test("isPathBleed flags another checkout of the same repo and nothing else", () => {
  const cwd = "/home/u/worktrees/task-a_1/sample-app";
  assert.equal(isPathBleed("/worktrees/a/shop", "/worktrees/b/docs/src/index.js"), false);
  assert.equal(isPathBleed("/worktrees/a/shop", "/worktrees/b/shop/src/index.js"), true);
  assert.equal(isPathBleed(cwd, "/home/u/worktrees/task-a_1/sample-app/backend/x.py"), false);
  assert.equal(isPathBleed(cwd, "/home/u/worktrees/task-b_2/sample-app/backend/x.py"), true);
  assert.equal(isPathBleed(cwd, "/home/u/code/sample-app/sample-app/backend/x.py"), true);
  assert.equal(isPathBleed(cwd, "/tmp/scratch/x.py"), false);
  assert.equal(isPathBleed("/home/u/code/sample-app", "/home/u/worktrees/task-b_2/sample-app/x.py"), true);
  assert.equal(isPathBleed("/home/u/code/sample-app", "/home/u/code/other/x.py"), false);
  // A sub-agent started in a sub-folder is still inside its own checkout.
  assert.equal(
    isPathBleed("/home/u/worktrees/task-a_1/sample-app/site/content/docs", "/home/u/worktrees/task-a_1/sample-app/site/src/docs/v.tsx"),
    false,
  );
});

test("repoArea names the folder a path belongs to", () => {
  assert.equal(repoArea("/r", "/r/backend/service/core/x.py"), "backend/service");
  assert.equal(repoArea("/r", "/r/scripts/x.sh"), "scripts");
  assert.equal(repoArea("/r", "/r/README.md"), "(repo root)");
  assert.equal(repoArea("/r", "/elsewhere/x"), null);
});
