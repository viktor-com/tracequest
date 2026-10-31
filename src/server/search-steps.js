/**
 * searchSessionsAsync's per-session file work for serve's GET /api/search
 * (fact hsw1): the result snippet scans, a quoted query's phrase checks and
 * the OpenCode/dsh near-words scoring run side by side in the search worker
 * threads, not on the event loop. A batch whose worker failed is retried
 * once in a fresh worker and otherwise fails the request.
 */
import { releaseSearchWorkers, searchWorkers } from "./phrase-check.js";

/** `items` in at most `slots` batches of about equal file size: [[index, item], ...] each. */
function balancedBatches(items, slots, sizeOf) {
  const batches = Array.from({ length: Math.min(slots, items.length) }, () => ({ bytes: 0, items: [] }));
  const order = items.map((item, i) => [i, item]).sort((a, b) => sizeOf(b[1]) - sizeOf(a[1]));
  for (const entry of order) {
    let least = batches[0];
    for (const b of batches) if (b.bytes < least.bytes) least = b;
    least.items.push(entry);
    least.bytes += sizeOf(entry[1]);
  }
  return batches.map((b) => b.items).filter((b) => b.length);
}

const sessionSize = (session) => Number(session?.size) || 0;

/**
 * Run `message(items)` for one batch in a search worker and return
 * `read(reply)`, an array with one answer per item; a batch whose worker
 * failed, or that left an item unanswered, is retried once in a fresh
 * worker, and a second failure fails the search: no session file is read on
 * the event loop and no answer is guessed (as flt4 does for phrase checks).
 */
async function inWorker(workers, items, message, read) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const answers = read(await workers.run(message(items)).promise);
      if (Array.isArray(answers) && answers.length === items.length && answers.every((a) => a != null)) return answers;
    } catch {
      // The worker died: retried below.
    }
  }
  throw new Error("search file work failed in its worker");
}

/**
 * runStep for searchSessionsAsync; `isGone()` true stops the search at its
 * next step (the client closed the request).
 */
export function searchStepRunner(isGone) {
  return async (step) => {
    if (isGone()) throw new Error("search client went away");
    const { workers, slots } = searchWorkers();
    try {
      if (step.nearScans) {
        const { args, sessions } = step.nearScans;
        const scores = new Array(sessions.length);
        await Promise.all(balancedBatches(sessions, slots, sessionSize).map(async (batch) => {
          const answers = await inWorker(workers, batch, (b) => ({ near: { args, sessions: b.map(([, session]) => session) } }), (reply) => reply?.scores);
          batch.forEach(([i], j) => { scores[i] = answers[j]; });
        }));
        return scores;
      }
      if (step.phraseScans) {
        const answered = new Map();
        await Promise.all(balancedBatches(step.phraseScans, slots, (request) => sessionSize(request.session)).map(async (batch) => {
          const answers = await inWorker(workers, batch, (b) => ({ phraseScans: b.map(([, request]) => request) }), (reply) => reply?.scans);
          batch.forEach(([, request], j) => answered.set(request.path, answers[j]));
        }));
        return answered;
      }
      const scanned = new Map();
      await Promise.all(balancedBatches(step.snippetScans, slots, (request) => sessionSize(request.session)).map(async (batch) => {
        const answers = await inWorker(workers, batch, (b) => ({ requests: b.map(([, { session, terms }]) => ({ session, terms })) }), (reply) => reply?.scans);
        batch.forEach(([, request], j) => scanned.set(request.path, new Map(answers[j])));
      }));
      return scanned;
    } finally {
      releaseSearchWorkers();
    }
  };
}
