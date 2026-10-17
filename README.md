# Universal Agent Progress Bar (UAPB)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An open-source (MIT), agent-agnostic progress layer: a live demo website, a
progress-reporting protocol, an MCP-server "connector", an embeddable
widget, and a live layer — a local event sink plus a localhost dashboard —
so **any AI agent with visible thinking** (ChatGPT, DeepSeek, Kimi,
Claude, Gemini) can show the same live module: a 0–100% bar, a % counter, a
countdown, and a stage ticker.

## Live Demo

**[https://nx9161.github.io/agent-progress-bar/](https://nx9161.github.io/agent-progress-bar/)**

## The hard truth — read this first

**We cannot modify any third-party client's UI.** This project does not and
cannot inject a progress bar into ChatGPT, Claude, Gemini, DeepSeek, Kimi, or
any other app. "Works with all AI agents" means: an open, adoptable layer
that agent builders and agent harnesses wire in voluntarily. Anyone promising
"a progress bar inside ChatGPT" is selling a fantasy.

### What it IS

- A published protocol (`PROTOCOL.md` + `protocol/schema.json`) any agent can speak.
- An MCP server any MCP-compatible agent connects to and reports progress through.
- A local event sink: every progress report is appended to a JSONL log on
  your machine — no network, no accounts (see "Live layer" and "Privacy").
- A localhost dashboard (`agent-progress dashboard`) that renders the
  event stream live, gated by a per-launch token.
- An unofficial dashboard plugin for Hermes (open-source, MIT; see
  "Hermes plugin").
- A `<uapb-progress>` web component + iframe wrapper any page can embed.
- A concept demo showing the proposed UX (simulated run — no AI connected).

### What it is NOT

- Not a plugin, extension, or patch for any **closed** chat client. This
  project now ships an *unofficial* dashboard plugin for Hermes — but
  Hermes is open-source (MIT), and the plugin is installed by the user
  into their own Hermes copy; it is not injected into any closed client.
  The hard truth above still applies to ChatGPT, Claude, Gemini, DeepSeek,
  Kimi, and every other closed app: nobody can inject a progress bar into
  those.
- Not affiliated with or endorsed by OpenAI, Anthropic, Google, DeepSeek,
  Moonshot AI, or Nous Research.
- Not a backend service (the live layer is local-only; see non-goals).

> *Experimental. Progress percentages and time estimates are heuristics, not
> guarantees. Not warranted for production agent orchestration or any
> time-critical use. Use at your own risk.*

**No telemetry, no accounts, no data leaves your machine.** The MCP server
keeps reports in memory with a 30-minute TTL *and* appends them to a local
JSONL event log (`~/.agent-progress/events-YYYY-MM-DD.jsonl`, files `0600`,
7-day retention) — it never phones home.

## Quickstarts

### 1. Try the concept demo (everyone)

Open the self-contained demo page — no build step, no server:

```sh
node scripts/build-demo.js   # writes dist/index.html (zero dependencies)
open dist/index.html         # or serve it with any static server
```

Mock chat window, three-dot "Thinking…" indicator **alongside** (never
replacing) the progress module, 15s/30s/60s presets (default 45s), compact
toggle, Restart. Honesty labels on the page mark it as a simulated run.

### 2. Connect an agent via the MCP connector (agent builders)

```sh
cd packages/mcp-server
npm ci            # exact-pinned deps; regenerate the lockfile first: npm install
npm run build
npm start         # stdio MCP server
```

Or install globally: `npm install -g agent-progress-mcp`, then add to your
MCP client's config (Claude Desktop example):

```json
{
  "mcpServers": {
    "agent-progress": {
      "command": "npx",
      "args": ["-y", "agent-progress-mcp"],
      "env": { "PROGRESS_TTL_MS": "1800000", "LOG_LEVEL": "info" }
    }
  }
}
```

Then from the agent: `report_progress({task_id: "claude:my-task", percent: 42, eta_seconds: 30, stage: "Reasoning"})` → `get_status({task_id: "claude:my-task"})`. Full worked example in `packages/mcp-server/README.md`.

### 3. Embed the widget (web developers)

Canonical — the custom element (timer-free; you push state):

```html
<script src="packages/widget/src/uapb-core.js"></script>
<script src="packages/widget/src/uapb-widget.js"></script>
<uapb-progress id="bar"></uapb-progress>
<script>
  document.getElementById("bar").setProgress({ percent: 42, etaSeconds: 30, stage: "Reasoning" });
  document.getElementById("bar").addEventListener("uapb-complete", () => console.log("done"));
</script>
```

Secondary — iframe (sandboxed, origin allowlist, default deny):

```html
<iframe src="packages/widget/embed/iframe.html?allow=https%3A%2F%2Fyour-site.example"
        sandbox="allow-scripts" title="Agent progress bar"></iframe>
```

See `examples/embed-snippet.html` for the full postMessage pattern
(explicit targetOrigin — never `'*'`).

### 4. Watch the live layer (dashboard + event log)

Once an agent reports through the MCP server, its thinking trace lands in
the local event log — watch it live:

```sh
agent-progress dashboard   # binds 127.0.0.1, prints a one-launch token
```

The dashboard streams new events over SSE and renders them by duration
tier: sub-second tasks get a mascot pulse, 1–5s runs a compact bar, longer
runs the full bar + ETA + stage ticker. Every `/api/*` call needs the
token printed in your terminal; the token dies when the dashboard process
exits.

Inspect the raw log any time — it is just JSONL:

```sh
agent-progress events    # read-only inspector for the event log
```

Full detail in the "Live layer" section below and in
[`packages/dashboard/README.md`](packages/dashboard/README.md).

## Live layer

The MCP server's in-memory store answers `get_status`, but the live layer
keeps the **history** — so any agent's progress survives on your machine
and renders live.

**Event sink.** Every `report_progress` call is appended to a local JSONL
file, `~/.agent-progress/events-YYYY-MM-DD.jsonl`. The directory is mode
`0700`, files are mode `0600`, files older than 7 days are deleted
automatically, and `AGENT_PROGRESS_EVENTS_DIR` overrides the directory.
The sink stamps each record with `agent` (from the record, `UAPB_AGENT`,
or the `agent:` prefix of `task_id` as fallback) and `session_id`
(defaults to `task_id`) — additive labels for the dashboard, not wire
fields (wire contract frozen at `proto: 1`; consumers ignore unknown
fields — see `PROTOCOL.md`).

**Dashboard.** `agent-progress dashboard` serves a small web UI plus an SSE
stream of new events. It binds `127.0.0.1` only (first free port
17421–17430) and gates every `/api/*` endpoint behind a 128-bit bearer
token minted fresh on each launch — the token is printed to your terminal
for you to paste into the page, is never written to disk, and dies with
the process. CORS is restricted to literal loopback hosts. Single-user
localhost by design: do not expose it beyond loopback. See
[`packages/dashboard/README.md`](packages/dashboard/README.md) and the
binding Privacy section below.

## Hermes plugin (unofficial)

`packages/hermes-plugin/` is an unofficial dashboard plugin for
[Hermes Agent](https://github.com/NousResearch/hermes-agent) (Nous
Research, MIT, open-source). It consumes the same localhost SSE stream as
the dashboard and renders Hermes's self-reported progress graphically —
bar, stage ticker, ETA that moves. Install it yourself into your own
Hermes copy (`~/.hermes/plugins/uapb-hermes-plugin/`, via `install.sh`);
Hermes self-reports through the MCP server using the skill in
[`examples/hermes/`](examples/hermes/). Nothing is injected into any
closed client — the plugin exists because Hermes is open-source and the
user opts in. Full instructions:
[`packages/hermes-plugin/README.md`](packages/hermes-plugin/README.md).

## Privacy

Binding. Your data lives in exactly one place and goes nowhere.

- **What is logged:** progress events only — `task_id`, `percent`,
  `stage`, `eta_seconds`, timestamps, and the agent label
  (`agent`/`session_id`). Stage labels and messages are whatever your
  agent chose to report; keep sensitive text out of them.
- **Where:** `~/.agent-progress/events-YYYY-MM-DD.jsonl` on your machine.
- **Modes:** directory `0700`, files `0600` (owner read/write only).
- **Retention:** 7 days, automatic.
- **Purge everything:** `rm -rf ~/.agent-progress`.
- **Threat model:** single-user localhost. The dashboard binds `127.0.0.1`
  only, gates `/api/*` behind a per-launch 128-bit bearer token, and
  restricts CORS to literal loopback hosts. There is no authentication
  system, no accounts, and no network — nothing is designed to be exposed
  beyond your machine.

## Repo layout

```
protocol/            schema.json (machine truth) + types.ts
packages/mcp-server/ stdio MCP server: report_progress / get_status (+ local JSONL event sink)
packages/dashboard/  localhost dashboard + SSE stream (127.0.0.1, token-gated /api/*)
packages/hermes-plugin/ unofficial Hermes dashboard plugin (install via install.sh)
packages/widget/     <uapb-progress> custom element + iframe wrapper
packages/cli/        internal dev CLI: agent-progress dashboard / agent-progress events
packages/web/        concept demo source (demo.js is disposable in v1)
examples/            iframe embed snippet, examples/hermes/ (config + skill for Hermes self-reporting)
scripts/             zero-dep demo bundler -> dist/index.html; build-dashboard.js -> dashboard bundle
dist/                built demo page (CI-built from packages/web + packages/widget; never edit by hand)
```

Read [`PROTOCOL.md`](PROTOCOL.md) for the event shape, honesty rule
(`eta_seconds: null`, never fabricated), and compatibility rule.

## Theming

Every `--uapb-*` token the widget and demo page read. Set them on a
wrapper (or `:root`) to restyle — tokens inherit into the widget's shadow
DOM. Flat solid fills are the design language: `--uapb-fill` is a solid
color, not a gradient.

| Token | Default | What it styles |
|---|---|---|
| `--uapb-bg` | `#0B0E14` | Page background (demo) |
| `--uapb-surface` | `#141A23` | Cards, buttons, panels |
| `--uapb-border` | `#26303D` | Borders |
| `--uapb-text` | `#E9EEF5` | Primary text; widget `:host` color |
| `--uapb-muted` | `#93A0B4` | Secondary text (stage, captions) |
| `--uapb-track` | `#232C3A` | Progress track |
| `--uapb-fill` | `#E9EEF5` | Progress fill (solid) |
| `--uapb-warn` | `#F5A524` | Reserved warning accent |
| `--uapb-done` | `#34D399` | 100% fill |
| `--uapb-error` | `#F87171` | Error state (stage text) |
| `--uapb-radius` | `10px` | Corner radius |
| `--uapb-sans` | system sans stack | Body font |
| `--uapb-mono` | `ui-monospace, SFMono-Regular, Menlo, monospace` | Numerals (% counter, countdown, eta caption) |
| `--uapb-font` | `var(--uapb-sans)` | Widget `:host` font |

## Widget states

`setProgress()` pushes one state update; the widget is timer-free and
renders only:

```js
bar.setProgress({
  percent: 42,        // 0–100, clamped
  etaSeconds: 30,     // null = unknown ("estimating…", never invented)
  stage: "Reasoning", // ≤120 chars; stage element title mirrors full text
  status: "running",  // started | running | paused | error | done (default "running")
  message: "...",     // ≤280 chars; shown as stage in error state
  durationMs: 41203,  // finite number -> carried on uapb-complete detail
});
```

Invalid `status` values fall back to `"running"` silently. All text is set
via `textContent` — no HTML is ever injected.

| Status | Rendered behavior |
|---|---|
| `started` | Normal bar. Null ETA shows "estimating…" with a subtle track sheen. |
| `running` | Normal bar. Null ETA shows "estimating…" with a subtle track sheen. |
| `paused` | Bar goes grayscale; stage becomes "Paused — {stage}" (or "Paused"); ETA caption reads "paused". |
| `error` | Stage shows `message` (or "Something went wrong") in the error color; stage element gets `role="alert"` (removed in non-error states). |
| `done` | 100% snap with the done-green fill. |

The `label` attribute sets the progressbar's `aria-label` (default
`"Agent progress"`). When `percent` reaches 100, the widget fires a
bubbling, composed `uapb-complete` event with `detail: {durationMs}` when
`durationMs` is a finite number, else `detail: {}`.

Iframe path: `iframe.html` also accepts one-shot `?status=` (one of the
five enum values, others ignored) and `?label=` (≤120 chars) seed params,
alongside `?percent=`, `?eta=`, `?stage=`.

## Non-goals

Live backend relay, hosted multi-tenant service, auth/rate-limiting,
analytics/telemetry, hosted history. (The local JSONL event sink and the
unofficial Hermes dashboard plugin are the deliberate exceptions — both
local-only, no network, no accounts.)

## Contributing / security

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — conventional commits, PR norms, DCO-lite.
- [`SECURITY.md`](SECURITY.md) — private vulnerability reporting via GitHub Security Advisories.

## Trademark notice

ChatGPT, Claude, Gemini, DeepSeek, and Kimi are trademarks of their
respective owners (OpenAI, Anthropic, Google, DeepSeek, Moonshot AI).
Hermes is a trademark of Nous Research. This project is not affiliated
with or endorsed by any of them.

## License

MIT — see [`LICENSE`](LICENSE). Copyright (c) 2026 Naman Parmar.
