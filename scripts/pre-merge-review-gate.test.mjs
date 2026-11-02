// Tests for ~/.claude/hooks/pre-merge-review-gate.sh (RIG-178 fixes).
// Covers: D (tool_input.command parsing), A (empty PR fail-closed), B (anchored ^bypass:).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

const HOOK = join(homedir(), ".claude/hooks/pre-merge-review-gate.sh");

function makeInput(command, useNestedFormat = true) {
  if (useNestedFormat) {
    return JSON.stringify({ tool_input: { command } });
  }
  return JSON.stringify({ command });
}

function runHook(input, projectDir) {
  return spawnSync("bash", [HOOK], {
    input,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });
}

function writeReviewFile(projectDir, prNum, content) {
  const dir = join(projectDir, ".ai", "status");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `review-pr${prNum}.md`), content);
}

// ─── D: tool_input.command input format ──────────────────────────────────────

test("D: nested tool_input.command is parsed (happy path → exits 0)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "rg-test-"));
  try {
    writeReviewFile(tmp, "42", "✅ complete\n");
    const result = runHook(makeInput("gh pr merge 42 --squash", true), tmp);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}.\nstderr: ${result.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("D: top-level command fallback still works (legacy format)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "rg-test-"));
  try {
    writeReviewFile(tmp, "42", "✅ complete\n");
    const result = runHook(makeInput("gh pr merge 42 --squash", false), tmp);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}.\nstderr: ${result.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("D: non-merge command exits 0 (hook is not a merge guard for other commands)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "rg-test-"));
  try {
    const result = runHook(makeInput("gh pr view 42"), tmp);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}.\nstderr: ${result.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── A: empty PR number → fail-closed ────────────────────────────────────────

test("A: gh pr merge with no number exits 2 (fail-closed)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "rg-test-"));
  try {
    const result = runHook(makeInput("gh pr merge --squash --auto"), tmp);
    assert.equal(result.status, 2, `expected exit 2, got ${result.status}.\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /could not extract PR number/, "error must mention PR number extraction");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("A: bare 'gh pr merge' with no args exits 2", () => {
  const tmp = mkdtempSync(join(tmpdir(), "rg-test-"));
  try {
    const result = runHook(makeInput("gh pr merge"), tmp);
    assert.equal(result.status, 2, `expected exit 2, got ${result.status}.\nstderr: ${result.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── B: anchored ^bypass: ────────────────────────────────────────────────────

test("B: bypass: mid-line does not bypass gate (must be at line start)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "rg-test-"));
  try {
    writeReviewFile(tmp, "42", "note: this is not a bypass: case\n");
    const result = runHook(makeInput("gh pr merge 42"), tmp);
    assert.equal(result.status, 2, `expected exit 2 (blocked), got ${result.status}.\nstderr: ${result.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("B: ^bypass: on its own line passes the gate", () => {
  const tmp = mkdtempSync(join(tmpdir(), "rg-test-"));
  try {
    writeReviewFile(tmp, "42", "bypass: emergency hotfix — CEO approved\n");
    const result = runHook(makeInput("gh pr merge 42"), tmp);
    assert.equal(result.status, 0, `expected exit 0 (bypass), got ${result.status}.\nstderr: ${result.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── Completion markers ───────────────────────────────────────────────────────

test("✅ complete marker exits 0", () => {
  const tmp = mkdtempSync(join(tmpdir(), "rg-test-"));
  try {
    writeReviewFile(tmp, "99", "✅ complete\n");
    const result = runHook(makeInput("gh pr merge 99 --squash"), tmp);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}.\nstderr: ${result.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("dual-stack marker exits 0", () => {
  const tmp = mkdtempSync(join(tmpdir(), "rg-test-"));
  try {
    writeReviewFile(tmp, "55", "dual-stack review complete\n");
    const result = runHook(makeInput("gh pr merge 55"), tmp);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}.\nstderr: ${result.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("no review file exits 2", () => {
  const tmp = mkdtempSync(join(tmpdir(), "rg-test-"));
  try {
    const result = runHook(makeInput("gh pr merge 42"), tmp);
    assert.equal(result.status, 2, `expected exit 2, got ${result.status}.\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /No \/code-review-dual evidence/, "error must mention missing evidence");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("review file exists but no completion marker exits 2", () => {
  const tmp = mkdtempSync(join(tmpdir(), "rg-test-"));
  try {
    writeReviewFile(tmp, "42", "Review still in progress.\n");
    const result = runHook(makeInput("gh pr merge 42"), tmp);
    assert.equal(result.status, 2, `expected exit 2, got ${result.status}.\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /no completion marker/, "error must mention missing marker");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
