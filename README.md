# Universal Agent Progress Bar (UAPB)

An open-source (MIT), agent-agnostic progress layer: a live demo website, a
progress-reporting protocol, an MCP-server "connector", and an embeddable
widget — so **any AI agent with visible thinking** (ChatGPT, DeepSeek, Kimi,
Claude, Gemini) can show the same live module: a 0–100% bar, a % counter, a
countdown, and a stage ticker.

## The hard truth — read this first

**We cannot modify any third-party client's UI.** This project does not and
cannot inject a progress bar into ChatGPT, Claude, Gemini, DeepSeek, Kimi, or
any other app. "Works with all AI agents" means: an open, adoptable layer
that agent builders and agent harnesses wire in voluntarily. Anyone promising
"a progress bar inside ChatGPT" is selling a fantasy.

### What it IS

- A published protocol (`PROTOCOL.md` + `protocol/schema.json`) any agent can speak.
- An MCP server any MCP-compatible agent connects to and reports progress through.
- A `<uapb-progress>` web component + iframe wrapper any page can embed.
- A concept demo showing the proposed UX (simulated run — no AI connected).

### What it is NOT

- Not a plugin, extension, or patch for any chat client.
- Not affiliated with or endorsed by OpenAI, Anthropic, Google, DeepSeek, or Moonshot AI.
- Not a backend service (v0 is a demo + connector skeleton; see non-goals).

> *Experimental. Progress percentages and time estimates are heuristics, not
> guarantees. Not warranted for production agent orchestration or any
> time-critical use. Use at your own risk.*

**No telemetry, no accounts, no data leaves your machine in v0.** The MCP
server keeps reports in memory with a 30-minute TTL and never phones home.

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

## Repo layout

```
protocol/            schema.json (machine truth) + types.ts
packages/mcp-server/ stdio MCP server: report_progress / get_status
packages/widget/     <uapb-progress> custom element + iframe wrapper
packages/cli/        internal dev CLI for driving/testing the MCP server
packages/web/        concept demo source (demo.js is disposable in v1)
examples/            iframe embed snippet
scripts/             zero-dep demo bundler -> dist/index.html
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

## v0 non-goals

Live backend relay, hosted multi-tenant service, persistence beyond TTL
memory, auth/rate-limiting, client plugins/extensions/mobile SDKs,
analytics/telemetry, history of progress events.

## Contributing / security

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — conventional commits, PR norms, DCO-lite.
- [`SECURITY.md`](SECURITY.md) — private vulnerability reporting via GitHub Security Advisories.

## Trademark notice

ChatGPT, Claude, Gemini, DeepSeek, and Kimi are trademarks of their
respective owners (OpenAI, Anthropic, Google, DeepSeek, Moonshot AI). This
project is not affiliated with or endorsed by any of them.

## License

MIT — see [`LICENSE`](LICENSE). Copyright (c) 2026 Naman Parmar.
