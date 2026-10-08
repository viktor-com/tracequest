# Launch Integration Tests

End-to-end integration for the launch feature (facts `lamx`, `labt`, `laag`, `laae`, `larc`, `larl`, `lasn`, `laah`, `lakl`, `lain`, `lapm`, `laho`, `laal`, `lans`, `latg`, `lath` in `launch.facts`, plus the run↔session facts in `chat-live.facts`): `tracequest serve` ensures the tracequest tmux session at boot, `/api/agents` reports multiplexer status plus detected agent CLIs, and the run lifecycle — create, list, run-session linking, snapshot, kill, input — is exercised over HTTP against real tmux windows. A **Run** is a tracequest-initiated agent execution living in a tmux window of the tracequest session; all run state lives in tmux (including the `@tq_session` run↔session link), so runs survive serve restarts.

Automated harness: `test/bin/tracequest-launch-integration.test.js` (35 scenarios). Run via `npm run test:integration` or:

```bash
TRACEQUEST_SKIP_LR_WATCH=1 node --test --test-concurrency=1 test/bin/tracequest-launch-integration.test.js
```

## Prerequisites

- tmux installed (any version answering `tmux -V`). Without it, every tmux-dependent scenario **skips** via `test/helpers/tmux-gate.js` (skip, never fail); `TRACEQUEST_SKIP_TMUX=1` forces the same skip. The no-tmux degradation scenario runs regardless.
- **Private tmux server per test file**: a unique `TRACEQUEST_TMUX_SOCKET` (pid-derived) plus `TRACEQUEST_TMUX_SESSION`, torn down with `tmux -L <socket> kill-server` in `after()` — the harness never creates windows in, or kills, the developer's real tmux server.
- Real `node bin/tracequest.js serve` child processes with temp `HOME`, ephemeral ports, `TRACEQUEST_NO_SIDECAR=1`, and `TRACEQUEST_SKIP_LR_WATCH=1`.
- **No real agent CLIs are ever launched**: a stub `claude` shell script on a prepended minimal `PATH` (`<stubdir>:/usr/bin:/bin:/usr/sbin:/sbin` — `/usr/sbin` so the `lsof` behind pid attribution is reachable) stands in for agent binaries, so detection sees exactly one agent no matter what is installed. The launcher spawns `claude --session-id <uuid> -- <prompt>`, so every stub parses its argv like the real CLI — `SID` from `--session-id`, the prompt from behind the end-of-options `--` (which shields dash-leading prompts). The default stub echoes its full argv, exits immediately for the `exit-fast` prompt, and prints SGR-colored output (plus a delayed second line) for the `color` prompt; an interactive echo stub (`GOT:<line>` per stdin line) serves the input scenarios. tmux is pinned by absolute path via `TRACEQUEST_TMUX_BIN`.
- Run windows are killed between scenarios; temp HOMEs and serve children are torn down in `afterEach`.

---

## Serve boot mux

### Test 1: serve ensures the tmux session at boot

**Steps:**
1. Boot serve with an isolated socket/session; wait for `/api/agents`; boot a second serve on the same socket/session.

**Expectations:**
1. `/api/agents` answers `mux.available: true`, `mux.session` = the configured session, and an `agents` array.
2. `tmux has-session` exits 0 (the session was created detached) and serve's stdout names the tmux session.
3. The second serve reuses the session untouched: no second session, identical window list.

---

### Test 2: serve boots without tmux and reports mux unavailable

**Steps:**
1. Boot serve with `TRACEQUEST_TMUX_BIN` pointing at a nonexistent binary.

**Expectations:**
1. `/api/agents` still answers 200 with `mux.available: false`, the configured session name, and an agents array.
2. Pre-existing routes (`/api/sessions`) serve unchanged; no mux boot line is printed.

---

## Create + list runs

### Test 3: POST /api/runs starts a run in a tmux window

**Steps:**
1. POST `/api/runs` with `{agent: "claude", cwd, prompt: "hello"}` against a stub-agent serve.

**Expectations:**
1. 200 with `{id}` where the id IS the tmux window id (`@<digits>`).
2. `tmux list-windows` shows the window with `@tq_agent`/`@tq_cwd` user options, an ISO `@tq_started`, and `remain-on-exit` on.
3. `capture-pane` shows the stub's argv echo including the prompt — the prompt travelled as a discrete argv element.

---

### Test 4: GET /api/runs lists runs with live status

**Steps:**
1. Start a long-lived run and a fast-exiting run; open one tmux window by hand in the same session.

**Expectations:**
1. `/api/runs` lists both runs with `{id, agent, cwd, startedAt, status}`; the long-lived run is `running`.
2. The hand-opened window is NOT a run (exactly 2 runs listed).
3. The fast-exiting run flips to `exited` while staying listed (remain-on-exit).

---

### Test 5: runs survive a serve restart

**Steps:**
1. Start a run; SIGKILL the serve process; boot a fresh serve on a new port with the same socket/session.

**Expectations:**
1. The fresh serve lists the same run with the same id, agent, cwd, and `running` status — run state lives in tmux, not in serve.

---

### Test 6: unknown agents are rejected with 400

**Steps:**
1. POST `/api/runs` with `agent: "not-an-agent"` and with `agent: "codex"` (registry entry NOT on the stub PATH).

**Expectations:**
1. Both answer 400 naming the agent problem; no tmux window is created for a rejected agent.

---

### Test 7: missing cwd is rejected with 400

**Steps:**
1. POST `/api/runs` with a `cwd` path that does not exist.

**Expectations:**
1. 400 naming `cwd`; no tmux window is created.

---

## Snapshot + kill

### Test 8: snapshot returns the captured screen as html

**Steps:**
1. Start the `color` stub run; poll `GET /api/runs/snapshot?id=`.

**Expectations:**
1. 200 `{status: "running", html}` where the SGR-red marker became `<span class="ansi-fg-1">…</span>`.
2. Terminal text is HTML-escaped (`&lt;plain&gt;`, `&amp;`); no raw escape byte survives in the html.
3. The stub's delayed second line appears in a later snapshot of the same run — fresh capture every poll, no route cache.

---

### Test 9: snapshot of an exited run reports exited with the final output

**Steps:**
1. Start the `exit-fast` stub run; poll the snapshot until `status: "exited"`.

**Expectations:**
1. The exited snapshot still contains the stub's final output — remain-on-exit keeps the screen viewable.

---

### Test 10: snapshot rejects malformed and unknown ids

**Steps:**
1. Request snapshots for `bogus`, `5`, `@x`, and the empty id, then for the well-formed but unknown `@99999`.

**Expectations:**
1. Malformed ids answer 400; the unknown id answers 404 naming it — never an empty screen.

---

### Test 11: kill removes the run window

**Steps:**
1. Start a long-lived run; POST `/api/runs/kill {id}`; repeat the kill; then kill an exited (remain-on-exit) run.

**Expectations:**
1. Kill answers 200 `{ok: true}`; the window is gone from `tmux list-windows`, the run vanishes from `/api/runs`, and its snapshot answers 404.
2. Killing an already-killed run answers 404.
3. An exited run is dismissed the same way: 200, window gone.

---

### Test 12: runs list and snapshot survive a C-locale serve environment (no LANG/LC_*)

**Steps:**
1. Boot serve with every `LANG`/`LC_*` variable scrubbed (launchd/cron regression: C-locale tmux clients mangle control bytes in `list-windows` output); start a run.

**Expectations:**
1. `/api/runs` still lists the run with intact agent, cwd, ISO `startedAt`, and `running` status.
2. The snapshot html contains the stub output.

---

## Run session (live unified representation)

These scenarios use the **session-writing stub agent**, modeling the REAL claude CLI's recording behavior: it honors the spawn-assigned `--session-id` by naming its recording `<uuid>.jsonl`, and it NEVER holds the recording open — every write is open/append/close, so `lsof` finds zero holders between writes. It records claude-format JSONL under `<home>/.claude/projects/<slug-of-cwd>/` while it runs (the serve HOME is baked into the script because the persistent tmux server keeps the first scenario's env; the slug comes from the pane's `$PWD` — exactly the literal-vs-realpath cwd mismatch the link resolver must absorb). Prompt branches: `chat-live` (2 events, +2 after ~1s, stays running), `chat-exit` (2 events, exits), `no-session` (never writes a recording), `user-race*` (sleeps ~2s before writing, stays running).

### Test 13: run session serves the growing unified session for a linked run

**Steps:**
1. Start a `chat-live` run; poll `GET /api/runs/session?id=` until linked; keep polling as the stub appends; then repeat the request with the current `etag`; finally list `/api/runs`.

**Expectations:**
1. The run links within the poll interval: `link: "linked"`, `state: "running"`, `sessionPath` = the agent's own recording under the serve HOME's `.claude/projects/`.
2. The body is tracequest's unified representation: `session.source "claude"`, events (first user prompt text intact), stats, and chapters, plus an `mtimeMs-size` etag; the recording is NAMED by the persisted `@tq_session_id` uuid and `attribution` is `"sid"` — spawn identity, no fd evidence involved.
3. Appended events appear in a later poll (eventCount 2 → 4, a second chapter, a moved etag) — the "messages appear live" behavior.
4. Repeating the current etag answers `{unchanged: true}` with no session body.
5. `GET /api/runs` carries the same `sessionPath`/`link`/`state` for the run.

---

### Test 14: run session link survives a serve restart

**Steps:**
1. Start a `chat-live` run; wait until linked; SIGKILL serve; boot a fresh serve on a new port with the same socket/session/HOME; request the run session once.

**Expectations:**
1. The fresh serve answers `linked` with the SAME `sessionPath` — the link is persisted in the window's `@tq_session` user option, so tmux remains the only run table.
2. The unified session is served after the restart.

---

### Test 15: run session of an exited run stays served with state exited

**Steps:**
1. Start a `chat-exit` run; poll until `run.status: "exited"` and `link: "linked"`.

**Expectations:**
1. `state: "exited"` while the final conversation (all recorded events) stays served.

---

### Test 16: two NON-HOLDING runs in one cwd (<2s stagger): both link their own transcript via spawn identity

Round-2 regression (the round-1 mislink scenario, sharpened to real-claude behavior). Uses the **racing stub agent**: it names its recording by the spawn-assigned `--session-id` uuid, writes it open/append/close, and NEVER holds an fd on it — fd-based identity can never fire; `race-slow-*` prompts sleep 4s before writing (the trust-prompt/MCP-handshake/hung-start trigger). The 0.7s stagger is inside the 2s birth-gate slack, the exact configuration that used to deadlock both runs pending-forever.

**Steps:**
1. Start run A (`race-slow-a`), then ~0.7s later run B (`race-fast-b`) in the SAME cwd; read both runs' `@tq_session_id` uuids; poll `GET /api/runs/session` for BOTH runs every 250ms until both link; `lsof` both recordings; finally read the persisted `@tq_session`/`@tq_session_attr` tmux options.

**Expectations:**
1. Each run mints its own uuid; at EVERY observation, a run only ever answers the recording named by ITS uuid — the invariant is asserted on each poll, not just at the end.
2. B links promptly while A is still `pending` — A never borrows B's transcript to fake progress — and both eventually link (the r2 deadlock left them pending forever).
3. Both report `attribution: "sid"`; each first event text matches its own prompt; `lsof` exits non-zero on both recordings (zero holders — the identity needed no fd evidence).
4. The persisted tmux state carries the uuid-named paths with `@tq_session_attr` `sid` for both — nothing sticky-poisons across restarts.

---

### Test 17: a user's own session in the run cwd is NEVER served — the run pends until ITS uuid recording appears

Round-2 scenario (b): the user opens their own claude chat in the run's directory right after the run starts; the run's agent (non-holding, `user-race` branch) writes only ~2s later.

**Steps:**
1. Start a `user-race` run; immediately write a user session file (non-uuid name, claude-format, born after the run's start) into the same project slug dir; poll `GET /api/runs/session` every 200ms until linked.

**Expectations:**
1. At EVERY poll the run answers `pending` or its OWN `<uuid>.jsonl` — never the user's file; the pending phase is actually observed.
2. Once the agent writes, the run links its own recording with `attribution: "sid"`; the served session never contains the user's transcript.

---

### Test 18: a poisoned pre-upgrade claim on an identified run heals across a serve restart

Round-2 scenario (b), restart flavor: a heuristic mislink to the user's session persisted in tmux (as an older tracequest would have left it) used to survive restarts and be served forever.

**Steps:**
1. Start a `no-session` run; plant a user session file plus `@tq_session` = that file with `@tq_session_attr heur` on the run window; SIGKILL serve; boot a fresh serve; request the run session once; read `@tq_session` back.

**Expectations:**
1. The fresh serve answers `pending` with null session — the poisoned claim is dropped, the user's transcript is never served.
2. `@tq_session` is CLEARED in tmux, so the poison cannot resurface.

---

### Test 19: run session rejects malformed and unknown ids and answers pending before any recording exists

**Steps:**
1. Request run sessions for `bogus`, `5`, `@x`, and the empty id, then the well-formed but unknown `@99999`; then start a `no-session` run and request its session.

**Expectations:**
1. Malformed ids answer 400; the unknown id answers 404 naming it.
2. The unlinked run answers 200 with the pending shape: `link: "pending"`, `state: "running"`, null `sessionPath`/`session`.

---

## Input to a run

### Test 20: input sends text and Enter to a run

**Steps:**
1. Start the interactive echo stub; POST `/api/runs/input {id, text: "hello-input", key: "Enter"}` — then send the literal text `Enter;-l` with `key: "Enter"`.

**Expectations:**
1. 200 `{ok: true}`; the echoed `GOT:hello-input` line appears in the snapshot — text plus key in ONE request types a line and submits it.
2. `GOT:Enter;-l` arrives VERBATIM — literal text is never parsed as a key name, a send-keys flag, or a tmux command separator.

---

### Test 21: input rejects an unknown key name

**Steps:**
1. POST `/api/runs/input {id, key: "C-d"}` (outside the allowlist).

**Expectations:**
1. 400 whose error names every allowed key (`Enter`, `C-c`, `Escape`, `Up`, `Down`, `Tab`).
2. Nothing was sent: the pane content is unchanged and the run still runs.

---

### Test 22: input C-c interrupts a running run to exited

**Steps:**
1. POST `/api/runs/input {id, key: "C-c"}` to the echo stub; then POST input again after it exits.

**Expectations:**
1. The run flips to `exited` (the stub dies on SIGINT).
2. Input to the exited run answers the documented 409 naming the exited state.

---

## Prompt validation hardening

### Test 23: oversized and control-character prompts are rejected with 400 JSON

**Steps:**
1. POST `/api/runs` with a 10KB prompt (inside the 64KB body cap but beyond what tmux respawn-window accepts), then with a prompt containing a NUL byte.

**Expectations:**
1. The 10KB prompt answers 400 JSON `{"error":"prompt too long (max 8192 bytes)"}` — never the plaintext 500 that the "command too long" tmux failure used to produce.
2. The NUL prompt answers 400 JSON naming the prompt (C0 control characters except `\n` and `\t` are rejected before any spawn).
3. No tmux window is created for either rejected prompt.

---

## Continue-resume

### Test 24: continuing an external session launches a fork run that carries the prior context

**Steps:**
1. Plant an EXTERNAL claude session (never started by tracequest) under the serve HOME, recorded in a work directory; boot serve with a stub `claude` modeling the CLI's documented fork-resume semantics (`--resume <src> --fork-session --session-id <new>` → a NEW `<new>.jsonl` beginning with the source conversation, then appending new turns; source untouched).
2. POST `/api/runs {resumeSession: <source hash>}` — no agent, no cwd.
3. Inspect tmux options, the pane's argv echo, `/api/runs/session`, and `GET /api/runs`.

**Expectations:**
1. 200 `{id, resumedFrom: <source hash>}`; `@tq_resumed_from` persisted; `@tq_session_id` is a FRESH fork uuid (never the source's); cwd defaulted to the source session's recorded cwd.
2. The agent received `--resume <srcId> --fork-session --session-id <forkUuid>`.
3. The run links the FORK recording with attribution `sid`; its transcript begins with the source conversation (context carried) and grows with the new turns; `run.resumedFrom` and the runs-list row expose the provenance.

---

### Test 25: resume guards — unknown session 404, agent without a resume mechanism 400

**Steps:**
1. POST `/api/runs {resumeSession: "0123abcd"}` (no such session), then `{resumeSession: <valid hash>, agent: "gemini"}`.

**Expectations:**
1. The unknown hash answers 404 JSON naming the hash; the mechanism-less agent answers 400 JSON naming the missing resume mechanism.
2. No tmux window is created for either rejected resume.

---

## Non-identity attribution (tombstones + prompt corroboration)

These scenarios run a `cursor-agent` stub — one of the 5 registry agents WITHOUT a `--session-id` mechanism — that names its recording itself in the **REAL Cursor CLI layout** (`~/.cursor/projects/<DASHLESS slug of cwd>/agent-transcripts/<uuid>/<uuid>.jsonl`, verified against a real machine: 917 recordings, all at that nesting, none at project-dir root), never holds an fd on it, and embeds the launch prompt as the transcript's first user message (cursor `{"role":…}` dialect). Decoy "user's own session" files are written in the same real layout. Bare launches write interactively-typed text after 6s; `slow-*` prompts write after 4s; everything else writes immediately; the crash stub writes nothing at all.

### Test 26: kill-laundering (r3): dismissing the fast rival NEVER hands its transcript to the slow survivor — before or after a serve restart

**Steps:**
1. Create run A `slow-alpha` and run B `fast-beta` in ONE cwd; wait for B's `/api/runs/session` to link.
2. Assert A is pending, then `POST /api/runs/kill` B (the documented dismissal).
3. Poll A repeatedly; wait for A's own late recording to link; SIGKILL serve and boot a fresh one on the same HOME/socket.

**Expectations:**
1. B links its OWN recording with attribution `prompt` (content corroboration) while both runs live — no contested-forever.
2. After B's dismissal A NEVER answers B's sessionPath and `fast-beta` never appears in any of A's session bodies (the tombstone keeps B's claim alive).
3. A links its own recording (attribution `prompt`, transcript has `slow-alpha`, not `fast-beta`), and a restarted serve answers the same link — tombstone and link both live in tmux.

---

### Test 27: two live prompted runs, one cwd: prompt corroboration disambiguates — each links its OWN transcript with both alive

**Steps:**
1. Create runs `slow-alpha-two` and `fast-beta-two` in one cwd; wait for BOTH `/api/runs/session` answers to link with neither run dismissed.

**Expectations:**
1. Both link attribution `prompt` to DIFFERENT paths; each transcript contains only its own prompt; `GET /api/runs` still lists 2 running runs.

---

### Test 28: BARE survivor: a dismissed prompted rival stays out of its chat across a restart; its own late recording links heuristically

**Steps:**
1. Create bare run A (no prompt) and prompted run B `fast-beta-bare`; wait for B linked; kill B; restart serve.
2. Poll A while only B's file exists; wait for A's own recording (first message `typed-interactively-by-user`) to land.

**Expectations:**
1. After the restart A never answers B's path — only the persisted tombstone (tmux session option) can be keeping B's file excluded for a bare run.
2. A links its own file with the honest attribution `heuristic` (a bare run has no content identity), transcript free of `fast-beta-bare`.

---

### Test 29: r5 regression: a promptless run DEMOTES its guess when its own recording lands beside the user's session — pending, cleared, never finalized at exit

**Steps:**
1. Create bare run A (no prompt — the stub writes its recording only after 6s); immediately write the USER's own session (`user-own-session.jsonl`, first message `USERS-PRIVATE-CHAT …`) into the same cwd's project dir.
2. Wait for A to link the sole candidate; wait for the stub's own recording to land; poll A; then `POST /api/runs/input` `C-c` to exit the run and poll again.

**Expectations:**
1. The sole-candidate phase links the user's file only as an honest `heuristic` guess.
2. The moment A's own recording exists the guess is DEMOTED: link `pending`, null sessionPath/attribution, durable across polls (two indistinguishable recordings select nothing — the pre-fix behavior kept the user's private chat forever).
3. The exited run stays `pending` at every poll — a guess that was ambiguous at death is never finalized.

### Test 30: r7 regression: a promptless run that CRASHES before writing anything never binds the user's session born in its window

**Steps:**
1. Boot serve with a `cursor-agent` stub that exits 1 immediately (writes nothing); create a BARE run (no prompt).
2. Write the USER's own cursor session (real layout) into the same cwd's candidate space, then poll `/api/runs/session` until the run is observed `exited` and for ~5s afterwards.

**Expectations:**
1. The run answers `pending` at the exit poll and at every later poll — the user's private chat is never its `sessionPath`.
2. Zero affirmative evidence (no spawn uuid, no prompt, no fd holder, nothing the run wrote) plus a lifetime too short for a bare guess to mature means "pending", honestly, forever — pre-fix the sole-eligible-at-death rule bound the stranger's recording permanently.

## Contest memory (r4: dismissal floods, tmux-direct kills, equal-prompt collisions)

These scenarios prove a run's contest memory outlives everything that used to erase it: tombstone relevance-compaction (never evicted by routine dismissal floods), the persisted run ledger (tombstones synthesized for windows killed OUTSIDE the kill API), and the equal-prompt ambiguity rule. A dedicated twin stub makes two runs with the IDENTICAL prompt behave differently (first instance writes at once, later ones after 8s); `cycle-*` prompts never write (pure create+kill fodder).

### Test 31: r4 vector 1: 32+ routine dismissals never evict the stone keeping the dismissed twin's contest honest

**Steps:**
1. Create twin B and survivor A with the IDENTICAL prompt in one cwd; wait for B's recording; dismiss B via `POST /api/runs/kill`.
2. Run 40 pure-API create+kill dismissal cycles in the same cwd; read `@tq_tombstones`; poll A repeatedly; wait for A's own late recording.

**Expectations:**
1. A is honest-pending while both live (identical prompts prove nothing) and NEVER answers B's path at any poll after the flood — pre-fix the 33rd stone evicted the twin's and A linked B's recording attr `prompt`.
2. The tombstone list stays bounded; A's own recording (born after every stone's death) links attribution `prompt`.

---

### Test 32: r4 vector 2: a window killed DIRECTLY in tmux (kill-window, no API) still leaves a tombstone — synthesized from the run ledger, across a serve restart

**Steps:**
1. Create bare survivor A and prompted fast B; wait for B linked; one extra `GET /api/runs` so the persisted ledger carries B's claim.
2. STOP serve, `tmux kill-window` B (the prefix-& path — no API, no tombstone written by the kill), boot a fresh serve; poll A; wait for A's own recording.

**Expectations:**
1. A NEVER answers B's path and B's conversation never appears in A's chat — the first poll after restart synthesizes B's tombstone from the ledger diff (`@tq_tombstones` carries B's id + claimed path).
2. A links its own recording (honest `heuristic`); B's recording sits unserved beside it.

---

### Test 33: r4 vector 3: a user session opening with the run's exact prompt is dropped (ambiguous, pending) once the run's own recording lands

**Steps:**
1. Create run A with a `slow-*` prompt (writes at 4s); immediately write a USER session in the same cwd whose first message EQUALS the prompt.
2. Wait for A's own recording to land; poll; delete the user file; poll again.

**Expectations:**
1. Once equality exists twice, A drops any claim on the user file and answers `pending` at every poll — the user's transcript is never served again (pre-fix it was kept attr `prompt` forever).
2. With the collision gone, A links its OWN recording attribution `prompt`, transcript free of the user's conversation.

---

## Execution Results

| Test | Description | Result | Evidence |
|------|-------------|--------|----------|
| 1 | serve ensures the tmux session at boot | **PASS** | mux.available true; has-session exit 0; stdout names session; reboot reuses session untouched |
| 2 | serve boots without tmux, mux unavailable | **PASS** | 200 with mux.available false; /api/sessions unchanged; no mux boot line |
| 3 | POST /api/runs starts a tmux-window run | **PASS** | id `@N`; @tq_* options + remain-on-exit on; prompt echoed in capture-pane |
| 4 | GET /api/runs lists runs with live status | **PASS** | running + exited statuses; hand-opened window excluded (2 runs) |
| 5 | runs survive a serve restart | **PASS** | SIGKILL'd serve; fresh process lists same id/agent/cwd, status running |
| 6 | unknown agents rejected with 400 | **PASS** | not-an-agent + undetected codex both 400; window list unchanged |
| 7 | missing cwd rejected with 400 | **PASS** | 400 naming cwd; window list unchanged |
| 8 | snapshot returns captured screen as html | **PASS** | ansi-fg-1 span; &lt;/&amp; escaping; no raw ESC; late SECOND-LINE in later poll |
| 9 | exited snapshot keeps the final output | **PASS** | status exited with stub output still in html |
| 10 | snapshot rejects malformed/unknown ids | **PASS** | bogus/5/@x/"" all 400; @99999 404 naming the id |
| 11 | kill removes the run window | **PASS** | 200 {ok:true}; window gone; re-kill 404; exited run dismissed too |
| 12 | C-locale serve regression | **PASS** | LANG/LC_* scrubbed; run listed intact; snapshot html present |
| 13 | run session serves the growing unified session | **PASS** | linked live as attribution sid; uuid-named recording; events/stats/chapters served; 2→4 events in later poll; etag moves; unchanged answer; /api/runs carries link |
| 14 | run session link survives a serve restart | **PASS** | SIGKILL'd serve; fresh process answers linked with the same @tq_session path |
| 15 | exited run session stays served | **PASS** | state exited with the full final conversation |
| 16 | two NON-HOLDING runs one cwd: spawn identity (r2 deadlock regression) | **PASS** | no poll ever cross-attributes; B links sid while A pending; A links own uuid file after slow write; lsof exit 1 on both recordings; both @tq_session_attr sid |
| 17 | user's own session never served (r2 user-steal regression) | **PASS** | pending observed while only the user's file exists; links own uuid file as sid; user transcript never in any answer |
| 18 | poisoned pre-upgrade claim heals across restart | **PASS** | fresh serve answers pending, not the user's file; @tq_session cleared in tmux |
| 19 | run session id validation + pending shape | **PASS** | malformed 400; @99999 404; no-session run answers pending with null session |
| 20 | input sends text and Enter | **PASS** | GOT:hello-input echoed; `Enter;-l` arrives verbatim |
| 21 | unknown key name rejected | **PASS** | 400 naming full allowlist; pane unchanged; run still running |
| 22 | C-c interrupts to exited | **PASS** | exited after C-c; late input answers 409 naming exited |
| 23 | oversized/NUL prompts rejected with 400 JSON | **PASS** | 10KB prompt 400 `prompt too long (max 8192 bytes)`; NUL prompt 400 JSON; window list unchanged |
| 24 | continue an external session as a fork run | **PASS** | 200 {id, resumedFrom}; @tq_resumed_from + fresh @tq_session_id; fork-resume argv in pane; linked sid to the fork with prior context + new turns; provenance in list + session answers |
| 25 | resume guards: unknown 404, no-mechanism 400 | **PASS** | 404 JSON for unknown hash; 400 naming gemini's missing resume mechanism; window list unchanged |
| 26 | kill-launder (r3): dismissed rival's transcript never inherited, restart included | **PASS** | B linked attribution prompt while contested; post-kill A pending at every poll (fast-beta never served); A links own file as prompt; identical answer from restarted serve |
| 27 | two live prompted runs disambiguate in one cwd | **PASS** | both linked attribution prompt to different paths with both RUNNING; each transcript only its own prompt |
| 28 | bare survivor protected by persisted tombstone across restart | **PASS** | post-restart polls never answer B's path; A links own file as honest heuristic; typed-interactively transcript, no fast-beta-bare |
| 29 | r4 dismissal flood: twin's stone never evicted | **PASS** | 40 create+kill cycles after the twin's dismissal; tombstones stay ≤64; A pending at every poll, never B's path; A's late recording links attr prompt |
| 30 | r4 tmux-direct kill: tombstone synthesized from the ledger | **PASS** | kill-window while serve DOWN; post-restart polls never answer B's path; B's stone carries id+claim; A links own file heuristic; B's file unserved beside it |
| 31 | r4 equal-prompt collision: ambiguous → pending, never kept | **PASS** | user file transiently linkable at most; once own recording lands A answers pending, user path never again; after user file removed A links own attr prompt |

**Summary:** 31/31 PASS.
