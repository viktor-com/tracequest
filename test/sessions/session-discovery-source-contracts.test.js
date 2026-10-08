import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SRC_ROOT = join(REPO_ROOT, "src");
const SESSION_DISCOVERY_REL = "src/sessions/session-discovery.js";
const SESSION_DISCOVERY_PATHS_REL = "src/sessions/session-discovery-paths.js";

function readProjectFile(relPath) {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

function listJsFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      listJsFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

function sourceRelPath(filePath) {
  return relative(REPO_ROOT, filePath).split("\\").join("/");
}

function functionBody(source, name) {
  const marker = `export function ${name}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} must be exported`);

  const braceStart = source.indexOf("{", start);
  assert.notEqual(braceStart, -1, `${name} must have a function body`);

  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(braceStart + 1, i);
    }
  }
  assert.fail(`${name} body did not close`);
}

test("OpenCode SQLite production access stays behind the shared warning-suppressing loader", () => {
  const pathsSrc = readProjectFile(SESSION_DISCOVERY_PATHS_REL);
  assert.match(pathsSrc, /const origEmitWarning = process\.emitWarning/);
  assert.match(pathsSrc, /process\.emitWarning = \(warning, \.\.\.args\) =>/);
  assert.match(pathsSrc, /includesLower\(msg, "sqlite"\)/);
  assert.match(pathsSrc, /includesLower\(msg, "experimental"\)/);
  assert.match(pathsSrc, /createRequire\(import\.meta\.url\)\("node:sqlite"\)/);
  assert.match(pathsSrc, /process\.emitWarning = origEmitWarning/);

  // Only the loader may reach for node:sqlite directly. Other modules (e.g. the
  // Cursor state.vscdb reader) may hold a DatabaseSync handle, but only one
  // obtained from loadDatabaseSync -- otherwise the experimental-warning
  // suppression is bypassed.
  const rawSqliteFiles = listJsFiles(SRC_ROOT)
    .filter((filePath) => /node:sqlite/.test(readFileSync(filePath, "utf8")))
    .map(sourceRelPath)
    .sort();
  assert.deepEqual(rawSqliteFiles, [SESSION_DISCOVERY_PATHS_REL]);

  for (const filePath of listJsFiles(SRC_ROOT)) {
    const rel = sourceRelPath(filePath);
    if (rel === SESSION_DISCOVERY_PATHS_REL) continue;
    const src = readFileSync(filePath, "utf8");
    if (!/\bDatabaseSync\b/.test(src)) continue;
    assert.match(
      src,
      /import \{[^}]*\bloadDatabaseSync\b[^}]*\} from "[^"]*session-discovery-paths\.js"/,
      `${rel} uses DatabaseSync without importing loadDatabaseSync`,
    );
  }

  const probe = `
    import { loadDatabaseSync } from "./src/sessions/session-discovery-paths.js";
    const DatabaseSync = loadDatabaseSync();
    if (typeof DatabaseSync !== "function") throw new Error("DatabaseSync was not loaded");
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stderr, /ExperimentalWarning.*sqlite|sqlite.*ExperimentalWarning/is);
});

test("filesystem discovery helpers use Dirent traversal and shared output arrays", () => {
  const discoverySrc = readProjectFile(SESSION_DISCOVERY_REL);
  const discoverBody = functionBody(discoverySrc, "discoverSessions");
  for (const name of [
    "findClaudeSessions",
    "findCodexSessions",
    "findCursorSessions",
    "findFactorySessions",
    "findGrokSessions",
    "findOpenCodeSessions",
  ]) {
    assert.match(discoverBody, new RegExp(`${name}\\(projectFilter, out, paths\\);`));
  }
  assert.match(discoverBody, /return out;/);

  for (const name of [
    "findCodexSessions",
  ]) {
    assert.ok(
      discoverySrc.includes(`export function ${name}(projectFilter, out = [], paths = getDiscoveryPaths())`),
      `${name} must accept the caller-provided output array`,
    );
    const body = functionBody(discoverySrc, name);
    // Dirent traversal now goes through the shared guarded reader, so one
    // unreadable subtree skips instead of emptying the session list (fact a4k).
    assert.match(body, /readDirEntries\(/, `${name} must read directories through readDirEntries`);
    assert.match(body, /\bout\.push\s*\(/, `${name} must append to the shared output array`);
    assert.match(body, /return out;/, `${name} must return the shared output array`);
  }

  // The guarded reader is the single place Dirent traversal is configured; it
  // is module-private on purpose, so match its declaration in the source.
  const readerStart = discoverySrc.indexOf("function readDirEntries(");
  assert.notEqual(readerStart, -1, "session-discovery must define readDirEntries");
  assert.match(
    discoverySrc.slice(readerStart, readerStart + 400),
    /readdirSync\([^)]*\{\s*withFileTypes:\s*true\s*\}/s,
    "readDirEntries must use Dirent reads",
  );

  const claudeBody = functionBody(discoverySrc, "findClaudeSessions");
  assert.match(claudeBody, /findClaudeFamilySessions\(projectFilter, out, paths\.claudeDir, "claude"\)/);

  const cursorBody = functionBody(discoverySrc, "findCursorSessions");
  // The agent-transcripts nesting is defined once in session-layout.js and consumed
  // by discovery, live detection, attribution and the fs watcher; discovery must build
  // it from that module rather than re-inlining the literal (a divergence between the
  // two once made every cursor-agent run pend forever with its transcript on disk).
  assert.match(
    cursorBody,
    /CURSOR_TRANSCRIPTS_DIR/,
    "findCursorSessions must take the transcripts dir from the shared layout module",
  );
  assert.match(
    readProjectFile("src/sessions/session-layout.js"),
    /CURSOR_TRANSCRIPTS_DIR\s*=\s*"agent-transcripts"/,
    "the shared layout module must define the real cursor transcripts dir",
  );
  assert.match(cursorBody, /readDirEntries\(/);
  assert.match(cursorBody, /\bout\.push\s*\(/);
  assert.match(cursorBody, /return out;/);

  const familyStart = discoverySrc.indexOf("function findClaudeFamilySessions");
  assert.notEqual(familyStart, -1, "Claude-family discovery helper must exist");
  const familySrc = discoverySrc.slice(familyStart, discoverySrc.indexOf("export function findCodexSessions", familyStart));
  assert.match(familySrc, /readDirEntries\(/);
  assert.match(familySrc, /\bout\.push\s*\(/);
  assert.match(familySrc, /return out;/);

  for (const name of [
    "findFactorySessions",
    "findGrokSessions",
  ]) {
    assert.ok(
      discoverySrc.includes(`export function ${name}(projectFilter, out = [], paths = getDiscoveryPaths())`),
      `${name} must accept the caller-provided output array`,
    );
    const body = functionBody(discoverySrc, name);
    assert.match(body, /readDirEntries\(/, `${name} must read directories through readDirEntries`);
    assert.match(body, /\bout\.push\s*\(/, `${name} must append to the shared output array`);
    assert.match(body, /return out;/, `${name} must return the shared output array`);
  }
});
