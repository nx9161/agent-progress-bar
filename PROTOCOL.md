# Universal Agent Progress Bar — Protocol (v0)

Human-readable companion to `protocol/schema.json`, which is the machine
truth. If this document and `schema.json` ever disagree, `schema.json` wins.

## What this is

An open, agent-agnostic contract for reporting task progress so that **any**
AI agent or chat client can render the same live progress module: a 0–100%
bar, a countdown, and a stage ticker.

**Hard truth:** we cannot modify any third-party client's UI. "Works with
all AI agents" means an open layer that agent builders wire in voluntarily —
not injection into their apps.

## Progress event

| Field | Required | Shape | Notes |
|---|---|---|---|
| `proto` | yes | integer, currently `1` | Major version. Breaking field changes bump this. |
| `task_id` | yes | 1–128 chars, `^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$` | Convention: `agentName:taskSlug` (e.g. `claude:summarize-report`). The server enforces the charset only. |
| `percent` | yes | number, 0–100 inclusive | The server **clamps** out-of-range values and never errors on regression (progress going backwards). |
| `eta_seconds` | yes | number ≥ 0, or `null` | `null` = unknown. **Honesty rule: NEVER fabricate an ETA.** Report `null` rather than a guess. |
| `stage` | yes | string, ≤120 chars | Human-readable phase label, e.g. `"Reasoning"`. |
| `status` | yes | `started` \| `running` \| `paused` \| `done` \| `error` | Lifecycle state. |
| `timestamp` | yes | ISO-8601 UTC | **Server-assigned.** Producers may not set their own clock as truth. |
| `agent` | no | string | e.g. `"claude"`. |
| `message` | no | string, ≤280 chars | Short note. |

## Compatibility rule (binding)

- Consumers MUST ignore unknown fields.
- Producers MUST NOT remove or rename fields except with a `proto` major bump.

## Event sink (local, additive)

The MCP server also appends every `report_progress` call to a local JSONL
file (`~/.agent-progress/events-YYYY-MM-DD.jsonl`: directory mode `0700`,
file mode `0600`, 7-day retention; `AGENT_PROGRESS_EVENTS_DIR` overrides
the directory). For the dashboard, the sink stamps each record with two
additive labels — `agent` (from `UAPB_AGENT`, else from the
`agent:` prefix of `task_id`, else `"unknown"`) and `session_id` (defaults to
`task_id`). These are **not** wire fields: the wire contract is frozen at
`proto: 1`, and consumers ignore unknown fields per the compatibility rule.

## Example

```json
{
  "proto": 1,
  "task_id": "claude:summarize-report",
  "percent": 42,
  "eta_seconds": 30,
  "stage": "Reasoning",
  "status": "running",
  "timestamp": "2026-10-14T02:00:00.000Z",
  "agent": "claude",
  "message": "reading section 3 of 7"
}
```

Unknown-ETA example — note `eta_seconds: null`, never a made-up number:

```json
{
  "proto": 1,
  "task_id": "deepseek:long-search",
  "percent": 12,
  "eta_seconds": null,
  "stage": "Searching memory",
  "status": "running",
  "timestamp": "2026-10-14T02:00:00.000Z"
}
```

## Transport notes (v0)

- The MCP server (`packages/mcp-server`) exposes `report_progress` and
  `get_status` over stdio. `get_status` returns the latest record per
  `task_id` plus `complete` (auto-true at 100%) and `updated_at`.
- The widget (`packages/widget`) is timer-free: hosts push state; the
  element renders. Iframe embedding uses an explicit origin allowlist with
  default deny — see the widget sources and `examples/embed-snippet.html`.

## Rendering guidance (non-normative)

This section is advisory only. The normative contract above is unchanged.

- **paused:** render the bar desaturated (e.g. grayscale), prefix the stage
  label with "Paused — " (or "Paused" when no stage is present), and mark
  the ETA area as "paused".
- **error:** render the stage as an assertive alert carrying `message`, or
  the fallback "Something went wrong" when no message was reported.
- **eta_seconds: null:** render "estimating…" (or an equivalent
  indeterminate cue). Never render an invented number.
- **done:** snap the bar to 100%.
