/* SPDX-License-Identifier: MIT */
/* Concept demo driver: mock chat shell + SimulatedSource (rAF).
 * DISPOSABLE in v1 — the demo feed is one ProgressSource adapter,
 * deleted (not refactored) when live sources land. No AI is connected;
 * every value here is scripted to demonstrate the proposed UX. */
(function () {
  "use strict";

  var DEFAULT_DURATION_S = 45;
  var ALLOWED_DURATIONS = { 15: true, 30: true, 45: true, 60: true };
  var MILESTONES = [25, 50, 75, 100];

  var bar = document.getElementById("demoBar");
  var restartBtn = document.getElementById("restartBtn");
  var compactBtn = document.getElementById("compactBtn");
  var srStatus = document.getElementById("srStatus");
  var presetBtns = Array.prototype.slice.call(
    document.querySelectorAll(".preset")
  );

  var reducedMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function readParams() {
    // Allowlisted-or-absent: only known keys with known values take effect.
    var out = { durationS: DEFAULT_DURATION_S, compact: false };
    try {
      var q = new URLSearchParams(window.location.search);
      var d = q.get("duration");
      if (d !== null && ALLOWED_DURATIONS[d]) out.durationS = Number(d);
      var c = q.get("compact");
      if (c === "1") out.compact = true;
    } catch (e) {
      /* URLSearchParams unavailable — fall back to defaults */
    }
    return out;
  }

  var params = readParams();
  var durationMs = params.durationS * 1000;

  /**
   * SimulatedSource — one clock (performance.now()), rAF-driven.
   * Samples a keyframed timeline; ends exactly 100% / 0:00 / "Done".
   */
  function SimulatedSource(el, totalMs, linear) {
    this.el = el;
    this.totalMs = totalMs;
    this.timeline = window.UAPB.createTimeline(totalMs, { linear: linear });
    this.rafId = 0;
    this.startStamp = 0;
    this.pausedTotal = 0;
    this.pauseStart = 0;
    this.announced = {};
    this.running = false;
    var self = this;
    this.onVisibility = function () {
      if (document.hidden) {
        if (self.running && self.pauseStart === 0) {
          self.pauseStart = performance.now();
        }
      } else if (self.pauseStart !== 0) {
        self.pausedTotal += performance.now() - self.pauseStart;
        self.pauseStart = 0;
      }
    };
  }

  SimulatedSource.prototype.start = function () {
    this.stop();
    this.startStamp = performance.now();
    this.pausedTotal = 0;
    this.pauseStart = 0;
    this.announced = {};
    this.running = true;
    document.addEventListener("visibilitychange", this.onVisibility);
    this.el.setProgress({ percent: 0, etaSeconds: this.totalMs / 1000, stage: window.UAPB.STAGES[0] });
    this.tick();
  };

  SimulatedSource.prototype.stop = function () {
    this.running = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    document.removeEventListener("visibilitychange", this.onVisibility);
  };

  SimulatedSource.prototype.finish = function () {
    // Termination clamps: exactly 100% / 0:00 / "Done".
    this.el.setProgress({ percent: 100, etaSeconds: 0, stage: "Done" });
    this.announce(100);
    this.stop();
  };

  SimulatedSource.prototype.announce = function (pct) {
    if (this.announced[pct]) return;
    this.announced[pct] = true;
    srStatus.textContent =
      pct >= 100 ? "Progress complete." : "Progress " + pct + " percent.";
  };

  SimulatedSource.prototype.tick = function () {
    if (!this.running) return;
    var self = this;
    this.rafId = requestAnimationFrame(function () {
      self.frame();
    });
  };

  SimulatedSource.prototype.frame = function () {
    if (!this.running) return;
    var now = performance.now();
    var elapsed = now - this.startStamp - this.pausedTotal;
    if (elapsed >= this.totalMs) {
      this.finish();
      return;
    }
    var sample = window.UAPB.sampleTimeline(this.timeline, Math.max(0, elapsed));
    var remainingMs = Math.max(0, this.totalMs - elapsed);
    // Math.ceil(remainingMs/1000) inside formatCountdown hits 0:00 exactly.
    this.el.setProgress({
      percent: sample.percent,
      etaSeconds: remainingMs / 1000,
      stage: sample.stage,
    });
    var whole = Math.round(sample.percent);
    for (var i = 0; i < MILESTONES.length; i++) {
      if (whole >= MILESTONES[i]) this.announce(MILESTONES[i]);
    }
    this.tick();
  };

  var source = new SimulatedSource(bar, durationMs, reducedMotion);

  function setDuration(seconds) {
    durationMs = seconds * 1000;
    source.totalMs = durationMs;
    source.timeline = window.UAPB.createTimeline(durationMs, { linear: reducedMotion });
    presetBtns.forEach(function (b) {
      var active = Number(b.getAttribute("data-duration")) === seconds;
      b.setAttribute("aria-pressed", active ? "true" : "false");
    });
    source.start();
  }

  function setCompact(on) {
    if (on) {
      bar.setAttribute("compact", "");
    } else {
      bar.removeAttribute("compact");
    }
    compactBtn.setAttribute("aria-pressed", on ? "true" : "false");
  }

  restartBtn.addEventListener("click", function () {
    source.start();
  });

  presetBtns.forEach(function (b) {
    b.addEventListener("click", function () {
      setDuration(Number(b.getAttribute("data-duration")));
    });
  });

  compactBtn.addEventListener("click", function () {
    setCompact(compactBtn.getAttribute("aria-pressed") !== "true");
  });

  // Init from allowlisted URL params, then auto-start.
  presetBtns.forEach(function (b) {
    var active = Number(b.getAttribute("data-duration")) === params.durationS;
    b.setAttribute("aria-pressed", active ? "true" : "false");
  });
  setCompact(params.compact);
  source.start();
})();
