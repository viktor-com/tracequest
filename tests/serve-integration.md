# Serve HTTP API Integration Tests

End-to-end integration tests for tracequest's `serve` command and HTTP surface: JSON APIs (`/api/sessions`, `/api/search`), session detail routes (`/view`, `/export`, `/markdown`, `/raw`), and error handling. Tests exercise a **real** `node ./bin/tracequest.js serve` process with isolated `HOME` fixtures — no mocked route handlers.

Core CLI smoke (Test 9) lives in `tests/integration.md`. Route-handler unit/integration tests live under `test/routes/`. This spec covers the full serve stack: CLI → discovery → index → HTTP.

## Prerequisites

- Node.js (same major as CI) and repo dependencies installed.
- Run from repository root: `/home/dev/code/tracequest`.
- Invoke CLI as `node ./bin/tracequest.js`.
- Set `TRACEQUEST_NO_SIDECAR=1` and `TRACEQUEST_SKIP_LR_WATCH=1` for deterministic discovery and to avoid filesystem watchers.
- Seed sessions under a temporary `HOME`:
  1. `export TQ_HOME=$(mktemp -d /tmp/tracequest-serve-home-XXXXXX)`
  2. Create `$TQ_HOME/.claude/projects/<project>/` with valid Claude JSONL sessions.
  3. Prefix serve with `HOME=$TQ_HOME TRACEQUEST_NO_SIDECAR=1 TRACEQUEST_SKIP_LR_WATCH=1`.
- Pick a free port per run (ephemeral).
- Tear down: kill serve PID; `rm -rf $TQ_HOME`.

---

## Test 1: `/api/sessions` returns valid JSON list envelope

**Steps:**
1. Seed one session under `$TQ_HOME`.
2. Start serve on ephemeral port; wait for `GET /api/sessions` → 200.
3. Parse JSON body.

**Expectations:**
1. HTTP `200`, `Content-Type` includes `application/json`.
2. Body has `sessions` (array, length ≥ 1), `total`, `page`, `pageSize`, `stats`, `liveSessions`.
3. First session entry includes `source`, `project`, `path`, `id`, `prompt`.

---

## Test 2: `/api/sessions` pagination respects `page` and `pageSize`

**Steps:**
1. Seed three sessions in one project.
2. `GET /api/sessions?page=1&pageSize=2`, then `page=2&pageSize=2`.

**Expectations:**
1. First response: `page=1`, `pageSize=2`, `sessions.length=2`, `total=3`.
2. Second response: `page=2`, `sessions.length=1`.

---

## Test 3: `/api/search?q=...` returns matching sessions

**Steps:**
1. Seed session whose user prompt contains unique marker `serve-api-search-marker-xyz`.
2. `GET /api/search?q=serve-api-search-marker-xyz`.

**Expectations:**
1. HTTP `200` with JSON `{ results: [...] }`.
2. `results.length ≥ 1`.
3. Hit includes `path`, `source`, `prompt`, `matches` (array).

---

## Test 4: `/api/search` empty and unmatched queries

**Steps:**
1. `GET /api/search?q=` and `GET /api/search?q=zzzz-serve-no-match-token`.
2. With seeded session present.

**Expectations:**
1. Empty `q`: HTTP `200`, `{ results: [] }`.
2. Unmatched token: HTTP `200`, `{ results: [] }`.

---

## Test 5: `/view?path=...` renders session HTML

**Steps:**
1. Seed session with id `serve-view-1`.
2. `GET /view?path=<absolute-session-path>`.

**Expectations:**
1. HTTP `200`, `Content-Type` includes `text/html`.
2. Body contains `<html` and `SESSION =`.
3. Body references session id `serve-view-1`.

---

## Test 6: `/export?path=...` returns downloadable HTML

**Steps:**
1. `GET /export?path=<session-path>`.

**Expectations:**
1. HTTP `200`, `Content-Type` includes `text/html`.
2. `Content-Disposition` is `attachment` with `tracequest-*.html` filename.
3. Body contains `SESSION =`.

---

## Test 7: `/markdown?path=...` returns downloadable markdown

**Steps:**
1. `GET /markdown?path=<session-path>`.

**Expectations:**
1. HTTP `200`, `Content-Type` includes `text/markdown`.
2. `Content-Disposition` is `attachment` with `.md` filename.
3. Body is non-empty plain text/markdown (not HTML doctype).

---

## Test 8: `/raw?path=...` returns JSONL attachment

**Steps:**
1. `GET /raw?path=<session-path>`.

**Expectations:**
1. HTTP `200`.
2. `Content-Disposition` attachment with `.jsonl` filename.
3. Body contains seeded user prompt text from fixture.

---

## Test 9: Unknown route returns 404

**Steps:**
1. `GET /api/does-not-exist`.

**Expectations:**
1. HTTP `404`, body `Not found`.

---

## Test 10: `/view` without path returns 400

**Steps:**
1. `GET /view` (no query).

**Expectations:**
1. HTTP `400`, body `Missing path`.
2. Not HTML.

---

## Test 11: `/view` forbidden path returns 403 without leaking path

**Steps:**
1. `GET /view?path=/etc/passwd`.

**Expectations:**
1. HTTP `403`, body `Forbidden: path is not a session file`.
2. Body does not contain `/etc/passwd`.

---

## Test 13: `GET /` returns browser index HTML

**Steps:**
1. Seed sessions under `$TQ_HOME`.
2. `GET /` (index route).

**Expectations:**
1. HTTP `200`, `Content-Type` includes `text/html`.
2. Body contains doctype, `<title>Runs · tracequest</title>`, and client fetch to `/api/sessions`.

---

## Test 14: `GET /compare?a=&b=` renders session comparison HTML

**Steps:**
1. Seed two sessions with distinct ids.
2. `GET /compare?a=<path-a>&b=<path-b>`.

**Expectations:**
1. HTTP `200`, `Content-Type` includes `text/html`.
2. Body contains `session comparison`, `session-a` / `session-b` cards, and both fixture prompts.

---

## Test 15: `GET /export` without path returns 400

**Steps:**
1. `GET /export` (no query).

**Expectations:**
1. HTTP `400`, body `Missing path`.
2. Not HTML; no `Content-Disposition` attachment header.

---

## Test 35: `GET /compare` without param `a` returns 400

**Steps:**
1. Seed fixture sessions.
2. `GET /compare?b=<path-b>` (no `a`).

**Expectations:**
1. HTTP `400`, body `Missing path`.
2. Not HTML.

---

## Test 36: `GET /compare` with valid `a` but missing `b` returns 400

**Steps:**
1. Seed fixture sessions.
2. `GET /compare?a=<path-a>` (no `b`).

**Expectations:**
1. HTTP `400`, body `Missing path`.
2. Not HTML.

---

## Test 37: `GET /compare` forbidden path returns 403

**Steps:**
1. Seed one valid session.
2. `GET /compare?a=<path-a>&b=/etc/passwd`.

**Expectations:**
1. HTTP `403`, body contains `Forbidden`.
2. No `/etc/passwd` leak; not HTML.

---

## Test 16: `/api/sessions?sort=recent` returns sessions newest-first

**Steps:**
1. Seed three sessions with distinct file mtimes (oldest → newest: `aaa-oldest`, `mmm-middle`, `zzz-newest`).
2. `GET /api/sessions?sort=recent&pageSize=10`.

**Expectations:**
1. HTTP `200`; three sessions returned.
2. Order by `id`: `zzz-newe`, `mmm-midd`, `aaa-olde` (mtime descending; ids truncated to 8 chars).
3. Each session’s `mtime` field is non-increasing down the list.

---

## Test 17: `/api/sessions` default sort matches `recent`

**Steps:**
1. Same fixture as Test 16.
2. `GET /api/sessions?pageSize=10` (no `sort` param).

**Expectations:**
1. Same newest-first order as Test 16.

---

## Test 34: `/api/sessions?sort=date` aliases `recent`

**Steps:**
1. Same fixture as Test 16.
2. `GET /api/sessions?sort=date&pageSize=10`.

**Expectations:**
1. Same newest-first order as Test 16.
2. Each session's `mtime` field is non-increasing down the list.

---

## Test 18: invalid `sort` param handled gracefully

**Steps:**
1. Same fixture as Test 16.
2. `GET /api/sessions?sort=<bad>&pageSize=10` for `not-a-real-key` and `name`.

**Expectations:**
1. HTTP `200` for each (no server error).
2. Order falls back to `recent` (mtime descending), not alphabetical by id.
3. Note: API sort keys are `recent`, `date` (alias for recent), `duration`, `cost`, `tokens`, `errors`, `files`, `commits`, `chapters`, `grade` — not `name`.

---

## Test 19: `/export` forbidden path returns 403

**Steps:**
1. `GET /export?path=/etc/passwd`.

**Expectations:**
1. HTTP `403`, body `Forbidden: path is not a session file`.
2. Body does not contain `/etc/passwd`.

---

## Test 20: `/markdown` forbidden path returns 403

**Steps:**
1. `GET /markdown?path=/etc/passwd`.

**Expectations:**
1. HTTP `403`, body `Forbidden: path is not a session file`.
2. Body does not contain `/etc/passwd`.

---

## Test 21: `/raw` forbidden path returns 403

**Steps:**
1. `GET /raw?path=/etc/passwd`.

**Expectations:**
1. HTTP `403`, body `Forbidden`.
2. Body does not contain `/etc/passwd`.

---

## Test 38: Three concurrent serve instances on different ports

**Steps:**
1. Seed three isolated `HOME` dirs with one session each (distinct prompts: alpha, beta, gamma).
2. Start three `tracequest serve --port <port>` processes concurrently (one per HOME).
3. `GET /api/sessions` and cross-home `/api/search?q=...` on each port.
4. Stop all three; verify ports are bindable again.

**Expectations:**
1. Each instance returns only its own seeded session (HOME isolation).
2. Cross-home search queries return empty on every other port.
3. All child processes exit after teardown.
4. All three ports are free after stop (no port leak).

---

## Test 39: Rapid serve start/stop cycles do not leak ports

**Steps:**
1. Seed one isolated `HOME` with a single session.
2. Allocate one ephemeral port; run 5 cycles: start serve → `GET /api/sessions` → SIGKILL stop → wait for exit.
3. After all cycles, verify the port is bindable again.

**Expectations:**
1. Each cycle returns HTTP 200 with the seeded session.
2. Child process exits within timeout after each stop.
3. Port is bindable after all cycles (no TIME_WAIT / leak accumulation).

---

## Test 22: Two concurrent serve instances on different ports

**Steps:**
1. Seed two isolated `HOME` dirs with one session each (distinct prompts).
2. Start `tracequest serve --port <portA>` with `HOME=A` and `tracequest serve --port <portB>` with `HOME=B` concurrently.
3. `GET /api/sessions` and `/api/search?q=...` on each port.
4. Stop both serve processes; verify ports are bindable again.

**Expectations:**
1. Each instance returns only its own seeded session (HOME isolation).
2. Cross-home search queries return empty on the other port.
3. Both child processes exit after teardown (no zombies).
4. Both ports are free after stop (no port leak).

---

## Test 23: `/api/sessions` lists OpenCode sessions from `opencode.db`

**Steps:**
1. Seed an isolated `HOME` with only `opencode.db` (no Claude/Codex sessions).
2. Start serve; `GET /api/sessions`.

**Expectations:**
1. HTTP `200`; exactly one session in `sessions`.
2. Session has `source=opencode`, `path=opencode://<id>`, and seeded prompt text.

---

## Test 24: `/view?path=opencode://...` renders session HTML

**Steps:**
1. Same OpenCode-only fixture as Test 23.
2. `GET /view?path=opencode://<session-id>`.

**Expectations:**
1. HTTP `200`, `Content-Type` includes `text/html`.
2. Body contains `SESSION =`, session id, and seeded user prompt.

---

## Test 25: `/api/search` indexes OpenCode session text

**Steps:**
1. Same OpenCode-only fixture as Test 23 (unique search marker in user prompt).
2. `GET /api/search?q=<marker>`.

**Expectations:**
1. HTTP `200`; `results.length ≥ 1`.
2. Hit includes `path=opencode://<id>`, `source=opencode`, marker in `prompt`, and non-empty `matches`.

---

## Test 26: `/api/sessions?sort=tokens` orders by totalTokens descending

**Steps:**
1. Seed three sessions with explicit assistant `usage` totals: 150, 500, and 900 tokens (`tok-low.jsonl`, `tok-mid.jsonl`, `tok-high.jsonl`).
2. `GET /api/sessions?sort=tokens&pageSize=10`.

**Expectations:**
1. HTTP `200`; three sessions returned.
2. Order by `id`: `tok-high`, `tok-mid`, `tok-low`.
3. `totalTokens` values are `[900, 500, 150]` and non-increasing down the list.

---

## Test 27: `/api/sessions?sort=duration` orders by durationMs descending

**Steps:**
1. Seed three sessions with distinct first/last timestamps: 10s, 50s, and 99s (`dur-short.jsonl`, `dur-mid.jsonl`, `dur-long.jsonl`).
2. `GET /api/sessions?sort=duration&pageSize=10`.

**Expectations:**
1. HTTP `200`; three sessions returned.
2. Order by `id`: `dur-long`, `dur-mid`, `dur-shor`.
3. `durationMs` values are `[99000, 50000, 10000]` and non-increasing down the list.

---

## Test 28: `/api/sessions?sort=cost` orders by estimateCost descending

**Steps:**
1. Seed three sessions with distinct assistant `usage` at the same model: low (1.1K tokens), mid (11K), high (110K).
2. `GET /api/sessions?sort=cost&pageSize=10`.

**Expectations:**
1. HTTP `200`; three sessions returned.
2. Order by `id`: `cost-hig`, `cost-mid`, `cost-low`.
3. Per-session `estimateCost` (from `inputTokens`/`outputTokens`/`model`) is non-increasing; high exceeds low.

---

## Test 29: `/api/sessions?sort=errors` orders by errors descending

**Steps:**
1. Seed three sessions with 0, 2, and 5 `is_error` tool_result rows (`err-none.jsonl`, `err-few.jsonl`, `err-many.jsonl`).
2. `GET /api/sessions?sort=errors&pageSize=10`.

**Expectations:**
1. HTTP `200`; three sessions returned.
2. Order by `id`: `err-many`, `err-few`, `err-none`.
3. `errors` values are `[5, 2, 0]` and non-increasing down the list.

---

## Test 31: `/api/sessions?sort=commits` orders by commits descending

**Steps:**
1. Seed three sessions with 1, 3, and 6 `git commit` Bash tool_use commands (`cmt-few.jsonl`, `cmt-mid.jsonl`, `cmt-many.jsonl`).
2. `GET /api/sessions?sort=commits&pageSize=10`.

**Expectations:**
1. HTTP `200`; three sessions returned.
2. Order by `id`: `cmt-many`, `cmt-mid`, `cmt-few`.
3. `commits` values are `[6, 3, 1]` and non-increasing down the list.

---

## Test 32: `/api/sessions?sort=chapters` orders by chapters descending

**Steps:**
1. Seed three sessions with 2, 5, and 9 user turns (`ch-few.jsonl`, `ch-mid.jsonl`, `ch-many.jsonl`).
2. `GET /api/sessions?sort=chapters&pageSize=10`.

**Expectations:**
1. HTTP `200`; three sessions returned.
2. Order by `id`: `ch-many`, `ch-mid`, `ch-few`.
3. `chapters` values are `[9, 5, 2]` and non-increasing down the list.

---

## Test 33: `/api/sessions?sort=grade` orders by grade score descending

**Steps:**
1. Seed three sessions with distinct grade profiles: high (A), mid (C), low (F).
2. `GET /api/sessions?sort=grade&pageSize=10`.

**Expectations:**
1. HTTP `200`; three sessions returned.
2. Order by `id`: `grd-high`, `grd-mid`, `grd-low`.
3. `computeGrade(session).score` is non-increasing down the list; high exceeds low.

---

## Test 30: `/api/sessions?sort=files` orders by files descending

**Steps:**
1. Seed three sessions with 1, 4, and 7 `Read` tool_use `file_path` entries.
2. `GET /api/sessions?sort=files&pageSize=10`.

**Expectations:**
1. HTTP `200`; three sessions returned.
2. Order by `id`: `files-ma`, `files-mi`, `files-fe`.
3. `files` values are `[7, 4, 1]` and non-increasing down the list.

---

## Test 12: `serve --filter` scopes API session list

**Steps:**
1. Seed `serve-filter-alpha` and `serve-filter-beta` projects (one session each).
2. Start `serve --filter serve-filter-alpha`.
3. `GET /api/sessions`.

**Expectations:**
1. All returned sessions reference project `serve-filter-alpha`.
2. No session from `serve-filter-beta`.

---

## Test 40: `serve --filter` scopes `/api/search` to matching sessions

**Steps:**
1. Seed alpha and beta projects with distinct search markers in prompts.
2. Start `serve --filter serve-filter-alpha`.
3. `GET /api/search?q=<alpha-marker>` and `GET /api/search?q=<beta-marker>`.

**Expectations:**
1. Alpha marker returns one hit under `serve-filter-alpha`.
2. Beta marker returns `{ results: [] }` (beta sessions excluded by startup filter).

---

## Test 41: `/api/sessions?expr=` compound expression filters API list

**Steps:**
1. Seed sonnet + opus under `serve-expr-alpha`, sonnet under `serve-expr-beta`.
2. Start `serve` (no `--filter`).
3. `GET /api/sessions?expr=project:serve-expr-alpha%20AND%20model:sonnet`.

**Expectations:**
1. HTTP `200`; `total=1`.
2. Single session is alpha sonnet (`alpha-sonnet.jsonl`); opus and beta sonnet excluded.

---

## Test 42: `/api/search?expr=` compound expression filters search hits

**Steps:**
1. Seed sonnet + opus under `serve-search-expr-alpha`, sonnet under `serve-search-expr-beta`; all prompts contain a shared search marker.
2. Start `serve` (no `--filter`).
3. `GET /api/search?q=<marker>&expr=project:serve-search-expr-alpha%20AND%20model:sonnet`.

**Expectations:**
1. HTTP `200`; `results.length=1`.
2. Hit is alpha sonnet (`alpha-sonnet.jsonl`); opus and beta sonnet excluded despite sharing the query token.

---

## Execution Results

Automated harness: `test/bin/tracequest-serve-integration.test.js` (42 scenarios; run via `npm run test:integration` or `npm test`).

Manual execution from repo root on 2026-06-25. All tests spawn real `tracequest serve` against isolated `HOME` fixtures.

| Test | Description | Result | Evidence |
|------|-------------|--------|----------|
| 1 | `/api/sessions` JSON envelope | **PASS** | 200 + `sessions`, `total`, `page`, `pageSize`, `stats`, `liveSessions` |
| 2 | `/api/sessions` pagination | **PASS** | `pageSize=2` → 2 items; page 2 → 1 item; `total=3` |
| 3 | `/api/search?q=...` matches | **PASS** | Marker `serve-api-search-marker-xyz` returns hit with `matches[]` |
| 4 | `/api/search` empty/unmatched | **PASS** | Empty `q` and no-match token both return `{ results: [] }` |
| 5 | `/view` session HTML | **PASS** | 200 HTML with `SESSION =` and session id |
| 6 | `/export` attachment HTML | **PASS** | `Content-Disposition: attachment` + `tracequest-*.html` |
| 7 | `/markdown` attachment | **PASS** | `text/markdown` + `.md` filename |
| 8 | `/raw` JSONL attachment | **PASS** | Attachment with seeded prompt in body |
| 9 | Unknown route 404 | **PASS** | `GET /api/does-not-exist` → 404 `Not found` |
| 10 | `/view` missing path 400 | **PASS** | `Missing path`, not HTML |
| 11 | `/view` forbidden 403 | **PASS** | No `/etc/passwd` leak in body |
| 12 | `serve --filter` scopes API | **PASS** | Only `serve-filter-alpha` sessions returned |
| 13 | `GET /` index HTML | **PASS** | 200 HTML with tracequest title + `/api/sessions` client |
| 14 | `GET /compare` comparison | **PASS** | 200 HTML with prompts, view links, metrics + tool sections |
| 15 | `GET /export` missing path 400 | **PASS** | `Missing path`, not HTML, no attachment header |
| 35 | `GET /compare` missing `a` 400 | **PASS** | `Missing path`, not HTML |
| 36 | `GET /compare` missing `b` 400 | **PASS** | `Missing path`, not HTML |
| 37 | `GET /compare` forbidden 403 | **PASS** | `Forbidden`, no path leak |
| 16 | `/api/sessions?sort=recent` newest-first | **PASS** | mtime desc: `zzz-newe`, `mmm-midd`, `aaa-olde` |
| 17 | `/api/sessions` default sort = recent | **PASS** | Same order as Test 16 without `sort` param |
| 34 | `/api/sessions?sort=date` alias = recent | **PASS** | Same order as Test 16 with non-increasing `mtime` |
| 18 | invalid `sort` falls back to recent | **PASS** | `not-a-real-key`, `name` → 200 + mtime order |
| 19 | `/export` forbidden 403 | **PASS** | No `/etc/passwd` leak |
| 20 | `/markdown` forbidden 403 | **PASS** | No `/etc/passwd` leak |
| 21 | `/raw` forbidden 403 | **PASS** | `Forbidden`, no path leak |
| 22 | concurrent serve on two ports | **PASS** | HOME isolation; ports rebind after stop |
| 38 | three concurrent serve instances | **PASS** | alpha/beta/gamma HOME isolation; 3 ports free after stop |
| 39 | rapid serve start/stop cycles | **PASS** | 5 cycles on one port; port rebindable after teardown |
| 23 | `/api/sessions` lists OpenCode sessions | **PASS** | OpenCode-only HOME; `source=opencode`, virtual URI |
| 24 | `/view?path=opencode://` renders HTML | **PASS** | 200 HTML with `SESSION =` + session id |
| 25 | `/api/search` indexes OpenCode text | **PASS** | Marker hit on `opencode://` path with `matches[]` |
| 26 | `/api/sessions?sort=tokens` token order | **PASS** | `totalTokens` desc: 900, 500, 150 |
| 27 | `/api/sessions?sort=duration` duration order | **PASS** | `durationMs` desc: 99000, 50000, 10000 |
| 28 | `/api/sessions?sort=cost` cost order | **PASS** | `estimateCost` desc: high → mid → low |
| 29 | `/api/sessions?sort=errors` errors order | **PASS** | `errors` desc: 5, 2, 0 |
| 30 | `/api/sessions?sort=files` files order | **PASS** | `files` desc: 7, 4, 1 |
| 31 | `/api/sessions?sort=commits` commits order | **PASS** | `commits` desc: 6, 3, 1 |
| 32 | `/api/sessions?sort=chapters` chapters order | **PASS** | `chapters` desc: 9, 5, 2 |
| 33 | `/api/sessions?sort=grade` grade order | **PASS** | grade score desc: high → mid → low |
| 40 | `serve --filter` scopes `/api/search` | **PASS** | alpha marker hit; beta marker returns `[]` |
| 41 | `/api/sessions?expr=` compound AND | **PASS** | `project:serve-expr-alpha AND model:sonnet` → `total=1` |
| 42 | `/api/search?expr=` compound AND | **PASS** | shared marker + `project:serve-search-expr-alpha AND model:sonnet` → 1 hit |
