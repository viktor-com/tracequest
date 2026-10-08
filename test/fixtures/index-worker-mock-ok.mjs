import { workerData } from "node:worker_threads";

const { sessions, sab, workerIndex, port } = workerData;
const signals = new Int32Array(sab);
const results = {};
for (const s of sessions) {
  results[s.path] = { firstPrompt: "from-worker" };
}
port.postMessage(results);
Atomics.store(signals, workerIndex, 1);
Atomics.notify(signals, workerIndex);