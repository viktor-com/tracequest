/**
 * Off-thread redaction for hub responses (facts hrd1, hrd2, hrd4).
 *
 * redactText over a large body (a 300 MB raw recording, a big session page)
 * costs seconds of CPU; on the event loop that froze every other request and
 * delayed SIGTERM until it finished. Jobs run here on a small pool of worker
 * threads instead (worker-pool.js): a job still waiting can be dropped and a
 * running one cancelled by terminating its worker. Heavy jobs (whole
 * recordings) may occupy all but one worker, so a page-sized body is never
 * stuck behind two huge downloads.
 */
import { createWorkerPool } from "./worker-pool.js";

const HEAVY_BYTES = 16 * 1024 * 1024;

const _pool = createWorkerPool({ url: new URL("./redact-worker.js", import.meta.url), slots: 3 });

/**
 * Redact `text` (a string or Buffer) or the file at `path` on a worker thread,
 * as a body of `kind` (redactBody: "html" | "json" | "jsonl" | "text").
 * Returns { promise, cancel, isCancelled }: the promise resolves to the
 * redacted UTF-8 bytes; cancel() drops a queued job or terminates the worker
 * running it (the promise then rejects and isCancelled() is true).
 */
export function redactOffThread({ text, path, bytes = 0, kind = "text" }) {
  const job = _pool.run(path != null ? { path, kind } : { text, kind }, { heavy: bytes >= HEAVY_BYTES });
  const promise = job.promise.then(({ out, error }) => {
    if (error) throw new Error(error);
    return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
  });
  return { promise, cancel: job.cancel, isCancelled: job.isCancelled };
}
