import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { mkTmp } from "../helpers/fixtures.js";
import { collectCursorUsage } from "../../src/usage/collect-cursor.js";
import {
  CURSOR_PLAN_BODY,
  CURSOR_USAGE_BODY,
  startJsonFixture,
  writeCursorTokenDb,
} from "./helpers.js";

test("cursor collector maps planUsage from DashboardService fixture", async () => {
  const home = mkTmp("tq-ul-cursor-ok-");
  const fx = await startJsonFixture({
    "/aiserver.v1.DashboardService/GetCurrentPeriodUsage": { body: CURSOR_USAGE_BODY },
    "/aiserver.v1.DashboardService/GetPlanInfo": { body: CURSOR_PLAN_BODY },
  });
  const prevUrl = process.env.TRACEQUEST_CURSOR_API2_URL;
  const prevDb = process.env.TRACEQUEST_CURSOR_STATE_DB;
  const dbPath = join(home, "state.vscdb");
  process.env.TRACEQUEST_CURSOR_API2_URL = fx.baseUrl;
  process.env.TRACEQUEST_CURSOR_STATE_DB = dbPath;
  try {
    writeCursorTokenDb(dbPath, "cursor-fixture-session-token-xx");
    const row = await collectCursorUsage({ home });
    assert.equal(row.status, "ok");
    assert.equal(row.plan, "Pro");
    assert.equal(row.windows[0].id, "period");
    assert.equal(row.windows[0].utilization, 0.4);
    assert.equal(JSON.stringify(row).includes("cursor-fixture-session-token-xx"), false);
    assert.equal(fx.requests[0].auth, "Bearer cursor-fixture-session-token-xx");
  } finally {
    if (prevUrl === undefined) delete process.env.TRACEQUEST_CURSOR_API2_URL;
    else process.env.TRACEQUEST_CURSOR_API2_URL = prevUrl;
    if (prevDb === undefined) delete process.env.TRACEQUEST_CURSOR_STATE_DB;
    else process.env.TRACEQUEST_CURSOR_STATE_DB = prevDb;
    await fx.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("cursor collector 401 is unauthenticated", async () => {
  const home = mkTmp("tq-ul-cursor-401-");
  const fx = await startJsonFixture({
    "*": { status: 401, body: { code: "unauthenticated" } },
  });
  const prevUrl = process.env.TRACEQUEST_CURSOR_API2_URL;
  process.env.TRACEQUEST_CURSOR_API2_URL = fx.baseUrl;
  try {
    const row = await collectCursorUsage({ home, cursorToken: "cursor-expired-token-valuexx" });
    assert.equal(row.status, "unauthenticated");
    assert.match(row.message, /Cursor/);
  } finally {
    if (prevUrl === undefined) delete process.env.TRACEQUEST_CURSOR_API2_URL;
    else process.env.TRACEQUEST_CURSOR_API2_URL = prevUrl;
    await fx.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("cursor collector missing credential is missing", async () => {
  const home = mkTmp("tq-ul-cursor-miss-");
  const prevDb = process.env.TRACEQUEST_CURSOR_STATE_DB;
  process.env.TRACEQUEST_CURSOR_STATE_DB = join(home, "missing.vscdb");
  try {
    const row = await collectCursorUsage({ home });
    assert.equal(row.status, "missing");
  } finally {
    if (prevDb === undefined) delete process.env.TRACEQUEST_CURSOR_STATE_DB;
    else process.env.TRACEQUEST_CURSOR_STATE_DB = prevDb;
    rmSync(home, { recursive: true, force: true });
  }
});
