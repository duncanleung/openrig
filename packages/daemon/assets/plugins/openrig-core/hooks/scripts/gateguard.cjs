#!/usr/bin/env node
"use strict";

// GateGuard (RIG-63): fact-forcing PreToolUse gate for Claude Code seats.
// The first gated Edit/Write in a turn is denied with a request for concrete
// facts. The retry in the same turn is allowed. A "turn" starts at each
// UserPromptSubmit, which runs this script with --reset.
//
// Opt-in: inert unless OPENRIG_GATEGUARD is truthy (1/true/on/yes).
// Fail-open: any error allows the edit. This script never blocks on its own failure.
// Measurement: one JSONL line per decision in <OPENRIG_HOME>/state/gateguard/events.jsonl.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// Tools the gate applies to. Must match the matcher in hooks/claude.json.
const GATED_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
// Values of OPENRIG_GATEGUARD that turn the gate on. Anything else is off.
const TRUE_VALUES = new Set(["1", "true", "on", "yes"]);
// An edit that changes fewer lines than this passes without a gate.
const TRIVIAL_LINE_LIMIT = 5;
// Hard stop for reading stdin. Must stay below the 5 s hook timeout in claude.json.
const STDIN_TIMEOUT_MS = 2_000;
// File name of the append-only decision log inside the state directory.
const EVENT_LOG_NAME = "events.jsonl";
// Longest session id kept verbatim as a state file name.
const MAX_SESSION_FILE_LENGTH = 128;
const DENY_REASON =
  "Before editing, present: (a) the specific files that import/consume this code, " +
  "(b) the schema or interface contract, (c) the verbatim user instruction or ticket requirement.";

function gateEnabled(value) {
  if (value === undefined || value === "") return false;
  return TRUE_VALUES.has(String(value).trim().toLowerCase());
}

const readStdin = () => new Promise((resolve) => {
  let data = "";
  let done = false;
  const finish = (value) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    resolve(value);
  };
  const timer = setTimeout(() => finish(""), STDIN_TIMEOUT_MS);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { data += chunk; });
  process.stdin.on("end", () => finish(data));
  process.stdin.on("error", () => finish(""));
});

function stateDir() {
  const home = process.env.OPENRIG_HOME || path.join(process.env.HOME || "/tmp", ".openrig");
  return path.join(home, "state", "gateguard");
}

// Keep the session id inside the state directory. Safe ids stay readable.
// Any other id (separators, "..", empty, too long) becomes a hash.
function sessionFileName(sessionId) {
  const id = String(sessionId);
  if (/^[A-Za-z0-9._-]+$/.test(id) && !/^\.+$/.test(id) && id.length <= MAX_SESSION_FILE_LENGTH) {
    return id;
  }
  return "h-" + crypto.createHash("sha256").update(id).digest("hex").slice(0, 32);
}

function statePath(dir, sessionId) {
  return path.join(dir, `${sessionFileName(sessionId)}.json`);
}

function readDenied(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")).deniedThisTurn === true;
  } catch {
    return false;
  }
}

function writeDenied(file, deniedThisTurn) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ deniedThisTurn }));
}

// Test file: a path segment test/tests/__tests__, or a basename with .test. or .spec.
function isTestPath(filePath) {
  const normalized = String(filePath).replace(/\\/g, "/");
  if (/(^|\/)(test|tests|__tests__)\//.test(normalized)) return true;
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  return base.includes(".test.") || base.includes(".spec.");
}

function lineCount(value) {
  return typeof value === "string" && value.length > 0 ? value.split("\n").length : 0;
}

// Changed-line rule, per tool:
//   Edit         max(lines in old_string, lines in new_string)
//   MultiEdit    sum of that value over every entry in edits[]
//   Write        lines in content
//   NotebookEdit lines in new_source
// An edit is trivial when the count is below TRIVIAL_LINE_LIMIT.
function changedLines(toolName, input) {
  switch (toolName) {
    case "Edit":
      return Math.max(lineCount(input.old_string), lineCount(input.new_string));
    case "MultiEdit":
      return (Array.isArray(input.edits) ? input.edits : []).reduce(
        (sum, edit) => sum + Math.max(lineCount(edit?.old_string), lineCount(edit?.new_string)),
        0,
      );
    case "Write":
      return lineCount(input.content);
    default:
      return lineCount(input.new_source);
  }
}

function logEvent(dir, event) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, EVENT_LOG_NAME),
      JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n",
    );
  } catch {
    // The event log must never change the decision.
  }
}

function parseInput(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function deny() {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: DENY_REASON,
    },
  }));
}

async function main() {
  if (!gateEnabled(process.env.OPENRIG_GATEGUARD)) return;
  const input = parseInput(await readStdin());
  const dir = stateDir();
  const sessionId = input && typeof input.session_id === "string" ? input.session_id : "";

  if (process.argv.includes("--reset")) {
    if (sessionId) writeDenied(statePath(dir, sessionId), false);
    return;
  }

  const tool = input && typeof input.tool_name === "string" ? input.tool_name : "";
  if (!input || !sessionId) {
    logEvent(dir, { session: sessionId, tool, file: "", decision: "allow-error" });
    return;
  }
  if (!GATED_TOOLS.has(tool)) return;

  const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  const file = String(toolInput.file_path || toolInput.notebook_path || "");
  const record = (decision) => logEvent(dir, { session: sessionId, tool, file, decision });

  if (isTestPath(file)) return record("allow-bypass-test");
  if (changedLines(tool, toolInput) < TRIVIAL_LINE_LIMIT) return record("allow-bypass-trivial");

  const stateFile = statePath(dir, sessionId);
  if (readDenied(stateFile)) return record("allow-second");

  // Persist the marker before denying. If it cannot be saved, allow instead
  // of denying on every attempt.
  writeDenied(stateFile, true);
  record("deny");
  deny();
}

main().catch(() => {
  try { logEvent(stateDir(), { session: "", tool: "", file: "", decision: "allow-error" }); } catch {}
}).finally(() => process.exit(0));
