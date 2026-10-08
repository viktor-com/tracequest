import { execSync } from "node:child_process";
import { safeSlice } from "../parse/parse-utils.js";

function gitExec(args, cwd) {
  return execSync(`git ${args.join(" ")}`, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/** Git non-zero exit is expected (not a repo, no HEAD); only warn on unexpected fs/spawn errors. */
function warnUnexpectedGitExecErr(err, args, cwd) {
  if (err?.code) {
    console.warn(`git-op: git ${args.join(" ")} failed in ${cwd}:`, err.message);
  }
}

/** True when `cwd` is inside a git work tree. */
export function isGitRepo(cwd) {
  const args = ["rev-parse", "--is-inside-work-tree"];
  try {
    gitExec(args, cwd);
    return true;
  } catch (err) {
    warnUnexpectedGitExecErr(err, args, cwd);
    return false;
  }
}

/** Current HEAD hash, or null when not in a repo or there is no commit yet. */
export function getCommitHash(cwd, opts = {}) {
  if (!isGitRepo(cwd)) return null;
  const args = opts.short ? ["rev-parse", "--short", "HEAD"] : ["rev-parse", "HEAD"];
  try {
    return gitExec(args, cwd);
  } catch (err) {
    warnUnexpectedGitExecErr(err, args, cwd);
    return null;
  }
}

/** Extract commit message text from a `-m` flag in a git commit command string. */
export function extractCommitMessageFromMFlag(gitPart) {
  var mMatch = gitPart.match(/-m\s+["']([^"']+)["']/);
  if (!mMatch) mMatch = gitPart.match(/-m\s+"([^"]+)"/);
  if (!mMatch) mMatch = gitPart.match(/-m\s+'([^']+)'/);
  if (!mMatch) mMatch = gitPart.match(/-m\s+(\S+)/);
  return mMatch ? mMatch[1] : null;
}

/** True when the working tree has staged, unstaged, or untracked changes. */
export function isWorkingTreeDirty(cwd) {
  if (!isGitRepo(cwd)) return false;
  const args = ["status", "--porcelain"];
  try {
    return gitExec(args, cwd).length > 0;
  } catch (err) {
    warnUnexpectedGitExecErr(err, args, cwd);
    return false;
  }
}

/** Detect git operations from Bash tool input and optional command output. */
export function detectGitOp(cmd, output) {
  if (!cmd) return null;
  var c = cmd.trim();
  // Fast reject: virtually all Bash tool calls are non-git (no split/regex work).
  if (c.indexOf("git ") < 0) return null;
  // Single command — skip chained split when there is no && or ;
  var gitPart;
  var chainAt = c.indexOf("&&");
  if (chainAt < 0) chainAt = c.indexOf(";");
  if (chainAt < 0) {
    if (!c.startsWith("git ")) return null;
    gitPart = c;
  } else {
    var parts = c.split(/&&|;/);
    gitPart = null;
    for (var pi = 0; pi < parts.length; pi++) {
      var p = parts[pi].trim();
      if (p.startsWith("git ")) {
        gitPart = p;
        break;
      }
    }
    if (!gitPart) return null;
  }
  // Strip git -C <path> prefix so the rest of the regex patterns work
  gitPart = gitPart.replace(/^git\s+(-C\s+\S+\s+)+/, 'git ');

  // git commit
  if (/\bgit\s+commit\b/.test(gitPart)) {
    var op = { type: 'commit', cmd: gitPart };
    // Try to extract commit hash and message from output
    // Typical output: "[branch abc1234] commit message here"
    if (output) {
      var commitMatch = output.match(/\[([^\s\]]+)\s+([a-f0-9]{7,})\]\s*(.*)/) ||
                        output.match(/([a-f0-9]{7,40})\]\s*(.*)/) ||
                        output.match(/\[\S+\s+([a-f0-9]{7,})\]\s*(.*)/);
      if (commitMatch) {
        // Format: [branch hash] message
        op.hash = commitMatch[2] || commitMatch[1];
        op.message = safeSlice((commitMatch[3] || commitMatch[2] || '').trim(), 120);
      }
      // Also try: "create mode" pattern or "-m" flag extraction
      if (!op.hash) {
        var hashLine = output.match(/([a-f0-9]{7,40})/);
        if (hashLine) op.hash = hashLine[1].slice(0, 7);
      }
    }
    if (!op.message) {
      var heredocMatch = cmd.match(/<<['"]?EOF['"]?\n([\s\S]*?)\nEOF/);
      if (heredocMatch) {
        op.message = safeSlice(heredocMatch[1].split('\n')[0].trim(), 120);
      }
    }
    if (!op.message) {
      var msgFromFlag = extractCommitMessageFromMFlag(gitPart);
      if (msgFromFlag) op.message = safeSlice(msgFromFlag, 120);
    }
    return op;
  }

  // git push
  if (/\bgit\s+push\b/.test(gitPart)) {
    var op = { type: 'push', cmd: gitPart };
    op.tags = /--tags/.test(gitPart);
    // Extract remote and branch (skip flags like --tags, -u, --force, etc.)
    var pushMatch = gitPart.match(/git\s+push\s+(?:(?:--?[\w-]+)\s+)*([^\s-][\w./-]*)(?:\s+([\w./-]+))?/);
    if (pushMatch) {
      op.remote = pushMatch[1];
      if (pushMatch[2]) op.branch = pushMatch[2];
    } else {
      // Try simpler: git push <remote> — scan tokens without split+filter alloc
      var pi = 0;
      var plen = gitPart.length;
      var pn = 0;
      while (pi < plen && pn < 2) {
        while (pi < plen && gitPart.charAt(pi) <= " ") pi++;
        if (pi >= plen) break;
        var pstart = pi;
        while (pi < plen && gitPart.charAt(pi) > " ") pi++;
        var pt = gitPart.slice(pstart, pi);
        if (pt.charAt(0) !== "-" && pt !== "git" && pt !== "push") {
          if (pn === 0) op.remote = pt;
          else op.branch = pt;
          pn++;
        }
      }
    }
    return op;
  }

  // git checkout -b (create branch)
  if (/\bgit\s+checkout\s+-b\b/.test(gitPart)) {
    var branchMatch = gitPart.match(/git\s+checkout\s+-b\s+([\w./-]+)/);
    return { type: 'branch-create', cmd: gitPart, branch: branchMatch ? branchMatch[1] : '' };
  }

  // git switch -c (create branch)
  if (/\bgit\s+switch\s+-c\b/.test(gitPart) || /\bgit\s+switch\s+--create\b/.test(gitPart)) {
    var branchMatch = gitPart.match(/git\s+switch\s+(?:-c|--create)\s+([\w./-]+)/);
    return { type: 'branch-create', cmd: gitPart, branch: branchMatch ? branchMatch[1] : '' };
  }

  // git branch (create)
  if (/\bgit\s+branch\s+[^-]/.test(gitPart) && !/\bgit\s+branch\s+-[dD]/.test(gitPart)) {
    var branchMatch = gitPart.match(/git\s+branch\s+([\w./-]+)/);
    if (branchMatch) return { type: 'branch-create', cmd: gitPart, branch: branchMatch[1] };
  }

  // git checkout (switch branch)
  if (/\bgit\s+checkout\s+(?!--)\S/.test(gitPart) && !/\bgit\s+checkout\s+-b\b/.test(gitPart)) {
    var branchMatch = gitPart.match(/git\s+checkout\s+([\w./-]+)/);
    if (branchMatch && !branchMatch[1].includes('.')) {
      return { type: 'branch-switch', cmd: gitPart, branch: branchMatch[1] };
    }
  }

  // git switch (switch branch)
  if (/\bgit\s+switch\s+(?!-c|--create)\S/.test(gitPart)) {
    var branchMatch = gitPart.match(/git\s+switch\s+([\w./-]+)/);
    if (branchMatch) return { type: 'branch-switch', cmd: gitPart, branch: branchMatch[1] };
  }

  // git merge
  if (/\bgit\s+merge\b/.test(gitPart)) {
    var mergeMatch = gitPart.match(/git\s+merge\s+(?:--[^\s]+\s+)*([\w./-]+)/);
    return { type: 'merge', cmd: gitPart, branch: mergeMatch ? mergeMatch[1] : '' };
  }

  // git rebase
  if (/\bgit\s+rebase\b/.test(gitPart)) {
    var rebaseMatch = gitPart.match(/git\s+rebase\s+(?:--[^\s]+\s+)*([\w./-]+)/);
    return { type: 'rebase', cmd: gitPart, branch: rebaseMatch ? rebaseMatch[1] : '' };
  }

  // git stash
  if (/\bgit\s+stash\b/.test(gitPart)) {
    return { type: 'stash', cmd: gitPart };
  }

  // git tag
  if (/\bgit\s+tag\b/.test(gitPart) && !/\bgit\s+tag\s+-d/.test(gitPart)) {
    var tagMatch = gitPart.match(/git\s+tag\s+(?:-[^\s]+\s+)*([\w./-]+)/);
    return { type: 'tag', cmd: gitPart, tag: tagMatch ? tagMatch[1] : '' };
  }

  return null;
}