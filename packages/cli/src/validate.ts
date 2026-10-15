// SPDX-License-Identifier: MIT
// INTERNAL tooling — client-side argument validation mirroring the server's
// strict schemas (protocol/schema.json). Fails fast before any MCP traffic.

import { z } from "zod";
import { CliError } from "./mcp.js";

const TASK_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const MAX_STAGE_LEN = 120;
const MAX_MESSAGE_LEN = 280; // protocol contract bound (schema.json)
const MAX_ETA_SECONDS = 86400; // 24h sanity cap

// Intentional asymmetry: the CLI rejects out-of-range percent locally; the
// server clamps (O1 — never a tool error). Both correct at their layer.

// Zod schemas mirror the server bounds (packages/mcp-server/src/tools.ts).
// Validators below keep their names, signatures, and CliError behavior,
// delegating internals to schema.safeParse.
const TaskIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(TASK_ID_RE, {
    message: "task_id must match ^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$",
  });
const PercentSchema = z.number().int().min(0).max(100);
const EtaSchema = z.number().finite().min(0).max(MAX_ETA_SECONDS);
const StageSchema = z.string().max(MAX_STAGE_LEN);
const MessageSchema = z.string().max(MAX_MESSAGE_LEN);

export function validateTaskId(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new CliError("--task is required (non-empty string)");
  }
  if (!TaskIdSchema.safeParse(raw).success) {
    throw new CliError(
      `--task "${raw}" is invalid: 1-128 chars, letters/digits start, then letters, digits, . _ - :`
    );
  }
  return raw;
}

export function validatePercent(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : raw;
  const parsed = PercentSchema.safeParse(n);
  if (!parsed.success) {
    throw new CliError(
      `--percent must be an integer between 0 and 100 (got "${String(raw)}")`
    );
  }
  return parsed.data;
}

export function validateEta(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const n = typeof raw === "string" ? Number(raw) : raw;
  const parsed = EtaSchema.safeParse(n);
  if (!parsed.success) {
    const tooBig = parsed.error.issues.some((i) => i.code === "too_big");
    if (tooBig) {
      throw new CliError(
        `--eta must not exceed ${MAX_ETA_SECONDS} seconds (got ${n})`
      );
    }
    throw new CliError(
      `--eta must be a non-negative number of seconds (got "${String(raw)}")`
    );
  }
  return parsed.data;
}

export function validateStage(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw new CliError("--stage must be a string");
  const s = raw.trim();
  if (!StageSchema.safeParse(s).success) {
    throw new CliError(`--stage must be ${MAX_STAGE_LEN} characters or fewer`);
  }
  return s;
}

export function validateMessage(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw new CliError("--message must be a string");
  const s = raw.trim();
  if (!MessageSchema.safeParse(s).success) {
    throw new CliError(`--message must be ${MAX_MESSAGE_LEN} characters or fewer`);
  }
  return s;
}

export function validateDuration(raw: unknown): number {
  if (raw === undefined || raw === null) return 45;
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || n > 3600) {
    throw new CliError(
      `--duration must be a positive number of seconds up to 3600 (got "${String(raw)}")`
    );
  }
  return n;
}

export function validateInterval(raw: unknown): number {
  if (raw === undefined || raw === null) return 1;
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0.2 || n > 60) {
    throw new CliError(
      `--interval must be between 0.2 and 60 seconds (got "${String(raw)}")`
    );
  }
  return n;
}

export function validateLimit(raw: unknown): number {
  if (raw === undefined || raw === null) return 20;
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 100000) {
    throw new CliError(`--limit must be an integer >= 1 (got "${String(raw)}")`);
  }
  return n;
}
