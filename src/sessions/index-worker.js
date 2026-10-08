import { workerData } from "node:worker_threads";

const { sessions, sab, workerIndex, port } = workerData;
const signals = new Int32Array(sab);

function sessionIndexCoreUrl() {
  const override = process.env.TRACEQUEST_TEST_SESSION_INDEX_CORE;
  if (override) return new URL(override, import.meta.url);
  return new URL("./session-index-core.js", import.meta.url);
}

const { indexSession } = await import(sessionIndexCoreUrl().href);
const { indexOpenCode } = await import(new URL("./session-index-opencode.js", import.meta.url).href);
const { openOpenCodeDbReadOnly } = await import(
  new URL("./session-discovery-paths.js", import.meta.url).href,
);

try {
  const results = {};
  let opencodeDb = null;
  for (const session of sessions) {
    if ((session.source || "claude") === "opencode") {
      if (!opencodeDb) opencodeDb = openOpenCodeDbReadOnly();
      results[session.path] = indexOpenCode(session, opencodeDb.db);
    } else {
      results[session.path] = indexSession(session);
    }
  }
  if (opencodeDb) opencodeDb.db.close();
  port.postMessage(results);
} catch (err) {
  port.postMessage({ _error: err.message });
} finally {
  Atomics.store(signals, workerIndex, 1);
  Atomics.notify(signals, workerIndex);
}
