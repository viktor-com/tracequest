import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCodex } from "../../src/parse/parse-codex.js";
import { analyzeSession, INSIGHTS_VERSION } from "../../src/insights/analyze.js";
import { insightsCachePath, loadInsights, refreshInsights } from "../../src/insights/store.js";
import { INDEX_VERSION } from "../../src/sessions/index-writers.js";

const fixture = fileURLToPath(new URL("../fixtures/codex-tool-outcomes/structured-exit.jsonl", import.meta.url));

test("structured Codex failure survives the parser-to-insights boundary", () => {
  const parsed = parseCodex(fixture);
  assert.equal(parsed.stats.errors, 1);
  assert.match(parsed.events.find((e) => e.type === "tool_result").text, /^Script completed/);
  const analysis = analyzeSession(parsed);
  assert.equal(analysis.errors, 1);
  assert.equal(analysis.suspect, 0);
});

test("confirmed Codex failure survives display truncation", () => {
  const home = mkdtempSync(join(tmpdir(), "tq-codex-truncated-"));
  try {
    const rows = readFileSync(fixture, "utf8").trim().split("\n").map(JSON.parse);
    rows[1].payload.output = [{ type: "input_text", text: "Script completed\nOutput:\n" + "x".repeat(1500) + "\n" + JSON.stringify({ chunk_id: "fixture", wall_time_seconds: 0, exit_code: 1, output: "" }) }];
    const file = join(home, "rollout.jsonl");
    writeFileSync(file, rows.map(JSON.stringify).join("\n") + "\n");
    const parsed = parseCodex(file);
    assert.equal(parsed.stats.errors, 1);
    assert.doesNotMatch(parsed.events.find((e) => e.type === "tool_result").text, /exit_code/);
    assert.equal(analyzeSession(parsed).errors, 1);
    assert.equal(analyzeSession(parsed).suspect, 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

for (const cache of ["insights-v1", "older-parser-index"]) {
  test(`refresh reanalyses unchanged recordings after ${cache} upgrade`, async () => {
    const home = mkdtempSync(join(tmpdir(), "tq-insights-upgrade-"));
    const previous = process.env.TRACEQUEST_CACHE_DIR;
    delete process.env.TRACEQUEST_CACHE_DIR;
    try {
      const mtime = 1000;
      const record = { ...analyzeSession({ events: [] }), mtime, v: cache === "insights-v1" ? 1 : INSIGHTS_VERSION };
      const path = insightsCachePath(home);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ _v: cache === "insights-v1" ? 1 : INSIGHTS_VERSION, _indexVersion: 10, sessions: { [fixture]: record } }));
      const result = await refreshInsights({ home, sessions: [{ path: fixture, source: "codex", mtime }], parseSession: parseCodex });
      assert.equal(result.analyzed, 1);
      assert.equal(result.reused, 0);
      assert.equal(result.records[fixture].errors, 1);
      assert.equal(loadInsights(home)[fixture].errors, 1);
      const saved = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(saved._v, 2);
      assert.equal(saved._indexVersion, INDEX_VERSION);
      const reused = await refreshInsights({ home, sessions: [{ path: fixture, source: "codex", mtime }], parseSession: () => { throw new Error("unchanged upgraded record should be reused"); } });
      assert.equal(reused.reused, 1);
      assert.equal(reused.failed, 0);
    } finally {
      if (previous === undefined) delete process.env.TRACEQUEST_CACHE_DIR; else process.env.TRACEQUEST_CACHE_DIR = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });
}
