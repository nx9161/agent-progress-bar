#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Hermetic tests for packages/hermes-plugin/install.sh.
#
# Runs install/uninstall against a FAKE $HOME so the real ~/.hermes is
# never touched. Covers:
#   F1 — nested `enabled:` before the top-level one: the installer must
#        edit the top-level plugins.enabled list, not the nested one.
#   F2 — uninstall must not clobber user edits made after install
#        (surgical removal first; backup restore only when config missing).
#   plus: idempotent re-install, flow-style enabled, --dry-run changes nothing.
#
# Usage: bash packages/hermes-plugin/test/install.test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
INSTALL="$ROOT/packages/hermes-plugin/install.sh"
PLUGIN="uapb-hermes-plugin"

PASS=0
FAIL=0

ok()   { PASS=$((PASS + 1)); echo "  ok: $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

# fresh fake home per test
new_home() {
  FAKEHOME="$(mktemp -d)"
  export HOME="$FAKEHOME"
  CONFIG="$FAKEHOME/.hermes/config.yaml"
}

run_install()   { bash "$INSTALL" "$@" >/dev/null 2>&1; }
run_uninstall() { bash "$INSTALL" --uninstall >/dev/null 2>&1; }

# --- F1: nested enabled: before the top-level one -------------------------
echo "[F1] nested enabled: fixture — top-level list is edited, nested untouched"
new_home
mkdir -p "$FAKEHOME/.hermes"
cat > "$CONFIG" <<'YAML'
model: test-model
plugins:
  dashboard:
    enabled: [other-dashboard-plugin]
  enabled:
    - other-plugin
gateway:
  port: 1234
YAML
run_install

if grep -q '^    enabled: \[other-dashboard-plugin\]$' "$CONFIG"; then
  ok "nested dashboard.enabled left untouched"
else
  bad "nested dashboard.enabled was modified:"; grep -n "other-dashboard-plugin" "$CONFIG" || true
fi
if grep -q '^    - uapb-hermes-plugin$' "$CONFIG"; then
  ok "plugin added to top-level enabled list"
else
  bad "plugin NOT in top-level enabled list"; cat "$CONFIG"
fi
if grep -q '^    - other-plugin$' "$CONFIG"; then
  ok "pre-existing top-level entry preserved"
else
  bad "pre-existing top-level entry lost"
fi
count="$(grep -c 'uapb-hermes-plugin' "$CONFIG")"
if [ "$count" = "1" ]; then ok "exactly one plugin entry"; else bad "plugin entry count = $count"; fi

# --- idempotent re-install ------------------------------------------------
echo "[idempotency] second install adds nothing"
run_install
count="$(grep -c 'uapb-hermes-plugin' "$CONFIG")"
if [ "$count" = "1" ]; then ok "still exactly one entry after re-install"; else bad "count = $count"; fi

# --- F2: uninstall preserves user edits -----------------------------------
echo "[F2] uninstall keeps user edits, removes plugin entry"
printf '\n# user edit made after install\ncustom_key: user-value\n' >> "$CONFIG"
run_uninstall
if grep -q '^custom_key: user-value$' "$CONFIG"; then
  ok "user edit preserved across uninstall"
else
  bad "user edit was clobbered by uninstall"
fi
if grep -q 'uapb-hermes-plugin' "$CONFIG"; then
  bad "plugin entry still present after uninstall"
else
  ok "plugin entry surgically removed"
fi
if [ -e "$FAKEHOME/.hermes/plugins/uapb-hermes-plugin" ]; then
  bad "plugin dir still present after uninstall"
else
  ok "plugin dir removed"
fi

# --- F2b: missing config restores from backup ------------------------------
echo "[F2b] missing config -> restored from install-time backup"
new_home
mkdir -p "$FAKEHOME/.hermes"
printf 'model: x\n' > "$CONFIG"
run_install
rm "$CONFIG"  # config lost after install
run_uninstall
if [ -f "$CONFIG" ]; then
  ok "config restored from backup"
else
  bad "config NOT restored"
fi
if grep -q 'uapb-hermes-plugin' "$CONFIG" 2>/dev/null; then
  bad "restored config contains plugin entry"
else
  ok "restored config has no plugin entry (backup predates the edit)"
fi

# --- flow-style top-level enabled ------------------------------------------
echo "[flow] top-level 'enabled: [a, b]' gains the plugin, no duplicates"
new_home
mkdir -p "$FAKEHOME/.hermes"
printf 'plugins:\n  enabled: [alpha, beta]\n' > "$CONFIG"
run_install
if grep -q '^  enabled: \[alpha, beta, uapb-hermes-plugin\]$' "$CONFIG"; then
  ok "plugin appended to flow-style list"
else
  bad "flow-style edit wrong:"; cat "$CONFIG"
fi
run_install
count="$(grep -c 'uapb-hermes-plugin' "$CONFIG")"
if [ "$count" = "1" ]; then ok "no duplicate on re-install (flow style)"; else bad "count = $count"; fi

# --- --dry-run changes nothing ---------------------------------------------
echo "[dry-run] no writes under fake home"
new_home
mkdir -p "$FAKEHOME/.hermes"
printf 'plugins:\n  enabled:\n    - other-plugin\n' > "$CONFIG"
before="$(cat "$CONFIG")"
bash "$INSTALL" --dry-run >/dev/null 2>&1
after="$(cat "$CONFIG")"
if [ "$before" = "$after" ]; then ok "config unchanged by --dry-run"; else bad "config changed by --dry-run"; fi
if [ -e "$FAKEHOME/.hermes/plugins" ]; then
  bad "plugin dir created by --dry-run"
else
  ok "no plugin dir created by --dry-run"
fi

# --- plugin files actually installed ---------------------------------------
echo "[files] dist copied into the plugin dir"
new_home
run_install
for f in plugin.js plugin.css manifest.json; do
  if [ -f "$FAKEHOME/.hermes/plugins/uapb-hermes-plugin/dashboard/$f" ]; then
    ok "$f installed"
  else
    bad "$f missing"
  fi
done

echo ""
echo "install.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
