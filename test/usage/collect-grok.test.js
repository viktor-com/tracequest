import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkTmp } from "../helpers/fixtures.js";
import { collectGrokUsage } from "../../src/usage/collect-grok.js";
import { GROK_USER_BODY, startJsonFixture, writeGrokAuth } from "./helpers.js";

test("grok collector maps subscriptionTier with empty windows", async () => {
  const home = mkTmp("tq-ul-grok-ok-");
  const fx = await startJsonFixture({
    "/user": { body: GROK_USER_BODY },
  });
  const prev = process.env.TRACEQUEST_GROK_USAGE_URL;
  process.env.TRACEQUEST_GROK_USAGE_URL = `${fx.baseUrl}/user?include=subscription`;
  try {
    writeGrokAuth(home, "grok-fixture-session-token-xxxx", "secret.email@example.com");
    const row = await collectGrokUsage({ home });
    assert.equal(row.status, "ok");
    assert.equal(row.plan, "SuperGrokPro");
    assert.deepEqual(row.windows, []);
    assert.equal(JSON.stringify(row).includes("grok-fixture-session-token-xxxx"), false);
    assert.equal(JSON.stringify(row).includes("secret.email@example.com"), false);
  } finally {
    if (prev === undefined) delete process.env.TRACEQUEST_GROK_USAGE_URL;
    else process.env.TRACEQUEST_GROK_USAGE_URL = prev;
    await fx.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("grok collector 401 is unauthenticated", async () => {
  const home = mkTmp("tq-ul-grok-401-");
  const fx = await startJsonFixture({
    "/user": { status: 401, body: { error: "unauthenticated" } },
  });
  const prev = process.env.TRACEQUEST_GROK_USAGE_URL;
  process.env.TRACEQUEST_GROK_USAGE_URL = `${fx.baseUrl}/user?include=subscription`;
  try {
    writeGrokAuth(home, "grok-expired-token-valuexxxxxxxx");
    const row = await collectGrokUsage({ home });
    assert.equal(row.status, "unauthenticated");
    assert.match(row.message, /grok login/);
  } finally {
    if (prev === undefined) delete process.env.TRACEQUEST_GROK_USAGE_URL;
    else process.env.TRACEQUEST_GROK_USAGE_URL = prev;
    await fx.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("grok collector missing credential is missing", async () => {
  const home = mkTmp("tq-ul-grok-miss-");
  try {
    const row = await collectGrokUsage({ home });
    assert.equal(row.status, "missing");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
