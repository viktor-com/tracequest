import "../helpers/skip-lr-watch-env.js";
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cmdFind,
  cmdLatest,
  cmdList,
  setCliLiveSessionDetectorForTests,
} from "../../src/cli/cli-commands.js";
import { indexPath } from "../../src/sessions/index-writers.js";
import { searchIdxPath } from "../../src/sessions/search-index.js";

function captureExit(fn) {
  const origExit = process.exit;
  const origError = console.error;
  const origLog = console.log;
  let code;
  const errors = [];
  const logs = [];
  process.exit = (c) => {
    code = c;
    throw new Error("process.exit");
  };
  console.error = (...a) => errors.push(a.join(" "));
  console.log = (...a) => logs.push(a.join(" "));
  try {
    fn();
    return { threw: false, code, errors, logs };
  } catch (err) {
    if (err.message !== "process.exit") throw err;
    return { threw: true, code, errors, logs };
  } finally {
    process.exit = origExit;
    console.error = origError;
    console.log = origLog;
  }
}

function writeClaudeSession(home, project, filename, prompt, mtime) {
  const dir = join(home, ".claude", "projects", project);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, filename);
  const ts = "2026-06-03T12:00:00.000Z";
  writeFileSync(
    p,
    [
      JSON.stringify({
        type: "user",
        sessionId: filename.replace(/\.jsonl$/, ""),
        cwd: "/tmp/tracequest-live-filter",
        timestamp: ts,
        uuid: `${filename}-u`,
        isMeta: false,
        message: { content: [{ type: "text", text: prompt }] },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: ts,
        uuid: `${filename}-a`,
        message: {
          model: "claude-sonnet-4-20250514",
          content: [{ type: "text", text: "ok" }],
        },
      }),
    ].join("\n") + "\n",
  );
  utimesSync(p, mtime, mtime);
  return p;
}

function withCliHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "tq-cli-live-filter-"));
  const oldHome = process.env.HOME;
  const oldNoSidecar = process.env.TRACEQUEST_NO_SIDECAR;
  process.env.HOME = home;
  process.env.TRACEQUEST_NO_SIDECAR = "1";
  try {
    return fn(home);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldNoSidecar === undefined) delete process.env.TRACEQUEST_NO_SIDECAR;
    else process.env.TRACEQUEST_NO_SIDECAR = oldNoSidecar;
    rmSync(home, { recursive: true, force: true });
  }
}

function assertOnlyLiveSessionShown(result, liveName, nonLiveName) {
  assert.equal(result.threw, true);
  assert.equal(result.code, 0);
  assert.ok(result.logs.some((l) => l.includes(liveName)), JSON.stringify(result.logs));
  assert.ok(!result.logs.some((l) => l.includes(nonLiveName)), JSON.stringify(result.logs));
}

afterEach(() => {
  setCliLiveSessionDetectorForTests(null);
});

describe("CLI live:true filters", () => {
  test("cmdList --filter live:true uses detected live paths without building indexes", () => {
    withCliHome((home) => {
      const live = writeClaudeSession(home, "live-filter", "live.jsonl", "live prompt", new Date("2026-06-03T12:00:10Z"));
      const nonLive = writeClaudeSession(home, "live-filter", "done.jsonl", "done prompt", new Date("2026-06-03T12:00:00Z"));
      const detectorCalls = [];
      setCliLiveSessionDetectorForTests((sessions) => {
        detectorCalls.push(sessions.map((s) => s.path).sort());
        return [live];
      });

      const result = captureExit(() => cmdList([], { filter: "live:true", sort: "recent" }));

      assertOnlyLiveSessionShown(result, "live.jsonl", "done.jsonl");
      assert.ok(result.logs.some((l) => l.includes("Found 1 sessions")), JSON.stringify(result.logs));
      assert.deepEqual(detectorCalls, [[live, nonLive].sort()]);
      assert.equal(existsSync(indexPath()), false, "discovery-only live filter should not create index.json");
      assert.equal(existsSync(searchIdxPath()), false, "discovery-only live filter should not create search.idx");
    });
  });

  test("cmdFind and cmdLatest apply live:true before displaying results", () => {
    withCliHome((home) => {
      const live = writeClaudeSession(home, "live-filter", "current.jsonl", "current prompt", new Date("2026-06-03T12:00:10Z"));
      writeClaudeSession(home, "live-filter", "finished.jsonl", "finished prompt", new Date("2026-06-03T12:00:00Z"));
      setCliLiveSessionDetectorForTests(() => [live]);

      const findResult = captureExit(() => cmdFind([], { filter: "live:true" }));
      assertOnlyLiveSessionShown(findResult, "current.jsonl", "finished.jsonl");
      assert.ok(findResult.logs.some((l) => l.includes("Found 1 sessions")), JSON.stringify(findResult.logs));

      const latestResult = captureExit(() => cmdLatest([], { filter: "live:true", limit: "2" }));
      assertOnlyLiveSessionShown(latestResult, "current.jsonl", "finished.jsonl");
      assert.ok(latestResult.logs.some((l) => l.includes("Top 1 latest sessions")), JSON.stringify(latestResult.logs));
    });
  });
});
