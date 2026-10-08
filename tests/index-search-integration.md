# Index / Search Pipeline Integration Tests

End-to-end integration tests for tracequest's index build + BM25 search pipeline via the real CLI. Exercises session discovery → `buildIndex` → `search.idx` persistence → `searchSessions` ranking without mocking internal modules.

Automated harness: `test/bin/tracequest-index-search-integration.test.js` (8 scenarios). Run via `npm run test:integration` or `npm test`.

## Prerequisites

- Node.js (same major as CI) and repo dependencies installed.
- Run from repository root: `/home/dev/code/tracequest`.
- Invoke CLI as `node ./bin/tracequest.js`.
- Set `TRACEQUEST_NO_SIDECAR=1` for deterministic JS-only indexing.
- Use isolated `HOME` temp dirs for fixtures; tear down after each test.

---

## Test 1: Index build produces searchable CLI results

**Steps:**
1. Seed one Claude JSONL session whose user prompt contains unique marker `idx-search-baseline-marker`.
2. Run `tracequest search idx-search-baseline-marker` with `HOME` override.

**Expectations:**
1. Exit code `0`.
2. stdout contains `Found 1 result` and references the seeded session path.
3. `~/.cache/tracequest/index.json` and `search.idx` exist under the test `HOME`.

---

## Test 2: Multi-session BM25 search ranks higher-frequency session first

**Steps:**
1. Seed two sessions under the same project:
   - `dense.jsonl`: user prompt + assistant reply repeat unique term `bm25rankneedle` many times.
   - `sparse.jsonl`: single occurrence of `bm25rankneedle`.
2. Run `tracequest search bm25rankneedle`.

**Expectations:**
1. Exit code `0`; stdout reports `Found 2 results`.
2. `dense.jsonl` path appears before `sparse.jsonl` path in stdout (higher BM25 score first).

---

## Test 3: Incremental index update finds newly added session

**Steps:**
1. Seed session A with marker `idxincremental_alpha_xyzzy`.
2. Run `tracequest search idxincremental_alpha_xyzzy` (builds warm index cache).
3. Add session B with marker `idxincremental_bravo_plugh` (new JSONL file, unchanged A).
4. Run `tracequest search idxincremental_bravo_plugh`.

**Expectations:**
1. First search finds A only.
2. Second search finds B (new file indexed without manual cache wipe).
3. Re-search for A still finds A.

---

## Test 4: Shared query returns all matching sessions

**Steps:**
1. Seed three sessions whose prompts all contain `idx-shared-query-needle`.
2. Run `tracequest search idx-shared-query-needle`.

**Expectations:**
1. Exit code `0`.
2. stdout reports `Found 3 results`.
3. Each seeded session filename appears in stdout.

---

## Test 5: Deleted session dropped from stale search index

**Steps:**
1. Seed `doomed.jsonl` (marker `idx-inv-delete-marker-xyzzy`) and `survivor.jsonl` (marker `idx-inv-survivor-marker-plugh`).
2. Run `tracequest search idx-inv-delete-marker-xyzzy` to warm `search.idx`.
3. Delete `doomed.jsonl` from disk.
4. Re-run search for doomed marker, then survivor marker.

**Expectations:**
1. Warm search finds doomed session (`Found 1 result`).
2. After delete, doomed query prints `No sessions match query`.
3. Survivor query still returns `Found 1 result`.

---

## Test 6: Edited session file reflected in re-search

**Steps:**
1. Seed `editable.jsonl` with marker `idx-inv-edit-before-plugh`.
2. Warm cache via search for the before-marker.
3. Rewrite file with `idx-inv-edit-after-plugh` (bump mtime).
4. Search after-marker, then before-marker.

**Expectations:**
1. Before edit: before-marker hit; after-marker miss.
2. After edit: after-marker hit; before-marker miss (`No sessions match query`).

---

## Test 7: Corrupt index.json rebuilds gracefully

**Steps:**
1. Seed one session with `idx-inv-survivor-marker-plugh`.
2. Warm cache via search.
3. Overwrite `~/.cache/tracequest/index.json` with invalid JSON.
4. Run search again.

**Expectations:**
1. Exit code `0`; search still finds the session.
2. `index.json` rewritten as valid JSON with `_v` version field.

---

## Test 8: Corrupt search.idx rebuilds gracefully

**Steps:**
1. Seed one session with `idx-inv-delete-marker-xyzzy`.
2. Warm cache via search.
3. Overwrite `search.idx` with garbage bytes.
4. Run search again.

**Expectations:**
1. Exit code `0`; search still finds the session.
2. `search.idx` exists with non-trivial rebuilt binary payload.

---

## Execution Results

Automated harness: `test/bin/tracequest-index-search-integration.test.js`.

| Test | Description | Result | Evidence |
|------|-------------|--------|----------|
| 1 | Index build → searchable CLI results | **PASS** | `Found 1 result`; `index.json` + `search.idx` under HOME |
| 2 | BM25 multi-session ranking | **PASS** | `dense.jsonl` path before `sparse.jsonl` in stdout |
| 3 | Incremental update after new session | **PASS** | Warm cache; new file B found; A still searchable |
| 4 | Shared query returns all hits | **PASS** | `Found 3 results`; all three filenames in stdout |
| 5 | Deleted session dropped from stale index | **PASS** | Doomed miss after delete; survivor still hit |
| 6 | Edited session reflected in re-search | **PASS** | After-marker hit; before-marker miss post-edit |
| 7 | Corrupt index.json rebuilds gracefully | **PASS** | Search correct; valid `index.json` rewritten |
| 8 | Corrupt search.idx rebuilds gracefully | **PASS** | Search correct; rebuilt binary `search.idx` |
