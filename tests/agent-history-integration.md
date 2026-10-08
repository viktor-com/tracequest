# Agent-History Integration Tests

End-to-end CLI and serve integration for Claude subagent sidecars (`{sessionId}/subagents/*.jsonl`). Verifies `fetchSession` merges `agentHistory` server-side while rendered HTML/markdown **strip** it from the inlined `SESSION` payload (regression guard from iteration 6). Complements unit coverage in `test/server/agent-history.test.js` and `test/agent-history-surface.test.js`.

Automated harness: `test/bin/tracequest-agent-history-integration.test.js` (6 scenarios). Run via `npm run test:integration`.

## Prerequisites

- Node.js (same major as CI).
- Run from repository root.
- Harness sets `TRACEQUEST_NO_SIDECAR=1` and `TRACEQUEST_SKIP_LR_WATCH=1`.
- Seed Claude parent + subagent fixtures under isolated temp `HOME`.
- Tear down temp dirs after each test.

---

## Test 1: serve /view SESSION JSON omits agentHistory

**Steps:**
1. Seed Claude parent session + one `subagents/scout.jsonl` sidecar with a unique marker.
2. Start `tracequest serve` with `HOME` override.
3. `GET /view?path=<parent.jsonl>`.

**Expectations:**
1. HTTP 200.
2. Inlined `const SESSION = {…}` parses as JSON without `agentHistory` or `agentSidecarCount`.

---

## Test 2: serve /view HTML does not leak sidecar marker

**Steps:**
1. Reuse fixture from Test 1.
2. `GET /view?path=<parent.jsonl>`.

**Expectations:**
1. Response body does **not** contain the sidecar-only marker string.
2. Inlined SESSION JSON has no `agentHistory` / `agentSidecarCount` (share-scanner bundle may reference `agentHistory` in JS — that is not a leak).

---

## Test 3: serve /view retains parent session events

**Steps:**
1. Reuse fixture from Test 1 (parent prompt uses a distinct marker).
2. Parse inlined SESSION from `/view` HTML.

**Expectations:**
1. `events` includes the parent user prompt marker.
2. `source` is `claude`.

---

## Test 4: CLI render omits agentHistory from SESSION payload

**Steps:**
1. Reuse sidecar fixture.
2. Run `tracequest render <parent.jsonl> --out <html>` with `HOME` override.

**Expectations:**
1. Exit `0`.
2. Inlined SESSION JSON has no `agentHistory` / `agentSidecarCount`.
3. HTML does not contain the sidecar-only marker.

---

## Test 5: serve /markdown export omits sidecar content

**Steps:**
1. Reuse sidecar fixture.
2. `GET /markdown?path=<parent.jsonl>` via serve.

**Expectations:**
1. HTTP 200, `text/markdown` or plain markdown body.
2. Body contains parent prompt; does **not** contain sidecar marker or `agentHistory`.

---

## Test 6: share CLI scans secrets in subagent sidecars

**Steps:**
1. Seed parent session (clean prompt) + sidecar JSONL containing a fake API key pattern.
2. Run `tracequest share <parent.jsonl>` (no `--force`, non-TTY stdin).

**Expectations:**
1. Exit `1`.
2. stderr reports secret scan findings (≥1).
3. stderr mentions re-run with `--force` (share aborted).

## Execution Results

Automated harness: `test/bin/tracequest-agent-history-integration.test.js`.

| Test | Description | Result | Evidence |
|------|-------------|--------|----------|
| 1 | Serve /view SESSION JSON omits agentHistory | **PASS** | Inlined SESSION JSON parses without `agentHistory` or `agentSidecarCount` |
| 2 | Serve /view HTML does not leak sidecar marker | **PASS** | HTML omits the sidecar-only marker and inlined SESSION omits agent-history fields |
| 3 | Serve /view retains parent session events | **PASS** | Inlined SESSION keeps `source: "claude"` and the parent prompt marker |
| 4 | CLI render omits agentHistory from SESSION payload | **PASS** | Render writes HTML whose SESSION and page body omit sidecar history and marker content |
| 5 | Serve /markdown export omits sidecar content | **PASS** | Markdown contains the parent prompt and omits the sidecar marker plus `agentHistory` text |
| 6 | Share CLI scans secrets in subagent sidecars | **PASS** | Share aborts, reports secret findings, and prints `--force` guidance |
