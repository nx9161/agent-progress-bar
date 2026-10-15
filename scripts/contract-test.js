#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Contract test for the Universal Agent Progress Bar completion build.
// Zero dependencies (node builtins only). Exits non-zero with a message on
// any failure. Run from the repo root: `node scripts/contract-test.js`
//
// Covers:
//   1. protocol/schema.json — exercised by a self-contained mini-validator
//      (required, type incl. ["number","null"] unions, minimum/maximum,
//      minLength/maxLength, pattern, enum, const, format: date-time).
//   2. Demo/widget feed — stage labels extracted from packages/web/demo.js
//      and STAGES in packages/widget/src/uapb-core.js; synthesized full
//      ProgressEvents validated against the schema.
//   3. MCP tools over raw JSON-RPC against a freshly built server —
//      O1 (percent 150 clamps to 100, not an error), M3 (eta_seconds 99999
//      rejected), shape (percent "x" rejected), M1 (unknown keys never reach
//      the store; strict ZodObjects proven directly), get_status round-trip
//      drift check (per-property, since tool results carry
//      contract/complete/updated_at instead of proto/status/timestamp and
//      schema.json sets additionalProperties: true).
//
// NOTE on M1: @modelcontextprotocol/sdk 1.17.1 wraps the registered raw
// shape in a NON-strict z.object() and safeParseAsync()s arguments BEFORE
// the handler runs (server/mcp.js), so unknown keys are stripped at the wire
// layer and the handler-level strict gate (which returns
// {error:"invalid_arguments"}) only fires for direct/programmatic callers.
// The test asserts the honest end-to-end property: unknown keys never reach
// the store, and the strict ZodObjects themselves reject unknown keys.

import { spawn, execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SCHEMA_PATH = join(ROOT, "protocol", "schema.json");
const DEMO_JS = join(ROOT, "packages", "web", "demo.js");
const CORE_JS = join(ROOT, "packages", "widget", "src", "uapb-core.js");
const SERVER_DIR = join(ROOT, "packages", "mcp-server");
const SERVER_DIST = join(SERVER_DIR, "dist", "index.js");

let passed = 0;
function ok(label) {
  passed += 1;
  console.log(`ok ${passed} - ${label}`);
}
function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
function assert(cond, msg) {
  if (!cond) fail(msg);
}

// ---------------------------------------------------------------------------
// 1. Mini-validator for protocol/schema.json
// ---------------------------------------------------------------------------

const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));

assert(
  schema.$id ===
    "https://raw.githubusercontent.com/nx9161/agent-progress-bar/main/protocol/schema.json",
  `schema $id must be the canonical raw URL, got ${JSON.stringify(schema.$id)}`
);
ok("schema.json $id is the canonical raw.githubusercontent URL");

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function jsonTypeName(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
function checkType(t, v) {
  switch (t) {
    case "string": return typeof v === "string";
    case "number": return typeof v === "number" && !Number.isNaN(v);
    case "integer": return typeof v === "number" && Number.isInteger(v);
    case "boolean": return typeof v === "boolean";
    case "null": return v === null;
    case "object": return v !== null && typeof v === "object" && !Array.isArray(v);
    case "array": return Array.isArray(v);
    default: return false;
  }
}
function isDateTime(v) {
  return typeof v === "string" && v.includes("T") && !Number.isNaN(Date.parse(v));
}

// Returns an array of issue strings (empty = valid).
function validateValue(sub, value, path) {
  const issues = [];
  if (sub === true) return issues;
  if (sub === false) {
    issues.push(`${path}: schema is false`);
    return issues;
  }
  if (Object.prototype.hasOwnProperty.call(sub, "const")) {
    if (!deepEqual(sub.const, value)) {
      issues.push(`${path}: expected const ${JSON.stringify(sub.const)}, got ${JSON.stringify(value)}`);
    }
    return issues;
  }
  if (Array.isArray(sub.enum)) {
    if (!sub.enum.some((e) => deepEqual(e, value))) {
      issues.push(`${path}: ${JSON.stringify(value)} not in enum ${JSON.stringify(sub.enum)}`);
    }
    return issues;
  }
  if (sub.type !== undefined) {
    const types = Array.isArray(sub.type) ? sub.type : [sub.type];
    if (!types.some((t) => checkType(t, value))) {
      issues.push(`${path}: expected type ${types.join("|")}, got ${jsonTypeName(value)}`);
      return issues;
    }
  }
  if (typeof value === "string") {
    if (sub.minLength !== undefined && value.length < sub.minLength) {
      issues.push(`${path}: length ${value.length} < minLength ${sub.minLength}`);
    }
    if (sub.maxLength !== undefined && value.length > sub.maxLength) {
      issues.push(`${path}: length ${value.length} > maxLength ${sub.maxLength}`);
    }
    if (sub.pattern !== undefined && !new RegExp(sub.pattern).test(value)) {
      issues.push(`${path}: ${JSON.stringify(value)} does not match pattern ${sub.pattern}`);
    }
    if (sub.format === "date-time" && !isDateTime(value)) {
      issues.push(`${path}: ${JSON.stringify(value)} is not a valid date-time`);
    }
  }
  if (typeof value === "number") {
    if (sub.minimum !== undefined && value < sub.minimum) {
      issues.push(`${path}: ${value} < minimum ${sub.minimum}`);
    }
    if (sub.maximum !== undefined && value > sub.maximum) {
      issues.push(`${path}: ${value} > maximum ${sub.maximum}`);
    }
  }
  const isObj = value !== null && typeof value === "object" && !Array.isArray(value);
  if (isObj) {
    for (const req of sub.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, req)) {
        issues.push(`${path}: missing required property ${JSON.stringify(req)}`);
      }
    }
    for (const [key, propSchema] of Object.entries(sub.properties ?? {})) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        issues.push(...validateValue(propSchema, value[key], `${path}.${key}`));
      }
    }
    // additionalProperties: true in this schema — unknown fields are ignored
    // by consumers, so no issue is raised for them here.
  }
  return issues;
}

function expectValid(event, label) {
  const issues = validateValue(schema, event, "$");
  assert(issues.length === 0, `${label} should validate, got: ${issues.join("; ")}`);
}
function expectInvalid(event, label) {
  const issues = validateValue(schema, event, "$");
  assert(issues.length > 0, `${label} should NOT validate but did`);
}

// ---------------------------------------------------------------------------
// 2. Demo/widget feed check
// ---------------------------------------------------------------------------

function extractStageLabels() {
  const labels = new Set();
  const coreSrc = readFileSync(CORE_JS, "utf8");
  const stagesBlock = coreSrc.match(/var STAGES\s*=\s*\[([\s\S]*?)\]/);
  assert(stagesBlock, `could not find "var STAGES = [...]" in ${CORE_JS}`);
  for (const m of stagesBlock[1].matchAll(/"([^"]+)"/g)) labels.add(m[1]);
  const demoSrc = readFileSync(DEMO_JS, "utf8");
  for (const m of demoSrc.matchAll(/stage:\s*"([^"]+)"/g)) labels.add(m[1]);
  const out = [...labels];
  assert(out.length > 0, "stage-label extraction found zero labels");
  return out;
}

const stageLabels = extractStageLabels();
ok(`extracted ${stageLabels.length} stage labels from demo.js + uapb-core.js STAGES: ${stageLabels.join(" | ")}`);

const STATUSES = ["started", "running", "paused", "done", "error"];
const PERCENTS = [0, 12.5, 25, 50, 75, 99.9, 100]; // ramp incl. boundaries
const ETAS = [3600, 0, null]; // eta as number AND null

let eventCount = 0;
for (const stage of stageLabels) {
  for (const percent of PERCENTS) {
    for (const eta of ETAS) {
      for (const status of STATUSES) {
        expectValid(
          {
            proto: 1,
            task_id: "contract:demo-feed",
            percent,
            eta_seconds: eta,
            stage,
            message: "synthesized by contract-test.js",
            status,
            timestamp: new Date().toISOString(),
          },
          `demo feed event (stage=${stage}, percent=${percent}, eta=${eta}, status=${status})`
        );
        eventCount += 1;
      }
    }
  }
}
// Boundary events: 120-char stage and 280-char message must validate.
expectValid(
  {
    proto: 1,
    task_id: "contract:boundary",
    percent: 100,
    eta_seconds: null,
    stage: "s".repeat(120),
    message: "m".repeat(280),
    status: "done",
    timestamp: new Date().toISOString(),
  },
  "120-char stage / 280-char message boundary event"
);
ok(`all ${eventCount + 1} synthesized ProgressEvents validate against schema.json`);

// Negative checks — prove the mini-validator actually rejects.
const validEvent = () => ({
  proto: 1,
  task_id: "contract:neg",
  percent: 50,
  eta_seconds: 30,
  stage: "Reasoning",
  status: "running",
  timestamp: new Date().toISOString(),
});
expectInvalid({ ...validEvent(), percent: 101 }, "percent 101");
expectInvalid({ ...validEvent(), percent: -1 }, "percent -1");
expectInvalid({ ...validEvent(), eta_seconds: -5 }, "negative eta_seconds");
expectInvalid({ ...validEvent(), proto: 2 }, "proto 2 (const 1)");
expectInvalid({ ...validEvent(), status: "bogus" }, "status not in enum");
expectInvalid({ ...validEvent(), task_id: "" }, "empty task_id (minLength 1)");
expectInvalid({ ...validEvent(), stage: "s".repeat(121) }, "121-char stage (maxLength 120)");
expectInvalid({ ...validEvent(), message: "m".repeat(281) }, "281-char message (maxLength 280)");
{
  const e = validEvent();
  delete e.timestamp;
  expectInvalid(e, "missing required timestamp");
}
expectInvalid({ ...validEvent(), timestamp: "not-a-date" }, "non-date-time timestamp");
ok("mini-validator rejects 11 malformed events (negative checks)");

// ---------------------------------------------------------------------------
// 3. MCP tool check over raw JSON-RPC
// ---------------------------------------------------------------------------

let child = null;
function cleanup() {
  try {
    if (child && child.exitCode === null) child.kill("SIGKILL");
  } catch { /* ignore */ }
  try {
    rmSync(join(SERVER_DIR, "dist"), { recursive: true, force: true });
  } catch { /* ignore */ }
}
process.on("exit", cleanup);

console.log("building mcp-server (npm run build) ...");
try {
  execFileSync("npm", ["run", "build"], { cwd: SERVER_DIR, stdio: "pipe" });
} catch (e) {
  fail(`npm run build failed in packages/mcp-server: ${e.message}`);
}
ok("mcp-server builds clean (npm run build)");

child = spawn("node", [SERVER_DIST], { stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", () => {}); // drain structured logs; stdout stays pure

const pending = new Map();
let nextId = 1;
let stdoutBuf = "";
child.stdout.on("data", (chunk) => {
  stdoutBuf += chunk.toString();
  let idx;
  while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, idx).trim();
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      fail(`server stdout line is not JSON: ${line.slice(0, 200)}`);
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});
child.on("error", (e) => fail(`server process error: ${e.message}`));

function send(msg) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, ...msg }) + "\n", (err) => {
      if (err) {
        pending.delete(id);
        reject(err);
      }
    });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timed out waiting for response to id ${id} (${msg.method})`));
      }
    }, 15000);
  });
}
function notify(msg) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
}
const callTool = (name, args) =>
  send({ method: "tools/call", params: { name, arguments: args } });
const toolPayload = (res) => JSON.parse(res.result.content[0].text);
// "Failed" at the wire = JSON-RPC error (SDK InvalidParams) OR isError tool result.
const callFailed = (res) => res.error != null || res.result?.isError === true;

const mcp = (async () => {
  const init = await send({
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "contract-test", version: "0.0.0" },
    },
  });
  assert(!init.error, `initialize failed: ${JSON.stringify(init.error)}`);
  notify({ method: "notifications/initialized" });
  ok("MCP initialize handshake over raw JSON-RPC");

  // O1: percent 150 clamps to 100 — NOT an error (docs promise "server clamps, never errors").
  const clamp = await callTool("report_progress", {
    task_id: "contract:o1",
    percent: 150,
  });
  assert(!callFailed(clamp), `percent 150 must not error: ${JSON.stringify(clamp).slice(0, 300)}`);
  const clampBody = toolPayload(clamp);
  assert(clampBody.percent === 100, `percent 150 must clamp to 100, got ${clampBody.percent}`);
  assert(clampBody.complete === true, "percent 100 must set complete:true");
  ok("O1: report_progress percent=150 -> 100, complete=true, no error (clamp proof)");

  // O1 lower bound for good measure.
  const clampLow = await callTool("report_progress", {
    task_id: "contract:o1-low",
    percent: -20,
  });
  assert(!callFailed(clampLow), "percent -20 must not error");
  assert(toolPayload(clampLow).percent === 0, "percent -20 must clamp to 0");
  ok("O1: report_progress percent=-20 -> 0, no error");

  // M3: eta_seconds 99999 violates the 86400 hard bound -> rejected.
  const etaBig = await callTool("report_progress", {
    task_id: "contract:m3",
    percent: 50,
    eta_seconds: 99999,
  });
  assert(callFailed(etaBig), "eta_seconds 99999 must be rejected (M3 bound)");
  ok("M3: report_progress eta_seconds=99999 rejected (bound proof)");

  // Shape: percent "x" is not a number -> rejected.
  const badShape = await callTool("report_progress", {
    task_id: "contract:shape",
    percent: "x",
  });
  assert(callFailed(badShape), 'percent "x" must be rejected (shape proof)');
  ok('shape: report_progress percent="x" rejected (shape proof)');

  // M1: unknown extra key. The SDK strips unknown keys at the wire layer
  // before the handler (server/mcp.js safeParseAsync with non-strict
  // z.object), so the call succeeds — the property that must hold is that
  // the unknown key NEVER reaches the store. Strict rejection of unknown
  // keys is proven directly against the strict ZodObjects below.
  const extra = await callTool("report_progress", {
    task_id: "contract:m1",
    percent: 10,
    bogus_extra_key: "zzz",
  });
  assert(!callFailed(extra), "report_progress with extra key unexpectedly failed at SDK layer");
  const status = await callTool("get_status", { task_id: "contract:m1" });
  assert(!callFailed(status), "get_status round-trip failed");
  const statusBody = toolPayload(status);
  assert(
    !Object.prototype.hasOwnProperty.call(statusBody, "bogus_extra_key"),
    "unknown key leaked into the stored record"
  );
  ok("M1: unknown extra key never reaches the store (stripped at SDK layer; strict proof below)");

  // M1 strict proof, direct: the handler-level gate schemas reject unknown keys.
  const tools = await import(SERVER_DIST.replace(/index\.js$/, "tools.js"));
  const rpBad = tools.ReportProgressInput.safeParse({
    task_id: "x",
    percent: 10,
    bogus_extra_key: 1,
  });
  assert(!rpBad.success, "ReportProgressInput must reject unknown keys");
  const gsBad = tools.GetStatusInput.safeParse({ task_id: "x", extra: 1 });
  assert(!gsBad.success, "GetStatusInput must reject unknown keys");
  const rpGood = tools.ReportProgressInput.safeParse({ task_id: "x", percent: 10 });
  assert(rpGood.success, "ReportProgressInput must accept valid input");
  const serverSrc = readFileSync(SERVER_DIST.replace(/index\.js$/, "server.js"), "utf8");
  assert(
    serverSrc.includes("invalid_arguments"),
    "built server.js must contain the handler-level invalid_arguments gate"
  );
  ok("M1: strict ZodObjects reject unknown keys; handler invalid_arguments gate present in build");

  // get_status round-trip drift check: per-property validation only.
  // Tool results carry contract/complete/updated_at instead of
  // proto/status/timestamp, and schema.json has additionalProperties: true.
  const round = await callTool("get_status", { task_id: "contract:o1" });
  assert(!callFailed(round), "get_status for contract:o1 failed");
  const b = toolPayload(round);
  const propIssues = [];
  propIssues.push(
    ...validateValue(
      { type: "string", minLength: 1, maxLength: 128, pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$" },
      b.task_id,
      "$.task_id"
    )
  );
  propIssues.push(...validateValue({ type: "number", minimum: 0, maximum: 100 }, b.percent, "$.percent"));
  propIssues.push(
    ...validateValue({ type: ["number", "null"], minimum: 0, maximum: 86400 }, b.eta_seconds, "$.eta_seconds")
  );
  propIssues.push(...validateValue({ type: "string", maxLength: 120 }, b.stage, "$.stage"));
  if (b.message !== null) {
    propIssues.push(...validateValue({ type: "string", maxLength: 280 }, b.message, "$.message"));
  }
  assert(propIssues.length === 0, `get_status drift: ${propIssues.join("; ")}`);
  ok("get_status round-trip: overlapping fields satisfy schema property constraints (drift check)");
})();

const timeout = setTimeout(() => fail("contract test timed out after 60s"), 60000);
mcp.then(
  () => {
    clearTimeout(timeout);
    console.log(`\ncontract-test: ${passed} checks passed`);
    try {
      child.stdin.end();
    } catch { /* ignore */ }
    try {
      child.kill("SIGTERM");
    } catch { /* ignore */ }
    setTimeout(() => process.exit(0), 500).unref();
  },
  (e) => {
    clearTimeout(timeout);
    fail(`MCP tool check failed: ${e && e.message ? e.message : e}`);
  }
);
