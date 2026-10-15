/* SPDX-License-Identifier: MIT */
/* UAPB live dashboard — vanilla JS, zero dependencies.
 * Consumes the localhost SSE stream from `agent-progress dashboard`:
 *   GET /api/stream?token=<128b>&resume=<id>   (SSE, replay then live)
 *   GET /api/snapshot?token=                  (latest event per task)
 * Event shape: {proto:1, task_id, percent, eta_seconds, stage, message?,
 *   status, complete, timestamp, agent, session_id} plus occasional
 *   {type:"dropped", task_id, dropped_count, ...} markers.
 * Rendering (AppSec C13): textContent ONLY — never HTML-string APIs.
 * JSONL/SSE line goes through JSON.parse in try/catch; field types are
 * validated before render; malformed lines are dropped silently and
 * counted for the stream-health indicator. eta_seconds: null renders
 * "estimating…" — never a fabricated number.
 * Timescale tiers: <1s mascot pulse-pop + "just started" (no bar);
 * 1–5s widget compact; >5s full widget. One fixed body min-height per
 * tier so promotion never reflows rows. */
(function () {
  "use strict";

  var FINISHED_TTL_MS = 10 * 60 * 1000;
  var STALE_AFTER_MS = 60 * 1000;
  var ANNOUNCE_MIN_GAP_MS = 5000;
  var HISTORY_CAP_RENDER = 25;
  var HISTORY_CAP_STORE = 50;
  var TICK_MS = 500;
  var MAX_STREAM_RETRIES_BEFORE_ERROR = 3;

  var REDUCED =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- tiny DOM helpers (textContent only) ---------- */
  function el(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) d.setAttribute("class", cls);
    if (text !== undefined && text !== null) d.textContent = text;
    return d;
  }

  /* ---------- config ---------- */
  var TOKEN = "";
  try {
    TOKEN = new URLSearchParams(window.location.search).get("token") || "";
  } catch (e) {
    TOKEN = "";
  }

  /* ---------- per-agent accent hues ----------
   * Deterministic hash of the agent name -> one of 6 hues.
   * Applied ONLY to the mascot antenna tip + the 2px row border.
   * Reserved and never agent accents: emerald #34D399 (done),
   * red #F87171 (error), amber #F5A524 (stale). */
  var ACCENTS = ["#7C9AFF", "#C084FC", "#F472B6", "#22D3EE", "#FB923C", "#A3E635"];
  function accentFor(agent) {
    var h = 5381;
    for (var i = 0; i < agent.length; i++) {
      h = ((h << 5) + h + agent.charCodeAt(i)) | 0;
    }
    return ACCENTS[Math.abs(h) % ACCENTS.length];
  }

  /* ---------- state ---------- */
  var sessions = new Map(); // task_id -> live session record
  var finishedSessions = []; // [{sess}] in finish order, newest first
  var malformed = 0;
  var droppedTotal = 0;
  var lastResumeId = null;
  var streamState = "connecting"; // connecting | live | retrying
  var activeFilter = "all";
  var loaded = false;
  var errorVisible = false;
  var streamFailures = 0;
  var lastAnnounceAt = {};

  /* ---------- DOM refs ---------- */
  var healthEl, errorBox, errorTitle, retryBtn, loadingBox, emptyBox;
  var activeList, activeSection, finishedSection, finishedList, announcer;
  var filterButtons = [];

  function announce(msg, key) {
    var now = Date.now();
    if (lastAnnounceAt[key] && now - lastAnnounceAt[key] < ANNOUNCE_MIN_GAP_MS) {
      return;
    }
    lastAnnounceAt[key] = now;
    announcer.textContent = msg;
  }

  /* ---------- validation ---------- */
  var STATUSES = ["started", "running", "paused", "done", "error"];

  function validEvent(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    if (obj.type === "dropped") {
      if (
        typeof obj.task_id === "string" &&
        obj.task_id &&
        typeof obj.dropped_count === "number" &&
        isFinite(obj.dropped_count)
      ) {
        return {
          dropped: true,
          task_id: obj.task_id,
          dropped_count: Math.max(0, Math.floor(obj.dropped_count)),
        };
      }
      return null;
    }
    if (typeof obj.task_id !== "string" || !obj.task_id) return null;
    if (typeof obj.percent !== "number" || !isFinite(obj.percent)) return null;
    if (
      !(obj.eta_seconds === null ||
        (typeof obj.eta_seconds === "number" && isFinite(obj.eta_seconds)))
    )
      return null;
    if (typeof obj.stage !== "string") return null;
    if (STATUSES.indexOf(obj.status) === -1) return null;
    if (typeof obj.timestamp !== "string" || isNaN(Date.parse(obj.timestamp)))
      return null;
    return {
      task_id: obj.task_id,
      percent: Math.min(100, Math.max(0, obj.percent)),
      eta_seconds: obj.eta_seconds,
      stage: obj.stage,
      status: obj.status,
      timestamp: obj.timestamp,
      agent: typeof obj.agent === "string" && obj.agent ? obj.agent : "agent",
      session_id: typeof obj.session_id === "string" ? obj.session_id : "",
      message: typeof obj.message === "string" ? obj.message : "",
      complete: obj.complete === true,
    };
  }

  function handleLine(line) {
    var obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      malformed++;
      updateHealth();
      return;
    }
    var ev = validEvent(obj);
    if (!ev) {
      malformed++;
      updateHealth();
      return;
    }
    if (ev.dropped) {
      droppedTotal += ev.dropped_count;
      updateHealth();
      return;
    }
    // Fallback resume cursor when the server sends no SSE id field.
    lastResumeId = ev.task_id + "@" + ev.timestamp;
    applyEvent(ev);
  }

  /* ---------- rows ---------- */
  function shortSession(id) {
    return id ? id.slice(0, 8) : "";
  }

  function createRow(sess) {
    var row = el("div", "session-row");
    row.style.setProperty("--accent", accentFor(sess.agent));
    row.setAttribute("data-task-id", sess.task_id);

    var head = el("div", "session-head");

    var dot = el("span", "status-dot");
    dot.setAttribute("aria-hidden", "true");

    var frame = el("span", "mascot-frame");
    frame.setAttribute("aria-hidden", "true");
    var masc = el("span", "mascot");
    masc.appendChild(el("span", "mascot-antenna"));
    masc.appendChild(el("span", "mascot-tip"));
    masc.appendChild(el("span", "mascot-body"));
    masc.appendChild(el("span", "mascot-eye left"));
    masc.appendChild(el("span", "mascot-eye right"));
    frame.appendChild(masc);

    var idBlock = el("div", "session-id");
    var titleText =
      sess.agent + (sess.session_id ? " · " + shortSession(sess.session_id) : "");
    var title = el("div", "session-title", titleText);
    var sub = el("div", "session-sub", sess.task_id);
    idBlock.appendChild(title);
    idBlock.appendChild(sub);

    var pill = el("span", "pill pill-running", "RUNNING");

    var expander = el("button", "expander", "History");
    expander.setAttribute("type", "button");
    expander.setAttribute("aria-expanded", "false");
    expander.addEventListener("click", function () {
      toggleHistory(sess);
    });

    var dismiss = el("button", "dismiss", "Dismiss");
    dismiss.setAttribute("type", "button");
    dismiss.hidden = true;
    dismiss.addEventListener("click", function () {
      dismissFinished(sess);
    });

    head.appendChild(dot);
    head.appendChild(frame);
    head.appendChild(idBlock);
    head.appendChild(pill);
    head.appendChild(expander);
    head.appendChild(dismiss);

    var body = el("div", "session-body");
    var foot = el("div", "session-foot");
    var staleLabel = el("span", "stale-label");
    foot.appendChild(staleLabel);

    row.appendChild(head);
    row.appendChild(body);
    row.appendChild(foot);

    sess.refs = {
      row: row,
      dot: dot,
      frame: frame,
      pill: pill,
      expander: expander,
      dismiss: dismiss,
      body: body,
      foot: foot,
      staleLabel: staleLabel,
      widget: null,
      etaLine: null,
      histList: null,
      tier: -1,
    };
    return row;
  }

  /* Timescale tiers: 0 (<1s) pulse-pop + "just started"; 1 (1-5s)
   * widget compact; 2 (>5s) full widget. Fixed .session-body min-height
   * in CSS is identical for every tier so promotion never reflows. */
  function tierFor(sess, now) {
    var age = now - sess.firstSeenMs;
    if (age < 1000) return 0;
    if (age < 5000) return 1;
    return 2;
  }

  function rebuildBody(sess, tier) {
    var r = sess.refs;
    r.tier = tier;
    while (r.body.firstChild) r.body.removeChild(r.body.firstChild);
    r.widget = null;
    r.etaLine = null;
    r.histList = null;
    if (tier === 0) {
      r.body.appendChild(el("div", "just-started", "just started"));
      if (!REDUCED) r.frame.classList.add("pulse-pop");
    } else {
      r.frame.classList.remove("pulse-pop");
      var w = document.createElement("uapb-progress");
      if (tier === 1) w.setAttribute("compact", "");
      r.body.appendChild(w);
      r.widget = w;
      if (tier === 1) {
        // compact mode hides the widget's meta: show our own mono ETA.
        r.etaLine = el("div", "session-eta mono");
        r.body.appendChild(r.etaLine);
      }
      var hist = el("ol", "history");
      hist.hidden = !sess.historyOpen;
      r.body.appendChild(hist);
      r.histList = hist;
      renderHistory(sess);
      pushToWidget(sess);
    }
  }

  function pushToWidget(sess, etaOverride) {
    var w = sess.refs.widget;
    if (!w || typeof w.setProgress !== "function") return;
    w.setProgress({
      percent: sess.percent,
      etaSeconds: etaOverride !== undefined ? etaOverride : sess.eta_seconds,
      stage: sess.stage,
      status: sess.status,
      message: sess.message,
    });
  }

  function renderHistory(sess) {
    var list = sess.refs.histList;
    if (!list) return;
    while (list.firstChild) list.removeChild(list.firstChild);
    var items = sess.history.slice(0, HISTORY_CAP_RENDER);
    for (var i = 0; i < items.length; i++) {
      var li = el("li");
      li.appendChild(el("time", "mono", items[i].ts));
      li.appendChild(document.createTextNode(" "));
      li.appendChild(el("span", null, items[i].stage));
      list.appendChild(li);
    }
  }

  function toggleHistory(sess) {
    if (!sess.refs.histList) return;
    sess.historyOpen = !sess.historyOpen;
    sess.refs.histList.hidden = !sess.historyOpen;
    sess.refs.expander.setAttribute("aria-expanded", String(sess.historyOpen));
  }

  function pillWord(sess, stale) {
    if (stale) return ["STALE", "pill-stale"];
    switch (sess.status) {
      case "started":
        return ["STARTED", "pill-started"];
      case "paused":
        return ["PAUSED", "pill-paused"];
      case "done":
        return ["DONE", "pill-done"];
      case "error":
        return ["ERROR", "pill-error"];
      default:
        return ["RUNNING", "pill-running"];
    }
  }

  function updateRow(sess, stale) {
    var r = sess.refs;
    var pw = pillWord(sess, stale);
    r.pill.textContent = pw[0];
    r.pill.setAttribute("class", "pill " + pw[1]);
    var dotCls = stale
      ? "status-dot is-stale"
      : "status-dot is-" + sess.status;
    r.dot.setAttribute("class", dotCls);
    r.row.classList.toggle("is-stale", !!stale);
  }

  /* ---------- session lifecycle ---------- */
  function applyEvent(ev) {
    var now = Date.now();
    var sess = sessions.get(ev.task_id);
    if (!sess) {
      sess = {
        task_id: ev.task_id,
        agent: ev.agent,
        session_id: ev.session_id,
        percent: 0,
        eta_seconds: null,
        stage: "",
        status: "running",
        message: "",
        complete: false,
        firstSeenMs: now,
        lastReceiptMs: 0,
        history: [],
        historyOpen: false,
        finished: false,
        finishedAt: 0,
        refs: null,
      };
      sessions.set(ev.task_id, sess);
      createRow(sess);
      activeList.appendChild(sess.refs.row);
      rebuildBody(sess, 0);
      announce(
        "Session started: " + sess.agent + " " + sess.task_id,
        "start:" + (sess.session_id || sess.task_id)
      );
    }
    if (ev.stage !== sess.stage) {
      sess.history.unshift({ ts: ev.timestamp, stage: ev.stage });
      if (sess.history.length > HISTORY_CAP_STORE)
        sess.history.length = HISTORY_CAP_STORE;
      renderHistory(sess);
    }
    sess.percent = ev.percent;
    sess.eta_seconds = ev.eta_seconds;
    sess.stage = ev.stage;
    sess.status = ev.status;
    sess.message = ev.message;
    sess.complete = ev.complete;
    sess.lastReceiptMs = now;

    if (ev.complete || ev.status === "done" || ev.status === "error") {
      finishSession(sess, ev.status);
    } else {
      pushToWidget(sess);
      updateRow(sess, false);
      applyFilterTo(sess);
    }
    updateEmpty();
  }

  function finishSession(sess, status) {
    pushToWidget(sess);
    updateRow(sess, false);
    sess.finished = true;
    sess.finishedAt = Date.now();
    sessions.delete(sess.task_id);
    // Move the row into the finished section, newest first.
    sess.refs.dismiss.hidden = false;
    finishedSessions.unshift(sess);
    renderFinished();
    updateHealth();
    var word = status === "error" ? "Session error: " : "Session finished: ";
    announce(
      word + sess.agent + " " + sess.task_id,
      "end:" + (sess.session_id || sess.task_id)
    );
    updateEmpty();
  }

  function renderFinished() {
    while (finishedList.firstChild)
      finishedList.removeChild(finishedList.firstChild);
    for (var i = 0; i < finishedSessions.length; i++) {
      finishedList.appendChild(finishedSessions[i].refs.row);
    }
    finishedSection.hidden = finishedSessions.length === 0;
  }

  function dismissFinished(sess) {
    var idx = finishedSessions.indexOf(sess);
    if (idx !== -1) finishedSessions.splice(idx, 1);
    if (sess.refs.row.parentNode) sess.refs.row.parentNode.removeChild(sess.refs.row);
    renderFinished();
    updateHealth();
    updateEmpty();
  }

  /* ---------- tick: tiers, stale, ETA decay, expiry ---------- */
  function tick() {
    var now = Date.now();
    sessions.forEach(function (sess) {
      var tier = tierFor(sess, now);
      if (tier !== sess.refs.tier) rebuildBody(sess, tier);
      var stale = now - sess.lastReceiptMs > STALE_AFTER_MS;
      if (stale) {
        var n = Math.floor((now - sess.lastReceiptMs) / 1000);
        sess.refs.staleLabel.textContent = "stale — no heartbeat " + n + "s";
      } else {
        sess.refs.staleLabel.textContent = "";
      }
      updateRow(sess, stale);
      // Live mono ETA countdown: decay the agent's reported estimate by
      // elapsed time since the event. null stays "estimating…" (honesty).
      if (
        !stale &&
        (sess.status === "running" || sess.status === "started") &&
        typeof sess.eta_seconds === "number"
      ) {
        var remaining = Math.max(
          0,
          sess.eta_seconds - (now - sess.lastReceiptMs) / 1000
        );
        pushToWidget(sess, remaining);
        if (sess.refs.etaLine)
          sess.refs.etaLine.textContent = "eta " + fmtCountdown(remaining);
      } else if (sess.refs.etaLine) {
        sess.refs.etaLine.textContent =
          typeof sess.eta_seconds === "number"
            ? "eta " + fmtCountdown(sess.eta_seconds)
            : "estimating…";
      }
    });
    // Auto-expire finished rows after 10 minutes.
    var changed = false;
    for (var i = finishedSessions.length - 1; i >= 0; i--) {
      if (now - finishedSessions[i].finishedAt > FINISHED_TTL_MS) {
        var s = finishedSessions[i];
        finishedSessions.splice(i, 1);
        if (s.refs.row.parentNode) s.refs.row.parentNode.removeChild(s.refs.row);
        changed = true;
      }
    }
    if (changed) renderFinished();
  }

  function fmtCountdown(sec) {
    var total = Math.ceil(Math.max(0, sec));
    var m = Math.floor(total / 60);
    var s = total % 60;
    return m + ":" + (s < 10 ? "0" + s : s);
  }

  /* ---------- filters ---------- */
  function filterMatches(sess) {
    if (activeFilter === "all") return true;
    if (activeFilter === "active")
      return sess.status === "started" || sess.status === "running";
    if (activeFilter === "paused") return sess.status === "paused";
    return false;
  }

  function applyFilterTo(sess) {
    if (activeFilter === "finished") return; // active list hidden entirely
    sess.refs.row.hidden = !filterMatches(sess);
  }

  function applyFilter() {
    sessions.forEach(applyFilterTo);
    var showActive = activeFilter !== "finished";
    activeSection.hidden = !showActive;
    var showFinished = activeFilter === "all" || activeFilter === "finished";
    if (finishedSessions.length === 0) {
      finishedSection.hidden = true;
    } else {
      finishedSection.hidden = !showFinished;
    }
    updateEmpty();
  }

  /* ---------- stream health ---------- */
  function updateHealth() {
    var parts = [];
    if (streamState === "live") parts.push("live");
    else if (streamState === "retrying") parts.push("reconnecting…");
    else parts.push("connecting…");
    var n = sessions.size;
    parts.push(n + (n === 1 ? " session" : " sessions"));
    if (droppedTotal > 0) parts.push(droppedTotal + " dropped");
    if (malformed > 0) parts.push(malformed + " malformed");
    healthEl.textContent = parts.join(" · ");
    healthEl.setAttribute(
      "class",
      "stream-health" +
        (streamState === "live"
          ? " is-live"
          : streamState === "retrying"
            ? " is-retry"
            : "")
    );
  }

  /* ---------- snapshot + SSE ---------- */
  function showError(title) {
    errorVisible = true;
    if (title) errorTitle.textContent = title;
    errorBox.hidden = false;
    loadingBox.hidden = true;
    emptyBox.hidden = true;
    updateHealth();
  }

  function hideError() {
    errorVisible = false;
    errorBox.hidden = true;
  }

  function loadSnapshot() {
    fetch("api/snapshot?token=" + encodeURIComponent(TOKEN))
      .then(function (res) {
        if (!res.ok) throw new Error("snapshot " + res.status);
        return res.json();
      })
      .then(function (data) {
        var list;
        if (Array.isArray(data)) {
          list = data;
        } else if (data && typeof data === "object") {
          list = Object.keys(data).map(function (k) {
            return data[k];
          });
        } else {
          list = [];
        }
        for (var i = 0; i < list.length; i++) {
          var ev = validEvent(list[i]);
          if (ev) applyEvent(ev);
          else malformed++;
        }
        loaded = true;
        loadingBox.hidden = true;
        updateEmpty();
        updateHealth();
        openStream();
      })
      .catch(function () {
        showError("The stream is unreachable.");
      });
  }

  var es = null;
  var retryTimer = null;
  var retryMs = 1000;

  function openStream() {
    if (es) {
      try {
        es.close();
      } catch (e) {}
    }
    if (!TOKEN) {
      showError("Missing token — open this page from the URL printed by `agent-progress dashboard`.");
      return;
    }
    var url =
      "api/stream?token=" +
      encodeURIComponent(TOKEN) +
      "&resume=" +
      encodeURIComponent(lastResumeId || "");
    streamState = "connecting";
    updateHealth();
    es = new EventSource(url);
    es.onopen = function () {
      streamState = "live";
      streamFailures = 0;
      retryMs = 1000;
      hideError();
      updateHealth();
    };
    es.onmessage = function (e) {
      if (e.lastEventId) lastResumeId = e.lastEventId;
      if (typeof e.data === "string" && e.data) handleLine(e.data);
    };
    es.onerror = function () {
      try {
        es.close();
      } catch (e2) {}
      es = null;
      streamFailures++;
      streamState = "retrying";
      updateHealth();
      if (streamFailures >= MAX_STREAM_RETRIES_BEFORE_ERROR) {
        showError("The stream is unreachable.");
        return;
      }
      retryTimer = setTimeout(function () {
        retryMs = Math.min(retryMs * 2, 30000);
        openStream();
      }, retryMs);
    };
  }

  /* ---------- empty / loading ---------- */
  function updateEmpty() {
    if (errorVisible || !loaded) {
      emptyBox.hidden = true;
      return;
    }
    var anyVisible = false;
    sessions.forEach(function (sess) {
      if (!sess.refs.row.hidden) anyVisible = true;
    });
    var showEmpty =
      !anyVisible &&
      (activeFilter === "all" || activeFilter === "active") &&
      finishedSessions.length === 0;
    emptyBox.hidden = !showEmpty;
  }

  function renderSkeletons() {
    while (loadingBox.firstChild)
      loadingBox.removeChild(loadingBox.firstChild);
    if (REDUCED) {
      // Skeleton shimmer is killed under reduced motion: plain text.
      loadingBox.appendChild(el("p", "empty-hint", "Loading sessions…"));
      return;
    }
    for (var i = 0; i < 3; i++) {
      var sk = el("div", "skeleton-row");
      sk.setAttribute("aria-hidden", "true");
      loadingBox.appendChild(sk);
    }
  }

  /* ---------- init ---------- */
  function init() {
    healthEl = document.getElementById("streamHealth");
    errorBox = document.getElementById("errorBox");
    errorTitle = document.getElementById("errorTitle");
    retryBtn = document.getElementById("retryBtn");
    loadingBox = document.getElementById("loadingBox");
    emptyBox = document.getElementById("emptyBox");
    activeList = document.getElementById("activeList");
    activeSection = document.getElementById("activeSection");
    finishedSection = document.getElementById("finishedSection");
    finishedList = document.getElementById("finishedList");
    announcer = document.getElementById("srAnnouncer");

    var chips = document.querySelectorAll(".chip[data-filter]");
    for (var i = 0; i < chips.length; i++) {
      filterButtons.push(chips[i]);
      (function (btn) {
        btn.addEventListener("click", function () {
          activeFilter = btn.getAttribute("data-filter");
          for (var j = 0; j < filterButtons.length; j++) {
            filterButtons[j].setAttribute(
              "aria-pressed",
              filterButtons[j] === btn ? "true" : "false"
            );
          }
          applyFilter();
        });
      })(chips[i]);
    }

    retryBtn.addEventListener("click", function () {
      hideError();
      streamFailures = 0;
      retryMs = 1000;
      loaded = false;
      loadingBox.hidden = false;
      renderSkeletons();
      loadSnapshot();
    });

    renderSkeletons();
    loadSnapshot();
    setInterval(tick, TICK_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
