// SPDX-License-Identifier: MIT
// In-memory progress store: TTL sweep, 1000-entry cap, oldest-first eviction.

/** Server-side stored record: the latest event per task_id plus bookkeeping. */
export interface ProgressRecord {
  task_id: string;
  percent: number;
  eta_seconds: number | null;
  stage: string;
  message?: string;
  complete: boolean;
  /** ISO-8601 UTC, server-assigned on every write. */
  updated_at: string;
}

export interface ReportInput {
  task_id: string;
  percent: number;
  eta_seconds?: number | null;
  stage?: string;
  message?: string;
}

export interface IProgressStore {
  report(input: ReportInput): ProgressRecord;
  get(task_id: string): ProgressRecord | undefined;
  size(): number;
  close(): void;
}

const TASK_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_ENTRIES = 1000;
const MAX_ETA_SECONDS = 86400; // 24h sanity cap (M3: hard bound)

function clampPercent(p: number): number {
  if (typeof p !== "number" || Number.isNaN(p)) return 0;
  return Math.min(100, Math.max(0, p));
}

function clampEta(e: number | null | undefined): number | null {
  if (e === null || e === undefined || Number.isNaN(e)) return null;
  return Math.min(MAX_ETA_SECONDS, Math.max(0, e));
}

export class InMemoryProgressStore implements IProgressStore {
  private readonly records = new Map<string, ProgressRecord>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(opts?: { ttlMs?: number; maxEntries?: number }) {
    const envTtl = Number(process.env.PROGRESS_TTL_MS);
    this.ttlMs =
      opts?.ttlMs ?? (Number.isFinite(envTtl) && envTtl > 0 ? envTtl : DEFAULT_TTL_MS);
    this.maxEntries = opts?.maxEntries ?? MAX_ENTRIES;
    // Active TTL sweep: runs at most once per minute so stale tasks die on time.
    this.sweepTimer = setInterval(() => this.sweep(), Math.min(this.ttlMs, 60_000));
    // Don't hold the process open for the sweep timer alone.
    const t = this.sweepTimer as unknown as { unref?: () => void };
    if (typeof t.unref === "function") t.unref();
  }

  private isExpired(rec: ProgressRecord, now: number): boolean {
    return now - Date.parse(rec.updated_at) >= this.ttlMs;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, rec] of this.records) {
      if (this.isExpired(rec, now)) this.records.delete(key);
    }
  }

  report(input: ReportInput): ProgressRecord {
    if (!TASK_ID_RE.test(input.task_id)) {
      throw new Error(
        "task_id must match ^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$ (1-128 chars)"
      );
    }
    const percent = clampPercent(input.percent);
    const nowIso = new Date().toISOString();
    const record: ProgressRecord = {
      task_id: input.task_id,
      percent,
      eta_seconds: clampEta(input.eta_seconds),
      stage: (input.stage ?? "").slice(0, 120),
      complete: percent >= 100,
      updated_at: nowIso,
    };
    if (typeof input.message === "string" && input.message.length > 0) {
      record.message = input.message.slice(0, 280);
    }
    // Last-write-wins. Re-insert so "oldest" for eviction = least recently written.
    this.records.delete(input.task_id);
    this.records.set(input.task_id, record);
    // Oldest-first eviction past the cap.
    while (this.records.size > this.maxEntries) {
      const oldest = this.records.keys().next();
      if (oldest.done) break;
      this.records.delete(oldest.value as string);
    }
    return record;
  }

  get(task_id: string): ProgressRecord | undefined {
    const rec = this.records.get(task_id);
    if (!rec) return undefined;
    if (this.isExpired(rec, Date.now())) {
      this.records.delete(task_id);
      return undefined;
    }
    return rec;
  }

  size(): number {
    return this.records.size;
  }

  close(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }
}
