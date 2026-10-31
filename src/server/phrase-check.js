/**
 * Quoted-phrase checks of the Runs filter off the event loop (facts flt1,
 * flt3): sessionHasPhrase runs in worker threads, a few sessions per job and
 * at most one job per worker at a time, so a request that is cancelled stops
 * after the jobs already running and a large session file never holds the
 * server.
 */
import { availableParallelism } from "node:os";
import { createWorkerPool } from "./worker-pool.js";
import { runSidecarAsync } from "../sessions/index-writers.js";
import { phraseByteTestApplies } from "../sessions/phrase-bytes.js";

/** Sessions per worker job: small, so a cancelled check stops soon. */
const BATCH = 4;
const MAX_WORKERS = 8;
/** Workers idle this long are stopped, so the hub holds no worker heaps between searches. */
const IDLE_MS = 30_000;

let _pool = null;
let _slots = 0;
let _idleTimer = null;

function pool() {
  if (!_pool) {
    _slots = Math.max(1, Math.min(MAX_WORKERS, availableParallelism() - 1));
    _pool = createWorkerPool({ url: new URL("../sessions/search-worker.js", import.meta.url), slots: _slots, maxHeavy: _slots });
  }
  return _pool;
}

/**
 * The search worker pool and its number of slots, for other per-session
 * search work of serve (search-steps.js); call releaseSearchWorkers() when
 * done, so idle workers are stopped.
 */
export function searchWorkers() {
  return { workers: pool(), slots: _slots };
}

/** Stop the search workers once they have been idle for IDLE_MS. */
export function releaseSearchWorkers() {
  clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => _pool?.closeIdle(), IDLE_MS);
  _idleTimer.unref?.();
}

/** Most files per sidecar byte test (fact flt7): a cancelled check stops after the one running. */
const BYTE_TEST_FILES = 4096;
/** The first byte test's files; each next test is four times larger up to BYTE_TEST_FILES, so workers start early. */
const FIRST_BYTE_TEST_FILES = 64;
/** Set once the sidecar's byte test failed: an older sidecar without it is not asked again. */
let _byteTestUnavailable = false;

/**
 * phraseMayOccurInFile of each session's file, in order, computed by the
 * sidecar in parallel: `[from, size, mtimeNs]` with from -1 when the file
 * cannot hold the phrase, else the byte offset of its first line that can,
 * for the file at that size and mtime. Null when the sidecar is unavailable
 * or failed (the workers then test the bytes themselves) or `signal` aborted
 * (the sidecar is stopped).
 */
async function sidecarByteTest(phrase, sessions, signal) {
  if (_byteTestUnavailable) return null;
  const out = await runSidecarAsync("phrase", ["phrase"], (result) => {
    const from = JSON.parse(result.stdout);
    const valid = (r) => Array.isArray(r) && Number.isInteger(r[0]) && r[0] >= -1 && Number.isInteger(r[1]) && typeof r[2] === "string";
    if (!Array.isArray(from) || from.length !== sessions.length || !from.every(valid)) {
      throw new Error("phrase: result count mismatch");
    }
    return from;
  }, { input: JSON.stringify({ phrase, files: sessions.map((s) => s.path) }), signal });
  if (!out && !signal?.aborted) _byteTestUnavailable = true;
  return out;
}

/** What a worker needs of an API session object to read its text. */
function sessionFields(s) {
  return { path: s.path, source: s.source, file: s.file, size: s.size, mtime: s.mtime };
}

/**
 * The Set of paths of `allSessions` holding `phrase` (lowercase), as
 * sessionHasPhrase decides; null once `signal` is aborted (the jobs then
 * running are cancelled). `onAnswer(session, hit)` hears each answer as it
 * is known. Workers line-scan the sessions in list order while the sidecar
 * byte-tests the ones after them, in chunks that start small, so the first
 * answers come early (fact flt7). A batch whose worker failed is retried once
 * in a fresh worker; a second failure rejects, so no session file is ever
 * read on the event loop and no answer is guessed (fact flt4).
 */
export async function verifyPhraseOffThread(phrase, sessions, signal, onAnswer = null) {
  const found = new Set();
  const answer = (s, hit) => {
    if (hit) found.add(s.path);
    onAnswer?.(s, hit);
  };
  const workers = pool();
  const running = new Set();
  const queue = [];
  // Session -> { from, size, mtimeNs }: its line scan starts at `from` if the file is still at that size and mtime.
  const scanFrom = new Map();
  let produced = false;
  let failed = false;
  let waiting = [];
  const wakeAll = () => { const w = waiting; waiting = []; for (const resolve of w) resolve(); };
  const cancelRunning = () => { for (const job of running) job.cancel(); wakeAll(); };
  signal?.addEventListener("abort", cancelRunning, { once: true });
  const stopped = () => failed || signal?.aborted;
  // Sessions whose file bytes cannot hold the phrase are answered without a worker.
  const produce = async () => {
    try {
      let size = FIRST_BYTE_TEST_FILES;
      for (let i = 0; i < sessions.length && !stopped();) {
        const chunk = sessions.slice(i, i + size);
        i += chunk.length;
        size = Math.min(size * 4, BYTE_TEST_FILES);
        const testable = chunk.filter((s) => phraseByteTestApplies(s, phrase));
        const from = testable.length ? await sidecarByteTest(phrase, testable, signal) : null;
        if (stopped()) return;
        const ruledOut = new Set();
        if (from) {
          testable.forEach((s, k) => {
            const [start, size, mtimeNs] = from[k];
            if (start < 0) ruledOut.add(s);
            else if (start > 0 && mtimeNs) scanFrom.set(s, { from: start, size, mtimeNs });
            else scanFrom.set(s, { from: 0 });
          });
        }
        for (const s of chunk) {
          if (ruledOut.has(s)) answer(s, false);
          else queue.push(s);
        }
        wakeAll();
      }
    } finally {
      produced = true;
      wakeAll();
    }
  };
  const check = async (batch) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) return null;
      const job = workers.run({ phrase: { phrase, sessions: batch.map(sessionFields), from: batch.map((s) => scanFrom.get(s) ?? null) } });
      running.add(job);
      try {
        const reply = await job.promise;
        if (Array.isArray(reply?.found) && reply.found.every((hit) => hit === true || hit === false)) return reply.found;
      } catch {
        // Cancelled, or the worker died: retried below unless aborted.
      } finally {
        running.delete(job);
      }
    }
    if (signal?.aborted) return null;
    failed = true;
    wakeAll();
    throw new Error("quoted phrase check failed in its worker");
  };
  let next = 0;
  const feed = async () => {
    while (!stopped()) {
      if (next >= queue.length) {
        if (produced) return;
        await new Promise((resolve) => waiting.push(resolve));
        continue;
      }
      const batch = queue.slice(next, next + BATCH);
      next += batch.length;
      const hits = await check(batch);
      if (!hits) return;
      batch.forEach((session, k) => answer(session, hits[k]));
    }
  };
  try {
    await Promise.all([produce(), ...Array.from({ length: _slots }, feed)]);
  } finally {
    signal?.removeEventListener("abort", cancelRunning);
    releaseSearchWorkers();
  }
  return signal?.aborted ? null : found;
}
