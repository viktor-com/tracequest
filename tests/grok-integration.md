# Grok Integration Tests

End-to-end CLI integration for Grok sessions under `~/.grok/sessions/<workspace>/<session-dir>/` (directory with `chat_history.jsonl`). Complements unit coverage in `test/parse/parse-grok.test.js` with real `bin/tracequest.js` invocations.

Automated harness: `test/bin/tracequest-grok-integration.test.js` (6 scenarios). Run via `npm run test:integration`.

## Prerequisites

- Node.js (same major as CI).
- Run from repository root.
- Harness sets `TRACEQUEST_NO_SIDECAR=1` and `TRACEQUEST_SKIP_LR_WATCH=1`.
- Seed Grok session dirs under isolated temp `HOME` with `chat_history.jsonl` + `events.jsonl`.
- Tear down temp dirs after each test.

---

## Test 1: list discovers Grok session directories

**Steps:**
1. Seed `~/.grok/sessions/ws-grok-integ-proj/grok-integ-sess-01/` with chat + events files.
2. Run `tracequest list` with `HOME` override.

**Expectations:**
1. Exit `0`.
2. stdout reports `Found 1 sessions`.
3. stdout shows `grok` source and the session directory path.

---

## Test 2: render produces HTML from Grok session dir

**Steps:**
1. Reuse Grok fixture.
2. Run `tracequest render <session-dir> --out <html>`.

**Expectations:**
1. Exit `0`, stdout contains `Written:`.
2. Inlined SESSION has `source: "grok"` and seeded user prompt.

---

## Test 3: messages exports JSON from Grok session dir

**Steps:**
1. Reuse Grok fixture.
2. Run `tracequest messages <session-dir>`.

**Expectations:**
1. Exit `0`, stderr contains `Parsing session`.
2. stdout parses as JSON with `messages` array (user + assistant roles).

---

## Test 4: search indexes Grok session text

**Steps:**
1. Seed Grok user prompt with unique search marker.
2. Run `tracequest search <marker>`.

**Expectations:**
1. Exit `0`, stdout reports `Found 1 result`.
2. stdout shows session dir path and marker snippet.

---

## Test 5: serve /api/sessions lists Grok session

**Steps:**
1. Reuse Grok fixture.
2. Start `tracequest serve`, `GET /api/sessions`.

**Expectations:**
1. HTTP 200 JSON envelope.
2. `sessions` includes one entry with `source: "grok"` and session directory path.

---

## Test 6: list --filter source:grok filters to Grok only

**Steps:**
1. Seed Grok + Claude sessions in same HOME.
2. Run `tracequest list --filter source:grok`.

**Expectations:**
1. Exit `0`, stdout reports `Found 1 sessions`.
2. stdout shows Grok dir only; Claude path absent.

---

## Execution Results

Automated harness: `test/bin/tracequest-grok-integration.test.js`.

| Test | Description | Result | Evidence |
|------|-------------|--------|----------|
| 1 | List discovers Grok session directories | **PASS** | `Found 1 sessions`; stdout shows `grok` and the session directory path |
| 2 | Render produces HTML from Grok session dir | **PASS** | `Written:` output; inlined SESSION has `source: "grok"` and seeded prompt |
| 3 | Messages exports JSON from Grok session dir | **PASS** | stderr logs `Parsing session`; JSON includes user and assistant roles |
| 4 | Search indexes Grok session text | **PASS** | `Found 1 result`; stdout includes session directory path and marker snippet |
| 5 | Serve /api/sessions lists Grok session | **PASS** | HTTP 200 JSON lists one `source: "grok"` session at the session directory path |
| 6 | List --filter source:grok filters to Grok only | **PASS** | `Found 1 sessions`; Grok directory shown and Claude path omitted |
