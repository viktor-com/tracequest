import "../helpers/skip-lr-watch-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { captureJsonHandler } from "../helpers/capture-json-handler.js";
import { handleApiUsageLimits, resetUsageLimitsCache, USAGE_LIMITS_TTL_MS, usageLimitsEnabled } from "../../src/routes/route-handlers-usage.js";
import { ROUTE_MAP } from "../../src/routes.js";

const LOCAL = {
  collectedAt: "2026-09-20T17:00:00.000Z",
  host: null,
  harnesses: [{ id: "claude", status: "ok", plan: "max", windows: [{ id: "five_hour", utilization: 0.2, resetsAt: "2026-09-20T21:00:00.000Z" }] }],
};

test("GET /api/usage-limits is registered and returns local plus hosts", async () => {
  resetUsageLimitsCache();
  assert.equal(ROUTE_MAP["/api/usage-limits"], handleApiUsageLimits);
  const { res, parse, headers } = captureJsonHandler();
  let collects = 0;
  await handleApiUsageLimits(null, res, new URL("http://localhost/api/usage-limits"), {
    collect: async () => {
      collects += 1;
      return LOCAL;
    },
    listSnapshots: async () => [{ ...LOCAL, host: "gpu" }],
    now: () => 1000,
    ttlMs: 60_000,
    enabled: true,
  });
  assert.equal(headers["Content-Type"], "application/json; charset=utf-8");
  const data = parse();
  assert.equal(data.local.host, null);
  assert.equal(data.hosts[0].host, "gpu");
  assert.equal(collects, 1);
  assert.ok(USAGE_LIMITS_TTL_MS >= 30_000);
});

test("GET /api/usage-limits TTL cache reuses the local snapshot", async () => {
  resetUsageLimitsCache();
  let collects = 0;
  const collect = async () => {
    collects += 1;
    return LOCAL;
  };
  const listSnapshots = async () => [];
  const first = captureJsonHandler();
  await handleApiUsageLimits(null, first.res, new URL("http://localhost/api/usage-limits"), {
    collect, listSnapshots, now: () => 1000, ttlMs: 60_000, enabled: true,
  });
  const second = captureJsonHandler();
  await handleApiUsageLimits(null, second.res, new URL("http://localhost/api/usage-limits"), {
    collect, listSnapshots, now: () => 2000, ttlMs: 60_000, enabled: true,
  });
  assert.equal(collects, 1);
  const third = captureJsonHandler();
  await handleApiUsageLimits(null, third.res, new URL("http://localhost/api/usage-limits"), {
    collect, listSnapshots, now: () => 70_000, ttlMs: 60_000, enabled: true,
  });
  assert.equal(collects, 2);
});

test("GET /api/usage-limits makes no live collect unless opted in", async () => {
  resetUsageLimitsCache();
  let collects = 0;
  const { res, parse } = captureJsonHandler();
  await handleApiUsageLimits(null, res, new URL("http://localhost/api/usage-limits"), {
    collect: async () => {
      collects += 1;
      return LOCAL;
    },
    listSnapshots: async () => [{ ...LOCAL, host: "gpu" }],
    enabled: false,
  });
  const data = parse();
  assert.equal(collects, 0);
  assert.equal(data.local, null);
  assert.equal(data.hosts[0].host, "gpu");
});

test("usage limits are opt-in via TRACEQUEST_USAGE_LIMITS=1", () => {
  assert.equal(usageLimitsEnabled({}), false);
  assert.equal(usageLimitsEnabled({ TRACEQUEST_USAGE_LIMITS: "1" }), true);
});
