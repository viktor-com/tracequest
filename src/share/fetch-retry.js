/** HTTP fetch wrapper for share uploads: per-request timeout + retry on rate limits / transient errors. */

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 500;
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

function parsePositiveInt(raw, fallback) {
  const n = parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function shareFetchConfig() {
  return {
    timeoutMs: parsePositiveInt(process.env.TRACEQUEST_SHARE_FETCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxRetries: parsePositiveInt(process.env.TRACEQUEST_SHARE_FETCH_RETRIES, DEFAULT_MAX_RETRIES),
    retryDelayMs: parsePositiveInt(process.env.TRACEQUEST_SHARE_FETCH_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS),
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(err) {
  return err?.name === "AbortError" || err?.code === "ABORT_ERR";
}

/**
 * Fetch with AbortSignal timeout and limited retries for 429/502/503/504.
 * Connection failures are not retried (fail fast).
 */
export async function shareFetch(url, options = {}, fetchImpl = fetch) {
  const { timeoutMs, maxRetries, retryDelayMs } = shareFetchConfig();
  let lastResponse = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      lastResponse = res;
      if (RETRYABLE_STATUSES.has(res.status) && attempt < maxRetries) {
        await delay(retryDelayMs * (attempt + 1));
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      if (isAbortError(err)) {
        throw new Error(`Share request timed out after ${timeoutMs}ms`);
      }
      throw err;
    }
  }

  return lastResponse;
}