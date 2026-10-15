# Evidence: OpenCode errors:>0 filter (tracequest audit finding 3)

Real recording: the audit's witness, OpenCode session `20e4de3f` (`ses_2d4176beeffel0iPkFYT5WDD8N`, project lifeos, 68 failed tool calls) plus a second lifeos session (`2f2dc6c3`, 13 failures), copied read-only from fedora's `~/.local/share/opencode/opencode.db` into a disposable HOME as an imported host (`hosts/fedora/.local/share/opencode/opencode.db`). The Mac hub was unreachable from this machine (different tailnet); fedora is where this witness was recorded.

| File | What it shows |
|---|---|
| `before-main-cli.txt` | main 636d4d2, native and JS indexer: `find 'source:opencode errors:>0'` → "No sessions match"; detail view counts 68 and 13 |
| `after-branch-cli.txt` | index built by main, then read by the branch: rows re-read once, index stores 68 and 13 (= detail), filter lists both; second run reuses the cache |
| `before-runs.png` | Runs page on main with `source:opencode errors:>0` typed into the filter: "No runs match" |
| `after-runs.png` | Same on the branch (started on main's index.json): 2 runs, 68 errors and 13 errors |
| `after-detail.png` | Witness detail page: 68 errors (same on main and branch) |
| `e2e-on-main.txt` / `e2e-on-branch.txt` | New end-to-end tests: 4 fail on main, 4 pass on the branch |
