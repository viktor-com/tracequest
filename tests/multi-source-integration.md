# Multi-Source HOME Integration Tests

End-to-end integration for a single `HOME` containing **both** Claude Code JSONL sessions and an OpenCode `opencode.db`. Verifies discovery, indexing, and query surfaces (CLI `list`/`search`, serve `/api/sessions`/`/api/search`) all see mixed sources.

Automated harness: `test/bin/tracequest-multi-source-integration.test.js` (5 scenarios). Run via `npm run test:integration`.

## Prerequisites

- Node.js (same major as CI) with `node:sqlite` support.
- Run from repository root.
- Harness sets `TRACEQUEST_NO_SIDECAR=1` and `TRACEQUEST_SKIP_LR_WATCH=1`.
- Seed Claude JSONL under `$HOME/.claude/projects/…` and OpenCode DB via `test/helpers/opencode-db-fixtures.js`.
- Shared search marker: `multi-src-home-marker-xyz` in both Claude prompt and OpenCode user text.
- Tear down temp dirs after each test.

---

## Test 1: list and search discover Claude JSONL and OpenCode DB in same HOME

**Steps:**
1. Seed one Claude session (≥3 turns) and one OpenCode session (≥3 messages) under the same temp `HOME`.
2. Run `tracequest list` with `HOME` override.
3. Run `tracequest search multi-src-home-marker-xyz` with same `HOME`.

**Expectations:**
1. `list` exit `0`; stdout reports `Found 2 sessions`.
2. `list` stdout shows both `claude` and `opencode` sources and both absolute Claude path + `opencode://` virtual URI.
3. `search` exit `0`; stdout reports `Found 2 results`.
4. `search` stdout references both Claude project and OpenCode project/source.

---

## Test 2: serve /api/sessions and /api/search see mixed Claude + OpenCode sources

**Steps:**
1. Same fixture as Test 1.
2. Start `tracequest serve` on ephemeral port with `HOME` override.
3. `GET /api/sessions` and `GET /api/search?q=multi-src-home-marker-xyz`.

**Expectations:**
1. `/api/sessions` returns exactly two sessions with sources `{claude, opencode}`.
2. Session paths include the seeded Claude JSONL path and `opencode://ses_multiSrcHomeIntegSession01`.
3. Both session prompts contain the shared marker.
4. `/api/search` returns two hits (one per source) with non-empty `matches[]`.

---

## Test 3: GET /compare?a=claude&b=opencode renders cross-source comparison

**Steps:**
1. Same fixture as Test 1 (one Claude session + one OpenCode session).
2. Start `tracequest serve` on ephemeral port with `HOME` override.
3. `GET /compare?a=<claude-jsonl-path>&b=opencode://<session-id>`.

**Expectations:**
1. HTTP `200`, `Content-Type` includes `text/html`.
2. Body contains `session comparison`, `session-a` / `session-b` cards, and both source badges (`claude`, `opencode`).
3. Session cards show distinct prompts (`claude side …` vs `opencode side …`).
4. Metrics table includes a `Model` row with different models (Claude sonnet vs OpenCode `gpt-4o`).
5. `Tool usage` and `Chapter quality` sections render.
6. View links: Claude path without `source` param; OpenCode URI with `&source=opencode`.

---

## Test 4: BM25 search ranks dense Claude session above sparse OpenCode in same HOME

**Steps:**
1. Seed one Claude session with many occurrences of `multi-src-bm25-rank-needle` (prompt + assistant).
2. Seed one OpenCode session with a single occurrence of the same needle.
3. Run `tracequest search multi-src-bm25-rank-needle`.

**Expectations:**
1. Exit `0`; stdout reports `Found 2 results`.
2. Dense Claude JSONL path appears before sparse `opencode://` URI (higher BM25 score first).

---

## Test 5: search and serve API return hits from all seven agent sources

This is the seven-source search gate for the full provider set (the seven-source matrix: `claude`, `cursor`, `cursor-cloud`, `opencode`, `codex`, `factory`, `grok`).

**Steps:**
1. Seed one session per agent source under the same `HOME`, each containing `multi-src-six-way-marker` (the cursor-cloud session lives under `$HOME/.local/share/tracequest/cursor-cloud/<slug>/<agentId>.jsonl` with a `session_meta` first line).
2. Run `tracequest search multi-src-six-way-marker`.
3. Start `tracequest serve`; `GET /api/search?q=multi-src-six-way-marker`.

**Expectations:**
1. CLI search exit `0`; stdout reports `Found 7 results` referencing all seven session paths/URIs.
2. stdout mentions all seven source labels (`claude`, `cursor`, `cursor-cloud`, `opencode`, `codex`, `factory`, `grok`).
3. `/api/search` returns seven hits with sources `{claude, cursor, cursor-cloud, opencode, codex, factory, grok}` and non-empty `matches[]`.

---

## Execution Results

| Test | Description | Result | Evidence |
|------|-------------|--------|----------|
| 1 | CLI list + search mixed sources | **PASS** | 2 sessions/results; claude + opencode |
| 2 | serve API mixed sources | **PASS** | `/api/sessions` + `/api/search` both sources |
| 3 | Cross-source compare page | **PASS** | Claude + OpenCode prompts, badges, metrics, view links |
| 4 | BM25 dense vs sparse ranking | **PASS** | dense Claude path before sparse OpenCode URI |
| 5 | Seven-source cross-search | **PASS** | CLI 7 results; serve API 7 hits all sources incl cursor-cloud |
