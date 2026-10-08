import "../helpers/skip-lr-watch-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateInsights } from "../../src/insights/aggregate.js";
import { analyzeSession, INSIGHTS_VERSION } from "../../src/insights/analyze.js";
import { insightsCachePath, loadInsights, refreshInsights } from "../../src/insights/store.js";
import { loadInsightsData, parseInsightsQuery } from "../../src/insights/load.js";
import { formatInsights } from "../../src/insights/format.js";

function analysis(over = {}) {
  return {
    ...analyzeSession({ events: [] }),
    calls: 10,
    activeMs: 600_000,
    ...over,
  };
}

function row(over = {}) {
  return {
    path: `/s/${Math.random()}.jsonl`,
    sessionHash: "abcd1234",
    source: "claude",
    project: "sample-app",
    prompt: "fix the thing with OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx1234",
    model: "claude-opus-5-5",
    mtime: Date.parse("2026-10-01T00:00:00Z"),
    totalTokens: 1_000_000,
    inputTokens: 900_000,
    outputTokens: 100_000,
    cacheReadTokens: 800_000,
    ...over,
  };
}

function corpus() {
  const traps = (patch) => ({ ...analysis().traps, ...patch });
  return [
    row({ path: "/s/a.jsonl", host: "mac", analysis: analysis({
      errors: 4, classes: { "missing-path": 3, timeout: 1 }, examples: { "missing-path": "No such file", timeout: "timed out" },
      retries: 2, loops: 1, loopCalls: 5, loopExample: "Bash: gh pr checks 7",
      stalls: 2, stallMs: 1_800_000, longestStall: { ms: 1_200_000, after: "Bash: uv run pytest" }, area: "backend/service",
      traps: traps({ "ci-wait": { count: 6, ms: 3_600_000, sleepSec: 300, example: "gh pr checks 7" } }),
    }) }),
    row({ path: "/s/b.jsonl", source: "codex", analysis: analysis({
      errors: 1, classes: { "missing-path": 1 }, examples: { "missing-path": "ENOENT" }, area: "frontend/apps",
      traps: traps({ "wrong-folder": { count: 1, example: "not a git repository" } }),
    }) }),
    row({ path: "/s/c.jsonl", source: "codex", totalTokens: 50_000_000, inputTokens: 49_000_000, outputTokens: 1_000_000, analysis: analysis({ area: "frontend/apps" }) }),
    row({ path: "/s/pending.jsonl" }),
  ];
}

test("aggregateInsights reports totals, error classes and breakdowns with example sessions", () => {
  const a = aggregateInsights(corpus());
  assert.deepEqual(
    { sessions: a.totals.sessions, analyzed: a.totals.analyzed, pending: a.totals.pending, hosts: a.totals.hosts },
    { sessions: 4, analyzed: 3, pending: 1, hosts: 2 },
  );
  assert.equal(a.totals.calls, 30);
  assert.equal(a.totals.errors, 5);
  assert.equal(a.totals.errorSessions, 2);
  assert.equal(a.totals.errorRate, 5 / 30);

  assert.deepEqual(a.classes.map((c) => [c.id, c.count, c.sessions]), [["missing-path", 4, 2], ["timeout", 1, 1]]);
  assert.equal(a.classes[0].share, 0.8);
  assert.equal(a.classes[0].examples[0].path, "/s/a.jsonl", "worst session first");
  assert.match(a.classes[0].examples[0].note, /3× — No such file/);

  const harness = Object.fromEntries(a.byHarness.map((g) => [g.key, g]));
  assert.equal(harness.claude.errorRate, 0.4);
  assert.equal(harness.codex.errorRate, 1 / 20);
  assert.equal(harness.claude.topClasses[0].id, "missing-path");
  assert.equal(harness.claude.examples[0].path, "/s/a.jsonl");
  assert.deepEqual(a.byArea.map((g) => g.key).sort(), ["backend/service", "frontend/apps"]);
  assert.deepEqual(a.byHost.map((g) => g.key).sort(), ["local", "mac"]);
});

test("aggregateInsights reports retries, time, stalls, spend and traps with example sessions", () => {
  const a = aggregateInsights(corpus());
  assert.deepEqual(
    { retries: a.retries.retries, sessions: a.retries.sessions, loops: a.retries.loops, loopCalls: a.retries.loopCalls },
    { retries: 2, sessions: 1, loops: 1, loopCalls: 5 },
  );
  assert.match(a.retries.examples[0].note, /2 retries, 1 loops — Bash: gh pr checks 7/);
  assert.equal(a.time.medianActiveMs, 600_000);
  assert.equal(a.time.histogram.reduce((n, b) => n + b.count, 0), 3);
  assert.deepEqual({ count: a.stalls.count, sessions: a.stalls.sessions, ms: a.stalls.ms }, { count: 2, sessions: 1, ms: 1_800_000 });
  assert.match(a.stalls.examples[0].note, /20 min waiting after Bash: uv run pytest/);
  assert.equal(a.expensive[0].path, "/s/c.jsonl", "most expensive first");
  assert.ok(a.expensive[0].cost > a.expensive[1].cost);
  const traps = Object.fromEntries(a.traps.map((t) => [t.id, t]));
  assert.deepEqual(Object.keys(traps), ["wrong-folder", "path-bleed", "test-hang", "ci-wait"]);
  assert.deepEqual({ s: traps["ci-wait"].sessions, e: traps["ci-wait"].events, ms: traps["ci-wait"].ms }, { s: 1, e: 6, ms: 3_600_000 });
  assert.equal(traps["wrong-folder"].examples[0].path, "/s/b.jsonl");
  assert.equal(traps["test-hang"].sessions, 0);
});

test("example session refs never carry a secret from the prompt", () => {
  const blob = JSON.stringify(aggregateInsights(corpus()));
  assert.doesNotMatch(blob, /sk-proj-abcdefghijklmnopqrstuvwx1234/);
  assert.match(blob, /OPENAI_API_KEY=\[REDACTED\]/);
});

test("refreshInsights analyses new and changed sessions and reuses the rest", async () => {
  const home = mkdtempSync(join(tmpdir(), "tq-insights-"));
  try {
    const sessions = [
      { path: "/s/a.jsonl", source: "claude", mtime: 1000 },
      { path: "/s/b.jsonl", source: "codex", mtime: 2000 },
      { path: "/s/broken.jsonl", source: "claude", mtime: 3000 },
    ];
    const parsed = [];
    const parseSession = async (path, source) => {
      parsed.push(`${source}:${path}`);
      if (path.includes("broken")) throw new Error("unreadable");
      return { cwd: "/r", events: [] };
    };
    const first = await refreshInsights({ sessions, parseSession, home });
    assert.deepEqual({ a: first.analyzed, r: first.reused, f: first.failed }, { a: 2, r: 0, f: 1 });
    assert.equal(loadInsights(home)["/s/a.jsonl"].v, INSIGHTS_VERSION);
    assert.equal(loadInsights(home)["/s/a.jsonl"].mtime, 1000);
    assert.ok(insightsCachePath(home).endsWith(join(".cache", "tracequest", "insights.json")));

    parsed.length = 0;
    sessions[1].mtime = 2500;
    const second = await refreshInsights({ sessions: sessions.slice(0, 2), parseSession, home });
    assert.deepEqual({ a: second.analyzed, r: second.reused }, { a: 1, r: 1 });
    assert.deepEqual(parsed, ["codex:/s/b.jsonl"], "only the changed session is parsed again");

    const third = await refreshInsights({ sessions: sessions.slice(0, 1), parseSession, home });
    assert.equal(third.removed, 1);
    assert.deepEqual(Object.keys(loadInsights(home)), ["/s/a.jsonl"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadInsightsData joins sessions with cached analysis and applies expr, host and days", (t) => {
  const archive = mkdtempSync(join(tmpdir(), "tq-insights-ambient-"));
  mkdirSync(join(archive, "unexpected-archive"));
  const previous = process.env.TRACEQUEST_HOSTS_DIR;
  process.env.TRACEQUEST_HOSTS_DIR = archive;
  t.after(() => {
    if (previous === undefined) delete process.env.TRACEQUEST_HOSTS_DIR; else process.env.TRACEQUEST_HOSTS_DIR = previous;
    rmSync(archive, { recursive: true, force: true });
  });
  const now = Date.parse("2026-10-06T00:00:00Z");
  const day = 86_400_000;
  const sessions = [
    { path: "/s/a.jsonl", source: "claude", project: "sample-app", host: "mac", size: 10, mtime: new Date(now - day) },
    { path: "/s/b.jsonl", source: "codex", project: "sample-app", size: 10, mtime: new Date(now - 40 * day) },
    { path: "/s/c.jsonl", source: "codex", project: "other", size: 10, mtime: new Date(now - day) },
  ];
  const index = new Map(sessions.map((s) => [s.path, { firstPrompt: "p", totalTokens: 5 }]));
  const records = Object.fromEntries(sessions.map((s) => [s.path, analysis({ errors: 1, classes: { other: 1 }, examples: { other: "x" } })]));
  const load = (qs) => loadInsightsData({
    sessions, index, records, pullState: {}, configured: [{ spec: "mac", hostId: "mac" }], importedHosts: [], now,
    query: parseInsightsQuery(new URLSearchParams(qs)),
  });
  assert.equal(load("").totals.analyzed, 3);
  assert.equal(load("expr=project:sample-app").totals.analyzed, 2);
  assert.equal(load("expr=project:sample-app&days=30").totals.analyzed, 1);
  assert.equal(load("host=mac").totals.analyzed, 1);
  assert.equal(load("host=local").totals.analyzed, 2);
  assert.equal(load("days=13").query.days, 0, "only the offered ranges are accepted");
  const data = load("");
  assert.deepEqual(data.hub.map((h) => [h.host, h.state, h.sessions]), [["local", "local", 2], ["mac", "never", 1]]);
  const text = formatInsights(data);
  assert.match(text, /insights: 3 sessions on 2 machines/);
  assert.match(text, /top error classes:\n\s+Other\s+3/);
});
