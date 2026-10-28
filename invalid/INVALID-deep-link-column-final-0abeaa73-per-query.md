ms, p50 / p90 unless noted. Corpus: final4-0.5.9=16777 sessions.

| Condition | Target | final4-0.5.9 |
|---|---|---|
| CLI warm search, p50/p90 of per-query p50 | <150 p50 | 151 / 208 |
| CLI warm handoff, p50/p90 of per-query p50 | <150 p50 | 146 / 174 |
| CLI first search after sessions changed | <150 p50 | 163 / 245 |
| CLI first search of a fresh start (nothing resident) | <1000 | 424 / 500 |
| Hub fresh start: first search | <1000 | 261 / 2702 |
| Hub fresh start: spawn → first results (incl. page load) |  | 11690, 3426, 3981 |
| UI top bar, last key → results (novel) | <100 p50, <200 p90 | 33 / 71 |
| UI Runs filter, Enter → rows (novel) | <100 p50, <200 p90 | 33 / 138 |
| UI deep link /sessions?filter= → rows | — | — |
| UI while agents write: top bar | <100 p50, <200 p90 | 47 / 140 |
| UI while agents write: Runs Enter | <100 p50, <200 p90 | 73 / 170 |
| CLI while agents write | <150 p50 | 166 / 221 |
| UI during host pull: top bar | <100 p50, <200 p90 | 38 / 83 |
| UI during host pull: Runs Enter | <100 p50, <200 p90 | 62 / 214 |
| Hub idle CPU % (60 s, settled) | <5 | 0 (RSS 1524 MB) |
| Hub idle CPU % after live load |  | 0 (RSS 3364 MB) |
| Hub CPU % while agents write |  | 74.4 |
| Cold index build (empty cache, CLI) |  | 56414 |

### final4-0.5.9: every query (ms; ✗ = over its limit, — = not run, T = timed out)

Head 0abeaa736d6ce350570aa453ba5439c798ec7945; corpus {"copied":{"sessions":16957,"unique":16845},"heldOut":{"new":30,"pull":150,"active":8},"timed":{"sessions":16777,"unique":16665}}
Overlap while agents write: UI 48/48 queries, CLI 20/20 queries inside the writer window
Overlap during the host pull: UI 48/48 queries, CLI 20/20 queries inside the writer window

| Query | CLI search | CLI handoff | CLI writing | CLI pull | Top bar | Runs Enter | Top bar writing | Runs writing | Top bar pull | Runs pull |
|---|---|---|---|---|---|---|---|---|---|---|
| codex stop button | 165 ✗ | 160 ✗ | 210 ✗ | 188 ✗ | 65 | 7 | 36 | 170 | 33 | 111 |
| interrupt generation with one Stop | 166 ✗ | 146 | 166 ✗ | 155 ✗ | 71 | 55 | 114 | 106 | 45 | 35 |
| cursor support | 176 ✗ | 169 ✗ | 182 ✗ | 181 ✗ | 21 | 23 | 225 ✗ | 26 | 46 | 51 |
| runs page sorting | 132 | 135 | 140 | 129 | 45 | 39 | 107 | 38 | 23 | 115 |
| fix runs page sorting and search box | 141 | 138 | 146 | 149 | 37 | 28 | 32 | 112 | 29 | 117 |
| open the failed call from what went wrong | 197 ✗ | 156 ✗ | 221 ✗ | 192 ✗ | 41 | 80 | 172 | 73 | 48 | 111 |
| what went wrong failed call | 208 ✗ | 158 ✗ | — | — | 44 | 48 | — | — | — | — |
| standup and handoff features | 163 ✗ | 163 ✗ | — | — | 35 | 20 | — | — | — | — |
| ui style design guidelines | 138 | 135 | — | — | 24 | 6 | — | — | — | — |
| harbor wordmark on dither canvas | 151 ✗ | 153 ✗ | — | — | 25 | 32 | — | — | — | — |
| harness hacks slide presentation | 142 | 144 | — | — | 22 | 34 | — | — | — | — |
| pre-wiring explainer video | 177 ✗ | 174 ✗ | — | — | 26 | 30 | — | — | — | — |
| more space between lines yes or no state | 252 ✗ | 250 ✗ | — | — | 75 | 79 | — | — | — | — |
| test agent store as an end user | 169 ✗ | 171 ✗ | — | — | 51 | 70 | — | — | — | — |
| readme diagram images redesign before after | 141 | 141 | — | — | 33 | 78 | — | — | — | — |
| draft render queued 40 minutes ago | 162 ✗ | 163 ✗ | — | — | 35 | 51 | — | — | — | — |
| "cannot contain whitespace" | 145 | 118 | — | — | 14 | 591 ✗ | — | — | — | — |
| parseSession | 153 ✗ | 148 | — | — | 41 | 21 | — | — | — | — |
| sidecar timeout | 150 ✗ | 151 ✗ | — | — | 20 | 22 | — | — | — | — |
| ssh import backoff | 149 | 145 | — | — | 27 | 28 | — | — | — | — |
| usage limits | 152 ✗ | 152 ✗ | — | — | 28 | 37 | — | — | — | — |
| insights stall | 135 | 134 | — | — | 33 | 23 | — | — | — | — |
| worktree origin remote | 180 ✗ | 173 ✗ | — | — | 90 | 8 | — | — | — | — |
| error handling | 161 ✗ | 164 ✗ | — | — | 32 | 30 | — | — | — | — |
| grok vktr | 135 | 132 | — | — | 20 | 22 | — | — | — | — |
| you're absolutely right | 141 | 134 | 166 ✗ | 149 | 46 | 299 ✗ | 34 | 134 | 61 | 214 ✗ |
| absolutely right | 146 | 133 | 172 ✗ | 177 ✗ | 31 | 33 | 123 | 56 | 29 | 35 |
| let me | 216 ✗ | 198 ✗ | 245 ✗ | 205 ✗ | 61 | 26 | 56 | 51 | 163 | 52 |
| I'll | 151 ✗ | 137 | 168 ✗ | 166 ✗ | 45 | 33 | 33 | 25 | 36 | 34 |
| the | 158 ✗ | 150 | 178 ✗ | 164 ✗ | 37 | 23 | 51 | 30 | 55 | 7 |
| now let me check | 178 ✗ | 168 ✗ | 176 ✗ | 165 ✗ | 55 | 40 | 140 | 93 | 249 ✗ | 62 |
| "you're absolutely right" | 141 | 116 | 158 ✗ | 131 | 33 | 115 | 23 | 467 ✗ | 38 | 150 |
| "let me" | 101 | 105 | 116 | 114 | 22 | 1868 ✗ | 43 | 1628 ✗ | 25 | 2040 ✗ |
| "absolutely right" | 134 | 109 | 127 | 127 | 24 | 138 | 47 | 103 | 18 | 95 |
| why does the sidecar near scan give a different score than the javascript scorer for codex sessions | 156 ✗ | 136 | 154 ✗ | 166 ✗ | 36 | 81 | 107 | 94 | 71 | 104 |
| make the runs page side panel stop blocking clicks on the list behind it when it is open | 226 ✗ | 209 ✗ | 239 ✗ | 221 ✗ | 82 | 127 | 73 | 123 | 54 | 578 ✗ |
| zstd | 100 | 97 | 119 | 103 | 33 | 19 | 36 | 25 | 32 | 29 |
| fsevents | 95 | 96 | 107 | 100 | 18 | 23 | 19 | 46 | 25 | 26 |
| flock | 95 | 98 | 108 | 116 | 17 | 27 | 32 | 30 | 83 | 35 |

Queries over their limit: CLI search 22, CLI handoff 17, CLI writing 13, CLI pull 11, Top bar 0, Runs Enter 3, Top bar writing 1, Runs writing 2, Top bar pull 1, Runs pull 3
