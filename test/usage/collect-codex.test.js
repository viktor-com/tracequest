import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkTmp } from "../helpers/fixtures.js";
import { collectCodexUsage } from "../../src/usage/collect-codex.js";
import { CODEX_USAGE_BODY, startJsonFixture, writeCodexAuth } from "./helpers.js";

test("codex collector maps primary and secondary windows from a fixture", async () => {
  const home = mkTmp("tq-ul-codex-ok-");
  const fx = await startJsonFixture({
    "/api/codex/usage": { body: CODEX_USAGE_BODY },
  });
  const prev = process.env.TRACEQUEST_CODEX_USAGE_URL;
  process.env.TRACEQUEST_CODEX_USAGE_URL = `${fx.baseUrl}/api/codex/usage`;
  try {
    writeCodexAuth(home, "codex-fixture-access-token-xx", "acct-fixture-id");
    const row = await collectCodexUsage({ home });
    assert.equal(row.status, "ok");
    assert.equal(row.plan, "plus");
    assert.equal(row.windows[0].id, "primary");
    assert.equal(row.windows[0].utilization, 0.125);
    assert.equal(row.windows[1].utilization, 0.4);
    assert.equal(JSON.stringify(row).includes("codex-fixture-access-token-xx"), false);
    assert.equal(fx.requests[0].auth, "Bearer codex-fixture-access-token-xx");
  } finally {
    if (prev === undefined) delete process.env.TRACEQUEST_CODEX_USAGE_URL;
    else process.env.TRACEQUEST_CODEX_USAGE_URL = prev;
    await fx.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("codex collector 401 is unauthenticated", async () => {
  const home = mkTmp("tq-ul-codex-401-");
  const fx = await startJsonFixture({
    "/api/codex/usage": { status: 401, body: { error: { code: "token_expired" } } },
  });
  const prev = process.env.TRACEQUEST_CODEX_USAGE_URL;
  process.env.TRACEQUEST_CODEX_USAGE_URL = `${fx.baseUrl}/api/codex/usage`;
  try {
    writeCodexAuth(home, "codex-expired-token-valuexxxx", "acct-id");
    const row = await collectCodexUsage({ home });
    assert.equal(row.status, "unauthenticated");
    assert.match(row.message, /codex login/);
  } finally {
    if (prev === undefined) delete process.env.TRACEQUEST_CODEX_USAGE_URL;
    else process.env.TRACEQUEST_CODEX_USAGE_URL = prev;
    await fx.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("codex collector missing credential is missing", async () => {
  const home = mkTmp("tq-ul-codex-miss-");
  try {
    const row = await collectCodexUsage({ home });
    assert.equal(row.status, "missing");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
