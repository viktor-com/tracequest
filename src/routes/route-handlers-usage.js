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

export function resetUsageLimitsCache() {
  cachedLocal = null;
  cachedAt = 0;
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
    local = await collect();
    cachedLocal = local;
    cachedAt = now;
  }

  const hosts = await listSnapshots();
  send(res, 200, JSON.stringify({ local, hosts }), "application/json; charset=utf-8");
}
