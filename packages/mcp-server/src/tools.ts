// SPDX-License-Identifier: MIT
// Tool contracts for the agent-progress MCP server.
// CONTRACT_VERSION is the wire contract between this server and consumers.

import { z } from "zod";

/** Wire contract version. Bump on any breaking tool/schema change. */
export const CONTRACT_VERSION = "0.1.0" as const;

export const TOOL_NAMES = {
  REPORT_PROGRESS: "report_progress",
  GET_STATUS: "get_status",
} as const;

const taskId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/, {
    message: "task_id must match ^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$",
  });

/** Raw zod shape (for the MCP SDK's registerTool inputSchema). */
export const reportProgressShape = {
  task_id: taskId,
  percent: z.number().min(0).max(100),
  eta_seconds: z.number().min(0).nullable().optional(),
  stage: z.string().max(120).optional(),
  message: z.string().max(280).optional(),
} as const;

/** Raw zod shape (for the MCP SDK's registerTool inputSchema). */
export const getStatusShape = {
  task_id: taskId,
} as const;

/** Strict validated input for report_progress. Unknown keys are rejected. */
export const ReportProgressInput = z.object(reportProgressShape).strict();
export type ReportProgressInput = z.infer<typeof ReportProgressInput>;

/** Strict validated input for get_status. Unknown keys are rejected. */
export const GetStatusInput = z.object(getStatusShape).strict();
export type GetStatusInput = z.infer<typeof GetStatusInput>;
