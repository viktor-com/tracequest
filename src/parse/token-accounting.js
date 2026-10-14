import { rollupClaudeUsage } from "./parse-utils.js";

/** Content fragments repeat a message's cumulative usage, not new requests. */
export function claudeUsageDelta(record, seen) {
  const tokens = rollupClaudeUsage(record.message?.usage || record.usage);
  const id = record.message?.id;
  if (!id) return tokens;
  const key = JSON.stringify([record.requestId || "", id]);
  const previous = seen.get(key) || {};
  const delta = {};
  const next = {};
  for (const field of ["input", "output", "cacheHit", "cacheWrite", "cacheWrite1h"]) {
    next[field] = Math.max(previous[field] || 0, tokens[field] || 0);
    delta[field] = next[field] - (previous[field] || 0);
  }
  seen.set(key, next);
  return delta;
}

/** Billing weights preserve per-request long-context pricing after aggregation.
 * Displayed token counts remain the actual usage. Cache writes stay split by TTL.
 */
export function billingTokenUsage(tokens, model) {
  const long = /^gpt-(6\.1|5\.6)-sol(?:$|-)/.test(model || "") && tokens.input > 272000;
  return {
    input: (tokens.input || 0) * (long ? 2 : 1),
    output: (tokens.output || 0) * (long ? 1.5 : 1),
    cacheHit: (tokens.cacheHit || 0) * (long ? 2 : 1),
    cacheWrite: (tokens.cacheWrite || 0) * (long ? 2 : 1),
    cacheWrite1h: tokens.cacheWrite1h || 0,
  };
}

export function addTokenUsage(target, tokens) {
  for (const field of ["input", "output", "cacheHit", "cacheWrite", "cacheWrite1h"]) {
    target[field] = (target[field] || 0) + (tokens[field] || 0);
  }
  return target;
}
