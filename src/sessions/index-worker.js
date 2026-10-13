import { workerData } from "node:worker_threads";

const { sessions, sab, workerIndex, port } = workerData;
const signals = new Int32Array(sab);

function sessionIndexCoreUrl() {
  const override = process.env.TRACEQUEST_TEST_SESSION_INDEX_CORE;
  if (override) return new URL(override, import.meta.url);
  return new URL("./session-index-core.js", import.meta.url);
}

const { indexSession } = await import(sessionIndexCoreUrl().href);
const { openCodeIndexer } = await import(new URL("./session-index-opencode.js", import.meta.url).href);

try {
  const results = {};
  let opencode = null;
  try {
    for (const session of sessions) {
      if ((session.source || "claude") === "opencode") {
        if (!opencode) opencode = openCodeIndexer();
        results[session.path] = opencode.index(session);
      } else {
        results[session.path] = indexSession(session);
      }
    }
  } finally {
    opencode?.close();
  }
  port.postMessage(results);
} catch (err) {
  port.postMessage({ _error: err.message });
} finally {
  Atomics.store(signals, workerIndex, 1);
  Atomics.notify(signals, workerIndex);
}
