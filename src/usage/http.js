/**
 * Shared fetch for harness usage endpoints: per-call timeout, 401
 * detection, and error strings that never include Authorization values.
 */
import { readFileSync } from "node:fs";
import { isIndexDiskExpectedErr } from "../utils/fs-expected-err.js";

export const HARNESS_TIMEOUT_MS = 5000;

export function defaultReadFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if (isIndexDiskExpectedErr(err)) return null;
    throw err;
  }
}

const BEARER_RE = /Bearer\s+\S+/gi;

export function sanitizeFetchError(err, url = "") {
  let msg = err?.message || String(err || "fetch failed");
  msg = msg.replace(BEARER_RE, "Bearer [redacted]");
  msg = msg.replace(/authorization["']?\s*[:=]\s*["']?Bearer\s+\S+/gi, "authorization: Bearer [redacted]");
  if (err?.name === "AbortError" || /aborted|abort/i.test(msg)) {
    return url ? `timed out fetching ${url}` : "timed out fetching usage";
  }
  return msg;
}

export function unauthenticatedMessage(loginHint) {
  return `unauthenticated — ${loginHint}`;
}

/**
 * GET/POST JSON. Never throws on HTTP status; returns { status, ok, json }.
 * Transport/timeout/parse failures throw a sanitized Error.
 */
export async function fetchUsageJson({
  url,
  headers = {},
  fetchImpl = fetch,
  timeoutMs = HARNESS_TIMEOUT_MS,
  method = "GET",
  body = null,
} = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const init = { method, headers, signal: ctrl.signal };
    if (body != null) init.body = typeof body === "string" ? body : JSON.stringify(body);
    const res = await fetchImpl(url, init);
    let json = null;
    const ctype = res.headers?.get?.("content-type") || "";
    try {
      if (typeof res.json === "function") json = await res.json();
      else if (typeof res.text === "function") {
        const text = await res.text();
        json = text ? JSON.parse(text) : null;
      }
    } catch {
      json = null;
    }
    void ctype;
    return { status: res.status, ok: Boolean(res.ok), json };
  } catch (err) {
    throw new Error(sanitizeFetchError(err, url));
  } finally {
    clearTimeout(timer);
  }
}

export function percentToFraction(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value / 100;
}

/** ISO-8601, unix seconds, or epoch millis (number / bigint / numeric string). */
export function toIso(value) {
  if (value == null || value === "") return null;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === "string" && !/^\d+(\.\d+)?$/.test(value.trim())) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const n = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n < 1e12 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function pick(obj, ...keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    if (obj[key] != null) return obj[key];
  }
  return undefined;
}

export function harnessRow({ id, status, plan = null, windows = [], message = null, limitingWindow = null }) {
  const row = { id, status, plan, windows };
  if (message) row.message = message;
  if (limitingWindow) row.limitingWindow = limitingWindow;
  return row;
}
