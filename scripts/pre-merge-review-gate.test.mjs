// Tests for scripts/hooks/pre-merge-review-gate.sh (RIG-178 fixes).
// Covers: D (tool_input.command parsing), A (empty PR fail-closed), B (anchored ^bypass:),
//         C (skill-gate exit propagation).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const HOOK = resolve("scripts/hooks/pre-merge-review-gate.sh");

// Skip all tests on machines where the hook source is absent (e.g. partial clones).
const SKIP = existsSync(HOOK) ? undefined : `hook not found at ${HOOK}`;

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

function writeSkillGate(projectDir, exitCode) {
  const dir = join(projectDir, "scripts", "hooks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "pre-merge-skill-gate.sh"),
    `#!/usr/bin/env bash\nexit ${exitCode}\n`,
    { mode: 0o755 }
  );
}

// ─── D: tool_input.command input format ──────────────────────────────────────

test("D: nested tool_input.command is parsed (happy path → exits 0)", { skip: SKIP }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "rg-test-"));
  try {
    writeReviewFile(tmp, "42", "✅ complete\n");
    const result = runHook(makeInput("gh pr merge 42 --squash", true), tmp);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}.\nstderr: ${result.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("D: top-level command fallback still works (legacy format, happy path)", { skip: SKIP }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "rg-test-"));
  try {
    writeReviewFile(tmp, "42", "✅ complete\n");
    const result = runHook(makeInput("gh pr merge 42 --squash", false), tmp);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}.\nstderr: ${result.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("D: top-level command fallback — missing evidence exits 2", { skip: SKIP }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "rg-test-"));
  try {
    const result = runHook(makeInput("gh pr merge 42", false), tmp);
    assert.equal(result.status, 2, `expected exit 2, got ${result.status}.\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /No \/code-review-dual evidence/, "error must mention missing evidence");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("D: non-merge command exits 0 (not a merge)", { skip: SKIP }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "rg-test-"));
  try {
    const result = runHook(makeInput("gh pr view 42"), tmp);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}.\nstderr: ${result.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── A: empty PR number → fail-closed ────────────────────────────────────────

test("A: command with no PR number exits 2 (fail-closed)", { skip: SKIP }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "rg-test-"));
  try {
    const result = runHook(makeInput("gh pr merge --squash --auto"), tmp);
    assert.equal(result.status, 2, `expected exit 2, got ${result.status}.\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /could not extract PR number/, "error must mention PR number extraction");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("A: bare 'gh pr merge' with no args exits 2", { skip: SKIP }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "rg-test-"));
  try {
    const result = runHook(makeInput("gh pr merge"), tmp);
    assert.equal(result.status, 2, `expected exit 2, got ${result.status}.\nstderr: ${result.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── B: anchored ^bypass: ────────────────────────────────────────────────────

test("B: bypass: mid-line does not bypass gate (must be at line start)", { skip: SKIP }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "rg-test-"));
  try {
    writeReviewFile(tmp, "42", "note: this is not a bypass: case\n");
    const result = runHook(makeInput("gh pr merge 42"), tmp);
    assert.equal(result.status, 2, `expected exit 2 (blocked), got ${result.status}.\nstderr: ${result.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("B: ^bypass: on its own line passes the gate", { skip: SKIP }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "rg-test-"));
  try {
    writeReviewFile(tmp, "42", "bypass: emergency hotfix — CEO approved\n");
    const result = runHook(makeInput("gh pr merge 42"), tmp);
    assert.equal(result.status, 0, `expected exit 0 (bypass), got ${result.status}.\nstderr: ${result.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── C: skill gate delegation exit propagation ───────────────────────────────

test("C: skill gate exits 2 → review gate propagates exit 2", { skip: SKIP }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "rg-test-"));
  try {
    writeReviewFile(tmp, "42", "✅ complete\n");
    writeSkillGate(tmp, 2);
    const result = runHook(makeInput("gh pr merge 42"), tmp);
    assert.equal(result.status, 2, `expected exit 2 (skill gate blocked), got ${result.status}.\nstderr: ${result.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("C: skill gate exits 0 → review gate exits 0", { skip: SKIP }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "rg-test-"));
  try {
    writeReviewFile(tmp, "42", "✅ complete\n");
    writeSkillGate(tmp, 0);
    const result = runHook(makeInput("gh pr merge 42"), tmp);
    assert.equal(result.status, 0, `expected exit 0 (skill gate passed), got ${result.status}.\nstderr: ${result.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── Completion markers and blocked paths ─────────────────────────────────────

test("✅ complete marker exits 0", { skip: SKIP }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "rg-test-"));
  try {
    writeReviewFile(tmp, "99", "✅ complete\n");
    const result = runHook(makeInput("gh pr merge 99 --squash"), tmp);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}.\nstderr: ${result.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("dual-stack marker exits 0", { skip: SKIP }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "rg-test-"));
  try {
    writeReviewFile(tmp, "55", "dual-stack review complete\n");
    const result = runHook(makeInput("gh pr merge 55"), tmp);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}.\nstderr: ${result.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("no review file exits 2", { skip: SKIP }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "rg-test-"));
  try {
    const result = runHook(makeInput("gh pr merge 42"), tmp);
    assert.equal(result.status, 2, `expected exit 2, got ${result.status}.\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /No \/code-review-dual evidence/, "error must mention missing evidence");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("review file exists but no completion marker exits 2", { skip: SKIP }, () => {
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
