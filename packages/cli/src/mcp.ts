// SPDX-License-Identifier: MIT
// INTERNAL tooling — minimal MCP client speaking JSON-RPC 2.0 over stdio.
// No SDK dependency on purpose: the handshake is small and this keeps the
// CLI installable with zero runtime dependencies.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ServerRef {
  command: string;
  args: string[];
}

const PROTOCOL_VERSION = "2024-11-05";
const CLI_VERSION = "0.1.0";
const HANDSHAKE_TIMEOUT_MS = 15000;
const CALL_TIMEOUT_MS = 10000;

/**
 * Resolve which MCP server to spawn, in order:
 * 1. $AGENT_PROGRESS_MCP_CMD (space-separated command line)
 * 2. Sibling packages/mcp-server build output (monorepo checkout)
 * 3. npx fallback to the published agent-progress-mcp package
 */
export function resolveServer(): ServerRef {
  const env = process.env.AGENT_PROGRESS_MCP_CMD;
  if (env && env.trim().length > 0) {
    const parts = env.trim().split(/\s+/);
    return { command: parts[0], args: parts.slice(1) };
  }
  // packages/cli/dist/index.js -> up two levels -> packages/mcp-server/dist/index.js
  const distDir = dirname(fileURLToPath(import.meta.url));
  const candidate = join(distDir, "..", "..", "mcp-server", "dist", "index.js");
  if (existsSync(candidate)) {
    return { command: process.execPath, args: [candidate] };
  }
  return { command: "npx", args: ["-y", "agent-progress-mcp"] };
}

export interface ToolDef {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export class McpClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private closed = false;
  private readonly server: ServerRef;

  constructor(server?: ServerRef) {
    this.server = server ?? resolveServer();
  }

  get serverLabel(): string {
    return [this.server.command, ...this.server.args].join(" ");
  }

  async connect(): Promise<void> {
    const { command, args } = this.server;
    this.child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });

    this.child.on("error", (err) => {
      const msg = `could not start MCP server (${this.serverLabel}): ${err.message}`;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new CliError(msg));
      }
      this.pending.clear();
    });

    this.child.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
    this.child.on("exit", (code) => {
      if (!this.closed) {
        const msg = `MCP server exited unexpectedly (code ${code})`;
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new CliError(msg));
        }
        this.pending.clear();
      }
    });

    // Give the process a moment to fail fast on bad commands.
    await new Promise((r) => setTimeout(r, 50));
    if (this.child.exitCode !== null) {
      throw new CliError(
        `MCP server failed to start (${this.serverLabel}), exit code ${this.child.exitCode}`
      );
    }

    const hello = (await this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "agent-progress-cli", version: CLI_VERSION },
      },
      HANDSHAKE_TIMEOUT_MS
    )) as { protocolVersion?: string };
    if (!hello || typeof hello !== "object") {
      throw new CliError("MCP server returned an invalid initialize response");
    }
    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<ToolDef[]> {
    const res = (await this.request("tools/list", {}, CALL_TIMEOUT_MS)) as {
      tools?: ToolDef[];
    };
    if (!res || !Array.isArray(res.tools)) {
      throw new CliError("MCP server returned an invalid tools/list response");
    }
    return res.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const res = (await this.request(
      "tools/call",
      { name, arguments: args },
      CALL_TIMEOUT_MS
    )) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    if (res && res.isError) {
      const text = (res.content ?? [])
        .map((c) => c.text ?? "")
        .join(" ")
        .trim();
      throw new CliError(text || `tool "${name}" reported an error`);
    }
    return res;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new CliError("client closed"));
    }
    this.pending.clear();
    if (this.child && this.child.exitCode === null) {
      this.child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 300));
      if (this.child.exitCode === null) this.child.kill("SIGKILL");
    }
    this.child = null;
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length === 0) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        // Ignore non-JSON stdout noise; protocol frames are JSON lines.
        continue;
      }
      if (msg.id === undefined || msg.id === null) continue; // notification
      const p = this.pending.get(Number(msg.id));
      if (!p) continue;
      this.pending.delete(Number(msg.id));
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(
          new CliError(`MCP error ${msg.error.code}: ${msg.error.message}`)
        );
      } else {
        p.resolve(msg.result);
      }
    }
  }

  private send(method: string, params: unknown, id?: number): void {
    if (!this.child || !this.child.stdin) {
      throw new CliError("MCP client is not connected");
    }
    const frame: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (id !== undefined) frame.id = id;
    if (params !== undefined) frame.params = params;
    // Protocol bytes go to the server's stdin only — never to the user's terminal.
    this.child.stdin.write(JSON.stringify(frame) + "\n");
  }

  private notify(method: string, params: unknown): void {
    this.send(method, params);
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs: number
  ): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CliError(`MCP request "${method}" timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send(method, params, id);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }
}
