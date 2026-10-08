# Messages Format Integration Tests

End-to-end integration for `tracequest messages` across all supported agent sources. Verifies each source exports valid **Anthropic-format** JSON (default) and that format variants (`--format openai`, `--pretty`) behave correctly on Claude sessions.

Automated harness: `test/bin/tracequest-messages-format-integration.test.js` (7 scenarios). Run via `npm run test:integration`.

## Prerequisites

- Node.js (same major as CI) with `node:sqlite` support for OpenCode fixtures.
- Run from repository root.
- Harness sets `TRACEQUEST_NO_SIDECAR=1` and `TRACEQUEST_SKIP_LR_WATCH=1`.
- Each test uses an isolated temp `HOME` with a single seeded session per source.

---

## Test 1: Claude JSONL exports valid Anthropic-format JSON

**Steps:**
1. Seed a minimal Claude JSONL session (≥2 turns).
2. Run `tracequest messages <path>`.

**Expectations:**
1. Exit `0`; stderr contains `Parsing session`.
2. stdout parses as JSON with `messages[]`.
3. First message `role=user`, second `role=assistant`; content blocks are typed arrays (`text` blocks have `type` + `text`).

---

## Test 2: OpenCode `opencode://` URI exports valid Anthropic-format JSON

**Steps:**
1. Seed `opencode.db` with one session (≥3 messages for discovery).
2. Run `tracequest messages opencode://<session-id>`.

**Expectations:**
1. Exit `0`; valid Anthropic `messages[]` shape.
2. User text retains seeded marker.

---

## Test 3: Codex `rollout-*.jsonl` exports valid Anthropic-format JSON

**Steps:**
1. Seed `~/.codex/sessions/.../rollout-*.jsonl`.
2. Run `tracequest messages <codex-path>`.

**Expectations:**
1. Exit `0`; valid Anthropic `messages[]` shape.
2. User text retains seeded marker.

---

## Test 4: Factory JSONL exports valid Anthropic-format JSON

**Steps:**
1. Seed `~/.factory/sessions/**/<session>.jsonl`.
2. Run `tracequest messages <factory-path>`.

**Expectations:**
1. Exit `0`; valid Anthropic `messages[]` shape.
2. User text retains seeded marker.

---

## Test 5: Grok session dir exports valid Anthropic-format JSON

**Steps:**
1. Seed `~/.grok/sessions/**/<sess>/chat_history.jsonl` + `events.jsonl`.
2. Run `tracequest messages <grok-dir>`.

**Expectations:**
1. Exit `0`; valid Anthropic `messages[]` shape.
2. User text retains seeded marker.

---

## Test 6: Claude `--format openai` exports valid OpenAI-format JSON

**Steps:**
1. Seed Claude JSONL with a tool_use turn.
2. Run `tracequest messages <path> --format openai`.

**Expectations:**
1. Exit `0`; `messages[]` with OpenAI roles (`user`/`assistant`/`tool`).
2. Assistant `tool_calls[].function.arguments` is a JSON string.

---

## Test 7: Claude `--pretty` emits indented JSON

**Steps:**
1. Seed minimal Claude JSONL.
2. Run `tracequest messages <path> --pretty`.

**Expectations:**
1. Exit `0`; stdout contains newline-indented JSON (not single-line).

---

## Execution Results

| Test | Description | Result | Evidence |
|------|-------------|--------|----------|
| 1 | Claude Anthropic default | **PASS** | `messages[0].role=user`, typed content blocks |
| 2 | OpenCode Anthropic | **PASS** | `opencode://` URI, marker in user text |
| 3 | Codex Anthropic | **PASS** | rollout JSONL, marker in user text |
| 4 | Factory Anthropic | **PASS** | factory JSONL, marker in user text |
| 5 | Grok Anthropic | **PASS** | grok dir, marker in user text |
| 6 | Claude OpenAI variant | **PASS** | `tool_calls[].function.arguments` string |
| 7 | Claude --pretty | **PASS** | multi-line indented stdout |