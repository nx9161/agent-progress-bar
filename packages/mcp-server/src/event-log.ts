// SPDX-License-Identifier: MIT
// Universal event substrate: every report_progress call is appended here as
// one JSON line in a local, private JSONL log. Best-effort by design — a
// logging failure must NEVER break the MCP tool call (Phase 2 policy).
// Zero dependencies: node:fs / node:os / node:path only.

import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ProgressRecord } from "./store.js";

const PROTO_VERSION = 1;
const DEFAULT_DIR_NAME = ".agent-progress";
const MAX_FILE_BYTES = 50 * 1024 * 1024; // ~50MB (C5: bounded disk growth)
const RETENTION_DAYS = 7;
const RATE_LIMIT_PER_SECOND = 20; // C5: safety valve; every drop is counted and marked
const STDERR_WARN_INTERVAL_MS = 60_000; // at most one stderr warning per minute
const MAX_TRACKED_TASKS = 10_000; // bound the per-task window map (C5)
// C4: exact-match only — retention must never touch files outside this shape.
const FILE_NAME_RE = /^events-\d{4}-\d{2}-\d{2}(\.\d+)?\.jsonl$/;

export interface EventLogOptions {
  /** Clock injection for hermetic tests. Defaults to Date.now. */
  now?: () => number;
  /** Max bytes per daily file before numeric-suffix roll. Defaults to 50MB. */
  maxFileBytes?: number;
  /** Appends per task per second before drops. Defaults to 20. */
  rateLimitPerSecond?: number;
}

/** One serialized progress event. message is present only when the record has one. */
interface ProgressEvent {
  proto: 1;
  task_id: string;
  percent: number;
  eta_seconds: number | null;
  stage: string;
  message?: string;
  complete: boolean;
  timestamp: string;
  agent: string;
  session_id: string;
}

/** Honest drop-counter marker: one per window in which events were dropped. */
interface DropMarkerEvent {
  proto: 1;
  type: "dropped";
  task_id: string;
  dropped_count: number;
  timestamp: string;
  agent: string;
  session_id: string;
}

function resolveEventsDir(): string {
  const override = process.env.AGENT_PROGRESS_EVENTS_DIR;
  if (override !== undefined && override !== "") {
    // C4: a relative override would resolve against the server's cwd — refuse it.
    if (!isAbsolute(override)) {
      throw new Error("AGENT_PROGRESS_EVENTS_DIR must be an absolute path");
    }
    return override;
  }
  return join(homedir(), DEFAULT_DIR_NAME);
}

/**
 * Agent identity binding (Iron Man §3 — overrides all else):
 * UAPB_AGENT env (trimmed, non-empty) → task_id prefix before the FIRST ":"
 * → "unknown". ZERO tool-schema change: identity is derived, never requested.
 */
export function resolveAgent(taskId: string): string {
  const fromEnv = process.env.UAPB_AGENT?.trim();
  if (fromEnv) return fromEnv;
  const sep = taskId.indexOf(":");
  if (sep > 0) return taskId.slice(0, sep); // sep > 0 guarantees a non-empty prefix
  return "unknown";
}

function utcDayString(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function startOfUtcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function errSummary(err: unknown): string {
  const e = err as NodeJS.ErrnoException | null;
  const code = e && typeof e.code === "string" ? ` [${e.code}]` : "";
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/[\r\n]/g, " ").slice(0, 200) + code; // no secrets: code + scrubbed message only
}

export class EventLog {
  private readonly dir: string;
  private readonly now: () => number;
  private readonly maxFileBytes: number;
  private readonly rateLimit: number;
  private fd: number | undefined;
  private currentDay = "";
  private currentIndex = 0;
  private lastStderrWarn = 0;
  private readonly windows = new Map<
    string,
    { window: number; count: number; dropped: number; agent: string; sessionId: string }
  >();

  constructor(opts?: EventLogOptions) {
    this.dir = resolveEventsDir();
    this.now = opts?.now ?? Date.now;
    this.maxFileBytes = opts?.maxFileBytes ?? MAX_FILE_BYTES;
    this.rateLimit = opts?.rateLimitPerSecond ?? RATE_LIMIT_PER_SECOND;

    // C4: lstat (not stat) — refuse to operate through a symlinked dir.
    let st: ReturnType<typeof lstatSync> | undefined;
    try {
      st = lstatSync(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (st !== undefined) {
      if (st.isSymbolicLink()) {
        throw new Error(`refusing symlinked events dir: ${this.dir}`);
      }
      if (!st.isDirectory()) {
        throw new Error(`events path is not a directory: ${this.dir}`);
      }
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700); // C4: enforce 0700, don't trust umask or a pre-existing mode
    this.prune(this.now());
    this.ensureFile(this.now());
  }

  /**
   * Append one event for a validated progress record. Synchronous, so the
   * caller can rely on it completing before the tool result is returned.
   * Never throws out of here in a way that breaks the MCP tool call: write
   * failures drop the event with a rate-limited stderr warning (Phase 2).
   */
  append(rec: ProgressRecord, agent: string, sessionId: string): void {
    try {
      this.appendInner(rec, agent, sessionId);
    } catch (err) {
      this.warnOncePerMinute("event_log_write_failed", {
        task_id: rec.task_id,
        error: errSummary(err),
      });
    }
  }

  private appendInner(rec: ProgressRecord, agent: string, sessionId: string): void {
    const now = this.now();
    const taskId = rec.task_id;

    // C5: per-task append rate cap — a safety valve, not a filter. Exceeded
    // windows drop events but emit ONE honest marker so the log stays truthful.
    const window = Math.floor(now / 1000);
    let w = this.windows.get(taskId);
    if (w === undefined || w.window !== window) {
      if (w !== undefined && w.dropped > 0) {
        this.writeMarker(taskId, agent, sessionId, w.dropped, now);
      }
      w = { window, count: 0, dropped: 0, agent, sessionId };
      this.windows.set(taskId, w);
      if (this.windows.size > MAX_TRACKED_TASKS) this.windows.clear(); // C5: bound memory
    } else {
      w.agent = agent;
      w.sessionId = sessionId;
    }
    if (w.count >= this.rateLimit) {
      w.dropped += 1;
      return; // drop the event; the marker goes out at window rollover
    }
    w.count += 1;

    // Build from VALIDATED fields only (rec came through the strict store).
    // Exactly one JSON.stringify for the whole line — no string concatenation (C3).
    const event: ProgressEvent = {
      proto: PROTO_VERSION,
      task_id: taskId,
      percent: rec.percent,
      eta_seconds: rec.eta_seconds,
      stage: rec.stage,
      ...(typeof rec.message === "string" ? { message: rec.message } : {}),
      complete: rec.complete,
      timestamp: rec.updated_at, // the record's own timestamp, not "now"
      agent,
      session_id: sessionId,
    };
    this.ensureFile(now);
    this.writeLine(event);
  }

  private writeMarker(
    taskId: string,
    agent: string,
    sessionId: string,
    droppedCount: number,
    now: number
  ): void {
    const marker: DropMarkerEvent = {
      proto: PROTO_VERSION,
      type: "dropped",
      task_id: taskId,
      dropped_count: droppedCount,
      timestamp: new Date(now).toISOString(),
      agent,
      session_id: sessionId,
    };
    this.ensureFile(now);
    this.writeLine(marker);
  }

  private writeLine(obj: unknown): void {
    if (this.fd === undefined) throw new Error("event log file not open");
    writeSync(this.fd, JSON.stringify(obj) + "\n", null, "utf8");
  }

  private ensureFile(now: number): void {
    const day = utcDayString(now);
    if (this.fd === undefined || day !== this.currentDay) {
      this.closeFd();
      if (day !== this.currentDay) this.prune(now); // C4: retention sweep on day rollover
      this.currentDay = day;
      this.currentIndex = 0;
      this.openNextAvailable(day);
      return;
    }
    if (fstatSync(this.fd).size >= this.maxFileBytes) {
      // C5: size-triggered roll to a numeric suffix (events-YYYY-MM-DD.N.jsonl).
      this.closeFd();
      this.openNextAvailable(day);
    }
  }

  private openNextAvailable(day: string): void {
    let index = this.currentIndex;
    for (;;) {
      const name =
        index === 0 ? `events-${day}.jsonl` : `events-${day}.${index}.jsonl`;
      let size = -1;
      try {
        size = statSync(join(this.dir, name)).size;
      } catch {
        // absent — this suffix is free
      }
      if (size < 0 || size < this.maxFileBytes) {
        this.openFile(day, index);
        return;
      }
      index += 1;
    }
  }

  private openFile(day: string, index: number): void {
    const name =
      index === 0 ? `events-${day}.jsonl` : `events-${day}.${index}.jsonl`;
    const path = join(this.dir, name);
    // O_APPEND|O_CREAT with mode 0600, then fchmodSync to be certain (C4:
    // umask must not weaken it). O_NOFOLLOW: refuse symlink file redirection.
    const fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
      0o600
    );
    try {
      fchmodSync(fd, 0o600); // C4: exact 0600 regardless of umask at creation
    } catch (err) {
      closeSync(fd);
      throw err;
    }
    this.fd = fd;
    this.currentDay = day;
    this.currentIndex = index;
  }

  /** Delete event files older than 7 days; never touch non-matching files (C4). */
  private prune(now: number): void {
    const cutoff = startOfUtcDay(now) - RETENTION_DAYS * 86_400_000;
    let entries: string[];
    try {
      entries = readdirSync(this.dir);
    } catch {
      return; // best-effort: a listing failure must not break construction
    }
    for (const name of entries) {
      if (!FILE_NAME_RE.test(name)) continue; // C4: never delete anything not matching
      const dayMs = Date.parse(`${name.slice(7, 17)}T00:00:00Z`);
      if (Number.isNaN(dayMs) || dayMs >= cutoff) continue;
      try {
        unlinkSync(join(this.dir, name));
      } catch {
        // best-effort: a stubborn file must not break the log
      }
    }
  }

  private closeFd(): void {
    if (this.fd !== undefined) {
      try {
        closeSync(this.fd);
      } catch {
        // best-effort
      }
      this.fd = undefined;
    }
  }

  /** stderr only (stdout is reserved for MCP frames); max one warning/minute; no secrets. */
  private warnOncePerMinute(msg: string, fields: Record<string, unknown>): void {
    const now = this.now();
    if (now - this.lastStderrWarn < STDERR_WARN_INTERVAL_MS) return;
    this.lastStderrWarn = now;
    const scrub = (v: unknown): unknown =>
      typeof v === "string" ? v.replace(/[\r\n]/g, " ") : v;
    const line: Record<string, unknown> = {
      ts: new Date(now).toISOString(),
      level: "warn",
      msg,
    };
    for (const key of Object.keys(fields)) line[key] = scrub(fields[key]);
    try {
      process.stderr.write(JSON.stringify(line) + "\n");
    } catch {
      // last resort: give up rather than throw
    }
  }

  /** Flush pending drop markers honestly, then release the file descriptor. */
  close(): void {
    const now = this.now();
    try {
      for (const [taskId, w] of this.windows) {
        if (w.dropped > 0) {
          this.writeMarker(taskId, w.agent, w.sessionId, w.dropped, now);
          w.dropped = 0;
        }
      }
    } catch {
      // best-effort: close must not throw
    }
    this.closeFd();
  }
}
