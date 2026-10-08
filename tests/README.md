# Integration Test Suite

End-to-end integration tests for tracequest. Most harnesses pair a **human-readable spec** (`tests/*-integration.md`) with an **automated runner** (`test/bin/tracequest-*-integration.test.js` or Playwright under `test/browser/`). The stress harness is the only runner-only exception: its numbered scenarios live inline in `test/bin/tracequest-stress-integration.test.js` and its coverage is tracked in the harness index.

## Quick start

```bash
# Non-Playwright integration harnesses (282 scenarios)
npm run test:integration

# Browser-only (Playwright; 122 scenarios; skips when Chromium unavailable)
npm run test:browser

# Full unit + integration suite
npm test
```

CI runs `npm test`, which already includes the non-Playwright integration harnesses via the recursive `test/**/*.test.js` target, then installs Chromium and runs `npm run test:browser` for the Playwright browser harnesses. `npm run test:integration` remains the focused local target for non-Playwright integration work.

## Principles

These tests follow integration-testing practices tuned for a CLI + HTTP server tool:

1. **Expectations first** — Each spec lists verifiable steps and assertions before implementation. Harness code mirrors the spec numbering.
2. **Real processes, minimal mocks** — Harnesses spawn `node ./bin/tracequest.js` and real `serve` HTTP listeners. Route handlers are not stubbed; discovery → parse → index → render/server run as in production.
3. **Isolated fixtures** — Every scenario uses a temp `HOME` with seeded JSONL, OpenCode DB, or other agent data. No dependency on the developer's `~/.claude` tree.
4. **Deterministic env** — `TRACEQUEST_NO_SIDECAR=1` avoids the Rust sidecar binary; `TRACEQUEST_SKIP_LR_WATCH=1` disables live-reload filesystem watchers. Sidecar-specific tests opt in explicitly.
5. **Paired docs by default** — Markdown specs are the contract; harnesses are the executable proof. Execution results tables in each spec are updated when scenarios change. The stress harness is intentionally runner-only because it is a compact large-corpus performance gate with inline numbered scenarios and thresholds.
6. **Fast failure, clear teardown** — Temp dirs and serve child processes are killed in `afterEach`/`finally`. Port allocation uses ephemeral binds.
7. **Layered coverage** — Unit tests (`test/`) cover pure functions and route handlers; integration tests cover cross-module CLI and HTTP flows; Playwright covers browser UI that HTTP status codes alone cannot verify.

## Harness index

| Harness | Spec | Tests | Focus |
|---------|------|------:|-------|
| Core CLI | [`integration.md`](integration.md) | 16 | help, version, render, messages, list, find/search/latest filter, serve smoke |
| Sharing | [`sharing-integration.md`](sharing-integration.md) | 19 | `share` CLI, bundle output, HF upload mocks, secret scan/redaction, full rule compilation audit |
| Serve HTTP | [`serve-integration.md`](serve-integration.md) | 42 | `/api/sessions`, `/api/search`, `serve --filter`, `?expr=`, `/view`, `/export`, `/markdown`, `/raw`, `/compare`, sort keys, OpenCode routes, concurrency stress |
| Index & search | [`index-search-integration.md`](index-search-integration.md) | 8 | BM25 ranking, incremental index, cache, invalidation |
| Sidecar | [`sidecar-integration.md`](sidecar-integration.md) | 11 | Rust sidecar scan, agent-history markers, mtime edge cases |
| Edge cases | [`edge-integration.md`](edge-integration.md) | 9 | empty HOME, port conflict, network timeout/retry, unicode, permissions, symlinks |
| OpenCode | [`opencode-integration.md`](opencode-integration.md) | 8 | `opencode://` URIs, DB discovery, render/messages/search/serve |
| Multi-source | [`multi-source-integration.md`](multi-source-integration.md) | 5 | Claude + OpenCode in one HOME; BM25 ranking; seven-source search; `/compare` |
| Messages format | [`messages-format-integration.md`](messages-format-integration.md) | 7 | Anthropic export across all sources; OpenAI + `--pretty` variants |
| Stress | *(inline in harness)* | 6 | 60-session corpus: list/search/serve pagination, sort, perf regression gate |
| Render/messages | [`render-messages-integration.md`](render-messages-integration.md) | 4 | system-only, image blocks, long tool output, malformed JSONL |
| Presets | [`preset-integration.md`](preset-integration.md) | 3 | default/local ports, `--port` override |
| Agent history | [`agent-history-integration.md`](agent-history-integration.md) | 6 | sidecar marker stripping in serve/render/share |
| Codex | [`codex-integration.md`](codex-integration.md) | 6 | `rollout-*.jsonl` discovery, render, search, serve API |
| Factory | [`factory-integration.md`](factory-integration.md) | 6 | Factory agent JSONL format |
| Grok | [`grok-integration.md`](grok-integration.md) | 6 | Grok session directory format |
| Large session | [`large-session-integration.md`](large-session-integration.md) | 7 | 120-turn render/export/markdown/share (gist + HF mock + HF preupload path) edge cases |
| Live reload | [`livereload-integration.md`](livereload-integration.md) | 9 | serve `fs.watch` + `/__livereload` SSE + index + `/view` route-cache refresh (JSONL + OpenCode DB + src/nested-helper hot reload + concurrent serve stress) |
| Cursor cloud import | [`cursor-cloud-import-integration.md`](cursor-cloud-import-integration.md) | 33 | `import cursor-cloud` keyless api2 route (local session token) + optional v0 route, two mock servers, pagination dedupe, tool_use mapping, credential errors/secrecy, dry-run, incremental fetch skip + `--full` + bounded concurrency, idempotent re-run, 404 skip, discovery/search of imported sessions |
| SSH host import | [`ssh-import-integration.md`](ssh-import-integration.md) | 27 | `import ssh` copies remote filesystem session trees via local-rsync fixture (`TRACEQUEST_IMPORT_SSH_FIXTURE`), dry-run, `--full`, `--as` host id, import-hosts file, OpenCode db copy, absent-source skip, rsync/host failure isolation, idempotent re-run, no remote delete, discovery/search with original source + `host`, two-host run, serve `/api/sessions?expr=host:gpu` + `/view`, render |
| Usage limits | [`usage-limits-integration.md`](usage-limits-integration.md) | 9 | `tracequest limits` human/--json/--host, `GET /api/usage-limits`, SSH fixture snapshot, dry-run no write, skip-with-warning, secret-free JSON |
| Launch | [`launch-integration.md`](launch-integration.md) | 35 | serve tmux-session boot + no-tmux degradation, `POST`/`GET /api/runs`, run restart survival, spawn-identity run↔session attribution (--session-id uuid; non-holding two-runs-one-cwd + user-session-steal + poisoned-claim-heal regressions) + live `/api/runs/session` unified representation, snapshot SGR→HTML capture, kill, C-locale regression, input text/keys, oversized/NUL prompt 400 JSON, continue-resume (external session → fork run carrying prior context + provenance; resume guards 404/400), non-identity attribution (r3 kill-launder tombstones, prompt-corroboration disambiguation, bare-survivor restart persistence), r4 contest memory (dismissal-flood tombstone retention, ledger-synthesized tombstones for tmux-direct kills, equal-prompt collision ambiguity), r5 heuristic-ambiguity demotion (promptless run + user session: guess demoted when the own recording lands, never finalized at exit), r7 death rule (a promptless run that crashes before writing anything never binds a session born in its window) |
| Live UI (browser) | *(fact-backed in .facts)* | 2 | Playwright unified live row (external live session as first-class running row) initial load and data-update refresh |
| Unified live chat (browser) | *(fact-backed in unified-live.facts)* | 4 | Playwright external live session in the read-only chat view (/run?session): transcript, live append, watch-only state, dashboard live-row navigation, launched+external parity (one LIVE counter, identical card anatomy), and every-source coverage (stub cursor-agent/droid/opencode processes live simultaneously, one RUNNING row per source, opencode:// opens its live chat) |
| Rendered session keyboard (browser) | *(fact-backed in .facts)* | 5 | Playwright rendered session keyboard, chart, timeline, and diagnostic strip accessibility |
| Share modal (browser) | [`sharing-integration.md`](sharing-integration.md) § Test 11 | 5 | Playwright share modal UI |
| HF adapter (browser) | [`sharing-integration.md`](sharing-integration.md) | 3 | Playwright HuggingFace re-share flow |
| Compare responsive (browser) | *(fact-backed in .facts)* | 1 | Playwright narrow-viewport compare long-label truncation |
| Launch UI (browser) | *(fact-backed in .facts)* | 4 | Playwright integrated launch flow (dashboard New run modal → run chat → Agents strip row → chat), strip kill-control dismissal, missing-multiplexer modal state, /launch→dashboard-launcher redirect |
| Run watch (browser) | *(fact-backed in .facts)* | 8 | Playwright /run chat transcript live append + pending state, raw-terminal live polling, exited state, kill from watch page, composer send paths (typed Enter, round send button, keys popover), composer Stop interrupt, in-composer state feedback (live activity line, send-morphs-to-stop, held follow-up queue with cancel/edit/send-now + in-order auto-delivery) |
| Continue-resume (browser) | *(fact-backed in launch.facts)* | 4 | Playwright type-to-continue flow: EXITED run chat's live continue composer (typed follow-up delivered into the new run, "continued from" provenance + carried prior context), dashboard row inline continue composer, observer continue composer on the read-only external-session chat, and inline vanished-cwd recovery (needs:"cwd" → directory prompt → retry lands) |
| Command palette (browser) | *(fact-backed in command-palette.facts)* | 7 | Playwright Cmd+K palette: open/filter/no-results/close, ranked session hits from the page catalog, Go to page jumps, and in-run section jumps |
| Session flyout (browser) | *(fact-backed in .facts)* | 1 | Playwright session flyout: opening a run keeps the Runs list and shows /view analytics in a RHS inspector |
| Analytics panel (browser) | *(fact-backed in .facts)* | 1 | Playwright run analytics panel: chat + sidebar stay while /view analytics dock on the right |
| Overlay focus (browser) | *(fact-backed in .facts)* | 30 | Playwright overlay focus trap, restore, and nested overlay stack |
| Shortcut when idle (browser) | *(fact-backed in .facts)* | 41 | Playwright idle page shortcuts (j/k list, g-then chords, cheatsheet, Enter/O) |
| Editable guard (browser) | *(fact-backed in .facts)* | 4 | Playwright printable page shortcuts yield to focused text fields |
| Usage limits (browser) | *(fact-backed in usage-limits.facts)* | 2 | Playwright dashboard meters: chips + reset title, hidden when empty, no horizontal overflow at mobile width |

**Total: 404 automated integration scenarios** across 38 harnesses (22 CLI/serve runners + 16 Playwright).

Runner-only exception: `test/bin/tracequest-stress-integration.test.js` intentionally has no `tests/stress-integration.md`. It is the only non-Playwright integration harness whose scenario contract is inline in the runner; keep its row here and `test:integration` registration in sync.

## Running a single harness

```bash
TRACEQUEST_SKIP_LR_WATCH=1 node --test --test-concurrency=1 \
  test/bin/tracequest-serve-integration.test.js
```

Replace the file path with any harness from the table above.

## Fixture helpers

Shared utilities live under `test/helpers/`:

- `fixtures.js` — Claude JSONL writers (`writeClaudeJsonlSynced` for fsync'd live-reload fixtures), temp dirs, model constants
- `opencode-db-fixtures.js` — SQLite `opencode.db` seeding (`appendOpenCodeIndexSessionSynced` for fsync'd live-reload fixtures)
- `synthetic-sessions.js` — large-corpus session generation (stress harness)
- `skip-lr-watch-env.js` — sets `TRACEQUEST_SKIP_LR_WATCH=1` on import
- `tmux-gate.js` — tmux availability gate (mirrors `playwright-gate.js`): tmux-dependent tests skip cleanly when tmux is absent or `TRACEQUEST_SKIP_TMUX=1`; gated harnesses always use a private per-test tmux server (unique `TRACEQUEST_TMUX_SOCKET` + `kill-server` teardown), never the developer's real one

## Relationship to unit tests

| Layer | Location | Role |
|-------|----------|------|
| Unit | `test/*.test.js`, `test/routes/` | Pure functions, route handler logic with injected deps |
| Integration | `test/bin/tracequest-*-integration.test.js` | Full CLI and serve stack |
| Browser | `test/browser/*.playwright.test.js` | DOM interactions, modal flows |
| Rust | `sidecar/` (`cargo test`) | Sidecar scan and parse |

Serve integration tests intentionally overlap with some route unit tests on error paths (400/403/404) but own the full-stack cases: real `serve` process, index build, pagination, sort keys, and multi-source discovery.

## Adding a new harness

1. Write `tests/<name>-integration.md` with numbered tests, steps, and expectations.
2. Create `test/bin/tracequest-<name>-integration.test.js` mirroring the spec.
3. Register the file in `package.json` → `scripts.test:integration`.
4. Run `npm run test:integration` and update the execution-results table in the spec.
5. Add a row to the harness index in this README.
