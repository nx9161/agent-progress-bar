# agent-progress-mcp

MCP server connector for the Universal Agent Progress Bar protocol. Any
MCP-compatible AI agent connects over stdio and reports live progress
(`report_progress`); any client can read it back (`get_status`). The server
keeps the latest report per `task_id` in memory with a TTL — no accounts, no
telemetry, nothing leaves the machine.

## Install

Exact-pinned dependencies. **First:** this lockfile was authored offline —
run `npm install` once with network access to regenerate resolved URLs and
integrity hashes, then use `npm ci` from then on:

```sh
cd packages/mcp-server
npm install     # one-time, regenerates package-lock.json from the registry
npm run build   # tsc -> dist/
npm start       # node dist/index.js (stdio)
```

Development: `npm run dev` (tsx, no build step). Tests: `npm test`
(`node --test test/stdout-purity.test.ts` — zero dependencies; includes the stdout-purity guard).

Global install for everyday use:

```sh
npm install -g agent-progress-mcp
```

## Claude Desktop config

Add to your MCP client config (`claude_desktop_config.json` → `mcpServers`):

```json
{
  "mcpServers": {
    "agent-progress": {
      "command": "npx",
      "args": ["-y", "agent-progress-mcp"],
      "env": {
        "PROGRESS_TTL_MS": "1800000",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

(Use `"command": "agent-progress-mcp", "args": []` if installed globally.)

## Tools

### `report_progress`

```json
{
  "task_id": "claude:summarize-report",
  "percent": 42,
  "eta_seconds": 30,
  "stage": "Reasoning",
  "message": "reading section 3 of 7"
}
```

- `percent` 0–100. The server **clamps** out-of-range values and never
  errors on regression (progress going backwards is fine).
- `eta_seconds` may be `null` = unknown. **Honesty rule: never fabricate
  an ETA** — report `null` rather than a guess.
- `percent: 100` automatically sets `complete: true`.
- `task_id` convention: `agentName:taskSlug` (e.g. `claude:summarize-report`,
  `deepseek:long-search`). The server enforces the charset
  (`^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$`) only — the naming convention is a
  social contract, documented here.

### `get_status`

```json
{ "task_id": "claude:summarize-report" }
```

Returns:

```json
{
  "task_id": "claude:summarize-report",
  "percent": 42,
  "eta_seconds": 30,
  "stage": "Reasoning",
  "message": "reading section 3 of 7",
  "complete": false,
  "updated_at": "2026-10-14T02:00:00.000Z"
}
```

Unknown `task_id` → `{ "error": "not_found", "task_id": "..." }`.

## Worked example (report → get_status)

1. The agent starts a long task and reports:
   `report_progress({task_id: "claude:summarize-report", percent: 5, eta_seconds: null, stage: "Reading context", status: "started"})`
   (reported via the tool's input shape; `status`/`timestamp` are
   server-managed on the stored record).
2. Mid-run it updates: `report_progress({task_id: "claude:summarize-report", percent: 60, eta_seconds: 45, stage: "Drafting reply"})`.
3. A dashboard calls `get_status({task_id: "claude:summarize-report"})` and
   renders the bar at 60% with a 0:45 countdown.
4. Done: `report_progress({task_id: "claude:summarize-report", percent: 100, stage: "Done"})` → `complete: true`.

## Store behavior

- `InMemoryProgressStore`: `Map`, max **1,000 entries**, active TTL sweep
  (default 30 min, override with `PROGRESS_TTL_MS`), **oldest-first
  eviction** past the cap, last-write-wins.
- Records are JSON-serializable. `createServer(store)` in `src/server.ts`
  is transport-agnostic; `src/index.ts` attaches `StdioServerTransport` only.

## Logging

Structured JSON-lines to **stderr only**. stdout carries MCP protocol
frames exclusively — `console.log` and direct stdout writes are banned and
enforced by `test/stdout-purity.test.ts`. `LOG_LEVEL` env (`debug`/`info`/
`warn`/`error`, default `info`). Logged fields are CR/LF-stripped; secrets
are never logged (none exist in v0).

## Graceful shutdown

SIGINT/SIGTERM → stops the TTL sweep, exits 0.
