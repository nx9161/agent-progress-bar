---
name: progress-reporting
description: Report live thinking progress (stage, percent, ETA) through the agent-progress MCP server during multi-step tasks, so the user can see what you are doing.
---

# Progress Reporting

You have an MCP server called `progress` with two tools (they may appear
prefixed, e.g. `mcp_progress_report_progress`):

- `report_progress(task_id, percent, eta_seconds, stage, message?)` — record where you are.
- `get_status(task_id)` — read back the last report.

## When to report

Any task with 3+ steps, or anything lasting longer than ~30 seconds:
1. **Start**: `report_progress` with `percent: 0` and `stage` naming what you are about to do.
2. **Each step boundary**: report again with your honest `percent` and the new `stage`.
3. **Done**: `percent: 100`, `stage: "Done"`.

## Rules

- `task_id`: one stable id per task, e.g. `hermes:summarize-commits`. Charset: letters, numbers, `._:-`.
- `percent`: your genuine estimate of completion, 0–100. Out-of-range values are clamped server-side.
- `stage`: short present-tense label of what you are doing RIGHT NOW, e.g. `"Searching memory"`, `"Reading config"`, `"Drafting reply"`. Max 120 chars.
- `eta_seconds`: seconds until you expect to finish, or `null` when you genuinely do not know. **Never fabricate an ETA** — `null` is always acceptable and always honest.
- `message` (optional): one-line detail for the user, max 280 chars.

## Identity

- `task_id` convention: `hermes:<task-slug>`, e.g.
  `hermes:summarize-commits`. The `agent:` prefix is the fallback source
  of the agent label in the local event log.
- `UAPB_AGENT: "hermes"` (set in `config-snippet.yaml`) is the primary
  identity source — keep it.
- `session_id` in the event log equals your `task_id`: one session per
  task.

## What this is

This is self-reported thinking: you telling the user what you are doing,
in your own words, as you do it. It is not a brain scan — report what is
true, and say `null` when you do not know.
