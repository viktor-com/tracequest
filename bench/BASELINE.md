# Baseline

Numbers from `bench/`. Every row is reproducible with the command in its
section. Replace them when the hardware or the corpus changes; do not quote a
number here that did not come from a full (non-`--quick`) run.

## Machine

| | |
|---|---|
| CPU | 32 logical cores |
| OS | Linux 7.0.12 (Fedora 43) |
| Node | 22.22.2 |
| Disk | local SSD, corpora under `/tmp` |

## What the corpus on this machine looks like

What the tool actually faces here, measured with `find` and `du`:

| root | files | size |
|---|---:|---:|
| `~/.claude/projects` | 2 822 | 982 MB |
| `~/.codex/sessions` | 1 581 | 2.0 GB |
| `~/.cursor` | 110 | 65 MB |
| `~/.factory/sessions` | 820 | 124 MB |
| `~/.grok/sessions` | 6 450 | 679 MB |
| `~/.local/share/opencode` | 14 700 | 1.7 GB |

Largest single transcripts are 20–45 MB; the harness also generates synthetic
16/64/300 MB transcripts because those exist in the wild and nothing in the test
suite covers them.

## Indexing the real corpus

`node bench/cold-index.js --real` — the operator's actual `$HOME`, 7 521
discovered sessions across all sources. The real `~/.cache/tracequest` was
empty at the time, so this is a genuine cold index of real transcripts rather
than the warm revalidation the flag usually measures. It never deletes a real
index; it measures whatever state it finds.

| path | sessions | scan | build | total | peak RSS | index.json | search.idx |
|---|---:|---:|---:|---:|---:|---:|---:|
| sidecar | 7 521 | 2 313 ms | 12 980 ms | 16 176 ms | **886 MB** | 3.9 MB | 28.2 MB |
| JS fallback | 7 521 | 239 ms | 38 497 ms | 40 196 ms | 853 MB | 3.9 MB | 35.5 MB |

Real transcripts cost about 1.7 ms each to index against 0.57 ms for the
synthetic ones, which is why the 5 000-session synthetic figure and this one are
not comparable. **Peak RSS approaching 900 MB is the memory high-water mark for
the whole pipeline** and by far the largest number this harness produces.

The JS pass reported 1 588 sessions stale immediately after the sidecar had
indexed all 7 521. That looked like the two indexers disagreeing, so it was
checked directly: comparing every discovered session's mtime against its
`index.json` entry afterwards finds **4** stale, and all four are sessions being
actively appended to while the check runs. The 1 588 were sessions present in
`index.json` but absent from the sidecar-written `search.idx`, which the JS side
forces stale to regenerate their term frequencies — a one-time catch-up, not a
standing disagreement. `search.idx` grows from 28.2 MB to 35.5 MB when it
happens.

## Cold and warm index

`node bench/cold-index.js --per-source 1000` — 5 000 sessions, 1 000 each across
claude, codex, factory, grok and opencode.

The Rust sidecar is the production path; the pure-JS walk is the fallback when
the sidecar binary is missing. Both are measured, because most of the test suite
exercises only the fallback. The first numbers taken for this document were
accidentally fallback-only: `sidecar/bin/` was empty in a fresh worktree and
`runSidecar` degrades silently. Build it with `node scripts/bundle-sidecar.mjs`
before quoting a sidecar row.

| path | pass | scan | build | flush | total | peak RSS |
|---|---|---:|---:|---:|---:|---:|
| sidecar | cold | 271 ms | 2 530 ms | 25 ms | **2 826 ms** | 122 MB |
| sidecar | warm | 473 ms | 58 ms | 42 ms | 573 ms | 94 MB |
| JS fallback | cold | 101 ms | 4 850 ms | 57 ms | **5 008 ms** | 145 MB |
| JS fallback | warm | 47 ms | 25 ms | 19 ms | 91 ms | 103 MB |

Target was a cold index of 5 000 sessions under 3 s. **The production path meets
it at 2.8 s.** The JS fallback does not, at 5.0 s; that is the documented
degraded mode and was left alone rather than rewritten on speculation.

Warm revalidation is comfortable on both paths. The sidecar's warm scan is
slower than the fallback's because it pays a process spawn to answer a question
the fallback answers in-process; at 5 000 sessions that spawn dominates.

## Incremental update

`node bench/incremental.js` — append one user+assistant turn to one transcript,
then re-scan and re-index. Sweeps transcript SIZE rather than session count,
because index invalidation is mtime-equality with no stored byte offset: an
append re-reads the file from byte 0.

| transcript | p50 | mean | max | RSS |
|---|---:|---:|---:|---:|
| ~5 KB | 3.2 ms | 3.1 ms | 3.9 ms | 70 MB |
| 16 MB | 24.6 ms | 24.8 ms | 26.8 ms | 80 MB |
| 64 MB | 49.0 ms | 49.1 ms | 53.5 ms | 81 MB |
| 304 MB | 171 ms | 170 ms | 178 ms | 80 MB |

Target was under 100 ms after an append. Met through 64 MB; a 304 MB transcript
costs 171 ms. RSS is flat across all four sizes, confirming the JSONL reader
streams in 64 KiB chunks rather than buffering the file.

**Not changed, deliberately.** Offset-based tailing would fix the 304 MB row, but
it is not a small change: the index entry carries aggregates (token totals, tool
counts, chapter boundaries) that would each need persisted accumulator state and
a validity check against truncation and rewrite. The largest real transcript on
this machine is 45 MB, which lands at roughly 35 ms, so nothing in the actual
corpus crosses the target. Revisit when a real transcript does.

## Idle server

`node bench/idle.js --seconds 300 --per-source 400` — 2 000 sessions, watchers
armed, nobody touching the tree. CPU and RSS sampled from `/proc` once a second.

The live-page rows simulate one open live-session page polling `/api/sessions/live`
once a second. The UI addresses a session by hash, not by path, and the two take
different routes through resolution, so both are measured.

| scenario | window | CPU | RSS start → end | peak | growth (whole run) |
|---|---|---:|---|---:|---:|
| idle, no page open | 5 min | 0.01 % | 88.5 → 91.4 MB | 91.4 MB | 0.1 MB/min |
| idle, live page by path | 5 min | 0.46 % | 88.2 → 100.9 MB | 101.9 MB | 2.0 MB/min |
| idle, live page by hash | 5 min | 0.60 % | 87.4 → 115.4 MB | 115.4 MB | 4.5 MB/min |
| idle, live page by hash | **15 min** | 0.68 % | 90.4 → 103.9 MB | 108.7 MB | **0.0 MB/min** |

**Both targets pass: CPU stays under 1 % everywhere, and memory is flat.**

The memory conclusion needed a better measurement to reach. A 5-minute window
with a live page open shows 2–4.5 MB/min of growth and looks like a leak. It is
not: the same scenario over 15 minutes reports a whole-run slope of zero, and
splitting the run in half shows why —

| | first half | second half |
|---|---:|---:|
| RSS slope | 0.8 MB/min | 0.1 MB/min |

The heap grows to a working set of roughly 104 MB and then stops. The second
half matches the idle-with-no-page baseline. Heap warm-up and a leak both show a
positive whole-run slope, which is why `sampleProcess` reports each half
separately; quoting only the 5-minute number would have sent someone hunting a
leak that does not exist.

## Correctness under hostile conditions

`node bench/correctness.js` — seven cases, each asking whether the session list
still matches reality. The two churn cases scan repeatedly for eight seconds
while the parent process deletes and recreates the tree underneath, because a
single timed scan cannot test a concurrent modification: the child takes longer
to start than the scan takes to run, so the edits always landed first.

| case | before | after |
|---|---|---|
| baseline (5 sources, 100 sessions) | pass | pass |
| unreadable directory in the tree | **FAIL — EACCES emptied the entire list** | pass |
| symlink cycle (depth-limited root) | pass | pass |
| sessions deleted and recreated during live scans | pass | pass |
| project directory removed during live scans | pass | pass |
| torn trailing JSONL record | pass | pass |
| ssh-imported host tree | pass | pass |

Plus one case found outside the suite and now covered by a regression test: a
symlink cycle under `~/.codex/sessions`, whose walk is unbounded, threw ELOOP out
of `findSessions` and emptied the list for every source, not only codex.

One candidate was investigated and **disproved**: deleting one session and adding
another in the same interval was expected to leave the deleted path in
`index.json` and in the search postings, because `pruneIndexCache` returns early
when the path count is unchanged. Measured, the deleted path was absent from both
the in-memory index and the persisted file. No fact was written and no code was
changed for it.

## Live-state stability

`node bench/live-stability.js --seconds 120` — a stub agent whose argv matches
the pgrep patterns, running in the cwd whose project directory holds a steadily
appended transcript. Polled every two seconds with the 5 s memo expired (not
cleared, so the previous clean snapshot survives, which is what a real poll two
seconds later sees). Each observation records whether that pass had a probe that
could not answer, and how long the pass took.

| | before | after |
|---|---:|---:|
| polls in 120 s | 10 | 11 |
| state flaps | **2** | **0** |
| polls reporting the session live | 80 % | **100 %** |
| polls with a failed probe | not measured | 7 of 11 |
| detection cost, median | not measured | 8 949 ms |
| detection cost, max | not measured | 14 472 ms |

The target was no flaps in a two-minute steady run, and it is met. The
interesting part is the third and fourth rows together: **64 % of passes had a
probe time out, and the reported state still never changed.** Before, a timed-out
probe was indistinguishable from "nothing is running", so those passes dropped
the session; now they carry the last clean answer forward, gated on the recording
still reading as generating (fact 3w6).

The same run quantifies the cost problem: a detection pass takes about nine
seconds here, which is longer than the 5 s memo it is supposed to be cached
behind. See "Open items".

## Open items

### Process-probe latency (the largest remaining issue)

`detectLiveSessions` measured at **9–15 s per call** on this machine, with a
one-session corpus and nothing live. It issues nine serial synchronous `pgrep`
spawns — four agent binaries × two match forms, plus claude — each capped at a
2 s timeout:

```
pgrep -x claude                  869 ms   status 0
pgrep -x codex                  1085 ms   status 1
pgrep -f (^|/)codex($| )        1009 ms   status 1
pgrep -x cursor-agent           1019 ms   status 1
pgrep -f (^|/)cursor-agent($| ) 1004 ms   status 1
pgrep -x droid                    90 ms   status 1
pgrep -f (^|/)droid($| )        1034 ms   status 1
pgrep -x opencode               2003 ms   ETIMEDOUT
pgrep -f (^|/)opencode($| )     2003 ms   ETIMEDOUT
                       subtotal 10116 ms
```

This box runs at load average 8–13 with ~940 processes, which is its normal
state for someone running several agents at once — that is, the condition under
which live detection matters most.

Two consequences, one fixed and one not:

- **Fixed.** A timed-out probe exits with a null status and no stdout, which
  read exactly like pgrep's honest "matched nothing", so every running agent
  blinked out of the dashboard and back on the next poll. Detection now
  distinguishes the two and carries a recent clean snapshot forward, gated on
  the recording still reading as generating (fact 3w6).
- **Not fixed.** The latency itself. `detectLiveSessions` is synchronous, so it
  blocks the event loop for seconds, and it takes longer than its own 5 s memo
  TTL — which means the memo never actually holds and every caller pays full
  price.

  Timed directly, four consecutive calls against an empty fake `$HOME`:

  | | call 1 | call 2 | call 3 | call 4 | over the 5 s TTL |
  |---|---:|---:|---:|---:|---:|
  | this branch | 10 343 ms | 10 376 ms | 9 701 ms | 7 589 ms | 4 of 4 |
  | unmodified `main` | 8 563 ms | 10 462 ms | 10 862 ms | 12 215 ms | 4 of 4 |

  The two are equivalent; if anything `main` is slower. This matters because
  the `detectLiveSessions cache TTL` tests assert that two consecutive calls
  return the same array reference, which can only hold if the first call
  finishes inside the 5 s window. On this machine it never does, so those tests
  fail intermittently **on both branches** — a machine property, not a
  regression. Run them on an idle host and they pass.

The proposed change is recorded as draft fact `y0g`: evaluate the same
exact-name and full-argv match semantics against ONE process-table snapshot per
pass instead of nine spawns. It is left as a decision rather than applied
because `live-sessions-platform.facts` pins the per-binary pgrep mechanism and
its darwin behaviour cannot be verified on this host.

### Pre-existing test failures on this machine

A full `npm test` here reports 4 275 tests, 4 189 passing, 82 skipped and 4
failing. None of the four come from this branch; each was reproduced on
unmodified `origin/main` in a scratch worktree:

| failing suite | why |
|---|---|
| `scan-queries behavioral findSessions integration` | fails identically on `main` |
| `session-index-core findSessions sidecar scan fallback` | fails identically on `main` |
| `sidecar enabled path (gate off, mock binary)` | fails identically on `main` |
| `detectLiveSessions cache TTL` (4 subtests) | detection exceeds its own 5 s memo here; see above |

The three sidecar ones were first suspected to be caused by staging a real
`sidecar/bin/<platform>/tracequest-sidecar`, since the tests use a mock binary.
Parking the staged binary and re-running changed nothing, and `main` fails them
with the staged binary absent too, so the cause is elsewhere and pre-existing.

Two tmux `launch integration` suites also fail under load and pass when run
alone; they are timing-sensitive and were failing before any change here.

### Incremental indexing above ~150 MB

Index invalidation is mtime-equality with no stored byte offset, so an append
re-reads the transcript from byte 0. Measured cost stays under the 100 ms target
through 64 MB and would cross it somewhere above ~150 MB. No change was made:
the measurement did not justify one, and the largest real transcript on this
machine is 45 MB.
