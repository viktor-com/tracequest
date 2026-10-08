# Render / Messages Edge-Case Integration Tests

End-to-end CLI integration for `tracequest render` and `tracequest messages` on Claude JSONL edge cases that unit tests cover in isolation but are not exercised through real `bin/tracequest.js` invocations.

Automated harness: `test/bin/tracequest-render-messages-integration.test.js` (4 scenarios). Run via `npm run test:integration`.

## Prerequisites

- Node.js (same major as CI).
- Run from repository root.
- Harness sets `TRACEQUEST_NO_SIDECAR=1` and `TRACEQUEST_SKIP_LR_WATCH=1`.
- Fixtures are written to isolated temp dirs and removed after each test.

---

## Test 1: system-only session renders and exports empty messages

**Steps:**
1. Write a JSONL file with only `type: "system"` and `isMeta: true` user rows (no real user/assistant turns).
2. Run `tracequest render <file> --out <html>`.
3. Run `tracequest messages <file>`.

**Expectations:**
1. Both commands exit `0`.
2. Render stderr warns `0 events parsed`.
3. Rendered HTML embeds `SESSION` with `eventCount: 0` and empty `events`.
4. Messages stdout parses as JSON with an empty `messages` array.

---

## Test 2: image content blocks preserve text and omit image payload

**Steps:**
1. Write a JSONL session whose user turn has `type: "image"` plus `type: "text"` blocks and a unique marker string.
2. Include a normal assistant reply.
3. Run `tracequest render` and `tracequest messages`.

**Expectations:**
1. Both commands exit `0`.
2. Text marker appears in rendered `SESSION` and messages export.
3. Base64 image payload does not appear in HTML or messages JSON (images are skipped; text is preserved).

---

## Test 3: very long tool output is truncated to 1000 chars

**Steps:**
1. Write a JSONL session with assistant `tool_use` and a `tool_result` whose content is 8000+ characters.
2. Run `tracequest render` and `tracequest messages`.

**Expectations:**
1. Both commands exit `0`.
2. Parsed `tool_result` text in `SESSION` is truncated to 1000 characters (marker prefix preserved).
3. Full 8000-character payload is not present in HTML or messages JSON.

---

## Test 4: malformed indexed-looking JSONL lines are skipped with stderr warning

**Steps:**
1. Write a JSONL file mixing: empty lines, a line that looks like a user row but is invalid JSON, a skippable `type: "system"` filler row, and a valid user row with a unique marker.
2. Run `tracequest render` and `tracequest messages`.

**Expectations:**
1. Both commands exit `0`.
2. stderr logs `parseJsonlLine: malformed JSONL line` for the broken row.
3. Valid user line is parsed; marker appears in output.
4. No stack traces or process crashes.

## Execution Results

Automated harness: `test/bin/tracequest-render-messages-integration.test.js`.

| Test | Description | Result | Evidence |
|------|-------------|--------|----------|
| 1 | System-only session renders and exports empty messages | **PASS** | Render warns `0 events parsed`; inlined SESSION has `eventCount: 0`; messages export has an empty array |
| 2 | Image content blocks preserve text and omit image payload | **PASS** | Render and messages retain the text marker and omit the base64 image payload |
| 3 | Very long tool output is truncated to 1000 chars | **PASS** | Rendered SESSION and messages JSON keep the marker prefix, cap tool output at 1000 chars, and omit the full payload |
| 4 | Malformed indexed-looking JSONL lines are skipped with stderr warning | **PASS** | Both commands log the malformed JSONL warning, parse the valid marker line, and avoid stack traces |
