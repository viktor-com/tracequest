# Serve Live-Reload Integration Tests

End-to-end verification of `fs.watch` → debounced SSE → session index refresh during `tracequest serve`.

## Feature

Live reload is implemented in `src/server/server-live-reload.js`:

- Watches `src/*.js` and direct `.js` helpers under `src/render/`, `src/server/`, and `src/browser/` for hot module reload (`data: reload`)
- Watches session data roots (`.claude/projects`, etc.) for `.jsonl` churn (`data: data-update`, 3s debounce)
- SSE endpoint: `GET /__livereload`

Disabled when `TRACEQUEST_SKIP_LR_WATCH=1` (default in most harnesses).

## Integration test principles

1. **Real serve process** — spawn `tracequest serve` **without** `TRACEQUEST_SKIP_LR_WATCH`.
2. **Real fs.watch** — write a new `.jsonl` under `$HOME/.claude/projects/` and wait for debounced SSE.
3. **API verification** — after `data-update`, `/api/sessions` must list the new session.

Automated harness: `test/bin/tracequest-livereload-integration.test.js` (9 scenarios). **Does not** import `skip-lr-watch-env.js`.

## Expectations

| Test | Scenario | Pass criteria |
|------|----------|---------------|
| 1 | SSE connect | `GET /__livereload` returns `data: connected` |
| 2 | New session file | Writing `.jsonl` triggers `data: data-update` within debounce window + buffer |
| 3 | Index refresh | After SSE, `/api/sessions` total becomes 1 with expected prompt/path |
| 4 | Route cache clear | After SSE, `GET /view?path=` returns HTML containing the new session prompt |
| 5 | OpenCode DB write | Inserting into `opencode.db` (fsync'd) triggers `data: data-update` within debounce window |
| 6 | OpenCode index refresh | After SSE, `/api/sessions` lists the new `opencode://` session; `/view?path=` serves fresh HTML |
| 7 | Src hot reload | Touching a watched `src/*.js` file triggers immediate `data: reload` SSE; `/api/sessions` still returns 200 after reload |
| 8 | Concurrent serve stress | Two `serve` instances on different ports sharing one `HOME`, both with livereload enabled: writing a new `.jsonl` triggers `data: data-update` on both SSE streams; both `/api/sessions` and `/view` refresh; no watcher crashes or port conflicts |
| 9 | Nested browser helper hot reload | Editing `src/browser/browser-page-build.js` triggers `data: reload`; the next served `/` HTML reflects the edited helper output |

## Execution results

| Test | Status |
|------|--------|
| 1 | **PASS** |
| 2 | **PASS** |
| 3 | **PASS** |
| 4 | **PASS** |
| 5 | **PASS** |
| 6 | **PASS** |
| 7 | **PASS** |
| 8 | **PASS** |
| 9 | **PASS** |
