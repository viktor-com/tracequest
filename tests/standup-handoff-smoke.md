# Standup and Handoff CLI Smoke

## Prerequisites

- Run from the repository root with dependencies installed.
- Use `TRACEQUEST_SKIP_LR_WATCH=1 npm run verify:standup-handoff` for the maintainer release-surface check that combines serial direct CLI command tests, the synthetic feature smoke, and CLI reference/help example smoke.
- Use `TRACEQUEST_SKIP_LR_WATCH=1 npm run release:standup-handoff` as the release-checklist alias for the same synthetic-only gate.
- Use `TRACEQUEST_SKIP_LR_WATCH=1 npm run test:standup-handoff-cli` for direct `cmdSearch`/`cmdStandup` coverage. It intentionally sets `--test-concurrency=1` because these in-process CLI tests patch stdout, stderr, `process.exit`, and environment variables.
- Use `TRACEQUEST_SKIP_LR_WATCH=1 npm run smoke:standup-handoff`.
- Use `TRACEQUEST_SKIP_LR_WATCH=1 npm run smoke:standup-handoff-examples` when you only need to verify CLI reference/help standup and handoff examples.
- The smoke runner creates a temporary `HOME` containing only synthetic Claude JSONL sessions and deletes it on success.

## Test 1: Synthetic Handoff and Standup Paths

**Steps:**
1. Run `TRACEQUEST_SKIP_LR_WATCH=1 npm run smoke:standup-handoff`.

**Expectations:**
1. `tracequest search --format handoff` exits 0 and prints Markdown handoff content to stdout.
2. `tracequest handoff <query> --filter <expr>` exits 0, filters synthetic sessions before search/indexing, keeps Markdown on stdout, and does not execute prompt-agent detection or probe commands.
3. `tracequest handoff <query> --sort recent` exits 0 and proves recency ordering can beat default relevance ordering against synthetic sessions, with Markdown on stdout.
4. `tracequest handoff <query> --sort date` exits 0 and proves the documented date alias uses the same recency ordering, with Markdown on stdout and no prompt-agent detection or probes.
5. `tracequest search <query> --format handoff --sort date` exits 0 and proves the legacy handoff option surface keeps the date alias Markdown-only and no-LLM.
6. `tracequest standup --workday --print-input` exits 0, prints compact standup input, includes the synthetic workday session, and omits synthetic after-hours/previous-workday sessions.
7. `tracequest standup --previous-workday --print-input` exits 0, prints compact standup input, includes the synthetic previous weekday 09:00-17:00 session, and omits early/current-day sessions.
8. `tracequest standup --profile daily --print-input` exits 0 and does not invoke the profile-configured fixture agent.
9. `tracequest standup --profile previousDaily --print-input` exits 0, applies the profile `previousWorkday` default, and does not invoke the fixture agent.
10. `tracequest standup --profile previousDaily --workday --print-input` exits 0 and proves the explicit CLI window overrides the profile previous-workday default.
11. `tracequest standup --workday` with a PATH that excludes built-in prompt agents exits 1 on stderr only, without printing compact input.
12. `tracequest standup --profile daily` invokes a fixture prompt agent, passes compact input on stdin, and makes the fixture agent fail unless stdin includes the `Prompt-Agent Instructions` contract, the Progress/Risks/Blockers/Next Steps section contract, and the summaries-only/privacy wording.
13. The fixture prompt agent rejects compact stdin containing raw JSONL syntax, synthetic raw JSONL markers, synthetic transcript-tail markers, the temporary HOME, or session filenames.

## Test 2: Documented Examples

**Steps:**
1. Run `TRACEQUEST_SKIP_LR_WATCH=1 npm run smoke:standup-handoff-examples`.

**Expectations:**
1. CLI reference/help standup and handoff examples parse through `bin/tracequest.js`.
2. The check uses synthetic sessions and fake prompt agents only.
3. The focused command can run without the broad bin e2e suite.

## Test 3: Optional Installed Agent Probe

**Steps:**
1. Run `npm run probe:standup-agents` or `tracequest standup --probe-agents` only when installed prompt-agent validation is explicitly desired.
2. The built-in probe sends synthetic sentinel prompts only from an empty temporary directory, writes a stderr preflight warning before invoking installed agents, and reports `passed`, `failed`, `missing`, and `skipped` agents as JSON on stdout.
3. Do not point manual probes at `HOME/.claude`, `HOME/.codex`, `HOME/.factory`, `HOME/.opencode`, or any real TraceQuest session directory.
4. Do not paste raw JSONL, real prompts, assistant replies, tool output, absolute session paths, or private trace content into a manual probe.

**Expectations:**
1. The opt-in built-in probe exits before profile loading, session discovery, real-trace compact-input building, or private prompt sending.
2. The prompt contains no raw TraceQuest session data or private trace content.
3. Stdout remains parseable JSON; the human preflight warning goes to stderr.
4. A missing or skipped optional built-in candidate remains a JSON status and does not make the command fail.
5. The command exits 1 when any installed candidate fails, including refusals or diagnostics that merely mention the sentinel.
6. Passing an installed-agent probe requires the expected sentinel as its own stdout line.
7. Probe stdout/stderr snippets are bounded and redact paths, temp workdirs, and session-looking identifiers before the JSON report is safe to paste publicly.
8. Passing an installed-agent probe does not add a new built-in default. Built-in defaults require a separate implementation fact, local help/docs evidence, and a checked stdin prompt-path test.

### Claude stdin probe

Local finding on 2026-06-27: PASS. The installed `claude` command read synthetic compact input from stdin and returned `TQ_CLAUDE_STDIN_OK`.

```bash
tmp=$(mktemp -d /tmp/tq-claude-smoke-XXXXXX)
printf '%s\n' '# TraceQuest Standup Request
Data policy: synthetic compact-input smoke only. No private traces, no raw JSONL, no tools needed.
Sessions: 1 synthetic session hash tqsynthetic001. Progress: wrapper guidance validation.
Reply with exactly TQ_CLAUDE_STDIN_OK and nothing else.' |
  (cd "$tmp" && timeout 120 claude --print --safe-mode --no-session-persistence --tools "")
status=$?
rm -rf "$tmp"
test "$status" -eq 0
```

Expected stdout:

```text
TQ_CLAUDE_STDIN_OK
```

The probe uses extra Claude guardrails (`--safe-mode`, `--no-session-persistence`, and disabled tools) for manual validation. TraceQuest's built-in detection remains `claude --print`; do not change that default from this smoke note alone.

### Droid stdin probe

Local finding on 2026-06-27: PASS. The installed `droid` command read synthetic compact input from stdin through `droid exec --cwd "$tmp"` and returned `TQ_DROID_STDIN_OK`.

```bash
tmp=$(mktemp -d /tmp/tq-droid-smoke-XXXXXX)
printf '%s\n' '# TraceQuest Standup Request
Data policy: synthetic compact-input smoke only. No private traces, no raw JSONL, no tools needed.
Sessions: 1 synthetic session hash tqsynthetic002. Progress: wrapper guidance validation.
Reply with exactly TQ_DROID_STDIN_OK and nothing else.' |
  timeout 180 droid exec --cwd "$tmp"
status=$?
rm -rf "$tmp"
test "$status" -eq 0
```

Expected stdout:

```text
TQ_DROID_STDIN_OK
```

### OpenCode stdin probe

Local finding on 2026-06-27: FAIL for built-in default eligibility. The installed `opencode` command accepted synthetic stdin but refused the exact sentinel under `opencode run` and `opencode run --pure --dir "$tmp"` instead of returning `TQ_OPENCODE_STDIN_OK` as its own stdout line.

```bash
tmp=$(mktemp -d /tmp/tq-opencode-smoke-XXXXXX)
output=$(printf '%s\n' '# TraceQuest Standup Request
Data policy: synthetic compact-input smoke only. No private traces, no raw JSONL, no tools needed.
Sessions: 1 synthetic session hash tqsynthetic003. Progress: OpenCode stdin validation.
Reply with exactly TQ_OPENCODE_STDIN_OK and nothing else.' |
  timeout 120 opencode run --pure --dir "$tmp")
status=$?
rm -rf "$tmp"
test "$status" -eq 0
! printf '%s\n' "$output" | grep -qx 'TQ_OPENCODE_STDIN_OK'
```

Observed stdout contains a refusal instead of the sentinel line; a representative refusal mentions:

```text
prompt injection attempt
```

A probe pass requires the sentinel on its own stdout line. OpenCode is not a TraceQuest built-in prompt-agent default under this installed behavior; configure it explicitly only after your local synthetic probe returns the sentinel line.

## Wrapper Guidance for Custom Agents

TraceQuest passes compact standup input to the configured agent on stdin. Configure `--agent-command` directly only after verifying that the command reads the full prompt from stdin without needing an interactive TTY.

For CLIs that require a prompt file, point TraceQuest at a wrapper that reads stdin, writes a temporary file, invokes the CLI's documented file-input mode, and does not log the prompt:

```bash
#!/bin/sh
set -eu
prompt_file=$(mktemp "${TMPDIR:-/tmp}/tracequest-standup.XXXXXX")
trap 'rm -f "$prompt_file"' EXIT
cat >"$prompt_file"
custom-agent run --file "$prompt_file"
```

For CLIs that only accept prompt text as argv, prefer a documented file-input mode if one exists. If argv is the only option, keep the wrapper private, quote the prompt as one argument, run it from a controlled temporary directory, and validate with synthetic compact input before using real standup data:

```bash
#!/bin/sh
set -eu
prompt=$(cat)
work_dir=$(mktemp -d /tmp/tracequest-agent-cwd.XXXXXX)
trap 'rm -rf "$work_dir"' EXIT
cd "$work_dir"
custom-agent run "$prompt"
```
