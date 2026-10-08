# Edge-Case Integration Tests

Stress scenarios for graceful failure, empty-state behavior, and filesystem edge cases. Complements `tests/integration.md` (happy paths) with real CLI invocations against isolated fixtures.

Automated harness: `test/bin/tracequest-edge-integration.test.js` (9 scenarios). Run via `npm run test:integration`.

## Prerequisites

- Node.js (same major as CI) and repo dependencies installed.
- Run from repository root.
- Set `TRACEQUEST_NO_SIDECAR=1` and `TRACEQUEST_SKIP_LR_WATCH=1` (harness sets these).
- Use isolated temp `HOME` overrides; tear down after each test.

---

## Test 1: Empty HOME returns sensible empty results

**Steps:**
1. Create an empty temp `HOME` with no agent data dirs.
2. Run `tracequest list`, `tracequest find model:sonnet`, and `tracequest search needle`.

**Expectations:**
1. All three exit `0`.
2. stdout contains `No sessions found.` (list/find) or `No sessions found.` before indexing (search).
3. No stack traces on stderr.

---

## Test 2: serve --port conflict fails clearly

**Steps:**
1. Bind an ephemeral TCP port on `127.0.0.1`.
2. Run `tracequest serve --port <bound-port>` with a seeded HOME.

**Expectations:**
1. Exit code `1`.
2. stderr contains `Error: Port <port> is already in use`.
3. stderr suggests `tracequest serve --port <port+1>`.
4. No `node:internal` stack trace.

---

## Test 3: share reports network errors cleanly

**Steps:**
1. Create a minimal session JSONL.
2. Run `tracequest share <path> --target gist --json --force` with `GITHUB_API_URL` pointing at a closed local port (no server listening).

**Expectations:**
1. Exit code `1`.
2. stderr contains `Error:` with a gist/upload/fetch failure message.
3. stdout is empty (no partial JSON).
4. No unhandled rejection or stack trace on stderr.

---

## Test 4: Unicode project paths discover and render

**Steps:**
1. Seed `$HOME/.claude/projects/café-日本語/` with a session whose prompt contains `unicode-edge-marker-🚀`.
2. Run `tracequest list café` and `tracequest search unicode-edge-marker-🚀`.
3. Run `tracequest render <session-path> --out <tmp.html>`.

**Expectations:**
1. list/search exit `0` and reference the unicode project name.
2. search finds the marker.
3. render writes HTML containing the marker text intact.

---

## Test 5: Unreadable session file fails gracefully

**Steps:**
1. Create a valid Claude JSONL, then `chmod 000` the file.
2. Run `tracequest render <path>`.

**Expectations:**
1. Exit code `1`.
2. stderr contains `Error:` and a parse/read failure (not a crash).
3. stdout may contain a `Parsing session...` progress line before failure.
4. Restore permissions in teardown.

---

## Test 6: Symlinked .jsonl session is discovered

**Steps:**
1. Seed a project with a real `.jsonl` and a symlink `via-link.jsonl` pointing at it.
2. Run `tracequest list <project-filter>`.

**Expectations:**
1. Exit code `0`.
2. stdout reports both the real file and the symlink path.

---

## Test 7: share times out against a hanging mock API

**Steps:**
1. Start a local HTTP server that accepts connections but never responds.
2. Run `tracequest share <path> --target gist --json --force` with `GITHUB_API_URL` pointing at the hanging server and `TRACEQUEST_SHARE_FETCH_TIMEOUT_MS` set low (e.g. 1500).

**Expectations:**
1. Exit code `1` within a bounded wall time (no hang forever).
2. stderr contains `Error:` and `timed out`.
3. stdout is empty (no partial JSON).

---

## Test 8: share retries 429 from mock API then succeeds

**Steps:**
1. Start a mock gist API that returns HTTP `429` for the first two POSTs, then `200` with a valid gist id.
2. Run share with short retry delay env (`TRACEQUEST_SHARE_FETCH_RETRY_DELAY_MS`).

**Expectations:**
1. Exit code `0`.
2. stdout JSON includes a `url` field.
3. Mock received ≥ 3 POST attempts.

---

## Test 9: share fails cleanly after 503 retries exhausted

**Steps:**
1. Start a mock gist API that always returns HTTP `503`.
2. Run share with `TRACEQUEST_SHARE_FETCH_RETRIES=2` and short retry delay.

**Expectations:**
1. Exit code `1`.
2. stderr contains `Error:` and `503`.
3. stdout is empty.

---

## Execution log

| # | Scenario | Status |
|---|----------|--------|
| 1 | Empty HOME | **PASS** |
| 2 | Port conflict | **PASS** |
| 3 | Share network error | **PASS** |
| 4 | Unicode paths | **PASS** |
| 5 | Permission denied | **PASS** |
| 6 | Symlink discovery | **PASS** |
| 7 | Share hanging API timeout | **PASS** |
| 8 | Share 429 retry success | **PASS** |
| 9 | Share 503 retry exhaustion | **PASS** |
