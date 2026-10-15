// SPDX-License-Identifier: MIT
// INTERNAL tooling — implementations of every CLI command. Each command
// maps 1:1 onto an MCP tool on the server ("each and every button").

import { CliError, McpClient, type ToolDef } from "./mcp.js";
import {
  defaultEventsDir,
  eventsFile,
  installGracefulShutdown,
  readEventsFile,
  startDashboardServer,
  type DashboardEvent,
} from "./dashboard-server.js";
import { listTasks, registryPath, touchTask } from "./registry.js";
import {
  bar,
  clearPad,
  formatCountdown,
  isTTY,
  progressLine,
} from "./render.js";
import {
  validateDuration,
  validateEta,
  validateInterval,
  validateLimit,
  validateMessage,
  validatePercent,
  validateStage,
  validateTaskId,
} from "./validate.js";

export interface Flags {
  [key: string]: string | boolean | undefined;
}

export interface StatusResult {
  task_id: string;
  percent: number;
  eta_seconds: number | null;
  stage: string | null;
  message: string | null;
  complete: boolean;
  updated_at: string;
}

function withClient<T>(fn: (client: McpClient) => Promise<T>): Promise<T> {
  const client = new McpClient();
  return (async () => {
    try {
      await client.connect();
      return await fn(client);
    } catch (err) {
      if (err instanceof CliError) throw err;
      throw new CliError(
        `failed to talk to MCP server (${client.serverLabel}): ${(err as Error).message}`
      );
    } finally {
      await client.close();
    }
  })();
}

function asStatus(raw: unknown): StatusResult {
  const r = raw as Record<string, unknown>;
  const content = Array.isArray(r.content) ? r.content[0] : undefined;
  let payload: Record<string, unknown> = {};
  if (content && typeof content === "object" && "text" in content) {
    try {
      payload = JSON.parse(String((content as { text: string }).text));
    } catch {
      throw new CliError("server returned an unreadable status payload");
    }
  } else if (r.structuredContent && typeof r.structuredContent === "object") {
    payload = r.structuredContent as Record<string, unknown>;
  }
  return {
    task_id: String(payload.task_id ?? ""),
    percent: Number(payload.percent ?? 0),
    eta_seconds:
      payload.eta_seconds === null || payload.eta_seconds === undefined
        ? null
        : Number(payload.eta_seconds),
    stage:
      payload.stage === null || payload.stage === undefined
        ? null
        : String(payload.stage),
    message:
      payload.message === null || payload.message === undefined
        ? null
        : String(payload.message),
    complete: Boolean(payload.complete) || Number(payload.percent) >= 100,
    updated_at: String(payload.updated_at ?? ""),
  };
}

export async function cmdReport(flags: Flags): Promise<void> {
  const taskId = validateTaskId(flags.task);
  const percent = validatePercent(flags.percent);
  const eta = validateEta(flags.eta);
  const stage = validateStage(flags.stage);
  const message = validateMessage(flags.message);

  const args: Record<string, unknown> = { task_id: taskId, percent };
  if (eta !== undefined) args.eta_seconds = eta;
  if (stage !== undefined) args.stage = stage;
  if (message !== undefined) args.message = message;

  await withClient(async (client) => {
    await client.callTool("report_progress", args);
  });
  touchTask(taskId, { lastPercent: percent, lastStage: stage ?? null });
  console.log(
    `ok: "${taskId}" -> ${percent}%${stage ? ` (${stage})` : ""}${
      eta !== undefined ? `, eta ${formatCountdown(eta)}` : ""
    }`
  );
}

export async function cmdStatus(flags: Flags): Promise<void> {
  const taskId = validateTaskId(flags.task);
  const st = await withClient(async (client) => {
    return asStatus(await client.callTool("get_status", { task_id: taskId }));
  });
  touchTask(taskId, { lastPercent: st.percent, lastStage: st.stage });
  console.log(progressLine({ percent: st.percent, etaSeconds: st.eta_seconds, stage: st.stage }));
  console.log(`  task:     ${st.task_id}`);
  console.log(`  status:   ${st.complete ? "done" : "in progress"}`);
  if (st.message) console.log(`  message:  ${st.message}`);
  console.log(`  updated:  ${st.updated_at}`);
}

export async function cmdTools(): Promise<void> {
  const tools: ToolDef[] = await withClient(async (client) => client.listTools());
  console.log(`MCP control surface (${tools.length} tool${tools.length === 1 ? "" : "s"}):`);
  console.log("");
  for (const t of tools) {
    console.log(`  ${t.name}`);
    if (t.description) console.log(`    ${t.description}`);
    console.log(`    args: ${JSON.stringify(t.inputSchema)}`);
    console.log("");
  }
}

export async function cmdList(): Promise<void> {
  const tasks = listTasks();
  if (tasks.length === 0) {
    console.log(`no tasks yet (registry: ${registryPath()})`);
    console.log('hint: run "agent-progress report --task demo:1 --percent 10" first');
    return;
  }
  console.log(`task registry (${registryPath()}):`);
  for (const t of tasks) {
    const pct = t.lastPercent === null ? "  -" : `${String(t.lastPercent).padStart(3, " ")}%`;
    console.log(`  ${pct}  ${t.id}${t.lastStage ? `  (${t.lastStage})` : ""}`);
  }
}

const DEMO_STAGES = [
  { label: "Reading context", frac: 0.18 },
  { label: "Searching memory", frac: 0.42 },
  { label: "Reasoning", frac: 0.72 },
  { label: "Drafting reply", frac: 0.97 },
  { label: "Done", frac: 1.0 },
];

function easeInOutCubic(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

function stageFor(t: number): string {
  // "Done" is terminal-only; before t=1 the run is always in a working stage.
  if (t >= 1) return "Done";
  for (const s of DEMO_STAGES) {
    if (s.label !== "Done" && t <= s.frac) return s.label;
  }
  return "Drafting reply";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Scripted simulated run in the terminal. Drives the REAL MCP server too
 * (task cli:demo-<ts>) so it doubles as an end-to-end integration check;
 * falls back to local-only if the server is unreachable.
 */
export async function cmdDemo(flags: Flags): Promise<void> {
  const durationS = validateDuration(flags.duration);
  const durationMs = durationS * 1000;
  const taskId = `cli:demo-${Date.now()}`;

  let client: McpClient | null = null;
  try {
    client = new McpClient();
    await client.connect();
  } catch (err) {
    console.error(
      `warning: MCP server unreachable (${(err as Error).message}) — running local simulation only`
    );
    client = null;
  }

  const tty = isTTY();
  const started = Date.now();
  let lastInt = -1;
  let lastReport = 0;
  let done = false;

  const draw = (percent: number, etaS: number, stage: string) => {
    const line = progressLine({ percent, etaSeconds: etaS, stage });
    if (tty) {
      process.stdout.write("\r" + clearPad(line));
    } else if (Math.round(percent) !== lastInt) {
      console.log(line);
      lastInt = Math.round(percent);
    }
  };

  try {
    while (!done) {
      const elapsed = Date.now() - started;
      const t = Math.min(1, elapsed / durationMs);
      const eased = easeInOutCubic(t);
      const percent = Math.min(100, Math.round(eased * 100));
      const etaS = Math.max(0, (durationMs - elapsed) / 1000);
      const stage = stageFor(t);
      draw(percent, etaS, stage);

      const now = Date.now();
      if (client && (now - lastReport >= 500 || t >= 1)) {
        lastReport = now;
        try {
          await client.callTool("report_progress", {
            task_id: taskId,
            percent,
            eta_seconds: Math.round(etaS),
            stage,
          });
        } catch {
          // Local render is the source of truth; a flaky server must not
          // break the visible demo.
        }
      }

      if (t >= 1) {
        done = true;
      } else {
        await sleep(100);
      }
    }

    if (client) {
      try {
        await client.callTool("report_progress", {
          task_id: taskId,
          percent: 100,
          eta_seconds: 0,
          stage: "Done",
        });
      } catch {
        /* already handled above */
      }
      touchTask(taskId, { lastPercent: 100, lastStage: "Done" });
    }
  } finally {
    if (client) await client.close();
  }

  if (tty) process.stdout.write("\n");
  console.log(`Done in ${formatCountdown(durationS)} (task "${taskId}")`);
}

/** Poll get_status and render a live bar until the task completes. */
export async function cmdWatch(flags: Flags): Promise<void> {
  const taskId = validateTaskId(flags.task);
  const intervalS = validateInterval(flags.interval);
  const tty = isTTY();

  await withClient(async (client) => {
    for (;;) {
      let st: StatusResult;
      try {
        st = asStatus(await client.callTool("get_status", { task_id: taskId }));
      } catch (err) {
        throw new CliError(
          `cannot watch "${taskId}": ${(err as Error).message}`
        );
      }
      touchTask(taskId, { lastPercent: st.percent, lastStage: st.stage });
      const line = progressLine({
        percent: st.percent,
        etaSeconds: st.eta_seconds,
        stage: st.stage,
      });
      if (tty) {
        process.stdout.write("\r" + clearPad(line));
      } else {
        console.log(line);
      }
      if (st.complete || st.percent >= 100) break;
      await sleep(intervalS * 1000);
    }
  });

  if (tty) process.stdout.write("\n");
  console.log(`task "${taskId}" complete`);
}

/**
 * Serve the dashboard SPA + localhost SSE stream over the JSONL event log.
 * Binds 127.0.0.1 only (hardcoded, AppSec C14), scans ports 17421-17430,
 * mints a per-launch 128-bit token (C1). Blocks until SIGINT/SIGTERM.
 * The token is printed to the operator's terminal (stdout) only — never to
 * logs, argv, or env — and dies with the process.
 */
export async function cmdDashboard(): Promise<void> {
  const handle = await startDashboardServer();
  installGracefulShutdown(handle);
  console.log(
    `UAPB dashboard: http://127.0.0.1:${handle.port}/?token=${handle.token}`
  );
  console.log(`events dir: ${handle.eventsDir}`);
  await new Promise<void>(() => {
    /* block until SIGINT/SIGTERM */
  });
}

/**
 * Read-only inspector for the JSONL event log. Prints newest-first compact
 * lines: <timestamp> <agent> <session_id> <task_id> <percent>% <stage>.
 * Never writes. ("-" when absent.)
 */
export async function cmdEvents(flags: Flags): Promise<void> {
  const agent = typeof flags.agent === "string" ? flags.agent : undefined;
  const task = typeof flags.task === "string" ? flags.task : undefined;
  const limit = validateLimit(flags.limit);
  const file =
    typeof flags.file === "string" && flags.file.length > 0
      ? flags.file
      : eventsFile(defaultEventsDir());

  let events: DashboardEvent[] = readEventsFile(file).map((e) => e.event);
  if (agent !== undefined) events = events.filter((e) => e.agent === agent);
  if (task !== undefined) events = events.filter((e) => e.task_id === task);
  const newest = events.reverse().slice(0, limit);

  if (newest.length === 0) {
    console.log(`no events in ${file}`);
    return;
  }
  for (const e of newest) {
    const session = typeof e.session_id === "string" ? e.session_id : "-";
    console.log(
      `${e.timestamp} ${e.agent ?? "-"} ${session} ${e.task_id} ${e.percent}% ${e.stage}`
    );
  }
}
