import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./hooks/post-tool-truncate.sh", import.meta.url));
const hasJq = spawnSync("jq", ["--version"]).status === 0;

function run(input, env = {}) {
  const r = spawnSync("bash", [SCRIPT], { input: typeof input === "string" ? input : JSON.stringify(input), env: { ...process.env, ...env }, encoding: "utf8" });
  return { status: r.status, out: r.stdout, parsed: r.stdout.trim() ? JSON.parse(r.stdout) : null };
}
const bash = (stdout, extra = {}) => ({ tool_name: "Bash", tool_response: { stdout, stderr: "", isImage: false, ...extra } });

test("leaves small output alone (no output, exit 0)", { skip: !hasJq }, () => {
  const r = run(bash("hello"));
  assert.equal(r.status, 0);
  assert.equal(r.out, "");
});

test("output exactly at the cap is not cut", { skip: !hasJq }, () => {
  assert.equal(run(bash("x".repeat(8192))).out, "");
});

test("cuts an over-cap Bash stdout to head + marker + tail and keeps the shape", { skip: !hasJq }, () => {
  const text = "H".repeat(5000) + "M".repeat(9000) + "T".repeat(3000);
  const { parsed, status } = run(bash(text, { stderr: "warn" }));
  assert.equal(status, 0);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PostToolUse");
  const o = parsed.hookSpecificOutput.updatedToolOutput;
  assert.deepEqual(Object.keys(o).sort(), ["isImage", "stderr", "stdout"]);
  assert.equal(o.stderr, "warn");
  assert.ok(o.stdout.startsWith("H".repeat(3072)));
  assert.ok(o.stdout.endsWith("T".repeat(2048)));
  assert.match(o.stdout, /truncated 11880 bytes by post-tool-truncate/);
  assert.ok(o.stdout.length < 5500);
});

test("cuts Read file.content in place", { skip: !hasJq }, () => {
  const { parsed } = run({ tool_name: "Read", tool_response: { type: "text", file: { filePath: "/a", content: "L".repeat(20000), numLines: 1 } } });
  const f = parsed.hookSpecificOutput.updatedToolOutput.file;
  assert.equal(f.filePath, "/a");
  assert.equal(f.numLines, 1);
  assert.match(f.content, /truncated/);
});

test("cuts text blocks of an MCP array response", { skip: !hasJq }, () => {
  const { parsed } = run({ tool_name: "mcp__x__y", tool_response: [{ type: "text", text: "a".repeat(9000) }, { type: "text", text: "short" }] });
  const o = parsed.hookSpecificOutput.updatedToolOutput;
  assert.match(o[0].text, /truncated/);
  assert.equal(o[1].text, "short");
});

test("cuts a plain string response", { skip: !hasJq }, () => {
  const { parsed } = run({ tool_name: "WebFetch", tool_response: "w".repeat(10000) });
  assert.match(parsed.hookSpecificOutput.updatedToolOutput, /truncated/);
});

test("does not touch image output", { skip: !hasJq }, () => {
  assert.equal(run(bash("i".repeat(20000), { isImage: true })).out, "");
});

test("fails open: bad JSON, empty input and a missing tool_response all exit 0 with no output", { skip: !hasJq }, () => {
  for (const input of ["not json", "", "{}", '{"tool_name":"Bash"}']) {
    const r = run(input);
    assert.equal(r.status, 0, input);
    assert.equal(r.out, "", input);
  }
});

test("fails open with a non-numeric tunable", { skip: !hasJq }, () => {
  const r = run(bash("x".repeat(20000)), { OPENRIG_TRUNCATE_CAP: "abc" });
  assert.equal(r.status, 0);
  assert.equal(r.out, "");
});

test("OPENRIG_TRUNCATE_DISABLE=1 turns the hook off", { skip: !hasJq }, () => {
  assert.equal(run(bash("x".repeat(20000)), { OPENRIG_TRUNCATE_DISABLE: "1" }).out, "");
});

test("OPENRIG_TRUNCATE_CAP lowers the cap", { skip: !hasJq }, () => {
  const { parsed } = run(bash("x".repeat(500)), { OPENRIG_TRUNCATE_CAP: "100", OPENRIG_TRUNCATE_HEAD: "20", OPENRIG_TRUNCATE_TAIL: "10" });
  assert.match(parsed.hookSpecificOutput.updatedToolOutput.stdout, /truncated 470 bytes/);
});

test("fails open when jq is missing from PATH", () => {
  const r = spawnSync("/bin/bash", [SCRIPT], { input: JSON.stringify(bash("x".repeat(20000))), env: { PATH: "/nonexistent" }, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("runs in well under the 100 ms budget per call", { skip: !hasJq }, () => {
  const input = JSON.stringify(bash("x".repeat(40000)));
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 5; i++) spawnSync("bash", [SCRIPT], { input });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 5;
  assert.ok(ms < 100, `mean ${ms.toFixed(1)} ms`);
});
