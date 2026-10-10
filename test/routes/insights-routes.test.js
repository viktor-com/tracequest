import "../helpers/skip-lr-watch-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { captureJsonHandler, mockHttpResponse } from "../helpers/capture-json-handler.js";
import { handleApiInsights, handleInsights } from "../../src/routes/route-handlers-insights.js";
import { ROUTE_MAP } from "../../src/routes.js";
import { createHandle, isHubMode, send, setHubMode } from "../../src/server/server-http.js";
import { aggregateInsights } from "../../src/insights/aggregate.js";
import { analyzeSession } from "../../src/insights/analyze.js";
import { insightsPage } from "../../src/browser/insights-page.js";

const NOW = Date.parse("2026-10-06T12:00:00Z");

function data(query = { expr: "", days: 0, host: "" }) {
  const base = analyzeSession({ events: [] });
  const rows = [{
    path: "/home/u/.claude/projects/-work-sample-app/a b.jsonl",
    sessionHash: "abcd1234",
    source: "claude",
    host: "mac",
    project: "sample-app",
    prompt: "deploy with <script>alert(1)</script> and DB_PASSWORD=supersecretvalue",
    model: "claude-opus-5-5",
    mtime: NOW - 3_600_000,
    totalTokens: 2_000_000,
    inputTokens: 1_900_000,
    outputTokens: 100_000,
    cacheReadTokens: 1_000_000,
    analysis: {
      ...base,
      calls: 20, errors: 3, activeMs: 900_000,
      classes: { "missing-path": 3 }, examples: { "missing-path": "cat: /nope: No such file or directory" },
      retries: 1, loops: 1, loopCalls: 4, loopExample: "Bash: gh pr checks 7",
      stalls: 1, stallMs: 600_000, longestStall: { ms: 600_000, after: "Bash: uv run pytest" },
      area: "backend/service",
      traps: { ...base.traps, "ci-wait": { count: 4, ms: 1_200_000, sleepSec: 60, example: "gh pr checks 7" } },
    },
  }];
  return {
    generatedAt: new Date(NOW).toISOString(),
    query,
    exprError: null,
    hub: [
      { host: "local", spec: null, state: "local", sessions: 0, newestSessionAt: null, lastAttemptAt: null, lastSuccessAt: null, consecutiveFailures: 0, error: null },
      { host: "mac", spec: "u@mac", state: "fresh", sessions: 1, newestSessionAt: NOW - 3_600_000, lastAttemptAt: new Date(NOW - 600_000).toISOString(), lastSuccessAt: new Date(NOW - 600_000).toISOString(), consecutiveFailures: 0, error: null },
      { host: "gpu", spec: "gpu", state: "failing", sessions: 0, newestSessionAt: null, lastAttemptAt: new Date(NOW).toISOString(), lastSuccessAt: null, consecutiveFailures: 2, error: "Permission denied (publickey)." },
    ],
    ...aggregateInsights(rows),
  };
}

test("GET /insights and /api/insights are registered and served from loaded data", async () => {
  assert.equal(ROUTE_MAP["/insights"], handleInsights);
  assert.equal(ROUTE_MAP["/api/insights"], handleApiInsights);

  let seen = null;
  const deps = { loadInsightsData: (query) => { seen = query; return data(query); } };
  const api = captureJsonHandler();
  await handleApiInsights(null, api.res, new URL("http://localhost/api/insights?expr=project:sample-app&days=30&host=mac"), deps);
  assert.equal(api.headers["Content-Type"], "application/json; charset=utf-8");
  assert.deepEqual(seen, { expr: "project:sample-app", days: 30, host: "mac" });
  const json = api.parse();
  assert.equal(json.totals.errors, 3);
  assert.equal(json.classes[0].examples[0].path, "/home/u/.claude/projects/-work-sample-app/a b.jsonl");

  const page = mockHttpResponse();
  await handleInsights(null, page.res ?? page, new URL("http://localhost/insights"), deps);
  assert.equal(page.status, 200);
  assert.equal(page.headers["Content-Type"], "text/html; charset=utf-8");
  assert.match(page.body, /<title>tracequest — insights<\/title>/);
});

test("the insights page shows every insight with drill-down links to example sessions", () => {
  const html = insightsPage(data({ expr: "project:sample-app", days: 30, host: "mac" }));
  for (const id of ["headline", "machines", "error-classes", "by-harness", "by-area", "retries", "active-time", "stalls", "expensive", "traps"]) {
    assert.ok(html.includes(`data-insight="${id}"`), `missing ${id}`);
  }
  const link = "/view?path=%2Fhome%2Fu%2F.claude%2Fprojects%2F-work-sample-app%2Fa%20b.jsonl&amp;source=claude";
  assert.ok(html.split(link).length - 1 >= 6, "each insight links to its example session");
  assert.match(html, /<details class="ins-bar-row">/);
  assert.match(html, /Missing file or directory/);
  assert.match(html, /data-trap="ci-wait"/);
  assert.match(html, /claude@mac/);
  // Scope controls keep the current filter, range and machine.
  assert.match(html, /name="expr" value="project:sample-app"/);
  assert.match(html, /href="\/insights\?expr=project%3Asample-app&amp;days=7&amp;host=mac" aria-current="false"/);
  assert.match(html, /aria-current="true">last 30 days</);
  assert.match(html, /machine: mac ×/);
});

test("the insights page shows per-machine pull health and escapes and redacts session text", () => {
  const html = insightsPage(data());
  assert.match(html, /<tr data-host="gpu" data-state="failing">/);
  assert.match(html, /Permission denied \(publickey\)\. \(2 failed pulls in a row\)/);
  assert.match(html, /data-state="fresh"><span class="ins-state-dot"><\/span>up to date/);
  assert.match(html, /data-state="local"><span class="ins-state-dot"><\/span>this machine/);
  assert.ok(!html.includes("<script"), "the page ships no script and never injects one");
  assert.ok(!html.includes("supersecretvalue"));
  assert.match(html, /DB_PASSWORD=\[REDACTED\]/);

  const empty = insightsPage({ ...data(), ...aggregateInsights([{ path: "/x", source: "claude" }]) });
  assert.match(empty, /data-insights-state="empty"/);
  assert.match(empty, /1 of 1 sessions are not analysed yet/);
});

test("hub mode redacts every text response and refuses requests that change state", async () => {
  assert.equal(isHubMode(), false);
  const plain = mockHttpResponse();
  send(plain, 200, "AWS_SECRET_ACCESS_KEY=abcdefghijklmnop1234", "text/plain");
  assert.equal(plain.body, "AWS_SECRET_ACCESS_KEY=abcdefghijklmnop1234", "default mode is untouched");

  setHubMode(true);
  try {
    const text = mockHttpResponse();
    send(text, 200, '{"prompt":"use AWS_SECRET_ACCESS_KEY=abcdefghijklmnop1234 now"}', "application/json");
    assert.equal(JSON.parse(text.body).prompt, "use AWS_SECRET_ACCESS_KEY=[REDACTED] now");
    const raw = mockHttpResponse();
    send(raw, 200, Buffer.from("Authorization: Bearer abcdefghijklmnop1234567890\n"), "application/jsonl");
    assert.equal(raw.body, "Authorization: Bearer [REDACTED]\n");

    let ran = 0;
    const handle = createHandle({ "/api/runs": async (_req, res) => { ran += 1; send(res, 200, "ok"); } });
    const post = mockHttpResponse();
    await handle({ url: "/api/runs", method: "POST" }, post);
    assert.equal(post.status, 403);
    assert.equal(ran, 0);
    const get = mockHttpResponse();
    await handle({ url: "/api/runs", method: "GET" }, get);
    assert.equal(get.status, 200);
    assert.equal(ran, 1);
  } finally {
    setHubMode(false);
  }
});
