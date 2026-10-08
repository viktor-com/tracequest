import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { forEachParsedJsonlLine } from "../parse/jsonl-read.js";
import { parseCursor } from "../parse/parse-claude.js";
import {
  claudeSubagentsDirFromSessionDir,
  claudeSubagentsDirFromSessionPath,
  listClaudeSubagentJsonlFiles,
} from "../sessions/claude-subagents.js";
import { isIndexDiskExpectedErr } from "../utils/fs-expected-err.js";

/**
 * @typedef {Object} AgentHistoryEntry
 * @property {string} agentId
 * @property {string} path
 * @property {number} lineIndex
 * @property {object} record
 * @property {number|null} timestampMs
 */

/** Parse ISO timestamp or epoch-ms fields from a JSONL record. */
export function historyTimestamp(record) {
  if (!record || typeof record !== "object") return null;
  const ts = record.timestamp ?? record.ts;
  if (ts == null) return null;
  if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  const ms = Date.parse(String(ts));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Parse in-memory JSONL into history entries for one agent.
 * Malformed lines are skipped; empty input yields [].
 *
 * @param {string} raw
 * @param {{ agentId?: string, path?: string }} [opts]
 * @returns {AgentHistoryEntry[]}
 */
export function parseAgentHistoryJsonl(raw, opts = {}) {
  const agentId = opts.agentId ?? "default";
  const path = opts.path ?? "";
  const entries = [];
  let lineIndex = 0;
  forEachParsedJsonlLine(typeof raw === "string" ? raw : "", (record) => {
    entries.push({
      agentId,
      path,
      lineIndex,
      record,
      timestampMs: historyTimestamp(record),
    });
    lineIndex++;
  });
  return entries;
}

/**
 * Claude stores subagent JSONL logs beside the parent session:
 * `{project}/{sessionId}.jsonl` + `{project}/{sessionId}/subagents/*.jsonl`.
 *
 * Cursor reuses the same `subagents/` convention but with the directory as a
 * sibling of the parent transcript:
 * `agent-transcripts/{uuid}/{uuid}.jsonl` + `agent-transcripts/{uuid}/subagents/*.jsonl`.
 * Cursor sidecar entries carry `format: "cursor"` so loaders parse the Cursor
 * row shape; Claude entries keep the original `{ agentId, path }` shape.
 */
export function discoverAgentSidecarPaths(sessionPath) {
  if (!sessionPath || typeof sessionPath !== "string") return [];
  if (!sessionPath.endsWith(".jsonl")) return [];

  if (sessionPath.includes(".claude/")) {
    const subDir = claudeSubagentsDirFromSessionPath(sessionPath);
    return listClaudeSubagentJsonlFiles(subDir, { logLabel: "discoverAgentSidecarPaths" }).map(
      ({ name, path }) => ({
        agentId: name.replace(/\.jsonl$/, ""),
        path,
      }),
    );
  }

  if (sessionPath.includes(".cursor/")) return discoverCursorAgentSidecarPaths(sessionPath);

  return [];
}

/**
 * Sidecar discovery for a Cursor parent transcript. Only the parent gets
 * sidecars: the file basename must match the enclosing `agent-transcripts`
 * uuid directory, which is never true for `subagents/*.jsonl` files
 * themselves. Cursor rows carry no timestamps, so sidecars are ordered by
 * file mtime (oldest first) as the cross-sidecar ordering key for the merge.
 */
function discoverCursorAgentSidecarPaths(sessionPath) {
  if (!sessionPath.includes("agent-transcripts/")) return [];
  const sessionDir = dirname(sessionPath);
  if (basename(sessionDir) !== basename(sessionPath, ".jsonl")) return [];

  const subDir = claudeSubagentsDirFromSessionDir(sessionDir);
  const sidecars = listClaudeSubagentJsonlFiles(subDir, {
    logLabel: "discoverAgentSidecarPaths",
  }).map(({ name, path }) => {
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      // Race between readdir and stat: keep the sidecar with a neutral mtime.
    }
    return { agentId: name.replace(/\.jsonl$/, ""), path, format: "cursor", mtimeMs };
  });
  sidecars.sort((a, b) => a.mtimeMs - b.mtimeMs || a.agentId.localeCompare(b.agentId));
  return sidecars.map(({ mtimeMs: _mtimeMs, ...rest }) => rest);
}

/**
 * Load and merge subagent sidecar histories for a parent session path.
 * Returns null when no sidecar files exist.
 *
 * @param {string} sessionPath
 * @param {Array<{ agentId: string, path: string }>|null} [knownSidecars]
 * @returns {AgentHistoryEntry[]|null}
 */
export function loadAgentHistoryForSession(sessionPath, knownSidecars) {
  const sidecars = knownSidecars ?? discoverAgentSidecarPaths(sessionPath);
  if (!sidecars.length) return null;
  const merged = mergeAgentHistories(sidecars);
  return merged.length ? merged : null;
}

/** Read a JSONL session file into history entries. Missing/unreadable paths return []. */
export function loadAgentHistoryFile(filePath, agentId) {
  if (!filePath || typeof filePath !== "string") return [];
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, "utf-8");
    return parseAgentHistoryJsonl(raw, {
      agentId: agentId ?? filePath,
      path: filePath,
    });
  } catch (err) {
    if (!isIndexDiskExpectedErr(err)) {
      console.error(`loadAgentHistoryFile: failed to read ${filePath}:`, err.message);
    }
    return [];
  }
}

/**
 * Read a Cursor JSONL sidecar into history entries. Cursor rows
 * (`{role, message:{content}}` plus `turn_ended` markers) carry no
 * timestamps, so records are the canonical Cursor parser's Claude-shape
 * events (type/text/toolCalls with `timestamp: null`); `lineIndex` is the
 * event index, preserving file order, and `timestampMs` stays null so the
 * merge never fabricates epoch times. Missing/unreadable paths return [].
 */
export function loadCursorAgentHistoryFile(filePath, agentId) {
  if (!filePath || typeof filePath !== "string") return [];
  if (!existsSync(filePath)) return [];
  try {
    const session = parseCursor(filePath);
    const events = Array.isArray(session?.events) ? session.events : [];
    return events.map((record, lineIndex) => ({
      agentId: agentId ?? filePath,
      path: filePath,
      lineIndex,
      record,
      timestampMs: historyTimestamp(record),
    }));
  } catch (err) {
    if (!isIndexDiskExpectedErr(err)) {
      console.error(`loadCursorAgentHistoryFile: failed to read ${filePath}:`, err.message);
    }
    return [];
  }
}

/**
 * Merge histories from multiple agents in chronological order.
 * When timestamps are missing or equal, source order (first listed agent wins) then
 * line index within the file breaks ties.
 *
 * @param {Array<{
 *   agentId?: string,
 *   path?: string,
 *   format?: string,
 *   raw?: string,
 *   entries?: AgentHistoryEntry[],
 * }>} sources
 * @returns {AgentHistoryEntry[]}
 */
export function mergeAgentHistories(sources) {
  if (!sources?.length) return [];

  const agentOrder = new Map();
  let nextOrder = 0;
  const flat = [];

  for (const src of sources) {
    const agentId = src.agentId ?? src.path ?? `agent-${nextOrder}`;
    if (!agentOrder.has(agentId)) agentOrder.set(agentId, nextOrder++);

    let entries = src.entries;
    if (!entries) {
      if (src.raw !== undefined) {
        entries = parseAgentHistoryJsonl(src.raw, {
          agentId,
          path: src.path ?? "",
        });
      } else if (src.path) {
        entries =
          src.format === "cursor"
            ? loadCursorAgentHistoryFile(src.path, agentId)
            : loadAgentHistoryFile(src.path, agentId);
      } else {
        entries = [];
      }
    }

    const order = agentOrder.get(agentId);
    for (const entry of entries) {
      flat.push({
        ...entry,
        agentId: entry.agentId ?? agentId,
        _agentOrder: order,
      });
    }
  }

  flat.sort(compareHistoryEntries);
  return flat.map(stripSortMeta);
}

function compareHistoryEntries(a, b) {
  const ta = a.timestampMs;
  const tb = b.timestampMs;
  const aHas = ta != null;
  const bHas = tb != null;

  if (aHas && bHas && ta !== tb) return ta - tb;
  if (aHas && !bHas) return -1;
  if (!aHas && bHas) return 1;

  if (a._agentOrder !== b._agentOrder) return a._agentOrder - b._agentOrder;
  if (a.lineIndex !== b.lineIndex) return a.lineIndex - b.lineIndex;
  return String(a.agentId).localeCompare(String(b.agentId));
}

function stripSortMeta(entry) {
  const { _agentOrder, ...rest } = entry;
  return rest;
}