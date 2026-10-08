# OpenCode Integration Tests

End-to-end CLI integration for OpenCode session discovery (`~/.local/share/opencode/opencode.db`), virtual `opencode://` paths, and render/messages edge cases. Complements unit coverage in `test/parse/parse-opencode.test.js` and `test/integration-pipeline.test.js` with real `bin/tracequest.js` invocations.

Automated harness: `test/bin/tracequest-opencode-integration.test.js` (8 scenarios). Run via `npm run test:integration`.

## Prerequisites

- Node.js (same major as CI) with `node:sqlite` support.
- Run from repository root.
- Harness sets `TRACEQUEST_NO_SIDECAR=1` and `TRACEQUEST_SKIP_LR_WATCH=1`.
- Seed OpenCode fixtures under isolated temp `HOME` via `test/helpers/opencode-db-fixtures.js`.
- Use well-formed OpenCode session IDs (`ses_` + ≥20 alphanumeric chars) so virtual paths pass `isSessionPath`.
- Tear down temp dirs after each test.

---

## Test 1: list discovers OpenCode sessions when DB present

**Steps:**
1. Seed `opencode.db` with a session row and ≥3 messages (index schema).
2. Run `tracequest list` with `HOME` override.

**Expectations:**
1. Exit `0`.
2. stdout reports `Found 1 sessions`.
3. stdout shows `opencode` source and `opencode://ses_…` virtual path.

---

## Test 2: render produces HTML from opencode:// URI

**Steps:**
1. Seed OpenCode DB with user + assistant text turns.
2. Run `tracequest render opencode://<id> --out <html>` with `HOME` override.

**Expectations:**
1. Exit `0`.
2. stdout contains `Written:`.
3. HTML contains `SESSION =` boot payload with `source: "opencode"` and the seeded user prompt.

---

## Test 3: messages exports JSON from opencode:// URI

**Steps:**
1. Reuse OpenCode fixture from Test 2.
2. Run `tracequest messages opencode://<id>` with `HOME` override.

**Expectations:**
1. Exit `0`.
2. stderr contains `Parsing session`.
3. stdout parses as JSON with `messages` array containing user and assistant roles.

---

## Test 4: search indexes OpenCode session text

**Steps:**
1. Seed OpenCode DB whose user prompt contains a unique marker string.
2. Run `tracequest search <marker>` with `HOME` override.

**Expectations:**
1. Exit `0`.
2. stdout reports `Found 1 result`.
3. stdout shows the `opencode://` path and prompt snippet containing the marker.

---

## Test 5: missing opencode.db yields no OpenCode sessions

**Steps:**
1. Use empty temp `HOME` (no `opencode.db`).
2. Run `tracequest list`.

**Expectations:**
1. Exit `0`.
2. stdout contains `No sessions found.`
3. No stack traces on stderr.

---

## Test 6: corrupt opencode.db does not crash list

**Steps:**
1. Create `~/.local/share/opencode/opencode.db` containing non-SQLite bytes.
2. Run `tracequest list`.

**Expectations:**
1. Exit `0`.
2. stdout contains `No sessions found.` (graceful empty discovery).
3. No unhandled exception or `node:internal` stack trace.

---

## Test 7: tool-only assistant turn renders and exports

**Steps:**
1. Seed OpenCode DB with: user text, assistant turn containing only `tool` parts (no text), and a third user message (discovery threshold).
2. Run `tracequest render opencode://<id> --out <html>` and `tracequest messages opencode://<id>`.

**Expectations:**
1. Both commands exit `0`.
2. Rendered HTML embeds assistant `toolCalls` (e.g. Bash) in inlined `SESSION`.
3. Messages JSON includes `tool_use` blocks on the assistant turn.

---

## Test 8: malformed opencode:// URI is rejected

**Steps:**
1. Run `tracequest render opencode://sess-not-valid-id` (fails `isSessionPath`).

**Expectations:**
1. Exit `1`.
2. stderr contains `Invalid OpenCode session path`.

---

## Execution Results

Automated harness: `test/bin/tracequest-opencode-integration.test.js`.

| Test | Description | Result | Evidence |
|------|-------------|--------|----------|
| 1 | List discovers OpenCode sessions when DB present | **PASS** | `Found 1 sessions`; stdout shows `opencode` and the `opencode://` URI |
| 2 | Render produces HTML from opencode:// URI | **PASS** | `Written:` output; inlined SESSION has `source: "opencode"` and seeded prompt |
| 3 | Messages exports JSON from opencode:// URI | **PASS** | stderr logs `Parsing session`; JSON includes user and assistant roles |
| 4 | Search indexes OpenCode session text | **PASS** | `Found 1 result`; stdout includes `opencode://` URI and marker snippet |
| 5 | Missing opencode.db yields no OpenCode sessions | **PASS** | Empty HOME prints `No sessions found.` without a `node:internal` stack |
| 6 | Corrupt opencode.db does not crash list | **PASS** | Corrupt DB prints `No sessions found.` without a `node:internal` stack |
| 7 | Tool-only assistant turn renders and exports | **PASS** | Render embeds assistant `toolCalls`; messages JSON includes `tool_use` blocks |
| 8 | Malformed opencode:// URI is rejected | **PASS** | Exit 1 with `Invalid OpenCode session path` and no `node:internal` stack |
