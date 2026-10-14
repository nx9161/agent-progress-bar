/* SPDX-License-Identifier: MIT */
/* UAPB core: timeline math, easing, countdown formatting, stage presets.
 * Zero DOM. No import/export — everything lives under window.UAPB. */
(function (global) {
  "use strict";

  /** Locked stage labels for the concept demo timeline. */
  var STAGES = [
    "Reading context",
    "Searching memory",
    "Reasoning",
    "Drafting reply",
    "Done",
  ];

  /** Time weights of the first four stages (sum = 1). "Done" snaps to 100. */
  var WEIGHTS = [0.18, 0.22, 0.38, 0.17];

  /** Fraction of each stage slice spent moving (eased) vs dwelling (flat). */
  var MOVE_FRACTION = 0.7;

  function easeInOutCubic(t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function clampPercent(p) {
    if (typeof p !== "number" || isNaN(p)) return 0;
    return Math.min(100, Math.max(0, p));
  }

  /**
   * Format a millisecond countdown as m:ss, rounding UP so the display
   * hits exactly 0:00 at termination (Math.ceil(remainingMs/1000)).
   */
  function formatCountdown(ms) {
    var totalSeconds = Math.ceil(Math.max(0, ms) / 1000);
    var m = Math.floor(totalSeconds / 60);
    var s = totalSeconds % 60;
    return m + ":" + (s < 10 ? "0" + s : s);
  }

  /**
   * Build a keyframed timeline for totalMs.
   * Each stage: an eased move segment (70%) + a flat dwell segment (30%)
   * at the stage boundary. opts.linear disables easing (reduced motion).
   * Returns { totalMs, segments: [{t0,t1,p0,p1,eased,stage}] }.
   */
  function createTimeline(totalMs, opts) {
    var linear = !!(opts && opts.linear);
    var segments = [];
    var t = 0;
    var ends = [];
    var acc = 0;
    for (var i = 0; i < WEIGHTS.length; i++) {
      acc += WEIGHTS[i] * 100;
      ends.push(i === WEIGHTS.length - 1 ? 97 : acc);
    }
    var p = 0;
    for (var s = 0; s < WEIGHTS.length; s++) {
      var sliceMs = totalMs * WEIGHTS[s];
      var moveMs = sliceMs * MOVE_FRACTION;
      var p1 = ends[s];
      segments.push({
        t0: t,
        t1: t + moveMs,
        p0: p,
        p1: p1,
        eased: !linear,
        stage: STAGES[s],
      });
      segments.push({
        t0: t + moveMs,
        t1: t + sliceMs,
        p0: p1,
        p1: p1,
        eased: false,
        stage: STAGES[s],
      });
      t += sliceMs;
      p = p1;
    }
    return { totalMs: totalMs, segments: segments };
  }

  /**
   * Sample the timeline at elapsedMs.
   * Returns { percent, stage, done }. done=true exactly at/after totalMs.
   */
  function sampleTimeline(timeline, elapsedMs) {
    var segs = timeline.segments;
    if (elapsedMs >= timeline.totalMs) {
      return { percent: 100, stage: "Done", done: true };
    }
    if (elapsedMs <= 0 || segs.length === 0) {
      return { percent: 0, stage: STAGES[0], done: false };
    }
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (elapsedMs <= s.t1 || i === segs.length - 1) {
        var p = s.p0;
        if (s.eased && s.t1 > s.t0) {
          var k = (elapsedMs - s.t0) / (s.t1 - s.t0);
          k = Math.min(1, Math.max(0, k));
          p = s.p0 + (s.p1 - s.p0) * easeInOutCubic(k);
        }
        return { percent: clampPercent(p), stage: s.stage, done: false };
      }
    }
    return { percent: 100, stage: "Done", done: true };
  }

  global.UAPB = {
    STAGES: STAGES,
    WEIGHTS: WEIGHTS,
    MOVE_FRACTION: MOVE_FRACTION,
    easeInOutCubic: easeInOutCubic,
    clampPercent: clampPercent,
    formatCountdown: formatCountdown,
    createTimeline: createTimeline,
    sampleTimeline: sampleTimeline,
  };

  /* v1 seam — ProgressSource adapter interface (documented, not implemented).
   * A ProgressSource is { start(sink), stop() } where sink is
   * { setProgress({ percent, etaSeconds, stage }), finish() }.
   * Adapters: demo (simulated, disposable), callback, sse.
   * The demo feed (packages/web/demo.js) is one adapter: it is DELETED,
   * not refactored, in v1. */
})(typeof window !== "undefined" ? window : this);
