// SPDX-License-Identifier: MIT
// Deterministic build for the uapb-hermes-plugin package.
//
// Reads:
//   packages/hermes-plugin/src/plugin.js      (slot component, two markers)
//   packages/hermes-plugin/src/plugin.css     (slot styles, incl. mascot)
//   packages/hermes-plugin/manifest.json     (source manifest, integrity placeholder)
//   packages/widget/src/uapb-core.js         (inlined)
//   packages/widget/src/uapb-widget.js        (inlined)
// Writes (byte-identical across runs — no timestamps, no random ids):
//   packages/hermes-plugin/dist/plugin.js     (single self-contained bundle)
//   packages/hermes-plugin/dist/plugin.css    (identical copy of src, for reference)
//   packages/hermes-plugin/dist/manifest.json (source manifest + real sha384 SRI)
// Self-verification: rebuilds everything in memory and byte-compares
// against the written files; any mismatch throws (non-zero exit).
// Usage: node scripts/build-hermes-plugin.js
// No network, no npm packages — only node:fs, node:path, node:crypto.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "..");
const PLUGIN = path.join(ROOT, "packages", "hermes-plugin");
const SRC = path.join(PLUGIN, "src");
const DIST = path.join(PLUGIN, "dist");
const WIDGET_SRC = path.join(ROOT, "packages", "widget", "src");

const WIDGET_MARKER = "/*UAPB:WIDGET-JS*/";
// The CSS placeholder is a complete quoted string in src/plugin.js so the
// source parses standalone; the build swaps the whole literal.
const CSS_PLACEHOLDER = '"/*UAPB:PLUGIN-CSS*/"';

function read(p) {
  return fs.readFileSync(p, "utf8");
}

function sha384Base64(bytes) {
  return crypto.createHash("sha384").update(bytes, "utf8").digest("base64");
}

/** Build all three dist artifacts in memory; returns { "plugin.js", "plugin.css", "manifest.json" }. */
function buildAll() {
  const srcJs = read(path.join(SRC, "plugin.js"));
  const slotCss = read(path.join(SRC, "plugin.css"));
  const core = read(path.join(WIDGET_SRC, "uapb-core.js"));
  const widget = read(path.join(WIDGET_SRC, "uapb-widget.js"));

  if (srcJs.indexOf(WIDGET_MARKER) === -1) {
    throw new Error("build failed: widget marker not found in src/plugin.js");
  }
  if (srcJs.indexOf(CSS_PLACEHOLDER) === -1) {
    throw new Error("build failed: CSS placeholder not found in src/plugin.js");
  }

  // Concatenation order matters: core (window.UAPB) -> widget (custom
  // element). Fixed separator so a missing trailing semicolon can never
  // fuse two scripts.
  const widgetJs = [core, widget].join("\n;\n");

  // The CSS becomes a JS string literal via JSON encoding — exact bytes,
  // no escaping ambiguity. A JSON string literal is valid JS.
  const cssLiteral = JSON.stringify(slotCss);

  const bundleJs = srcJs
    .split(WIDGET_MARKER)
    .join(widgetJs)
    .split(CSS_PLACEHOLDER)
    .join(cssLiteral);

  if (
    bundleJs.indexOf(WIDGET_MARKER) !== -1 ||
    bundleJs.indexOf(CSS_PLACEHOLDER) !== -1
  ) {
    throw new Error("build failed: marker survived replacement");
  }

  const integrity = "sha384-" + sha384Base64(bundleJs);

  const manifest = JSON.parse(read(path.join(PLUGIN, "manifest.json")));
  if (manifest.name !== "uapb-hermes-plugin") {
    throw new Error("build failed: manifest name must be uapb-hermes-plugin");
  }
  manifest.integrity = integrity;
  // Stable key order for byte-determinism.
  const ordered = {};
  for (const k of ["name", "version", "description", "entry", "slot", "integrity"]) {
    ordered[k] = manifest[k];
  }
  const manifestJson = JSON.stringify(ordered);

  return {
    "plugin.js": bundleJs,
    "plugin.css": slotCss,
    "manifest.json": manifestJson,
  };
}

function main() {
  const built = buildAll();

  fs.mkdirSync(DIST, { recursive: true });
  for (const name of Object.keys(built)) {
    fs.writeFileSync(path.join(DIST, name), built[name], "utf8");
  }

  // Self-verification: rebuild in memory, byte-compare with disk.
  const rebuilt = buildAll();
  for (const name of Object.keys(built)) {
    const onDisk = read(path.join(DIST, name));
    if (onDisk !== rebuilt[name]) {
      throw new Error("self-verification failed: dist/" + name + " mismatch on rebuild");
    }
  }

  // SRI cross-check: the integrity in dist/manifest.json must equal the
  // sha384 of the exact dist/plugin.js bytes.
  const manifestOnDisk = JSON.parse(read(path.join(DIST, "manifest.json")));
  const pluginBytes = read(path.join(DIST, "plugin.js"));
  const expected = "sha384-" + sha384Base64(pluginBytes);
  if (manifestOnDisk.integrity !== expected) {
    throw new Error("self-verification failed: manifest integrity does not match dist/plugin.js");
  }

  console.log("built packages/hermes-plugin/dist/:");
  for (const name of Object.keys(built)) {
    console.log("  " + name + " (" + Buffer.byteLength(built[name], "utf8") + " bytes)");
  }
  console.log("integrity " + expected);
  console.log("self-verification passed: rebuild byte-identical, SRI matches bundle");
}

main();
