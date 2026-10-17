# Installing the agent-progress skill (manual)

The one-command path is `./install.sh` in this directory — it copies the
skill into every detected harness and can `npm install -g` the MCP server
for you. The steps below are the manual equivalent.

## 1. Copy the skill

A skill is a folder named `agent-progress` containing `SKILL.md`. Copy this
whole directory into your harness's skills folder:

| Harness | Personal (global) | Project |
|---|---|---|
| Claude Code | `~/.claude/skills/agent-progress/` | `<repo>/.claude/skills/agent-progress/` |
| OpenAI Codex | `~/.agents/skills/agent-progress/` | `<repo>/.agents/skills/agent-progress/` |
| Cursor | `~/.cursor/skills/agent-progress/` | `<repo>/.cursor/skills/agent-progress/` |
| VS Code + GitHub Copilot | `~/.copilot/skills/agent-progress/` | `<repo>/.github/skills/agent-progress/` |
| Gemini CLI | `~/.gemini/skills/agent-progress/` | `<repo>/.gemini/skills/agent-progress/` |
| OpenCode | `~/.config/opencode/skills/agent-progress/` | `<repo>/.opencode/skills/agent-progress/` |

The folder name must match the `name` field in `SKILL.md`'s frontmatter.

## 2. Connect the MCP server

The skill's `report_progress` / `get_status` tools come from the
`agent-progress-mcp` server (stdio). Install it:

```sh
npm install -g agent-progress-mcp
```

Then register it in your client and restart the client:

**Claude Code CLI**
```sh
claude mcp add agent-progress -- npx -y agent-progress-mcp
```

**Claude Desktop** — Settings > Connectors > Add custom connector:
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

**Codex CLI** — `~/.codex/config.toml`:
```toml
[mcp_servers.agent-progress]
command = "npx"
args = ["-y", "agent-progress-mcp"]
```

**Cursor** — Settings > MCP > Add new global MCP server, paste the JSON
block above.

## 3. Verify

Ask the agent to list its tools (or check the client's MCP panel) — you
should see `report_progress` and `get_status`. Then give it a multi-step
task and watch the dashboard:

```sh
agent-progress dashboard   # localhost UI, token-gated
```

Events also land in `~/.agent-progress/events-YYYY-MM-DD.jsonl` (7-day
retention, purge with `rm -rf ~/.agent-progress`).

## Hermes

If you run Hermes (Nous Research, open-source), there is a dedicated
variant: `examples/hermes/` in the repo has a Hermes-tuned skill plus an
unofficial dashboard plugin (`packages/hermes-plugin/`, installed with its
own `install.sh`).
