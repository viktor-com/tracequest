import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { parseClaude } from "../../src/parse/parse-claude.js";
import { parseCodex } from "../../src/parse/parse-codex.js";
import { indexCodexJsonl, indexClaudeJsonl } from "../../src/sessions/session-index-jsonl.js";
import { isCodexToolOutputError } from "../../src/parse/codex-response-item.js";
import fs from "node:fs";
import path from "node:path";
import { mkTmp, writeJsonl } from "../helpers/fixtures.js";

// Fixture provenance and redaction are documented beside the JSONL files.
for (const [name, failed] of [
  ["nonzero-exit", true], ["patch-failure", true], ["timeout", true],
  ["structured-exit", true], ["success", false], ["structured-success", false],
  ["legacy-patch-failure", true], ["legacy-exec-success", false],
  ["documentation-success", false], ["script-failure", true],
]) {
  test(`real Codex ${name}: transcript and index agree on failure`, () => {
    const path = fileURLToPath(new URL(`../fixtures/codex-tool-outcomes/${name}.jsonl`, import.meta.url));
    const parsed = parseCodex(path);
    const results = parsed.events.filter((e) => e.type === "tool_result");
    assert.equal(results.length, 1);
    assert.equal(results[0].isError, failed);
    assert.equal(results[0].errorConfirmed, failed);
    assert.equal(parsed.stats.errors, Number(failed));
    assert.equal(indexCodexJsonl(path).errors, Number(failed));
  });
}

test("Codex status metadata distinguishes failures from ordinary successful output", () => {
  for (const output of [
    { exit_code: 2, output: "" }, { exit_code: -1 }, { isError: true },
    { is_error: true }, { error: "tool unavailable" },
    [{ type: "output_text", text: '{"exit_code":124,"output":""}' }],
    "Script failed\nWall time 0.0 seconds\nOutput:\nScript error:\nunknown process",
    "RESULT 1\n{\"chunk_id\":\"x\",\"wall_time_seconds\":0.1,\"exit_code\":1,\"output\":\"\"}",
    "Process exited with code 127\nOutput:\n", "command timed out after 1000 milliseconds",
  ]) assert.equal(isCodexToolOutputError(output), true, JSON.stringify(output));
  for (const output of [
    { exit_code: 0, output: "Error: example" },
    "Error: example", "Documentation\ncommand timed out after 1000 milliseconds",
    "Documentation\n{\"exit_code\":1}",
    "Script completed\nWall time 0.0 seconds\nOutput:\nError: example",
    "Process exited with code 0\nOutput:\nError: example",
    { exit_code: 0, output: "command timed out after 1000 milliseconds" }, { isError: false, error: null },
    "Process exited with code 0\nOutput:\ntimeout configured to 1000 ms",
    'Process exited with code 0\nOutput:\n{"exit_code":1}',
    "Process running with session ID 123", "Script running with cell ID 123",
    "Process exited with code 0\nOutput:\nconst isError = true;",
    "Process exited with code 0\nOutput:\ncommand timed out after 1000 milliseconds",
    "Process exited with code 0\nOutput:\nProcess exited with code 1",
  ]) assert.equal(isCodexToolOutputError(output), false, JSON.stringify(output));
});

test("legacy Codex end events use status rather than successful diagnostic text", (t) => {
  const dir = mkTmp("codex-end-outcomes-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "rollout.jsonl");
  function assertOutcome(payload, failed) {
    writeJsonl(file, [{ type: "event_msg", timestamp: "2026-06-01T00:00:00Z", payload }]);
    assert.equal(parseCodex(file).events.find((e) => e.type === "tool_result").isError, failed, JSON.stringify(payload));
    assert.equal(indexCodexJsonl(file).errors, Number(failed), JSON.stringify(payload));
  }
  for (const payload of [
    { type: "exec_command_end", exit_code: 2 },
    { type: "exec_command_end", aggregated_output: "command timed out after 1000 milliseconds" },
    { type: "patch_apply_end", success: false, stderr: "patch failed" },
  ]) {
    assertOutcome(payload, true);
  }
  for (const payload of [
    { type: "exec_command_end", exit_code: 0, aggregated_output: "ok" },
    { type: "exec_command_end", exit_code: 0, aggregated_output: "SyntaxError: invalid syntax" },
    { type: "exec_command_end", exit_code: 0, stdout: "ok", stderr: "Error: boom" },
    { type: "exec_command_end", exit_code: 0, aggregated_output: "command timed out after 1000 milliseconds" },
    { type: "patch_apply_end", success: true },
  ]) {
    assertOutcome(payload, false);
  }
});

test("Codex expected negative exits match Claude explicit error results", (t) => {
  const fixture = fileURLToPath(new URL("../fixtures/codex-tool-outcomes/negative-checks.jsonl", import.meta.url));
  const parsed = parseCodex(fixture);
  assert.equal(parsed.stats.errors, 4);
  assert.equal(indexCodexJsonl(fixture).errors, 4);
  assert.ok(parsed.events.filter((e) => e.type === "tool_result").every((e) => e.isError));
  const dir = mkTmp("claude-negative-outcomes-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "claude.jsonl");
  // Claude reports shell exit 1 using explicit tool-result error metadata.
  const calls = fs.readFileSync(fixture, "utf8").trim().split("\n").map(JSON.parse)
    .filter((r) => r.payload.type === "function_call");
  writeJsonl(file, calls.flatMap(({ payload: p }) => [
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id: p.call_id, input: JSON.parse(p.arguments) }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: p.call_id, is_error: true, content: "Exit code 1" }] } },
  ]));
  assert.equal(parseClaude(file).stats.errors, 4);
  assert.equal(indexClaudeJsonl(file).errors, 4);
});
