// SPDX-License-Identifier: MIT
// Transport-agnostic MCP server factory. index.ts attaches the transport.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CONTRACT_VERSION,
  GetStatusInput,
  ReportProgressInput,
  TOOL_NAMES,
  getStatusShape,
  reportProgressShape,
} from "./tools.js";
import type { IProgressStore } from "./store.js";

function textResult(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function errorResult(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return { ...textResult(payload), isError: true as const };
}

/**
 * Create the MCP server bound to a progress store.
 * Transport-blind: callers attach StdioServerTransport (index.ts) or any
 * other transport. All records produced here are JSON-serializable.
 */
export function createServer(store: IProgressStore): McpServer {
  const server = new McpServer({
    name: "agent-progress-mcp",
    version: CONTRACT_VERSION,
  });

  server.registerTool(
    TOOL_NAMES.REPORT_PROGRESS,
    {
      description:
        "Report progress for a task. percent 0-100 (server clamps, never errors on regression). " +
        "eta_seconds null = unknown — NEVER fabricate an ETA (honesty rule). " +
        "task_id convention 'agentName:taskSlug'; server enforces charset only.",
      inputSchema: reportProgressShape,
    },
    async (args) => {
      // Handler-level strictness gate. The raw shapes are registered with the
      // SDK (registerTool<InputArgs extends ZodRawShape> rejects a ZodObject
      // as inputSchema — a compile error), so the SDK strips unknown keys
      // before this handler runs (consistent with the protocol's "consumers
      // ignore unknown fields" rule). Enforcing the .strict() ZodObjects
      // here still validates every known field's shape and type, and would
      // reject unknown keys for any caller that bypasses the SDK's
      // pre-validation. Net security property: unknown keys never reach
      // the store.
      const parsed = ReportProgressInput.safeParse(args);
      if (!parsed.success) {
        return errorResult({
          error: "invalid_arguments",
          details: parsed.error.issues,
        });
      }
      const input = parsed.data;
      const rec = store.report({
        task_id: input.task_id,
        percent: input.percent,
        eta_seconds: input.eta_seconds ?? null,
        stage: input.stage ?? "",
        message: input.message,
      });
      return textResult({
        contract: CONTRACT_VERSION,
        task_id: rec.task_id,
        percent: rec.percent,
        eta_seconds: rec.eta_seconds,
        stage: rec.stage,
        message: rec.message ?? null,
        complete: rec.complete,
        updated_at: rec.updated_at,
      });
    }
  );

  server.registerTool(
    TOOL_NAMES.GET_STATUS,
    {
      description:
        "Get the latest reported status for a task_id. Returns complete:true once percent reached 100.",
      inputSchema: getStatusShape,
    },
    async (args) => {
      // Same handler-level strictness gate as report_progress: registerTool
      // accepts only a raw shape, so .strict() enforcement lives here.
      const parsed = GetStatusInput.safeParse(args);
      if (!parsed.success) {
        return errorResult({
          error: "invalid_arguments",
          details: parsed.error.issues,
        });
      }
      const rec = store.get(parsed.data.task_id);
      if (!rec) {
        return errorResult({ error: "not_found", task_id: parsed.data.task_id });
      }
      return textResult({
        task_id: rec.task_id,
        percent: rec.percent,
        eta_seconds: rec.eta_seconds,
        stage: rec.stage,
        message: rec.message ?? null,
        complete: rec.complete,
        updated_at: rec.updated_at,
      });
    }
  );

  return server;
}
