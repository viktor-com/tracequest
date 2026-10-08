/**
 * Synthetic session corpus generator for the bench harness.
 *
 * Reuses the fixture writers the test suite already ships
 * (test/helpers/synthetic-sessions.js) so a bench corpus and a test corpus
 * are the same shape, and adds the adversarial cases the harness needs and
 * the unit tests deliberately do not carry: multi-hundred-MB transcripts,
 * a transcript being appended to while it is indexed, a session deleted
 * mid-scan, a symlinked directory cycle, an unreadable directory, and an
 * imported remote-host tree.
 *
 * Everything is written under a throwaway $HOME so a bench run can never
 * touch the operator's real ~/.claude.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  writeSyntheticClaudeSessions,
  writeSyntheticCodexSessions,
  writeSyntheticFactorySessions,
  writeSyntheticGrokSessions,
  writeSyntheticOpenCodeSessions,
  makeClaudeSessionLines,
} from "../../test/helpers/synthetic-sessions.js";

/** Sources the generator can populate, in the order it populates them. */
export const BENCH_SOURCES = Object.freeze([
  "claude",
  "codex",
  "factory",
  "grok",
  "opencode",
]);

/** Create a throwaway $HOME root for one bench corpus. */
export function makeBenchHome(tag = "tq-bench-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), tag));
}

function claudeProjectDir(home, project) {
  return path.join(home, ".claude", "projects", project);
}

/**
 * Write `perSource` sessions for each requested source under `home`.
 * Returns the descriptor list plus per-source counts, so a correctness run can
 * assert discovered-vs-expected without re-walking the tree itself.
 */
export async function seedCorpus(home, opts = {}) {
  const {
    perSource = 1000,
    sources = BENCH_SOURCES,
    fillerLines = 8,
    markerPrefix = "benchneedle",
  } = opts;

  const expected = [];
  const bySource = {};

  for (const source of sources) {
    let written = [];
    if (source === "claude") {
      const projDir = claudeProjectDir(home, "benchproj");
      ({ sessions: written } = writeSyntheticClaudeSessions(projDir, {
        sessionCount: perSource,
        fillerLines,
        markerPrefix: `${markerPrefix}-claude`,
      }));
    } else if (source === "codex") {
      ({ sessions: written } = writeSyntheticCodexSessions(home, {
        sessionCount: perSource,
        fillerLines,
        markerPrefix: `${markerPrefix}-codex`,
      }));
    } else if (source === "factory") {
      ({ sessions: written } = writeSyntheticFactorySessions(home, {
        sessionCount: perSource,
        fillerLines,
        markerPrefix: `${markerPrefix}-factory`,
      }));
    } else if (source === "grok") {
      ({ sessions: written } = writeSyntheticGrokSessions(home, {
        sessionCount: perSource,
        fillerLines,
        markerPrefix: `${markerPrefix}-grok`,
      }));
    } else if (source === "opencode") {
      ({ sessions: written } = await writeSyntheticOpenCodeSessions(home, {
        sessionCount: perSource,
        markerPrefix: `${markerPrefix}-opencode`,
      }));
    } else {
      throw new Error(`seedCorpus: unknown source ${source}`);
    }
    bySource[source] = written.length;
    expected.push(...written);
  }

  return { home, expected, bySource, expectedPaths: new Set(expected.map((s) => s.path)) };
}

/**
 * Write one Claude transcript of approximately `targetMb` megabytes.
 *
 * The point is a transcript that must never be buffered whole: at 300 MB a
 * readFileSync of it is already half of a default Node heap.
 */
export function seedHugeTranscript(home, opts = {}) {
  const { targetMb = 300, project = "benchhuge", name = "huge-0.jsonl" } = opts;
  const projDir = claudeProjectDir(home, project);
  fs.mkdirSync(projDir, { recursive: true });
  const filePath = path.join(projDir, name);

  const { lines } = makeClaudeSessionLines(0, {
    fillerLines: 0,
    markerPrefix: "benchhuge",
  });
  const head = lines.map((row) => JSON.stringify(row)).join("\n") + "\n";

  // One filler row is ~1 KiB; write in 8 MiB blocks so the generator itself
  // stays flat in memory.
  const filler = JSON.stringify({ type: "progress", data: "x".repeat(1000) }) + "\n";
  const blockRows = Math.ceil((8 * 1024 * 1024) / filler.length);
  const block = filler.repeat(blockRows);
  const blockBytes = Buffer.byteLength(block);
  const targetBytes = targetMb * 1024 * 1024;

  const fd = fs.openSync(filePath, "w");
  try {
    fs.writeSync(fd, head);
    let written = Buffer.byteLength(head);
    while (written < targetBytes) {
      fs.writeSync(fd, block);
      written += blockBytes;
    }
    // Close with a real assistant row so the tail heuristics see a boundary.
    fs.writeSync(fd, head);
  } finally {
    fs.closeSync(fd);
  }

  return { path: filePath, bytes: fs.statSync(filePath).size, project };
}

/**
 * Materialise an imported remote-host tree: <hostsRoot>/<host>/ is a synthetic
 * $HOME, so the same discovery code runs over it a second time.
 */
export async function seedImportedHost(home, opts = {}) {
  const { host = "benchhost", perSource = 50, sources = ["claude", "codex"] } = opts;
  const hostHome = path.join(home, ".local", "share", "tracequest", "hosts", host);
  fs.mkdirSync(hostHome, { recursive: true });
  const seeded = await seedCorpus(hostHome, {
    perSource,
    sources,
    markerPrefix: `benchhost-${host}`,
  });
  return { host, hostHome, ...seeded };
}

/** A symlink that points at one of its own ancestors — a walk with no loop guard hangs. */
export function seedSymlinkCycle(home, opts = {}) {
  const { project = "benchloop" } = opts;
  const projDir = claudeProjectDir(home, project);
  fs.mkdirSync(projDir, { recursive: true });
  const linkPath = path.join(projDir, "loop");
  try {
    fs.symlinkSync(path.join(home, ".claude", "projects"), linkPath, "dir");
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
  }
  return { linkPath, projDir };
}

/** A directory the scanning user cannot read — an unguarded walk throws EACCES. */
export function seedUnreadableDir(home, opts = {}) {
  const { project = "benchdenied" } = opts;
  const projDir = claudeProjectDir(home, project);
  fs.mkdirSync(projDir, { recursive: true });
  const denied = path.join(projDir, "denied");
  fs.mkdirSync(denied, { recursive: true });
  fs.writeFileSync(path.join(denied, "session-0.jsonl"), "{}\n");
  fs.chmodSync(denied, 0o000);
  return {
    deniedPath: denied,
    restore: () => {
      try {
        fs.chmodSync(denied, 0o755);
      } catch {}
    },
  };
}

/** Append one realistic user+assistant turn to an existing Claude transcript. */
export function appendTurn(filePath, marker) {
  const rows = [
    { type: "user", message: { content: [{ type: "text", text: `${marker} appended prompt` }] } },
    {
      type: "assistant",
      message: {
        model: "claude-3-opus",
        content: [{ type: "text", text: `${marker} appended reply` }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      timestamp: new Date().toISOString(),
    },
  ];
  fs.appendFileSync(filePath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return marker;
}

/** Append a line and stop halfway through it, leaving a torn trailing record. */
export function appendPartialLine(filePath) {
  const row = JSON.stringify({
    type: "user",
    message: { content: [{ type: "text", text: "benchpartial torn record" }] },
  });
  fs.appendFileSync(filePath, row.slice(0, Math.floor(row.length / 2)));
  return { truncatedFrom: row };
}

/** Finish a record previously torn by appendPartialLine. */
export function completePartialLine(filePath, truncatedFrom) {
  fs.appendFileSync(filePath, truncatedFrom.slice(Math.floor(truncatedFrom.length / 2)) + "\n");
}

export function removeCorpus(home) {
  fs.rmSync(home, { recursive: true, force: true });
}
