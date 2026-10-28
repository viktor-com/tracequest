ms, p50 / p90 unless noted. Corpus: final7-c2ada00a=16777 sessions.

| Condition | Target | final7-c2ada00a |
|---|---|---|
| CLI warm search, p50/p90 of per-query p50 | <150 p50 | 149 / 200 |
| CLI warm handoff, p50/p90 of per-query p50 | <150 p50 | 142 / 188 |
| CLI first search after sessions changed | <150 p50 | 161 / 234 |
| CLI first search of a fresh start (nothing resident) | <1000 | — |
| Hub fresh start: first search | <1000 | 232 / 1593 |
| Hub fresh start: spawn → first results (incl. page load) |  | 10547, 3457, 4074 |
| UI top bar, last key → results (novel) | <100 p50, <200 p90 | 33 / 76 |
| UI Runs filter, Enter → rows (novel) | <100 p50, <200 p90 | 45 / 134 |
| UI Runs filter, Enter → complete count (novel) | <100 p50, <200 p90 | 45 / 142 |
| UI deep link /sessions?expr= → rows on screen |  | 149 / 237 |
| UI while agents write: top bar | <100 p50, <200 p90 | 39 / 129 |
| UI while agents write: Runs Enter | <100 p50, <200 p90 | 59 / 271 |
| UI while agents write: Runs complete count | <100 p50, <200 p90 | 59 / 402 |
| CLI while agents write | <150 p50 | 164 / 238 |
| UI during host pull: top bar | <100 p50, <200 p90 | 34 / 91 |
| UI during host pull: Runs Enter | <100 p50, <200 p90 | 46 / 192 |
| UI during host pull: Runs complete count | <100 p50, <200 p90 | 46 / 261 |
| Hub idle CPU % (60 s, settled) | <5 | 0 (RSS 1763 MB) |
| Hub idle CPU % after live load |  | 0 (RSS 2256 MB) |
| Hub CPU % while agents write |  | 75.8 |
| Cold index build (empty cache, CLI) |  | 65335 |

### final7-c2ada00a: every query (ms; ✗ = over its limit, — = not run, T = timed out)

Head c2ada00aa47560072482d9d33e0b22a96cc05046; corpus {"copied":{"sessions":16957,"unique":16845},"heldOut":{"new":30,"pull":150,"active":8},"timed":{"sessions":16777,"unique":16665}}
Overlap while agents write: UI 86/86 queries, CLI 39/39 queries inside the writer window
Overlap during the host pull: UI 86/86 queries, CLI 39/39 queries inside the writer window

| Query | CLI search | CLI handoff | CLI writing | CLI pull | Top bar p50 | Top bar p90 | Runs Enter p50 | Runs Enter p90 | Runs count complete p50 | Top bar writing | Runs writing | Runs complete writing | Top bar pull | Runs pull | Runs complete pull | Deep link p50 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| codex stop button | 164 ✗ | 160 ✗ | 212 ✗ | 177 ✗ | 32 | 38 | 28 | 62 | 28 | 32 | 27 | 27 | 35 | 7 | 7 | 150 |
| interrupt generation with one Stop | 149 | 144 | 195 ✗ | 158 ✗ | 36 | 36 | 100 ✗ | 104 | 100 | 70 | 31 | 31 | 28 | 50 | 50 | 151 |
| cursor support | 170 ✗ | 164 ✗ | 195 ✗ | 175 ✗ | 29 | 33 | 54 | 59 | 54 | 38 | 134 | 134 | 91 | 60 | 60 | 135 |
| runs page sorting | 136 | 137 | 137 | 145 | 51 | 52 | 38 | 41 | 38 | 37 | 40 | 40 | 36 | 31 | 31 | 132 |
| fix runs page sorting and search box | 139 | 138 | 149 | 145 | 40 | 46 | 31 | 35 | 31 | 44 | 144 | 144 | 223 ✗ | 33 | 33 | 160 |
| open the failed call from what went wrong | 185 ✗ | 163 ✗ | 238 ✗ | 215 ✗ | 43 | 45 | 69 | 72 | 69 | 46 | 96 | 96 | 47 | 85 | 85 | 237 |
| what went wrong failed call | 200 ✗ | 156 ✗ | 187 ✗ | 196 ✗ | 36 | 39 | 30 | 37 | 30 | 39 | 42 | 42 | 40 | 40 | 40 | 217 |
| standup and handoff features | 165 ✗ | 165 ✗ | 164 ✗ | 161 ✗ | 31 | 35 | 40 | 56 | 40 | 28 | 81 | 81 | 39 | 44 | 44 | 160 |
| ui style design guidelines | 141 | 133 | 150 | 136 | 31 | 36 | 50 | 61 | 50 | 111 | 37 | 37 | 19 | 64 | 64 | — |
| harbor wordmark on dither canvas | 152 ✗ | 150 ✗ | 184 ✗ | 172 ✗ | 31 | 33 | 37 | 57 | 37 | 27 | 84 | 84 | 31 | 6 | 6 | — |
| harness hacks slide presentation | 141 | 136 | 146 | 155 ✗ | 29 | 42 | 30 | 36 | 30 | 17 | 57 | 57 | 27 | 46 | 46 | — |
| pre-wiring explainer video | 191 ✗ | 188 ✗ | 208 ✗ | 184 ✗ | 35 | 36 | 46 | 58 | 46 | 129 | 4 | 4 | 24 | 46 | 46 | — |
| more space between lines yes or no state | 254 ✗ | 250 ✗ | 279 ✗ | 308 ✗ | 72 | 76 | 79 | 79 | 79 | 424 ✗ | 75 | 75 | 92 | 66 | 66 | — |
| test agent store as an end user | 168 ✗ | 183 ✗ | 189 ✗ | 195 ✗ | 49 | 50 | 75 | 81 | 75 | 39 | 271 ✗ | 271 ✗ | 59 | 75 | 75 | — |
| readme diagram images redesign before after | 147 | 139 | 149 | 144 | 37 | 42 | 39 | 40 | 39 | 56 | 82 | 82 | 37 | 32 | 32 | — |
| draft render queued 40 minutes ago | 171 ✗ | 160 ✗ | 215 ✗ | 175 ✗ | 33 | 38 | 46 | 48 | 46 | 24 | 44 | 44 | 35 | 32 | 32 | — |
| "cannot contain whitespace" | 143 | 117 | 211 ✗ | 127 | 19 | 29 | 134 ✗ | 140 | 569 ✗ | 20 | 248 ✗ | 1093 ✗ | 11 | 192 | 622 ✗ | — |
| parseSession | 149 | 148 | 154 ✗ | 159 ✗ | 30 | 34 | 28 | 46 | 28 | 51 | 3 | 3 | 31 | 284 ✗ | 284 ✗ | — |
| sidecar timeout | 149 | 142 | 150 | 141 | 32 | 33 | 46 | 54 | 46 | 19 | 59 | 59 | 33 | 44 | 44 | — |
| ssh import backoff | 149 | 139 | 154 ✗ | 156 ✗ | 26 | 32 | 46 | 59 | 46 | 84 | 277 ✗ | 277 ✗ | 27 | 7 | 7 | — |
| usage limits | 151 ✗ | 151 ✗ | 148 | 151 ✗ | 31 | 31 | 45 | 50 | 45 | 29 | 59 | 59 | 29 | 47 | 47 | — |
| insights stall | 142 | 139 | 137 | 137 | 23 | 26 | 36 | 52 | 36 | 28 | 43 | 43 | 29 | 77 | 77 | — |
| worktree origin remote | 173 ✗ | 163 ✗ | 184 ✗ | 182 ✗ | 74 | 83 | 55 | 96 | 55 | 60 | 430 ✗ | 430 ✗ | 51 | 3 | 3 | — |
| error handling | 159 ✗ | 160 ✗ | 168 ✗ | 154 ✗ | 25 | 26 | 3 | 22 | 3 | 28 | 35 | 35 | 27 | 22 | 22 | — |
| grok vktr | 144 | 142 | 133 | 135 | 19 | 26 | 37 | 45 | 37 | 124 | 67 | 67 | 21 | 39 | 39 | — |
| you're absolutely right | 149 | 140 | 165 ✗ | 150 | 106 ✗ | 113 | 64 | 96 | 64 | 77 | 57 | 57 | 90 | 156 | 156 | — |
| absolutely right | 152 ✗ | 132 | 171 ✗ | 156 ✗ | 23 | 36 | 37 | 40 | 37 | 71 | 37 | 37 | 19 | 43 | 43 | — |
| let me | 210 ✗ | 191 ✗ | 240 ✗ | 216 ✗ | 61 | 79 | 32 | 57 | 32 | 50 | 36 | 36 | 64 | 7 | 7 | — |
| I'll | 144 | 128 | 135 | 137 | 33 | 34 | 57 | 58 | 57 | 29 | 56 | 56 | 33 | 43 | 43 | — |
| the | 153 ✗ | 146 | 158 ✗ | 155 ✗ | 54 | 56 | 48 | 61 | 48 | 54 | 10 | 10 | 57 | 61 | 61 | — |
| now let me check | 175 ✗ | 169 ✗ | 167 ✗ | 175 ✗ | 44 | 53 | 46 | 66 | 46 | 47 | 95 | 95 | 44 | 46 | 46 | — |
| "you're absolutely right" | 164 ✗ | 110 | 161 ✗ | 133 | 27 | 33 | 142 ✗ | 151 | 142 | 32 | 259 ✗ | 259 ✗ | 29 | 160 | 160 | — |
| "let me" | 104 | 96 | 154 ✗ | 95 | 26 | 32 | 162 ✗ | 163 | 1158 ✗ | 26 | 151 | 1179 ✗ | 21 | 199 | 1225 ✗ | — |
| "absolutely right" | 129 | 115 | 137 | 128 | 27 | 32 | 215 ✗ | 291 ✗ | 215 ✗ | 20 | 402 ✗ | 402 ✗ | 25 | 261 ✗ | 261 ✗ | — |
| why does the sidecar near scan give a different score than the javascript scorer for codex sessions | 145 | 140 | 269 ✗ | 150 | 45 | 48 | 79 | 99 | 79 | 212 ✗ | 112 | 112 | 48 | 84 | 84 | — |
| make the runs page side panel stop blocking clicks on the list behind it when it is open | 214 ✗ | 213 ✗ | 236 ✗ | 224 ✗ | 122 ✗ | 158 | 133 ✗ | 192 | 133 | 311 ✗ | 125 | 125 | 71 | 132 | 132 | — |
| zstd | 99 | 101 | 105 | 105 | 18 | 18 | 30 | 32 | 30 | 32 | 37 | 37 | 34 | 39 | 39 | — |
| fsevents | 107 | 102 | 100 | 115 | 26 | 28 | 30 | 39 | 30 | 21 | 32 | 32 | 210 ✗ | 32 | 32 | — |
| flock | 93 | 98 | 100 | 100 | 30 | 30 | 34 | 44 | 34 | 27 | 119 | 119 | 22 | 37 | 37 | — |

Queries over their limit: CLI search 19, CLI handoff 16, CLI writing 25, CLI pull 22, Top bar p50 2, Top bar p90 0, Runs Enter p50 6, Runs Enter p90 1, Runs count complete p50 3, Top bar writing 3, Runs writing 6, Runs complete writing 7, Top bar pull 2, Runs pull 2, Runs complete pull 4, Deep link p50 0
