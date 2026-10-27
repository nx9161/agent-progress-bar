<!-- SPDX-License-Identifier: MIT -->

# UAPB Live Dashboard

A single-file, zero-dependency local dashboard that renders **every live agent session** in one screen — rows on hairlines, like a GitHub Actions run list. Served on localhost by `agent-progress dashboard`.

## Run it

```sh
agent-progress dashboard
```

The CLI prints a URL carrying a per-run 128-bit token. Open that URL — the dashboard reads `token` from the query string and passes it (URL-encoded) on every API call. Without the token the page shows an error instead of guessing.

## Honesty

> Self-reported thinking — agents report their own progress; estimates move.

The dashboard shows exactly what agents report. `eta_seconds: null` renders **"estimating…"** — never a fabricated number. Nothing here measures an agent's real internal state; it is the agent's own claim about itself.

## All tasks

Below the live rows, the **All tasks** section lists *every* task in the local event log — all retained days (7-day retention), not just today's live sessions, and finished tasks stay listed instead of expiring after 10 minutes. Each row shows status, progress bar, stage, message, start/last-update times, duration, event count, stage history, and an ETA. It polls `GET /api/tasks?token=<redacted> every 5 seconds; the endpoint aggregates the JSONL log on the server, one summary per task, active tasks first.

ETA per task, in priority order:

| Source | Rendered as | Meaning |
|---|---|---|
| `done` | `done` | Task finished; the row shows its total duration instead |
| `reported` | live countdown | The agent's own `eta_seconds` from its latest event, decayed by time since that event |
| `estimated` | `~m:ss est.` | Derived on the server from the task's *own* reported pace: elapsed × remaining ÷ done, rounded to 5s, only with ≥2 events, ≥5% progress, and forward motion |
| `unknown` | `estimating…` | Too little signal — no number is shown rather than an invented one |

An estimate is never blended with a reported ETA, and the `est.` label is part of the contract: it is a pace projection, not the agent's claim.

## All chats

Above All tasks, the **All chats** section lists *every* chat in the local session registry (`~/.agent-progress/sessions.json`, written by the host agent), working or idle — a chat is never silently missing just because it has reported nothing. `GET /api/sessions?token=<redacted> joins the registry with the task aggregation: each chat carries its reported tasks (matched by exact `task_ids` or `task_prefixes` in its registry entry) and its latest task's percent + ETA, rendered with the same honesty rules as below. Tasks no chat claims are counted as `unassigned_count` and still appear in All tasks. Working chats sort first, then alphabetically.

## The tier system

A bar for a 300ms session is noise, so rows are time-tiered by session age:

| Session age | Render |
|---|---|
| < 1s | Mascot pulse-pop + "just started" micro-label — no bar |
| 1–5s | `<uapb-progress>` in compact mode + mono ETA |
| > 5s | Full `<uapb-progress>`: bar + ETA + stage ticker |

Every tier shares one fixed body min-height, so promoting a session never reflows the rows around it. Only active rows animate (motion budget); finished sessions collapse into **"Recently finished"**, auto-expire after 10 minutes, and each has a Dismiss button.

A session with no event for 60 seconds goes **stale**: amber left border, frozen mascot, desaturated bar, and "stale — no heartbeat Ns". Frozen, not animated — that is the honest signal.

## Row anatomy

Status dot + pixel mascot (24px, pure-CSS box-shadow) + `agent · session` text + word-first status pill (RUNNING / PAUSED / DONE / ERROR / STALE — word first, color never the only signal) + `<uapb-progress>` + stage ticker + mono ETA. Per-agent identity: a deterministic hash of the agent name picks one of 6 accent hues, applied **only** to the mascot's antenna tip and the 2px row border. Emerald, red, and amber are reserved for done/error/stale and never used as agent accents. The stage ticker opens a newest-first history viewer (mono timestamps, capped at 25) via the History expander.

## Stream

- `GET /api/stream?token=<128b>&resume=<id>` — SSE; the server replays recent events on connect, then streams live. Malformed lines are dropped silently and counted in the stream-health indicator, along with `{type:"dropped"}` markers.
- `GET /api/snapshot?token=` — latest event per task, rendered before the stream opens.

If the stream is unreachable the page shows a full-page error with a Retry button.

## Privacy

Everything is local. The dashboard consumes the localhost SSE stream; the stream's events are appended by the MCP server to `~/.agent-progress/events-YYYY-MM-DD.jsonl` on your machine (mode `0600`, per-day rotation, 7-day retention). No data leaves the machine — the page's CSP allows `connect-src 'self'` only.

## Build

```sh
node scripts/build-dashboard.js
```

Zero npm dependencies. `packages/dashboard/src/` (vanilla JS + the marker shell `index.html`) is inlined with the widget sources into `packages/dashboard/dist/index.html`; the build injects a strict CSP meta (three hashes: script, document style, widget shadow style) and then **re-reads the output and re-hashes** — any mismatch throws and the build fails.
