// SPDX-License-Identifier: MIT
// Transport-agnostic MCP server factory. index.ts attaches the transport.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CONTRACT_VERSION,
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
      const rec = store.report({
        task_id: args.task_id,
        percent: args.percent,
        eta_seconds: args.eta_seconds ?? null,
        stage: args.stage ?? "",
        message: args.message,
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
      const rec = store.get(args.task_id);
      if (!rec) {
        return errorResult({ error: "not_found", task_id: args.task_id });
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
