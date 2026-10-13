/**
 * Worker thread that opens one recording for a page (facts hps1, hps2): the
 * whole-file parse, agent-sidecar history and session summary, and the body
 * built from them (session page, viewer JSON, Markdown or a comparison), so
 * opening a multi-hundred-MB recording never blocks the server's event loop.
 * The summary uses the index entry the server sent with the job. A page,
 * viewer JSON or Markdown body leaves here finished — hub-marked and redacted
 * in hub mode — as transferred UTF-8 bytes.
 */
import { parentPort } from "node:worker_threads";
import { parseSession } from "../parse/index.js";
import { renderHTML } from "../render.js";
import { comparePage } from "../browser/compare-page.js";
import { buildSessionChapters } from "../chapters/session-chapters.js";
import { attachSessionSummary } from "../sessions/session-summary.js";
import { currentIndexEntry, indexEntryIfCurrent } from "../sessions/index-writers.js";
import { completeParsedSession } from "./server-helpers.js";
import { finishSessionBody, sessionBody, sessionIdentity } from "./session-load.js";
import { redactBody } from "./redact-body.js";

/** Parse and complete one recording (what fetchSession does on the event loop). */
function load({ path, source }) {
  return completeParsedSession(parseSession(path, source), path);
}

/** Attach the summary from `entry`, the server's index entry for the recording (undefined: none loaded). */
function summarize(session, { path, entry }) {
  const indexEntry = entry === undefined
    ? currentIndexEntry
    : (p, mtimeMs) => (p === path ? indexEntryIfCurrent(entry, mtimeMs) : currentIndexEntry(p, mtimeMs));
  return attachSessionSummary(session, indexEntry);
}

/** Load one side of a comparison: { session } or { side, error | empty }. */
function loadSide(side, input) {
  let session;
  try {
    session = load(input);
  } catch (err) {
    return { side, error: String(err?.message || err) };
  }
  return session ? { session } : { side, empty: true };
}

function run(msg) {
  if (msg.op === "live") {
    // The /api/sessions/live body's session and chapters (fact clft: turn
    // bodies in full), serialized here so the server only splices them in.
    let session;
    try {
      session = parseSession(msg.path, msg.source, { full: true });
    } catch (err) {
      return { error: String(err?.message || err) };
    }
    // The rest of the body after its small head, finished here (in hub mode
    // each document redacted value by value, fact hrd6) and transferred as
    // UTF-8 bytes, so the event loop never copies or scans it (fact hlj1).
    let sessionJson = JSON.stringify(session ?? null);
    let chaptersJson = JSON.stringify(buildSessionChapters(session) ?? null);
    if (msg.hub) {
      sessionJson = redactBody(sessionJson, "json");
      chaptersJson = redactBody(chaptersJson, "json");
    }
    return { body: Buffer.from(`,"session":${sessionJson},"chapters":${chaptersJson}}`, "utf8") };
  }
  if (msg.op === "compare") {
    const a = loadSide("a", msg.a);
    if (!a.session) return a;
    if (!msg.b) return { needB: true };
    const b = loadSide("b", msg.b);
    if (!b.session) return b;
    for (const [side, input] of [[a, msg.a], [b, msg.b]]) {
      summarize(side.session, input);
      side.session._path = input.label;
    }
    return { body: comparePage(a.session, b.session) };
  }
  let session;
  try {
    session = load(msg);
  } catch (err) {
    return { error: String(err?.message || err) };
  }
  if (!session) return { empty: true };
  summarize(session, msg);
  // The body goes back finished, as UTF-8 bytes that are transferred, not
  // copied: the event loop never scans, rewrites, redacts or even encodes a
  // body the size of the recording (fact hps1).
  const { body, at, palette } = finishSessionBody(msg.op, sessionBody(msg.op, session, renderHTML), { hub: msg.hub, embed: msg.embed, shell: msg.shell, bytes: true });
  return { body, at, palette, session: sessionIdentity(session) };
}

/** The ArrayBuffer of `reply.body` when it can be transferred (small Buffers share a pooled one). */
function transferList(reply) {
  const b = reply?.body;
  if (!(b instanceof Uint8Array)) return [];
  return b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? [b.buffer] : [];
}

parentPort.on("message", (msg) => {
  let reply;
  try {
    reply = run(msg);
  } catch (err) {
    reply = { failed: String(err?.stack || err?.message || err) };
  }
  parentPort.postMessage({ id: msg.id, ...reply }, transferList(reply));
});
