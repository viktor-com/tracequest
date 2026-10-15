# Git activity labels: audit finding 12

Verified on 2026-10-15 against GitHub `origin/main` at `636d4d2` (0.4.0), confirmed by both `git ls-remote origin refs/heads/main` and the GitHub commits API. The shared local checkout was newer (0.9.0); it was not modified or used as the baseline. No CODING_STANDARDS file or domain facts section exists on this main; AGENTS.md and CONTRIBUTING.md were followed.

## Real recording, actual browser surface

The Mac hub was unreachable over HTTP and SSH. The fleet registry's `mac` entry resolves locally on this host, so its output was not treated as a Mac recording. Used an equivalent existing real Claude recording: the September 26 `apply-rest` workgraph session, `55a46e2a-bb93-4243-b7b8-b8f657a26a1f.jsonl`. Copied the entire recording without edits from the local Claude recording directory into a disposable HOME under `/tmp/tq-fix-12-evidence/home`. Source and copy SHA-256 both equal `59b00e0b59b1ceda7d59961ee1a4d392b0c923065fd6c0a0b8af76bfea26e454`. No source recording or hub was modified.

Started the real CLI `serve` with this HOME, port 37812, unique `TRACEQUEST_TMUX_SOCKET=tq-fix-12` and `TRACEQUEST_TMUX_SESSION=tq-fix-12`, and disabled sidecar, tmux, and reload watchers. Opened `/view?path=<copied recording>` in Playwright Chromium and read `.git-op-detail` from the rendered Git activity panel. All local test/server/browser processes were restricted to four CPUs and nice 19.

The recording contains `git checkout -q 035e4b09a1 -- $F`, a file restore, and `git commit -qam 'test(rest): parametrize native app slug membership checks (10 tests)' && git log --oneline -1 && python3 - <<'EOF'`, followed by Python source. The quiet commit output has a hash but no conventional `[branch hash] subject` line.

Before, browser DOM output on main:

```text
6c212b3p='viktor/backups/tests/test_phi_backups.py'
35723f8test(rest): parametrize scheduled backup date retries (3 tests)
switch to -q
Browser page errors: []
```

After, browser DOM output with the fix:

```text
6c212b3test(rest): parametrize native app slug membership checks (10 tests)
35723f8test(rest): parametrize scheduled backup date retries (3 tests)
Browser page errors: []
```

The source hash and second commit label are unchanged; the file restore is correctly absent from branch activity. Tool usage still shows Bash 30. Full-page screenshots were also captured locally as `/tmp/tq-fix-12-evidence/before.png` and `after.png`.

## Regression test

```sh
TRACEQUEST_SKIP_LR_WATCH=1 node --test --test-concurrency=1 test/browser/git-activity.playwright.test.js
```

This launches the real server with synthetic Claude JSONL in a temporary HOME, opens `/view` in Chromium, and asserts visible Git activity labels and no browser errors. Coverage includes quiet checkout/switch, file restore, ordinary branch creation, combined `-qam`, unrelated Python heredocs before and after a commit, a genuine commit-message heredoc, authoritative commit output, newline-separated commands, trailing checkout separators, semicolons in heredoc subjects, and `git -C` heredocs.

With the unchanged main implementation, the same test fails:

```text
+ switch to -q
+ switch to --quiet
+ switch to -q
- switch to main
- switch to topic
+ abc1234import re
+ def5678import os
- abc1234preserve the actual subject
- def5678plain subject
# pass 0
# fail 1
```

With the fix, the regression test and existing session-flyout browser test both pass (2 tests, 0 failures, 0 skips). Both `git-activity-12` facts pass. No existing tests or CI configuration were edited, and no dependencies were added. Facts: `zyu`, `mpv`.

## Review and CI

The fresh-context reviewer identified regressions in newline-separated branch commands, semicolon-containing heredocs, `git -C` heredocs, and trailing checkout separators. Each was fixed and added to the browser regression test.

CI is externally blocked: the existing CI workflow (`.github/workflows/ci.yml`) reports `disabled_manually`. `gh pr checks 26 --watch --fail-fast` reported no checks. A manual dispatch attempt returned HTTP 422: `Cannot trigger a workflow_dispatch on a disabled workflow`. No workflow state or CI configuration was changed; the PR must remain unmerged until green CI is available.

Fresh-context reviewer final verdict: **PASS, no unresolved findings**. Independently read the entire diff, inspected the real recording inputs/results and browser output, reran Git activity and existing flyout browser tests (2 passed, 0 skipped), verified unchanged source-recording hash and clean diff, and reran tagged facts in isolation (2 passed). One earlier facts invocation run concurrently with browser tests failed before the isolated rerun passed. Reviewer made no code or source-recording changes and closed all browsers.
