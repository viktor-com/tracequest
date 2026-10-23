# Fresh agent session running the README's "Try it in a minute" instruction

- **Project:** a clean, empty git repo `csv-stats` with only a README.
- **Agent:** a fresh `claude -p` session given exactly the text below.
- **`tracequest` start state:** not on the agent's PATH.
- **npm prefix:** a throwaway folder, so `npm link` could not touch the machine's shared global install.
- **Pre-merge only:** `main` doesn't have the skill yet, so a temporary git `insteadOf` setting pointed the README's clone URL at this PR's branch (`bf6b583`). After merge, the same text clones `main`.

```text
Add the TraceQuest skill to this project and use it.
1. Clone https://github.com/viktor-com/tracequest.git next to this project (../tracequest).
2. Copy ../tracequest/skills/tracequest into this project's skills folder
   (.claude/skills/tracequest for Claude Code, or your agent's own skills folder).
3. Follow that SKILL.md: install TraceQuest, then find out what keeps failing in this
   project's past agent sessions and propose a fix for AGENTS.md.
```

## What the agent did (10 turns, 71 s)

1. Cloned the repo. Its first clone landed one folder too high because of a `cd`; it moved the clone to `../tracequest` itself.
2. Copied the skill into the project:
   ```
   $ mkdir -p .claude/skills && cp -r ../tracequest/skills/tracequest .claude/skills/
   $ ls .claude/skills/tracequest
   SKILL.md
   $ tracequest --version
   bash: tracequest: command not found
   ```
3. Followed SKILL.md "Install": checked `package.json` for install scripts, then
   ```
   $ cd ../tracequest && npm install && npm link; tracequest --version
   added 2 packages, and audited 3 packages in 582ms
   added 1 package, and audited 3 packages in 434ms
   0.5.3
   ```
4. Followed SKILL.md "Investigate":
   ```
   $ tracequest find "project:csv-stats errors:>0" --json
   tracequest: building index for 8010 sessions (1815 stale)...
   tracequest: indexed 1815 sessions (6195 cached) in 4700ms
   []
   $ tracequest find "project:csv-stats"
   Found 3 sessions: ...
   $ tracequest insights "project:csv-stats" --refresh
   insights refresh: 1815 analysed, 6195 unchanged, 0 failed, 0 removed
   insights: 3 sessions on 1 machine
     tool errors   0 of 20 calls (0.0%), 0 sessions with errors
     retries       0 retries, 0 loops (0 calls)
   ```
   It then read the earlier sessions with `tracequest messages <hash> --pretty`.

## Agent's final answer (trimmed)

> I installed TraceQuest and searched this project's past sessions. Nothing keeps failing, so I don't have an evidence-backed AGENTS.md fix, and I haven't written one.
>
> - `tracequest find "project:csv-stats errors:>0"` matched no sessions.
> - `tracequest insights "project:csv-stats" --refresh` covered 3 sessions with 20 tool calls: no tool errors, no retries, no stalls.
> - Two of those sessions are earlier runs of this same setup task, and both finished cleanly.
>
> One weak pattern, not a failure: shell cwd resets made one of my commands run in the wrong folder. If you want a rule anyway: "Use absolute paths (or `cd /abs/path && ...` in one command) for anything outside the project, e.g. sibling clones like ../tracequest." Tell me if you want it added to AGENTS.md.

The project has no failed sessions, so "nothing to fix" is the correct result. The skill's "If nothing matches, say so instead of guessing" rule held.
