#!/usr/bin/env node

import { parseArgs } from "node:util";
import {
  RENDER_OUTPUT_OPTIONS,
  showHelp,
  showShareHelp,
  showVersion,
} from "../src/cli/cli-help.js";
import { cmdPresets } from "../src/cli/cli-presets.js";
import { die } from "../src/cli/cli-die.js";
import { setColorEnabled } from "../src/cli/cli-color.js";
import { loadHubConfig, applyHubConfig, hubConfig } from "../src/hub/config.js";

// Force stdout/stderr into blocking mode. Node pipes are asynchronous by default,
// so a bare process.exit() in a command handler discards whatever is still
// buffered — silently truncating piped output (e.g. `find --json | jq` losing
// rows past ~64 KiB while still exiting 0). Blocking writes are flushed to the fd
// synchronously, so exit-after-write can never truncate. Redirects to files are
// already synchronous; the optional chaining keeps this a no-op where unsupported.
for (const stream of [process.stdout, process.stderr]) {
  stream?._handle?.setBlocking?.(true);
}

const COMMAND_HELP = new Set(["render", "messages", "list", "latest", "find", "search", "handoff", "standup", "import", "limits", "serve", "presets", "preset"]);

/** Map node:util parseArgs failures to user-facing CLI errors */
function dieParseArgs(err) {
  if (err.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") die(`${err.message}\nRun 'tracequest --help' for usage.`);
  if (err.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") die(`${err.message}\nRun 'tracequest --help' for usage.`);
  throw err;
}

function safeParseArgs(opts) {
  try {
    return parseArgs(opts);
  } catch (err) {
    dieParseArgs(err);
  }
}

function wantsHelp(args) {
  return args.includes("--help") || args.includes("-h");
}

function showCommandHelpIfRequested(subcommand, subArgs) {
  if (!wantsHelp(subArgs)) return;
  if (subcommand === "share") showShareHelp();
  if (COMMAND_HELP.has(subcommand)) showHelp();
}

function loadCommands() {
  return import("../src/cli/cli-commands.js");
}

// --- Main dispatch ---

// Apply explicit configuration before loading commands and strip global options
// so per-command parseArgs schemas do not reject them.
const inputArgs = process.argv.slice(2);
const configArgs = [];
for (let i = 0; i < inputArgs.length; i++) {
  const arg = inputArgs[i];
  if (arg === "--config" || arg.startsWith("--config=")) {
    const file = arg === "--config" ? inputArgs[++i] : arg.slice(9);
    if (!file || file.startsWith("--")) die("--config requires a JSON file path");
    if (hubConfig()) die("--config may only be supplied once");
    try { applyHubConfig(loadHubConfig(file)); } catch (err) { die(err.message); }
  } else configArgs.push(arg);
}
const args = configArgs.filter((a) => {
  if (a === "--no-color") { setColorEnabled(false); return false; }
  return true;
});

if (args.length === 0 || args[0].startsWith("-")) {
  const { values: gv } = safeParseArgs({
    args,
    options: { help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" } },
    allowPositionals: true,
  });
  if (gv.help) showHelp();
  if (gv.version) showVersion();
  showHelp();
}

const subcommand = args[0];
const subArgs = args.slice(1);

async function dispatch() {
  showCommandHelpIfRequested(subcommand, subArgs);

  switch (subcommand) {
  case "render": {
    const { positionals, values } = safeParseArgs({
      args: subArgs,
      options: RENDER_OUTPUT_OPTIONS,
      allowPositionals: true,
    });
    const { cmdRender } = await loadCommands();
    cmdRender(positionals, values);
    break;
  }
  case "messages": {
    const { positionals, values } = safeParseArgs({
      args: subArgs,
      options: {
        help: { type: "boolean", short: "h" },
        format: { type: "string", short: "f" },
        pretty: { type: "boolean" },
        out: { type: "string", short: "o" },
        latest: { type: "boolean" },
        filter: { type: "string" },
        sort: { type: "string", short: "s" },
        full: { type: "boolean" },
        "no-truncate": { type: "boolean" },
      },
      allowPositionals: true,
    });
    const { cmdMessages } = await loadCommands();
    cmdMessages(positionals, values);
    break;
  }
  case "list": {
    const { positionals, values } = safeParseArgs({
      args: subArgs,
      options: {
        help: { type: "boolean", short: "h" },
        filter: { type: "string", short: "f" },
        sort: { type: "string", short: "s" },
        limit: { type: "string", short: "l" },
        json: { type: "boolean" },
      },
      allowPositionals: true,
    });
    const { cmdList } = await loadCommands();
    cmdList(positionals, values);
    break;
  }
  case "latest": {
    const { positionals, values } = safeParseArgs({
      args: subArgs,
      options: {
        ...RENDER_OUTPUT_OPTIONS,
        filter: { type: "string", short: "f" },
        sort: { type: "string", short: "s" },
        limit: { type: "string", short: "l" },
      },
      allowPositionals: true,
    });
    const { cmdLatest } = await loadCommands();
    cmdLatest(positionals, values);
    break;
  }
  case "find": {
    const { positionals, values } = safeParseArgs({
      args: subArgs,
      options: {
        help: { type: "boolean", short: "h" },
        filter: { type: "string", short: "f" },
        limit: { type: "string", short: "l" },
        sort: { type: "string", short: "s" },
        json: { type: "boolean" },
      },
      allowPositionals: true,
    });
    const { cmdFind } = await loadCommands();
    cmdFind(positionals, values);
    break;
  }
  case "search": {
    const { positionals, values } = safeParseArgs({
      args: subArgs,
      options: {
        help: { type: "boolean", short: "h" },
        filter: { type: "string", short: "f" },
        limit: { type: "string", short: "l" },
        format: { type: "string" },
        sort: { type: "string", short: "s" },
        json: { type: "boolean" },
      },
      allowPositionals: true,
    });
    const { cmdSearch } = await loadCommands();
    cmdSearch(positionals, values);
    break;
  }
  case "handoff": {
    const { positionals, values } = safeParseArgs({
      args: subArgs,
      options: {
        help: { type: "boolean", short: "h" },
        filter: { type: "string", short: "f" },
        limit: { type: "string", short: "l" },
        sort: { type: "string", short: "s" },
      },
      allowPositionals: true,
    });
    const { cmdHandoff } = await loadCommands();
    cmdHandoff(positionals, values);
    break;
  }
  case "standup": {
    const { positionals, values } = safeParseArgs({
      args: subArgs,
      options: {
        help: { type: "boolean", short: "h" },
        filter: { type: "string", short: "f" },
        sort: { type: "string", short: "s" },
        limit: { type: "string", short: "l" },
        profile: { type: "string" },
        since: { type: "string" },
        today: { type: "boolean" },
        yesterday: { type: "boolean" },
        workday: { type: "boolean" },
        "previous-workday": { type: "boolean" },
        "print-input": { type: "boolean" },
        "dry-run-agent-detection": { type: "boolean" },
        "probe-agents": { type: "boolean" },
        "agent-command": { type: "string" },
        "agent-arg": { type: "string", multiple: true },
        "agent-timeout-ms": { type: "string" },
        param: { type: "string", multiple: true },
      },
      allowPositionals: true,
    });
    const { cmdStandup } = await loadCommands();
    await cmdStandup(positionals, values);
    break;
  }
  case "share": {
    const { positionals, values } = safeParseArgs({
      args: subArgs,
      options: {
        help: { type: "boolean", short: "h" },
        target: { type: "string" },
        latest: { type: "boolean" },
        filter: { type: "string", short: "f" },
        sort: { type: "string", short: "s" },
        open: { type: "boolean" },
        json: { type: "boolean" },
        private: { type: "boolean" },
        force: { type: "boolean" },
        "hf-repo": { type: "string" },
      },
      allowPositionals: true,
    });
    const { cmdShare } = await loadCommands();
    await cmdShare(positionals, values);
    break;
  }
  case "import": {
    const { positionals, values } = safeParseArgs({
      args: subArgs,
      options: {
        help: { type: "boolean", short: "h" },
        "dry-run": { type: "boolean" },
        full: { type: "boolean" },
        "api-key": { type: "string" },
        identity: { type: "string", short: "i" },
        port: { type: "string" },
        as: { type: "string" },
      },
      allowPositionals: true,
    });
    const { cmdImport } = await loadCommands();
    await cmdImport(positionals, values);
    break;
  }
  case "limits": {
    const { positionals, values } = safeParseArgs({
      args: subArgs,
      options: {
        help: { type: "boolean", short: "h" },
        json: { type: "boolean" },
        host: { type: "string" },
      },
      allowPositionals: true,
    });
    const { cmdLimits } = await loadCommands();
    await cmdLimits(positionals, values);
    break;
  }
  case "insights": {
    const { positionals, values } = safeParseArgs({
      args: subArgs,
      options: {
        help: { type: "boolean", short: "h" },
        json: { type: "boolean" },
        refresh: { type: "boolean" },
        days: { type: "string" },
        host: { type: "string" },
      },
      allowPositionals: true,
    });
    const { cmdInsights } = await loadCommands();
    await cmdInsights(positionals, values);
    break;
  }
  case "serve": {
    const { positionals, values } = safeParseArgs({
      args: subArgs,
      options: { help: { type: "boolean", short: "h" }, port: { type: "string", short: "p" }, filter: { type: "string", short: "f" }, preset: { type: "string" }, bind: { type: "string" }, hub: { type: "boolean" }, "usage-limits": { type: "boolean" } },
      allowPositionals: true,
    });
    const { cmdServe } = await loadCommands();
    cmdServe(positionals, { ...hubConfig()?.serve, ...values });
    break;
  }
  case "presets":
  case "preset": {
    cmdPresets();
    break;
  }
  case "help": {
    showHelp();
    break;
  }
  default:
    die(`Unknown command: ${subcommand}\nRun 'tracequest --help' for usage.`);
  }
}

dispatch().catch((err) => {
  die(err?.message || String(err));
});
