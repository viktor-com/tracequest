import {
  indexClaudeJsonl,
  indexCursorJsonl,
  indexCursorCloudJsonl,
  indexFactoryJsonl,
  indexCodexJsonl,
  indexGrokJsonl,
} from "./session-index-jsonl.js";
import { indexOpenCode } from "./session-index-opencode.js";
import { indexDsh, indexFx } from "./session-index-fx-dsh.js";
import { discoveryRoots, discoverSessions } from "./session-discovery.js";
import { resolveHostsRoot, stampImportedHost } from "./session-discovery-paths.js";
import { runSidecar, runSidecarAsync, sidecarAvailable } from "./index-writers.js";
import { sortSessionsByMtimeDesc } from "./session-list.js";
import { rememberSessionPaths } from "./session-hash.js";

/** Module-scope dispatch table (hot path: workers call indexSession per stale session). */
const INDEX_SESSION_BY_SOURCE = new Map([
  ["codex", (session) => indexCodexJsonl(session.path)],
  ["cursor", (session) => indexCursorJsonl(session.path)],
  ["cursor-cloud", (session) => indexCursorCloudJsonl(session.path)],
  ["factory", (session) => indexFactoryJsonl(session.path)],
  ["grok", (session) => indexGrokJsonl(session.path, "grok")],
  ["vktr", (session) => indexGrokJsonl(session.path, "vktr")],
  ["opencode", (session) => indexOpenCode(session)],
  ["fx", (session) => indexFx(session.path)],
  ["dsh", (session) => indexDsh(session.path)],
  ["claude", (session) => indexClaudeJsonl(session.path)],
]);

/**
 * Every session source this build knows how to index — the keys of the dispatch
 * table above, sorted. Kept derived (not hand-written) so the two cannot drift.
 * Rust twin: `KNOWN_SOURCES` in `sidecar/src/indexer.rs` (fact z9k).
 */
export const KNOWN_SESSION_SOURCES = Object.freeze(
  [...INDEX_SESSION_BY_SOURCE.keys()].sort(),
);

/**
 * A session arrived with a `source` this build does not know how to index.
 *
 * This is a contract violation between the discovery layer and the indexer, not a
 * per-file read error: picking an indexer by guesswork writes a plausible-looking
 * but entirely fabricated entry into index.json.
 */
export class UnknownSessionSourceError extends Error {
  constructor(source, sessionPath) {
    super(
      `unrecognised session source ${JSON.stringify(source)} for ${sessionPath} — ` +
        `refusing to index (known sources: ${KNOWN_SESSION_SOURCES.join(", ")})`,
    );
    this.name = "UnknownSessionSourceError";
    this.source = source;
    this.path = sessionPath;
  }
}

/** Coerce numeric sidecar mtimes to Date (scan JSON uses epoch ms). */
export function coerceSidecarSessionMtimes(sessions) {
  for (const s of sessions) {
    if (typeof s.mtime === "number") s.mtime = new Date(s.mtime);
  }
  return sessions;
}

function parseSidecarScanStdout(stdout) {
  return coerceSidecarSessionMtimes(JSON.parse(stdout));
}

/**
 * Discover sessions from sidecar scan or JS filesystem walk.
 * Always returns a list sorted by mtime descending (newest first).
 */
function sidecarScanArgs(projectFilter) {
  const args = ["scan", "--roots", JSON.stringify(discoveryRoots())];
  if (projectFilter) args.push("--filter", projectFilter);
  return args;
}

function finishFoundSessions(sessions, projectFilter) {
  if (!sessions) {
    sessions = [];
    discoverSessions(projectFilter, sessions);
  }
  const hostsRoot = resolveHostsRoot();
  for (const session of sessions) stampImportedHost(session, hostsRoot);
  rememberSessionPaths(sessions);
  return sortSessionsByMtimeDesc(sessions);
}

export function findSessions(projectFilter) {
  const sessions = runSidecar("scan", sidecarScanArgs(projectFilter), (result) => parseSidecarScanStdout(result.stdout));
  return finishFoundSessions(sessions, projectFilter);
}

/**
 * findSessions for the server (fact hsa1): the sidecar scan runs as an
 * asynchronous child, so the event loop keeps answering while it walks.
 */
export async function findSessionsAsync(projectFilter) {
  const sessions = await runSidecarAsync("scan", sidecarScanArgs(projectFilter), (result) => parseSidecarScanStdout(result.stdout));
  return finishFoundSessions(sessions, projectFilter);
}

/**
 * Sessions under just these discovery roots, via one asynchronous sidecar scan
 * (fact hsi1): the incremental refresh rescans only the roots that gained or
 * lost a file. Unsorted; null when the sidecar is unavailable or failed, so the
 * caller falls back to a full scan instead of guessing.
 */
export async function findSessionsInRootsAsync(roots) {
  if (!sidecarAvailable()) return null;
  if (!roots.length) return [];
  const sessions = await runSidecarAsync("scan", ["scan", "--roots", JSON.stringify(roots)], (result) => parseSidecarScanStdout(result.stdout));
  if (!sessions) return null;
  const hostsRoot = resolveHostsRoot();
  for (const session of sessions) stampImportedHost(session, hostsRoot);
  return sessions;
}

/**
 * Index one session with the indexer registered for its source.
 *
 * Fails closed on an unrecognised source, consistently with the Rust half
 * (fact z9k): there is deliberately no catch-all fallback to indexClaudeJsonl.
 * Guessing produced an all-zero entry that buildIndex then persisted into
 * index.json stamped with the discovery row's mtime, so the mtime-equality
 * incremental check never re-indexed it — silent, sticky corruption.
 *
 * A session with no `source` at all is still a Claude session: that default is
 * what `sessionPayloadForSidecarIndex` already sends to the sidecar.
 */
export function indexSession(session) {
  const source = session.source || "claude";
  const indexer = INDEX_SESSION_BY_SOURCE.get(source);
  if (!indexer) throw new UnknownSessionSourceError(source, session.path);
  return indexer(session);
}
