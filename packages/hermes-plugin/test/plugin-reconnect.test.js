// SPDX-License-Identifier: MIT
// Hermetic test for F3: after 5 consecutive stream failures the slot clears
// the (per-launch, now stale) dashboard token and returns to setup mode
// instead of retrying forever.
//
// Runs the BUILT dist/plugin.js with stubbed DOM/EventSource/timers.
// Usage: node --test packages/hermes-plugin/test/plugin-reconnect.test.js
const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DIST = path.join(__dirname, "..", "dist", "plugin.js");

function makeEl(tag) {
  const n = {
    tag,
    className: "",
    textContent: "",
    value: "",
    style: {},
    children: [],
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    setAttribute(k, v) {
      this[k] = v;
    },
    removeAttribute() {},
    addEventListener() {},
  };
  return n;
}

function loadPlugin() {
  const src = fs.readFileSync(DIST, "utf8");
  const store = {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v);
    },
    removeItem: (k) => {
      delete store[k];
    },
  };
  const esInstances = [];
  function EventSource(url) {
    const inst = {
      url,
      onmessage: null,
      onerror: null,
      closed: false,
      close() {
        this.closed = true;
      },
    };
    esInstances.push(inst);
    return inst;
  }
  const timeouts = [];
  const fakeSetTimeout = (fn) => {
    const id = timeouts.length;
    timeouts.push({ fn, cleared: false });
    return id;
  };
  const fakeClearTimeout = (id) => {
    if (timeouts[id]) timeouts[id].cleared = true;
  };
  let factory = null;
  const win = {
    localStorage,
    __HERMES_PLUGIN_SDK__: { version: "1.2.3" },
    __HERMES_PLUGINS__: {
      registerSlot(_plugin, _slot, comp) {
        factory = comp;
      },
    },
  };
  const doc = {
    readyState: "complete",
    createElement: (tag) => makeEl(tag),
    head: makeEl("head"),
    documentElement: makeEl("html"),
    addEventListener() {},
  };
  const run = new Function(
    "window",
    "document",
    "EventSource",
    "HTMLElement",
    "customElements",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "console",
    src
  );
  class FakeHTMLElement {}
  run(
    win,
    doc,
    EventSource,
    FakeHTMLElement,
    { get() {}, define() {} },
    fakeSetTimeout,
    fakeClearTimeout,
    () => 0,
    () => {},
    { warn() {} }
  );

  function fireTimeouts() {
    // Run every pending non-cleared timeout once (the reconnect timers).
    for (const t of timeouts.splice(0)) {
      if (!t.cleared) t.fn();
    }
  }

  return { factory, localStorage, esInstances, fireTimeouts, store };
}

describe("F3 stale-token reset", () => {
  test("5 consecutive failures -> token cleared, setup mode, no more retries", () => {
    const ctx = loadPlugin();
    assert.ok(ctx.factory, "slot factory registered");
    ctx.localStorage.setItem("uapb.dashboardToken", "stale-token");
    const container = makeEl("div");
    ctx.factory(container);
    assert.equal(ctx.esInstances.length, 1, "one EventSource on boot");

    // 6 consecutive stream errors: 5 scheduled retries, then the reset.
    for (let i = 0; i < 6; i++) {
      const es = ctx.esInstances[ctx.esInstances.length - 1];
      assert.ok(es && !es.closed, "stream open before error " + (i + 1));
      es.onerror();
      ctx.fireTimeouts(); // run the reconnect timer, if any was scheduled
    }

    assert.equal(
      ctx.localStorage.getItem("uapb.dashboardToken"),
      null,
      "stale token cleared from localStorage"
    );
    assert.equal(
      ctx.esInstances.length,
      6,
      "no new EventSource after the reset (retrying stopped)"
    );
    const root = container.children[0];
    assert.equal(root["data-mode"], "setup", "slot returned to setup mode");
  });

  test("a successful message resets the consecutive-failure budget", () => {
    const ctx = loadPlugin();
    ctx.localStorage.setItem("uapb.dashboardToken", "good-token");
    const container = makeEl("div");
    ctx.factory(container);

    const failOnce = () => {
      ctx.esInstances[ctx.esInstances.length - 1].onerror();
      ctx.fireTimeouts();
    };
    failOnce();
    failOnce();
    // A live message arrives -> budget resets to 0.
    ctx.esInstances[ctx.esInstances.length - 1].onmessage({
      data: JSON.stringify({ task_id: "hermes:t1", percent: 10 }),
    });
    // 5 more failures must NOT clear the token (only 5 consecutive do).
    for (let i = 0; i < 5; i++) failOnce();
    assert.equal(
      ctx.localStorage.getItem("uapb.dashboardToken"),
      "good-token",
      "token survives: failures were not consecutive"
    );
    // The 6th consecutive failure clears it.
    failOnce();
    assert.equal(
      ctx.localStorage.getItem("uapb.dashboardToken"),
      null,
      "token cleared after 5 consecutive failures post-reset"
    );
  });
});
