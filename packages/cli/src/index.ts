#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// INTERNAL tooling — entry point for the agent-progress CLI.
// Drives the agent-progress MCP server over stdio. Not the public API surface.

import { CliError } from "./mcp.js";
import {
  cmdDemo,
  cmdList,
  cmdReport,
  cmdStatus,
  cmdTools,
  cmdWatch,
  type Flags,
} from "./commands.js";

const VERSION = "0.1.0";

const GLOBAL_HELP = `agent-progress ${VERSION} — INTERNAL developer CLI for the agent-progress MCP server.

Usage: agent-progress <command> [options]

Commands (each maps 1:1 onto an MCP tool — the full control surface):
  report   Report progress for a task            -> report_progress
  status   Show the last reported status         -> get_status
  tools    List every MCP tool with its schema
  list     Show task_ids this CLI has touched (local registry)
  demo     Run a scripted simulated progress run in this terminal
  watch    Poll a task and render a live bar until it completes

Global options:
  -h, --help       Show help (use "<command> --help" for command help)
  -v, --version    Show version

INTERNAL tooling: for driving and testing the MCP server during development.
The public integration surface is the MCP server + the <uapb-progress> widget.
`;

const HELP: Record<string, string> = {
  report: `agent-progress report — report progress for a task (MCP: report_progress)

Usage: agent-progress report --task <id> --percent <0-100> [options]

Required:
  --task <id>        Task id: 1-128 chars, letters/digits start, then . _ - :
  --percent <n>      Integer 0-100

Optional:
  --eta <seconds>    Non-negative number; omit when unknown (honesty rule)
  --stage "..."      Human-readable stage label, max 120 chars
  --message "..."    One-line detail, max 280 chars

Example:
  agent-progress report --task claude:doc-rewrite-042 --percent 62 --eta 45 --stage "Drafting section 3"
`,
  status: `agent-progress status — show the last reported status (MCP: get_status)

Usage: agent-progress status --task <id>

Example:
  agent-progress status --task claude:doc-rewrite-042
`,
  tools: `agent-progress tools — list every MCP tool with its argument schema

Usage: agent-progress tools

This is the complete control surface: everything the server exposes,
with the exact args each tool accepts.
`,
  list: `agent-progress list — show task_ids this CLI has touched

Usage: agent-progress list

Reads the local registry (~/.agent-progress/tasks.json). The MCP server
contract is frozen, so this stays client-side by design.
`,
  demo: `agent-progress demo — scripted simulated progress run in this terminal

Usage: agent-progress demo [--duration <seconds>]

Options:
  --duration <s>   Run length in seconds, default 45 (max 3600)

Renders a live ASCII bar + % + mm:ss countdown + stage ticker, and also
drives the real MCP server (task cli:demo-<timestamp>) as an end-to-end
check. Falls back to a local-only simulation if the server is unreachable.
Ends exactly at 100% / 0:00 / Done.
`,
  watch: `agent-progress watch — poll a task and render a live bar until done

Usage: agent-progress watch --task <id> [--interval <seconds>]

Options:
  --task <id>         Task id to watch (required)
  --interval <s>      Poll interval, 0.2-60s, default 1

Exits when the task reports complete (or percent reaches 100).
`,
};

function parseArgs(argv: string[]): { command: string | null; flags: Flags; positionals: string[] } {
  const flags: Flags = {};
  const positionals: string[] = [];
  let command: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else if (a === "-h") {
      flags.help = true;
    } else if (a === "-v") {
      flags.version = true;
    } else if (command === null) {
      command = a;
    } else {
      positionals.push(a);
    }
  }
  return { command, flags, positionals };
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (flags.version) {
    console.log(VERSION);
    return;
  }
  if (flags.help && !command) {
    console.log(GLOBAL_HELP);
    return;
  }
  if (!command) {
    console.error(GLOBAL_HELP);
    process.exit(2);
  }
  if (flags.help && HELP[command]) {
    console.log(HELP[command]);
    return;
  }

  switch (command) {
    case "report":
      await cmdReport(flags);
      break;
    case "status":
      await cmdStatus(flags);
      break;
    case "tools":
      await cmdTools();
      break;
    case "list":
      await cmdList();
      break;
    case "demo":
      await cmdDemo(flags);
      break;
    case "watch":
      await cmdWatch(flags);
      break;
    case "help":
      console.log(GLOBAL_HELP);
      break;
    default:
      console.error(`unknown command "${command}"\n`);
      console.error(GLOBAL_HELP);
      process.exit(2);
  }
}

main().catch((err) => {
  if (err instanceof CliError) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
  console.error(`unexpected error: ${(err as Error).message}`);
  process.exit(1);
});
