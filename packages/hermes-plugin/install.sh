#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Installer for uapb-hermes-plugin (Universal Agent Progress Bar slot for
# the Hermes Agent web dashboard).
#
# Default (install):
#   1. checks node is present
#   2. runs the deterministic build (scripts/build-hermes-plugin.js)
#   3. backs up ~/.hermes/config.yaml
#   4. adds uapb-hermes-plugin to plugins.enabled (surgical, idempotent,
#      YAML-aware via an embedded node script — never sed)
#   5. copies dist/ into ~/.hermes/plugins/uapb-hermes-plugin/dashboard/
#   6. prints next steps
#
#   --dry-run    print every action, change nothing
#   --uninstall  remove the installed plugin dir and surgically remove the
#                plugins.enabled entry (idempotent). A backup restore
#                happens ONLY if config.yaml is missing entirely; backups
#                otherwise stay as the documented manual fallback.
#
# No network is used at any point (AppSec C10/C11). Disk writes are
# confined to ~/.hermes/** and ~/.agent-progress/** and asserted before
# every write.
set -euo pipefail

PLUGIN_NAME="uapb-hermes-plugin"
DRY_RUN=0
UNINSTALL=0

usage() {
  echo "usage: install.sh [--dry-run] [--uninstall]"
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; usage; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERMES_HOME="${HOME}/.hermes"
AGENT_PROGRESS_HOME="${HOME}/.agent-progress"
CONFIG="${HERMES_HOME}/config.yaml"
PLUGIN_ROOT="${HERMES_HOME}/plugins/${PLUGIN_NAME}"
PLUGIN_DIR="${PLUGIN_ROOT}/dashboard"
DIST="${ROOT}/packages/hermes-plugin/dist"

say() { echo "$1"; }

# Fail closed: every write target must resolve under ~/.hermes or
# ~/.agent-progress (AppSec disk confinement).
assert_under() {
  local resolved
  resolved="$(realpath -m "$1")"
  case "$resolved" in
    "${HERMES_HOME}" | "${HERMES_HOME}"/* | "${AGENT_PROGRESS_HOME}" | "${AGENT_PROGRESS_HOME}"/*) ;;
    *)
      echo "refusing to write outside ~/.hermes and ~/.agent-progress: $1" >&2
      exit 1
      ;;
  esac
}

# YAML-aware edit of plugins.enabled. Never sed: a small embedded node
# program parses the block structure (indentation-aware) and adds/removes
# the plugin name idempotently. Aborts loudly on shapes it does not
# understand instead of corrupting the file.
yaml_edit() {
  local mode="$1" # add | remove
  node - "$CONFIG" "$mode" <<'NODE_EOF'
const fs = require("node:fs");
const file = process.argv[2];
const mode = process.argv[3]; // "add" | "remove"
const NAME = "uapb-hermes-plugin";

const exists = fs.existsSync(file);
let text = exists ? fs.readFileSync(file, "utf8") : "";
let lines = text === "" ? [] : text.split("\n");
if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

const indentOf = (l) => l.match(/^ */)[0].length;
const isBlankOrComment = (l) => /^\s*(#|$)/.test(l);
const stripVal = (v) => v.trim().replace(/^(['"])(.*)\1$/, "$2");

let dirty = false;

function blockEnd(from) {
  // First line at indent 0 (a new top-level key) ends the plugins block.
  for (let i = from; i < lines.length; i++) {
    const l = lines[i];
    if (isBlankOrComment(l)) continue;
    if (indentOf(l) === 0) return i;
  }
  return lines.length;
}

function findPlugins() {
  for (let i = 0; i < lines.length; i++) {
    if (/^plugins:\s*(#.*)?$/.test(lines[i])) return i;
    if (/^plugins:\s*[{[]/.test(lines[i])) {
      console.error("yaml_edit: 'plugins:' uses flow style; edit " + file + " manually");
      process.exit(1);
    }
  }
  return -1;
}

// Locate the `enabled:` line that is a DIRECT CHILD of the plugins block.
// F1-residual: match only `enabled:` at the direct-child indent level (the
// minimum indent among non-blank block lines). A nested `enabled:` with no
// top-level sibling (e.g. plugins: -> dashboard: -> enabled: [...]) must
// never hijack the edit — return null so `add` inserts a fresh top-level
// list and `remove` no-ops.
function findEnabled(pIdx) {
  const end = blockEnd(pIdx + 1);
  const pIndent = indentOf(lines[pIdx]);
  let childIndent = null;
  for (let i = pIdx + 1; i < end; i++) {
    const l = lines[i];
    if (isBlankOrComment(l)) continue;
    if (indentOf(l) <= pIndent) break; // dedent ends the block
    if (childIndent === null || indentOf(l) < childIndent) childIndent = indentOf(l);
  }
  if (childIndent === null) return null;
  for (let i = pIdx + 1; i < end; i++) {
    const l = lines[i];
    if (isBlankOrComment(l)) continue;
    if (indentOf(l) <= pIndent) break;
    if (indentOf(l) !== childIndent) continue;
    const m = l.match(/^(\s*)enabled:(.*)$/);
    if (m) return { idx: i, indent: m[1], rest: m[2] };
  }
  return null;
}

function listItems(e) {
  // Block-sequence items directly under `enabled:`, deeper indent.
  const items = [];
  for (let i = e.idx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (isBlankOrComment(l)) continue;
    if (indentOf(l) <= e.indent.length) break;
    const m = l.match(/^(\s*)-\s+(.*)$/);
    if (!m || indentOf(l) <= e.indent.length) {
      console.error("yaml_edit: 'plugins.enabled' has a non-list shape; edit " + file + " manually");
      process.exit(1);
    }
    items.push({ idx: i, indent: m[1], value: stripVal(m[2]) });
  }
  return items;
}

if (mode === "add") {
  let pIdx = findPlugins();
  if (pIdx === -1) {
    if (lines.length > 0 && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push("plugins:", "  enabled:", "    - " + NAME);
    dirty = true;
  } else {
    const e = findEnabled(pIdx);
    const pIndent = " ".repeat(indentOf(lines[pIdx]));
    if (!e) {
      lines.splice(pIdx + 1, 0, pIndent + "  enabled:", pIndent + "    - " + NAME);
      dirty = true;
    } else {
      const rest = e.rest.replace(/#.*$/, "").trim();
      if (rest === "") {
        const items = listItems(e);
        if (!items.some((it) => it.value === NAME)) {
          const at = items.length > 0 ? items[items.length - 1].idx + 1 : e.idx + 1;
          const ind = items.length > 0 ? items[0].indent : e.indent + "  ";
          lines.splice(at, 0, ind + "- " + NAME);
          dirty = true;
        }
      } else if (rest.startsWith("[")) {
        const inner = rest.replace(/^\[/, "").replace(/\]$/, "");
        const vals = inner.split(",").map(stripVal).filter((v) => v !== "");
        if (!vals.includes(NAME)) {
          vals.push(NAME);
          lines[e.idx] = e.indent + "enabled: [" + vals.join(", ") + "]";
          dirty = true;
        }
      } else {
        console.error("yaml_edit: 'plugins.enabled' is a scalar (" + rest + "); edit " + file + " manually");
        process.exit(1);
      }
    }
  }
} else if (mode === "remove") {
  const pIdx = findPlugins();
  if (pIdx !== -1) {
    const e = findEnabled(pIdx);
    if (e) {
      const rest = e.rest.replace(/#.*$/, "").trim();
      if (rest === "") {
        const items = listItems(e);
        for (let k = items.length - 1; k >= 0; k--) {
          if (items[k].value === NAME) {
            lines.splice(items[k].idx, 1);
            dirty = true;
          }
        }
      } else if (rest.startsWith("[")) {
        const inner = rest.replace(/^\[/, "").replace(/\]$/, "");
        const vals = inner.split(",").map(stripVal).filter((v) => v !== "" && v !== NAME);
        const before = inner.split(",").map(stripVal).filter((v) => v !== "");
        if (before.length !== vals.length) {
          lines[e.idx] = e.indent + "enabled: [" + vals.join(", ") + "]";
          dirty = true;
        }
      }
    }
  }
} else {
  console.error("yaml_edit: unknown mode " + mode);
  process.exit(1);
}

if (dirty) {
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
  console.log("yaml_edit: " + (mode === "add" ? "added" : "removed") + " '" + NAME + "'");
} else {
  console.log("yaml_edit: no change needed (" + mode + " '" + NAME + "')");
}
NODE_EOF
}

do_install() {
  say "Installing ${PLUGIN_NAME} ..."
  say ""

  say "[1/6] checking for node"
  if [ "$DRY_RUN" = "1" ]; then
    say "  [dry-run] would: require 'node' on PATH (build needs it)"
  else
    command -v node >/dev/null 2>&1 || {
      echo "error: node is required but not found on PATH" >&2
      exit 1
    }
    say "  ok: $(command -v node)"
  fi

  say "[2/6] building the plugin bundle"
  if [ "$DRY_RUN" = "1" ]; then
    say "  [dry-run] would: node ${ROOT}/scripts/build-hermes-plugin.js"
  else
    node "${ROOT}/scripts/build-hermes-plugin.js"
  fi

  say "[3/6] backing up ${CONFIG}"
  local backup=""
  if [ -f "$CONFIG" ]; then
    backup="${CONFIG}.uapb-bak-$(date +%Y%m%dT%H%M%S)"
    assert_under "$backup"
    if [ "$DRY_RUN" = "1" ]; then
      say "  [dry-run] would: cp -p ${CONFIG} ${backup}"
    else
      assert_under "$CONFIG"
      cp -p "$CONFIG" "$backup"
      say "  backup: $backup"
    fi
  else
    say "  no config.yaml yet — a minimal one will be created at step 4"
    if [ "$DRY_RUN" = "0" ]; then
      assert_under "$HERMES_HOME"
      mkdir -p "$HERMES_HOME"
    else
      say "  [dry-run] would: mkdir -p ${HERMES_HOME}"
    fi
  fi

  say "[4/6] adding '${PLUGIN_NAME}' to plugins.enabled in ${CONFIG}"
  if [ "$DRY_RUN" = "1" ]; then
    say "  [dry-run] would: YAML-aware idempotent edit (embedded node, never sed)"
    say "  [dry-run] would: create the plugins.enabled key if absent; never duplicate"
  else
    assert_under "$CONFIG"
    yaml_edit add
  fi

  say "[5/6] copying dist/ to ${PLUGIN_DIR}/"
  if [ "$DRY_RUN" = "1" ]; then
    say "  [dry-run] would: mkdir -p ${PLUGIN_DIR}"
    say "  [dry-run] would: cp ${DIST}/plugin.js ${DIST}/plugin.css ${DIST}/manifest.json ${PLUGIN_DIR}/"
  else
    assert_under "$PLUGIN_DIR"
    mkdir -p "$PLUGIN_DIR"
    assert_under "${PLUGIN_DIR}/plugin.js"
    cp "${DIST}/plugin.js" "${DIST}/plugin.css" "${DIST}/manifest.json" "${PLUGIN_DIR}/"
    say "  installed: ${PLUGIN_DIR}/plugin.js"
    say "  installed: ${PLUGIN_DIR}/plugin.css"
    say "  installed: ${PLUGIN_DIR}/manifest.json"
  fi

  say "[6/6] next steps"
  say ""
  say "  1. Teach Hermes to report progress (one-time):"
  say "       mkdir -p ~/.hermes/skills/progress-reporting"
  say "       cp ${ROOT}/examples/hermes/SKILL.md ~/.hermes/skills/progress-reporting/SKILL.md"
  say "     Add the MCP server block from ${ROOT}/examples/hermes/config-snippet.yaml"
  say "     to ~/.hermes/config.yaml, then restart Hermes (or /reload-mcp)."
  say "  2. Start the dashboard and copy the token it prints:"
  say "       agent-progress dashboard"
  say "  3. Open the Hermes web dashboard (hermes --web). At the top of chat"
  say "     the new slot shows a setup row: paste the token (adjust the port"
  say "     if the dashboard used a non-default one) and Save."
  say "  4. Give Hermes a multi-step task and watch the slot."
  say ""
  say "Done."
}

do_uninstall() {
  say "Uninstalling ${PLUGIN_NAME} ..."

  say "[1/3] removing ${PLUGIN_ROOT}"
  if [ "$DRY_RUN" = "1" ]; then
    say "  [dry-run] would: rm -rf ${PLUGIN_ROOT}"
  else
    assert_under "$PLUGIN_ROOT"
    rm -rf "$PLUGIN_ROOT"
    say "  removed"
  fi

  # F2: surgical removal FIRST — never restore a backup over the live config,
  # which would discard user edits made between install and uninstall.
  # A backup restore happens ONLY when the config file is missing entirely
  # (the install-time backup predates our edit, so it contains no plugin
  # entry and needs no further surgery). Backups otherwise remain as the
  # documented manual fallback.
  say "[2/3] removing '${PLUGIN_NAME}' from plugins.enabled (idempotent, surgical)"
  if [ "$DRY_RUN" = "1" ]; then
    say "  [dry-run] would: YAML-aware idempotent removal (embedded node, never sed)"
    say "  [dry-run] would: if ${CONFIG} were missing, restore it from the newest backup"
  else
    if [ -f "$CONFIG" ]; then
      command -v node >/dev/null 2>&1 || {
        echo "error: node is required but not found on PATH" >&2
        exit 1
      }
      assert_under "$CONFIG"
      yaml_edit remove
    else
      # shellcheck disable=SC2012
      local newest_backup=""
      newest_backup="$(ls -t "${CONFIG}".uapb-bak-* 2>/dev/null | head -n 1 || true)"
      if [ -n "$newest_backup" ]; then
        assert_under "$CONFIG"
        cp -p "$newest_backup" "$CONFIG"
        say "  ${CONFIG} was missing; restored from $newest_backup"
      else
        say "  no ${CONFIG} and no uapb backup found; nothing to edit"
      fi
    fi
  fi

  say ""
  say "Done. (Backups are kept at ${CONFIG}.uapb-bak-*; delete them manually if wanted.)"
}

if [ "$UNINSTALL" = "1" ]; then
  do_uninstall
else
  do_install
fi
