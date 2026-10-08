import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkTmp } from "../helpers/fixtures.js";
import { collectClaudeUsage } from "../../src/usage/collect-claude.js";
import { CLAUDE_USAGE_BODY, startJsonFixture, writeClaudeCreds } from "./helpers.js";

test("claude collector maps five_hour and seven_day from a fixture", async () => {
  const home = mkTmp("tq-ul-claude-ok-");
  const fx = await startJsonFixture({
    "/api/oauth/usage": { body: CLAUDE_USAGE_BODY },
  });
  const prev = process.env.TRACEQUEST_CLAUDE_USAGE_URL;
  process.env.TRACEQUEST_CLAUDE_USAGE_URL = `${fx.baseUrl}/api/oauth/usage`;
  try {
    writeClaudeCreds(home, "sk-ant-fixture-token-never-print");
    const row = await collectClaudeUsage({ home });
    assert.equal(row.status, "ok");
    assert.equal(row.plan, "default_claude_max_20x");
    assert.equal(row.windows[0].id, "five_hour");
    assert.equal(row.windows[0].utilization, 0.25);
    assert.equal(row.limitingWindow, "five_hour");
    assert.equal(JSON.stringify(row).includes("sk-ant-fixture-token-never-print"), false);
    assert.equal(fx.requests[0].auth, "Bearer sk-ant-fixture-token-never-print");
  } finally {
    if (prev === undefined) delete process.env.TRACEQUEST_CLAUDE_USAGE_URL;
    else process.env.TRACEQUEST_CLAUDE_USAGE_URL = prev;
    await fx.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("claude collector missing credential is missing", async () => {
  const home = mkTmp("tq-ul-claude-miss-");
  try {
    const row = await collectClaudeUsage({ home });
    assert.equal(row.status, "missing");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("claude collector 401 is unauthenticated", async () => {
  const home = mkTmp("tq-ul-claude-401-");
  const fx = await startJsonFixture({
    "/api/oauth/usage": { status: 401, body: { error: "unauthorized" } },
  });
  const prev = process.env.TRACEQUEST_CLAUDE_USAGE_URL;
  process.env.TRACEQUEST_CLAUDE_USAGE_URL = `${fx.baseUrl}/api/oauth/usage`;
  try {
    writeClaudeCreds(home, "sk-ant-expired-token-valuexx");
    const row = await collectClaudeUsage({ home });
    assert.equal(row.status, "unauthenticated");
    assert.match(row.message, /claude/);
    assert.equal(JSON.stringify(row).includes("sk-ant-expired-token-valuexx"), false);
  } finally {
    if (prev === undefined) delete process.env.TRACEQUEST_CLAUDE_USAGE_URL;
    else process.env.TRACEQUEST_CLAUDE_USAGE_URL = prev;
    await fx.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("claude collector malformed credentials.json is error", async () => {
  const home = mkTmp("tq-ul-claude-bad-");
  try {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", ".credentials.json"), "{not json");
    const row = await collectClaudeUsage({ home });
    assert.equal(row.status, "error");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
