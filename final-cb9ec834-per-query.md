ms, p50 / p90 unless noted. Corpus: final5=16777 sessions.

| Condition | Target | final5 |
|---|---|---|
| CLI warm search, p50/p90 of per-query p50 | <150 p50 | 151 / 202 |
| CLI warm handoff, p50/p90 of per-query p50 | <150 p50 | 142 / 173 |
| CLI first search after sessions changed | <150 p50 | 186 / 254 |
| CLI first search of a fresh start (nothing resident) | <1000 | 426 / 556 |
| Hub fresh start: first search | <1000 | 230 / 2868 |
| Hub fresh start: spawn → first results (incl. page load) |  | 11714, 3428, 4002 |
| UI top bar, last key → results (novel) | <100 p50, <200 p90 | 34 / 82 |
| UI Runs filter, Enter → rows (novel) | <100 p50, <200 p90 | 45 / 132 |
| UI deep link /sessions?expr= → rows on screen |  | 176 / 208 |
| UI while agents write: top bar | <100 p50, <200 p90 | 56 / 227 |
| UI while agents write: Runs Enter | <100 p50, <200 p90 | 76 / 292 |
| CLI while agents write | <150 p50 | 156 / 248 |
| UI during host pull: top bar | <100 p50, <200 p90 | 35 / 103 |
| UI during host pull: Runs Enter | <100 p50, <200 p90 | 100 / 451 |
| Hub idle CPU % (60 s, settled) | <5 | 0 (RSS 1521 MB) |
| Hub idle CPU % after live load |  | 0 (RSS 2753 MB) |
| Hub CPU % while agents write |  | 83.2 |
| Cold index build (empty cache, CLI) |  | 57149 |

### final5: every query (ms; ✗ = over its limit, — = not run, T = timed out)

Head cb9ec834aeb2921286a0cd4042846879f23fdb4a; corpus {"copied":{"sessions":16957,"unique":16845},"heldOut":{"new":30,"pull":150,"active":8},"timed":{"sessions":16777,"unique":16665}}
Overlap while agents write: UI 86/86 queries, CLI 39/39 queries inside the writer window
Overlap during the host pull: UI 86/86 queries, CLI 39/39 queries inside the writer window

| Query | CLI search | CLI handoff | CLI writing | CLI pull | Top bar p50 | Top bar p90 | Runs Enter p50 | Runs Enter p90 | Top bar writing | Runs writing | Top bar pull | Runs pull | Deep link p50 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| codex stop button | 164 ✗ | 161 ✗ | 209 ✗ | 190 ✗ | 39 | 61 | 30 | 39 | 26 | 49 | 23 | 451 ✗ | 214 |
| interrupt generation with one Stop | 156 ✗ | 141 | 210 ✗ | 210 ✗ | 63 | 77 | 35 | 41 | 56 | 391 ✗ | 47 | 71 | 239 |
| cursor support | 168 ✗ | 168 ✗ | 278 ✗ | 191 ✗ | 36 | 39 | 45 | 46 | 37 | 4 | 49 | 47 | 162 |
| runs page sorting | 131 | 128 | 153 ✗ | 155 ✗ | 36 | 38 | 38 | 40 | 236 ✗ | 84 | 103 | 153 | 169 |
| fix runs page sorting and search box | 139 | 141 | 155 ✗ | 155 ✗ | 41 | 46 | 36 | 40 | 78 | 41 | 86 | 107 | 185 |
| open the failed call from what went wrong | 192 ✗ | 160 ✗ | 257 ✗ | 229 ✗ | 44 | 58 | 80 | 84 | 135 | 230 ✗ | 47 | 85 | 199 |
| what went wrong failed call | 212 ✗ | 155 ✗ | 246 ✗ | 222 ✗ | 40 | 42 | 83 | 85 | 48 | 35 | 32 | 148 | 177 |
| standup and handoff features | 159 ✗ | 157 ✗ | 157 ✗ | 184 ✗ | 36 | 38 | 46 | 48 | 227 ✗ | 274 ✗ | 33 | 256 ✗ | 152 |
| ui style design guidelines | 137 | 137 | 139 | 153 ✗ | 23 | 31 | 9 | 60 | 36 | 42 | 26 | 27 | — |
| harbor wordmark on dither canvas | 155 ✗ | 154 ✗ | 177 ✗ | 152 ✗ | 34 | 34 | 83 | 96 | 33 | 26 | 37 | 180 | — |
| harness hacks slide presentation | 140 | 139 | 164 ✗ | 168 ✗ | 28 | 32 | 34 | 57 | 147 | 83 | 28 | 52 | — |
| pre-wiring explainer video | 171 ✗ | 173 ✗ | 230 ✗ | 235 ✗ | 27 | 35 | 45 | 46 | 55 | 57 | 32 | 146 | — |
| more space between lines yes or no state | 256 ✗ | 246 ✗ | 292 ✗ | 247 ✗ | 83 | 121 | 73 | 75 | 115 | 138 | 76 | 198 | — |
| test agent store as an end user | 168 ✗ | 163 ✗ | 212 ✗ | 178 ✗ | 44 | 49 | 117 ✗ | 152 | 240 ✗ | 76 | 97 | 81 | — |
| readme diagram images redesign before after | 141 | 142 | 160 ✗ | 147 | 34 | 35 | 61 | 91 | 150 | 292 ✗ | 42 | 57 | — |
| draft render queued 40 minutes ago | 164 ✗ | 162 ✗ | 176 ✗ | 169 ✗ | 27 | 28 | 55 | 82 | 40 | 136 | 22 | 74 | — |
| "cannot contain whitespace" | 158 ✗ | 126 | 153 ✗ | 130 | 19 | 26 | 503 ✗ | 569 ✗ | 25 | 567 ✗ | 16 | 916 ✗ | — |
| parseSession | 147 | 149 | 155 ✗ | 154 ✗ | 33 | 40 | 36 | 59 | 97 | 35 | 80 | 341 ✗ | — |
| sidecar timeout | 145 | 142 | 188 ✗ | 186 ✗ | 33 | 34 | 43 | 44 | 227 ✗ | 44 | 32 | 45 | — |
| ssh import backoff | 151 ✗ | 143 | 150 | 145 | 28 | 37 | 57 | 57 | 81 | 42 | 33 | 67 | — |
| usage limits | 151 ✗ | 145 | 149 | 161 ✗ | 34 | 37 | 66 | 71 | 29 | 47 | 154 | 47 | — |
| insights stall | 138 | 135 | 141 | 135 | 19 | 19 | 40 | 43 | 28 | 76 | 28 | 335 ✗ | — |
| worktree origin remote | 175 ✗ | 171 ✗ | 197 ✗ | 191 ✗ | 84 | 96 | 49 | 96 | 152 | 64 | 99 | 100 | — |
| error handling | 157 ✗ | 156 ✗ | 157 ✗ | 153 ✗ | 23 | 24 | 45 | 55 | 24 | 104 | 29 | 142 | — |
| grok vktr | 134 | 135 | 141 | 175 ✗ | 25 | 31 | 48 | 50 | 33 | 45 | 29 | 47 | — |
| you're absolutely right | 143 | 140 | 146 | 165 ✗ | 155 ✗ | 182 | 350 ✗ | 357 ✗ | 100 | 262 ✗ | 188 | 187 | — |
| absolutely right | 149 | 129 | 156 ✗ | 176 ✗ | 34 | 34 | 39 | 40 | 28 | 32 | 24 | 40 | — |
| let me | 202 ✗ | 187 ✗ | 222 ✗ | 222 ✗ | 69 | 73 | 30 | 61 | 75 | 101 | 102 | 25 | — |
| I'll | 150 | 141 | 147 | 161 ✗ | 31 | 44 | 45 | 49 | 135 | 88 | 33 | 39 | — |
| the | 155 ✗ | 148 | 152 ✗ | 171 ✗ | 52 | 60 | 89 | 93 | 54 | 120 | 52 | 53 | — |
| now let me check | 173 ✗ | 168 ✗ | 181 ✗ | 176 ✗ | 36 | 73 | 66 | 90 | 52 | 50 | 42 | 629 ✗ | — |
| "you're absolutely right" | 137 | 115 | 149 | 129 | 21 | 26 | 390 ✗ | 465 ✗ | 29 | 112 | 22 | 140 | — |
| "let me" | 107 | 103 | 118 | 103 | 25 | 34 | 1670 ✗ | 1688 ✗ | 22 | 2259 ✗ | 37 | 2441 ✗ | — |
| "absolutely right" | 129 | 110 | 129 | 130 | 23 | 28 | 115 ✗ | 130 | 85 | 133 | 19 | 130 | — |
| why does the sidecar near scan give a different score than the javascript scorer for codex sessions | 145 | 135 | 151 ✗ | 146 | 44 | 47 | 89 | 93 | 115 | 108 | 75 | 112 | — |
| make the runs page side panel stop blocking clicks on the list behind it when it is open | 229 ✗ | 206 ✗ | 248 ✗ | 218 ✗ | 82 | 84 | 147 ✗ | 151 | 157 | 238 ✗ | 340 ✗ | 222 ✗ | — |
| zstd | 97 | 96 | 110 | 100 | 33 | 35 | 42 | 52 | 34 | 28 | 35 | 31 | — |
| fsevents | 97 | 96 | 105 | 113 | 26 | 37 | 28 | 29 | 24 | 26 | 25 | 32 | — |
| flock | 97 | 95 | 97 | 106 | 31 | 32 | 55 | 69 | 77 | 36 | 33 | 59 | — |

Queries over their limit: CLI search 20, CLI handoff 15, CLI writing 26, CLI pull 28, Top bar p50 1, Top bar p90 0, Runs Enter p50 7, Runs Enter p90 4, Top bar writing 4, Runs writing 8, Top bar pull 1, Runs pull 8, Deep link p50 0
