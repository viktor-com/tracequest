import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkTmp } from "../helpers/fixtures.js";
import { collectUsageLimits } from "../../src/usage/collect.js";
import { HARNESS_TIMEOUT_MS } from "../../src/usage/http.js";
import {
  CLAUDE_USAGE_BODY,
  CODEX_USAGE_BODY,
  GROK_USER_BODY,
  startJsonFixture,
  writeClaudeCreds,
  writeCodexAuth,
  writeGrokAuth,
} from "./helpers.js";

test("statuses and unavailable harnesses", async () => {
  const home = mkTmp("tq-ul-fan-unavail-");
  try {
    const snap = await collectUsageLimits({ home, fetchImpl: async () => { throw new Error("no net"); } });
    const byId = Object.fromEntries(snap.harnesses.map((h) => [h.id, h]));
    assert.equal(byId.factory.status, "unavailable");
    assert.equal(byId.opencode.status, "unavailable");
    assert.equal(byId.gemini.status, "unavailable");
    assert.equal(byId.claude.status, "missing");
    assert.ok(!snap.harnesses.some((h) => h.id === "cursor-cloud"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("unavailable harnesses are never fetched", async () => {
  const home = mkTmp("tq-ul-unavail-fetch-");
  const calls = [];
  try {
    await collectUsageLimits({
      home,
      fetchImpl: async (url) => {
        calls.push(url);
        throw new Error("no");
      },
    });
    assert.equal(calls.length, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("fan-in isolates harness failures", async () => {
  const home = mkTmp("tq-ul-fan-");
  const fx = await startJsonFixture({
    "/api/oauth/usage": { body: CLAUDE_USAGE_BODY },
    "/api/codex/usage": { status: 500, body: { error: "boom" } },
    "/user": { body: GROK_USER_BODY },
    "*": { status: 404, body: {} },
  });
  const env = {
    TRACEQUEST_CLAUDE_USAGE_URL: `${fx.baseUrl}/api/oauth/usage`,
    TRACEQUEST_CODEX_USAGE_URL: `${fx.baseUrl}/api/codex/usage`,
    TRACEQUEST_GROK_USAGE_URL: `${fx.baseUrl}/user?include=subscription`,
    TRACEQUEST_CURSOR_API2_URL: fx.baseUrl,
  };
  const prev = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    writeClaudeCreds(home, "sk-ant-fan-token-xxxxxxxx");
    writeCodexAuth(home, "codex-fan-token-xxxxxxxx", "acct");
    writeGrokAuth(home, "grok-fan-token-xxxxxxxx");
    const snap = await collectUsageLimits({ home });
    const byId = Object.fromEntries(snap.harnesses.map((h) => [h.id, h]));
    assert.equal(byId.claude.status, "ok");
    assert.equal(byId.codex.status, "error");
    assert.equal(byId.grok.status, "ok");
    assert.equal(byId.cursor.status, "missing");
    assert.equal(JSON.stringify(snap).includes("sk-ant-fan-token-xxxxxxxx"), false);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await fx.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("per-harness timeout does not stall the fan-in", async () => {
  const home = mkTmp("tq-ul-timeout-");
  writeClaudeCreds(home, "sk-ant-timeout-token-xxxx");
  const prev = process.env.TRACEQUEST_CLAUDE_USAGE_URL;
  process.env.TRACEQUEST_CLAUDE_USAGE_URL = "http://127.0.0.1:1/hang";
  try {
    const started = Date.now();
    const snap = await collectUsageLimits({
      home,
      timeoutMs: 50,
      fetchImpl: (_url, init) => new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      }),
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000, `fan-in stalled (${elapsed}ms)`);
    const claude = snap.harnesses.find((h) => h.id === "claude");
    assert.equal(claude.status, "error");
    assert.match(claude.message, /timed out|abort/i);
    assert.ok(HARNESS_TIMEOUT_MS >= 1000);
  } finally {
    if (prev === undefined) delete process.env.TRACEQUEST_CLAUDE_USAGE_URL;
    else process.env.TRACEQUEST_CLAUDE_USAGE_URL = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
