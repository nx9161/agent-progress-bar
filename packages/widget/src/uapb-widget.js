/* SPDX-License-Identifier: MIT */
/* <uapb-progress> custom element — the canonical embeddable widget.
 * Timer-free by design: the host pushes state via attributes or
 * setProgress(); the element only renders. Shadow DOM. textContent only. */
(function () {
  "use strict";

  var CSS = [
    ":host{display:block;font-family:var(--uapb-font,inherit);color:var(--uapb-text,#E9EEF5);}",
    ".uapb{width:100%;}",
    ".uapb-row{display:flex;align-items:center;gap:12px;}",
    ".uapb-track{flex:1;min-width:0;height:10px;background:var(--uapb-track,#232C3A);",
    "border:1px solid var(--uapb-border,#26303D);border-radius:var(--uapb-radius,8px);overflow:hidden;}",
    ".uapb-fill{height:100%;width:100%;transform-origin:left center;transform:scaleX(0);",
    "background:var(--uapb-fill,linear-gradient(90deg,#7C6CFF,#38E1C6));border-radius:inherit;}",
    ".uapb-fill.is-done{background:var(--uapb-done,#34D399);}",
    ".uapb-pct{font-variant-numeric:tabular-nums;font-weight:600;min-width:3.5ch;text-align:right;}",
    ".uapb-meta{display:flex;justify-content:space-between;gap:12px;margin-top:8px;",
    "font-size:0.85em;color:var(--uapb-muted,#93A0B4);}",
    ".uapb-stage{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    ".uapb-eta{font-variant-numeric:tabular-nums;white-space:nowrap;}",
    ":host([compact]) .uapb-track{height:56px;}",
    ":host([compact]) .uapb-meta{display:none;}",
    "@media (prefers-reduced-motion:reduce){.uapb-fill{transition:none !important;}}",
  ].join("\n");

  function toNumber(v, fallback) {
    var n = Number(v);
    return typeof n === "number" && !isNaN(n) ? n : fallback;
  }

  function clamp01(x) {
    return Math.min(1, Math.max(0, x));
  }

  class UAPBProgress extends HTMLElement {
    static get observedAttributes() {
      return ["percent", "eta", "stage", "compact"];
    }

    constructor() {
      super();
      this._completed = false;
      this._lastWhole = -1;
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
      track.setAttribute("aria-label", "Progress");

      var fill = document.createElement("div");
      fill.setAttribute("class", "uapb-fill");
      track.appendChild(fill);

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

      this._els = { track: track, fill: fill, pct: pct, stage: stage, eta: eta };
      this._render();
    }

    attributeChangedCallback(name, _oldVal, _newVal) {
      if (name === "compact") {
        this._render();
        return;
      }
      this._render();
    }

    /**
     * Push new state. Timer-free: call whenever the source has an update.
     * Fires a bubbling, composed `uapb-complete` event exactly once per
     * run when percent reaches 100.
     */
    setProgress(opts) {
      var o = opts || {};
      var p = clamp01(toNumber(o.percent, 0) / 100);
      var changed = false;
      if (p !== this._percent) {
        this._percent = p;
        changed = true;
      }
      var eta = o.etaSeconds === null || o.etaSeconds === undefined ? null : toNumber(o.etaSeconds, null);
      if (eta !== this._etaSeconds) {
        this._etaSeconds = eta;
        changed = true;
      }
      var stage = typeof o.stage === "string" ? o.stage : "";
      if (stage !== this._stage) {
        this._stage = stage;
        changed = true;
      }
      if (changed) this._render();
      if (p >= 1 && !this._completed) {
        this._completed = true;
        this.dispatchEvent(new CustomEvent("uapb-complete", { bubbles: true, composed: true }));
      }
      if (p < 1) this._completed = false;
      return this;
    }

    _syncFromAttributes() {
      var p = this.hasAttribute("percent") ? toNumber(this.getAttribute("percent"), 0) : this._percent || 0;
      var eta = this.hasAttribute("eta") ? toNumber(this.getAttribute("eta"), null) : this._etaSeconds;
      var stage = this.hasAttribute("stage") ? String(this.getAttribute("stage")) : this._stage || "";
      this._percent = clamp01(p / 100);
      this._etaSeconds = eta === null || eta === undefined || isNaN(eta) ? null : eta;
      this._stage = stage;
    }

    _render() {
      this._syncFromAttributes();
      var whole = Math.round(this._percent * 100);
      var els = this._els;
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
      var stageText = this._stage || "";
      if (els.stage.textContent !== stageText) {
        els.stage.textContent = stageText;
      }
      var etaText =
        this._etaSeconds === null || this._etaSeconds === undefined
          ? ""
          : window.UAPB
            ? window.UAPB.formatCountdown(this._etaSeconds * 1000)
            : String(this._etaSeconds);
      if (els.eta.textContent !== etaText) {
        els.eta.textContent = etaText;
      }
    }
  }

  if (!customElements.get("uapb-progress")) {
    customElements.define("uapb-progress", UAPBProgress);
  }
})();
