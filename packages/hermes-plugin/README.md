<!-- SPDX-License-Identifier: MIT -->

# uapb-hermes-plugin

A dashboard plugin for [Hermes Agent](https://github.com/NousResearch/hermes-agent)
(`hermes --web`) that renders the Universal Agent Progress Bar — pixel mascot,
progress bar, stage and ETA readouts — in a `chat:top` slot above the chat.

**Unofficial community plugin. Not affiliated with Nous Research.**

## What you see (please read)

This plugin shows **progress Hermes chooses to report via its progress
skill** — self-reported stages, not internal reasoning or chain-of-thought.
**Estimates move.** A slot micro-label says so at all times:
`Self-reported · estimates move`.

### Data path

The plugin does **not** subscribe to Hermes's native `/api/events`. It
consumes the Universal Agent Progress Bar localhost SSE stream:

```
http://127.0.0.1:<port>/api/stream?token=<paste-once>
```

fed by Hermes self-reporting through its progress skill → the
`agent-progress` MCP server → JSONL → `agent-progress dashboard`.
Events are filtered to `agent === "hermes"` (falling back to the
most-recent session when none is tagged yet).

## Install

Prerequisites: `node` (>= 18) on PATH, a Hermes checkout of this repo, and
Hermes itself with `~/.hermes/config.yaml`.

```bash
cd agent-progress-bar
./packages/hermes-plugin/install.sh            # install
./packages/hermes-plugin/install.sh --dry-run  # print every action, change nothing
./packages/hermes-plugin/install.sh --uninstall
```

What install does:

1. Checks `node` is present.
2. Runs the deterministic build (`scripts/build-hermes-plugin.js`) into
   `packages/hermes-plugin/dist/`.
3. Backs up `~/.hermes/config.yaml` to
   `~/.hermes/config.yaml.uapb-bak-<timestamp>`.
4. Adds `uapb-hermes-plugin` to `plugins.enabled` — surgical, idempotent,
   YAML-aware (embedded node, never sed); creates the key if absent, never
   duplicates.
5. Copies `dist/` to `~/.hermes/plugins/uapb-hermes-plugin/dashboard/`
   (Hermes discovers dashboard plugins at
   `~/.hermes/plugins/<name>/dashboard/manifest.json`).
6. Prints next steps.

No network is used at any point. Writes are confined to `~/.hermes/**`
(and never touch `~/.agent-progress/**` event data); every write target is
asserted to resolve under those roots before it happens.

### Next steps (after install)

1. Teach Hermes to report progress (one-time):
   ```bash
   mkdir -p ~/.hermes/skills/progress-reporting
   cp examples/hermes/SKILL.md ~/.hermes/skills/progress-reporting/SKILL.md
   ```
   Add the MCP server block from `examples/hermes/config-snippet.yaml` to
   `~/.hermes/config.yaml`, then restart Hermes (or `/reload-mcp`).
2. Start the dashboard and copy the token it prints:
   ```bash
   agent-progress dashboard
   ```
3. Open the Hermes web dashboard (`hermes --web`). At the top of chat the
   new slot shows a setup row: paste the token (adjust the port if the
   dashboard used a non-default one) and Save. The token is stored in the
   browser's `localStorage` only — never logged, never sent anywhere except
   as the `?token=` query parameter on the localhost stream.
4. Give Hermes a multi-step task and watch the slot.

## Theming (chameleon)

The slot has **zero panel chrome** — no border, no background panel, no
shadow. It sits in Hermes's chat flow and inherits the host's look. Every
color and font resolves through a `--uapb-*` CSS variable with a fallback
to the Universal Agent Progress Bar instrument-panel tokens, so defining
any of these on the host re-themes the slot (and the bar inside it, whose
shadow-DOM CSS reads the same variables).

| Variable       | Controls                          | Fallback (instrument-panel token) |
|----------------|-----------------------------------|-----------------------------------|
| `--uapb-text`  | Primary text                      | `#E9EEF5`                         |
| `--uapb-muted` | Secondary / muted text            | `#93A0B4`                         |
| `--uapb-track` | Progress bar track                | `#232C3A`                         |
| `--uapb-fill`  | Bar fill + mascot body            | `#E9EEF5`                         |
| `--uapb-border`| Hairlines (setup inputs)          | `#26303D`                         |
| `--uapb-done`  | Done state + mascot antenna tip   | `#34D399`                         |
| `--uapb-error` | Error text                        | `#F87171`                         |
| `--uapb-bg`    | Mascot eyes (contrasts the fill)  | `#0B0E14`                         |
| `--uapb-radius`| Corner radius                     | `8px`                             |
| `--uapb-font`  | Host font stack (body text)       | system sans stack                 |
| `--uapb-mono`  | Mono for numerals — tabular figures, non-negotiable | `ui-monospace` stack |

Example — tint the slot from the host page:

```css
:root {
  --uapb-text: #111111;
  --uapb-muted: #666666;
  --uapb-fill: #111111;
  --uapb-track: #e5e5e5;
}
```

## Behavior

- **Setup (no token):** quiet setup row — "Paste your dashboard token —
  run `agent-progress dashboard` to get it" — with port + token inputs and
  a Save button.
- **Live session tiers** (by elapsed time):
  - `< 1s`: mascot pulse only, bar hidden.
  - `1–5s`: compact bar.
  - `> 5s`: full bar with stage + ETA readouts.
- **Idle:** first run (never saw a live session) shows a static mascot at
  60% opacity and muted "Idle — progress appears here when Hermes works."
  (never animated when idle, never fully hidden — discoverability). After
  the first live session, idle collapses to the honesty micro-label only.
- **Stream drop:** shows "reconnecting…" and retries with backoff
  (1s → 2s → 4s → 8s → 15s → 30s cap).
- **SDK guard:** the plugin feature-detects the Hermes plugin SDK major
  version 1 (`window.__HERMES_PLUGIN_SDK__`) and the runtime slot API
  (`window.__HERMES_PLUGINS__.registerSlot(plugin, slot, component)`). If
  either is absent or incompatible, it fails quietly — console warning
  only, never breaking the host page.
- **Rendering:** textContent-only DOM, no `innerHTML` anywhere (AppSec
  C13). Honors `prefers-reduced-motion`.

## Troubleshooting

| Symptom | Check |
|---|---|
| Slot doesn't appear | Is `uapb-hermes-plugin` listed under `plugins.enabled` in `~/.hermes/config.yaml`? Is `~/.hermes/plugins/uapb-hermes-plugin/dashboard/manifest.json` present? Restart the dashboard. |
| Setup row stuck on "connecting…" / "reconnecting…" | Is `agent-progress dashboard` running? Does the port in the setup row match the dashboard's port? Is the token current? |
| Slot shows the wrong agent's progress | The plugin filters to `agent === "hermes"` (or `hermes:<task>` task ids) and only falls back to the most-recent session when no Hermes-tagged session exists yet. |
| "Hermes plugin SDK v1 not detected" in console | Your Hermes dashboard build predates (or changed) the plugin SDK. The plugin disables itself rather than breaking the page. |
| Stale bundle after repo update | Re-run `install.sh` — it rebuilds deterministically and re-copies `dist/`. |

## Uninstall

```bash
./packages/hermes-plugin/install.sh --uninstall
```

Removes `~/.hermes/plugins/uapb-hermes-plugin/`, restores
`~/.hermes/config.yaml` from the newest
`~/.hermes/config.yaml.uapb-bak-*` backup, and removes the
`plugins.enabled` entry idempotently (safe to run twice). Backups are kept;
delete them manually if wanted. The browser-side token in `localStorage`
(`uapb.dashboardToken`) is not touched — clear site data in the dashboard
if you want it gone.

## Files

- `src/plugin.js` — slot component (vanilla JS, zero deps); build markers
  get the widget sources + CSS inlined.
- `src/plugin.css` — chameleon slot styles + 24px pixel mascot.
- `manifest.json` — source manifest (`integrity` is a placeholder here;
  the build computes the real `sha384` into the installed copy).
- `install.sh` — installer (`--dry-run`, `--uninstall`), no network.
- `../scripts/build-hermes-plugin.js` — deterministic build + SRI +
  self-verification (repo root `scripts/`).

License: MIT, Copyright (c) 2026 Naman Parmar.
