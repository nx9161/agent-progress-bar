# agent-progress CLI — INTERNAL tooling

> **INTERNAL.** This package is developer tooling for driving and testing the
> `agent-progress-mcp` server during development. It is **not** the public API
> surface. The public integration surface is the MCP server (`packages/mcp-server`)
> plus the `<uapb-progress>` widget (`packages/widget`).

A zero-runtime-dependency command-line client that spawns the MCP server over
stdio and exposes **each and every MCP tool 1:1 as a command** — the full
control surface, in your terminal.

## Install

```bash
cd packages/cli
npm install        # devDeps only (typescript, @types/node)
npm run build
npm install -g .   # exposes the `agent-progress` binary
```

Requires Node >= 18.

## How it finds the server

1. `$AGENT_PROGRESS_MCP_CMD` if set (space-separated command line)
2. Sibling `packages/mcp-server/dist/index.js` in a monorepo checkout
3. Fallback: `npx -y agent-progress-mcp`

Build the server first (`cd ../mcp-server && npm install && npm run build`)
so option 2 resolves.

## Commands

| Command | MCP tool | What it does |
|---|---|---|
| `report --task <id> --percent <n> [--eta <s>] [--stage "..."] [--message "..."]` | `report_progress` | Report progress for a task |
| `status --task <id>` | `get_status` | Pretty-print last reported status |
| `tools` | `tools/list` | List every MCP tool with its arg schema |
| `list` | — | Local registry of task_ids this CLI touched (`~/.agent-progress/tasks.json`) |
| `demo [--duration 45]` | `report_progress` | Scripted terminal run: live ASCII bar + % + mm:ss countdown + stages |
| `watch --task <id> [--interval 1]` | `get_status` (poll) | Live bar until the task completes |

Every command supports `--help`. Global: `agent-progress --help`, `--version`.

## Example sessions

```bash
# 1. See the whole control surface
agent-progress tools

# 2. Report progress (validates args client-side before any MCP traffic)
agent-progress report --task claude:doc-rewrite-042 --percent 10 --stage "Reading context"

agent-progress report --task claude:doc-rewrite-042 --percent 62 \
  --eta 45 --stage "Drafting section 3" --message "on track"

# 3. Check what the server stored
agent-progress status --task claude:doc-rewrite-042
# █████████████████░░░░░░░░░░░   62%   0:45 remaining  Drafting section 3
#   task:     claude:doc-rewrite-042
#   status:   in progress
#   message:  on track
#   updated:  2026-10-13T22:05:00.000Z

# 4. End-to-end check: simulated run that ALSO drives the real server
agent-progress demo --duration 15

# 5. Watch another agent's task live (e.g. reported by a second terminal)
agent-progress watch --task claude:doc-rewrite-042

# 6. What have I touched?
agent-progress list
```

## Validation (mirrors the server, fails fast)

- `--task`: 1–128 chars, `^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$`
- `--percent`: integer 0–100
- `--eta`: non-negative number, max 86400s; **omit when unknown** (honesty rule — never fabricate)
- `--stage`: max 120 chars · `--message`: max 280 chars (protocol contract)

## Notes

- **State scope (v0, read this):** the v0 MCP server keeps state in memory for
  the lifetime of one server process, and each CLI command spawns its own
  server process. So `report` in one command followed by `status` in another
  will **not** see each other's data — each command gets a fresh, empty
  server. Within a single command it all works: `demo` reports and renders
  against one live server process, and `watch` polls one process until done.
  To drive a long-lived server across commands, point
  `$AGENT_PROGRESS_MCP_CMD` at it (e.g. a server you started yourself and
  keep running). Persistent, shared task state is a v1 (live relay) feature —
  this is the documented v0 non-goal, not a CLI bug.
- No network, no secrets, no telemetry. The server runs as a local child
  process; the registry is a user-local file (`~/.agent-progress/tasks.json`,
  mode 0600).
- `demo` degrades gracefully: if the MCP server is unreachable it runs the
  local simulation and says so on stderr.
- Exit codes: `0` ok · `1` validation/tool error · `2` usage error.
