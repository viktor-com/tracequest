# bench/

A reproducible harness for the session pipeline: discovery, indexing, search,
fs watching and live-state detection. It exists so that a claim about tracequest
being fast or stable is a number somebody else can reproduce, not an impression.

Numbers recorded from these scripts live in [BASELINE.md](./BASELINE.md).

## Running

```sh
npm run bench                 # everything, at the settings BASELINE.md quotes
node bench/run-all.js --quick # same shape, short idle runs, for iteration
```

Individual scripts, all of which accept `--keep` to leave the corpus on disk:

| script | question it answers |
|---|---|
| `correctness.js` | does the session list still match reality under hostile conditions |
| `cold-index.js` | how long to index N sessions from nothing, and to revalidate them warm |
| `incremental.js` | how long one appended turn takes to reach the index, by transcript size |
| `idle.js` | CPU and RSS of a running server with watchers armed and nobody typing |
| `live-stability.js` | does a steady situation keep getting reported the same way |

`cold-index.js --real` measures the operator's actual `$HOME` instead of a
synthetic corpus. It never deletes a real index — but it does not guarantee a
warm measurement either: if `~/.cache/tracequest` happens to be empty or its
schema version has moved, the run is a genuine cold index of real data. Read the
indexer's own "N stale" line to know which one you got.

## How the harness is built

**Every measurement runs in a fresh child process** (`lib/harness.js`). The index
layer holds process-lifetime caches — the index cache, the BM25 search index, the
per-path parse memos — so a second measurement in the same process would quietly
report warm-cache numbers. The parent also waits for the child to exit rather than
killing it, because the child flushes deferred index writes from its exit handler.

**The corpus generator reuses the fixture writers the test suite already ships**
(`test/helpers/synthetic-sessions.js`), so a bench corpus and a test corpus are the
same shape. `lib/corpus.js` adds the cases the unit tests deliberately do not carry:

- transcripts of a few hundred MB, written in blocks so the generator stays flat
- a transcript appended to while it is being indexed, and one torn mid-record
- sessions deleted, and whole directories removed, during a scan
- a symlinked directory cycle, and a directory the scanning user cannot read
- an ssh-imported remote-host tree, which is a second synthetic `$HOME`

**Everything is written under a throwaway `$HOME`.** `os.homedir()` follows `$HOME`
on Linux, so both the corpus and `~/.cache/tracequest` are redirected and a bench
run cannot touch real session data.

**CPU and memory for the server come from `/proc`** (`lib/measure.js`), since
`process.cpuUsage()` only sees the calling process. `rssGrowthMbPerMin` is a
least-squares slope: garbage-collection sawtooth averages out, a leak does not.

## Reading the results

Each script prints one JSON record. Set `TQ_BENCH_JSON=path.jsonl` to also append
records to a file for comparison across runs.

Two measurement traps worth knowing about, both of which produced wrong numbers
while this harness was being written:

- **The sidecar may not be built.** `findSessions`/`buildIndex` fall back to the
  pure-JS path silently. `cold-index.js` reports `sidecar.*` and `js.*` separately;
  if they are identical, `sidecar/bin/<platform>/tracequest-sidecar` is missing and
  both rows are really the fallback.
- **Liveness needs the process and the cwd to line up.** A stub agent whose argv
  matches the pgrep pattern is not enough; it has to run in the cwd whose project
  directory holds the recording, or the run measures an empty set and reports a
  reassuring zero.
