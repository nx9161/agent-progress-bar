// SPDX-License-Identifier: MIT
// Hermetic tests for the dashboard server:
//   (a) loopback-only bind — the AppSec C14 CI assertion
//   (b/c/d) token gating (C1) on /api/health, /api/snapshot, /api/stream
//   (e) loopback-only CORS (C2)
//   (f) SSE replay of buffered events, then the stream stays open
// Plus: /api/snapshot last-wins, missing-dashboard 500, OPTIONS preflight.
//
// Run: npx tsx --test test/dashboard-server.test.ts
// (tsx resolves the "../src/*.js" specifiers to their .ts sources.)

import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateTasks,
  deriveEtaSeconds,
  eventsFile,
  joinSessions,
  startDashboardServer,
  type DashboardHandle,
} from "../src/dashboard-server.js";

// Browser fetch/XHR always sends an Origin header; node fetch does not, so
// the API tests send one explicitly. (C2: "null"/foreign Origin is denied on
// /api/*; a missing Origin means same-origin/non-browser and is allowed —
// the token gate authenticates. See the CORS test below.)
const LOOPBACK_ORIGIN = { Origin: "http://localhost:9876" };

const handles: DashboardHandle[] = [];
afterEach(async () => {
  while (handles.length) {
    const h = handles.pop();
    if (h) await h.close();
  }
});

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "uapb-dash-test-"));
}

function event(i: number, taskId = `t:${i}`): string {
  return JSON.stringify({
    proto: 1,
    task_id: taskId,
    percent: i * 10,
    eta_seconds: null,
    stage: `stage-${i}`,
    status: "running",
    timestamp: new Date(Date.now() + i * 1000).toISOString(),
    agent: "test",
  });
}

function writeEvents(dir: string, lines: string[]): void {
  writeFileSync(eventsFile(dir), lines.join("\n") + "\n", "utf8");
}

async function start(dir?: string): Promise<DashboardHandle> {
  const h = await startDashboardServer({ port: 0, eventsDir: dir ?? tempDir() });
  handles.push(h);
  return h;
}

async function fetchJson(
  url: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep raw text */
  }
  return { status: res.status, body, headers: res.headers };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("dashboard-server", () => {
  test("(a) binds 127.0.0.1 only — AppSec C14 CI assertion", async () => {
    const h = await start();
    const addr = h.server.address();
    assert.ok(addr && typeof addr === "object", "server must be listening");
    assert.equal(addr.address, "127.0.0.1");
  });

  test("(b) no token -> 401 on every /api/* route", async () => {
    const h = await start();
    for (const route of ["/api/health", "/api/snapshot", "/api/stream"]) {
      const { status } = await fetchJson(`${h.url}${route}`, LOOPBACK_ORIGIN);
      assert.equal(status, 401, `${route} without token must be 401`);
    }
  });

  test("(c) wrong token -> 401", async () => {
    const h = await start();
    const { status, body } = await fetchJson(
      `${h.url}/api/health?token=definitely-not-the-token`,
      LOOPBACK_ORIGIN
    );
    assert.equal(status, 401);
    assert.equal((body as { ok: boolean }).ok, false);
  });

  test("(d) correct token -> 200 with health payload", async () => {
    const dir = tempDir();
    writeEvents(dir, [event(0), event(1), "this is not json", event(2)]);
    const h = await start(dir);
    const { status, body } = await fetchJson(
      `${h.url}/api/health?token=${h.token}`,
      LOOPBACK_ORIGIN
    );
    assert.equal(status, 200);
    const b = body as { ok: boolean; uptime_s: number; events_today: number };
    assert.equal(b.ok, true);
    assert.ok(typeof b.uptime_s === "number");
    assert.equal(b.events_today, 3); // malformed line dropped
  });

  test("(e) CORS: evil origin gets no ACAO; loopback origin echoed + Vary", async () => {
    const h = await start();
    const url = `${h.url}/api/health?token=${h.token}`;

    const evil = await fetchJson(url, { Origin: "http://evil.com" });
    assert.equal(evil.status, 403);
    assert.equal(evil.headers.get("access-control-allow-origin"), null);

    const nul = await fetchJson(url, { Origin: "null" });
    assert.equal(nul.status, 403); // C2: sandboxed "null" origin denied on API

    // C2: no Origin header = same-origin/non-browser client — CORS does not
    // apply; the token gate authenticates. (Our own dashboard SPA fetches
    // same-origin, so denying this would break the primary use case.)
    const missing = await fetchJson(url);
    assert.equal(missing.status, 200);
    assert.equal(missing.headers.get("access-control-allow-origin"), null);

    const good = await fetchJson(url, { Origin: "http://localhost:3000" });
    assert.equal(good.status, 200);
    assert.equal(
      good.headers.get("access-control-allow-origin"),
      "http://localhost:3000"
    );
    assert.match(good.headers.get("vary") ?? "", /origin/i);

    const v6 = await fetchJson(url, { Origin: "http://[::1]:4000" });
    assert.equal(
      v6.headers.get("access-control-allow-origin"),
      "http://[::1]:4000"
    );
  });

  test("OPTIONS preflight follows the same loopback-only policy", async () => {
    const h = await start();
    const url = `${h.url}/api/health?token=${h.token}`;
    const evil = await fetch(url, {
      method: "OPTIONS",
      headers: { Origin: "http://evil.com" },
    });
    assert.equal(evil.status, 403);
    assert.equal(evil.headers.get("access-control-allow-origin"), null);
    const good = await fetch(url, {
      method: "OPTIONS",
      headers: { Origin: "http://127.0.0.1:3000" },
    });
    assert.equal(good.status, 204);
    assert.equal(
      good.headers.get("access-control-allow-origin"),
      "http://127.0.0.1:3000"
    );
  });

  test("/api/snapshot is last-wins per task_id, map-shaped", async () => {
    const dir = tempDir();
    writeEvents(dir, [
      event(1, "t:a"),
      event(2, "t:b"),
      event(9, "t:a"), // later line for t:a wins
    ]);
    const h = await start(dir);
    const { status, body } = await fetchJson(
      `${h.url}/api/snapshot?token=${h.token}`,
      LOOPBACK_ORIGIN
    );
    assert.equal(status, 200);
    const b = body as {
      ok: boolean;
      count: number;
      tasks: Record<string, { task_id: string; percent: number }>;
    };
    assert.equal(b.count, 2);
    assert.equal(b.tasks["t:a"].percent, 90);
    assert.equal(b.tasks["t:b"].percent, 20);
  });

  test("GET / serves the SPA shell, or 500 with build hint if not built", async () => {
    const h = await start();
    // Same path the server resolves: ../../dashboard/dist/index.html from src/.
    const spaFile = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "dashboard",
      "dist",
      "index.html"
    );
    const res = await fetch(`${h.url}/`);
    if (existsSync(spaFile)) {
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    } else {
      assert.equal(res.status, 500);
      assert.match(await res.text(), /dashboard not built/);
    }
  });

  // Collects `want` SSE data frames from /api/stream, then tears down.
  // With stayOpenMs > 0, waits that long first and asserts the server never
  // ended the stream (replay must not close the connection).
  async function collectSse(
    h: DashboardHandle,
    qs: string,
    want: number,
    stayOpenMs = 0
  ): Promise<{ datas: string[]; ids: string[] }> {
    return new Promise((resolve, reject) => {
      const datas: string[] = [];
      const ids: string[] = [];
      let settled = false;
      let waitScheduled = false;
      const timer = setTimeout(
        () => done(new Error("timed out waiting for SSE")),
        10000
      );
      timer.unref();
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve({ datas, ids });
      };
      const req = httpGet(
        `${h.url}/api/stream?${qs}`,
        { headers: { Origin: "http://localhost:1" } },
        (res) => {
          if (res.statusCode !== 200) {
            req.destroy();
            done(new Error(`SSE status ${res.statusCode}`));
            return;
          }
          let buf = "";
          res.on("data", (chunk: Buffer) => {
            buf += chunk.toString("utf8");
            let idx: number;
            while ((idx = buf.indexOf("\n\n")) >= 0) {
              const frame = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              const m = /^id: ([^\n]+)\ndata: ([\s\S]*)$/.exec(frame);
              if (m) {
                ids.push(m[1]);
                datas.push(m[2]);
              }
              if (datas.length >= want && !waitScheduled) {
                waitScheduled = true;
                if (stayOpenMs > 0) {
                  setTimeout(() => {
                    try {
                      assert.equal(
                        res.readableEnded,
                        false,
                        "SSE stream must stay open after replay"
                      );
                    } catch (e) {
                      req.destroy();
                      done(e as Error);
                      return;
                    }
                    req.destroy();
                    done();
                  }, stayOpenMs).unref();
                } else {
                  req.destroy();
                  done();
                }
              }
            }
          });
          res.on("error", () => {
            /* destroyed by us; ignore */
          });
        }
      );
      req.on("error", () => {
        if (!settled) done(new Error("SSE request error"));
      });
    });
  }

  test(
    "(f) SSE replay: no resume replays all events with ids, stream stays open",
    { timeout: 15000 },
    async () => {
      const dir = tempDir();
      writeEvents(dir, [event(0), event(1), event(2)]);
      const h = await start(dir);
      const { datas, ids } = await collectSse(h, `token=${h.token}`, 3, 400);
      assert.equal(datas.length, 3);
      assert.equal(ids.length, 3);
      const offsets = ids.map(Number);
      for (const o of offsets) assert.ok(Number.isFinite(o) && o >= 0);
      assert.ok(offsets[0] < offsets[1] && offsets[1] < offsets[2]);
      assert.deepEqual(
        datas.map((d) => (JSON.parse(d) as { task_id: string }).task_id),
        ["t:0", "t:1", "t:2"]
      );
    }
  );

  test(
    "SSE ?resume=<numeric id> replays only later events",
    { timeout: 15000 },
    async () => {
      const dir = tempDir();
      writeEvents(dir, [event(0), event(1), event(2)]);
      const h = await start(dir);
      const first = await collectSse(h, `token=${h.token}`, 3);
      const second = await collectSse(
        h,
        `token=${h.token}&resume=${first.ids[1]}`,
        1
      );
      assert.equal(second.datas.length, 1);
      assert.equal(
        (JSON.parse(second.datas[0]) as { task_id: string }).task_id,
        "t:2"
      );
    }
  );

  test(
    "SSE ?resume=<task@timestamp> replays only later events",
    { timeout: 15000 },
    async () => {
      const dir = tempDir();
      const ts = (i: number) => `2026-10-15T00:00:0${i}.000Z`;
      writeEvents(
        dir,
        [0, 1, 2].map((i) =>
          JSON.stringify({
            proto: 1,
            task_id: `t:${i}`,
            percent: i * 10,
            eta_seconds: null,
            stage: `stage-${i}`,
            status: "running",
            timestamp: ts(i),
            agent: "test",
          })
        )
      );
      const h = await start(dir);
      // The dashboard's fallback cursor: "<task_id>@<timestamp>".
      const cursor = encodeURIComponent(`t:1@${ts(1)}`);
      const { datas } = await collectSse(
        h,
        `token=${h.token}&resume=${cursor}`,
        1
      );
      assert.equal(datas.length, 1);
      assert.equal(
        (JSON.parse(datas[0]) as { task_id: string }).task_id,
        "t:2"
      );
    }
  );

  test(
    "SSE ?resume=<unknown> falls back to last 200",
    { timeout: 15000 },
    async () => {
      const dir = tempDir();
      writeEvents(dir, [event(0), event(1)]);
      const h = await start(dir);
      const { datas } = await collectSse(
        h,
        `token=${h.token}&resume=nope@never`,
        2
      );
      assert.equal(datas.length, 2);
    }
  );

  test("deriveEtaSeconds: reported wins, done is 0, pace estimate is labeled, thin signal stays unknown", () => {
    const t0 = 1_700_000_000_000;
    // Reported ETA is never blended with the estimate.
    assert.deepEqual(
      deriveEtaSeconds({
        status: "running",
        percent: 50,
        eta_reported_seconds: 42,
        first_seen_ms: t0,
        first_percent: 0,
        event_count: 5,
        now_ms: t0 + 100_000,
      }),
      { eta_seconds: 42, eta_source: "reported" }
    );
    // Done tasks need no ETA.
    assert.deepEqual(
      deriveEtaSeconds({
        status: "done",
        percent: 100,
        eta_reported_seconds: null,
        first_seen_ms: t0,
        first_percent: 0,
        event_count: 5,
        now_ms: t0 + 100_000,
      }),
      { eta_seconds: 0, eta_source: "done" }
    );
    // Pace estimate: 100s elapsed to reach 50% -> ~100s remaining.
    assert.deepEqual(
      deriveEtaSeconds({
        status: "running",
        percent: 50,
        eta_reported_seconds: null,
        first_seen_ms: t0,
        first_percent: 0,
        event_count: 5,
        now_ms: t0 + 100_000,
      }),
      { eta_seconds: 100, eta_source: "estimated" }
    );
    // Too little progress: no honest number exists.
    assert.deepEqual(
      deriveEtaSeconds({
        status: "running",
        percent: 2,
        eta_reported_seconds: null,
        first_seen_ms: t0,
        first_percent: 0,
        event_count: 5,
        now_ms: t0 + 100_000,
      }),
      { eta_seconds: null, eta_source: "unknown" }
    );
    // A single event is not a pace.
    assert.deepEqual(
      deriveEtaSeconds({
        status: "running",
        percent: 60,
        eta_reported_seconds: null,
        first_seen_ms: t0,
        first_percent: 60,
        event_count: 1,
        now_ms: t0 + 100_000,
      }),
      { eta_seconds: null, eta_source: "unknown" }
    );
  });

  test("/api/tasks aggregates every retained day, with an ETA per task", async () => {
    const dir = tempDir();
    const oldDay = join(dir, "events-2020-01-01.jsonl");
    writeFileSync(
      oldDay,
      [
        JSON.stringify({
          proto: 1,
          task_id: "old:done",
          percent: 10,
          eta_seconds: null,
          stage: "Working",
          timestamp: "2020-01-01T00:00:00.000Z",
          agent: "test",
        }),
        JSON.stringify({
          proto: 1,
          task_id: "old:done",
          percent: 100,
          eta_seconds: null,
          stage: "Done",
          complete: true,
          timestamp: "2020-01-01T00:02:00.000Z",
          agent: "test",
        }),
      ].join("\n") + "\n",
      "utf8"
    );
    writeEvents(dir, [
      JSON.stringify({
        proto: 1,
        task_id: "live:eta",
        percent: 40,
        eta_seconds: 120,
        stage: "Running",
        status: "running",
        timestamp: new Date().toISOString(),
        agent: "test",
      }),
    ]);
    const h = await start(dir);

    const noToken = await fetchJson(`${h.url}/api/tasks`, LOOPBACK_ORIGIN);
    assert.equal(noToken.status, 401);

    const { status, body } = await fetchJson(
      h.url + "/api/tasks?token=" + h.token,
      LOOPBACK_ORIGIN
    );
    assert.equal(status, 200);
    const b = body as {
      ok: boolean;
      count: number;
      tasks: {
        task_id: string;
        status: string;
        eta_seconds: number | null;
        eta_source: string;
        duration_seconds: number;
        event_count: number;
      }[];
    };
    assert.equal(b.count, 2);
    // Active tasks sort before finished ones.
    assert.equal(b.tasks[0].task_id, "live:eta");
    assert.equal(b.tasks[0].eta_source, "reported");
    assert.equal(b.tasks[0].eta_seconds, 120);
    const done = b.tasks.find((t) => t.task_id === "old:done");
    assert.ok(done);
    assert.equal(done.status, "done");
    assert.equal(done.eta_source, "done");
    assert.equal(done.eta_seconds, 0);
    assert.equal(done.duration_seconds, 120);
    assert.equal(done.event_count, 2);
  });

  test("aggregateTasks skips drop markers and caps stage history", () => {
    const ev = (stage: string, i: number) => ({
      task_id: "t:x",
      percent: i * 2,
      eta_seconds: null,
      stage,
      status: "running",
      timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
      agent: "test",
    });
    const many = Array.from({ length: 40 }, (_, i) => ev(`s${i}`, i));
    const out = aggregateTasks(many as never, 1_700_000_100_000);
    assert.equal(out.length, 1);
    assert.equal(out[0].stages.length, 25);
    assert.equal(out[0].event_count, 40);
  });
  test("/api/sessions lists every registered chat, idle ones included, with joined progress", async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "sessions.json"),
      JSON.stringify([
        {
          id: "chat-1",
          title: "Working chat",
          kind: "chat",
          status: "running",
          updated_at: "2026-10-27T00:00:00.000Z",
          task_ids: ["chat1:build"],
        },
        {
          id: "chat-2",
          title: "Quiet chat",
          kind: "chat",
          status: "idle",
          updated_at: "2026-10-27T00:00:00.000Z",
        },
      ]),
      "utf8"
    );
    writeEvents(dir, [
      JSON.stringify({
        proto: 1,
        task_id: "chat1:build",
        percent: 30,
        eta_seconds: 90,
        stage: "Building",
        status: "running",
        timestamp: new Date().toISOString(),
        agent: "test",
      }),
      JSON.stringify({
        proto: 1,
        task_id: "stray:task",
        percent: 10,
        eta_seconds: null,
        stage: "Other",
        status: "running",
        timestamp: new Date().toISOString(),
        agent: "test",
      }),
    ]);
    const h = await start(dir);

    const noTok = await fetchJson(h.url + "/api/sessions", LOOPBACK_ORIGIN);
    assert.equal(noTok.status, 401);

    const { status, body } = await fetchJson(
      h.url + "/api/sessions?tok" + "en=" + h.token,
      LOOPBACK_ORIGIN
    );
    assert.equal(status, 200);
    const b = body as {
      count: number;
      unassigned_count: number;
      sessions: {
        id: string;
        tasks: { task_id: string }[];
        latest_task: { task_id: string; eta_source: string } | null;
      }[];
    };
    assert.equal(b.count, 2);
    assert.equal(b.unassigned_count, 1);
    const working = b.sessions.find((s) => s.id === "chat-1");
    assert.ok(working);
    assert.equal(working.latest_task?.task_id, "chat1:build");
    assert.equal(working.latest_task?.eta_source, "reported");
    const quiet = b.sessions.find((s) => s.id === "chat-2");
    assert.ok(quiet);
    assert.deepEqual(quiet.tasks, []);
    assert.equal(quiet.latest_task, null);
  });

  test("joinSessions matches by prefix and sorts working chats first", () => {
    const tasks = aggregateTasks(
      [
        {
          task_id: "war:phase-1",
          percent: 80,
          eta_seconds: null,
          stage: "Phase 1",
          status: "running",
          timestamp: "2026-10-27T00:00:00.000Z",
          agent: "test",
        },
      ] as never,
      Date.parse("2026-10-27T00:01:00.000Z")
    );
    const { sessions, unassigned_count } = joinSessions(
      [
        {
          id: "a",
          title: "Alpha",
          kind: "chat",
          status: "idle",
          updated_at: "2026-10-27T00:00:00.000Z",
        },
        {
          id: "b",
          title: "Beta",
          kind: "chat",
          status: "running",
          updated_at: "2026-10-27T00:00:00.000Z",
          task_prefixes: ["war:"],
        },
      ],
      tasks
    );
    assert.equal(sessions[0].id, "b");
    assert.equal(sessions[0].tasks.length, 1);
    assert.equal(unassigned_count, 0);
  });
});

