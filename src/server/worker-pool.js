/**
 * A small pool of worker threads that run one job each at a time, so a job
 * still waiting can be dropped and a running one cancelled by terminating its
 * worker (facts hrd4, hps3). Heavy jobs may occupy at most `maxHeavy` workers,
 * so a page-sized job is never stuck behind several huge ones. Idle workers
 * are unref'd: they never keep a process (serve after SIGTERM, a CLI, a test)
 * alive.
 *
 * A worker answers each job's message with `{ id, ... }`; the job's promise
 * resolves to that reply. When `version()` changes (a non-hub serve that
 * hot-reloads its src), idle workers are replaced so the next job runs the
 * current code.
 */
import { SHARE_ENV, Worker } from "node:worker_threads";

export class CancelledError extends Error {}

export function createWorkerPool({ url, slots = 3, maxHeavy = slots - 1, version = () => 0 }) {
  const _slots = Array.from({ length: slots }, () => ({ worker: null, job: null, version: 0 }));
  const _queue = [];
  let _seq = 0;

  function spawn(slot) {
    // SHARE_ENV: the worker sees the server's environment as it is now and
    // later (cache dir, hosts root, test overrides), not a copy from spawn time.
    const worker = new Worker(url, { env: SHARE_ENV });
    worker.on("message", (reply) => {
      const job = slot.job;
      if (!job || job.id !== reply?.id) return;
      finish(slot, job);
      job.resolve(reply);
    });
    const lost = (err) => {
      if (slot.worker !== worker) return;
      slot.worker = null;
      const job = slot.job;
      if (job) {
        finish(slot, job);
        job.reject(job.cancelled ? new CancelledError("cancelled") : err || new Error("worker exited"));
      }
    };
    worker.on("error", (err) => lost(err));
    worker.on("exit", () => lost(null));
    // After the listeners: attaching a "message" listener re-refs the port.
    worker.unref();
    slot.version = version();
    return worker;
  }

  function finish(slot, job) {
    slot.job = null;
    job.running = false;
    slot.worker?.unref();
    setImmediate(pump);
  }

  function heavyRunning() {
    let n = 0;
    for (const s of _slots) if (s.job?.heavy) n++;
    return n;
  }

  function pump() {
    for (let q = 0; q < _queue.length;) {
      const job = _queue[q];
      const slot = _slots.find((s) => !s.job);
      if (!slot) return;
      if (job.heavy && heavyRunning() >= maxHeavy) {
        q++;
        continue;
      }
      _queue.splice(q, 1);
      try {
        if (slot.worker && slot.version !== version()) {
          const stale = slot.worker;
          slot.worker = null;
          stale.terminate();
        }
        if (!slot.worker) slot.worker = spawn(slot);
      } catch (err) {
        job.reject(err);
        continue;
      }
      slot.job = job;
      job.running = true;
      job.slot = slot;
      slot.worker.ref();
      slot.worker.postMessage(job.msg, job.transfer);
    }
  }

  /**
   * Queue `msg` (posted with an `id` added). Returns { promise, cancel,
   * isCancelled }: the promise resolves to the worker's reply; cancel() drops
   * a queued job or terminates the worker running it (the promise then
   * rejects with a CancelledError and isCancelled() is true).
   */
  function run(msg, { heavy = false, transfer = [] } = {}) {
    const id = ++_seq;
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const job = { id, msg: { ...msg, id }, transfer, heavy, running: false, cancelled: false, slot: null, resolve, reject };
    _queue.push(job);
    pump();
    const cancel = () => {
      if (job.cancelled) return;
      job.cancelled = true;
      const q = _queue.indexOf(job);
      if (q >= 0) {
        _queue.splice(q, 1);
        reject(new CancelledError("cancelled"));
      } else if (job.running && job.slot?.worker) {
        // A synchronous job cannot be interrupted; its worker can. The exit
        // handler rejects the job and frees the slot for a fresh worker.
        job.slot.worker.terminate();
      }
    };
    return { promise, cancel, isCancelled: () => job.cancelled };
  }

  /** Terminate idle workers (a later run starts new ones). */
  function closeIdle() {
    for (const slot of _slots) {
      if (slot.job || !slot.worker) continue;
      const worker = slot.worker;
      slot.worker = null;
      worker.terminate();
    }
  }

  return { run, closeIdle };
}
