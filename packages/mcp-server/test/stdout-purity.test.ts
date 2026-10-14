// SPDX-License-Identifier: MIT
// Stdout-purity guard: the MCP server's stdout must carry protocol frames
// exclusively. This test statically asserts no source file writes to stdout
// (console.log / process.stdout.write). Run offline: `npm test`
// (node --test test/stdout-purity.test.ts). No dependencies.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

const BANNED = [
  /console\.log\s*\(/,
  /console\.debug\s*\(/,
  /console\.info\s*\(/,
  /process\.stdout\.write\s*\(/,
];

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...tsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

test("no stdout writes in MCP server sources", () => {
  const files = tsFiles(SRC_DIR);
  assert.ok(files.length > 0, "expected TypeScript sources under src/");
  const violations: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const pattern of BANNED) {
      if (pattern.test(src)) violations.push(`${file}: matches ${pattern}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `stdout-purity violations (stdout is reserved for MCP protocol frames):\n${violations.join("\n")}`
  );
});
