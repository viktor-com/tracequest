# Sidecar (Rust) Integration Tests

End-to-end integration tests for the `tracequest-sidecar` Rust binary and Node delegation when `TRACEQUEST_NO_SIDECAR` is **not** set. Exercises real binary spawn (scan/index), CLI workflows with sidecar enabled, and edge cases: empty fixtures, malformed JSONL, large files, and concurrent index builds.

Unit-level JS×Rust index parity lives in `test/sidecar-parity*.test.js`. Gate/fallback behavior is in `test/sidecar-gate.test.js`. This spec covers **real ELF binary** interactions only.

Automated harness: `test/bin/tracequest-sidecar-integration.test.js` (11 scenarios). Run via `npm run test:integration`. Skips when `sidecar/target/release/tracequest-sidecar` is not a built ELF (`npm run build:sidecar`).

## Prerequisites

- Node.js (same major as CI) and repo dependencies installed.
- Rust sidecar built: `npm run build:sidecar` (release ELF at `sidecar/target/release/tracequest-sidecar`).
- Run commands from the repository root.
- Set `TRACEQUEST_SIDECAR_PATH` to the release binary (harness does this automatically).
- Do **not** set `TRACEQUEST_NO_SIDECAR=1` — these tests require sidecar delegation.
- Set `TRACEQUEST_SKIP_LR_WATCH=1` for deterministic discovery.
- Use isolated temp `HOME` overrides for CLI discovery tests; tear down after each test.

---

## Test 1: Sidecar binary runs and documents subcommands

**Steps:**
1. Run `sidecar/target/release/tracequest-sidecar --help`.

**Expectations:**
1. Exit code is `0`.
2. stdout documents `scan` and `index` subcommands.

---

## Test 2: Direct scan on empty roots returns empty JSON array

**Steps:**
1. Run `tracequest-sidecar scan --roots '[]'`.

**Expectations:**
1. Exit code is `0`.
2. stdout parses as JSON `[]`.

---

## Test 3: Direct index on empty session list returns empty object

**Steps:**
1. Pipe `[]` on stdin to `tracequest-sidecar index --index-path <tmp> --version <INDEX_VERSION> --sessions-stdin`.

**Expectations:**
1. Exit code is `0`.
2. stdout parses as JSON `{}`.

---

## Test 4: Malformed JSONL indexes without crash

**Steps:**
1. Create a temp `.jsonl` with only invalid lines (`not json`, `{broken`).
2. Index it via sidecar `index` with a minimal session payload.

**Expectations:**
1. Exit code is `0`.
2. stdout contains an entry for the path with `chapters: 0`, no `firstPrompt`, and zeroed counters.
3. Process does not panic or emit a non-zero exit.

---

## Test 5: Large session file indexes via mmap path (>512KB)

**Steps:**
1. Create a Claude JSONL fixture >512KB (thousands of user/assistant lines).
2. Index via sidecar `index`.

**Expectations:**
1. Exit code is `0`.
2. Entry has `chapters` ≥ 1000 and `firstPrompt` containing the first user marker.
3. `totalTokens` > 0 when usage fields are present.

---

## Test 6: CLI list discovers sessions via sidecar scan

**Steps:**
1. Seed `$TQ_HOME/.claude/projects/sidecar-int/` with a valid Claude JSONL session.
2. Run `HOME=$TQ_HOME TRACEQUEST_SIDECAR_PATH=<bin> TRACEQUEST_SKIP_LR_WATCH=1 node ./bin/tracequest.js list sidecar-int` (no `TRACEQUEST_NO_SIDECAR`).

**Expectations:**
1. Exit code is `0`.
2. stdout contains `Found 1 session` (or `Found 1 sessions`).
3. stdout references `sidecar-int` and the session path under `$TQ_HOME`.
4. stdout includes `claude` source label.

---

## Test 7: CLI search builds index via sidecar

**Steps:**
1. Seed `$TQ_HOME` with a session whose user prompt contains `sidecar-integration-marker-xyz`.
2. Run `tracequest search "sidecar-integration-marker-xyz"` with sidecar enabled (same env as Test 6).

**Expectations:**
1. Exit code is `0`.
2. stderr contains `via sidecar` during index build.
3. stdout contains `Found 1 result` and the project name.

---

## Test 8: Sidecar scan matches JS discoverSessions on same HOME

**Steps:**
1. Seed `$TQ_HOME` with two Claude projects (one matching filter, one not).
2. Run sidecar `scan --roots <discovery roots> --filter <name>`.
3. Run JS `discoverSessions(filter)` with `HOME=$TQ_HOME`.

**Expectations:**
1. Both return the same set of session paths (order may differ before sort).
2. Matching project is included; non-matching project is excluded.

---

## Test 9: buildIndex via sidecar matches JS-only buildIndex on minimal session

**Steps:**
1. Create a minimal valid Claude JSONL in a temp dir.
2. Call Node `buildIndex` with `TRACEQUEST_SIDECAR_PATH` set (sidecar path).
3. Reset writers; call `buildIndex` with `TRACEQUEST_NO_SIDECAR=1` (JS path).

**Expectations:**
1. Both return a `Map` with an entry for the session path.
2. `firstPrompt`, `model`, `chapters`, `tools`, and `toolCounts` match between sidecar and JS entries.

---

## Test 10: Concurrent parallel index builds complete identically

**Steps:**
1. Create a fixture with two small Claude JSONL sessions.
2. Spawn two parallel `tracequest-sidecar index` processes with the same `--index-path` and identical stdin payload.

**Expectations:**
1. Both exit `0`.
2. Both stdout JSON objects are identical.
3. Each output contains entries for both session paths.

---

## Test 11: Fractional mtime in stdin JSON indexes without panic

**Steps:**
1. Create a minimal Claude JSONL fixture.
2. Index via sidecar `index` with a session payload whose `mtime` is a floating-point epoch-ms value (e.g. `1700000000000.9`).

**Expectations:**
1. Exit code is `0` (no panic).
2. stdout entry `mtime` is truncated to integer milliseconds (`1700000000000`).
3. Session content is indexed normally (`firstPrompt` present).

---

## Execution log

Automated harness execution from repo root on 2026-06-25. Skips when release ELF is absent (`npm run build:sidecar`).

| # | Scenario | Status |
|---|----------|--------|
| 1 | Binary help | **PASS** |
| 2 | Empty scan | **PASS** |
| 3 | Empty index | **PASS** |
| 4 | Malformed JSONL | **PASS** |
| 5 | Large file mmap | **PASS** |
| 6 | CLI list + sidecar scan | **PASS** |
| 7 | CLI search + sidecar index | **PASS** |
| 8 | Scan × JS discovery parity | **PASS** |
| 9 | buildIndex × JS parity | **PASS** |
| 10 | Concurrent index builds | **PASS** |
| 11 | Fractional mtime stdin | **PASS** |
