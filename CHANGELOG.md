# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- README leads with screenshots and features; command, configuration and API guides live in `docs/` with an entry point for coding agents.

## [0.1.0] - 2026-10-08

First public release.

### Changed

- **License: MIT.** tracequest is released under the MIT License.
- **`serve` listens on 127.0.0.1 by default.** `--bind <addr>` picks another address.
- `npm start` no longer fails without a Rust toolchain; it falls back to the JS indexer.

### Added

- `npm run demo` serves two synthetic sample sessions from `examples/`.
- CODE_OF_CONDUCT, issue and PR templates, README quickstart and screenshots.
- **`tracequest insights`** plus the `/insights` page and `GET /api/insights`: cross-host answers to where agents fail and wait — tool-error rate and error classes by harness and repo area, retries and loops, active time and tokens per session, long stalls, the most expensive sessions, and four recurring traps (wrong folder, path bleed, test-runner hangs, CI waits). Every figure opens onto example sessions. Recording: `docs/ui-examples/insights.webm`.
- Central hub support: `import ssh` records per-machine pull health, shown in the Machines table on `/insights`; `serve --hub` is a read-only view that redacts secrets in every response and refuses non-GET requests; `serve --bind <addr>` limits the listener to one address.

## Private pre-releases

The entries below are from before the project was open-sourced. Their version numbers predate the public 0.1.0.

## [0.9.0] - 2026-09-22

### Added
- **`tracequest limits`** plus `GET /api/usage-limits` and dashboard meters for remaining plan windows (Claude 5-hour/weekly, Codex rate-limit windows, Cursor period usage, Grok subscription). Unauthenticated harnesses show a muted sign-in chip. SSH import writes a secret-free snapshot per host; credential files are never copied. Recording: `docs/ui-examples/usage-limits.webm`.
- Home usage row on `/`, `/run`, and the Runs inventory: one widget per detected harness (plan window, used versus remaining, reset time, or the sign-in hint), same payload as the top-bar chips. Recording: `docs/ui-examples/usage-limits.webm`.

## [0.8.2] - 2026-09-21

### Fixed
- Release workflow: fact `dj0` (Dirent-based discovery reads) counted inline `readdirSync` call sites, which 0.8.1 consolidated into the shared guarded reader; it now checks the reader and its call sites. 0.8.1 never published because of it.

## [0.8.1] - 2026-09-21

### Fixed
- Session discovery no longer empties the dashboard when one subtree is unreadable: an `EACCES` directory, a symlink cycle (`ELOOP`), or a directory removed mid-walk is skipped instead of failing the whole scan. The codex walk has a depth ceiling and a visited real-path set, so an aliased directory is listed once.
- An unwritable `~/.cache/tracequest` no longer turns a successful command into exit 1 (the `search.idx` flush is guarded like `index.json`).
- `cursor-cloud` and the ssh-imported hosts root are watched, not just scanned, so imported sessions appear without a restart.
- Live detection: a timed-out `pgrep` probe is treated as inconclusive rather than "nothing running", so running agents no longer blink out of the dashboard on loaded machines. A degraded pass carries the previous clean snapshot forward while the recording still reads as generating.

### Changed
- `/api/sessions/live` uses one discovery scan per poll instead of two.
- The OpenCode discovery cache keeps one slot per database instead of retaining every mtime's rows.
- Adds `bench/`, a reproducible harness for cold index, incremental update, idle CPU/memory, live-state flapping, and adversarial correctness.

## [0.8.0] - 2026-09-20

### Added
- **`tracequest import ssh`** copies filesystem session trees (and OpenCode's `opencode.db`) from remote machines into `~/.local/share/tracequest/hosts/<host>/`. One ControlMaster SSH mux per host; `--as <id>` (or `user@box as gpu` in `~/.tracequest/import-hosts`) is the stable host id. Imported rows keep their original source plus `host`, so `source:claude host:gpu` is a normal filter, and Continue is disabled on those rows. `--dry-run`, `--full`, `--identity`/`-i`, and `--port` match the existing import command.

## [0.7.4] - 2026-09-20

### Fixed

- Release workflow: `TRACEQUEST_SKIP_PERF_ASSERTS` is now job-level on the linux leg so `facts check` (which also runs perf-backed facts) honours it; 0.7.3 failed on one such fact.

## [0.7.3] - 2026-09-20

### Fixed

- Release workflow: the linux-x64 leg skips wall-clock perf budgets (`TRACEQUEST_SKIP_PERF_ASSERTS=1`, as CI already does) — 0.7.2 never published because five micro-benchmarks missed by 15-40% on the hosted Ubuntu runner.

## [0.7.2] - 2026-09-20

### Added
- **Linux x86_64 release tarball.** `tracequest-<version>-linux-x64.tgz` ships a natively built (glibc, `ubuntu-24.04`) sidecar next to the Apple Silicon one, so Linux hosts no longer degrade to the JS indexer when installed from a GitHub Release.

## [0.7.1] - 2026-08-27

### Fixed
- **RUNNING means the agent is generating, not that the TUI is open.** An attached idle session — process alive, listed in Grok `active_sessions.json`, last assistant turn complete, composer showing "Send a follow-up" — is not running. The same definition applies to claude, codex, cursor-agent, factory/droid, and opencode. cursor-cloud stays never-live (no local process). Process + cwd match is a candidate gate only; a session is live only while `recordingIsGenerating` sees an in-flight turn: unmatched `turn_started` / `task_started` / `tool_use`, live phase, growing or mid-write jsonl, running subagent, or OpenCode last-assistant streaming text. Dashboard `running`, `/api/sessions` `live`, CLI `--filter live:true`, and watch-page identity share that one bit. A last JSONL record larger than the 128KB tail is still parsed; an unmatched start that has aged out of the tail still counts as generating unless the tail shows a closing boundary.

### Notes
- Built by an adversarial builder/critic loop against this session's idle Grok TUI screenshot as the quality bar. The full verdict history lives outside the repo in the run's harness directory.

## [0.7.0] - 2026-08-20

### Added
- **Cmd+K is how you move.** From any page in the web UI, `⌘K` / `Ctrl+K` opens a command palette over a full-viewport scrim: type to search sessions by identity, jump to Chat, Runs, Compare, a session view, or New run, and — when you are already on a run — jump to that run's sections (`#chapter-N` and the rest of the in-page landmarks). Results mix commands and ranked session hits in one list; chips name the kind of row; empty query shows the jump mix, a query that matches nothing says so.
- **Session hits paint from an identity catalog shipped with the page**, so typing does not wait on `/api/search` or a 50-file snippet scan. Cold key-to-hit is a handful of milliseconds. The search page and CLI still do the full snippeted BM25 path; the palette does not.

### Notes
- Built by an adversarial builder/critic loop against Linear's command menu as the quality bar: 5 lanes (palette shell, search, page jumps, in-run sections, search latency), each round built and judged by separate fresh agents, UI rounds judged blind. Search latency took three rounds — first dropping snippet scans, then a preloaded catalog, then embedding the catalog in the page — before the critic certified it against Linear's typed list. The full verdict history lives outside the repo in the run's harness directory.

## [0.6.0] - 2026-08-12

### Added
- **Watching a run is a chat, not a terminal.** `/run?id=` renders the agent's own session recording through tracequest's unified representation: user messages, assistant prose with inline code and bullets, tool-call cards with human titles grouped as "Explored N searches", "Thought 6s" markers, file-edit cards with +N/−N diffstats, and a spinner on the step running right now. It updates live — the page polls the run's parsed session with an etag so an unchanged poll costs a 615-byte answer, and appends surface within a poll of hitting disk. The raw tmux screen is still there, demoted to a collapsed `raw terminal` disclosure, because a TUI's redraws are occasionally what you actually want to see.
- **Any live session — not just the ones tracequest started.** Every supported agent's running session is detected and gets identical treatment: claude, codex, cursor-agent, droid/factory, grok, and opencode (whose sessions live in one SQLite file and are addressed as `opencode://`), each via per-binary process detection correlated to the session by working directory. cursor-cloud is honestly excluded — it has no local process to probe, so it is never badged RUNNING no matter what its imported metadata claims. Externally started sessions open in the same live chat with a watch-only state that says plainly why there is no composer: another terminal drives that agent.
- **Continue any session as a new run.** A finished thread keeps a live composer — typing *is* the continue. Submitting forks the conversation into a fresh tmux run via each agent's own resume mechanism (`claude --resume <id> --fork-session --session-id <new>`, `codex resume <id>`, `cursor-agent --resume`, `opencode --session`), carries the prior context, and lands you in the new run's chat with your follow-up already delivered. The same affordance lives on dashboard rows, `/view`, and the watch page of an externally-driven session. Agents with no resume mechanism (droid, gemini) simply do not offer it.
- **Launching and watching live inside the app.** The standalone `/launch` page is gone (it redirects); a `+ New run` launcher opens from anywhere, a run is ONE row in the session list carrying its live activity line, and the chat opens the same record the list sells — same id, model, project, grade, and stat chips, under the same app chrome and a persistent session rail.
- **A composer that shows the run's state.** The status strip names what the agent is doing right now; follow-ups typed while it is busy are held in a visible, editable, cancelable queue and delivered in order when it is ready; the send control morphs to a stop control mid-generation; `Stop ^C` and a danger-tinted `Kill run` are distinct before you read them.

### Fixed
- **Run↔recording attribution is identity, not a guess.** Runs mint a session id at spawn where the agent supports it (`claude/grok --session-id`), so a run's chat can never show another agent's transcript. Where no such flag exists, attribution falls back through pid-keyed open-file probing, first-user-message corroboration against the run's launch prompt, and finally a sole-candidate guess that must survive a 3s probation and is demoted the moment a second candidate becomes eligible — preferring an honest "pending" over a wrong transcript, always. Dismissed runs leave tombstones inside tmux (relevance-compacted, and synthesized from a run ledger when a window is killed outside the API) so a survivor can never launder a dead run's conversation.
- **Every consumer agrees where an agent writes.** Recording layouts are defined once in `src/sessions/session-layout.js` and shared by discovery, live detection, attribution, and the file watcher. Attribution had been scanning a cursor directory layout the real CLI has never used, so every cursor-agent run pended forever with its transcript on disk; the watcher was missing the cursor root entirely.
- **The codex AGENTS.md injection is no longer mistaken for your prompt.** Real codex rollouts open with an injected instructions block that is markdown rather than XML, so it slipped past the hidden-block filter and became the session's first prompt — showing up as the title in the session list and in search text, and preventing prompted codex runs from ever linking their own recording. The Rust indexer mirrors the same rule so it and the JS parser agree.

### Notes
- Built by an adversarial builder/critic loop against official Cursor UI captures as the quality bar: 26 rounds across 6 lanes, each round built and judged by separate fresh agents, UI rounds judged blind. Two lanes (continue-resume, chat-transcript) were certified by two consecutive independent wins; the full verdict history, including the gaps still open, lives outside the repo in the run's harness directory.
- Live updates are still snapshot polling; SSE push remains future work.

## [0.5.0] - 2026-08-11

### Added
- **Launch and watch agent runs from the web UI.** A **Run** is a tracequest-initiated agent execution living in a tmux window of the `tracequest` tmux session — tracequest keeps no run table of its own, so all run state lives in tmux and runs survive `serve` restarts: a freshly started serve process lists the same runs with the same ids, reading agent, cwd, and start time back out of tmux window user options (`@tq_agent`, `@tq_cwd`, `@tq_started`). At boot, `serve` connects to the `tracequest` session (creating it detached when absent, reusing it untouched when present), so `tmux attach -t tracequest` from a real terminal shows exactly the runs the web UI manages — the browser and the terminal are two views of the same windows. Finished runs keep their final screen viewable via remain-on-exit until explicitly killed. `TRACEQUEST_TMUX_SESSION`, `TRACEQUEST_TMUX_SOCKET`, and `TRACEQUEST_TMUX_BIN` override the session name, tmux server, and binary.
- **An agent auto-detection registry** pins the launchable agent CLIs — claude, codex, cursor-agent, opencode, grok, droid, gemini — each with its binary name and per-agent argv shape for passing an optional initial prompt. Detection means exactly "the binary resolves on PATH" via a which-style probe that never executes the agent itself; an agent absent from PATH is simply not offered, and agents outside the registry can never be launched at all.
- **The `/launch` page** (linked from the dashboard) renders a form — agent dropdown listing only the detected agents, cwd input, optional initial-prompt textarea — plus a runs list with per-run status and watch/kill actions. **The `/run` watch page** is a terminal-styled live viewer: it polls the run's screen snapshot roughly every 600ms, rendering tmux `capture-pane -e` output through a zero-dependency SGR-to-HTML converter (`src/render/ansi-html.js`) that HTML-escapes text before styling it and covers the 16 base/bright colors, 256-color, truecolor, bold/dim/italic/underline/reverse — unknown SGR parameters are ignored, never thrown on. An input box forwards text and special keys into the run via tmux send-keys, an exited run shows a visually distinct state with its final screen intact, and a kill control dismisses it.
- **The API surface behind the pages:** `GET /api/agents` (multiplexer status + detected agents), `POST /api/runs` (create), `GET /api/runs` (list with live running/exited status derived from tmux `pane_dead`), `GET /api/runs/snapshot?id=` (current screen as HTML, bypassing the route cache so every poll is fresh), `POST /api/runs/kill`, and `POST /api/runs/input` (literal text via `send-keys -l`, plus exactly one special key from the closed set Enter, C-c, Escape, Up, Down, Tab).

### Security
- The mutating endpoints — `POST /api/runs`, `/api/runs/kill`, `/api/runs/input` — accept POST only (405 otherwise) and validate the request's Host header before acting: a hostname other than localhost, 127.0.0.1, or [::1] answers 403 and performs no tmux operation, the DNS-rebinding/CSRF guard these process-controlling routes need even on a localhost-only tool. `POST /api/runs` launches only registry agents currently detected on PATH (unknown or undetected agents answer 400 with no window created) and requires cwd to be an existing directory — the request chooses among detected agents and supplies prompt/cwd data, never a command line. No shell-string interpolation exists anywhere in the feature: every tmux and detection call goes through `execFileSync`/`spawnSync` argv arrays, and agent argv passes prompts behind a `--` end-of-options marker so a dash-leading prompt cannot become a flag. Prompts are validated for size (8192-byte cap) and C0 control characters before any spawn.

### Notes
- **Without tmux, `serve` still boots and every pre-existing route works unchanged** — the launch APIs report the multiplexer unavailable and the `/launch` page renders a missing-multiplexer state instead of a form. No tmux process is ever spawned when tmux is not resolvable.
- tmux invocations are locale-proof (parsing does not depend on the user's LANG/LC_*), and pane capture is read through a 32MB buffer so a chatty agent cannot truncate its own screen.
- **~600ms snapshot polling is the shipped v1 transport; SSE push is explicitly deferred** as future work.
- Test surface: a 16-scenario integration harness (`test/bin/tracequest-launch-integration.test.js`, real serve children against private per-test tmux servers, stub agent scripts standing in for real CLIs), 7 playwright browser scenarios, and unit suites for the tmux adapter, agent detection, SGR rendering, and routes — all green (`npm test` 3554 pass / 0 fail).

## [0.4.1] - 2026-07-28

### Fixed
- **`tracequest import cursor-cloud` downloaded every transcript on every run.** The idempotency check compared the local file's message count against the remote conversation, and getting that count required fetching the conversation — so a run that changed nothing still pulled all of your cloud agents, one at a time, multi-megabyte responses included. The decision is now made from the `ListBackgroundComposers` response alone: when the local file's `session_meta.updatedAt` matches the remote `updatedAtMs` and `createdAt` matches too, **no conversation request is issued at all**. Only new or genuinely changed agents are fetched, and those remaining fetches now run with a bounded concurrency of 4 instead of strictly sequentially. Measured on a real 61-agent account: a full run went from 176.5s (62 requests) to 28.2s (10 requests), and a steady-state run where nothing had changed takes 0.64s and issues a single list request. The existing guarantees are unchanged — an unchanged session is still not rewritten, so its mtime is preserved and the incremental indexer does not re-read it; a `404` is still skipped with a warning, a `401` still ends the run with an actionable re-auth message, and the credential still never leaks.

### Added
- **`--full` refetches every agent, bypassing the incremental skip.** This is the recovery path for a local file whose metadata is intact but whose body is not — written by an older importer with different message mapping, truncated, or left behind after switching between the keyless and `--api-key` routes. A `--full` run reverts to incremental behavior on the next run.
- The run summary now reports **checked / fetched / imported / updated / skipped / failed**, and a plan line is printed before fetching begins, so it is obvious how much work a run decided to do and why.

### Notes
- The incremental skip trusts the remote timestamp. An agent whose remote `updatedAtMs` is unchanged but whose local file is stale or damaged for some other reason is **not** detected automatically — the file's own contents are never compared. `--full` is the documented recovery for that case, and is worth running once after switching between the keyless and `--api-key` routes, since the two produce different transcript fidelity.

## [0.4.0] - 2026-07-28

### Added
- **`tracequest import cursor-cloud` — Cursor cloud agent sessions are now searchable, and it needs no API key.** Cursor's cloud (background) agents keep no structured transcript on disk: `state.vscdb` holds metadata only, and the `conversation-search.db` FTS cache is flattened text with no message ids, timestamps, or tool calls. The new explicit import command fetches the real transcripts and materialises them as JSONL under `~/.local/share/tracequest/cursor-cloud/<project-slug>/<agentId>.jsonl`, where ordinary discovery, indexing, and search pick them up like any other session. By default it reads the Cursor session token this machine already has (`state.vscdb` key `cursorAuth/accessToken`) and calls Cursor's own connect-rpc backend (`api2.cursor.sh`: `ListBackgroundComposers` + `GetBackgroundComposerConversation`) — full fidelity, including tool calls. Supplying a dashboard key with `--api-key` or `CURSOR_API_KEY` selects the documented `api.cursor.com` Cloud Agents v0 route instead (text-only transcripts). The two are separate auth systems and are never mixed or cross-retried: the key source picks the route once. `--dry-run` reports what would be written without touching the disk. Re-runs are idempotent — a session whose remote `updatedAt` and message count are unchanged is skipped without rewriting the file, so its mtime is preserved and the incremental indexer does not re-read it. Every run ends with an `imported / updated / skipped / failed` summary. Nothing outside this command performs network I/O to Cursor; startup behavior is unchanged apart from statting one more (possibly absent) discovery root.
- **`cursor-cloud` is a first-class seventh session source**, registered end to end in both engines: discovery roots and walker, the JS indexer and the Rust sidecar, parse, peek, snippet scan, search, the `source:cursor-cloud` filter, the `serve` session-path allowlist, and the UI/HTML source badge (cyan). Both halves ship together — a JS-only source would make the fail-closed sidecar exit non-zero and silently drop the whole corpus back to the JS indexer.
- **Imported transcripts carry more than text.** `MESSAGE_TYPE_HUMAN`/`MESSAGE_TYPE_AI` map to `user`/`assistant` rows; a message's thinking text is merged into its text block (a separate thinking block is indexed by JS but not by Rust, so it would break parity and skew token estimates); and `toolResults[]` become `tool_use` content blocks, so tools, tool counts, and touched files light up through the existing Cursor tool tracking. Cursor's tool names are normalized to tracequest's vocabulary (`run_terminal_cmd`→Shell, `read_file`→Read, `grep`→Grep, `glob_file_search`→Glob, `search_replace`→StrReplace, `task_v2`→Task, `mcp`→CallMcpTool), and unrecognized names pass through verbatim. Message ids ride along as `bubbleId`. Session title, model, status, repository, branch, PR url, and real epoch timestamps come from the list response, so cloud sessions report an actual start and duration instead of the file-birthtime estimate used for local Cursor sessions.
- Environment overrides for the new surface: `TRACEQUEST_CURSOR_CLOUD_DIR` (storage root), `TRACEQUEST_CURSOR_API2_URL` and `TRACEQUEST_CURSOR_API_URL` (the two backends), alongside the existing `TRACEQUEST_CURSOR_STATE_DB`.

### Fixed
- **The dual-index parity harness ran discovery with an unpinned sidecar.** `withDualIndexHarness` called `findSessions` without pinning `SIDECAR_BIN`, so `detectSidecar` preferred the gitignored staged binary in `sidecar/bin/` over the freshly built one. A stale staged binary therefore reported a source set from before the build, and the parity suite compared against it instead of the code under test — which is exactly how a newly added source can vanish without a single test going red. Discovery in the harness is now pinned to the binary the suite is testing.

### Notes
- The credential is read from the local store at request time only. It is never written into an imported session file, never printed (including under `--dry-run`), and never included in an error message.
- The keyless route talks to an **undocumented internal Cursor backend**. Its response shape may change without notice; the importer fails soft on drift, skipping the affected session with a warning rather than aborting the run. The documented `--api-key` v0 route is kept as the stable fallback.
- **The local session token expires and is not refreshed.** On this project's development machine it expires 2026-09-23. There is no refresh flow: a `401` ends the run with an actionable message telling you to re-authenticate in Cursor. A deleted or unknown agent (`404`) is skipped with a warning and does not fail the run.
- A first import fetches every cloud agent sequentially; large agents produce multi-megabyte single responses (the largest observed had 3458 messages) and are read without truncation. Passing `--api-key` on the command line makes the key visible to `ps`; the keyless default avoids that entirely.

## [0.3.1] - 2026-07-28

### Fixed
- **An unrecognized session source silently corrupted the index, permanently.** Both indexers dispatched an unknown `source` through a catch-all fallback to the Claude JSONL indexer — `_ => index_claude(…)` in the sidecar (`sidecar/src/indexer.rs`) and `indexer ? indexer(session) : indexClaudeJsonl(session.path)` in JS (`src/sessions/session-index-core.js`). When the session's path was not a Claude JSONL file the read failed, the error went to stderr only, and an **all-zero metadata entry was persisted to `index.json` carrying the discovery row's own mtime** — so the mtime-equality incremental check never re-indexed it. The bogus entry was sticky until `INDEX_VERSION` was bumped, and the sidecar still exited 0. Both halves now fail closed: the source must be one of the six known ones (`claude`, `codex`, `cursor`, `factory`, `grok`, `opencode`), the whole batch is refused, nothing is written to `index.json`, and the sidecar exits non-zero with the offending source and path on stderr. The two compose — a non-zero sidecar exit routes the batch to the JS indexer, which refuses it as well. A session with no `source` at all still defaults to the Claude indexer, so no current scanner output changes behavior.
- **`tracequest list`, `find`, and `latest` crashed mid-output on an epoch-ms mtime.** These printers called `s.mtime.toISOString()` on the raw value, so a discovery row carrying a number instead of a `Date` threw `TypeError: s.mtime.toISOString is not a function` — *after* `Found N sessions:` had already printed, in both text and `--json` modes. `search` already used the hardened `new Date(s.mtime)` form; the other three now match it.
- **`tracequest handoff` printed absolute filesystem paths three lines below its own "no absolute paths" privacy header.** The Markdown used `projectLabel`, which only strips a `-code-` suffix or `-home-<user>-` prefix and therefore passes an absolute path through untouched. It now uses `normalizeProjectFolder`, which collapses the value to its final folder name.
- **The CLI and `/api/sessions` printed different project strings for the same session.** `list`/`find`/`latest`/`search` normalized `project` with `projectLabel` while `/api/sessions` used `normalizeProjectFolder` via `sessionToApiObject`, so the same record rendered as `/srv/deploy-tools` in the terminal and `deploy-tools` in the API. Both surfaces now use `normalizeProjectFolder`.
- **Refusing a batch leaked a file descriptor in a long-lived `serve` process.** Both serial indexing paths in `src/sessions/index-writers.js` (`indexStaleChunkSerial` and the serial branch of `buildIndex`) closed the lazily opened read-only `opencode.db` handle *after* the loop — correct only while indexing could not throw, which the fail-closed change above ends. A batch shaped `[opencode, unknown-source]` skipped the close entirely, so every refused build leaked one descriptor; measured before the fix, 12 refused batches grew the process open-fd count by exactly 12. The close now runs in a `finally`, matching the existing `withOpenCodeDb` convention.

### Changed
- **A session with an empty or absent project now renders `(unknown)`** in `list`, `find`, `latest`, and `search` instead of a blank column, matching what `/api/sessions` already returned. This falls out of unifying both surfaces on `normalizeProjectFolder`.

## [0.3.0] - 2026-07-21

### Fixed
- **Multi-source session discovery dropped sources at random on x86_64 Linux.** The Rust sidecar scanned data roots with `roots.par_iter()` while each per-source scanner also parallelizes internally via jwalk; the nested rayon parallelism starved the inner walks and returned a non-deterministic subset of sessions (a six-root scan yielded 1, then 4, then 1 session across successive runs). On an affected host `tracequest list`/`serve` would show only some of your Claude/Codex/Cursor/Factory/Grok sessions, varying run to run. Roots are now walked sequentially; jwalk still parallelizes each directory walk.
- **Live session detection never worked on macOS.** Every probe was Linux-only — `readlink /proc/<pid>/cwd` for Claude and Grok, a `/proc/*/fd` scan for Codex/Cursor/Factory. On macOS those calls raised `ENOENT`, which the code classified as an expected process race and swallowed, so `detectLiveSessions()` always returned `[]`: the dashboard live block stayed hidden, row badges never appeared, and `live:true` matched nothing. Detection now runs through a platform facade (`src/sessions/proc-probe.js`) with an `lsof` implementation for macOS alongside the existing `/proc` one.
- **The session you launched tracequest from was invisible in the live list.** BSD `pgrep` omits its own ancestors unless `-a` is passed, so a `tracequest serve` started inside a Claude session filtered out that very session. macOS now passes `-ax`; Linux keeps `-x`, where `-a` means `--list-full` and would corrupt pid parsing.
- Watching a single file (`opencode.db`) died permanently the first time the file was replaced by rename, deleted, or was absent at startup, because `fs.watch` binds to an inode. `watchFile` now re-arms, retrying on a capped backoff while the path is missing.
- **Session routes rejected valid sessions under a symlinked home.** `isSessionPath` compared the realpath'd session file against a non-canonicalized home prefix, so when `$HOME` (or a parent like macOS `/var` → `/private/var`) resolved through a symlink, every `/view`, `/export`, `/markdown`, and `/compare` request returned 403. The home prefix is now canonicalized before the comparison.

### Changed
- **`engines.node` is now `>=22.5.0`**, matching what the code already required for the built-in SQLite module. This is the breaking part of the release: installs on older Node are no longer supported. `.nvmrc` pins the matching major and both workflows were moved from Node 20 to 22, so CI finally exercises the runtime the project actually targets — the OpenCode SQLite paths degrade silently below it and were effectively untested. `test/node-engine-contract.test.js` fails the build if the three ever drift apart.
- All `fs.watch` usage moved behind `src/server/fs-watch.js`. Setup failures now degrade to a no-op handle with a one-time warning instead of four call sites logging and then silently watching nothing; `filename === null` is an explicit per-caller policy (data roots fail open, src hot-reload fails closed) rather than an event dropped by accident.

### Notes
- macOS live detection spawns `lsof` (~120ms per sweep), memoized for 5 seconds, so cost is bounded regardless of request volume. Detection resolves a running Claude process to the newest `.jsonl` in its project directory, so two concurrent sessions in one directory collapse to a single entry; Codex/Cursor/Factory sessions are only considered when modified within the last 120s. Windows reports no live sessions.
- This release ships a **`darwin-arm64` (Apple Silicon) tarball only**. The `darwin-x64` (Intel) build is temporarily disabled because GitHub no longer allocates `macos-13` hosted runners for this repo, and the project builds each platform natively rather than shipping an untested cross-compiled binary. Intel support returns once a native Intel runner is available or a Rosetta-tested cross-build is added.

## [0.2.0] - 2026-07-10

### Fixed
- **The Rust sidecar never ran on macOS.** `detectSidecar` gated on ELF magic bytes, so it rejected the Mach-O binary it had just built (`detectSidecar: ignoring non-ELF sidecar`) and silently fell back to the JavaScript indexer — on every macOS machine, including a source checkout. The gate now accepts any native executable format. `scripts/ensure-sidecar.mjs` had the same bug, causing `npm start` to re-run `cargo build` every time.
- `resolveBundledSidecarBinaryPath` shelled out to `which`, which does not exist on Windows; it now uses `where` there and takes the first match.

### Changed
- **tracequest is no longer published to any registry.** `package.json` sets `"private": true` and a `prepublishOnly` hook aborts `npm publish` unconditionally. Distribution is a tarball installed directly by URL, needing no account, token, or npm configuration on the recipient's machine.
- **One tarball per platform**, `tracequest-<version>-<platform>.tgz`, each bundling a sidecar binary built natively for that CPU under `sidecar/bin/<platform>/`. Supported platforms (`darwin-arm64`, `darwin-x64`) are declared in `scripts/dist-platforms.mjs`. `detectSidecar` prefers the bundled binary, and warns explicitly when a tarball's sidecar does not match the running host instead of degrading in silence.
- **License: relicensed from MIT to proprietary.** `LICENSE` is now "all rights reserved" with a revocable internal-use grant for explicitly authorized recipients; `package.json` declares `SEE LICENSE IN LICENSE`, and `sidecar/Cargo.toml` points at the same file with `publish = false`. Copyright is held by av. Prior releases remain available under the MIT terms they were published with; this change is not retroactive.

### Added
- `.github/workflows/release.yml`: on a `v*` tag, verifies the tag matches `package.json` version, builds and smoke-tests each per-platform tarball on its own native macOS runner, and attaches them to a GitHub Release with the workflow's built-in `GITHUB_TOKEN`. The GitHub Release is the hosting — no external bucket, no configured secrets. How assets reach users is a private channel outside this repo; installation is intentionally not documented.
- `scripts/preflight-dist.mjs`, wired as `prepack`: aborts the pack if the LICENSE is not proprietary, `THIRD-PARTY-NOTICES.md` is missing its gitleaks attribution, the package is not marked private, or `sidecar/bin/` does not hold exactly one platform whose binary's real CPU architecture matches its directory name. A JS-only or mislabeled tarball cannot be built. Also serves as the `prepublishOnly --forbid-publish` hook, because npm does not enforce `"private": true` under `--dry-run`.
- `scripts/bundle-sidecar.mjs` and `scripts/pack-dist.mjs` (`npm run dist`) build the per-platform tarballs; `src/sessions/native-executable.js` reads executable format and CPU architecture out of Mach-O/ELF headers, since magic bytes alone cannot tell arm64 from x86_64.
- `CONTRIBUTING.md` rewritten: proprietary, single-maintainer, no unsolicited contributions, written copyright assignment required before any contribution, and a rule against vendoring copyleft code.
- `THIRD-PARTY-NOTICES.md` retaining the upstream MIT copyright and permission notice for the gitleaks ruleset vendored as `data/secret-rules.json`, and shipped in the npm `files` whitelist. MIT permits redistribution inside a proprietary work, but requires the notice travel with it.
- Cursor metric parity with other sources: estimated token usage and cost (factory-style chars/4 estimation, since Cursor JSONL carries no usage fields), error counts from `turn_ended` status `error` rows, files-touched tracking via Cursor's `path` tool input, sessionId from the transcript UUID, and assistant thinking blocks — in the JS parser/indexer/peek and the Rust sidecar identically.
- Cursor sessions now report their real model name (e.g. `composer-2.5`), read from Cursor's `state.vscdb` (`composerData:<uuid>` → `modelConfig.modelName`), instead of the placeholder `cursor`. Resolved identically by `parseCursor`, `indexCursorJsonl`, `peekCursor`, and the Rust sidecar's `index_cursor`; all four fall back to `cursor` when the DB or row is absent. `TRACEQUEST_CURSOR_STATE_DB` overrides the DB location.
- `tracequest messages --full` (alias `--no-truncate`) exports verbatim content; otherwise truncated content now carries a visible `… [truncated N chars]` marker instead of being silently elided.
- Cursor tool-name normalization: `StrReplace` → Edit (with old/new diff rendering) and `AskQuestion` → Ask; `Write` previews honor Cursor's `contents` input key.
- Cursor session headers now show cwd (majority Shell `working_directory`), git branch (first `SetActiveBranch`), and `~started`/`~duration` estimated from file birthtime/mtime (`timesEstimated` flag, `~` marker convention); `--sort duration` ranks Cursor sessions, with identical durationMs in the JS and Rust indexers.
- Cursor `CallMcpTool` calls render as MCP operations (server/tool summary + MCP section) instead of raw JSON dumps; `SemanticSearch`, `Delete`, `Await`, and `Ask` get input summaries and tool colors; `Delete` paths count as touched files in chapters.
- Cursor parent sessions attach `agentHistory` from `agent-transcripts/<uuid>/subagents/*.jsonl` sidecars (parents only, mtime-ordered, null-timestamp records handled).
- `tracequest messages` exports are API-replay-valid for Cursor: unpaired tool_use blocks get `"(no output recorded)"` stub results (Anthropic and OpenAI formats); session-level errors export as plain text, never as null-id tool_results.
- `TRACEQUEST_OPEN_CMD` env var overrides the browser launcher used by `render --open` and `share --open`.

### Fixed
- Sessions with no event timestamps (Cursor) report `startTime`/`endTime` as null instead of the 1970-01-01 epoch; rendered headers show a dash.
- Multi-source test fixtures now use the real Cursor JSONL shape and `agent-transcripts/<uuid>/` layout, repairing six-source search/discovery coverage.
- A Cursor session with any `turn_ended` error no longer renders every tool call as failed (null tool-id collision): the error shows once as a session-level error block, the waveform no longer paints all turns red, and markdown export lists it as `**session:**` without bogus per-command `[FAIL]` markers.
- Compare view no longer awards green "winner" deltas to missing Cursor metrics (zero tokens/duration/cost render as no-data dashes) and marks estimated values with `~`; the stats bar shows `—` instead of `~0` input tokens; share metadata carries `tokensEstimated`/`timesEstimated`.
- Waveform for timestamp-less sessions: chapter dividers and turn-click navigation work via event-ordinal mapping (provably equivalent for timestamped sources), tooltips omit the bogus epoch time, and unknown cache data draws at neutral brightness.
- The test suite no longer opens a real browser on macOS (`share --open` test stubbed `xdg-open` but darwin uses `open`); tests now pin `TRACEQUEST_OPEN_CMD`.

## [0.1.2] - 2026-07-05

### Added
- Cursor sessions are now a first-class Source, discovered from `~/.cursor/projects/` and parsed/indexed with Claude-family JSONL semantics while preserving `source=cursor`.
- Cursor support spans CLI/session discovery, search, peek metadata, rendered/browser/compare source badges, Rust sidecar scan/index, README/docs, and six-source integration coverage.
- Facts-driven release preparation audit: 7 new @spec facts for release artifacts (LICENSE, README, CHANGELOG, package metadata, CI workflows, test suite, CLI --version) + verification/closure of 2 pre-existing @spec facts (total 13 facts @implemented).
- Core unit tests (parse/render/sessions) + `npm test` script; GitHub Actions CI (facts check + CLI + tests on push/PR).
- Clean packaging: "files" whitelist in package.json + `npm pkg fix` for minimal publish (9 files, no warnings).
- CI status badge added to README.md top.
- v0.1.0 annotated tag cut after full pre-release gates (tests, facts, pack, CLI --version/help).
- `tracequest handoff <query>` and `tracequest search --format handoff` for non-LLM Markdown handoff summaries with session hashes, capped privacy-conscious snippets, and concrete follow-up commands.
- Direct handoff and `tracequest search --format handoff` support `--sort recent` / `--sort date` for newest matching sessions while default output remains relevance-ordered; quoted-phrase returned rows stay exact, but older phrase matches beyond the bounded scan cap may be omitted until TraceQuest has a phrase/position-aware index.
- `tracequest standup` for local prompt-agent standups using compact bounded Markdown input instead of raw JSONL, full transcripts, absolute session paths, or full tool outputs.
- Standup controls for `--print-input`, `--profile`, `--since`, `--today`, `--yesterday`, `--workday`, `--previous-workday`, `--agent-command`, repeated `--agent-arg`, repeated `--param`, `--agent-timeout-ms`, and `TRACEQUEST_STANDUP_AGENT_*` defaults.
- Standup audit and validation tooling: `--dry-run-agent-detection`, `--probe-agents`, `npm run probe:standup-agents`, `npm run smoke:standup-handoff`, `npm run smoke:standup-handoff-examples`, `npm run verify:standup-handoff`, and `npm run release:standup-handoff`.

### Changed
- CI workflow enhanced post-tag with `npm test` step (stronger gate while preserving original spec).
- CI now runs `npm run verify:standup-handoff` as a noninteractive standup/handoff release gate without running installed-agent probes.
- Post-v0.1.0: hygiene to ensure pristine tree for release.
- Built-in standup prompt-agent detection is conservative: Codex (`codex exec -`), Claude (`claude --print`), and Droid (`droid exec`) are detected in that order; OpenCode remains explicit configuration only until a synthetic sentinel probe passes locally.

### Fixed
- Reverted stray post-tag src/server.js edit (ensured exact verified v0.1.0 commit tree for tag).
- Standup probe, timeout, missing-agent, and stdin pipe failures now return bounded diagnostics without sending private trace content or crashing on early agent stdin close.

## [0.1.1] - 2026-06-26

### Added
- `tracequest find` now accepts positional filter expressions in addition to `--filter`; when both are supplied they are combined with AND.
- Stable 8-character session hashes are used for CLI/API/browser session handles, viewer links, compare links, markdown headers, and share filenames.

### Changed
- Help and integration docs now show `find [expr] [--filter <expr>]` and the positional plus flag filter combination behavior.
- Browser, route, render, markdown, and share flows prefer session hashes over raw session id prefixes for user-facing handles.

### Fixed
- Updated hash-based route, compare, export, share, and browser tests to match the current public session handle contract.

## [0.1.0] - 2026-05-20

### Added
- Initial public release of TraceQuest: zero-dependency Node.js CLI (`tracequest`) that discovers, parses, and visualizes agent session logs as self-contained interactive HTML reports and a live browsable gallery.
- Core domain model: Sessions (with metadata), Events, Chapters (user-prompt bounded), Sources (claude, codex, factory, grok, opencode), and Waveform canvas visualizations.
- CLI interface supporting four primary modes:
  - Render specific session file (default)
  - `--latest [project]` for newest session
  - `--list [project]` to enumerate available sessions
  - `--serve [port]` (default 7777) for the full web UI with search, filtering, and detail views
- Convenience flags: `--open` (launch browser), `--out <file>`.
- Features in rendered views and browser: retina-ready Waveform charts (token flow, tool colors, cache), collapsible chapters with outcome badges (clean/error/corrected), tool usage chips/sparkers, file operations, stats, grades, project grouping, pagination, lazy rendering, dependency chains, MCP tool integration, live-reload during dev.
- Automatic Source detection from standard paths (e.g. `~/.claude/projects/`, `~/.codex/sessions/`, `opencode://` virtual, etc.) and unified parsing/normalization.
- Release artifacts: comprehensive README.md (install, full usage, Sources list), MIT LICENSE (2026), and this CHANGELOG.md.
- npm package at version 0.1.0 with `tracequest` bin.

### Changed
- N/A (initial release)

### Fixed
- Multiple parsing, rendering, scoring, layout, and detection fixes across development iterations (see commit history for details: MCP display, cache versioning, pagination, grade recalibration, cost fixes, filter bar, etc.).

### Removed
- N/A (initial release)

See the git history and README for full details on usage and supported Sources.
