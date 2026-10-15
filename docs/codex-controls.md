# Codex Send and Stop regression evidence

On 15 October 2026, fetched `origin/main` was `636d4d2` (version 0.4.0).
Both browser reproductions fail there and pass with this fix using native
Codex v0.161.0. [Native test output](codex-controls/native-results.txt) records
both runs. The API compatibility check uses the branch handler in both runs;
the two browser cases start the server from the selected checkout.

The tests run real tracequest serve, Chromium, tmux, and native Codex. A local
Responses stream supplies deterministic replies without paid model calls.
Each native case first creates a genuine Codex recording with `codex exec`,
copies it into a fresh scratch HOME, and resumes the copy through tracequest.
The source recording is disposable and unchanged. The Mac hub was unreachable
from this host, so these equivalent recordings replace the audit witness.
No real user traces or credentials are included here.

| Action | Main | Fixed |
| --- | --- | --- |
| One Send | [Text remains in native prompt](codex-controls/before-send.png) | [Follow-up appears in parsed chat and native reply](codex-controls/after-send.png) |
| One Stop during streaming | [Cancellation dialog, task still running](codex-controls/before-stop.png) | [Idle, native interruption, run attached](codex-controls/after-stop.png) |
| Composer Stop after raw Ctrl-C opened the dialog | Leaves task running | [Cancels and keeps run attached](codex-controls/after-stop-dialog.png) |

The tests additionally cover multiline text, trailing semicolons, raw text then
bare Enter, unchanged raw Ctrl-C, sending another follow-up after Stop, other
agents' Ctrl-C, and rejection of invalid/mixed input and foreign Host requests.
The normal CI path uses a small terminal double for Codex's burst and dialog
semantics; native verification uses the same browser tests and local provider.
No runtime or development dependency was added. A separate v0.162.1 check
confirmed Send and ordinary Stop; the full dialog regression targets v0.161.0.
The dialog setup waits for streaming before sending raw Ctrl-C: when sent
while idle, native Codex disconnects instead of opening the task dialog.

To rerun the audited-version proof, use an installed Codex v0.161.0 binary
and Playwright Chromium:

```sh
TRACEQUEST_TEST_CODEX_BIN=/absolute/path/to/codex \
TRACEQUEST_TEST_EVIDENCE=/tmp/codex-controls-evidence \
nice -n 19 taskset -c 0-3 node --test --test-concurrency=1 \
  test/browser/codex-controls.playwright.test.js
```

Set `TRACEQUEST_TEST_ROOT` to an extracted main checkout to compare the served
application against main with the same driver. Omit the native-binary setting
for the regular terminal-double regression. Each run allocates its own HOME,
loopback ports, tmux socket/session, and closes its server/browser/processes.
