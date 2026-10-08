import "../helpers/skip-lr-watch-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkTmp } from "../helpers/fixtures.js";
import {
  launchedRunGenerating,
  runGeneratingStatus,
} from "../../src/sessions/run-generating-status.js";

function writeClaudeJsonl(dir, name, objs) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, objs.map((o) => JSON.stringify(o)).join("\n") + "\n");
  return path;
}

describe("launchedRunGenerating", () => {
  test("unmatched tool_use is generating even when pgrep finds nothing", () => {
    const home = mkTmp("tq-lrg-tool-");
    const path = writeClaudeJsonl(join(home, "proj"), "s.jsonl", [
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "t-1", name: "Bash", input: { command: "ls" } }],
        },
      },
    ]);
    const got = launchedRunGenerating("claude", path, {}, { detectLiveSessions: () => [] });
    assert.equal(got, true);
    assert.equal(runGeneratingStatus(false, path, got), "running");
  });

  test("complete end_turn is idle when pgrep finds nothing", () => {
    const home = mkTmp("tq-lrg-idle-");
    const path = writeClaudeJsonl(join(home, "proj"), "s.jsonl", [
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "done" }],
          stop_reason: "end_turn",
        },
      },
    ]);
    const got = launchedRunGenerating("claude", path, {}, { detectLiveSessions: () => [] });
    assert.equal(got, false);
    assert.equal(runGeneratingStatus(false, path, got), "idle");
  });

  test("detectLiveSessions membership still counts as generating", () => {
    const path = "/tmp/does-not-need-to-exist.jsonl";
    const got = launchedRunGenerating("claude", path, {}, {
      detectLiveSessions: () => [path],
    });
    assert.equal(got, true);
  });
});
