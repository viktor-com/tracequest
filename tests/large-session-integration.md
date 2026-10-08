# Large Session Integration Tests

Stress export/share paths with a **120-turn** synthetic Claude session (240 user+assistant JSONL rows).

## Integration test principles

1. **Expectations first** — render, messages, serve routes, and share must complete within CI timeouts without OOM.
2. **Real workflows** — full `bin/tracequest.js` and `serve` HTTP stack; mock Gist only for upload.
3. **Isolated fixtures** — temp `HOME` with one large `.jsonl` under `.claude/projects/`.
4. **Deterministic env** — `TRACEQUEST_NO_SIDECAR=1`, `TRACEQUEST_SKIP_LR_WATCH=1` (no filesystem watchers).

Automated harness: `test/bin/tracequest-large-session-integration.test.js` (7 scenarios).

## Expectations

| Test | Scenario | Pass criteria |
|------|----------|---------------|
| 1 | CLI `render` | Exit 0 within 90s; HTML embeds SESSION with ≥240 events; first/last turn markers present |
| 2 | CLI `messages` | Exit 0 within 90s; JSON has ≥240 Anthropic messages |
| 3 | serve `GET /view` | 200 HTML within 60s; SESSION events ≥240; no livereload script in export-style check |
| 4 | serve `GET /export` + `/markdown` | 200; substantial body; markdown includes first/last turn text |
| 5 | CLI `share --json` (mock gist) | Exit 0 within 90s; `chapterCount` ≥120; upload HTML includes last turn |
| 6 | CLI `share --json` (mock HF) | Exit 0 within 90s; HF commit has html+json+README; HTML includes last turn; sidecar `eventCount` ≥240 |
| 7 | CLI `share --json` (mock HF preupload) | Exit 0 within 90s; HTML ≥1 MiB triggers `/preupload/main` then PUT then commit with `oid` (not inline HTML); sidecar still inlined |

## Execution results

| Test | Status | Evidence |
|------|--------|----------|
| 1 | **PASS** | `tracequest render` exits 0 within 90s, writes HTML, embeds SESSION with >=240 events, and includes first/last turn markers |
| 2 | **PASS** | `tracequest messages` exits 0 within 90s and exports >=240 Anthropic messages with the first user marker |
| 3 | **PASS** | `GET /view?path=` returns 200 HTML within 60s, embeds >=240 events, includes the last assistant marker, and injects livereload |
| 4 | **PASS** | `/export` returns substantial HTML without livereload; `/markdown` returns substantial Markdown with first/last turn text |
| 5 | **PASS** | Gist share JSON reports `target=gist`, `chapterCount >= 120`, and mock upload HTML includes the final assistant marker |
| 6 | **PASS** | HF share JSON reports `target=hf`; mock commit includes HTML, JSON, README, final marker, and sidecar `eventCount >= 240` |
| 7 | **PASS** | HF large HTML path calls `/preupload/main`, PUTs uploaded HTML, commits an `oid` instead of inline HTML, and keeps the JSON sidecar inline |
