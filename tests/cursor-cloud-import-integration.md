# Cursor Cloud Import Integration Tests

End-to-end integration for the explicit `tracequest import cursor-cloud` command (facts `ccim`, `cckey`, `ccdry`, `ccsm`, `ccis`, `cca2`, `ccah`, `ccax`, `ccpg`, `cccv`, `ccdf`, `ccep`, `ccau`, `cc44`, `ccvb`, `ccak`, `ccse`, `ccxp`, `ccly`, `ccml`, `ccmr`, `cctx`, `cctb`, `ccdm`, `ccid`, `ccme`, `ccin`, `ccfu`, `ccpr`, `ccit` in `cursor-cloud.facts`). The importer materialises cloud agents as JSONL under the tracequest-owned cursor-cloud discovery root, where normal discovery/indexing/search finds them as the `cursor-cloud` source.

Two disjoint transports. The **default keyless route** needs no API key: the importer reads this machine's Cursor session token from `state.vscdb` (`ItemTable` key `cursorAuth/accessToken`) and POSTs connect-rpc JSON to `https://api2.cursor.sh/aiserver.v1.BackgroundComposerService/{ListBackgroundComposers,GetBackgroundComposerConversation}`, yielding full-fidelity transcripts with thinking text and tool calls. An **explicit dashboard key** (`--api-key` or `CURSOR_API_KEY`) selects the documented **v0 route** (`GET /v0/agents`, `GET /v0/agents/{id}/conversation`) instead — text-only, kept as the documented fallback. The two credentials belong to separate auth systems and are never merged or cross-retried.

Automated harness: `test/bin/tracequest-cursor-cloud-import-integration.test.js` (33 scenarios). Run via `npm run test:integration` or:

```bash
TRACEQUEST_SKIP_LR_WATCH=1 node --test --test-concurrency=1 test/bin/tracequest-cursor-cloud-import-integration.test.js
```

## Prerequisites

- Node.js (same major as CI) with `node:sqlite` support (state.vscdb fixtures).
- Run from repository root; harness sets `TRACEQUEST_NO_SIDECAR=1` and `TRACEQUEST_SKIP_LR_WATCH=1`.
- **No real network I/O ever**: two local `node:http` fixture servers, one per route — the api2 connect-rpc fixture behind `TRACEQUEST_CURSOR_API2_URL` and the v0 fixture behind `TRACEQUEST_CURSOR_API_URL` — so one test process can prove which route a run actually took (precedent: sharing-integration mock upload servers).
- **Never the developer's own credential**: `TRACEQUEST_CURSOR_STATE_DB` points at a tiny synthetic `state.vscdb` holding a FAKE `cursorAuth/accessToken`, or at an absent file when the scenario needs "no local token derivable".
- Recorded api2 payload shapes live in `test/helpers/cursor-cloud-api2-fixtures.js`: structure, field names, enum values, `toolName` strings and tool argument key names are verbatim as recorded read-only from api2; every private value is replaced with an obvious placeholder.
- Isolation: temp `HOME` and `TRACEQUEST_CURSOR_CLOUD_DIR` (temp cursor-cloud root).
- Tear down temp dirs and fixture servers after each test.

---

## Test 1: import with an unknown source dies

**Steps:**
1. Run `tracequest import` (no positional) and `tracequest import nope`.

**Expectations:**
1. Both exit `1` via `die()`.
2. stderr names the supported import sources including `cursor-cloud`; the unknown case prints `Unknown import source: nope`.

---

## Test 2: import help lists usage and options

**Steps:**
1. Run `tracequest import --help`.

**Expectations:**
1. Exit `0`; stdout is the built-in help.
2. Help lists the `import <source>` command row, the `import Options:` block with `--dry-run`, `--full`, and `--api-key <key>`, the `CURSOR_API_KEY` env alternative, and a `tracequest import cursor-cloud` example.
3. The key reads as **optional** — the help says so explicitly, because the default route needs no key at all.

---

## Test 3: import cursor-cloud imports keylessly with the local session token

**Steps:**
1. Start both fixture servers; seed a synthetic `state.vscdb` with a fake `cursorAuth/accessToken`; run `tracequest import cursor-cloud` with no key anywhere.

**Expectations:**
1. Exit `0`, `1 imported, 0 updated, 0 skipped, 0 failed`, file under `<root>/<org-repo slug>/<bcId>.jsonl`.
2. Exactly one `ListBackgroundComposers` POST with body `{"n":100,"includeArchived":true,"includeStatus":true}` and one `GetBackgroundComposerConversation` POST with body `{"bcId":…}`.
3. Every api2 request carries exactly `Content-Type: application/json` and `authorization: Bearer <token>` — no cookie, no `Origin`, no `Connect-Protocol-Version`.
4. The v0 fixture records **zero** requests.

---

## Test 4: import cursor-cloud dedupes the inclusive list pagination boundary by bcId

**Steps:**
1. api2 fixture serves page 1 `[A, B]` with `hasMore` + `nextPageOffset`, then page 2 `[B, C]` with both fields absent.

**Expectations:**
1. Two list POSTs; the second body carries `lastMessageActivityAtMsOffset` taken from the previous `nextPageOffset`.
2. The repeated boundary composer is imported once: `3 imported`, one conversation POST per distinct bcId, three files on disk.
3. The absent `hasMore`/`nextPageOffset` ends the walk.

---

## Test 5: import cursor-cloud maps MESSAGE_TYPE_HUMAN and MESSAGE_TYPE_AI to cursor user and assistant rows

**Steps:**
1. Import a conversation with a HUMAN bubble, an AI bubble carrying both text and thinking, a thinking-only AI bubble, a `MESSAGE_TYPE_SYSTEM` bubble, an unknown-type bubble, and an empty AI bubble.

**Expectations:**
1. `session_meta` + exactly three retained rows: SYSTEM, unknown type, and the empty bubble are dropped.
2. Every row's serialized line starts with `{"role":"user"` or `{"role":"assistant"` (role is the FIRST key) and carries a `message` object plus the source `bubbleId`.
3. Text and thinking merge into ONE `text` block, message text first and thinking after a blank line.
4. No `{"role":"tool"}` row is ever written.

---

## Test 6: import cursor-cloud tool results become tool_use rows that produce tools and toolCounts

**Steps:**
1. Import the recorded conversation carrying one `toolResults` entry per recorded `toolName` (`run_terminal_cmd`, `grep`, `task_v2`, `read_file`, `mcp`, `get_mcp_tools`, `glob_file_search`, `search_replace`).

**Expectations:**
1. Each becomes a `tool_use` content block serialized with `"type"` immediately followed by `"name"` and then `input`, aliased into the local Cursor CLI vocabulary (`Shell`, `Grep`, `Task`, `Read`, `CallMcpTool`, `GetMcpTools`, `Glob`, `StrReplace`).
2. File-touching tools emit `input.path`; `run_terminal_cmd` emits `input.command`.
3. Indexing the written file yields non-empty `tools`, `toolCounts` (`Bash`, `Read`, `Grep`, `Edit`), one touched file, and one counted git commit.

---

## Test 7: import cursor-cloud writes session_meta from the keyless list response

**Steps:**
1. Import one composer whose `repoUrl` carries no scheme (`github.com/org/repo`).

**Expectations:**
1. `createdAt`/`updatedAt` are ISO-8601 conversions of `createdAtMs`/`updatedAtMs`; `status` is the string enum verbatim; `model` is `modelDetails.modelName`; `repository`, `branchName`, `prUrl` come straight from the list entry.
2. The bare-scheme `repoUrl` still slugs to `org-repo` — no state.vscdb enrichment is consulted on this route.

---

## Test 8: import cursor-cloud prefers the v0 route when --api-key is given

**Steps:**
1. Both fixtures serve a distinct agent and a usable local token exists; run once with `--api-key`, then once with only `CURSOR_API_KEY` set.

**Expectations:**
1. Only the v0 agent lands on disk; the api2 fixture records **zero** requests in both runs.
2. Every v0 request carries `Authorization: Bearer <dashboard key>` — the session token is never presented to v0 and the dashboard key is never presented to api2.

---

## Test 9: import cursor-cloud dies with an actionable message when no credential can be found

**Steps:**
1. Point `TRACEQUEST_CURSOR_STATE_DB` at a missing file with no key anywhere; run the import.

**Expectations:**
1. Exit `1`; stderr names the state.vscdb path it looked at, the `cursorAuth/accessToken` key, and both `--api-key` and `CURSOR_API_KEY`.
2. Dies before any network request; the cursor-cloud root is never created.

---

## Test 10: import cursor-cloud dies with a re-authenticate message when the local credential is rejected

**Steps:**
1. api2 fixture answers every request `401 {"code":"unauthenticated","message":"ERROR_NOT_LOGGED_IN"}`.

**Expectations:**
1. Exit `1` on the first 401 — fatal for the whole run, not a per-agent skip; stderr names `401`, tells the user to sign in again, and offers `--api-key`/`CURSOR_API_KEY`.
2. Exactly one request is made: no token refresh attempt and no cross-retry against the v0 route.
3. The credential never appears in the message.

---

## Test 11: import cursor-cloud skips a keyless conversation that 404s with a warning

**Steps:**
1. api2 fixture answers one bcId with `404 {"code":"not_found"}` and serves the other normally.

**Expectations:**
1. Exit `0` — the 404 never affects the exit code.
2. stderr warns naming the agent id and the 404; the summary counts it under skipped; the live agent still imports and no file exists for the missing one.

---

## Test 12: import cursor-cloud never prints the credential in dry-run or error output

**Steps:**
1. Run `--dry-run` and then a real run against a fixture where one agent's conversation fails with `500`.

**Expectations:**
1. Neither stdout nor stderr contains the session token or any 12-character prefix of it — not truncated, not masked.
2. The per-agent failure message is printed without any credential.
3. The imported session file contains no fragment of the credential.

---

## Test 13: import cursor-cloud keyless re-run skips unchanged sessions and preserves mtime

**Steps:**
1. Import once, record mtime, re-run against identical remote state, then change the composer's `updatedAtMs` and run again.

**Expectations:**
1. Second run exits `0`, prints `skip <id>` and `0 imported, 0 updated, 1 skipped, 0 failed`, and the file mtime is byte-identical.
2. Third run reports `1 updated` and the mtime changes — a changed remote millisecond value is what triggers a rewrite.

---

## Test 14: import cursor-cloud issues no conversation request for an unchanged agent

**Steps:**
1. Import one agent over the keyless route, then re-run the same import with the same list response.

**Expectations:**
1. The fixture server's request log holds exactly ONE `GetBackgroundComposerConversation` POST across both runs — the second run resolves the agent from the `ListBackgroundComposers` response alone (fact `ccin`).
2. Two `ListBackgroundComposers` POSTs: the list request still happens on every run.
3. Second run prints `skip <id> (unchanged)` and the summary `1 checked, 0 fetched, 0 imported, 0 updated, 1 skipped, 0 failed`.
4. The session file's mtime is byte-identical to the first run's — no fetch also means no write (facts `ccin`, `ccid`).

---

## Test 15: import cursor-cloud refetches an agent whose remote updatedAtMs changed

**Steps:**
1. Import one agent; re-run after bumping only `updatedAtMs` in the list response.
2. Re-run again after advancing `updatedAtMs` by exactly one millisecond.
3. Re-run with `updatedAtMs` absent from the list entry, then with `updatedAtMs` of `0`.

**Expectations:**
1. A second `GetBackgroundComposerConversation` POST is issued, carrying `{"bcId": "<id>"}`.
2. Summary is `1 checked, 1 fetched, 0 imported, 1 updated, 0 skipped, 0 failed` and the file mtime changed.
3. The one-millisecond delta refetches too: the comparison is on the full-millisecond ISO-8601 form, so no rounding can hide a changed transcript (fact `ccin`).
4. An absent or zero remote `updatedAtMs` leaves nothing to compare and also refetches, rather than being read as "unchanged".

---

## Test 16: import cursor-cloud fetches an agent that has no local file

**Steps:**
1. Import one agent; re-run with a second, previously unseen agent added to the list response.

**Expectations:**
1. Exactly one new conversation POST, for the NEW bcId only.
2. Summary is `2 checked, 1 fetched, 1 imported, 0 updated, 1 skipped, 0 failed` and the new agent's JSONL exists.

---

## Test 17: import cursor-cloud refetches when the local file is corrupt or has no session_meta

**Steps:**
1. Import one agent; overwrite its file with an unparseable first line and re-run.
2. Overwrite the file with a valid JSON line that is not `session_meta` and re-run again.
3. Truncate the file to zero bytes and re-run.
4. Restore a well-formed `session_meta` whose `updatedAt` is an empty string, then `null`, then missing entirely, re-running after each.

**Expectations:**
1. Every re-run issues a conversation request — correctness beats speed, so unreadable local state never suppresses a fetch (fact `ccin`).
2. The first two re-runs rewrite the file (`1 checked, 1 fetched, 1 imported, 0 updated, 0 skipped, 0 failed`) and its first line is a `session_meta` row again.
3. An empty file and a `session_meta` with an unusable `updatedAt` (empty, `null`, or absent) each force a fetch as well: a skip is only ever taken on two non-empty ISO-8601 strings that are equal.

---

## Test 18: import cursor-cloud --full refetches every agent including unchanged ones

**Steps:**
1. Import two agents; re-run with `--full`; re-run once more with `--full --dry-run`.

**Expectations:**
1. `--full` issues a conversation request for every listed agent even though nothing changed (fact `ccfu`).
2. The write-skip of fact `ccid` still applies: the per-agent line is the plain `skip <id> -> <slug>/<id>.jsonl` form, the summary is `2 checked, 2 fetched, 0 imported, 0 updated, 2 skipped, 0 failed`, and the file mtime is unchanged.
3. `--full --dry-run` composes: the same requests go out, the summary is prefixed `dry-run summary: 2 checked, 2 fetched, …`, and no file is written.

---

## Test 19: import cursor-cloud fetches conversations concurrently within the bound

**Steps:**
1. Import eight agents from a fixture that holds each conversation response open for 80 ms while tracking the maximum number of simultaneously in-flight conversation requests.

**Expectations:**
1. All eight are imported with eight conversation POSTs.
2. The observed maximum in-flight count is greater than 1 (real parallelism) and never exceeds `CURSOR_CLOUD_FETCH_CONCURRENCY` (4) — bounded, never an unbounded fan-out (fact `cccv`).
3. The plan line names the bound: `up to 4 at a time`.

---

## Test 20: import cursor-cloud summary reports checked and fetched counts alongside the write outcomes

**Steps:**
1. Import three agents, one of which 404s; then re-run the identical import.

**Expectations:**
1. Run 1 summary: `3 checked, 3 fetched, 2 imported, 0 updated, 1 skipped, 0 failed` (fact `ccsm`).
2. The plan line `checked 3 agents: 0 unchanged, 3 to fetch` is printed BEFORE the first per-agent fetch outcome, so a long run never looks hung (fact `ccpr`).
3. Run 2 issues just one conversation POST (the 404 agent has no local file) and prints `checked 3 agents: 2 unchanged, 1 to fetch` plus `3 checked, 1 fetched, 0 imported, 0 updated, 3 skipped, 0 failed`.

---

## Test 21: import cursor-cloud tolerates unknown status, source, and message type values

**Steps:**
1. Serve a composer with a future `status`, a future `source`, an unknown extra field, a non-`bc-<uuid>` id, an unknown message type, and an unaliased `toolName`.

**Expectations:**
1. Exit `0`, `1 imported`; the id is used verbatim in the conversation request body and as the `<agentId>.jsonl` filename.
2. `session_meta.status` stores the future enum verbatim; the unknown message type is dropped while the known ones are kept; the unknown extra composer field is ignored, never fatal.
3. The unaliased `toolName` passes through verbatim as the `tool_use` name.

---

## Test 22: import cursor-cloud reads a large single-response conversation without truncation

**Steps:**
1. api2 fixture returns one conversation of ~1500 messages in a single response over one megabyte.

**Expectations:**
1. Exit `0`; the written file holds `session_meta` plus every retained bubble, with the final message intact — no truncation and no size cap.
2. Exactly one conversation request: the endpoint is unpaginated, with no cursor or continuation to follow.

---

## Test 23: import cursor-cloud --dry-run prints planned actions and writes nothing

**Steps:**
1. v0 fixture serves two agents; run `tracequest import cursor-cloud --dry-run`, then a real run.

**Expectations:**
1. Dry run exits `0`, prints one planned action per agent (`import <id>`) plus the `2 imported, 0 updated, 0 skipped, 0 failed` summary.
2. Dry run performs the same requests as a real run (one list + one conversation per agent) but the cursor-cloud root is never created.
3. The subsequent real run starts from unchanged state: both agents import and land on disk.

---

## Test 24: import cursor-cloud fetches paginated agents and writes jsonl under the cursor-cloud root

**Steps:**
1. v0 fixture serves two `/v0/agents` pages joined by `nextCursor`; run a real import with an explicit key.

**Expectations:**
1. Two list GETs with `limit=100`, the second carrying the `cursor` param; pagination stops when `nextCursor` is absent.
2. Every request authenticates with `Authorization: Bearer <key>`.
3. Files land at `<root>/org-repo/<agentId>.jsonl` (slug from `source.repository`), each holding `session_meta` + one line per message with no temp-file leftovers.

---

## Test 25: import cursor-cloud falls back to the cursor-cloud project slug when repository is absent

**Steps:**
1. v0 fixture serves one agent whose `source` has no `repository`; run a real import.

**Expectations:**
1. The session lands at `<root>/cursor-cloud/<agentId>.jsonl` (literal fallback slug).

---

## Test 26: import cursor-cloud writes a session_meta first line with agent metadata

**Steps:**
1. Import one v0 agent carrying repository/ref/branchName/prUrl/url; no state.vscdb present.

**Expectations:**
1. Line 1 is `{"type":"session_meta"}` with `bcId`, `name`, `status`, verbatim API `createdAt`, `repository`, `ref`, `branchName`, `prUrl`, and `url`.
2. Absent optional fields (`updatedAt`, `model`) are omitted, not null.

---

## Test 27: import cursor-cloud maps v0 user_message and assistant_message rows to the cursor row shape

**Steps:**
1. Import one v0 agent whose conversation has one `user_message` and one `assistant_message`.

**Expectations:**
1. Lines 2 and 3 are exactly `{"role":"user"|"assistant","message":{"content":[{"type":"text","text":…}]}}` — the Cursor CLI row shape the Cursor-family indexers consume unchanged.

---

## Test 28: import cursor-cloud re-run skips unchanged sessions and preserves mtime

**Steps:**
1. Import once over the v0 route; record the file mtime; re-run against identical remote state.

**Expectations:**
1. Second run exits `0` (all-skipped idempotent re-run), prints `skip <id>` and `0 imported, 0 updated, 1 skipped, 0 failed`.
2. The file mtime is byte-identical to the first run — the write was skipped entirely, so strict mtime-equality staleness never re-indexes.

---

## Test 29: import cursor-cloud skips deleted agents with a warning

**Steps:**
1. v0 fixture serves two agents; one conversation returns `404`.

**Expectations:**
1. Exit `0` — the 404 never affects the exit code.
2. stderr warns naming the deleted agent id and the 404.
3. Summary counts the deleted agent under skipped; the live agent still imports; no file exists for the deleted agent.

---

## Test 30: import cursor-cloud uses agent ids verbatim and tolerates unknown status values

**Steps:**
1. v0 fixture serves an agent with a non-`bc-<uuid>` id and an unknown `status` string.

**Expectations:**
1. The conversation URL and the `<agentId>.jsonl` filename use the id verbatim (no validation or normalisation).
2. The unknown status string is stored verbatim in `session_meta.status`.

---

## Test 31: import cursor-cloud summary reports imported, updated, skipped, and failed counts

**Steps:**
1. v0 fixture serves four agents: two importable, one `404`, one `500`; run twice, growing one conversation between runs.

**Expectations:**
1. Run 1 prints `2 imported, 0 updated, 1 skipped, 1 failed` and exits `1` (failed > 0).
2. Run 2 prints `skip`/`update` per-agent actions and `0 imported, 1 updated, 2 skipped, 1 failed`, still exit `1`.

---

## Test 32: import cursor-cloud --api-key enriches model from state.vscdb and omits model on failure

**Steps:**
1. Build a synthetic `state.vscdb` whose `ItemTable` key `cloudAgentRepository.agents.<authUser>` holds the agent's `modelDetails.modelName` and epoch-ms `updatedAt`; import over the v0 route with `TRACEQUEST_CURSOR_STATE_DB` pointing at it.
2. Re-import with `TRACEQUEST_CURSOR_STATE_DB` pointing at a missing file.

**Expectations:**
1. Enriched run: `session_meta.model` is the state-DB model and `updatedAt` is the ISO-8601 conversion of the ms value; rows for other bcIds are ignored. (This enrichment is v0-only — the keyless list response already carries model and timestamps.)
2. Failure run: exit `0`, import succeeds, and `model`/`updatedAt` are silently omitted.

---

## Test 33: imported cursor-cloud sessions are indexed and searchable

**Steps:**
1. Import one agent whose conversation contains a unique needle; stop the fixture server.
2. Run `tracequest search <needle> --json` with the same `HOME`/`TRACEQUEST_CURSOR_CLOUD_DIR`.

**Expectations:**
1. Search exits `0` with exactly one JSON record: `source` is `cursor-cloud`, `path` is the imported `<root>/org-repo/<agentId>.jsonl`, and `matches[]` is non-empty — normal discovery/indexing/search with no extra flag or rescan command.

---

## Execution Results

| Test | Description | Result | Evidence |
|------|-------------|--------|----------|
| 1 | unknown/missing source dies | **PASS** | exit 1; stderr names cursor-cloud |
| 2 | import --help usage/options | **PASS** | exit 0; command row, --dry-run, --full, --api-key (optional), CURSOR_API_KEY, example |
| 3 | keyless import with local session token | **PASS** | 1 imported; pinned list/conversation bodies; Content-Type + Bearer only; v0 untouched |
| 4 | inclusive pagination boundary deduped | **PASS** | 2 list POSTs with offset; 3 imported, one conversation per bcId |
| 5 | HUMAN/AI message type mapping | **PASS** | role-first rows + bubbleId; text+thinking merged; SYSTEM/unknown/empty dropped; no role:tool |
| 6 | tool_use rows drive tools/toolCounts | **PASS** | 8 aliased tool_use blocks; type-then-name; files=1, commits=1, Bash/Read/Grep/Edit counted |
| 7 | session_meta from the list response | **PASS** | ISO createdAt/updatedAt; verbatim status; modelDetails model; bare-scheme repoUrl slug |
| 8 | --api-key prefers the v0 route | **PASS** | only v0 agent on disk; api2 requests 0 for both flag and env |
| 9 | no credential dies actionably | **PASS** | exit 1; db path + cursorAuth/accessToken + flag + env; zero requests |
| 10 | rejected credential dies re-auth | **PASS** | exit 1 on first 401; sign-in-again message; 1 request; token absent from output |
| 11 | keyless 404 skip-with-warning | **PASS** | exit 0; stderr names id + 404; 1 imported, 1 skipped |
| 12 | credential never printed | **PASS** | token absent from dry-run/real stdout+stderr and from the written file |
| 13 | keyless idempotent re-run | **PASS** | skip + identical mtime; changed updatedAtMs => 1 updated |
| 14 | unchanged agent costs zero conversation requests | **PASS** | 1 conversation POST across 2 runs; 2 list POSTs; skip (unchanged); mtime identical |
| 15 | changed updatedAtMs is refetched | **PASS** | 2nd conversation POST with the bcId; 1 fetched, 1 updated; mtime changed |
| 16 | new agent with no local file is fetched | **PASS** | one new POST for the new bcId only; 2 checked, 1 fetched, 1 imported, 1 skipped |
| 17 | corrupt / session_meta-less file forces a fetch | **PASS** | both re-runs fetch and rewrite; first line is session_meta again |
| 18 | --full refetches everything | **PASS** | 2 extra POSTs; write-skip keeps mtime; composes with --dry-run |
| 19 | bounded concurrency | **PASS** | max in-flight > 1 and <= CURSOR_CLOUD_FETCH_CONCURRENCY (4); plan line names the bound |
| 20 | checked/fetched counts + plan line ordering | **PASS** | 3/3/2/0/1/0 then 3/1/0/0/3/0; plan line precedes fetch outcomes |
| 21 | unknown status/source/type tolerated | **PASS** | verbatim id + future enums; unknown type dropped; unaliased toolName verbatim |
| 22 | large single response untruncated | **PASS** | >1MB payload; 1502 lines; final message intact; 1 conversation request |
| 23 | --dry-run plans, writes nothing | **PASS** | per-agent actions + summary; root absent; real run imports 2 |
| 24 | v0 paginated fetch + jsonl layout | **PASS** | 2 list GETs limit=100/cursor; Bearer auth; org-repo/<id>.jsonl |
| 25 | slug fallback without repository | **PASS** | file under cursor-cloud/ slug |
| 26 | v0 session_meta first line | **PASS** | required + optional fields; absent fields omitted |
| 27 | v0 message row mapping | **PASS** | exact cursor row shape for user/assistant |
| 28 | v0 idempotent re-run preserves mtime | **PASS** | skip action; identical mtimeMs; exit 0 |
| 29 | v0 404 skip-with-warning | **PASS** | exit 0; stderr names id; no file for deleted agent |
| 30 | verbatim ids + unknown status | **PASS** | verbatim URL/filename; status stored verbatim |
| 31 | summary counts + exit codes | **PASS** | 2/0/1/1 then 0/1/2/1; exit 1 when failed>0 |
| 32 | v0 state.vscdb enrichment fail-soft | **PASS** | model+ISO updatedAt enriched; omitted on missing DB |
| 33 | imported sessions searchable | **PASS** | search --json: 1 hit, source cursor-cloud, non-empty matches |
