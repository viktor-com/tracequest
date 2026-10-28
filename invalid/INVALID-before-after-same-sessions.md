ms, p50 / p90 unless noted. Corpus: base-0.5.5-same=16777 sessions, final5=16777 sessions.

| Condition | Target | base-0.5.5-same | final5 |
|---|---|---|---|
| CLI warm search, p50/p90 of per-query p50 | <150 p50 | 304 / 330 | 151 / 202 |
| CLI warm handoff, p50/p90 of per-query p50 | <150 p50 | 299 / 333 | 142 / 173 |
| CLI first search after sessions changed | <150 p50 | 838 / 883 | 186 / 254 |
| CLI first search of a fresh start (nothing resident) | <1000 | 326 / 368 | 426 / 556 |
| Hub fresh start: first search | <1000 | 148 / 148 | 230 / 2868 |
| Hub fresh start: spawn → first results (incl. page load) |  | 3337, 2384, 2917 | 11714, 3428, 4002 |
| UI top bar, last key → results (novel) | <100 p50, <200 p90 | 140 / 148 | 34 / 82 |
| UI Runs filter, Enter → rows (novel) | <100 p50, <200 p90 | 28 / 56 | 45 / 132 |
| UI deep link /sessions?expr= → rows on screen |  | 83 / 88 | 176 / 208 |
| UI while agents write: top bar | <100 p50, <200 p90 | 138 / 196 | 56 / 227 |
| UI while agents write: Runs Enter | <100 p50, <200 p90 | 29 / 328 | 76 / 292 |
| CLI while agents write | <150 p50 | 867 / 943 | 156 / 248 |
| UI during host pull: top bar | <100 p50, <200 p90 | 138 / 143 | 35 / 103 |
| UI during host pull: Runs Enter | <100 p50, <200 p90 | 27 / 185 | 100 / 451 |
| Hub idle CPU % (60 s, settled) | <5 | 0 (RSS 444 MB) | 0 (RSS 1521 MB) |
| Hub idle CPU % after live load |  | 0 (RSS 854 MB) | 0 (RSS 2753 MB) |
| Hub CPU % while agents write |  | 24.6 | 83.2 |
| Cold index build (empty cache, CLI) |  | 6083 | 57149 |
