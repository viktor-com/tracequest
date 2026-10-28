ms, p50 / p90 unless noted. Corpus: final8-8c64677b=16777 sessions.

| Condition | Target | final8-8c64677b |
|---|---|---|
| CLI warm search, p50/p90 of per-query p50 | <150 p50 | 152 / 205 |
| CLI warm handoff, p50/p90 of per-query p50 | <150 p50 | 149 / 189 |
| CLI first search after sessions changed | <150 p50 | 161 / 231 |
| CLI first search of a fresh start (nothing resident) | <1000 | 431 / 514 |
| Hub fresh start: first search | <1000 | 277 / 1640 |
| Hub fresh start: spawn → first results (incl. page load) |  | 10691, 3565, 3958 |
| UI top bar, last key → results (novel) | <100 p50, <200 p90 | 31 / 51 |
| UI Runs filter, Enter → rows (novel) | <100 p50, <200 p90 | 46 / 136 |
| UI Runs filter, Enter → complete count (novel) | <100 p50, <200 p90 | 46 / 138 |
| UI deep link /sessions?expr= → rows on screen |  | 160 / 182 |
| UI while agents write: top bar | <100 p50, <200 p90 | 40 / 155 |
| UI while agents write: Runs Enter | <100 p50, <200 p90 | 67 / 235 |
| UI while agents write: Runs complete count | <100 p50, <200 p90 | 67 / 411 |
| CLI while agents write | <150 p50 | 163 / 221 |
| UI during host pull: top bar | <100 p50, <200 p90 | 37 / 120 |
| UI during host pull: Runs Enter | <100 p50, <200 p90 | 57 / 237 |
| UI during host pull: Runs complete count | <100 p50, <200 p90 | 57 / 245 |
| Hub idle CPU % (60 s, settled) | <5 | 0 (RSS 1754 MB) |
| Hub idle CPU % after live load |  | 0 (RSS 2306 MB) |
| Hub CPU % while agents write |  | 72.1 |
| Cold index build (empty cache, CLI) |  | 54483 |

### final8-8c64677b: every query (ms; ✗ = over its limit, — = not run, T = timed out)

Head 8c64677b58605bfc70d8d4e3d020058e02bc8c4a; corpus {"copied":{"sessions":16957,"unique":16845},"heldOut":{"new":30,"pull":150,"active":8},"timed":{"sessions":16777,"unique":16665}}
Overlap while agents write: UI 86/86 queries, CLI 39/39 queries inside the writer window
Overlap during the host pull: UI 86/86 queries, CLI 39/39 queries inside the writer window

| Query | CLI search | CLI handoff | CLI writing | CLI pull | Top bar p50 | Top bar p90 | Runs Enter p50 | Runs Enter p90 | Runs count complete p50 | Top bar writing | Runs writing | Runs complete writing | Top bar pull | Runs pull | Runs complete pull | Deep link p50 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| codex stop button | 168 ✗ | 161 ✗ | 200 ✗ | 188 ✗ | 29 | 34 | 8 | 10 | 8 | 43 | 61 | 61 | 31 | 5 | 5 | 161 |
| interrupt generation with one Stop | 175 ✗ | 164 ✗ | 190 ✗ | 177 ✗ | 36 | 41 | 71 | 122 | 71 | 59 | 446 ✗ | 446 ✗ | 38 | 49 | 49 | 160 |
| cursor support | 187 ✗ | 177 ✗ | 188 ✗ | 182 ✗ | 22 | 37 | 46 | 57 | 46 | 41 | 58 | 58 | 74 | 61 | 61 | 142 |
| runs page sorting | 132 | 134 | 172 ✗ | 175 ✗ | 33 | 48 | 39 | 68 | 39 | 33 | 62 | 62 | 33 | 34 | 34 | 149 |
| fix runs page sorting and search box | 140 | 134 | 163 ✗ | 167 ✗ | 30 | 44 | 31 | 32 | 31 | 85 | 39 | 39 | 254 ✗ | 32 | 32 | 162 |
| open the failed call from what went wrong | 191 ✗ | 159 ✗ | 276 ✗ | 239 ✗ | 46 | 50 | 71 | 96 | 71 | 49 | 124 | 124 | 55 | 84 | 84 | 182 |
| what went wrong failed call | 193 ✗ | 159 ✗ | 206 ✗ | 202 ✗ | 43 | 47 | 46 | 54 | 46 | 38 | 67 | 67 | 42 | 40 | 40 | 179 |
| standup and handoff features | 172 ✗ | 157 ✗ | 163 ✗ | 175 ✗ | 30 | 39 | 39 | 54 | 39 | 41 | 68 | 68 | 33 | 28 | 28 | 180 |
| ui style design guidelines | 140 | 140 | 140 | 155 ✗ | 28 | 41 | 6 | 6 | 6 | 107 | 28 | 28 | 24 | 237 ✗ | 237 ✗ | — |
| harbor wordmark on dither canvas | 153 ✗ | 147 | 171 ✗ | 204 ✗ | 30 | 40 | 37 | 75 | 37 | 26 | 190 | 190 | 25 | 34 | 34 | — |
| harness hacks slide presentation | 134 | 135 | 146 | 173 ✗ | 22 | 36 | 42 | 95 | 42 | 37 | 69 | 69 | 36 | 327 ✗ | 327 ✗ | — |
| pre-wiring explainer video | 205 ✗ | 189 ✗ | 197 ✗ | 192 ✗ | 36 | 36 | 45 | 46 | 45 | 25 | 33 | 33 | 37 | 86 | 86 | — |
| more space between lines yes or no state | 251 ✗ | 263 ✗ | 288 ✗ | 299 ✗ | 70 | 71 | 79 | 81 | 79 | 71 | 162 | 162 | 83 | 199 | 199 | — |
| test agent store as an end user | 171 ✗ | 168 ✗ | 169 ✗ | 176 ✗ | 49 | 53 | 69 | 112 | 69 | 48 | 70 | 70 | 44 | 87 | 87 | — |
| readme diagram images redesign before after | 143 | 140 | 149 | 143 | 41 | 43 | 46 | 90 | 46 | 110 | 83 | 83 | 27 | 46 | 46 | — |
| draft render queued 40 minutes ago | 165 ✗ | 166 ✗ | 175 ✗ | 186 ✗ | 30 | 41 | 48 | 54 | 48 | 23 | 78 | 78 | 31 | 108 | 108 | — |
| "cannot contain whitespace" | 114 | 113 | 120 | 121 | 30 | 33 | 157 ✗ | 161 | 586 ✗ | 25 | 166 | 624 ✗ | 14 | 386 ✗ | 832 ✗ | — |
| parseSession | 156 ✗ | 149 | 164 ✗ | 162 ✗ | 29 | 34 | 47 | 51 | 47 | 37 | 36 | 36 | 83 | 50 | 50 | — |
| sidecar timeout | 149 | 149 | 159 ✗ | 149 | 21 | 34 | 40 | 44 | 40 | 91 | 411 ✗ | 411 ✗ | 31 | 36 | 36 | — |
| ssh import backoff | 150 ✗ | 149 | 152 ✗ | 174 ✗ | 32 | 55 | 53 | 54 | 53 | 33 | 7 | 7 | 29 | 52 | 52 | — |
| usage limits | 163 ✗ | 156 ✗ | 162 ✗ | 160 ✗ | 29 | 38 | 55 | 58 | 55 | 30 | 42 | 42 | 33 | 39 | 39 | — |
| insights stall | 137 | 141 | 158 ✗ | 139 | 25 | 39 | 38 | 44 | 38 | 27 | 45 | 45 | 21 | 42 | 42 | — |
| worktree origin remote | 175 ✗ | 179 ✗ | 190 ✗ | 195 ✗ | 51 | 79 | 36 | 59 | 36 | 86 | 59 | 59 | 39 | 69 | 69 | — |
| error handling | 165 ✗ | 155 ✗ | 170 ✗ | 164 ✗ | 26 | 29 | 21 | 35 | 21 | 196 | 56 | 56 | 26 | 46 | 46 | — |
| grok vktr | 135 | 132 | 149 | 145 | 33 | 34 | 42 | 42 | 42 | 23 | 26 | 26 | 20 | 154 | 154 | — |
| you're absolutely right | 148 | 139 | 221 ✗ | 152 ✗ | 103 ✗ | 186 | 89 | 108 | 89 | 53 | 79 | 79 | 120 | 70 | 70 | — |
| absolutely right | 152 ✗ | 133 | 156 ✗ | 207 ✗ | 22 | 33 | 44 | 44 | 44 | 33 | 40 | 40 | 104 | 48 | 48 | — |
| let me | 212 ✗ | 203 ✗ | 203 ✗ | 211 ✗ | 79 | 82 | 56 | 57 | 56 | 65 | 38 | 38 | 60 | 57 | 57 | — |
| I'll | 139 | 133 | 148 | 144 | 36 | 36 | 49 | 50 | 49 | 31 | 42 | 42 | 31 | 41 | 41 | — |
| the | 166 ✗ | 152 ✗ | 170 ✗ | 157 ✗ | 51 | 54 | 60 | 60 | 60 | 171 | 4 | 4 | 52 | 76 | 76 | — |
| now let me check | 171 ✗ | 169 ✗ | 178 ✗ | 171 ✗ | 47 | 49 | 59 | 68 | 59 | 40 | 90 | 90 | 273 ✗ | 61 | 61 | — |
| "you're absolutely right" | 118 | 110 | 127 | 119 | 30 | 36 | 145 ✗ | 147 | 145 ✗ | 155 | 220 ✗ | 220 ✗ | 82 | 245 ✗ | 245 ✗ | — |
| "let me" | 103 | 103 | 110 | 97 | 26 | 30 | 161 ✗ | 178 | 1188 ✗ | 25 | 330 ✗ | 1657 ✗ | 24 | 196 | 1607 ✗ | — |
| "absolutely right" | 114 | 100 | 111 | 114 | 22 | 28 | 156 ✗ | 175 | 156 ✗ | 12 | 223 ✗ | 223 ✗ | 22 | 179 | 179 | — |
| why does the sidecar near scan give a different score than the javascript scorer for codex sessions | 148 | 139 | 153 ✗ | 153 ✗ | 43 | 47 | 132 ✗ | 142 | 132 ✗ | 77 | 80 | 80 | 56 | 112 | 112 | — |
| make the runs page side panel stop blocking clicks on the list behind it when it is open | 206 ✗ | 213 ✗ | 221 ✗ | 206 ✗ | 74 | 82 | 189 ✗ | 213 ✗ | 189 ✗ | 162 | 235 ✗ | 235 ✗ | 134 | 163 | 163 | — |
| zstd | 98 | 104 | 107 | 96 | 18 | 36 | 31 | 31 | 31 | 17 | 26 | 26 | 84 | 29 | 29 | — |
| fsevents | 101 | 93 | 96 | 112 | 22 | 33 | 34 | 38 | 34 | 28 | 213 ✗ | 213 ✗ | 29 | 30 | 30 | — |
| flock | 96 | 95 | 101 | 100 | 26 | 32 | 35 | 37 | 35 | 29 | 30 | 30 | 76 | 32 | 32 | — |

Queries over their limit: CLI search 21, CLI handoff 17, CLI writing 27, CLI pull 27, Top bar p50 1, Top bar p90 0, Runs Enter p50 6, Runs Enter p90 1, Runs count complete p50 6, Top bar writing 0, Runs writing 7, Runs complete writing 8, Top bar pull 2, Runs pull 4, Runs complete pull 5, Deep link p50 0
