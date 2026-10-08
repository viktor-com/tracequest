import { workerData } from "node:worker_threads";

const { sab, workerIndex, port } = workerData;
const signals = new Int32Array(sab);
port.postMessage({ _error: "mock worker boom" });
Atomics.store(signals, workerIndex, 1);
Atomics.notify(signals, workerIndex);