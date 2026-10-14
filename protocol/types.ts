// SPDX-License-Identifier: MIT
// TypeScript mirror of protocol/schema.json (machine truth lives in schema.json).

/** Protocol major version. Bump only for breaking field changes. */
export const PROTO_VERSION = 1 as const;

/** Lifecycle states for a reported task. */
export type ProgressStatus = "started" | "running" | "paused" | "done" | "error";

/**
 * A progress event as exchanged between producers (agents) and consumers
 * (widgets, demo pages, MCP clients). Consumers MUST ignore unknown fields;
 * producers MUST NOT remove/rename fields except with a proto major bump.
 */
export interface ProgressEvent {
  proto: 1;
  /** Required, 1-128 chars, ^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$ */
  task_id: string;
  /** Required, 0-100 inclusive. Server clamps; never errors on regression. */
  percent: number;
  /** Required. null = unknown (honesty rule — NEVER fabricate). */
  eta_seconds: number | null;
  /** Required, <=120 chars, human-readable phase label. */
  stage: string;
  /** Required lifecycle state. */
  status: ProgressStatus;
  /** Required. ISO-8601 UTC, SERVER-assigned. */
  timestamp: string;
  /** Optional, e.g. "claude". */
  agent?: string;
  /** Optional, <=280 chars. */
  message?: string;
}

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

/** Shape returned by the MCP get_status tool. */
export interface GetStatusResult {
  task_id: string;
  percent: number;
  eta_seconds: number | null;
  stage: string;
  message: string | null;
  complete: boolean;
  updated_at: string;
}
