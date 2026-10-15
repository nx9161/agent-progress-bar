// SPDX-License-Identifier: MIT
// Tests for the universal event substrate (src/event-log.ts) and its wiring
// into the report_progress tool. Hermetic: every test uses a fresh temp dir
// and (where timing matters) an injected fake clock. Run: `npm test`.

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { EventLog, resolveAgent } from "../src/event-log.js";
import { createServer } from "../src/server.js";
import { InMemoryProgressStore, type ProgressRecord } from "../src/store.js";

const DAY1 = Date.UTC(2026, 9, 15, 12, 0, 0); // 2026-10-15T12:00:00Z
const DAY2 = DAY1 + 86_400_000;

const tmpdirs: string[] = [];
let savedEventsDir: string | undefined;
let savedAgent: string | undefined;

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "uapb-evlog-"));
  tmpdirs.push(d);
  return d;
}

/** Build an EventLog rooted at a fresh temp dir. */
function makeLog(dir?: string, opts?: { now?: () => number; maxFileBytes?: number; rateLimitPerSecond?: number }): EventLog {
  const d = dir ?? freshDir();
  process.env.AGENT_PROGRESS_EVENTS_DIR = d;
  return new EventLog(opts);
}

function rec(taskId = "agent:task1", overrides: Partial<ProgressRecord> = {}): ProgressRecord {
  return {
    task_id: taskId,
    percent: 42,
    eta_seconds: 30,
    stage: "building",
    message: "hello",
    complete: false,
    updated_at: "2026-10-15T11:59:00.000Z",
    ...overrides,
  };
}

function jsonLines(dir: string): Array<{ file: string; line: Record<string, unknown> }> {
  const out: Array<{ file: string; line: Record<string, unknown> }> = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort()) {
    const content = readFileSync(join(dir, f), "utf8");
    for (const l of content.split("\n")) {
      if (l.length === 0) continue;
      out.push({ file: f, line: JSON.parse(l) as Record<string, unknown> });
    }
  }
  return out;
}

function captureStderr(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const orig = process.stderr.write;
  const patched = function (this: unknown, chunk: unknown, ...args: unknown[]): boolean {
    writes.push(String(chunk));
    return (orig as (...a: unknown[]) => boolean).apply(this, [chunk, ...args]);
  };
  process.stderr.write = patched as typeof process.stderr.write;
  return { writes, restore: () => { process.stderr.write = orig; } };
}

beforeEach(() => {
  savedEventsDir = process.env.AGENT_PROGRESS_EVENTS_DIR;
  savedAgent = process.env.UAPB_AGENT;
  delete process.env.UAPB_AGENT;
});

afterEach(() => {
  if (savedEventsDir === undefined) delete process.env.AGENT_PROGRESS_EVENTS_DIR;
  else process.env.AGENT_PROGRESS_EVENTS_DIR = savedEventsDir;
  if (savedAgent === undefined) delete process.env.UAPB_AGENT;
  else process.env.UAPB_AGENT = savedAgent;
  for (const d of tmpdirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

test("report_progress appends to the log before returning (integration via MCP client)", async () => {
  const dir = freshDir();
  const log = makeLog(dir, { now: () => DAY1 });
  const store = new InMemoryProgressStore({ ttlMs: 60_000 });
  const server = createServer(store, { eventLog: log });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);

  const res = (await client.callTool({
    name: "report_progress",
    arguments: { task_id: "hermes:build1", percent: 25, stage: "compiling" },
  })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
  assert.equal(res.isError, undefined);

  // callTool resolved, so the handler returned; the append is synchronous, so
  // the line MUST already be on disk. That is the ordering guarantee.
  const lines = jsonLines(dir);
  assert.equal(lines.length, 1);
  const ev = lines[0]?.line;
  assert.equal(ev?.proto, 1);
  assert.equal(ev?.task_id, "hermes:build1");
  assert.equal(ev?.percent, 25);
  assert.equal(ev?.agent, "hermes"); // task_id prefix binding (no UAPB_AGENT set)
  assert.equal(ev?.session_id, "hermes:build1");

  log.close();
  store.close();
  await client.close();
  await server.close();
});

test("event lines are one JSON.stringify with the exact field shape", () => {
  const dir = freshDir();
  const log = makeLog(dir, { now: () => DAY1 });
  const tricky = 'he said "hi"\nline2 ✓ 🎉';
  log.append(rec("agent:t", { message: tricky, updated_at: "2026-10-15T11:58:12.345Z" }), "agent", "agent:t");
  log.close();

  const lines = jsonLines(dir);
  assert.equal(lines.length, 1);
  const ev = lines[0]?.line;
  assert.ok(ev);
  // Exact key order and presence — proves a single structured serialize.
  assert.deepEqual(Object.keys(ev), [
    "proto", "task_id", "percent", "eta_seconds", "stage",
    "message", "complete", "timestamp", "agent", "session_id",
  ]);
  assert.equal(ev.message, tricky); // quoting/newlines round-trip intact
  assert.equal(ev.timestamp, "2026-10-15T11:58:12.345Z"); // the record's updated_at, not "now"
});

test("message key is omitted when the record has no message", () => {
  const dir = freshDir();
  const log = makeLog(dir, { now: () => DAY1 });
  const r = rec("agent:t");
  delete r.message;
  log.append(r, "agent", "agent:t");
  log.close();

  const lines = jsonLines(dir);
  assert.equal(lines.length, 1);
  const ev = lines[0]?.line;
  assert.ok(ev && !("message" in ev));
  assert.deepEqual(Object.keys(ev), [
    "proto", "task_id", "percent", "eta_seconds", "stage",
    "complete", "timestamp", "agent", "session_id",
  ]);
});

test("resolveAgent precedence: env (trimmed) > task_id prefix > unknown", () => {
  assert.equal(resolveAgent("hermes:build"), "hermes");
  assert.equal(resolveAgent("a:b:c"), "a"); // split on FIRST ":"
  assert.equal(resolveAgent("plain-task"), "unknown");
  assert.equal(resolveAgent(":empty-prefix"), "unknown");
  process.env.UAPB_AGENT = "  custom-agent  ";
  assert.equal(resolveAgent("hermes:build"), "custom-agent"); // env wins, trimmed
  process.env.UAPB_AGENT = "   ";
  assert.equal(resolveAgent("hermes:build"), "hermes"); // blank env falls through
});

test("session_id is the task_id verbatim", () => {
  const dir = freshDir();
  const log = makeLog(dir, { now: () => DAY1 });
  log.append(rec("weird:task_9.x-2"), "someone", "weird:task_9.x-2");
  log.close();
  const lines = jsonLines(dir);
  assert.equal(lines[0]?.line?.session_id, "weird:task_9.x-2");
});

test("daily file uses the UTC date, not local time", () => {
  const dir = freshDir();
  // 2026-01-06T00:30 in +05:00 == 2026-01-05T19:30Z — file must say 01-05.
  const log = makeLog(dir, { now: () => Date.UTC(2026, 0, 5, 19, 30, 0) });
  log.append(rec(), "agent", "agent:t");
  log.close();
  assert.ok(existsSync(join(dir, "events-2026-01-05.jsonl")));
  assert.ok(!existsSync(join(dir, "events-2026-01-06.jsonl")));
});

test("size cap rolls the log to a numeric suffix", () => {
  const dir = freshDir();
  const log = makeLog(dir, { now: () => DAY1, maxFileBytes: 120 });
  for (let i = 0; i < 3; i++) log.append(rec("agent:t", { percent: i }), "agent", "agent:t");
  log.close();

  const rolled = join(dir, "events-2026-10-15.1.jsonl");
  assert.ok(existsSync(rolled), "expected numeric-suffix roll file");
  const lines = jsonLines(dir);
  assert.equal(lines.length, 3);
  for (const { line } of lines) {
    assert.equal(line.task_id, "agent:t"); // rolled lines still parse as events
  }
  const inRolled = lines.filter((l) => l.file === "events-2026-10-15.1.jsonl");
  assert.ok(inRolled.length >= 1, "appends after the roll land in the suffix file");
});

test("7-day retention deletes only matching old files; decoys survive", () => {
  const dir = freshDir();
  const l1 = makeLog(dir, { now: () => DAY1 }); // creates dir + today's file
  // Plant: 8-day-old matching files (with and without suffix), a 7-day-old
  // file (kept), and decoys that must never be touched.
  writeFileSync(join(dir, "events-2026-10-07.jsonl"), "{}\n");
  writeFileSync(join(dir, "events-2026-10-07.1.jsonl"), "{}\n");
  writeFileSync(join(dir, "events-2026-10-08.jsonl"), "{}\n");
  writeFileSync(join(dir, "notes.txt"), "do not touch\n");
  writeFileSync(join(dir, "events-2026-10-15.jsonl.bak"), "do not touch\n");
  writeFileSync(join(dir, "events-evil.jsonl"), "do not touch\n");
  l1.close();

  const l2 = new EventLog({ now: () => DAY1 }); // construction runs retention
  assert.ok(!existsSync(join(dir, "events-2026-10-07.jsonl")), "8-day-old file deleted");
  assert.ok(!existsSync(join(dir, "events-2026-10-07.1.jsonl")), "8-day-old suffix file deleted");
  assert.ok(existsSync(join(dir, "events-2026-10-08.jsonl")), "7-day-old file kept");
  assert.ok(existsSync(join(dir, "notes.txt")), "decoy notes.txt survives");
  assert.ok(existsSync(join(dir, "events-2026-10-15.jsonl.bak")), "non-matching .bak survives");
  assert.ok(existsSync(join(dir, "events-evil.jsonl")), "non-matching name survives");
  l2.close();
});

test("events dir is 0700 and log files are 0600", () => {
  const dir = freshDir();
  const log = makeLog(dir, { now: () => DAY1 });
  log.append(rec(), "agent", "agent:t");
  log.close();
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, "events-2026-10-15.jsonl")).mode & 0o777, 0o600);
});

test("a symlinked events dir is refused", () => {
  const real = freshDir();
  const link = join(tmpdir(), `uapb-link-${process.pid}`);
  symlinkSync(real, link);
  process.env.AGENT_PROGRESS_EVENTS_DIR = link;
  try {
    assert.throws(() => new EventLog(), /symlink/);
  } finally {
    unlinkSync(link);
  }
});

test("a relative AGENT_PROGRESS_EVENTS_DIR throws", () => {
  process.env.AGENT_PROGRESS_EVENTS_DIR = "relative/path";
  assert.throws(() => new EventLog(), /absolute/);
});

test("write failures never reject the tool call; stderr warning is rate-limited to 1/min", async () => {
  const dir = freshDir();
  let now = DAY1;
  const log = makeLog(dir, { now: () => now });
  const store = new InMemoryProgressStore({ ttlMs: 60_000 });
  const server = createServer(store, { eventLog: log });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);

  // Break the log hermetically: tomorrow's file path is a directory, so the
  // day-rollover open fails (EISDIR) inside append — the tool must not care.
  now = DAY2;
  mkdirSync(join(dir, "events-2026-10-16.jsonl"));

  const { writes, restore } = captureStderr();
  try {
    for (let i = 0; i < 2; i++) {
      const res = (await client.callTool({
        name: "report_progress",
        arguments: { task_id: "agent:x", percent: 10 },
      })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
      assert.equal(res.isError, undefined, "tool call succeeds despite broken log");
      const payload = JSON.parse(res.content[0]?.text ?? "") as { task_id: string };
      assert.equal(payload.task_id, "agent:x");
    }
    const warns = writes.filter((w) => w.includes("event_log_write_failed"));
    assert.equal(warns.length, 1, "stderr warning rate-limited to one per minute");
    const parsed = JSON.parse(warns[0] ?? "") as Record<string, unknown>;
    assert.equal(parsed.level, "warn"); // JSON line, no secrets

    now = DAY2 + 61_000; // past the 1-minute window
    await client.callTool({
      name: "report_progress",
      arguments: { task_id: "agent:x", percent: 11 },
    });
    assert.equal(
      writes.filter((w) => w.includes("event_log_write_failed")).length,
      2,
      "a new window permits one more warning"
    );
  } finally {
    restore();
  }

  log.close();
  store.close();
  await client.close();
  await server.close();
});

test("per-task rate cap drops excess appends and emits one honest marker", () => {
  const dir = freshDir();
  let now = DAY1;
  const log = makeLog(dir, { now: () => now, rateLimitPerSecond: 5 });
  for (let i = 0; i < 8; i++) {
    log.append(rec("agent:t", { percent: i }), "agent", "agent:t");
  }
  now += 1000; // next one-second window flushes the marker
  log.append(rec("agent:t", { percent: 99 }), "agent", "agent:t");
  log.close();

  const lines = jsonLines(dir).map((l) => l.line);
  const events = lines.filter((l) => !("type" in l));
  const markers = lines.filter((l) => l.type === "dropped");
  assert.equal(events.length, 6, "5 in-window + 1 next-window event written");
  assert.equal(markers.length, 1, "exactly one drop marker per window");
  assert.equal(markers[0]?.dropped_count, 3, "marker count is honest (8 - 5)");
  assert.equal(markers[0]?.task_id, "agent:t");
  assert.equal(markers[0]?.agent, "agent");
  assert.equal(markers[0]?.session_id, "agent:t");
  assert.equal(markers[0]?.proto, 1);
});

test("default rate limit is 20 appends per task per second", () => {
  const dir = freshDir();
  let now = DAY1;
  const log = makeLog(dir, { now: () => now }); // default cap
  for (let i = 0; i < 21; i++) {
    log.append(rec("agent:t", { percent: i }), "agent", "agent:t");
  }
  now += 1000;
  log.append(rec("agent:t", { percent: 100, complete: true }), "agent", "agent:t");
  log.close();

  const lines = jsonLines(dir).map((l) => l.line);
  const markers = lines.filter((l) => l.type === "dropped");
  assert.equal(markers.length, 1);
  assert.equal(markers[0]?.dropped_count, 1, "the 21st append in the window was dropped");
});
