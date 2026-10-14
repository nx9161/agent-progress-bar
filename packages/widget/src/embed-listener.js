/* SPDX-License-Identifier: MIT */
/* postMessage / query-param wrapper for the iframe widget build.
 * Security: explicit origin allowlist, DEFAULT DENY. With no allowlist
 * configured the listener neither sends nor processes anything.
 * Every message validates event.origin + event.source + message schema.
 * Never uses '*' as a target origin. */
(function (global) {
  "use strict";

  var PROTOCOL = "uapb-progress";
  var VERSION = 1;
  var ORIGIN_RE = /^https:\/\/[a-z0-9.-]+(?::\d+)?$/i;

  function isAllowedOrigin(origin, allowlist) {
    return allowlist.indexOf(origin) !== -1;
  }

  function validMessage(data) {
    return (
      data !== null &&
      typeof data === "object" &&
      data.type === PROTOCOL &&
      data.version === VERSION &&
      data.payload !== null &&
      typeof data.payload === "object"
    );
  }

  function coercePayload(payload) {
    var out = {};
    if (typeof payload.percent === "number" && !isNaN(payload.percent)) {
      out.percent = payload.percent;
    }
    if (
      payload.etaSeconds === null ||
      (typeof payload.etaSeconds === "number" && !isNaN(payload.etaSeconds))
    ) {
      out.etaSeconds = payload.etaSeconds;
    }
    if (typeof payload.stage === "string") {
      out.stage = payload.stage.slice(0, 120);
    }
    return out;
  }

  /**
   * Attach a postMessage listener driving `opts.element` (a <uapb-progress>).
   * opts: { element, allowedOrigins: string[], expectedSource?: WindowProxy }
   * Returns { destroy() }.
   */
  function createListener(opts) {
    var el = opts.element;
    var allowlist = Array.isArray(opts.allowedOrigins) ? opts.allowedOrigins.slice() : [];
    var expectedSource = opts.expectedSource || null;

    function onMessage(event) {
      if (allowlist.length === 0) return; // default DENY
      if (!isAllowedOrigin(event.origin, allowlist)) return;
      if (expectedSource && event.source !== expectedSource) return;
      if (!validMessage(event.data)) return;
      var update = coercePayload(event.data.payload);
      if (typeof el.setProgress === "function") {
        el.setProgress(update);
      }
    }

    global.addEventListener("message", onMessage);
    return {
      destroy: function () {
        global.removeEventListener("message", onMessage);
      },
    };
  }

  /**
   * Parse ?allow=https://host origins for the iframe build.
   * Only bare https origins are accepted; anything else is ignored,
   * which collapses the allowlist to empty (deny).
   */
  function parseAllowlist(search) {
    var params = new URLSearchParams(search);
    var raw = params.getAll("allow");
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      if (ORIGIN_RE.test(raw[i]) && out.indexOf(raw[i]) === -1) {
        out.push(raw[i]);
      }
    }
    return out;
  }

  /** Parse an initial ?percent=&eta=&stage= seed (allowlisted params only). */
  function parseSeed(search) {
    var params = new URLSearchParams(search);
    var seed = {};
    var percent = params.get("percent");
    if (percent !== null && percent !== "" && !isNaN(Number(percent))) {
      seed.percent = Number(percent);
    }
    var eta = params.get("eta");
    if (eta !== null && eta !== "" && !isNaN(Number(eta))) {
      seed.etaSeconds = Number(eta);
    }
    var stage = params.get("stage");
    if (stage !== null) {
      seed.stage = String(stage).slice(0, 120);
    }
    return seed;
  }

  global.UAPBEmbed = {
    PROTOCOL: PROTOCOL,
    VERSION: VERSION,
    createListener: createListener,
    parseAllowlist: parseAllowlist,
    parseSeed: parseSeed,
  };
})(typeof window !== "undefined" ? window : this);
