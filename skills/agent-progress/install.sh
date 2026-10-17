#!/usr/bin/env bash
# Install the agent-progress skill + (optionally) the UAPB MCP server.
#
# Usage:
#   ./install.sh                 # install skill into every detected harness (global)
#   ./install.sh --project        # install into this repo's local skill dirs instead
#   ./install.sh --claude-code --codex   # pick harnesses explicitly
#   ./install.sh --mcp            # also npm-install the agent-progress-mcp server
#   ./install.sh --list           # show detected harnesses, install nothing
#   ./install.sh --mcp-config     # print the MCP client config snippet, install nothing
set -euo pipefail

SKILL_NAME="agent-progress"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="${HOME:-$HOME}"

PROJECT_MODE=0
INSTALL_MCP=0
LIST_ONLY=0
MCP_CONFIG_ONLY=0
declare -a WANT=()

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \?//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)    PROJECT_MODE=1 ;;
    --mcp)        INSTALL_MCP=1 ;;
    --list)       LIST_ONLY=1 ;;
    --mcp-config) MCP_CONFIG_ONLY=1 ;;
    --claude-code) WANT+=(claude-code) ;;
    --codex)      WANT+=(codex) ;;
    --cursor)     WANT+=(cursor) ;;
    --copilot)    WANT+=(copilot) ;;
    --gemini)     WANT+=(gemini) ;;
    --opencode)   WANT+=(opencode) ;;
    --all)        WANT=(claude-code codex cursor copilot gemini opencode) ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

# skill_dir <harness>: prints the install destination for a harness.
skill_dir() {
  case "$1" in
    claude-code) [[ $PROJECT_MODE -eq 1 ]] && echo ".claude/skills/$SKILL_NAME" || echo "$HOME_DIR/.claude/skills/$SKILL_NAME" ;;
    codex)      [[ $PROJECT_MODE -eq 1 ]] && echo ".agents/skills/$SKILL_NAME"  || echo "$HOME_DIR/.agents/skills/$SKILL_NAME" ;;
    cursor)     [[ $PROJECT_MODE -eq 1 ]] && echo ".cursor/skills/$SKILL_NAME"  || echo "$HOME_DIR/.cursor/skills/$SKILL_NAME" ;;
    copilot)    [[ $PROJECT_MODE -eq 1 ]] && echo ".github/skills/$SKILL_NAME"  || echo "$HOME_DIR/.copilot/skills/$SKILL_NAME" ;;
    gemini)     [[ $PROJECT_MODE -eq 1 ]] && echo ".gemini/skills/$SKILL_NAME"  || echo "$HOME_DIR/.gemini/skills/$SKILL_NAME" ;;
    opencode)   [[ $PROJECT_MODE -eq 1 ]] && echo ".opencode/skills/$SKILL_NAME"|| echo "$HOME_DIR/.config/opencode/skills/$SKILL_NAME" ;;
  esac
}

# detect: prints harness ids that look installed.
detect() {
  command -v claude >/dev/null 2>&1 && echo "claude-code"
  { command -v codex >/dev/null 2>&1 || [[ -d "$HOME_DIR/.codex" ]]; } && echo "codex"
  { command -v cursor >/dev/null 2>&1 || [[ -d "$HOME_DIR/.cursor" ]]; } && echo "cursor"
  { command -v copilot >/dev/null 2>&1 || [[ -d "$HOME_DIR/.copilot" ]]; } && echo "copilot"
  { command -v gemini >/dev/null 2>&1 || [[ -d "$HOME_DIR/.gemini" ]]; } && echo "gemini"
  { command -v opencode >/dev/null 2>&1 || [[ -d "$HOME_DIR/.config/opencode" ]]; } && echo "opencode"
  return 0
}

print_mcp_config() {
  cat <<'EOF'
Add this to your MCP client's config, then restart the client:

  {
    "mcpServers": {
      "agent-progress": {
        "command": "npx",
        "args": ["-y", "agent-progress-mcp"],
        "env": { "PROGRESS_TTL_MS": "1800000", "LOG_LEVEL": "info" }
      }
    }
  }

Claude Code CLI:   claude mcp add agent-progress -- npx -y agent-progress-mcp
Claude Desktop:    Settings > Connectors > Add custom connector (paste the JSON above)
Codex CLI:         ~/.codex/config.toml  ->  [mcp_servers.agent-progress]
Cursor:            Settings > MCP > Add new global MCP server (paste the JSON above)
EOF
}

if [[ $MCP_CONFIG_ONLY -eq 1 ]]; then
  print_mcp_config
  exit 0
fi

if [[ ${#WANT[@]} -eq 0 ]]; then
  # shellcheck disable=SC2207
  WANT=($(detect))
fi

if [[ $LIST_ONLY -eq 1 ]]; then
  if [[ ${#WANT[@]} -eq 0 ]]; then
    echo "No supported harnesses detected."
  else
    echo "Detected harnesses:"
    for h in "${WANT[@]}"; do echo "  - $h  ->  $(skill_dir "$h")"; done
  fi
  exit 0
fi

if [[ ${#WANT[@]} -eq 0 ]]; then
  echo "No supported harnesses detected. Pass one explicitly, e.g.:" >&2
  echo "  ./install.sh --claude-code --codex" >&2
  echo "Or run ./install.sh --list to see what was probed." >&2
  exit 1
fi

installed=0
for h in "${WANT[@]}"; do
  dest="$(skill_dir "$h")"
  mkdir -p "$dest"
  # Sync skill contents (keep it idempotent: wipe the dir first).
  rm -rf "${dest:?}/SKILL.md" "${dest:?}/references" "${dest:?}/test"
  cp "$SRC_DIR/SKILL.md" "$dest/"
  cp -r "$SRC_DIR/references" "$dest/"
  echo "installed: $h -> $dest"
  installed=$((installed + 1))
done

if [[ $INSTALL_MCP -eq 1 ]]; then
  if command -v npm >/dev/null 2>&1; then
    echo "installing agent-progress-mcp via npm..."
    npm install -g agent-progress-mcp
  else
    echo "npm not found — skipping MCP server install." >&2
    echo "Install Node.js, then run: npm install -g agent-progress-mcp" >&2
  fi
fi

echo
echo "Done ($installed harness(es)). Next: register the MCP server in your client:"
print_mcp_config
