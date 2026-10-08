import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Write JSONL to filePath.
 * - array of objects or strings: one line per element (objects are JSON.stringify'd)
 * - string: written as raw file body (discovery tests use "{}" placeholders)
 */
export function writeJsonl(filePath, linesOrBody = "{}") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let body;
  if (Array.isArray(linesOrBody)) {
    body = linesOrBody
      .map((row) => (typeof row === "string" ? row : JSON.stringify(row)))
      .join("\n");
    if (body) body += "\n";
  } else {
    body = linesOrBody;
  }
  fs.writeFileSync(filePath, body);
}

export function claudeProj(tmpDir, name) {
  return path.join(tmpDir, ".claude", "projects", name);
}

/** Stable cwd/model for Claude Code integration and parse fixtures. */
export const CLAUDE_FIXTURE_CWD = "/home/dev/tracequest";
export const CLAUDE_FIXTURE_MODEL = "claude-sonnet-4-20250514";

export function writeClaudeJsonl(dir, name, lines) {
  const filePath = path.join(dir, name);
  writeJsonl(filePath, lines);
  return filePath;
}

/**
 * Write JSONL and fsync the file so fs.watch observers see a durable on-disk change.
 * Use in live-reload integration tests to avoid flaky watch delivery on slow CI filesystems.
 */
export function writeJsonlSynced(filePath, linesOrBody = "{}") {
  writeJsonl(filePath, linesOrBody);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Like writeClaudeJsonl but fsyncs after write (live-reload harness). */
export function writeClaudeJsonlSynced(dir, name, lines) {
  const filePath = path.join(dir, name);
  writeJsonlSynced(filePath, lines);
  return filePath;
}

export function mkClaudeJsonlTmp(lines, suffix = "edge") {
  const dir = mkTmp(`parse-claude-${suffix}-`);
  const file = path.join(dir, "session.jsonl");
  writeJsonl(file, lines);
  return { dir, file };
}

/** Advance on-disk mtime so index invalidation tests see a stale cache entry. */
export function bumpFileMtime(filePath, offsetMs = 60_000) {
  const stat = fs.statSync(filePath);
  const bumped = new Date(stat.mtimeMs + offsetMs);
  fs.utimesSync(filePath, bumped, bumped);
}