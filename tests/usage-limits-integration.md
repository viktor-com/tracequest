# Usage Limits Integration Tests

End-to-end integration for `tracequest limits`, `GET /api/usage-limits`, and the usage-limits snapshot written by `import ssh` (facts in `usage-limits.facts`). Collectors talk only to local `node:http` fixtures via `TRACEQUEST_*_USAGE_URL` / `TRACEQUEST_CURSOR_API2_URL`. No real network and no developer credentials.

Automated harness: `test/bin/tracequest-usage-limits-integration.test.js` (9 scenarios). Run via `npm run test:integration` or:

```bash
TRACEQUEST_SKIP_LR_WATCH=1 node --test --test-concurrency=1 test/bin/tracequest-usage-limits-integration.test.js
```

## Prerequisites

- Node.js (same major as CI).
- Isolation: temp `HOME`. Fixture HTTP servers for collector URLs.

---

## Test 1: limits help lists usage and options

**Steps:** `tracequest limits -h`

**Expectations:** help names `limits`, `--json`, and `--host`.

## Test 2: limits command is listed in top-level help

**Steps:** `tracequest --help`

**Expectations:** Commands list includes `limits`.

## Test 3: limits empty exits 0

**Steps:** `tracequest limits` with an empty HOME.

**Expectations:** exit 0; human lines include `claude  missing`.

## Test 4: limits human and limits --json

**Steps:** Seed Claude credentials; point `TRACEQUEST_CLAUDE_USAGE_URL` at a fixture returning five_hour/seven_day utilization; run `tracequest limits` and `tracequest limits --json`.

**Expectations:** human line names claude, plan, and 25%; JSON snapshot has utilization 0.25; neither stream contains the fixture token.

## Test 5: limits --host reads the imported snapshot

**Steps:** Write `hosts/gpu/.tracequest/usage-limits.json`; `tracequest limits --host gpu --json`. Then `--host nope`.

**Expectations:** JSON host is gpu; missing host dies naming `import ssh`.

## Test 6: GET /api/usage-limits via serve

**Steps:** `tracequest serve` with a Claude fixture; GET `/api/usage-limits`.

**Expectations:** 200 `{ local, hosts }`; local claude is ok; body has no token.

## Test 7: import ssh writes a usage-limits snapshot

**Steps:** Fixture host with a Claude tree plus credentials; `tracequest import ssh gpu`.

**Expectations:** stdout `limits gpu claude ok`; `hosts/gpu/.tracequest/usage-limits.json` exists, host gpu, no token-shaped secrets; import summary still reports 6 checked.

## Test 8: dry-run does not write usage-limits

**Steps:** `tracequest import ssh gpu --dry-run`.

**Expectations:** stdout names the limits plan; hosts root is not created.

## Test 9: limits skip-with-warning and summary counters unchanged

**Steps:** Import a host with session trees but no credentials.

**Expectations:** `skip gpu claude (no credential)`; summary `6 checked` and `0 failed`.
