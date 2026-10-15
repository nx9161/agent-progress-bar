// SPDX-License-Identifier: MIT
// Zero-dependency Node build: concatenates + inlines the demo page's
// CSS/JS into dist/index.html and injects a <meta> CSP whose script-src
// and style-src hashes are computed over the EXACT bytes being inlined.
// After writing, the script re-reads dist/index.html and re-hashes the
// actual inlined text — any mismatch throws (non-zero exit).
// Usage: node scripts/build-demo.js
// No network, no npm packages — only node:fs, node:path, node:crypto.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "..");
const WEB = path.join(ROOT, "packages", "web");
const WIDGET_SRC = path.join(ROOT, "packages", "widget", "src");
const DIST = path.join(ROOT, "dist");

function read(p) {
  return fs.readFileSync(p, "utf8");
}

function sha256Base64(bytes) {
  return crypto.createHash("sha256").update(bytes, "utf8").digest("base64");
}

function main() {
  const htmlPath = path.join(WEB, "index.html");
  let html = read(htmlPath);

  const css = read(path.join(WEB, "styles.css"));
  const core = read(path.join(WIDGET_SRC, "uapb-core.js"));
  const widget = read(path.join(WIDGET_SRC, "uapb-widget.js"));
  const demo = read(path.join(WEB, "demo.js"));

  // Concatenation order matters: core (window.UAPB) -> widget (custom
  // element) -> demo (driver). Separated so a missing trailing semicolon
  // can never fuse two scripts.
  const js = [core, widget, demo].join("\n;\n");

  // F1: hash the EXACT bytes that get inlined (newline-wrapped), because
  // the CSP hash must cover the delivered <style>/<script> text verbatim.
  const cssInlined = "\n" + css + "\n";
  const jsInlined = "\n" + js + "\n";

  const cssHash = sha256Base64(cssInlined);
  const jsHash = sha256Base64(jsInlined);

  const csp =
    "<meta http-equiv=\"Content-Security-Policy\" content=\"" +
    "default-src 'none'; " +
    "script-src 'sha256-" + jsHash + "'; " +
    "style-src 'sha256-" + cssHash + "'; " +
    "object-src 'none'; " +
    "base-uri 'self'; " +
    "frame-ancestors 'none'\">";

  html = html.replace("<!--UAPB:HEAD-EXTRAS-->", csp);
  html = html.replace(
    "<!--UAPB:STYLES-->",
    "<style>" + cssInlined + "</style>"
  );
  html = html.replace(
    "<!--UAPB:SCRIPTS-->",
    "<script>" + jsInlined + "</script>"
  );

  for (const marker of ["UAPB:HEAD-EXTRAS", "UAPB:STYLES", "UAPB:SCRIPTS"]) {
    if (html.indexOf(marker) !== -1) {
      throw new Error("build failed: marker not replaced: " + marker);
    }
  }

  fs.mkdirSync(DIST, { recursive: true });
  const outPath = path.join(DIST, "index.html");
  fs.writeFileSync(outPath, html, "utf8");

  // Self-verification (F1): re-read the written file, extract the CSP
  // meta's sha256 values and the actual <style>/<script> text via regex,
  // re-hash, and throw (non-zero exit) on any mismatch.
  const written = read(outPath);
  const cspMatch = written.match(
    /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/
  );
  if (!cspMatch) {
    throw new Error("self-verification failed: CSP meta not found");
  }
  const scriptHashMatch = cspMatch[1].match(/script-src 'sha256-([^']+)'/);
  const styleHashMatch = cspMatch[1].match(/style-src 'sha256-([^']+)'/);
  if (!scriptHashMatch || !styleHashMatch) {
    throw new Error("self-verification failed: CSP hashes not found");
  }
  const styleTextMatch = written.match(/<style>([\s\S]*)<\/style>/);
  const scriptTextMatch = written.match(/<script>([\s\S]*)<\/script>/);
  if (!styleTextMatch || !scriptTextMatch) {
    throw new Error("self-verification failed: inlined style/script not found");
  }
  if (sha256Base64(styleTextMatch[1]) !== styleHashMatch[1]) {
    throw new Error("self-verification failed: style-src hash mismatch");
  }
  if (sha256Base64(scriptTextMatch[1]) !== scriptHashMatch[1]) {
    throw new Error("self-verification failed: script-src hash mismatch");
  }

  console.log("built " + outPath + " (" + Buffer.byteLength(html, "utf8") + " bytes)");
  console.log("csp script-src sha256-" + jsHash);
  console.log("csp style-src  sha256-" + cssHash);
  console.log("self-verification passed: CSP hashes match inlined bytes");
}

main();
