// SPDX-License-Identifier: MIT
// Stdio bootstrap ONLY. Transport attachment lives here and nowhere else.
// STDOUT PURITY: stdout carries MCP protocol frames exclusively.
// All logging goes to stderr as JSON-lines. Never console.log here.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { InMemoryProgressStore } from "./store.js";
import { EventLog } from "./event-log.js";
import { createServer } from "./server.js";

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

function currentLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(raw) ? (raw as LogLevel) : "info";
}

/** Structured JSON-lines logging to stderr only. Strips CR/LF; never logs secrets. */
function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  const active = currentLevel();
  if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(active)) return;
  const scrub = (v: unknown): unknown =>
    typeof v === "string" ? v.replace(/[\r\n]/g, " ") : v;
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg: String(msg).replace(/[\r\n]/g, " "),
  };
  for (const key of Object.keys(fields)) {
    line[key] = scrub(fields[key]);
  }
  process.stderr.write(JSON.stringify(line) + "\n");
}

async function main(): Promise<void> {
  const store = new InMemoryProgressStore();
  // Universal event substrate. Degradation, not death: if the log cannot
  // start (unwritable dir, symlink refusal, relative override), the server
  // still serves tools — just without the JSONL sink.
  let eventLog: EventLog | undefined;
  try {
    eventLog = new EventLog();
  } catch (err) {
    log("warn", "event log disabled; continuing without event sink", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const server = createServer(store, { eventLog });
  const transport = new StdioServerTransport();

  const shutdown = (signal: string): void => {
    log("info", "shutting down", { signal });
    eventLog?.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await server.connect(transport);
  log("info", "agent-progress-mcp listening on stdio", {
    ttl_ms: process.env.PROGRESS_TTL_MS ?? "default",
  });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  log("error", "fatal startup error", { error: message });
  process.exit(1);
});
