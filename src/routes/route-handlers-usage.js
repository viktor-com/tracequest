/**
 * GET /api/usage-limits — local live collect + imported disk snapshots.
 * Never route-cached. Never SSHes. Local answers use an in-memory TTL so
 * dashboard polls do not hammer harness APIs.
 *
 * The local collect calls Anthropic, OpenAI and xAI with the user's stored
 * agent credentials, so it is opt-in: `serve --usage-limits` (or
 * TRACEQUEST_USAGE_LIMITS=1). Without it only imported snapshots, which are
 * local files, are returned.
 */
import { send } from "../server/server-http.js";
import { collectUsageLimits } from "../usage/collect.js";
import { listImportedUsageSnapshots } from "../usage/snapshot.js";

export const USAGE_LIMITS_TTL_MS = 60_000;

let cachedLocal = null;
let cachedAt = 0;
// One local collect at a time: a page and the poll it starts share it.
let inflight = null;

export function resetUsageLimitsCache() {
  cachedLocal = null;
  cachedAt = 0;
  inflight = null;
}

function collectLocal(collect, now) {
  if (!inflight) {
    const job = Promise.resolve().then(() => collect()).then((local) => {
      cachedLocal = local;
      cachedAt = now;
      return local;
    }).finally(() => {
      if (inflight === job) inflight = null;
    });
    inflight = job;
  }
  return inflight;
}

export function usageLimitsEnabled(env = process.env) {
  return env.TRACEQUEST_USAGE_LIMITS === "1";
}

export async function handleApiUsageLimits(_req, res, _url, _deps = null) {
  const deps = _deps || {};
  const enabled = deps.enabled ?? usageLimitsEnabled();
  const collect = deps.collect || collectUsageLimits;
  const listSnapshots = deps.listSnapshots || listImportedUsageSnapshots;
  const now = deps.now ? deps.now() : Date.now();
  const ttl = deps.ttlMs ?? USAGE_LIMITS_TTL_MS;

  let local = enabled ? cachedLocal : null;
  if (enabled && (!local || now - cachedAt >= ttl)) {
    local = await collectLocal(collect, now);
  }

  const hosts = await listSnapshots();
  send(res, 200, JSON.stringify({ local, hosts }), "application/json; charset=utf-8");
}

/**
 * The usage snapshot an app-chrome page is served with (fact hlstrip): the
 * same { local, hosts } GET /api/usage-limits answers, read when the page is
 * built. Imported snapshots are read from disk; the local one comes from
 * the TTL cache, and a page waits for a harness collect only when there is
 * no cached local snapshot at all (otherwise the page's own first poll
 * refreshes a stale one). Never throws: a page without it is served with
 * the strip empty, as before.
 */
export async function usageLimitsForPage(_deps = null) {
  const deps = _deps || {};
  try {
    const enabled = deps.enabled ?? usageLimitsEnabled();
    const collect = deps.collect || collectUsageLimits;
    const listSnapshots = deps.listSnapshots || listImportedUsageSnapshots;
    const now = deps.now ? deps.now() : Date.now();
    let local = enabled ? cachedLocal : null;
    if (enabled && !local) local = await collectLocal(collect, now);
    const hosts = await listSnapshots();
    return { local, hosts };
  } catch (err) {
    console.error("usage limits for page failed:", err?.message || err);
    return null;
  }
}
