# CLI Preset Integration Tests

End-to-end verification that built-in YAML presets affect real `tracequest serve` behavior. Complements unit coverage in `test/cli/cli-presets.test.js` and `test/cli/cli-commands.test.js` with real bin invocations and HTTP probes.

Automated harness: `test/bin/tracequest-preset-integration.test.js` (3 scenarios). Run via `npm run test:integration`.

## Prerequisites

- Node.js (same major as CI) and repo dependencies installed.
- Run from repository root.
- Set `TRACEQUEST_NO_SIDECAR=1` and `TRACEQUEST_SKIP_LR_WATCH=1` (harness sets these).
- Use isolated temp `HOME` overrides; tear down after each test.

---

## Test 1: serve --preset local binds port 8888

**Steps:**
1. Seed a minimal Claude session under an isolated `HOME`.
2. Run `tracequest serve --preset local` (no `--port`).
3. When port 8888 is bindable, `GET http://127.0.0.1:8888/api/sessions` should succeed.

**Expectations:**
1. Exit `0` on startup (or exit `1` with `Port 8888 is already in use` if another process holds the port).
2. stdout contains `http://localhost:8888`.
3. When bindable, `/api/sessions` returns HTTP 200 JSON with the seeded session.

---

## Test 2: serve --preset default binds port 7777

**Steps:**
1. Seed a minimal Claude session under an isolated `HOME`.
2. Run `tracequest serve --preset default` (no `--port`).
3. When port 7777 is bindable, `GET http://127.0.0.1:7777/api/sessions` should succeed.

**Expectations:**
1. Exit `0` on startup (or exit `1` with `Port 7777 is already in use` if another process holds the port).
2. stdout contains `http://localhost:7777`.
3. When bindable, `/api/sessions` returns HTTP 200 JSON with the seeded session.

---

## Test 3: CLI --port overrides preset local port

**Steps:**
1. Seed a minimal Claude session under an isolated `HOME`.
2. Allocate an ephemeral TCP port.
3. Run `tracequest serve --preset local --port <ephemeral>`.

**Expectations:**
1. stdout contains `http://localhost:<ephemeral>` (not 8888).
2. `GET http://127.0.0.1:<ephemeral>/api/sessions` returns HTTP 200.

---

## Execution Results

| Test | Description | Result | Evidence |
|------|-------------|--------|----------|
| 1 | local preset → 8888 | **PASS** | stdout `http://localhost:8888`; `/api/sessions` 200 when bindable |
| 2 | default preset → 7777 | **PASS** | stdout `http://localhost:7777`; `/api/sessions` 200 when bindable |
| 3 | CLI --port overrides preset local port | **PASS** | `--preset local --port <ephemeral>` serves HTTP on ephemeral port instead of 8888 |
