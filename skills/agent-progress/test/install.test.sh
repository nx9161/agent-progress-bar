#!/usr/bin/env bash
# Hermetic test for skills/agent-progress/install.sh — fake HOME, fake harness CLIs.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SKILL_DIR="$REPO_ROOT/skills/agent-progress"
INSTALL="$SKILL_DIR/install.sh"

pass=0; fail=0
ok()   { pass=$((pass+1)); echo "ok   - $1"; }
bad()  { fail=$((fail+1)); echo "FAIL - $1"; }

# 1. Frontmatter sanity: name must match the folder name, description non-empty.
name="$(sed -n 's/^name: *//p' "$SKILL_DIR/SKILL.md" | head -1 | tr -d ' "')"
desc="$(sed -n 's/^description: *//p' "$SKILL_DIR/SKILL.md" | head -1)"
[[ "$name" == "agent-progress" ]] && ok "frontmatter name matches folder" || bad "frontmatter name ($name) != folder (agent-progress)"
[[ -n "$desc" ]] && ok "frontmatter description present" || bad "frontmatter description missing"
grep -q '^license: MIT' "$SKILL_DIR/SKILL.md" && ok "license field present" || bad "license field missing"

# 2. Fake environment.
FAKE_HOME="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
export HOME="$FAKE_HOME"
export PATH="$FAKE_BIN:$PATH"
trap 'rm -rf "$FAKE_HOME" "$FAKE_BIN"' EXIT
for cli in claude codex cursor gemini opencode; do
  printf '#!/bin/sh\nexit 0\n' > "$FAKE_BIN/$cli"
  chmod +x "$FAKE_BIN/$cli"
done

# 3. --list detects all fake harnesses.
list_out="$(bash "$INSTALL" --list)"
for h in claude-code codex cursor gemini opencode; do
  echo "$list_out" | grep -q "$h" && ok "detect $h" || bad "detect $h"
done

# 4. Full global install.
bash "$INSTALL" --all >/dev/null
declare -A EXPECT=(
  [claude-code]="$FAKE_HOME/.claude/skills/agent-progress"
  [codex]="$FAKE_HOME/.agents/skills/agent-progress"
  [cursor]="$FAKE_HOME/.cursor/skills/agent-progress"
  [copilot]="$FAKE_HOME/.copilot/skills/agent-progress"
  [gemini]="$FAKE_HOME/.gemini/skills/agent-progress"
  [opencode]="$FAKE_HOME/.config/opencode/skills/agent-progress"
)
for h in "${!EXPECT[@]}"; do
  d="${EXPECT[$h]}"
  [[ -f "$d/SKILL.md" && -f "$d/references/install.md" ]] \
    && ok "install $h" \
    || bad "install $h (missing files in $d)"
  cmp -s "$SKILL_DIR/SKILL.md" "$d/SKILL.md" \
    && ok "content identical ($h)" \
    || bad "content drift ($h)"
done

# 5. Idempotent: second run produces the same tree.
before="$(find "$FAKE_HOME" -type f | sort | sha256sum)"
bash "$INSTALL" --all >/dev/null
after="$(find "$FAKE_HOME" -type f | sort | sha256sum)"
[[ "$before" == "$after" ]] && ok "idempotent re-install" || bad "re-install changed the tree"

# 6. --project installs repo-local dirs.
PROJ="$(mktemp -d)"; cd "$PROJ"
bash "$INSTALL" --project --claude-code --codex >/dev/null
[[ -f "$PROJ/.claude/skills/agent-progress/SKILL.md" ]] && ok "project install (claude-code)" || bad "project install (claude-code)"
[[ -f "$PROJ/.agents/skills/agent-progress/SKILL.md" ]] && ok "project install (codex)" || bad "project install (codex)"
[[ ! -e "$FAKE_HOME/.claude/skills/agent-progress/SKILL.md.bak" ]] && ok "no stray files in HOME" || bad "stray files in HOME"
cd - >/dev/null; rm -rf "$PROJ"

# 7. --mcp-config prints a usable snippet.
bash "$INSTALL" --mcp-config | grep -q '"agent-progress-mcp"' \
  && ok "--mcp-config prints server snippet" \
  || bad "--mcp-config output"

# 8. Unknown harness flag exits non-zero.
bash "$INSTALL" --nope >/dev/null 2>&1 \
  && bad "unknown flag should fail" \
  || ok "unknown flag rejected"

echo
echo "passed: $pass, failed: $fail"
[[ $fail -eq 0 ]]
