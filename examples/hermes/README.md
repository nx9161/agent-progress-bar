<!-- SPDX-License-Identifier: MIT -->

# Show Hermes's thinking — via the progress bar protocol

Hermes Agent (Nous Research, MIT) speaks MCP natively, so the Universal
Agent Progress Bar plugs straight into it. With this setup, Hermes reports
its real thinking stages — what it is doing, how far along it estimates it
is, and its ETA — through `report_progress`, and you watch it happen.

## Setup (about 5 minutes, on the machine where Hermes runs)

1. **Build the MCP server**
   ```bash
   git clone https://github.com/nx9161/agent-progress-bar
   cd agent-progress-bar/packages/mcp-server
   npm ci && npm run build
   ```

2. **Connect it to Hermes** — add the block from `config-snippet.yaml`
   to `~/.hermes/config.yaml` (fix the path to your checkout).

3. **Teach Hermes to report** — copy `SKILL.md` to
   `~/.hermes/skills/progress-reporting/SKILL.md`.

4. **Restart Hermes** (or run `/reload-mcp` in a session).

5. **Give it a multi-step task**, e.g.
   `hermes run "research the three best note-taking apps and compare them"`.
   Watch its transcript: you will see `report_progress` calls with real
   stage names (`"Searching the web"`, `"Reading reviews"`, …), honest
   percentages, and ETAs that say `null` when it does not know.

## What you will see

Two ways to watch, same underlying reports:

**Transcript path.** Hermes's own UI shows each progress report as it
happens — that is the live thinking trace. Ask it anytime: *"what's your
progress on this?"* and it answers from `get_status`.

**Graphical path.** Install the unofficial dashboard plugin
(`packages/hermes-plugin/`, run `install.sh`) into your Hermes copy, then
run `agent-progress dashboard` and paste the one-launch token it prints.
Hermes's reports render live in the dashboard — bar, stage ticker, ETA
that moves — while the transcript stays the detailed view.

## Honest limits

- This is **self-reported thinking**: Hermes telling you what it is doing,
  in its own words. It is not a mind-reading device — an agent can only
  report what it knows about its own work.
- ETAs are estimates and will move. `null` means "I don't know", and the
  skill instructs Hermes never to fabricate one.
- The dashboard renders what Hermes reports — nothing more. If a stage
  name is vague or a percent looks optimistic, that is Hermes's own
  estimate, not a measurement. (An earlier version of this file said a
  graphical view needed an out-of-scope network relay; the local
  dashboard now covers that — local-only, no network.)
