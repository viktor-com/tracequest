ms, p50 / p90 unless noted. Corpus: base-0.5.5-mac-2=16497 sessions.

| Condition | Target | base-0.5.5-mac-2 |
|---|---|---|
| CLI warm search, p50/p90 of per-query p50 | <150 p50 | 403 / 520 |
| CLI warm handoff, p50/p90 of per-query p50 | <150 p50 | 384 / 464 |
| CLI first search after sessions changed | <150 p50 | 5398 / 5508 |
| CLI first search of a fresh start (nothing resident) | <1000 | 406 / 507 |
| Hub fresh start: first search | <1000 | 174 / 201 |
| Hub fresh start: spawn → first results (incl. page load) |  | 5545, 4495, 5023 |
| UI top bar, last key → results (novel) | <100 p50, <200 p90 | 153 / 175 |
| UI Runs filter, Enter → rows (novel) | <100 p50, <200 p90 | 31 / 1106 (3 failed) |
| UI deep link /sessions?expr= → rows on screen |  | 226 / 297 |
| UI while agents write: top bar | <100 p50, <200 p90 | 162 / 183 |
| UI while agents write: Runs Enter | <100 p50, <200 p90 | 258 / 6386 (2 failed) |
| CLI while agents write | <150 p50 | 5624 / 5672 |
| UI during host pull: top bar | <100 p50, <200 p90 | 162 / 286 |
| UI during host pull: Runs Enter | <100 p50, <200 p90 | 34 / 3198 (2 failed) |
| Hub idle CPU % (60 s, settled) | <5 | 0 (RSS 1453 MB) |
| Hub idle CPU % after live load |  | 0 (RSS 2019 MB) |
| Hub CPU % while agents write |  | 31.3 |
| Cold index build (empty cache, CLI) |  | 49443 |

### base-0.5.5-mac-2: every query (ms; ✗ = over its limit, — = not run, T = timed out)

Head ?; corpus {}

| Query | CLI search | CLI handoff | CLI writing | CLI pull | Top bar p50 | Top bar p90 | Runs Enter p50 | Runs Enter p90 | Top bar writing | Runs writing | Top bar pull | Runs pull | Deep link p50 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| codex stop button | 409 ✗ | 393 ✗ | — | — | 130 ✗ | 164 | 23 | 23 | 153 | 258 ✗ | 154 | 30 | 197 |
| interrupt generation with one Stop | 425 ✗ | 387 ✗ | — | — | 131 ✗ | 177 | 19 | 22 | 162 | 498 ✗ | 167 | 136 | 129 |
| cursor support | 421 ✗ | 403 ✗ | — | — | 130 ✗ | 162 | 24 | 30 | 152 | 29 | 149 | 22 | 127 |
| runs page sorting | 376 ✗ | 364 ✗ | — | — | 129 ✗ | 151 | 59 | 2424 ✗ | 152 | 5144 ✗ | 158 | 34 | 112 |
| fix runs page sorting and search box | 374 ✗ | 365 ✗ | — | — | 131 ✗ | 169 | 28 | 30 | 167 | 2779 ✗ | 164 | 54 | 146 |
| open the failed call from what went wrong | 480 ✗ | 390 ✗ | — | — | 128 ✗ | 175 | 103 ✗ | 215 ✗ | 170 | 204 ✗ | 169 | 142 | 162 |
| what went wrong failed call | 520 ✗ | 388 ✗ | — | — | 128 ✗ | 170 | 36 | 38 | — | — | — | — | 129 |
| standup and handoff features | 401 ✗ | 384 ✗ | — | — | 132 ✗ | 151 | 30 | 44 | — | — | — | — | 114 |
| ui style design guidelines | 358 ✗ | 356 ✗ | — | — | 130 ✗ | 153 | 25 | 29 | — | — | — | — | — |
| harbor wordmark on dither canvas | 467 ✗ | 468 ✗ | — | — | 134 ✗ | 155 | 23 | 34 | — | — | — | — | — |
| harness hacks slide presentation | 428 ✗ | 387 ✗ | — | — | 129 ✗ | 152 | 63 | 65 | — | — | — | — | — |
| pre-wiring explainer video | 526 ✗ | 479 ✗ | — | — | 131 ✗ | 148 | 28 | 31 | — | — | — | — | — |
| more space between lines yes or no state | 542 ✗ | 518 ✗ | — | — | 131 ✗ | 169 | 115 ✗ | 143 | — | — | — | — | — |
| test agent store as an end user | 400 ✗ | 396 ✗ | — | — | 129 ✗ | 166 | 66 | 75 | — | — | — | — | — |
| readme diagram images redesign before after | 379 ✗ | 361 ✗ | — | — | 129 ✗ | 154 | 27 | 28 | — | — | — | — | — |
| draft render queued 40 minutes ago | 432 ✗ | 425 ✗ | — | — | 129 ✗ | 157 | 102 ✗ | 178 | — | — | — | — | — |
| "cannot contain whitespace" | 358 ✗ | 334 ✗ | — | — | 133 ✗ | 139 | T | T | — | — | — | — | — |
| parseSession | 371 ✗ | 387 ✗ | — | — | 134 ✗ | 154 | 95862 ✗ | 102088 ✗ | — | — | — | — | — |
| sidecar timeout | 370 ✗ | 356 ✗ | — | — | 128 ✗ | 152 | 21 | 24 | — | — | — | — | — |
| ssh import backoff | 387 ✗ | 355 ✗ | — | — | 131 ✗ | 146 | 24 | 24 | — | — | — | — | — |
| usage limits | 408 ✗ | 374 ✗ | — | — | 137 ✗ | 156 | 26 | 35 | — | — | — | — | — |
| insights stall | 357 ✗ | 345 ✗ | — | — | 138 ✗ | 149 | 31 | 33 | — | — | — | — | — |
| worktree origin remote | 508 ✗ | 464 ✗ | — | — | 133 ✗ | 151 | 63 | 97 | — | — | — | — | — |
| error handling | 405 ✗ | 401 ✗ | — | — | 132 ✗ | 153 | 28 | 33 | — | — | — | — | — |
| grok vktr | 351 ✗ | 350 ✗ | — | — | 133 ✗ | 147 | 27 | 34 | — | — | — | — | — |
| you're absolutely right | 403 ✗ | 381 ✗ | 5648 ✗ | — | 129 ✗ | 158 | 582 ✗ | 596 ✗ | 172 | 6386 ✗ | 168 | 3198 ✗ | — |
| absolutely right | 420 ✗ | 357 ✗ | 5531 ✗ | — | 130 ✗ | 149 | 22 | 36 | 149 | 5412 ✗ | 146 | 26 | — |
| let me | 497 ✗ | 449 ✗ | 5580 ✗ | — | 129 ✗ | 188 | 22 | 25 | 181 | 23 | 176 | 25 | — |
| I'll | 447 ✗ | 411 ✗ | 5624 ✗ | — | 132 ✗ | 153 | 21 | 37 | 169 | 23 | 148 | 52 | — |
| the | 437 ✗ | 410 ✗ | 5672 ✗ | — | 128 ✗ | 168 | 26 | 27 | 173 | 25 | 164 | 25 | — |
| now let me check | 429 ✗ | 419 ✗ | 5643 ✗ | — | 131 ✗ | 158 | 29 | 32 | 168 | 36 | 162 | 28 | — |
| "you're absolutely right" | 391 ✗ | 361 ✗ | — | — | 131 ✗ | 149 | T | T | 236 ✗ | T | 698 ✗ | T | — |
| "let me" | 338 ✗ | 341 ✗ | — | — | 131 ✗ | 152 | T | T | 147 | T | 142 | T | — |
| "absolutely right" | 390 ✗ | 344 ✗ | — | — | 133 ✗ | 137 | 25181 ✗ | 25347 ✗ | 135 | 26171 ✗ | 286 ✗ | 29678 ✗ | — |
| why does the sidecar near scan give a different score than the javascript scorer for codex sessions | 400 ✗ | 366 ✗ | — | — | 132 ✗ | 165 | 1088 ✗ | 1106 ✗ | 187 | 5194 ✗ | 684 ✗ | 2889 ✗ | — |
| make the runs page side panel stop blocking clicks on the list behind it when it is open | 526 ✗ | 463 ✗ | — | — | 135 ✗ | 186 | 1082 ✗ | 1141 ✗ | 183 | 2447 ✗ | 187 | 1547 ✗ | — |
| zstd | 333 ✗ | 312 ✗ | — | — | 132 ✗ | 144 | 31 | 31 | 143 | 26 | 141 | 81 | — |
| fsevents | 316 ✗ | 312 ✗ | — | — | 129 ✗ | 141 | 27 | 31 | 145 | 2554 ✗ | 141 | 25 | — |
| flock | 326 ✗ | 315 ✗ | — | — | 130 ✗ | 148 | 26 | 28 | 152 | 21 | 144 | 23 | — |

Queries over their limit: CLI search 39, CLI handoff 39, CLI writing 6, CLI pull 0, Top bar p50 39, Top bar p90 0, Runs Enter p50 11, Runs Enter p90 10, Top bar writing 1, Runs writing 13, Top bar pull 3, Runs pull 6, Deep link p50 0
