import { workerData } from "node:worker_threads";

const { sessions, sab, workerIndex, port } = workerData;
const signals = new Int32Array(sab);
if (workerIndex === 0) {
  port.postMessage({ [sessions[0]?.path || "/none"]: { firstPrompt: "w0" } });
} else {
  // Signal done without posting (simulates missing message).
}
Atomics.store(signals, workerIndex, 1);
Atomics.notify(signals, workerIndex);