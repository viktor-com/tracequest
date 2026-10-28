ms, p50 / p90 unless noted. Corpus: base-0.5.5-same=16777 sessions.

| Condition | Target | base-0.5.5-same |
|---|---|---|
| CLI warm search, p50/p90 of per-query p50 | <150 p50 | 304 / 330 |
| CLI warm handoff, p50/p90 of per-query p50 | <150 p50 | 299 / 333 |
| CLI first search after sessions changed | <150 p50 | 838 / 883 |
| CLI first search of a fresh start (nothing resident) | <1000 | 326 / 368 |
| Hub fresh start: first search | <1000 | 148 / 148 |
| Hub fresh start: spawn → first results (incl. page load) |  | 3337, 2384, 2917 |
| UI top bar, last key → results (novel) | <100 p50, <200 p90 | 140 / 148 |
| UI Runs filter, Enter → rows (novel) | <100 p50, <200 p90 | 28 / 56 |
| UI deep link /sessions?expr= → rows on screen |  | 83 / 88 |
| UI while agents write: top bar | <100 p50, <200 p90 | 138 / 196 |
| UI while agents write: Runs Enter | <100 p50, <200 p90 | 29 / 328 |
| CLI while agents write | <150 p50 | 867 / 943 |
| UI during host pull: top bar | <100 p50, <200 p90 | 138 / 143 |
| UI during host pull: Runs Enter | <100 p50, <200 p90 | 27 / 185 |
| Hub idle CPU % (60 s, settled) | <5 | 0 (RSS 444 MB) |
| Hub idle CPU % after live load |  | 0 (RSS 854 MB) |
| Hub CPU % while agents write |  | 24.6 |
| Cold index build (empty cache, CLI) |  | 6083 |

### base-0.5.5-same: every query (ms; ✗ = over its limit, — = not run, T = timed out)

Head ?; corpus {"copied":{"sessions":16957,"unique":16845},"heldOut":{"new":30,"pull":150,"active":8},"timed":{"sessions":16777,"unique":16665}}
Overlap while agents write: UI 86/86 queries, CLI 39/39 queries inside the writer window
Overlap during the host pull: UI 86/86 queries, CLI 39/39 queries inside the writer window

| Query | CLI search | CLI handoff | CLI writing | CLI pull | Top bar p50 | Top bar p90 | Runs Enter p50 | Runs Enter p90 | Top bar writing | Runs writing | Top bar pull | Runs pull | Deep link p50 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| codex stop button | 282 ✗ | 271 ✗ | 1087 ✗ | 1015 ✗ | 139 ✗ | 140 | 29 | 34 | 137 | 25 | 140 | 31 | 83 |
| interrupt generation with one Stop | 287 ✗ | 285 ✗ | 880 ✗ | 703 ✗ | 136 ✗ | 151 | 21 | 23 | 135 | 34 | 145 | 31 | 84 |
| cursor support | 304 ✗ | 312 ✗ | 854 ✗ | 324 ✗ | 137 ✗ | 147 | 28 | 34 | 141 | 80 | 139 | 31 | 85 |
| runs page sorting | 287 ✗ | 281 ✗ | 836 ✗ | 282 ✗ | 136 ✗ | 138 | 25 | 26 | 139 | 21 | 133 | 23 | 75 |
| fix runs page sorting and search box | 281 ✗ | 274 ✗ | 859 ✗ | 281 ✗ | 131 ✗ | 141 | 19 | 24 | 135 | 29 | 134 | 26 | 71 |
| open the failed call from what went wrong | 311 ✗ | 299 ✗ | 895 ✗ | 336 ✗ | 144 ✗ | 147 | 25 | 32 | 138 | 32 | 138 | 19 | 86 |
| what went wrong failed call | 315 ✗ | 315 ✗ | 943 ✗ | 360 ✗ | 137 ✗ | 144 | 28 | 32 | 140 | 31 | 138 | 26 | 86 |
| standup and handoff features | 334 ✗ | 335 ✗ | 817 ✗ | 284 ✗ | 135 ✗ | 209 ✗ | 27 | 30 | 135 | 29 | 190 | 18 | 72 |
| ui style design guidelines | 293 ✗ | 287 ✗ | 842 ✗ | 319 ✗ | 137 ✗ | 137 | 23 | 30 | 142 | 20 | 138 | 29 | — |
| harbor wordmark on dither canvas | 316 ✗ | 327 ✗ | 900 ✗ | 277 ✗ | 129 ✗ | 141 | 20 | 26 | 196 | 21 | 136 | 26 | — |
| harness hacks slide presentation | 277 ✗ | 289 ✗ | 801 ✗ | 666 ✗ | 134 ✗ | 140 | 22 | 22 | 253 ✗ | 23 | 137 | 34 | — |
| pre-wiring explainer video | 325 ✗ | 329 ✗ | 864 ✗ | 304 ✗ | 131 ✗ | 135 | 34 | 34 | 138 | 34 | 137 | 26 | — |
| more space between lines yes or no state | 310 ✗ | 296 ✗ | 860 ✗ | 318 ✗ | 132 ✗ | 139 | 29 | 32 | 140 | 34 | 139 | 29 | — |
| test agent store as an end user | 308 ✗ | 305 ✗ | 883 ✗ | 335 ✗ | 138 ✗ | 143 | 27 | 33 | 143 | 25 | 138 | 27 | — |
| readme diagram images redesign before after | 278 ✗ | 277 ✗ | 836 ✗ | 299 ✗ | 132 ✗ | 139 | 23 | 30 | 138 | 56 | 135 | 32 | — |
| draft render queued 40 minutes ago | 269 ✗ | 272 ✗ | 850 ✗ | 300 ✗ | 131 ✗ | 134 | 32 | 33 | 135 | 18 | 135 | 21 | — |
| "cannot contain whitespace" | 278 ✗ | 277 ✗ | 834 ✗ | 307 ✗ | 135 ✗ | 145 | 9 | 75 | 137 | 732 ✗ | 136 | 7 | — |
| parseSession | 309 ✗ | 319 ✗ | 914 ✗ | 343 ✗ | 136 ✗ | 148 | 25 | 35 | 138 | 35 | 141 | 19 | — |
| sidecar timeout | 308 ✗ | 282 ✗ | 853 ✗ | 299 ✗ | 135 ✗ | 136 | 31 | 35 | 133 | 28 | 133 | 26 | — |
| ssh import backoff | 270 ✗ | 269 ✗ | 829 ✗ | 295 ✗ | 134 ✗ | 140 | 22 | 35 | 142 | 28 | 139 | 33 | — |
| usage limits | 320 ✗ | 326 ✗ | 907 ✗ | 358 ✗ | 136 ✗ | 137 | 24 | 34 | 134 | 14 | 140 | 37 | — |
| insights stall | 287 ✗ | 284 ✗ | 876 ✗ | 721 ✗ | 138 ✗ | 140 | 33 | 34 | 138 | 21 | 134 | 21 | — |
| worktree origin remote | 316 ✗ | 314 ✗ | 859 ✗ | 326 ✗ | 132 ✗ | 136 | 33 | 35 | 134 | 328 ✗ | 132 | 28 | — |
| error handling | 330 ✗ | 333 ✗ | 922 ✗ | 362 ✗ | 136 ✗ | 140 | 28 | 32 | 143 | 31 | 138 | 185 | — |
| grok vktr | 270 ✗ | 275 ✗ | 853 ✗ | 302 ✗ | 132 ✗ | 134 | 30 | 32 | 137 | 29 | 140 | 32 | — |
| you're absolutely right | 325 ✗ | 306 ✗ | 905 ✗ | 370 ✗ | 132 ✗ | 138 | 28 | 34 | 139 | 23 | 143 | 21 | — |
| absolutely right | 323 ✗ | 318 ✗ | 885 ✗ | 340 ✗ | 137 ✗ | 138 | 26 | 29 | 309 ✗ | 29 | 136 | 30 | — |
| let me | 361 ✗ | 351 ✗ | 996 ✗ | 470 ✗ | 130 ✗ | 143 | 27 | 32 | 138 | 22 | 143 | 26 | — |
| I'll | 297 ✗ | 297 ✗ | 872 ✗ | 322 ✗ | 141 ✗ | 150 | 33 | 34 | 144 | 34 | 136 | 29 | — |
| the | 309 ✗ | 299 ✗ | 875 ✗ | 322 ✗ | 138 ✗ | 139 | 35 | 35 | 136 | 34 | 137 | 221 ✗ | — |
| now let me check | 347 ✗ | 340 ✗ | 979 ✗ | 389 ✗ | 131 ✗ | 145 | 27 | 28 | 140 | 21 | 140 | 27 | — |
| "you're absolutely right" | 304 ✗ | 301 ✗ | 924 ✗ | 328 ✗ | 135 ✗ | 142 | 1973 ✗ | 1995 ✗ | 142 | 2966 ✗ | 139 | 2818 ✗ | — |
| "let me" | 315 ✗ | 320 ✗ | 868 ✗ | 718 ✗ | 132 ✗ | 137 | 1187 ✗ | 1274 ✗ | 132 | 1270 ✗ | 141 | 1681 ✗ | — |
| "absolutely right" | 304 ✗ | 311 ✗ | 867 ✗ | 325 ✗ | 137 ✗ | 152 | 56 | 57 | 170 | 25 | 140 | 42 | — |
| why does the sidecar near scan give a different score than the javascript scorer for codex sessions | 276 ✗ | 278 ✗ | 829 ✗ | 305 ✗ | 134 ✗ | 138 | 29 | 33 | 136 | 29 | 138 | 24 | — |
| make the runs page side panel stop blocking clicks on the list behind it when it is open | 280 ✗ | 278 ✗ | 878 ✗ | 299 ✗ | 133 ✗ | 148 | 29 | 31 | 198 | 181 | 143 | 29 | — |
| zstd | 307 ✗ | 317 ✗ | 843 ✗ | 301 ✗ | 134 ✗ | 134 | 28 | 30 | 137 | 10 | 133 | 26 | — |
| fsevents | 274 ✗ | 277 ✗ | 821 ✗ | 278 ✗ | 132 ✗ | 140 | 31 | 34 | 134 | 22 | 135 | 19 | — |
| flock | 274 ✗ | 276 ✗ | 834 ✗ | 280 ✗ | 136 ✗ | 138 | 31 | 31 | 135 | 27 | 133 | 23 | — |

Queries over their limit: CLI search 39, CLI handoff 39, CLI writing 39, CLI pull 39, Top bar p50 39, Top bar p90 1, Runs Enter p50 2, Runs Enter p90 2, Top bar writing 2, Runs writing 4, Top bar pull 0, Runs pull 3, Deep link p50 0
