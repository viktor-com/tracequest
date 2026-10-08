# Codex tool outcome fixtures

The real fixtures contain a tool call/result pair or a legacy tool end event from a Codex rollout. Call IDs are anonymized, arguments and patch inputs are removed, and private paths and large output bodies are replaced with `[REDACTED]`. Status fields, content-block types, failure headers and timing metadata are retained.

| Fixture | Source rollout | Result line |
|---|---|---:|
| nonzero-exit | rollout-2026-06-29T16-17-56-019f13be-75da-7202-a114-e447cbc2833a.jsonl | 117 |
| patch-failure | rollout-2026-06-29T16-17-56-019f13be-75da-7202-a114-e447cbc2833a.jsonl | 629 |
| timeout | rollout-2026-08-11T16-09-41-019ff128-5b34-7f30-8426-c3238645a5ba.jsonl | 96 |
| structured-exit | rollout-2026-07-10T10-21-00-019f4b1d-a171-7273-8db3-35014cc8685f.jsonl | 2730 |
| success | rollout-2026-06-29T16-17-56-019f13be-75da-7202-a114-e447cbc2833a.jsonl | 12 |
| structured-success | rollout-2026-07-10T10-21-00-019f4b1d-a171-7273-8db3-35014cc8685f.jsonl | 4142 |
| legacy-patch-failure | rollout-2026-05-15T23-47-17-019e2d9b-ad17-7092-8720-280f6d53b092.jsonl | 536 |
| documentation-success | rollout-2026-07-10T10-21-26-019f4b1e-0483-7dd1-8ef8-084f7d40e2cc.jsonl | 148 |
| script-failure | rollout-2026-07-10T10-21-00-019f4b1d-a171-7273-8db3-35014cc8685f.jsonl | 3159 |
| legacy-exec-success | rollout-2026-04-26T23-16-10-019dcba6-5a7b-76a0-bb49-71a3b5afe741.jsonl | 14 |

Legacy end-event fixtures are real imported records. Nonzero legacy exits and successful diagnostic text are also exercised by synthetic supplemental tests.

`negative-checks.jsonl` is synthetic: grep no match, false `test` and `[`, and differing `diff` return exit 1. These remain failures, matching Claude results with `is_error: true`. The documentation fixture retains its successful envelope and only the diagnostic examples from the returned page.

`main-v10-index.json` is metadata produced by main at `ec9a2d0` for `patch-failure.jsonl`. Its zero error count is the pre-upgrade result. The temporary path is represented by the `session` key and its mtime is normalized to zero; the upgrade test rebinds both without editing the recording.
