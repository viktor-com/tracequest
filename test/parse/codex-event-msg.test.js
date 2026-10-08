import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  isCodexDisplayableUserText,
  normalizeCodexUserPromptText,
  visitCodexEventMsgPayload,
} from "../../src/parse/codex-event-msg.js";

describe("visitCodexEventMsgPayload", () => {
  test("dispatches each payload.type to the matching handler once", () => {
    const seen = [];
    visitCodexEventMsgPayload(
      { type: "user_message", message: "hello" },
      { onUserMessage: () => seen.push("user_message") },
    );
    visitCodexEventMsgPayload(
      { type: "token_count", info: { last_token_usage: { input_tokens: 1 } } },
      { onTokenCount: () => seen.push("token_count") },
    );
    visitCodexEventMsgPayload(
      { type: "patch_apply_end", path: "/a.js" },
      { onPatchApplyEnd: () => seen.push("patch_apply_end") },
    );
    visitCodexEventMsgPayload(
      { type: "exec_command_end", exit_code: 0 },
      { onExecCommandEnd: () => seen.push("exec_command_end") },
    );
    visitCodexEventMsgPayload(
      { type: "web_search_end", query: "q" },
      { onWebSearchEnd: () => seen.push("web_search_end") },
    );
    assert.deepEqual(seen, [
      "user_message",
      "token_count",
      "patch_apply_end",
      "exec_command_end",
      "web_search_end",
    ]);
  });

  test("token_count without usage fields does not invoke onTokenCount", () => {
    let calls = 0;
    visitCodexEventMsgPayload({ type: "token_count", info: {} }, {
      onTokenCount: () => calls++,
    });
    assert.equal(calls, 0);
  });

  test("token_count with total_token_usage invokes onTokenCount", () => {
    let calls = 0;
    visitCodexEventMsgPayload(
      { type: "token_count", info: { total_token_usage: { input_tokens: 1, output_tokens: 2 } } },
      { onTokenCount: () => calls++ },
    );
    assert.equal(calls, 1);
  });

  test("unknown payload.type invokes no handlers", () => {
    let calls = 0;
    visitCodexEventMsgPayload({ type: "patch_apply_start" }, {
      onPatchApplyEnd: () => calls++,
      onUserMessage: () => calls++,
    });
    assert.equal(calls, 0);
  });
});

describe("isCodexDisplayableUserText", () => {
  test("accepts non-empty text not starting with <", () => {
    assert.equal(isCodexDisplayableUserText("fix codex"), true);
    assert.equal(isCodexDisplayableUserText("  spaced  "), true);
  });

  test("rejects empty, angle-bracket, and missing text", () => {
    assert.equal(isCodexDisplayableUserText(""), false);
    assert.equal(isCodexDisplayableUserText("<system>hidden</system>"), false);
    assert.equal(isCodexDisplayableUserText(null), false);
  });

  test("rejects the injected AGENTS.md instructions block (real-rollout dialect, r8)", () => {
    // Real codex rollouts open with this machine-injected user block — both
    // the path-suffixed and bare spellings — which must never count as the
    // user's prompt (it broke run attribution and titled every session).
    assert.equal(
      isCodexDisplayableUserText("# AGENTS.md instructions for /Users/dev/proj\n\n<INSTRUCTIONS>…</INSTRUCTIONS>"),
      false,
    );
    assert.equal(isCodexDisplayableUserText("# AGENTS.md instructions"), false);
    // Ordinary markdown headings typed by the user stay displayable.
    assert.equal(isCodexDisplayableUserText("# AGENTS roster review\nplease check"), true);
  });
});

describe("normalizeCodexUserPromptText", () => {
  test("collapses whitespace and newlines", () => {
    assert.equal(normalizeCodexUserPromptText("  line one\n\nline two  "), "line one line two");
  });
});