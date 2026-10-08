import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PKG_ROOT } from "./cli-presets.js";
import { DEFAULT_AGENT_PROBE_TIMEOUT_MS, DEFAULT_AGENT_TIMEOUT_MS, STANDUP_AGENT_ENV } from "../standup/agent-runner.js";
import { k } from "./cli-color.js";

const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
export const version = pkg.version;

/** Shared parseArgs schema for render and latest */
export const RENDER_OUTPUT_OPTIONS = {
  help: { type: "boolean", short: "h" },
  out: { type: "string", short: "o" },
  preset: { type: "string" },
  open: { type: "boolean" },
};

export const RENDER_OUTPUT_HELP = `${k.bold("render / latest Options:")}
  -o, --out <path>     Output file path (default: tracequest-<sessionHash>.html for render)
      --preset <name>  Load built-in preset
      --open           Open result in default browser`;

export const SHARE_OPTIONS_HELP = `${k.bold("share Options:")}
      --target <t>     Upload target: gist (default) or hf
      --latest         Share the most recent session (optional project filter)
  -f, --filter <expr>  Filter expression; most recent match is shared
  -s, --sort <key>     Sort key when using --filter (default: recent)
      --open           Open the share URL in the default browser (gisthost preview for gist)
      --json           Print result JSON (url=gisthost preview, gistUrl=raw gist)
      --private        Create a secret gist or private HF dataset (gisthost previews need GitHub auth)
      --force          Skip secret confirmation prompt
      --hf-repo <repo> HF dataset repo (namespace/repo)`;

export function buildHelp() {
  return `${k.bold("tracequest")} — stop reading agent logs. watch them.

${k.bold("Usage:")}
  tracequest <command> [options] [--config <file>]

${k.bold("Commands:")}
  ${k.cyan("render")} <session.jsonl>      Render a specific session file
  ${k.cyan("messages")} <session.jsonl>|--latest [project]
                                Export session as API message format (JSON)
  ${k.cyan("list")} [project]             List available sessions
  ${k.cyan("find")} [expr] [--filter <expr>] List recent sessions or find by filter expression
  ${k.cyan("search")} <query>             Full-text search across all sessions
  ${k.cyan("handoff")} <query>            Paste Markdown search handoff without an LLM
  ${k.cyan("standup")} [project]          Summarize recent sessions with a local prompt-mode agent
  ${k.cyan("latest")} [project]           Render the most recent session
  ${k.cyan("share")} [session]            Share a session to Gist or Hugging Face
  ${k.cyan("import")} <source>            Import sessions (cursor-cloud, ssh)
  ${k.cyan("limits")} [--json] [--host]   Remaining plan windows for installed harnesses
  ${k.cyan("insights")} [expr]            Where agents fail and wait, across collected machines
  ${k.cyan("serve")} [options]            Start session browser server
  ${k.cyan("presets")}                     List built-in presets

${k.bold("Global Options:")}
  -h, --help     Show this help
  -v, --version  Print version

${RENDER_OUTPUT_HELP}

${k.bold("messages Options:")}
  --latest             Export the most recent session (optional project filter)
  -f, --filter <expr>  With --latest, filter expression before selecting
  -s, --sort <key>     With --latest, sort by recent|date (default), duration,
                       cost, tokens, errors, files, commits, chapters, grade
  --format <fmt>       Output format: anthropic (default) or openai
  --pretty             Pretty-print the JSON output
  -o, --out <path>     Write JSON to file instead of stdout
      --full           Export untruncated content for a verbatim replay
      --no-truncate    Alias for --full

${k.bold("find Options:")}
  -f, --filter <expr>  Filter expression; combines with positional expr using AND
  -l, --limit <N>      Max results to show (default: 10 without any expr, 20 with an expr)
  -s, --sort <key>     Sort by: recent|date (default), duration, cost, tokens,
                       errors, files, commits, chapters, grade (only with a filter expr;
                       bare find always uses recency, unlike list)
      --json           Emit JSON records to stdout (status to stderr)
  Filter expression keys: project, source, host, tool, model, grade, errors, size, age, live
  Operators: AND, OR, NOT, parentheses, -negation, free text

${k.bold("search Options:")}
  -f, --filter <expr>  Filter expression before searching
  -l, --limit <N>      Max results to show (default: 20)
      --format <fmt>   Output format: text (default) or handoff Markdown
  -s, --sort <key>     With --format handoff: relevance (default) or recent|date
      --json           Emit JSON records (with matches) to stdout (status to stderr)

${k.bold("handoff Options:")}
  -f, --filter <expr>  Filter expression before searching
  -l, --limit <N>      Max results to include (default: 20)
  -s, --sort <key>     Sort by relevance (default) or recent|date
  Direct alias for search --format handoff with the same filter/limit/sort options;
  uses local search/indexing only.
  Quoted phrases with recent/date return exact matches within a bounded scan;
  older phrase matches may be omitted.

${k.bold("standup Options:")}
  -l, --limit <N>      Max sessions to summarize (default: 5)
  -f, --filter <expr>  Filter expression before selecting recent sessions
  -s, --sort <key>     Sort by: recent|date (default), duration, cost, tokens,
                       errors, files, commits, chapters, grade
      --profile <name> Load defaults from HOME/.tracequest/standup-profiles.json
      --since <when>   Select sessions modified since a duration/date (2h, 1d, 2026-06-27)
      --today          Select sessions modified since local midnight today
      --yesterday      Select sessions modified during local yesterday
      --workday        Select sessions modified during today's local 09:00-17:00 workday
      --previous-workday
                       Select sessions modified during the previous weekday's
                       local 09:00-17:00 workday
      --print-input    Print compact prompt input and do not invoke an agent
      --dry-run-agent-detection
                       Print resolved prompt-agent argv as JSON without discovering
                       sessions, building compact input, invoking an agent,
                       or sending a prompt
      --probe-agents   Opt-in installed-agent probe using synthetic prompts only;
                       reports passed/failed/missing/skipped as JSON without
                       loading profiles, discovering sessions, real-trace
                       compact-input building, or private prompt sending
                       (agents run from an empty temporary directory)
      --agent-command <cmd>
                       Override detected prompt-mode agent command
      --agent-arg <v>  Add one agent argv item; repeat as needed
                       Use --agent-arg=--flag for values that start with -
      --agent-timeout-ms <N>
                       Prompt-agent timeout in milliseconds (default: ${DEFAULT_AGENT_TIMEOUT_MS})
      --param <k=v>    Add one agent flag parameter; repeat as needed
  Env defaults: ${STANDUP_AGENT_ENV.command}, ${STANDUP_AGENT_ENV.args},
                ${STANDUP_AGENT_ENV.timeoutMs}
  Profile keys: project, filter, sort, limit,
                since/today/yesterday/workday/previousWorkday
                (or previous-workday),
                agentCommand, agentArgs, agentTimeoutMs, params
  Precedence: explicit CLI flags > profile > env defaults > built-in detection.
  --agent-command selects a new agent identity and does not reuse lower-source
                agentArgs or params unless CLI --agent-arg/--param are supplied.
  Built-in detection: codex exec --skip-git-repo-check -, claude --print, droid exec
  OpenCode must be configured explicitly after local stdin validation.
  Other agents: pass --agent-command/--agent-arg only after verifying stdin
                prompt input, or use a wrapper that reads stdin.
  Agent stdout/stderr stream live; failures still include captured snippets.
  Opt-in installed-agent validation command:
                tracequest standup --probe-agents
  --probe-agents is separate from normal standup execution and uses a
  ${DEFAULT_AGENT_PROBE_TIMEOUT_MS}ms default timeout unless --agent-timeout-ms is set.
  It prints a stderr preflight warning before invoking installed agents and
  keeps stdout as the JSON probe report for scripts.
  A passed probe requires the expected sentinel as its own stdout line.
  Probe stdout/stderr snippets are bounded and redact paths, temp workdirs,
  and session-looking identifiers for public-paste safety.
  Exit status is 1 if any installed probe fails; missing/skipped optional
  candidates still report in JSON without making the command fail.

${k.bold("list Options:")}
  -l, --limit <N>      Max results to show (default: 20)
  -f, --filter <expr>  Filter expression (same syntax as web app / find command)
  -s, --sort <key>     Sort by: recent|date (default), duration, cost, tokens,
                       errors, files, commits, chapters, grade
      --json           Emit JSON records to stdout (status to stderr)

${k.bold("latest Options:")}
  -l, --limit <N>      Show top N latest sessions instead of rendering one (default: 1)
  -f, --filter <expr>  Filter expression (same syntax as web app / find command)
  -s, --sort <key>     Sort by: recent|date (default), duration, cost, tokens,
                       errors, files, commits, chapters, grade

${SHARE_OPTIONS_HELP}

${k.bold("import Options:")}
      --dry-run        Fetch and print planned actions (import/update/skip) without writing files
      --full           Refetch every agent / recopy every remote tree, ignoring the unchanged skip
      --api-key <key>  Optional Cursor dashboard API key (or CURSOR_API_KEY); without it the
                       local Cursor session token is used
  -i, --identity <file> ssh: SSH identity file
      --port <N>       ssh: SSH port (ssh/config default when omitted)
      --as <id>        ssh: stable host id (dest folder / host: filter); with one host only

${k.bold("limits Options:")}
      --json           Print the secret-free snapshot JSON
      --host <id>      Read the imported snapshot for that host (no live SSH)

${k.bold("insights Options:")}
      --refresh        Analyse new and changed sessions before reporting
      --days <N>       Only sessions from the last 7, 30 or 90 days
      --host <id>      Only one machine (an imported host id, or "local")
      --json           Print the aggregates as JSON

${k.bold("serve Options:")}
  -p, --port <N>      Port number (default: 7777 or from preset)
      --bind <addr>   Listen address (default: 127.0.0.1; 0.0.0.0 exposes the
                      unauthenticated API, which can launch agents, to your network)
  -f, --filter <name> Project filter
      --preset <name>  Load built-in preset
      --hub            Shared read-only mode: redact secrets in every response
      --usage-limits   Show remaining plan windows on the home page (calls the
                       Anthropic, OpenAI and xAI APIs with your agent logins)
                       and refuse anything that starts or changes a run

${k.bold("Examples:")}
  tracequest render session.jsonl --out out.html --open
  tracequest messages session.jsonl --format openai --pretty
  tracequest messages session.jsonl --out messages.json
  tracequest messages session.jsonl > messages.json
  tracequest list tracequest
  tracequest list --limit 50
  tracequest list --filter "source:claude model:sonnet" --sort tokens
  tracequest list --filter "host:gpu"
  tracequest find --filter "source:claude host:gpu"
  tracequest find
  tracequest find "model:sonnet age:<7d"
  tracequest find --filter "model:sonnet age:<7d"
  tracequest find "project:myapp" --filter "model:sonnet"
  tracequest find --filter "tool:Read AND errors:>0" --sort errors
  tracequest find --filter "source:claude project:myapp" --limit 50
  tracequest search "parseSession"
  tracequest search "error handling" --limit 5
  tracequest search "error handling" --format handoff --limit 5
  tracequest search "error handling" --format handoff --filter "project:tracequest" --sort recent --limit 5
  tracequest search "error handling" --format handoff --sort date --limit 5
  tracequest handoff "error handling" --limit 5
  tracequest handoff "error handling" --sort recent --limit 5
  tracequest handoff "error handling" --sort date --limit 5
  tracequest standup --print-input --limit 3
  tracequest standup --profile daily --print-input
  tracequest standup --dry-run-agent-detection
  tracequest standup --since 4h --print-input
  tracequest standup --workday --print-input
  tracequest standup --previous-workday --print-input
  tracequest standup --yesterday --filter "project:tracequest" --print-input
  tracequest standup tracequest --filter "age:<2d" --print-input
  tracequest standup --agent-command my-agent --agent-arg run --param model=gpt-5
  tracequest standup --agent-command droid --agent-arg exec --param model=gpt-5.3-codex
  tracequest standup --agent-timeout-ms 120000
  tracequest standup --param model=gpt-5
  tracequest latest tracequest --out latest.html
  tracequest latest --limit 5
  tracequest latest --filter "project:myapp grade:a"
  tracequest share session.jsonl --target gist --open
  tracequest share --latest myproject --target hf --hf-repo user/tracequest-sessions
  tracequest share --filter "deploy" --json --force
  tracequest import cursor-cloud
  tracequest import cursor-cloud --dry-run
  tracequest import cursor-cloud --api-key key_xxx
  tracequest import ssh gpu
  tracequest import ssh gpu --dry-run
  tracequest import ssh gpu --full
  tracequest import ssh gpu -i ~/.ssh/id_ed25519 --port 2222
  tracequest import ssh user@gpu --as gpu
  tracequest import ssh
  tracequest limits
  tracequest limits --json
  tracequest insights --refresh
  tracequest insights "project:sample-app" --days 30
  tracequest serve --hub --bind 127.0.0.1
  tracequest limits --host gpu
  tracequest serve --port 8888 --filter tracequest
  tracequest presets

${k.dim("Supported agents: Claude Code, Codex CLI, Droid/Factory, OpenCode, Grok CLI")}`;
}

export function showHelp() {
  console.log(buildHelp());
  process.exit(0);
}

export function showVersion() {
  console.log(version);
  process.exit(0);
}

export function showShareHelp() {
  console.log(`${k.bold("tracequest share")} — share a session to Gist or Hugging Face

${k.bold("Usage:")}
  tracequest share <session.jsonl> [options]
  tracequest share --latest [project] [options]
  tracequest share --filter <expression> [options]

${SHARE_OPTIONS_HELP}

${k.bold("Examples:")}
  tracequest share session.jsonl --target gist --open
  tracequest share session.jsonl --target hf --hf-repo user/tracequest-sessions --json
  tracequest share --latest myproject --target gist
  tracequest share --filter "model:sonnet" --force

${k.dim("Secrets are scanned locally; matched values are redacted to [REDACTED] before upload.")}`);
  process.exit(0);
}
