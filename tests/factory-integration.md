# Factory Integration Tests

End-to-end CLI integration for Factory (Droid) sessions under `~/.factory/sessions/**/<name>.jsonl`. Complements unit coverage in `test/parse/parse-factory.test.js` and `test/integration-pipeline.test.js` with real `bin/tracequest.js` invocations.

Automated harness: `test/bin/tracequest-factory-integration.test.js` (6 scenarios). Run via `npm run test:integration`.

## Prerequisites

- Node.js (same major as CI).
- Run from repository root.
- Harness sets `TRACEQUEST_NO_SIDECAR=1` and `TRACEQUEST_SKIP_LR_WATCH=1`.
- Seed Factory JSONL fixtures under isolated temp `HOME` (`~/.factory/sessions/ws-home-dev-code-<project>/`).
- Tear down temp dirs after each test.

---

## Test 1: list discovers Factory sessions

**Steps:**
1. Seed `~/.factory/sessions/ws-home-dev-code-factory-integ-proj/factory-integ.jsonl` with `session_start` + user/assistant rows.
2. Run `tracequest list` with `HOME` override.

**Expectations:**
1. Exit `0`.
2. stdout reports `Found 1 sessions`.
3. stdout shows `factory` source and the JSONL file path.

---

## Test 2: render produces HTML from Factory path

**Steps:**
1. Reuse Factory fixture.
2. Run `tracequest render <jsonl> --out <html>`.

**Expectations:**
1. Exit `0`, stdout contains `Written:`.
2. Inlined SESSION has `source: "factory"` and seeded user prompt.

---

## Test 3: messages exports JSON from Factory path

**Steps:**
1. Reuse Factory fixture.
2. Run `tracequest messages <jsonl>`.

**Expectations:**
1. Exit `0`, stderr contains `Parsing session`.
2. stdout parses as JSON with `messages` array (user + assistant roles).

---

## Test 4: search indexes Factory session text

**Steps:**
1. Seed Factory user prompt with unique search marker.
2. Run `tracequest search <marker>`.

**Expectations:**
1. Exit `0`, stdout reports `Found 1 result`.
2. stdout shows JSONL path and marker snippet.

---

## Test 5: serve /api/sessions lists Factory session

**Steps:**
1. Reuse Factory fixture.
2. Start `tracequest serve`, `GET /api/sessions`.

**Expectations:**
1. HTTP 200 JSON envelope.
2. `sessions` includes one entry with `source: "factory"` and JSONL path.

---

## Test 6: list --filter source:factory filters to Factory only

**Steps:**
1. Seed Factory + Claude sessions in same HOME.
2. Run `tracequest list --filter source:factory`.

**Expectations:**
1. Exit `0`, stdout reports `Found 1 sessions`.
2. stdout shows Factory path only; Claude path absent.

---

## Execution Results

Automated harness: `test/bin/tracequest-factory-integration.test.js`.

| Test | Description | Result | Evidence |
|------|-------------|--------|----------|
| 1 | List discovers Factory sessions | **PASS** | `Found 1 sessions`; stdout shows `factory` and the JSONL path |
| 2 | Render produces HTML from Factory path | **PASS** | `Written:` output; inlined SESSION has `source: "factory"` and seeded prompt |
| 3 | Messages exports JSON from Factory path | **PASS** | stderr logs `Parsing session`; JSON includes user and assistant roles |
| 4 | Search indexes Factory session text | **PASS** | `Found 1 result`; stdout includes JSONL path and marker snippet |
| 5 | Serve /api/sessions lists Factory session | **PASS** | HTTP 200 JSON lists one `source: "factory"` session at the JSONL path |
| 6 | List --filter source:factory filters to Factory only | **PASS** | `Found 1 sessions`; Factory path shown and Claude path omitted |
