import "../helpers/skip-lr-watch-env.js";
import { test, describe, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { handleApiSessions } from "../../src/routes/route-handlers-api.js";
import { clearRouteCache } from "../../src/routes/route-cache.js";
import { setInitialFilter } from "../../src/server/server-state.js";
import { clearLiveSessionsCache } from "../../src/sessions/live-sessions.js";
import { sessionHash } from "../../src/sessions/session-hash.js";
import { captureJsonHandler } from "../helpers/capture-json-handler.js";

/** Build sessions + index where each row supplies sort-relevant meta. */
function buildSortFixture(rows) {
  const sessions = rows.map((row, i) => ({
    path: `/fake/sort-${i}.jsonl`,
    mtime: row.mtime ?? new Date(1_700_000_000_000 - (row.mtimeRank ?? i) * 60_000),
    size: 1024,
    source: "claude",
    project: "sort-proj",
    file: `sort-${i}.jsonl`,
  }));
  const index = new Map();
  for (let i = 0; i < sessions.length; i++) {
    const row = rows[i];
    const s = sessions[i];
    index.set(s.path, {
      firstPrompt: `p${i}`,
      model: "claude-sonnet-4-6",
      totalTokens: row.totalTokens ?? 0,
      inputTokens: 1,
      outputTokens: 1,
      durationMs: row.durationMs ?? 0,
      errors: row.errors ?? 0,
      tools: [],
      toolCounts: {},
      chapters: 0,
    });
  }
  return {
    findSessions: () => sessions,
    buildIndex: () => index,
    sessions,
    index,
  };
}

async function fetchSorted(url, fixture) {
  const { res, parse } = captureJsonHandler();
  await handleApiSessions({}, res, url, fixture);
  return parse();
}

function expectedIds(fixture, indexes) {
  return indexes.map((i) => sessionHash(fixture.sessions[i].path));
}

afterEach(() => {
  clearRouteCache();
  clearLiveSessionsCache();
  setInitialFilter(null);
});

describe("route-handlers-api handleApiSessions — sort", () => {

  test("sort=tokens orders sessions by totalTokens descending", async () => {
    const deps = buildSortFixture([
      { totalTokens: 100 },
      { totalTokens: 900 },
      { totalTokens: 300 },
      { totalTokens: 50 },
    ]);
    const data = await fetchSorted(
      new URL("http://localhost:7777/api/sessions?sort=tokens&pageSize=10"),
      deps,
    );
    assert.deepEqual(
      data.sessions.map((s) => s.totalTokens),
      [900, 300, 100, 50],
    );
  });

  test("sort=tokens treats missing totalTokens as zero", async () => {
    const deps = buildSortFixture([
      { totalTokens: 500 },
      {},
      { totalTokens: 200 },
    ]);
    const data = await fetchSorted(
      new URL("http://localhost:7777/api/sessions?sort=tokens"),
      deps,
    );
    assert.deepEqual(
      data.sessions.map((s) => s.totalTokens),
      [500, 200, 0],
    );
  });

  test("sort=duration orders sessions by durationMs descending", async () => {
    const deps = buildSortFixture([
      { durationMs: 1_000 },
      { durationMs: 99_000 },
      { durationMs: 5_000 },
    ]);
    const data = await fetchSorted(
      new URL("http://localhost:7777/api/sessions?sort=duration"),
      deps,
    );
    assert.deepEqual(
      data.sessions.map((s) => s.durationMs),
      [99_000, 5_000, 1_000],
    );
  });

  test("sort=duration treats missing durationMs as zero", async () => {
    const deps = buildSortFixture([
      { durationMs: 42_000 },
      {},
      { durationMs: 7_000 },
    ]);
    const data = await fetchSorted(
      new URL("http://localhost:7777/api/sessions?sort=duration"),
      deps,
    );
    assert.deepEqual(
      data.sessions.map((s) => s.durationMs),
      [42_000, 7_000, 0],
    );
  });

  test("sort=errors orders sessions by errors descending", async () => {
    const deps = buildSortFixture([
      { errors: 1 },
      { errors: 12 },
      { errors: 3 },
      { errors: 0 },
    ]);
    const data = await fetchSorted(
      new URL("http://localhost:7777/api/sessions?sort=errors"),
      deps,
    );
    assert.deepEqual(
      data.sessions.map((s) => s.errors),
      [12, 3, 1, 0],
    );
  });

  test("sort=errors with all zero errors returns every session", async () => {
    const deps = buildSortFixture([{}, {}, {}]);
    const data = await fetchSorted(
      new URL("http://localhost:7777/api/sessions?sort=errors"),
      deps,
    );
    assert.equal(data.total, 3);
    assert.ok(data.sessions.every((s) => s.errors === 0));
  });

  test("sort=recent orders sessions by mtime descending", async () => {
    const deps = buildSortFixture([
      { mtime: new Date("2026-01-01T00:00:00Z"), totalTokens: 1 },
      { mtime: new Date("2026-06-01T00:00:00Z"), totalTokens: 2 },
      { mtime: new Date("2026-03-01T00:00:00Z"), totalTokens: 3 },
    ]);
    const data = await fetchSorted(
      new URL("http://localhost:7777/api/sessions?sort=recent"),
      deps,
    );
    assert.deepEqual(
      data.sessions.map((s) => s.mtime),
      [
        new Date("2026-06-01T00:00:00Z").getTime(),
        new Date("2026-03-01T00:00:00Z").getTime(),
        new Date("2026-01-01T00:00:00Z").getTime(),
      ],
    );
  });

  test("omitted sort param defaults to recent (mtime descending)", async () => {
    const deps = buildSortFixture([
      { mtimeRank: 2 },
      { mtimeRank: 0 },
      { mtimeRank: 1 },
    ]);
    const data = await fetchSorted(
      new URL("http://localhost:7777/api/sessions"),
      deps,
    );
    const ids = data.sessions.map((s) => s.id);
    assert.deepEqual(ids, expectedIds(deps, [1, 2, 0]));
  });

  test("sort=date alias matches recent (mtime descending)", async () => {
    const deps = buildSortFixture([
      { mtimeRank: 2, totalTokens: 10 },
      { mtimeRank: 0, totalTokens: 999 },
      { mtimeRank: 1, totalTokens: 50 },
    ]);
    const data = await fetchSorted(
      new URL("http://localhost:7777/api/sessions?sort=date"),
      deps,
    );
    assert.deepEqual(
      data.sessions.map((s) => s.id),
      expectedIds(deps, [1, 2, 0]),
    );
  });

  test("unknown sort value falls back to recent (mtime descending)", async () => {
    const deps = buildSortFixture([
      { mtimeRank: 1, totalTokens: 999 },
      { mtimeRank: 0, totalTokens: 1 },
    ]);
    const data = await fetchSorted(
      new URL("http://localhost:7777/api/sessions?sort=not-a-real-key"),
      deps,
    );
    assert.deepEqual(
      data.sessions.map((s) => s.id),
      expectedIds(deps, [1, 0]),
    );
  });

  test("sort applies before pagination (page 2 under sort=tokens)", async () => {
    const deps = buildSortFixture([
      { totalTokens: 10 },
      { totalTokens: 90 },
      { totalTokens: 50 },
      { totalTokens: 70 },
    ]);
    const data = await fetchSorted(
      new URL("http://localhost:7777/api/sessions?sort=tokens&page=2&pageSize=2"),
      deps,
    );
    assert.equal(data.page, 2);
    assert.deepEqual(
      data.sessions.map((s) => s.totalTokens),
      [50, 10],
    );
    assert.equal(data.total, 4);
  });

  test("sort changes session order but not stats aggregates", async () => {
    const deps = buildSortFixture([
      { totalTokens: 100, durationMs: 1_000, errors: 2 },
      { totalTokens: 200, durationMs: 2_000, errors: 1 },
      { totalTokens: 300, durationMs: 3_000, errors: 0 },
    ]);
    const recent = await fetchSorted(
      new URL("http://localhost:7777/api/sessions?sort=recent"),
      deps,
    );
    const tokens = await fetchSorted(
      new URL("http://localhost:7777/api/sessions?sort=tokens"),
      deps,
    );
    assert.notDeepEqual(
      recent.sessions.map((s) => s.id),
      tokens.sessions.map((s) => s.id),
    );
    assert.equal(recent.stats.totalTokens, 600);
    assert.equal(tokens.stats.totalTokens, 600);
    assert.equal(recent.stats.totalDurationMs, 6_000);
    assert.equal(tokens.stats.totalErrors, 3);
  });

  test("sort=recent uses session file mtime, not index-only fields", async () => {
    const deps = buildSortFixture([
      { mtime: new Date("2025-01-01T00:00:00Z"), totalTokens: 9_999 },
      { mtime: new Date("2026-12-31T00:00:00Z"), totalTokens: 1 },
    ]);
    const data = await fetchSorted(
      new URL("http://localhost:7777/api/sessions?sort=recent"),
      deps,
    );
    assert.equal(data.sessions[0].id, expectedIds(deps, [1])[0]);
    assert.equal(data.sessions[0].totalTokens, 1);
  });
});
