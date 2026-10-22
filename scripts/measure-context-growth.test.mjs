import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, merge, summarize, resultBytes } from "./measure-context-growth.mjs";

const SCRIPT = fileURLToPath(new URL("./measure-context-growth.mjs", import.meta.url));
const T0 = Date.parse("2026-10-22T12:00:00Z");
const asst = (ts) => JSON.stringify({ type: "assistant", timestamp: ts, message: { content: [] } });
const res = (ts, content) => JSON.stringify({ type: "user", timestamp: ts, message: { content: [{ type: "tool_result", content }] } });
const session = (lines) => lines.join("\n") + "\n";

test("resultBytes counts strings, text blocks and multi-byte text", () => {
  assert.equal(resultBytes("abc"), 3);
  assert.equal(resultBytes([{ type: "text", text: "ab" }, { type: "text", text: "漢" }]), 5);
  assert.equal(resultBytes(undefined), 0);
});

test("splits records at the activation time", () => {
  const r = analyze(session([
    asst("2026-10-22T11:00:00Z"), res("2026-10-22T11:00:01Z", "x".repeat(10000)),
    asst("2026-10-22T13:00:00Z"), res("2026-10-22T13:00:01Z", "y".repeat(100)),
  ]), T0);
  assert.equal(r.before.turns, 1);
  assert.equal(r.before.toolResultBytes, 10000);
  assert.equal(r.before.overCap, 1);
  assert.equal(r.after.turns, 1);
  assert.equal(r.after.toolResultBytes, 100);
  assert.equal(r.after.overCap, 0);
});

test("counts results the hook cut, in string and block form", () => {
  const m = "...[truncated 5 bytes by post-tool-truncate; full output]...";
  const r = analyze(session([res("2026-10-22T13:00:00Z", m), res("2026-10-22T13:00:01Z", [{ type: "text", text: m }])]), T0);
  assert.equal(r.after.truncated, 2);
});

test("skips bad lines and records without a time, never throws", () => {
  const r = analyze(session(["not json", JSON.stringify({ type: "assistant" }), asst("2026-10-22T13:00:00Z")]), T0);
  assert.equal(r.skipped, 2);
  assert.equal(r.after.turns, 1);
});

test("per-turn figures divide by turns and return null with none", () => {
  assert.equal(summarize({ ...merge([]), turns: 4, toolResultBytes: 100, lineBytes: 200 }).toolResultBytesPerTurn, 25);
  assert.equal(summarize(merge([])).toolResultBytesPerTurn, null);
});

test("CLI reports the change between periods as JSON and refuses missing arguments", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcg-"));
  const f = join(dir, "s.jsonl");
  writeFileSync(f, session([
    asst("2026-10-22T11:00:00Z"), res("2026-10-22T11:00:01Z", "x".repeat(1000)),
    asst("2026-10-22T13:00:00Z"), res("2026-10-22T13:00:01Z", "y".repeat(250)),
  ]));
  const ok = spawnSync("node", [SCRIPT, "--activated", "2026-10-22T12:00:00Z", "--json", f], { encoding: "utf8" });
  assert.equal(ok.status, 0);
  const j = JSON.parse(ok.stdout);
  assert.equal(j.before.toolResultBytesPerTurn, 1000);
  assert.equal(j.after.toolResultBytesPerTurn, 250);
  assert.equal(j.toolResultBytesPerTurnChangePercent, 75);
  assert.equal(spawnSync("node", [SCRIPT, f], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync("node", [SCRIPT, "--activated", "nope", f], { encoding: "utf8" }).status, 2);
});
