// SPDX-License-Identifier: MIT
/* uapb-hermes-plugin — Universal Agent Progress Bar slot for the Hermes
 * Agent web dashboard (hermes --web), slot "chat:top".
 *
 * Unofficial community plugin. Not affiliated with Nous Research.
 *
 * Data path (read this before assuming otherwise): this plugin does NOT
 * subscribe to Hermes's native /api/events and does NOT read Hermes's
 * internal reasoning. It consumes the Universal Agent Progress Bar
 * localhost SSE stream (http://127.0.0.1:<port>/api/stream?token=...),
 * which is fed by Hermes self-reporting through its progress skill ->
 * the agent-progress MCP server -> JSONL -> `agent-progress dashboard`.
 * What the slot shows is self-reported stages, not internal reasoning or
 * chain-of-thought. Estimates move.
 *
 * Build markers (scripts/build-hermes-plugin.js replaces these):
 *   UAPB:WIDGET-JS  -> packages/widget/src/uapb-core.js + uapb-widget.js
 *   UAPB:PLUGIN-CSS -> this slot's CSS as a JS string literal
 * Zero dependencies. Zero network at build/install. textContent-only DOM
 * (AppSec C13): no innerHTML anywhere in this file.
 */
(function () {
  "use strict";

  /* ==== widget sources, inlined at build ==== */
  /*UAPB:WIDGET-JS*/

  /* ==== slot CSS, inlined at build: the whole quoted placeholder is
   * replaced with the CSS as a JS string literal ==== */
  var UAPB_SLOT_CSS = "/*UAPB:PLUGIN-CSS*/";

  var PLUGIN_NAME = "uapb-hermes-plugin";
  var SLOT = "chat:top";
  var DEFAULT_PORT = 17421; // binding: dashboard port scan starts at 17421
  var LS_TOKEN = "uapb.dashboardToken";
  var LS_PORT = "uapb.dashboardPort";
  var LS_SEEN = "uapb.hermes.seenLive";
  var HONESTY_LABEL = "Self-reported \u00b7 estimates move";
  var IDLE_FIRST_TEXT = "Idle \u2014 progress appears here when Hermes works.";
  var SETUP_TEXT =
    "Paste your dashboard token \u2014 run `agent-progress dashboard` to get it.";
  var RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];
  var DONE_HOLD_MS = 4000;

  function warn(msg) {
    if (typeof console !== "undefined" && typeof console.warn === "function") {
      console.warn("[uapb] " + msg);
    }
  }

  /** Feature-detect the Hermes plugin SDK, major version 1. */
  function sdkMajor() {
    try {
      var sdk = window.__HERMES_PLUGIN_SDK__;
      if (!sdk) return 0;
      var raw = sdk.version || sdk.VERSION || "";
      var major = parseInt(String(raw).split(".")[0], 10);
      return isNaN(major) ? 0 : major;
    } catch (e) {
      return 0;
    }
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function getLS(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function setLS(key, val) {
    try {
      window.localStorage.setItem(key, val);
    } catch (e) {
      /* storage unavailable (private mode) — run without persistence */
    }
  }

  function clampNum(v, fallback) {
    var n = Number(v);
    if (typeof n !== "number" || isNaN(n)) return fallback;
    return Math.min(100, Math.max(0, n));
  }

  function clampEta(v) {
    var n = Number(v);
    if (typeof n !== "number" || isNaN(n) || n < 0) return null;
    return n;
  }

  /**
   * A record belongs to Hermes if it carries agent === "hermes" or its
   * task_id follows the skill's `hermes:<task>` convention.
   */
  function isHermesRecord(rec) {
    if (!rec || typeof rec !== "object") return false;
    if (typeof rec.agent === "string" && rec.agent === "hermes") return true;
    if (typeof rec.task_id === "string" && rec.task_id.split(":")[0] === "hermes") {
      return true;
    }
    return false;
  }

  function recordTime(rec) {
    var t = Date.parse(rec.updated_at);
    return isNaN(t) ? 0 : t;
  }

  /**
   * Tolerant envelope unwrapping: the dashboard may stream a bare record,
   * {type, data: record}, {record}, or a snapshot {records: [...]}.
   */
  function extractRecords(payload) {
    var out = [];
    (function walk(node) {
      if (!node || typeof node !== "object") return;
      if (typeof node.task_id === "string" && typeof node.percent === "number") {
        out.push(node);
        return;
      }
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) walk(node[i]);
        return;
      }
      if (node.data) walk(node.data);
      if (node.record) walk(node.record);
      if (node.records) walk(node.records);
      if (node.events) walk(node.events);
    })(payload);
    return out;
  }

  /**
   * The slot component factory. Hermes calls it with the mount container;
   * it builds the slot DOM and returns a teardown function.
   */
  function createSlot(container) {
    var state = {
      token: getLS(LS_TOKEN),
      port: parseInt(getLS(LS_PORT), 10) || DEFAULT_PORT,
      seenLive: getLS(LS_SEEN) === "1",
      mode: "boot", // setup | idle-first | idle | live
      sessions: {},
      activeId: null,
      es: null,
      reconnectTimer: null,
      reconnectAttempt: 0,
      doneTimer: null,
      tickTimer: null,
      destroyed: false,
    };

    var root = el("div", "uapb-hermes-slot");
    root.setAttribute("data-uapb-slot", PLUGIN_NAME);

    var mascotScale = el("div", "uapb-mascot-scale");
    var mascot = el("div", "uapb-mascot");
    mascot.setAttribute("aria-hidden", "true");
    mascot.appendChild(el("div", "uapb-mascot-body"));
    mascot.appendChild(el("div", "uapb-mascot-eye uapb-mascot-eye-left"));
    mascot.appendChild(el("div", "uapb-mascot-eye uapb-mascot-eye-right"));
    mascot.appendChild(el("div", "uapb-mascot-antenna"));
    mascot.appendChild(el("div", "uapb-mascot-tip"));
    mascotScale.appendChild(mascot);

    var body = el("div", "uapb-hermes-body");
    var widget = document.createElement("uapb-progress");
    var stageLine = el("div", "uapb-hermes-stage");
    var setupRow = el("div", "uapb-hermes-setup");

    var setupText = el("span", null, SETUP_TEXT);
    var portInput = document.createElement("input");
    portInput.className = "uapb-port";
    portInput.setAttribute("inputmode", "numeric");
    portInput.setAttribute("aria-label", "Dashboard port");
    portInput.value = String(state.port);
    var tokenInput = document.createElement("input");
    tokenInput.className = "uapb-token";
    tokenInput.setAttribute("type", "password");
    tokenInput.setAttribute("autocomplete", "off");
    tokenInput.setAttribute("spellcheck", "false");
    tokenInput.setAttribute("aria-label", "Dashboard token");
    tokenInput.setAttribute("placeholder", "dashboard token");
    var saveBtn = el("button", null, "Save");
    saveBtn.setAttribute("type", "button");
    setupRow.appendChild(setupText);
    setupRow.appendChild(portInput);
    setupRow.appendChild(tokenInput);
    setupRow.appendChild(saveBtn);

    var honesty = el("div", "uapb-honesty", HONESTY_LABEL);
    honesty.setAttribute("title", HONESTY_LABEL);

    body.appendChild(widget);
    body.appendChild(stageLine);
    body.appendChild(setupRow);
    root.appendChild(mascotScale);
    root.appendChild(body);
    root.appendChild(honesty);
    container.appendChild(root);

    function setMode(mode) {
      state.mode = mode;
      root.setAttribute("data-mode", mode);
    }

    function show(node, on) {
      node.style.display = on ? "" : "none";
    }

    function markSeenLive() {
      if (!state.seenLive) {
        state.seenLive = true;
        setLS(LS_SEEN, "1");
      }
    }

    function streamURL() {
      return (
        "http://127.0.0.1:" +
        state.port +
        "/api/stream?token=" +
        encodeURIComponent(state.token || "")
      );
    }

    function statusText(t) {
      stageLine.textContent = t;
    }

    function disconnect() {
      if (state.es) {
        try {
          state.es.close();
        } catch (e) {
          /* already closed */
        }
        state.es = null;
      }
      if (state.reconnectTimer) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = null;
      }
    }

    function scheduleReconnect(reason) {
      disconnect();
      if (state.destroyed || !state.token) return;
      var delay =
        RECONNECT_DELAYS_MS[
          Math.min(state.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
        ];
      state.reconnectAttempt++;
      statusText("reconnecting\u2026");
      state.reconnectTimer = setTimeout(function () {
        state.reconnectTimer = null;
        connect();
      }, delay);
      warn("dashboard stream dropped (" + reason + "); retrying in " + delay + "ms");
    }

    function connect() {
      disconnect();
      if (state.destroyed) return;
      if (!state.token) {
        setMode("setup");
        render();
        return;
      }
      statusText("connecting\u2026");
      var es;
      try {
        es = new EventSource(streamURL());
      } catch (e) {
        scheduleReconnect("EventSource unavailable");
        return;
      }
      state.es = es;
      es.onmessage = function (evt) {
        state.reconnectAttempt = 0;
        var payload = null;
        try {
          payload = JSON.parse(String(evt.data || ""));
        } catch (e) {
          return;
        }
        onPayload(payload);
      };
      es.onerror = function () {
        scheduleReconnect("stream error");
      };
      /* A quiet heartbeat tick keeps the tier thresholds (<1s / 1-5s / >5s)
       * moving even when no new events arrive. */
      if (state.tickTimer) clearInterval(state.tickTimer);
      state.tickTimer = setInterval(function () {
        if (!state.destroyed) render();
      }, 500);
    }

    function ingest(rec, now) {
      var id = rec.task_id;
      var s = state.sessions[id];
      if (!s) {
        s = state.sessions[id] = { start: now };
        markSeenLive();
      }
      s.last = now;
      s.percent = clampNum(rec.percent, 0);
      s.eta =
        rec.eta_seconds === null || rec.eta_seconds === undefined
          ? null
          : clampEta(rec.eta_seconds);
      s.stage = typeof rec.stage === "string" ? rec.stage : "";
      s.complete = !!rec.complete || s.percent >= 100;
      if (s.complete && !s.doneAt) s.doneAt = now;
    }

    function pickActive(now) {
      var best = null;
      var bestStart = -1;
      var lastDone = null;
      var lastDoneAt = -1;
      for (var id in state.sessions) {
        if (!Object.prototype.hasOwnProperty.call(state.sessions, id)) continue;
        var s = state.sessions[id];
        if (!s.complete) {
          if (s.start > bestStart) {
            bestStart = s.start;
            best = id;
          }
        } else if (s.doneAt && s.doneAt > lastDoneAt) {
          lastDoneAt = s.doneAt;
          lastDone = id;
        }
      }
      if (best) {
        state.activeId = best;
        return;
      }
      /* Hold the finished run at 100% briefly, then collapse to idle. */
      if (lastDone && now - lastDoneAt < DONE_HOLD_MS) {
        state.activeId = lastDone;
        scheduleDoneCollapse(now - lastDoneAt);
        return;
      }
      state.activeId = null;
    }

    function scheduleDoneCollapse(alreadyElapsed) {
      if (state.doneTimer) return;
      state.doneTimer = setTimeout(function () {
        state.doneTimer = null;
        if (!state.destroyed) {
          pickActive(Date.now());
          render();
        }
      }, Math.max(0, DONE_HOLD_MS - alreadyElapsed));
    }

    function onPayload(payload) {
      var records = extractRecords(payload);
      var now = Date.now();
      var sawHermes = false;
      for (var i = 0; i < records.length; i++) {
        if (!isHermesRecord(records[i])) continue;
        sawHermes = true;
        ingest(records[i], now);
      }
      if (!sawHermes && records.length > 0) {
        /* Fallback: no hermes-tagged session yet — show the most recent
         * session so the slot is never mysteriously empty. */
        var latest = null;
        var latestT = -1;
        for (var j = 0; j < records.length; j++) {
          var t = recordTime(records[j]);
          if (t > latestT) {
            latestT = t;
            latest = records[j];
          }
        }
        if (latest) ingest(latest, now);
      }
      pickActive(now);
      render();
    }

    function saveToken() {
      var token = tokenInput.value.trim();
      var port = parseInt(portInput.value.trim(), 10);
      if (!token) {
        statusText("Paste the token first \u2014 run `agent-progress dashboard`.");
        return;
      }
      if (isNaN(port) || port <= 0 || port > 65535) {
        statusText("Port must be 1\u201365535.");
        return;
      }
      /* Stored to localStorage only; never logged, never sent anywhere
       * except as the ?token= query param on the localhost stream. */
      setLS(LS_TOKEN, token);
      setLS(LS_PORT, String(port));
      state.token = token;
      state.port = port;
      tokenInput.value = "";
      connect();
      render();
    }

    saveBtn.addEventListener("click", saveToken);
    tokenInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") saveToken();
    });

    function render() {
      var now = Date.now();
      var active = state.activeId ? state.sessions[state.activeId] : null;

      if (!state.token) {
        setMode("setup");
        show(mascotScale, true);
        show(body, true);
        show(setupRow, true);
        show(widget, false);
        show(stageLine, false);
        return;
      }

      show(setupRow, false);

      if (!active) {
        /* Idle. First run (never saw a live session): stay discoverable —
         * static mascot at 60% + muted line. After the first live session:
         * collapse to the honesty micro-label only. */
        if (state.seenLive) {
          setMode("idle");
        } else {
          setMode("idle-first");
          show(mascotScale, true);
          show(body, true);
          show(widget, false);
          show(stageLine, true);
          statusText(IDLE_FIRST_TEXT);
        }
        return;
      }

      setMode("live");
      show(mascotScale, true);
      show(body, true);

      var elapsed = now - active.start;
      if (typeof widget.setProgress === "function") {
        widget.setProgress({
          percent: active.percent,
          etaSeconds: active.eta,
          stage: active.stage,
          status: active.complete ? "done" : "running",
        });
      }

      if (elapsed < 1000) {
        /* Tier 1 (<1s): mascot pulse only, bar hidden. */
        show(widget, false);
        show(stageLine, true);
        statusText(active.stage || "Working\u2026");
        widget.removeAttribute("compact");
      } else if (elapsed < 5000) {
        /* Tier 2 (1-5s): compact bar. */
        show(widget, true);
        show(stageLine, false);
        widget.setAttribute("compact", "");
      } else {
        /* Tier 3 (>5s): full bar + stage/ETA readouts (widget meta). */
        show(widget, true);
        show(stageLine, false);
        widget.removeAttribute("compact");
      }
    }

    /* Boot. */
    root.setAttribute("data-mode", "boot");
    render();
    connect();

    return function teardown() {
      state.destroyed = true;
      disconnect();
      if (state.tickTimer) clearInterval(state.tickTimer);
      if (state.doneTimer) clearTimeout(state.doneTimer);
      if (root.parentNode) root.parentNode.removeChild(root);
    };
  }

  function init() {
    /* Fail QUIETLY on SDK absence/incompatibility: console warning only,
     * never break the host page. */
    if (sdkMajor() !== 1) {
      warn(
        "Hermes plugin SDK v1 not detected (found v" +
          sdkMajor() +
          "); progress slot disabled."
      );
      return;
    }
    var host = window.__HERMES_PLUGINS__;
    if (!host || typeof host.registerSlot !== "function") {
      warn("__HERMES_PLUGINS__.registerSlot not available; progress slot disabled.");
      return;
    }
    /* Inject the slot CSS before registering so first paint is styled.
     * textContent assignment, never innerHTML. */
    if (UAPB_SLOT_CSS) {
      var style = document.createElement("style");
      style.setAttribute("data-uapb", PLUGIN_NAME);
      style.textContent = UAPB_SLOT_CSS;
      (document.head || document.documentElement).appendChild(style);
    }
    /* Runtime slot signature: registerSlot(plugin, slot, component). */
    host.registerSlot(PLUGIN_NAME, SLOT, createSlot);
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  }
})();
