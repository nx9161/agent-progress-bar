/* SPDX-License-Identifier: MIT */
/* <uapb-progress> custom element — the canonical embeddable widget.
 * Timer-free by design: the host pushes state via attributes or
 * setProgress(); the element only renders. Shadow DOM. textContent only.
 * Status-aware: started | running | paused | error | done.
 * Psylocke art direction: monochrome dark instrument panel — solid fill,
 * sans body / mono numerals split, no gradients. */
(function () {
  "use strict";

  var CSS = [
    ":host{display:block;color-scheme:dark;font-family:var(--uapb-font,-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,sans-serif);color:var(--uapb-text,#E9EEF5);}",
    ".uapb{width:100%;}",
    ".uapb.is-paused{filter:grayscale(1);}",
    ".uapb-row{display:flex;align-items:center;gap:12px;}",
    ".uapb-track{flex:1;min-width:0;height:10px;position:relative;background:var(--uapb-track,#232C3A);",
    "border:1px solid var(--uapb-border,#26303D);border-radius:var(--uapb-radius,8px);overflow:hidden;}",
    ".uapb-fill{height:100%;width:100%;transform-origin:left center;transform:scaleX(0);",
    "background:var(--uapb-fill,#E9EEF5);border-radius:inherit;}",
    ".uapb-fill.is-done{background:var(--uapb-done,#34D399);}",
    ".uapb-sheen{position:absolute;inset:0;transform:translateX(-100%);pointer-events:none;display:none;",
    "background:linear-gradient(90deg,transparent,rgba(255,255,255,0.15),transparent);}",
    ".uapb-track.is-estimating .uapb-sheen{display:block;animation:uapb-sheen-sweep 2.4s linear infinite;}",
    "@keyframes uapb-sheen-sweep{to{transform:translateX(100%);}}",
    ".uapb-pct,.uapb-eta{font-family:var(--uapb-mono,ui-monospace,SFMono-Regular,Menlo,monospace);}",
    ".uapb-pct{font-variant-numeric:tabular-nums;font-weight:600;min-width:3.5ch;text-align:right;}",
    ".uapb-meta{display:flex;justify-content:space-between;gap:12px;margin-top:8px;",
    "font-size:0.85em;color:var(--uapb-muted,#93A0B4);}",
    ".uapb-stage{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    ".uapb.is-error .uapb-stage{color:var(--uapb-error,#F87171);}",
    ".uapb-eta{font-variant-numeric:tabular-nums;white-space:nowrap;}",
    ":host([compact]) .uapb-track{height:8px;}",
    ":host([compact]) .uapb-meta{display:none;}",
    "@media (prefers-reduced-motion:reduce){.uapb-fill{transition:none !important;}",
    ".uapb-sheen{display:none !important;animation:none !important;}}",
  ].join("\n");

  var STATUSES = ["started", "running", "paused", "error", "done"];
  var DEFAULT_LABEL = "Agent progress";

  function toNumber(v, fallback) {
    var n = Number(v);
    return typeof n === "number" && !isNaN(n) ? n : fallback;
  }

  function clamp01(x) {
    return Math.min(1, Math.max(0, x));
  }

  function validStatus(s) {
    return STATUSES.indexOf(s) !== -1 ? s : "running";
  }

  function isFiniteNumber(v) {
    return typeof v === "number" && Number.isFinite(v);
  }

  class UAPBProgress extends HTMLElement {
    static get observedAttributes() {
      return ["percent", "eta", "stage", "status", "label", "compact"];
    }

    constructor() {
      super();
      this._completed = false;
      this._lastWhole = -1;
      this._percent = 0;
      this._etaSeconds = null;
      this._stage = "";
      this._status = "running";
      this._message = "";
      this._label = null;
      var shadow = this.attachShadow({ mode: "open" });

      var style = document.createElement("style");
      style.textContent = CSS;
      shadow.appendChild(style);

      var root = document.createElement("div");
      root.setAttribute("class", "uapb");

      var row = document.createElement("div");
      row.setAttribute("class", "uapb-row");

      var track = document.createElement("div");
      track.setAttribute("class", "uapb-track");
      track.setAttribute("role", "progressbar");
      track.setAttribute("aria-valuemin", "0");
      track.setAttribute("aria-valuemax", "100");
      track.setAttribute("aria-valuenow", "0");
      track.setAttribute("aria-label", DEFAULT_LABEL);

      var fill = document.createElement("div");
      fill.setAttribute("class", "uapb-fill");
      track.appendChild(fill);

      var sheen = document.createElement("div");
      sheen.setAttribute("class", "uapb-sheen");
      sheen.setAttribute("aria-hidden", "true");
      track.appendChild(sheen);

      var pct = document.createElement("span");
      pct.setAttribute("class", "uapb-pct");
      pct.textContent = "0%";

      row.appendChild(track);
      row.appendChild(pct);

      var meta = document.createElement("div");
      meta.setAttribute("class", "uapb-meta");

      var stage = document.createElement("span");
      stage.setAttribute("class", "uapb-stage");
      stage.setAttribute("aria-live", "polite");

      var eta = document.createElement("span");
      eta.setAttribute("class", "uapb-eta");
      eta.setAttribute("aria-hidden", "true");

      meta.appendChild(stage);
      meta.appendChild(eta);

      root.appendChild(row);
      root.appendChild(meta);
      shadow.appendChild(root);

      this._root = root;
      this._els = { track: track, fill: fill, pct: pct, stage: stage, eta: eta };
      this._render();
    }

    attributeChangedCallback(name, _oldVal, _newVal) {
      this._render();
    }

    /**
     * Push new state. Timer-free: call whenever the source has an update.
     * setProgress({percent, etaSeconds, stage, status, message, durationMs})
     *   status: "started" | "running" | "paused" | "error" | "done"
     *           (default "running"; invalid values fall back silently).
     *   message: short note (<=280 chars) shown as the stage in error state.
     *   durationMs: run duration, carried on the uapb-complete event detail.
     * Fires a bubbling, composed `uapb-complete` event exactly once per
     * run when percent reaches 100, with detail {durationMs} when the
     * duration is a finite number, otherwise detail {}.
     */
    setProgress(opts) {
      var o = opts || {};
      var p = clamp01(toNumber(o.percent, 0) / 100);
      var eta = o.etaSeconds === null || o.etaSeconds === undefined ? null : toNumber(o.etaSeconds, null);
      var stage = typeof o.stage === "string" ? o.stage : "";
      var status = validStatus(o.status);
      var message = typeof o.message === "string" ? o.message.slice(0, 280) : "";
      var durationMs = isFiniteNumber(o.durationMs) ? o.durationMs : null;
      var changed = false;
      if (p !== this._percent) {
        this._percent = p;
        changed = true;
      }
      if (eta !== this._etaSeconds) {
        this._etaSeconds = eta;
        changed = true;
      }
      if (stage !== this._stage) {
        this._stage = stage;
        changed = true;
      }
      if (status !== this._status) {
        this._status = status;
        changed = true;
      }
      if (message !== this._message) {
        this._message = message;
        changed = true;
      }
      if (changed) this._render();
      if (p >= 1 && !this._completed) {
        this._completed = true;
        this.dispatchEvent(
          new CustomEvent("uapb-complete", {
            bubbles: true,
            composed: true,
            detail: durationMs === null ? {} : { durationMs: durationMs },
          })
        );
      }
      if (p < 1) this._completed = false;
      return this;
    }

    _syncFromAttributes() {
      // Attribute values are percent-scale (0-100); this._percent is the
      // fractional mirror used by setProgress. The fallback keeps the
      // fraction as-is so programmatic updates survive re-render.
      var p = this.hasAttribute("percent")
        ? toNumber(this.getAttribute("percent"), 0) / 100
        : typeof this._percent === "number"
          ? this._percent
          : 0;
      var eta = this.hasAttribute("eta") ? toNumber(this.getAttribute("eta"), null) : this._etaSeconds;
      var stage = this.hasAttribute("stage") ? String(this.getAttribute("stage")) : this._stage || "";
      var status = this.hasAttribute("status") ? validStatus(this.getAttribute("status")) : this._status || "running";
      var label = this.hasAttribute("label") ? String(this.getAttribute("label")) : this._label;
      this._percent = clamp01(p);
      this._etaSeconds = eta === null || eta === undefined || isNaN(eta) ? null : eta;
      this._stage = stage;
      this._status = status;
      this._label = label;
    }

    _render() {
      this._syncFromAttributes();
      var status = this._status || "running";
      var whole = Math.round(this._percent * 100);
      var els = this._els;

      // Status classes on the root: paused goes grayscale, error recolors.
      this._root.classList.toggle("is-paused", status === "paused");
      this._root.classList.toggle("is-error", status === "error");

      // Estimating = no ETA while still active. Honesty rule: show
      // "estimating…", never an invented number. Sheen sweeps the track.
      var estimating =
        (this._etaSeconds === null || this._etaSeconds === undefined) &&
        (status === "running" || status === "started");
      els.track.classList.toggle("is-estimating", estimating);

      // Bar moves via transform only (compositor-friendly).
      els.fill.style.transform = "scaleX(" + this._percent.toFixed(4) + ")";
      if (whole >= 100) {
        els.fill.classList.add("is-done");
      } else {
        els.fill.classList.remove("is-done");
      }
      // Text nodes update only on change.
      if (whole !== this._lastWhole) {
        this._lastWhole = whole;
        els.pct.textContent = whole + "%";
        els.track.setAttribute("aria-valuenow", String(whole));
      }

      // Stage text per status: paused prefixes, error shows the message.
      var rawStage = this._stage || "";
      var stageText;
      if (status === "paused") {
        stageText = rawStage ? "Paused — " + rawStage : "Paused";
      } else if (status === "error") {
        stageText = this._message || "Something went wrong";
      } else {
        stageText = rawStage;
      }
      if (els.stage.textContent !== stageText) {
        els.stage.textContent = stageText;
      }
      els.stage.setAttribute("title", stageText);
      if (status === "error") {
        els.stage.setAttribute("role", "alert");
      } else {
        els.stage.removeAttribute("role");
      }

      // ETA caption: "paused" / "estimating…" / countdown / blank.
      var etaText;
      if (status === "paused") {
        etaText = "paused";
      } else if (estimating) {
        etaText = "estimating…";
      } else if (this._etaSeconds === null || this._etaSeconds === undefined) {
        etaText = "";
      } else {
        etaText = window.UAPB
          ? window.UAPB.formatCountdown(this._etaSeconds * 1000)
          : String(this._etaSeconds);
      }
      if (els.eta.textContent !== etaText) {
        els.eta.textContent = etaText;
      }

      // Accessible label for the progressbar role.
      var label = this._label || DEFAULT_LABEL;
      if (els.track.getAttribute("aria-label") !== label) {
        els.track.setAttribute("aria-label", label);
      }
    }
  }

  if (!customElements.get("uapb-progress")) {
    customElements.define("uapb-progress", UAPBProgress);
  }
})();
