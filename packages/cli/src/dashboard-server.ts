// SPDX-License-Identifier: MIT
// INTERNAL tooling — localhost-only dashboard server for the Universal Live
// Progress Layer. Serves the dashboard SPA shell plus a token-gated
// localhost SSE stream over the ~/.agent-progress/events-YYYY-MM-DD.jsonl log.
//
// Security posture:
//   C14 — binds 127.0.0.1 ONLY. The address is a hardcoded constant: no flag,
//         no env var, no config file may override it.
//   C1  — every /api/* route (health included) requires the per-launch
//         128-bit token in ?token=, compared with crypto.timingSafeEqual.
//   C2  — strict loopback-only CORS: the Origin hostname is parsed literally
//         (never resolved via DNS), echoed only when loopback, never "*".

import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  watch,
  type FSWatcher,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

// C14 — loopback bind is hardcoded. Changing this constant is the ONLY way
// to bind elsewhere, which is the point: no runtime input can widen it.
export const HOST = "127.0.0.1";

// Port scan range; first free port wins. Narrow on purpose so the URL is
// predictable for the operator and stray servers are easy to spot.
const PORT_RANGE = { from: 17421, to: 17430 } as const;

const HEARTBEAT_MS = 15_000; // SSE ": keep-alive" comment interval
const POLL_MS = 1_000; // fs.watch fallback: re-check the file every second
const REPLAY_DEFAULT = 200; // events replayed on /api/stream without ?resume=

/** A validated progress event from the JSONL log (mirrors protocol/types.ts). */
export interface DashboardEvent {
  task_id: string;
  percent: number;
  eta_seconds: number | null;
  stage: string;
  status: string;
  timestamp: string;
  agent?: string;
  message?: string;
  session_id?: string;
  [key: string]: unknown;
}

export interface EventWithOffset {
  event: DashboardEvent;
  /** Byte offset of the line's first byte in the JSONL file (see SSE ids). */
  offset: number;
}

const STATUS_SET = new Set(["started", "running", "paused", "done", "error"]);

/**
 * Validate + normalize a parsed JSONL line into a DashboardEvent.
 * The sink's event shape carries `complete` (boolean) but no `status`
 * (report_progress has no status field — frozen contract), so status is
 * DERIVED here: "done" when complete === true, else "running". An explicit
 * valid status is honored when present (forward compatibility).
 * Honest drop-counter markers ({type:"dropped"}) pass through with a
 * synthetic status so viewers can count them (AppSec C5).
 * Returns null for malformed lines — the caller drops them.
 */
function normalizeEvent(o: unknown): DashboardEvent | null {
  if (!o || typeof o !== "object") return null;
  const e = o as Record<string, unknown>;
  if (typeof e.task_id !== "string" || e.task_id.length === 0) return null;
  if (typeof e.timestamp !== "string" || e.timestamp.length === 0) return null;

  if (e.type === "dropped") {
    const count =
      typeof e.dropped_count === "number" && Number.isFinite(e.dropped_count)
        ? e.dropped_count
        : 0;
    return {
      task_id: e.task_id,
      percent: 0,
      eta_seconds: null,
      stage: "",
      status: "dropped",
      timestamp: e.timestamp,
      dropped_count: count,
    };
  }

  if (
    typeof e.percent !== "number" ||
    !Number.isFinite(e.percent) ||
    !(e.eta_seconds === null || typeof e.eta_seconds === "number") ||
    typeof e.stage !== "string"
  ) {
    return null;
  }
  let status: string;
  if (typeof e.status === "string" && STATUS_SET.has(e.status)) {
    status = e.status;
  } else {
    // The sink records `complete`; derive the display status honestly.
    status = e.complete === true ? "done" : "running";
  }
  const out: DashboardEvent = {
    task_id: e.task_id,
    percent: e.percent,
    eta_seconds: e.eta_seconds,
    stage: e.stage,
    status,
    timestamp: e.timestamp,
  };
  if (typeof e.agent === "string") out.agent = e.agent;
  if (typeof e.message === "string") out.message = e.message;
  if (typeof e.session_id === "string") out.session_id = e.session_id;
  return out;
}

/**
 * Local JSONL reader (~30 lines, deliberately duplicated — do NOT import
 * across packages). Reads the whole file, splits on \n, JSON.parse in
 * try/catch, validates required field types, drops malformed lines.
 * Missing/unreadable file => [] (the log simply has no events yet).
 */
export function readEventsFile(file: string): EventWithOffset[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: EventWithOffset[] = [];
  let offset = 0;
  for (const line of raw.split("\n")) {
    const len = Buffer.byteLength(line, "utf8");
    if (line.trim() !== "") {
      try {
        // normalizeEvent validates field types and derives `status`
        // (the sink records `complete`, not `status`); malformed lines
        // are dropped, never rendered.
        const normalized = normalizeEvent(JSON.parse(line));
        if (normalized) out.push({ event: normalized, offset });
      } catch {
        /* drop malformed line */
      }
    }
    offset += len + 1; // +1 for the stripped newline
  }
  return out;
}

/**
 * Default events dir: ~/.agent-progress (one events-YYYY-MM-DD.jsonl per day).
 * Honors AGENT_PROGRESS_EVENTS_DIR (absolute only) — must match the MCP
 * server's event-log.ts resolution exactly, or the dashboard reads nothing.
 */
export function defaultEventsDir(): string {
  const override = process.env.AGENT_PROGRESS_EVENTS_DIR;
  if (override !== undefined && override !== "") {
    if (!isAbsolute(override)) {
      throw new Error("AGENT_PROGRESS_EVENTS_DIR must be an absolute path");
    }
    return override;
  }
  return join(homedir(), ".agent-progress");
}

export function todayFilename(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `events-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.jsonl`;
}

export function eventsFile(dir: string, d: Date = new Date()): string {
  return join(dir, todayFilename(d));
}

// ---------------------------------------------------------------------------
// C1 — token gating
// ---------------------------------------------------------------------------

function checkToken(req: IncomingMessage, token: string): boolean {
  // C1 — the token travels in ?token= only. It is printed to the operator's
  // terminal at startup and never written to logs, argv, or env.
  let provided: string | null = null;
  try {
    provided = new URL(req.url ?? "/", "http://localhost").searchParams.get(
      "token"
    );
  } catch {
    return false;
  }
  if (!provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(token, "utf8");
  // Lengths compared first: timingSafeEqual throws on mismatch, and the
  // length alone reveals nothing about the 128-bit value.
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// C2 — loopback-only CORS
// ---------------------------------------------------------------------------

// C2 — allowed Origin hostnames, matched LITERALLY against the parsed header.
// The parse is string surgery only (new URL); no DNS resolution happens here.
const LOOPBACK_ORIGINS = new Set(["127.0.0.1", "[::1]", "localhost"]);

function allowedOrigin(origin: string | undefined): string | null {
  if (!origin || origin === "null") return null;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return null;
  }
  return LOOPBACK_ORIGINS.has(host) ? origin : null;
}

function deny(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(message);
}

/**
 * Applies the CORS policy. Returns true when the request may continue.
 * Preflight (OPTIONS) is answered here too, under the same policy.
 */
function applyCors(
  req: IncomingMessage,
  res: ServerResponse,
  isApi: boolean
): boolean {
  // C2 — always send Vary: Origin so caches never mix origins.
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") {
    // C2 — preflight always carries an Origin; require the loopback allowlist.
    const preflightAllowed = allowedOrigin(req.headers.origin);
    if (!preflightAllowed) {
      deny(res, 403, "forbidden origin");
      return false;
    }
    // C2 — preflight gets the same loopback-only policy, never "*".
    res.writeHead(204, {
      "Access-Control-Allow-Origin": preflightAllowed,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Max-Age": "600",
    });
    res.end();
    return false;
  }

  if (req.headers.origin === undefined) {
    // C2 — no Origin header means a same-origin navigation/fetch or a
    // non-browser client (curl, node): CORS does not apply. The per-launch
    // token gate still authenticates every /api/* route. (A malicious
    // website's requests ALWAYS carry an Origin header, so this opens no
    // cross-origin hole.)
    return true;
  }
  const allowed = allowedOrigin(req.headers.origin);
  if (isApi && !allowed) {
    // C2 — cross-origin API calls must come from a literal loopback host.
    // "null" (sandboxed iframe) and foreign hosts are denied outright.
    deny(res, 403, "forbidden origin");
    return false;
  }
  if (allowed) {
    // C2 — echo the exact loopback origin; never "*", never an untrusted value.
    res.setHeader("Access-Control-Allow-Origin", allowed);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface DashboardHandle {
  server: Server;
  token: string;
  port: number;
  url: string;
  eventsDir: string;
  close: () => Promise<void>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function pathnameOf(req: IncomingMessage): string | null {
  try {
    return new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    return null;
  }
}

/**
 * Start the dashboard server.
 *
 * opts.port / opts.eventsDir exist ONLY for hermetic tests (ephemeral ports,
 * temp dirs). There is intentionally NO CLI flag or env var for them: the
 * bind address stays hardcoded (C14) and the port scan range is fixed.
 */
export async function startDashboardServer(
  opts: { port?: number; eventsDir?: string } = {}
): Promise<DashboardHandle> {
  const token = randomBytes(16).toString("base64url"); // 128-bit, per launch
  const eventsDir = opts.eventsDir ?? defaultEventsDir();
  mkdirSync(eventsDir, { recursive: true, mode: 0o700 });
  // N3 (mirrors C4 in the MCP server's event log): refuse to operate
  // through a symlinked dir, and enforce 0700 rather than trusting umask
  // or a pre-existing mode.
  if (lstatSync(eventsDir).isSymbolicLink()) {
    throw new Error(`refusing symlinked events dir: ${eventsDir}`);
  }
  chmodSync(eventsDir, 0o700);
  const startedAt = Date.now();

  // SPA shell lives at packages/dashboard/dist/index.html; from the compiled
  // dist/ dir that is ../../dashboard/dist/index.html. The file is built by
  // node scripts/build-dashboard.js (repo root) and carries its own CSP meta.
  const spaFile = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "dashboard",
    "dist",
    "index.html"
  );

  // ---- SSE live tail state (shared across stream clients) ----
  const sseClients = new Set<ServerResponse>();
  const heartbeats = new Map<ServerResponse, NodeJS.Timeout>();
  let watcher: FSWatcher | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let fileSize = 0; // bytes of today's file already consumed
  let tailRemainder = ""; // trailing partial line, not yet a full event
  // N2: decodes chunk bytes to text. A multi-byte UTF-8 char split across
  // two chunks is held internally and completed by the next write — without
  // this, buf.toString("utf8") would emit U+FFFD mid-char and corrupt the
  // byte offsets the SSE resume contract depends on.
  const utf8Decoder = new StringDecoder("utf8");

  const sendEvent = (res: ServerResponse, id: number, event: DashboardEvent) => {
    // SSE id = byte offset of the event's line start in today's JSONL file.
    // Offsets are monotonic while the file only appends, so ?resume=<offset>
    // replays exactly the events after that offset — that is the stream's
    // resume contract. A rotated/truncated file resets offsets; clients
    // should re-snapshot in that case.
    res.write(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`);
  };

  const pump = () => {
    const file = eventsFile(eventsDir);
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      size = 0;
    }
    if (size < fileSize) {
      fileSize = 0; // rotated or truncated: offsets reset (see sendEvent)
      tailRemainder = "";
      utf8Decoder.end(); // N2: discard any held partial char from the old file
    }
    if (size <= fileSize) return;
    const chunkStart = fileSize;
    let fd = -1;
    try {
      fd = openSync(file, "r");
      const buf = Buffer.alloc(size - chunkStart);
      readSync(fd, buf, 0, buf.length, chunkStart);
      fileSize = size;
      // N2: the decoder completes chars split across chunk boundaries; the
      // trailing remainder is then always a whole-char string, so the
      // byteLength-based offset accounting below stays exact.
      const chunk = tailRemainder + utf8Decoder.write(buf);
      const lines = chunk.split("\n");
      tailRemainder = lines.pop() ?? "";
      let offset = chunkStart;
      for (const line of lines) {
        const lineStart = offset;
        offset += Buffer.byteLength(line, "utf8") + 1;
        if (line.trim() === "") continue;
        try {
          const normalized = normalizeEvent(JSON.parse(line));
          if (normalized) {
            for (const client of sseClients) {
              try {
                sendEvent(client, lineStart, normalized);
              } catch {
                /* client going away; req close handler cleans up */
              }
            }
          }
        } catch {
          /* drop malformed line */
        }
      }
    } catch {
      /* file vanished mid-read; the next poll retries */
    } finally {
      if (fd >= 0) closeSync(fd);
    }
  };

  const ensureTailer = () => {
    if (watcher) return;
    try {
      watcher = watch(eventsDir, (eventType, name) => {
        if (typeof name === "string" && name === todayFilename()) pump();
      });
    } catch {
      watcher = null; // fs.watch unavailable: the poll fallback still works
    }
    pollTimer = setInterval(pump, POLL_MS);
    pollTimer.unref?.();
  };

  const releaseTailer = () => {
    if (sseClients.size > 0) return;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (watcher) {
      watcher.close();
      watcher = null;
    }
  };

  const startSse = (req: IncomingMessage, res: ServerResponse) => {
    // The resume cursor is an OPAQUE string from the dashboard: either one of
    // our numeric SSE id: values (byte offsets, see sendEvent) or the
    // dashboard's "<task_id>@<timestamp>" fallback when it never saw an id.
    // Both are accepted; an absent or unparseable cursor replays the last 200.
    let resumeRaw: string | null = null;
    try {
      resumeRaw = new URL(req.url ?? "/", "http://localhost").searchParams.get(
        "resume"
      );
    } catch {
      resumeRaw = null;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    // Sync the tail cursor BEFORE reading for replay: an event appended in
    // between is then re-sent by pump (duplicate, deduped by id) rather than
    // silently dropped.
    try {
      fileSize = statSync(eventsFile(eventsDir)).size;
    } catch {
      fileSize = 0;
    }
    const all = readEventsFile(eventsFile(eventsDir));
    let replay: EventWithOffset[];
    if (resumeRaw === null) {
      replay = all.slice(-REPLAY_DEFAULT);
    } else if (
      resumeRaw.trim() !== "" &&
      Number.isFinite(Number(resumeRaw)) &&
      Number(resumeRaw) >= 0
    ) {
      // Numeric cursor: one of our SSE id: byte offsets.
      const resume = Number(resumeRaw);
      replay = all.filter((e) => e.offset > resume);
    } else {
      // Opaque "<task_id>@<timestamp>" fallback cursor: replay everything
      // after the matching event; unknown cursor => last 200 (safe default).
      const idx = all.findIndex(
        (e) => `${e.event.task_id}@${e.event.timestamp}` === resumeRaw
      );
      replay = idx >= 0 ? all.slice(idx + 1) : all.slice(-REPLAY_DEFAULT);
    }
    for (const e of replay) sendEvent(res, e.offset, e.event);

    sseClients.add(res);
    ensureTailer();
    const hb = setInterval(() => {
      try {
        res.write(": keep-alive\n\n");
      } catch {
        /* req close handler cleans up */
      }
    }, HEARTBEAT_MS);
    hb.unref?.();
    heartbeats.set(res, hb);

    req.on("close", () => {
      const timer = heartbeats.get(res);
      if (timer) clearInterval(timer);
      heartbeats.delete(res);
      sseClients.delete(res);
      releaseTailer();
    });
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const pathname = pathnameOf(req);
    if (pathname === null) {
      deny(res, 400, "bad request");
      return;
    }
    const isApi = pathname.startsWith("/api/");
    if (!applyCors(req, res, isApi)) return;

    if (pathname === "/") {
      // Static SPA shell: carries no data, so no token. (C1 — data routes
      // below are the gated ones.)
      let html: string;
      try {
        html = readFileSync(spaFile, "utf8");
      } catch {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("dashboard not built — run: node scripts/build-dashboard.js");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(html);
      return;
    }

    if (!isApi) {
      deny(res, 404, "not found");
      return;
    }

    // C1 — health is gated too: no unauthenticated endpoints with teeth.
    if (!checkToken(req, token)) {
      json(res, 401, { ok: false, error: "unauthorized" });
      return;
    }

    if (pathname === "/api/health") {
      json(res, 200, {
        ok: true,
        uptime_s: Math.floor((Date.now() - startedAt) / 1000),
        events_today: readEventsFile(eventsFile(eventsDir)).length,
      });
      return;
    }

    if (pathname === "/api/snapshot") {
      // Latest event per task_id from today's JSONL; last-wins on file order.
      // Shape: a {task_id: event} map (dashboard accepts map or array; the
      // map was the recommended contract). Drop markers are stream metadata,
      // not task state — they are counted from the stream, not snapshotted.
      const latest = new Map<string, DashboardEvent>();
      for (const { event } of readEventsFile(eventsFile(eventsDir))) {
        if (event.status === "dropped") continue;
        latest.set(event.task_id, event);
      }
      json(res, 200, {
        ok: true,
        count: latest.size,
        tasks: Object.fromEntries(latest),
      });
      return;
    }

    if (pathname === "/api/stream") {
      startSse(req, res);
      return;
    }

    json(res, 404, { ok: false, error: "not found" });
  });

  const listen = (port: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, HOST); // C14 — HOST is the hardcoded loopback const.
    });

  let port = opts.port;
  if (port === undefined) {
    let lastErr: unknown = null;
    for (let p = PORT_RANGE.from; p <= PORT_RANGE.to; p++) {
      try {
        await listen(p);
        port = p;
        lastErr = null;
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
          lastErr = err;
          continue;
        }
        throw err;
      }
    }
    if (port === undefined) {
      throw new Error(
        `no free port in ${PORT_RANGE.from}-${PORT_RANGE.to}` +
          (lastErr ? `: ${(lastErr as Error).message}` : "")
      );
    }
  } else {
    await listen(port);
  }

  // With port 0 the OS picks an ephemeral port: read back the real one.
  const bound = server.address();
  if (bound && typeof bound === "object") {
    port = bound.port;
  }

  // N4: permanent error handler — a late server error is logged to stderr
  // and never crashes the process. Attached only after the port scan so
  // EADDRINUSE probes during the scan don't hit it.
  server.on("error", (err: Error) => {
    process.stderr.write(
      `[agent-progress dashboard] server error: ${err.message}\n`
    );
  });

  const close = async (): Promise<void> => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (watcher) {
      watcher.close();
      watcher = null;
    }
    for (const [res, hb] of heartbeats) {
      clearInterval(hb);
      try {
        res.end();
      } catch {
        /* already gone */
      }
    }
    heartbeats.clear();
    sseClients.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return {
    server,
    token,
    port,
    url: `http://${HOST}:${port}`,
    eventsDir,
    close,
  };
}

/** SIGINT/SIGTERM -> close server, SSE clients, watcher; exit 0. */
export function installGracefulShutdown(handle: DashboardHandle): void {
  let done = false;
  const shutdown = () => {
    if (done) return;
    done = true;
    handle.close().then(
      () => process.exit(0),
      () => process.exit(0)
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
