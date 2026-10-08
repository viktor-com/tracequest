import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import {
  isGitRepo,
  getCommitHash,
  isWorkingTreeDirty,
  detectGitOp,
  extractCommitMessageFromMFlag,
} from "../../src/utils/git-op.js";
import { assertPerf } from "../helpers/perf-assert.js";

function runGit(cwd, args) {
  execSync(`git ${args.join(" ")}`, { cwd, stdio: "ignore" });
}

function initRepo(dir, branch = "main") {
  fs.mkdirSync(dir, { recursive: true });
  runGit(dir, ["init", "-b", branch]);
  runGit(dir, ["config", "user.email", "git-op@test.local"]);
  runGit(dir, ["config", "user.name", "git-op-test"]);
}

function commitFile(dir, name, content, message) {
  fs.writeFileSync(path.join(dir, name), content);
  runGit(dir, ["add", name]);
  runGit(dir, ["commit", "-m", message]);
}

function tmpRepo(suffix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tq-git-op-${suffix}-`));
}

function rmRepo(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("git-op repo helpers", () => {
  test("isGitRepo is false for a plain temp directory", () => {
    const dir = tmpRepo("plain");
    try {
      assert.equal(isGitRepo(dir), false);
    } finally {
      rmRepo(dir);
    }
  });

  test("repo helpers warn on unexpected fs errors but stay silent for normal git failures", () => {
    const missing = path.join(os.tmpdir(), `tq-git-op-missing-${Date.now()}`);
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...args) => warns.push(args.join(" "));
    try {
      assert.equal(isGitRepo(missing), false);
      assert.equal(getCommitHash(missing), null);
      assert.equal(isWorkingTreeDirty(missing), false);
      assert.equal(warns.length, 3);
      assert.match(warns[0], /git-op: git rev-parse --is-inside-work-tree failed/);
      assert.match(warns[0], /ENOENT/);
    } finally {
      console.warn = origWarn;
    }
  });

  test("isGitRepo is false when only a fake .git file exists", () => {
    const dir = tmpRepo("fake-git");
    try {
      fs.writeFileSync(path.join(dir, ".git"), "not a directory\n");
      assert.equal(isGitRepo(dir), false);
    } finally {
      rmRepo(dir);
    }
  });

  test("isGitRepo is true immediately after git init", () => {
    const dir = tmpRepo("init-only");
    try {
      initRepo(dir);
      assert.equal(isGitRepo(dir), true);
    } finally {
      rmRepo(dir);
    }
  });

  test("isGitRepo is true inside a nested subdirectory of the repo", () => {
    const dir = tmpRepo("nested");
    try {
      initRepo(dir);
      commitFile(dir, "a.txt", "one\n", "first");
      const nested = path.join(dir, "pkg", "lib");
      fs.mkdirSync(nested, { recursive: true });
      assert.equal(isGitRepo(nested), true);
    } finally {
      rmRepo(dir);
    }
  });

  test("getCommitHash is null before the first commit", () => {
    const dir = tmpRepo("no-head");
    try {
      initRepo(dir);
      assert.equal(getCommitHash(dir), null);
      assert.equal(getCommitHash(dir, { short: true }), null);
    } finally {
      rmRepo(dir);
    }
  });

  test("getCommitHash returns full and short hashes after a commit", () => {
    const dir = tmpRepo("hash");
    try {
      initRepo(dir);
      commitFile(dir, "readme.txt", "hello\n", "initial");
      const full = getCommitHash(dir);
      const short = getCommitHash(dir, { short: true });
      assert.ok(full && /^[a-f0-9]{40}$/.test(full), `expected full hash, got ${full}`);
      assert.ok(short && /^[a-f0-9]{7,40}$/.test(short), `expected short hash, got ${short}`);
      assert.ok(full.startsWith(short), "short hash should prefix full hash");
    } finally {
      rmRepo(dir);
    }
  });

  test("getCommitHash tracks HEAD after a second commit", () => {
    const dir = tmpRepo("two-commits");
    try {
      initRepo(dir);
      commitFile(dir, "a.txt", "1\n", "one");
      const first = getCommitHash(dir);
      commitFile(dir, "b.txt", "2\n", "two");
      const second = getCommitHash(dir);
      assert.notEqual(first, second);
    } finally {
      rmRepo(dir);
    }
  });

  test("getCommitHash is null outside any repository", () => {
    const dir = tmpRepo("no-repo-hash");
    try {
      assert.equal(getCommitHash(dir), null);
      assert.equal(getCommitHash(dir, { short: true }), null);
    } finally {
      rmRepo(dir);
    }
  });

  test("isWorkingTreeDirty is false on a clean committed tree", () => {
    const dir = tmpRepo("clean");
    try {
      initRepo(dir);
      commitFile(dir, "stable.txt", "ok\n", "clean");
      assert.equal(isWorkingTreeDirty(dir), false);
    } finally {
      rmRepo(dir);
    }
  });

  test("isWorkingTreeDirty is true after modifying a tracked file", () => {
    const dir = tmpRepo("modified");
    try {
      initRepo(dir);
      commitFile(dir, "tracked.txt", "v1\n", "base");
      fs.appendFileSync(path.join(dir, "tracked.txt"), "v2\n");
      assert.equal(isWorkingTreeDirty(dir), true);
    } finally {
      rmRepo(dir);
    }
  });

  test("isWorkingTreeDirty is true with only an untracked file", () => {
    const dir = tmpRepo("untracked");
    try {
      initRepo(dir);
      commitFile(dir, "keep.txt", "x\n", "keep");
      fs.writeFileSync(path.join(dir, "new.txt"), "new\n");
      assert.equal(isWorkingTreeDirty(dir), true);
    } finally {
      rmRepo(dir);
    }
  });

  test("isWorkingTreeDirty is false when cwd is not a git repo", () => {
    const dir = tmpRepo("dirty-nonrepo");
    try {
      assert.equal(isWorkingTreeDirty(dir), false);
    } finally {
      rmRepo(dir);
    }
  });

  test("repo helpers use the provided cwd, not the process cwd", () => {
    const dir = tmpRepo("cwd-isolation");
    const outside = tmpRepo("outside");
    try {
      initRepo(dir);
      commitFile(dir, "only.txt", "here\n", "here");
      assert.equal(isGitRepo(outside), false);
      assert.equal(getCommitHash(outside), null);
      assert.ok(getCommitHash(dir));
    } finally {
      rmRepo(dir);
      rmRepo(outside);
    }
  });
});

describe("extractCommitMessageFromMFlag", () => {
  test("parses double-quoted, single-quoted, and bare -m values", () => {
    assert.equal(
      extractCommitMessageFromMFlag('git commit -m "docs: update README"'),
      "docs: update README",
    );
    assert.equal(
      extractCommitMessageFromMFlag("git commit -m 'hotfix: null guard'"),
      "hotfix: null guard",
    );
    assert.equal(
      extractCommitMessageFromMFlag("git commit -m chore/deps-bump"),
      "chore/deps-bump",
    );
  });

  test("returns null when no -m flag is present", () => {
    assert.equal(extractCommitMessageFromMFlag("git commit --allow-empty"), null);
  });
});

describe("detectGitOp", () => {
  test("returns null for empty or non-git shell commands", () => {
    assert.equal(detectGitOp(""), null);
    assert.equal(detectGitOp("npm test"), null);
    assert.equal(detectGitOp("echo hello"), null);
  });

  test("detects commit with hash and message from typical git output", () => {
    const op = detectGitOp(
      'git commit -m "fix tests"',
      "[main abc1234def5678] fix tests\n 1 file changed",
    );
    assert.equal(op.type, "commit");
    assert.equal(op.hash, "abc1234def5678");
    assert.equal(op.message, "fix tests");
  });

  test("picks git segment from chained shell commands", () => {
    const op = detectGitOp("cd /tmp && git push origin main");
    assert.equal(op.type, "push");
    assert.equal(op.remote, "origin");
    assert.equal(op.branch, "main");
  });

  test("honors git -C path prefix when detecting operations", () => {
    const op = detectGitOp("git -C /srv/app checkout -b feature/x");
    assert.equal(op.type, "branch-create");
    assert.equal(op.branch, "feature/x");
  });

  describe("commit message extraction", () => {
    test("parses hash and message from standard [branch hash] output", () => {
      const op = detectGitOp(
        'git commit -m "fix tests"',
        "[main abc1234def5678] fix tests\n 1 file changed",
      );
      assert.equal(op.type, "commit");
      assert.equal(op.hash, "abc1234def5678");
      assert.equal(op.message, "fix tests");
    });

    test("parses message from feature branch style output", () => {
      const op = detectGitOp(
        "git commit -am wip",
        "[feature/login abc9876543] ship login flow\n 3 files changed",
      );
      assert.equal(op.hash, "abc9876543");
      assert.equal(op.message, "ship login flow");
    });

    test("extracts -m message from double-quoted flag when output is absent", () => {
      const op = detectGitOp('git commit -m "docs: update README"');
      assert.equal(op.type, "commit");
      assert.equal(op.message, "docs: update README");
      assert.equal(op.hash, undefined);
    });

    test("extracts -m message from single-quoted flag when output is absent", () => {
      const op = detectGitOp("git commit -m 'hotfix: null guard'");
      assert.equal(op.message, "hotfix: null guard");
    });

    test("extracts -m message from unquoted flag when output is absent", () => {
      const op = detectGitOp("git commit -m chore/deps-bump");
      assert.equal(op.message, "chore/deps-bump");
    });

    test("extracts first line from HEREDOC -m in full command", () => {
      const cmd = `git commit -m "$(cat <<'EOF'
anneal: deep detect git op tests

Co-authored-by: Agent
EOF
)"`;
      const op = detectGitOp(cmd);
      assert.equal(op.message, "anneal: deep detect git op tests");
    });

    test("finds git commit in chained shell commands and reads output", () => {
      const op = detectGitOp(
        'npm test && git commit -m "green suite"',
        "[main deadbeef0123456] green suite\n",
      );
      assert.equal(op.type, "commit");
      assert.equal(op.hash, "deadbeef0123456");
      assert.equal(op.message, "green suite");
    });

    test("strips git -C prefix and still extracts commit output", () => {
      const op = detectGitOp(
        'git -C /srv/app commit -m "deploy config"',
        "[main cafebabe1234567] deploy config\n",
      );
      assert.equal(op.hash, "cafebabe1234567");
      assert.equal(op.message, "deploy config");
    });

    test("truncates long messages from git output to 120 characters", () => {
      const long = "x".repeat(200);
      const op = detectGitOp("git commit -m ignored", `[main abc1234567890] ${long}\n`);
      assert.equal(op.message.length, 120);
      assert.equal(op.message, "x".repeat(120));
    });

    test("truncates long -m flag messages to 120 characters", () => {
      const long = "y".repeat(200);
      const op = detectGitOp(`git commit -m "${long}"`);
      assert.equal(op.message.length, 120);
      assert.equal(op.message, "y".repeat(120));
    });

    test("prefers output message over -m flag when both are present", () => {
      const op = detectGitOp(
        'git commit -m "from flag"',
        "[main 1111111111111111] from output\n",
      );
      assert.equal(op.message, "from output");
      assert.equal(op.hash, "1111111111111111");
    });

    test("falls back to hash line in output when bracket format is missing", () => {
      const op = detectGitOp("git commit -m fallback", "Committed revision abcdef0123456789.\n");
      assert.equal(op.hash, "abcdef0");
      assert.equal(op.message, "fallback");
    });

    test("detects bare commit with no output and no -m flag", () => {
      const op = detectGitOp("git commit --allow-empty");
      assert.equal(op.type, "commit");
      assert.equal(op.hash, undefined);
      assert.equal(op.message, undefined);
    });
  });

  test("detects push with --tags flag", () => {
    const op = detectGitOp("git push --tags");
    assert.equal(op.type, "push");
    assert.equal(op.tags, true);
  });

  test("detects merge with branch name", () => {
    const op = detectGitOp("git merge --no-ff feature/login");
    assert.equal(op.type, "merge");
    assert.equal(op.branch, "feature/login");
  });

  test("detects rebase onto upstream branch", () => {
    const op = detectGitOp("git rebase --onto main feature/x");
    assert.equal(op.type, "rebase");
    assert.equal(op.branch, "main");
  });

  test("detects stash save", () => {
    const op = detectGitOp("git stash push -m wip");
    assert.equal(op.type, "stash");
    assert.equal(op.cmd, "git stash push -m wip");
  });

  test("detects lightweight tag creation", () => {
    const op = detectGitOp("git tag v1.2.3");
    assert.equal(op.type, "tag");
    assert.equal(op.tag, "v1.2.3");
  });

  test("detects annotated tag with -a flag", () => {
    const op = detectGitOp('git tag -a release-2026 -m "ship it"');
    assert.equal(op.type, "tag");
    assert.equal(op.tag, "release-2026");
  });

  describe("branch create, switch, tag delete, and push flags", () => {
    test("detects branch-create from git checkout -b", () => {
      const op = detectGitOp("git checkout -b feature/login");
      assert.equal(op.type, "branch-create");
      assert.equal(op.branch, "feature/login");
    });

    test("detects branch-create from git switch -c and --create", () => {
      assert.deepEqual(detectGitOp("git switch -c wip"), {
        type: "branch-create",
        cmd: "git switch -c wip",
        branch: "wip",
      });
      const created = detectGitOp("git switch --create long-lived");
      assert.equal(created.type, "branch-create");
      assert.equal(created.branch, "long-lived");
    });

    test("detects branch-create from plain git branch name", () => {
      const op = detectGitOp("git branch side-only");
      assert.equal(op.type, "branch-create");
      assert.equal(op.branch, "side-only");
    });

    test("does not treat git branch -d as branch-create", () => {
      assert.equal(detectGitOp("git branch -d stale"), null);
    });

    test("detects branch-switch from git checkout and git switch", () => {
      const checkout = detectGitOp("git checkout main");
      assert.equal(checkout.type, "branch-switch");
      assert.equal(checkout.branch, "main");

      const switched = detectGitOp("git switch release/1.0");
      assert.equal(switched.type, "branch-switch");
      assert.equal(switched.branch, "release/1.0");
    });

    test("ignores file checkout paths for branch-switch", () => {
      assert.equal(detectGitOp("git checkout src/app.js"), null);
    });

    test("does not classify git tag -d as a tag operation", () => {
      assert.equal(detectGitOp("git tag -d v1.0.0"), null);
    });

    test("detects push remote when flags precede remote", () => {
      const op = detectGitOp("git push --force origin main");
      assert.equal(op.type, "push");
      assert.equal(op.tags, false);
      assert.equal(op.remote, "origin");
      assert.equal(op.branch, "main");
    });

    test("detects push with -u and remote/branch after flags", () => {
      const op = detectGitOp("git push -u origin feature/x");
      assert.equal(op.remote, "origin");
      assert.equal(op.branch, "feature/x");
    });

    test("detects push --tags with remote only (not as remote name)", () => {
      const op = detectGitOp("git push --tags origin");
      assert.equal(op.type, "push");
      assert.equal(op.tags, true);
      assert.equal(op.remote, "origin");
      assert.equal(op.branch, undefined);
    });

    test("detects branch-switch in chained shell commands", () => {
      const op = detectGitOp("npm test && git switch main");
      assert.equal(op.type, "branch-switch");
      assert.equal(op.branch, "main");
    });
  });
});

describe("detectGitOp perf", () => {
  const NON_GIT_CMDS = [
    "npm test",
    "echo hello",
    "cd /tmp && ls -la",
    "cargo build --release",
    "TRACEQUEST_SKIP_LR_WATCH=1 node --test --test-concurrency=1 test/*.test.js",
    "make clean && make all",
    "docker compose up -d",
    "python -m pytest tests/",
    "rg -l detectGitOp src/",
    "ls -la node_modules/.bin",
  ];

  test("non-git Bash commands reject without split under 0.00004ms/op", () => {
    const ITERS = 80_000;
    for (let w = 0; w < 2; w++) {
      for (const cmd of NON_GIT_CMDS) assert.equal(detectGitOp(cmd), null);
    }
    const t0 = performance.now();
    for (let i = 0; i < ITERS; i++) {
      for (const cmd of NON_GIT_CMDS) assert.equal(detectGitOp(cmd), null);
    }
    const ms = (performance.now() - t0) / (ITERS * NON_GIT_CMDS.length);
    assertPerf(
      ms < 0.00004,
      `expected detectGitOp non-git fast-path under 0.00004ms/op, got ${ms.toFixed(5)}ms`,
    );
  });
});