# tq-fix-15 evidence: finished Grok reply shown as Generating

Real Grok 4.7 TUI run launched through `POST /api/runs` on a scratch serve
(disposable HOME, port 7915, tmux socket tq15-sock), prompt:
"Reply with exactly the single word TQ15-SENTINEL and nothing else. Do not use any tools."

Terminal (tmux capture-pane) after the reply:

    ❯ Reply with exactly the single word TQ15-SENTINEL and nothing else. Do not use any tools.
    Worked for 2.7s

Recording tail (chat_history.jsonl): assistant "TQ15-SENTINEL", then
{"type":"user", ..., "synthetic_reason":"system_reminder"} (Grok's skills list).
events.jsonl ends with turn_ended; updates.jsonl ends with turn_completed.

## Before (origin/main 636d4d2), minutes after the reply
- GET /api/runs        -> "status":"running"
- GET /api/sessions    -> "live":true
- /run?id=@1           -> header "running", "Planning next moves" under the reply, composer "Generating…", top bar "1 running"

## After (branch), same live run, same recording
- GET /api/runs        -> "status":"idle"
- GET /api/sessions    -> "live":false
- /run?id=@1           -> header "idle", composer "Idle", no "Planning next moves", no running badge

## Follow-up turn on the branch (still reports running while Grok works)
Sampled GET /api/runs every 0.5 s after sending a follow-up (Grok: "Worked for 4.1s"):
    11 samples "running" (15:27:10.3 - 15:27:15.8)
    39 samples "idle"    (from 15:27:16.1)
