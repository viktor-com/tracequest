# Insights machine scope: finding 8 proof

Baseline: current GitHub origin/main `636d4d2d144208bac976bc77653f94254cd287d6` (0.4.0), verified via GitHub branch API on 15 October 2026. The audit brief expected a newer main; this is the actual current canonical main.

A byte-identical real Fedora Codex recording from 3 October was copied with its original timestamps into a disposable HOME. SHA-256: `7789ada9b795b07ba7da4bb63c3c25c212bb791942205672ecaf9d31e70ce8e1`. The real recording is deliberately not uploaded. Direct SSH and hub API access to the Mac timed out; the equivalent real recording permitted by Acceptance was used instead. No original recording was changed.

Real browser, actual `tracequest serve`, loopback port 18088, isolated tmux socket/session, no sidecar and no metered services. Browser console errors: none. Browser script: [browser-proof.mjs](browser-proof.mjs). Exact URL/control/result snapshots: [main.json](main.json), [branch.json](branch.json).

- Main: `?expr=source%3Acodex&days=7` becomes `?host=fedora`; source field clears, selected range becomes all time, 0 analysed sessions becomes 1 (the older recording leaks into the scope).
- Branch: same start becomes `?expr=source%3Acodex&days=7&host=fedora`; source field stays source:codex, selected range stays last 7 days, and the older recording stays excluded (0 analysed sessions).

| | Before clicking Fedora | After clicking Fedora |
|---|---|---|
| Current main | ![Main before](main-before.png) | ![Main after](main-after.png) |
| Fixed branch | ![Branch before](branch-before.png) | ![Branch after](branch-after.png) |

The new served-browser regression test fails on main at the lost-source assertion and passes on the fixed branch with no skips: [main test](test-main.txt), [branch test](test-branch.txt). It checks UI and API session counts with recent Codex recordings on Fedora/Mac/local, an older Fedora Codex recording, and a recent Fedora Claude recording. Selecting/switching/clearing machines, source-only, time-only and unfiltered navigation are covered.

Evidence is kept on a separate branch so the fix PR contains only the three-line production change, one new browser test and its fact. Full suites run in CI.
