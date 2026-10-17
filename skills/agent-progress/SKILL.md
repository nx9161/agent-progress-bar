---
name: agent-progress
description: Report live thinking progress (stage, percent, ETA) through the agent-progress MCP server on multi-step or long tasks, so users can watch the work as it happens.
license: MIT
compatibility: Any agent harness that supports the Agent Skills open standard and MCP (Claude Code, OpenAI Codex, Cursor, VS Code + GitHub Copilot, Gemini CLI, OpenCode, and others).
metadata:
  skill-format: "agentskills.io"
  protocol-version: "1"
---

# Agent Progress

You can show the user a live progress module — a 0–100% bar, a percent
counter, a countdown, and a stage ticker — while you work, through the
Universal Agent Progress Bar (UAPB) MCP server. This is **self-reported**
progress: you telling the user what you are doing, in your own words, as
you do it. It is not a brain scan — report what is true, and say `null`
when you do not know.

## Prerequisite: the MCP server

This skill needs the `agent-progress` MCP server connected to your harness
(tools named `report_progress` and `get_status`, possibly prefixed, e.g.
`mcp_agent-progress_report_progress`). If those tools are unavailable, the
skill is not installed correctly — see `references/install.md` and fix the
setup before reporting. Never fake the tools' output; if they are missing,
just do the task normally and stay silent about progress.

## When to report

Any task with **3 or more steps**, or anything lasting longer than
**~30 seconds**:

1. **Start**: call `report_progress` with `percent: 0`, `status: "started"`, and `stage` naming what you are about to do.
2. **Each step boundary**: call it again with your honest `percent` and the new `stage`. Set `status: "paused"` if you are waiting on the user; `status: "error"` with a one-line `message` if something genuinely failed.
3. **Done**: `percent: 100`, `status: "done"`, `stage: "Done"`.

For quick single-step answers (a lookup, a short reply), do not report —
the skill would be noise.

## How to report

- `report_progress(task_id, percent, eta_seconds, stage, status?, message?)` — record where you are.
- `get_status(task_id)` — read back your last report (useful after an interruption, to resume honestly).

**Field rules** (from the UAPB protocol; `protocol/schema.json` in the repo is machine truth):

- `task_id`: one stable id per task, e.g. `claude:summarize-commits`. Convention: `<your-agent-name>:<task-slug>`. Charset: must start with a letter or digit, then letters, digits, `.`, `_`, `:`, `-`.
- `percent`: your genuine estimate of completion, 0–100. Out-of-range values are clamped server-side; going backwards is allowed (re-planning happens).
- `stage`: short present-tense label of what you are doing RIGHT NOW, e.g. `"Searching memory"`, `"Reading config"`, `"Drafting reply"`. Max 120 chars.
- `eta_seconds`: seconds until you expect to finish, or `null` when you genuinely do not know. **Never fabricate an ETA** — `null` is always acceptable and always honest. A null ETA renders as "estimating…", never as a made-up number.
- `status`: `started` | `running` | `paused` | `error` | `done`. Default `running`.
- `message` (optional): one-line detail for the user, max 280 chars. Keep secrets out of it — stage labels and messages are stored in a local event log on the user's machine.

## Identity

The local event log labels your reports by `agent` (from the record, the
`UAPB_AGENT` env var, or the `agent:` prefix of your `task_id` as fallback)
and `session_id` (defaults to your `task_id`: one session per task). Pick a
stable agent name for your harness (e.g. `claude`, `codex`, `cursor`) and
keep the `task_id` prefix consistent with it.

## What this is not

You cannot inject a progress bar into any closed chat client's UI — nobody
can. What you can do is report honestly through this server so any
connected dashboard, widget, or plugin renders your progress live. If no
surface is watching, the reports still land in the user's local event log
as a faithful record of what you did.
