import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { shareFetch, shareFetchConfig } from "../../src/share/fetch-retry.js";

const ENV_KEYS = [
  "TRACEQUEST_SHARE_FETCH_TIMEOUT_MS",
  "TRACEQUEST_SHARE_FETCH_RETRIES",
  "TRACEQUEST_SHARE_FETCH_RETRY_DELAY_MS",
];

describe("share fetch-retry", () => {
  /** @type {Record<string, string | undefined>} */
  let savedEnv = {};

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  test("shareFetchConfig reads env overrides", () => {
    process.env.TRACEQUEST_SHARE_FETCH_TIMEOUT_MS = "1200";
    process.env.TRACEQUEST_SHARE_FETCH_RETRIES = "2";
    process.env.TRACEQUEST_SHARE_FETCH_RETRY_DELAY_MS = "25";
    assert.deepEqual(shareFetchConfig(), {
      timeoutMs: 1200,
      maxRetries: 2,
      retryDelayMs: 25,
    });
  });

  test("shareFetch times out on hanging fetch", async () => {
    process.env.TRACEQUEST_SHARE_FETCH_TIMEOUT_MS = "80";
    const fetchImpl = (_url, opts) =>
      new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    await assert.rejects(
      () => shareFetch("http://127.0.0.1:1/hang", {}, fetchImpl),
      /Share request timed out after 80ms/,
    );
  });

  test("shareFetch retries 429 then returns success", async () => {
    process.env.TRACEQUEST_SHARE_FETCH_RETRIES = "3";
    process.env.TRACEQUEST_SHARE_FETCH_RETRY_DELAY_MS = "1";
    process.env.TRACEQUEST_SHARE_FETCH_TIMEOUT_MS = "5000";
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls < 3) {
        return { ok: false, status: 429, statusText: "Too Many Requests" };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
    const res = await shareFetch("http://127.0.0.1:1/gists", { method: "POST" }, fetchImpl);
    assert.equal(res.status, 200);
    assert.equal(calls, 3);
  });

  test("shareFetch returns final 503 after retries exhausted", async () => {
    process.env.TRACEQUEST_SHARE_FETCH_RETRIES = "2";
    process.env.TRACEQUEST_SHARE_FETCH_RETRY_DELAY_MS = "1";
    process.env.TRACEQUEST_SHARE_FETCH_TIMEOUT_MS = "5000";
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return { ok: false, status: 503, statusText: "Service Unavailable" };
    };
    const res = await shareFetch("http://127.0.0.1:1/gists", { method: "POST" }, fetchImpl);
    assert.equal(res.status, 503);
    assert.equal(calls, 3);
  });
});