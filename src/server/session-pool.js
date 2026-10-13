/**
 * Session opens off the event loop (facts hps1-hps4).
 *
 * Parsing a recording is a synchronous whole-file pass: ~0.1-1 s for the
 * largest ones, and on the event loop it froze every other request for that
 * long (the sum, for concurrent opens). The routes that show a session hand
 * the parse, and the body built from it, to these workers; the session handle
 * is still resolved on the event loop first. A recording of 32 MB or more is
 * a heavy job: at most two run at once, so a page-sized open is never queued
 * behind three giant ones.
 */
import { statSync } from "node:fs";
import { createWorkerPool } from "./worker-pool.js";
import { modVersion } from "./server-live-reload.js";
import { loadedIndexEntry } from "../sessions/index-writers.js";
import { parseSession } from "../parse/index.js";
import { renderHTML } from "../render.js";

const HEAVY_BYTES = 32 * 1024 * 1024;

const _pool = createWorkerPool({
  url: new URL("./session-worker.js", import.meta.url),
  slots: 3,
  version: modVersion,
});

/** parseSession/renderHTML the server loads itself (hot-reloaded copies included): only these run in the workers. */
const _stock = new WeakSet([parseSession, renderHTML]);

export function registerStockSessionModules(mods) {
  if (mods?.parseSession) _stock.add(mods.parseSession);
  if (mods?.renderHTML) _stock.add(mods.renderHTML);
}

/** True when `mods` parse and render with the server's own modules, which the workers run (fact hps4). */
export function usesSessionWorkers(mods) {
  return Boolean(mods && _stock.has(mods.parseSession) && _stock.has(mods.renderHTML));
}

function isHeavy(path) {
  if (path.startsWith("opencode://")) return false;
  try {
    return statSync(path).size >= HEAVY_BYTES;
  } catch {
    return false;
  }
}

/** One recording to open: its path, source, and the server's index entry for it. */
function input(path, source, label) {
  return { path, source, entry: loadedIndexEntry(path), label };
}

/**
 * Open the recording at `path` in a worker and build `op`'s body ("html",
 * "data" or "markdown", see sessionBody), finished there by
 * finishSessionBody with { hub, embed, shell }. Returns { promise, cancel,
 * isCancelled }; the promise resolves to { body, at, palette, session }
 * (body: a Buffer of UTF-8 bytes, at: a byte offset; session: identity
 * fields), { empty: true } when the parse yields no
 * session, { error } when it throws, or { failed } when building the body
 * threw.
 */
export function openSessionOffThread(op, path, source, { hub = false, embed = false, shell = null } = {}) {
  const job = _pool.run({ op, ...input(path, source), hub, embed, shell }, { heavy: isHeavy(path) });
  const promise = job.promise.then((reply) => {
    const b = reply.body;
    // Structured cloning hands back a plain Uint8Array: view it as a Buffer, no copy.
    if (b instanceof Uint8Array && !Buffer.isBuffer(b)) reply.body = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
    return reply;
  });
  return { ...job, promise };
}

/**
 * Parse the recording at `path` in full in a worker and serialize what
 * /api/sessions/live answers for it, redacted there in hub mode (`hub`). The
 * promise resolves to { body } (a Buffer: `,"session":…,"chapters":…}`, the
 * body after its head), { error } when the parse throws, or { failed }.
 */
export function openLiveSessionOffThread(path, source, { hub = false } = {}) {
  const job = _pool.run({ op: "live", path, source, hub }, { heavy: isHeavy(path) });
  const promise = job.promise.then((reply) => {
    const b = reply.body;
    if (b instanceof Uint8Array && !Buffer.isBuffer(b)) reply.body = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
    return reply;
  });
  return { ...job, promise };
}

/**
 * Open both recordings of a comparison in one worker and render the compare
 * page. `b` is null when its handle did not resolve: the reply is then
 * { needB: true } unless side A fails first ({ side: "a", error | empty }).
 */
export function openCompareOffThread(a, b) {
  return _pool.run({
    op: "compare",
    a: input(a.path, a.source, a.label),
    b: b ? input(b.path, b.source, b.label) : null,
  }, { heavy: isHeavy(a.path) || Boolean(b && isHeavy(b.path)) });
}
