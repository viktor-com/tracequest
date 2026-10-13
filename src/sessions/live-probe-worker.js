/**
 * Worker thread that runs one live-session detection pass (fact hlv1). The
 * pass runs its probes (pgrep, lsof) as concurrent child processes (fact
 * hlv3) and reads files synchronously; running it here keeps the server's
 * event loop free. Detection state that spans
 * passes — the last clean pass carried forward when a probe degrades —
 * lives in this thread's copy of live-sessions.js, exactly as it would in
 * the main thread.
 */
import { parentPort } from "node:worker_threads";
import { detectLiveSessionsAsync } from "./live-sessions.js";

function adoptEnv(env) {
  if (!env) return;
  for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
  Object.assign(process.env, env);
}

parentPort.on("message", async ({ id, sessions, env }) => {
  let live = null;
  try {
    adoptEnv(env);
    const rows = sessions.map((s) => ({ ...s, mtime: new Date(s.mtime) }));
    live = await detectLiveSessionsAsync(rows);
  } catch (err) {
    console.error("live-probe worker: detection failed:", err?.message || err);
  }
  parentPort.postMessage({ id, live });
});
