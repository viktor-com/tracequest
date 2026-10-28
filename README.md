# Search latency evidence for PR #64, head `2f52deee`

Verdict: **FAILED against the Acceptance block.** Several per-query latency targets, the unique-session count and memory are unmet. Nothing is merged or released. The final reviews are listed in the PR.

All timings are from fedora, on real sessions copied from Ivan's Mac hub. They are not Mac numbers. Control's held-out Mac query set was not opened.

## Files

| File | What it is |
|---|---|
| `final-8c64677b-per-query.md` | Every query × every condition at `8c64677b`, clean tree, 3 UI rounds. Over-limit values are marked ✗. Includes the overlap check and corpus identities. |
| `final-8c64677b-results.json` | The raw results behind that table. |
| `top10-8c64677b-on.txt`, `top10-8c64677b-off.txt` | The 26 original queries' top-10 lists against 29b56c6, sidecar on and off: 52/52 identical each. |
| `api-search-equality.txt` | Every harness query's `/api/search` body at `8c64677b` against `cb9ec834`, each hub alone on the same corpus and cache copy: 39/39 byte-identical. |
| `phrase-offset-differential.txt` | The sidecar byte test and first-line offset against the JS check, on every JSONL corpus session: 10,492 files × 5 phrases, 0 differences. Run at `c2ada00a`; the offset code is the same at the final head. |
| `lifecycle-idle-exit.txt` | The resident CLI search exiting 30 minutes after its last search and removing its socket, on the real timer. |
| `search-ui-8c64677b-redacted.webm` | The real hub UI recording, 27 s. The repo is public, so rows and result lists are blurred. Typed queries, the run count ("50+ runs" while counting) and the spinners stay visible. |
| `diff-stat.txt`, `commits.txt` | Own-diff review inputs against main `1b4fc646`: 39 files, +4,384 / −321, 29 commits. |
| `history/` | Earlier heads: `cb9ec834` (the previous evidence) and `c2ada00a` (the run before the last two fixes). |
| `before-0.5.5-*` | The 0.5.5 "before". It ran on the older 460-session hold-out, so it is not the same session set. |
| `invalid/` | Measurements that do not count, unchanged from the previous evidence. |

**Measured head versus final head.** The final head `2f52deee` differs from the measured `8c64677b` in two ways:
- A search-worker batch that fails is retried and then fails the request, instead of being scanned on the hub.
- The report judges the per-query complete-count p50 at 100 ms instead of 200 ms.

Neither changes a measured path. The harness is in the PR at `bench/search-latency/`.

## Headline at `8c64677b` (ms, p50 / p90)

| Condition | Target | Measured |
|---|---|---|
| Top bar, last key → results, warm | <100 / <200 | 31 / 51 (1/39 queries over at p50) |
| Runs filter, Enter → rows, warm | <100 / <200 | 46 / 136 (6/39 over at p50, 1 at p90) |
| Runs filter, Enter → complete count, warm | <100 / <200 | 46 / 138 (6/39 over at p50) |
| `/sessions?expr=` deep link, rows on screen | — | 160 / 182 |
| While agents write: top bar / Runs rows / Runs complete | <100 / <200 | 40 / 155, 67 / 235, 67 / 411 |
| During a host pull: top bar / Runs rows / Runs complete | <100 / <200 | 37 / 120, 57 / 237, 57 / 245 |
| CLI warm search / handoff (p50 of per-query p50) | <150 | 152 / 149 (21/39 and 17/39 queries over) |
| CLI after sessions changed / while writing | <150 | 161 / 163 |
| CLI first search, fresh start | <1000 | 431 / 514 |
| Hub fresh start, first search (3 starts) | <1000 | 1,640, 277, 151 |
| Hub idle CPU, settled / after live load | <5% | 0% / 0% |
| Hub RSS idle / after live load | bounded | 1,754 / 2,306 MB (2.75 GB at `cb9ec834`) |
| Resident CLI process RSS: start / after CLI / under writes | bounded | 2,462 / 3,792 / 3,265 MB, 15 threads |

## What changed since `cb9ec834`

**Runs filter, quoted phrases.**
- The first page arrives as soon as its rows are decided, with an "N+" count while the spinner stays on. The complete answer follows.
- The sidecar rules out files that cannot hold the phrase.
- Workers start each line scan at the first line that can hold it.

Effect: `"let me"` rows went from 1,670 to 161 ms; its complete answer takes 1,188 ms.

**Prefix resolution.** The last word's prefix matches were collected in quadratic time. `re` took 109 ms, now 0.5 ms; `t` took 320 ms, now 20 ms.

Effect: `you're absolutely right` in Runs went from 350 to 89 ms, and in the top bar from 155 to 103 ms.

**Top bar.** `/api/search` reads files for snippets and quoted phrases in the search workers, not on the hub's thread. Results are byte-identical.

**Fuzzy-match index.** A session change no longer restarts its sliced build.

**Line caches** are capped by characters as well as session count.

**Review fixes:**
- no cross-request memo;
- the sidecar byte test is aborted with its request;
- offsets are used only for the file version tested;
- the CLI's resident search sees a client that leaves;
- failed worker batches fail the request instead of scanning on the hub.

## Acceptance at the final head

| Line | Status |
|---|---|
| Accelerate exact quoted filtering without changing results | **Partly met.** The first page is 145–161 ms for the four quoted queries. The complete answer is 145 ms to 1.19 s. Results are unchanged (52/52, 39/39, 0 differences). Not under 100 ms. |
| Remove per-query CLI startup and serial snippet costs | **Not met.** A sidecar start is 2.5 ms of a 26 ms near scan, so removing it saves little. One 36 MB session's snippet scan is 122 ms by itself. With Node at about 70–85 ms of a CLI call on fedora, the resident process must answer in under about 65 ms. |
| Slice synchronous refresh bookkeeping during writes and pulls | **Partly.** A profile under writes showed `/api/search` file work as the main event-loop load, now moved to workers. The top bar while writing is 40 / 155 (was 56 / 227). Runs complete p90 while writing is 411 ms. |
| Prevent cold-start typo-index rebuild restarts | **Met** (sidx5, with a test). |
| Bound index and background-process memory | **Partly.** Line caches have byte ceilings (mem1) and hub RSS after load fell to 2.31 GB. The resident CLI process is still about 3.8 GB after the CLI run. |
| Lifecycle proof | **Met.** Idle exit with socket removal is logged. Client disconnect has a test (sd3). The sidecar abort has a test. |
| Per-query warm UI under 100 / 200 | **Unmet** for 1 top-bar query (103 ms) and 6 Runs queries (four quoted phrases and two long multi-word queries). |
| Warm CLI under 150 p50 | **Unmet**: 21 of 39 searches, 17 of 39 handoffs. |
| First search after a fresh start under 1 s | **CLI met** (431 / 514). **Hub unmet** on 1 of 3 starts (1,640 ms). That start is always the first after the corpus copy. The page cache is probably cold then; this is inferred, not proven. |
| Same limits during indexing and pulls | **Unmet** for the queries marked ✗ in the per-query table. |
| Idle CPU under 5% | **Met** (0%). |
| At least 16,938 unique sessions | **Unmet**: 16,845 copied, 16,665 timed. Fedora has no further unique sessions: its grok and vktr sessions are already in the Mac snapshot through pulled hosts. The rest exist only on the Mac. |
| 52/52 vs 29b56c6, sidecar on and off | **Met** at `8c64677b`. The final commit touches only the hub's failure path. |
| Recording | **Met**, redacted. |
| Reviews, merge, release | See the PR. Not merged or released while Acceptance is unmet. |

## Own diff review

- **New files:**
  - `src/server/search-steps.js` (the hub's worker step runner);
  - `src/sessions/phrase-bytes.js` (which sessions get the byte test);
  - `sidecar/src/phrase.rs` (the native byte test and offsets).
- **This session also changed:**
  - `filter.js` (first page in list order);
  - `route-handlers-api.js` (`first=1`, async top bar);
  - `phrase-check.js` (sidecar stream, abort);
  - `scan-queries.js` (prefix fix, phrase step, line-cache bound);
  - `search-index.js` (trigram change log);
  - `jsonl-read.js` (`start`, `startIf`);
  - `index-writers.js` (sidecar abort);
  - `search-daemon.js` (socket protocol, phrase steps);
  - `search-worker.js`;
  - `browser-client.js` (partial page);
  - `sidecar/src/cli.rs`, `main.rs`;
  - the harness; `.facts`; `CHANGELOG.md`.
- **Removed again within the session:** the 30 s phrase memo (flt6), which was stale-prone.
- **Existing tests, fixtures and CI:** untouched. Only `test/bin/search-latency.test.js` and `test/browser/search-loading.playwright.test.js` are new.
- **New dependencies:** none. The Rust code uses `regex`, `rayon`, `memmap2` and `memchr`, which the sidecar already depends on.
