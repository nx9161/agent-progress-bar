// SPDX-License-Identifier: MIT
// INTERNAL tooling — local registry of task_ids this CLI has touched.
// The MCP server contract is frozen: no new server tool was added for this.
// Registry lives at ~/.agent-progress/tasks.json (user-local, never synced).

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const DIR = join(homedir(), ".agent-progress");
const FILE = join(DIR, "tasks.json");

export interface TaskEntry {
  lastPercent: number | null;
  lastStage: string | null;
  updatedAt: string;
}

interface RegistryFile {
  version: 1;
  tasks: Record<string, TaskEntry>;
}

function load(): RegistryFile {
  try {
    if (!existsSync(FILE)) return { version: 1, tasks: {} };
    const parsed = JSON.parse(readFileSync(FILE, "utf8")) as Partial<RegistryFile>;
    if (!parsed || typeof parsed !== "object" || !parsed.tasks) {
      return { version: 1, tasks: {} };
    }
    return { version: 1, tasks: parsed.tasks as Record<string, TaskEntry> };
  } catch {
    return { version: 1, tasks: {} };
  }
}

function save(reg: RegistryFile): void {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  writeFileSync(FILE, JSON.stringify(reg, null, 2) + "\n", { mode: 0o600 });
}

export function touchTask(
  id: string,
  partial: { lastPercent?: number | null; lastStage?: string | null }
): void {
  const reg = load();
  const prev = reg.tasks[id];
  reg.tasks[id] = {
    lastPercent: partial.lastPercent ?? prev?.lastPercent ?? null,
    lastStage: partial.lastStage ?? prev?.lastStage ?? null,
    updatedAt: new Date().toISOString(),
  };
  save(reg);
}

export function listTasks(): Array<{ id: string } & TaskEntry> {
  const reg = load();
  return Object.entries(reg.tasks)
    .map(([id, e]) => ({ id, ...e }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function registryPath(): string {
  return FILE;
}
