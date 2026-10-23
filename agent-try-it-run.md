# Fresh agent session running the README's 'Try it in a minute' instruction

Clean temp project `/tmp/tq-agentproof/csv-stats` (empty git repo), fresh `claude -p` session given the exact README text below. npm prefix pointed at a temp dir so `npm link` could not touch the machine's shared global install.

```text
Install TraceQuest and use it to find out what went wrong in this project's past agent sessions.
1. Clone https://github.com/viktor-com/tracequest.git next to this project (../tracequest),
   then run `npm install` and `npm link` there so the `tracequest` command is on PATH.
2. Read ../tracequest/docs/cli-reference.md for the commands and filters.
3. Run `tracequest find "project:<this folder's name> errors:>0"`, then `tracequest search`
   for the errors you see. Tell me what keeps failing, and propose a fix for AGENTS.md.
```

## Commands the agent ran

```
$ cd /tmp/tq-agentproof && git clone https://github.com/viktor-com/tracequest.git tracequest 2>&1 | tail -2; cat tracequest/package.json; ls tracequest
Cloning into 'tracequest'...
{
  "name": "tracequest",
  "version": "0.5.3",
  "private": true,
  "description": "Stop reading agent logs. Watch them.",
…
```
```
$ cd /tmp/tq-agentproof/tracequest && npm install 2>&1 | tail -3 && npm link 2>&1 | tail -3; which tracequest; cat docs/cli-reference.md
added 2 packages, and audited 3 packages in 435ms

…
```
```
$ cd /tmp/tq-agentproof/tracequest && grep -n -A40 -i "^## .*find\|^### .*find\|filter expr\|^### .*search" docs/cli-reference.md | head -200
23:  find [expr] [--filter <expr>] List recent sessions or find by filter expression
24-  search <query>             Full-text search across all sessions
25-  handoff <query>            Paste Markdown search handoff without an LLM
26-  standup [project]          Summarize recent sessions with a local prompt-mode agent
27-  latest [project]           Render the most recent session
28-  share [session]            Share a session to Gist or Hugging Face
…
```
```
$ tracequest find "project:csv-stats errors:>0" 2>&1 | head -60
tracequest: session durations checked for 0 cached sessions (0 to re-index as worked time)
tracequest: building index for 8007 sessions (8007 stale)...
tracequest: indexed 8007 sessions (0 cached) in 14327ms
No sessions match the expression.
```
```
$ tracequest find "project:csv-stats" 2>&1 | head; tracequest find "csv-stats" 2>&1 | head; tracequest list 2>&1 | grep -i csv | head
Found 1 sessions:

  2026-10-23 11:47  claude    5ec81130     277KB  -tmp-tq-agentproof-csv-stats  /home/everlier/.claude/projects/-tmp-tq-agentproof-csv-stats/4940fad9-524a-4c1e-b682-3820a94e8d08.jsonl
tracequest: claude session spans checked for 222 cached sessions (155 shortened, 0 to re-index) in 108ms
tracequest: session durations checked for 2148 cached sessions (728 to re-index as worked time)
tracequest: building index for 8007 sessions (6564 stale)...
…
```
```
$ ls -la; git log --oneline 2>&1 | head; cat README.md | head -40; tracequest search "csv-stats" -l 10 2>&1 | grep -v "^tracequest:" | head -30
total 4
drwxr-xr-x. 3 everlier everlier  80 Oct 23 13:46 .
drwxr-xr-x. 6 everlier everlier 180 Oct 23 13:46 ..
drwxr-xr-x. 6 everlier everlier 180 Oct 23 13:46 .git
-rw-r--r--. 1 everlier everlier  12 Oct 23 13:46 README.md
fatal: your current branch 'master' does not have any commits yet
…
```

## Agent's final answer

There are no past agent sessions for this project, so I can't tell you what keeps failing. Nothing has.

**What I did**
- Cloned TraceQuest to `../tracequest`, then ran `npm install` and `npm link`. `tracequest` is now on PATH at `/tmp/tq-agentproof/npm-global/bin/tracequest`. I checked `package.json` first: it has no install-time scripts, and its only dependency is Playwright for development.
- Read `docs/cli-reference.md`.
- Ran `tracequest find "project:csv-stats errors:>0"`. Result: **"No sessions match the expression."**

**Why nothing matched**
- TraceQuest indexed 8,007 sessions across Claude, Codex and Factory on this machine. Only one belongs to csv-stats: the session we're in now, started today.
- `tracequest search "csv-stats"` finds the same thing. The other hits are unrelated projects that just mention "CSV" or "stats".
- The project itself is new. `master` has no commits, the only file is an untracked `README.md` containing just `# csv-stats`, and there's no `AGENTS.md`.
- The search does list three "errors" in this session, but they're all the notice "Shell cwd was reset to /tmp/tq-agentproof/csv-stats". My shell commands print that after changing into `../tracequest`. It's normal behaviour, not a failure.

**About AGENTS.md**
I'm not proposing a fix, because there are no failures to base one on. Anything I wrote would be invented. Once a few real sessions have run here, `tracequest find "project:csv-stats errors:>0"` and `tracequest insights "project:csv-stats" --refresh` will show recurring problems, and I can write `AGENTS.md` rules aimed at those.

If the past sessions happened somewhere else, such as another folder name or another machine, tell me where. If they're on another machine, `tracequest import ssh` can bring them in.

_turns: 7, duration: 96 s_
