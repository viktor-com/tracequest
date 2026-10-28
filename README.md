# Search latency evidence for PR #64, head `cb9ec834`

Verdict: **BLOCKED**. The head is not independently approved: the required fresh GPT-6.1 Sol and Grok 4.7 reviews of `cb9ec834` are outstanding. Several latency and memory targets are unmet. Nothing is merged or released.

All timings are from fedora, on real sessions copied from Ivan's Mac hub. They are not Mac numbers.

## Files

| File | What it is |
|---|---|
| `final-cb9ec834-per-query.md` | Every query × every condition at head `cb9ec834`, clean tree. Over-limit values are marked ✗. Also has the overlap check and corpus identities. |
| `final-cb9ec834-results.json` | Raw results behind that table: head, overlap timestamps, resident-process resources, corpus identities. |
| `before-0.5.5-full-index-per-query.md`, `before-0.5.5-full-index-results.json` | The 0.5.5 baseline used as "before": full JS index, 16,497 sessions, the older 460-session hold-out. This is the closest valid before; it is not the same session set. |
| `top10-cb9ec834-on.txt`, `top10-cb9ec834-off.txt` | The 26 original queries' top-10 lists against 29b56c6, sidecar on and off: 52/52 identical each. |
| `search-ui-cb9ec834-redacted.webm` | The real hub UI recording, 28 s. The repo is public, so session titles, rows, the search dropdown and the timing overlay are blurred; typed queries and both loading spinners stay visible. Exact timings are in the per-query table. |
| `diff-stat.txt`, `commits.txt` | Own-diff review inputs: 33 files and 19 commits against main `1b4fc646`. |
| `invalid/` | Measurements that do not count; kept for transparency. See below. |

The harness that produced these is in the PR at `bench/search-latency/`.

## Invalid measurements

- `invalid/INVALID-*base-0.5.5-same*`: a 0.5.5 baseline on the same held-out set. Its cold build went through 0.5.5's sidecar and wrote an 18 MB `search.idx`, against 195 MB from the JS indexer. It therefore searched a much smaller index, which explains its low memory and fast numbers.
- `invalid/INVALID-deep-link-column-final-0abeaa73-per-query.md`: the deep-link column and the earlier 16 deep-link "timeouts". The page embeds its rows and makes no fetch, while the old harness waited for a fetch. These are invalid measurements, not user hangs. The harness now times rows on screen: 176 / 208 ms p50 / p90 at `cb9ec834`.

## Corpus reconciliation (unique session identities)

Identity is source plus session file name (or OpenCode id), so a session imported from two machines counts once.

| | Sessions | Unique |
|---|---|---|
| Copied from Ivan's Mac hub | 16,957 | 16,845 |
| Held out for the live tests (30 written as new, 150 pulled, 8 appended to) | 180 moved out | — |
| Timed corpus | 16,777 | 16,665 |
| Mac reference from Control | 16,938 | not given |

The copy covers the 16,938 reference by raw count. By unique identity it is 93 short. The timed corpus is 273 unique sessions short of 16,938.

## Acceptance at `cb9ec834`

| Line | Status |
|---|---|
| Quoted `/sessions?expr=` and worker errors never scan on the hub event loop | **Met.** A test serves a quoted page over a 60 MB file and keeps the hub under 100 ms; the old head measured 161–171 ms. A failed phrase worker is retried once in a fresh worker, then the request fails; the hub-side checker has no file scanner. |
| Cancellation and lifecycle | **Met in code and tests** for the browser (abort and send newest), the server (drops gone clients, cancels running phrase jobs) and the resident CLI process (stops when its client leaves; that last one is source only). Resident: 2.45 GB at start, 3.75 GB after 78 searches, 3.46 GB under writes, 15 threads. Not verified: the 30-minute idle exit, and combined Mac memory. |
| UI under 100 ms p50 / 200 ms p90 per query, warm | **Unmet.** Top bar: 1 of 39 over p50, 0 over p90. Runs Enter: 7 over p50, 4 over p90. |
| Same while agents write and during a pull | **Unmet.** Write: top bar 4 of 39, Runs 8 of 39. Pull: top bar 1 of 39, Runs 8 of 39, `"let me"` 2.4 s. Overlap verified: 86/86 UI and 39/39 CLI rows inside each window. |
| CLI under 150 ms p50 per query | **Unmet.** Warm: 20 of 39 search, 15 of 39 handoff. Write: 26 of 39. Pull: 28 of 39. |
| First search after a fresh start under 1 s | **CLI met** (426 / 556 ms). **Hub unmet**: 1 of 3 starts took 2,868 ms. |
| Idle CPU under 5% | **Met:** 0% settled, and 0% after live load. |
| Memory | **Unmet**, no ceiling met: hub 1.52 GB idle and 2.75 GB after live load (0.5.5: 1.45 / 2.02). Resident figures as above. |
| 52/52 vs 29b56c6, sidecar on and off | **Met.** |
| Recording | **Met**, redacted copy here. |
| Fresh Sol and Grok reviews | **Outstanding.** |
| Merge, release `v0.5.9`, both tarballs | **Not done.** |

## Exact remaining work per unmet line

**Correctness limit: quoted phrases** (`"let me"` 1.7–2.4 s, `"cannot contain whitespace"` 0.5–0.9 s, `"you're absolutely right"` up to 0.5 s)
- Exact quoted matching must read every candidate session's text until it finds the phrase. For `"let me"` that is about 12,000 files, 3,507 of which match. Without positions in the index, no exact speedup can skip that.
- To make it fast without changing results, either:
  - add a positional or n-gram index of session text, built and kept current by the indexer, used as a sound prefilter; or
  - stream the Runs list: answer the first page once the newest matches are verified and fill in the total afterwards, which changes the `/api/sessions` response protocol.
- Anything else trims at most a constant factor; parallel workers already cut it about 5×.

**Optimization, no correctness limit**
- **CLI per-query p50 over 150 ms.** In the resident process, the sidecar near-words scan of about 400 files is 37–55 ms per query, a sidecar process per query. Snippet scans add 10–40 ms, and Node start-up about 75 ms on fedora. Remaining work:
  - a persistent sidecar near-scan mode, so there is no spawn per query and scans run in parallel with BM25;
  - snippet scans pipelined while the near scores arrive;
  - re-measure on the Mac.
- **UI misses while writing or pulling** (top bar 147–350 ms, Runs 230–629 ms on unquoted queries): the hub's refresh still does synchronous work between slices over 17k sessions (index metadata merge and key hashing). Moving that bookkeeping into slices or a worker is the work.
- **Fresh-hub first search 2.9 s**: a half-typed word needs the typo index. Its sliced background build restarts when the first refresh changes the index, and the first typo query then builds it synchronously. The work: keep a change log so an in-progress build can catch up instead of restarting, preserving the order a full rebuild gives.
- **Memory** (hub 2.75 GB after live load, resident 2.5–3.75 GB):
  - The decoded index and phrase workers are the bulk. Phrase workers already stop after 30 s idle.
  - Remaining: keep the index lazily decoded with a small change overlay instead of fully decoding it on the first change, and cap per-worker caches by bytes.

## Own diff review

- **Changed in `src/`:**
  - Hub UI: `browser-client.js`, `command-palette.js`, `runs-page-css.js`, `browser-page.js`.
  - CLI: `cli-search.js`, and new `search-daemon.js`, `search-daemon-main.js`, `search-request.js`.
  - Filter: `filter.js`.
  - Hub server: `route-cache.js`, `route-handlers-api.js`, `route-handlers-pages.js`, `worker-pool.js`, new `phrase-check.js`.
  - Search and index: `index-writers.js`, `scan-queries.js`, `search-index.js`, `session-changes.js`, `session-discovery-paths.js`, new `search-worker.js`.
- **Also changed:** `bin/tracequest.js`; `.facts`; `CHANGELOG.md`; package and lockfile (0.5.9); `bench/search-latency/` (harness); new `test/bin/search-latency.test.js` and `test/browser/search-loading.playwright.test.js`.
- **Reverted during the work:**
  - the one-request-at-a-time queue in both search boxes;
  - the main-thread fallback for failed phrase checks;
  - turning the worker line cache off;
  - an earlier 0.5.8 release commit.
- **Existing tests, fixtures and CI:** untouched.
- **New dependencies:** none.
