# Codex Integration Tests

End-to-end CLI integration for Codex rollout sessions under `~/.codex/sessions/**/rollout-*.jsonl`. Complements unit coverage in `test/parse/parse-codex.test.js` and `test/integration-pipeline.test.js` with real `bin/tracequest.js` invocations.

Automated harness: `test/bin/tracequest-codex-integration.test.js` (6 scenarios). Run via `npm run test:integration`.

## Prerequisites

- Node.js (same major as CI).
- Run from repository root.
- Harness sets `TRACEQUEST_NO_SIDECAR=1` and `TRACEQUEST_SKIP_LR_WATCH=1`.
- Seed Codex rollout fixtures under isolated temp `HOME` (files must be named `rollout-*.jsonl`).
- Tear down temp dirs after each test.

---

## Test 1: list discovers Codex rollout sessions

**Steps:**
1. Seed `~/.codex/sessions/.../rollout-codex-integ.jsonl` with `session_meta` + user/assistant rows.
2. Run `tracequest list` with `HOME` override.

**Expectations:**
1. Exit `0`.
2. stdout reports `Found 1 sessions`.
3. stdout shows `codex` source and the rollout file path.

---

## Test 2: render produces HTML from Codex path

**Steps:**
1. Reuse Codex fixture.
2. Run `tracequest render <rollout.jsonl> --out <html>`.

**Expectations:**
1. Exit `0`, stdout contains `Written:`.
2. Inlined SESSION has `source: "codex"` and seeded user prompt.

---

## Test 3: messages exports JSON from Codex path

**Steps:**
1. Reuse Codex fixture.
2. Run `tracequest messages <rollout.jsonl>`.

**Expectations:**
1. Exit `0`, stderr contains `Parsing session`.
2. stdout parses as JSON with `messages` array (user + assistant roles).

---

## Test 4: search indexes Codex session text

**Steps:**
1. Seed Codex user prompt with unique search marker.
2. Run `tracequest search <marker>`.

**Expectations:**
1. Exit `0`, stdout reports `Found 1 result`.
2. stdout shows rollout path and marker snippet.

---

## Test 5: serve /api/sessions lists Codex session

**Steps:**
1. Reuse Codex fixture.
2. Start `tracequest serve`, `GET /api/sessions`.

**Expectations:**
1. HTTP 200 JSON envelope.
2. `sessions` includes one entry with `source: "codex"` and rollout path.

---

## Test 6: list --filter source:codex filters to Codex only

**Steps:**
1. Seed one Claude session and one Codex rollout in the same `HOME`.
2. Run `tracequest list --filter "source:codex"`.

**Expectations:**
1. Exit `0`, stdout reports `Found 1 sessions`.
2. stdout shows `codex` and rollout path; does not list the Claude session path.

---

## Execution Results

Automated harness: `test/bin/tracequest-codex-integration.test.js`.

| Test | Description | Result | Evidence |
|------|-------------|--------|----------|
| 1 | List discovers Codex rollout sessions | **PASS** | `Found 1 sessions`; stdout shows `codex` and the rollout path |
| 2 | Render produces HTML from Codex path | **PASS** | `Written:` output; inlined SESSION has `source: "codex"` and seeded prompt |
| 3 | Messages exports JSON from Codex path | **PASS** | stderr logs `Parsing session`; JSON includes user and assistant roles |
| 4 | Search indexes Codex session text | **PASS** | `Found 1 result`; stdout includes rollout path and marker snippet |
| 5 | Serve /api/sessions lists Codex session | **PASS** | HTTP 200 JSON lists one `source: "codex"` session at the rollout path |
| 6 | List --filter source:codex filters to Codex only | **PASS** | `Found 1 sessions`; Codex path shown and Claude path omitted |
