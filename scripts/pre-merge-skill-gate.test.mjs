// Tests for scripts/hooks/pre-merge-skill-gate.sh (RIG-176 must-fix fixes).
// Covers: M1 (^bypass: anchor), M2 (gh api fail-closed), M5 (empty HEAD_SHA fail-closed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const GATE = resolve("scripts/hooks/pre-merge-skill-gate.sh");
const SHA = "abc1234def5678901234567890123456789012345678";

function makeEnv(binDir) {
  return { ...process.env, PATH: `${binDir}:${process.env.PATH}`, SKILL_GATE_REPO: "owner/repo" };
}

function writeGh(binDir, { headSha = SHA, filesOutput = null, apiFails = false } = {}) {
  const ghBin = join(binDir, "gh");
  const filesLines = filesOutput !== null
    ? filesOutput.map((f) => JSON.stringify(f)).join("\\n") + "\\n"
    : `.claude/skills/my-skill/SKILL.md\\n`;

  writeFileSync(ghBin, `#!/usr/bin/env node
const args = process.argv.slice(2).join(' ');
if (args.includes('nameWithOwner')) {
  process.stdout.write('owner/repo\\n');
} else if (args.includes('--paginate') && args.includes('/files')) {
  ${apiFails
    ? `process.stderr.write('gh api: simulated failure\\n'); process.exit(1);`
    : `process.stdout.write(\`${filesLines}\`);`
  }
} else if (args.includes('headRefOid')) {
  ${headSha
    ? `process.stdout.write(${JSON.stringify(headSha)} + '\\n');`
    : `process.stdout.write('\\n');`
  }
} else {
  process.stderr.write('fake-gh: unhandled: ' + args + '\\n');
  process.exit(1);
}
`, { mode: 0o755 });
}

function runGate(projectDir, binDir, prNum = "42") {
  return spawnSync("bash", [GATE, prNum, projectDir], {
    encoding: "utf8",
    env: makeEnv(binDir),
  });
}

function writeGateFile(projectDir, content) {
  const dir = join(projectDir, ".ai", "status");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "skill-gate-pr42.md"), content);
}

// ─── M5: empty HEAD_SHA → fail-closed ───────────────────────────────────────

test("M5: empty HEAD_SHA exits 2 (fail-closed)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "gate-test-"));
  try {
    const binDir = join(tmp, "bin");
    mkdirSync(binDir);
    writeGh(binDir, { headSha: "" });
    const result = runGate(tmp, binDir);
    assert.equal(result.status, 2, `expected exit 2, got ${result.status}.\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /head SHA/, "error must mention head SHA");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── M2: gh api failure → fail-closed ───────────────────────────────────────

test("M2: gh api failure exits 2 (fail-closed)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "gate-test-"));
  try {
    const binDir = join(tmp, "bin");
    mkdirSync(binDir);
    writeGh(binDir, { apiFails: true });
    const result = runGate(tmp, binDir);
    assert.equal(result.status, 2, `expected exit 2, got ${result.status}.\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /gh api call failed/, "error must mention gh api failure");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── M1: unanchored bypass: inside text must not bypass ─────────────────────

test("M1: bypass: mid-line in gate file does not bypass (anchor required)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "gate-test-"));
  try {
    const binDir = join(tmp, "bin");
    mkdirSync(binDir);
    writeGh(binDir);
    // Gate file has 'bypass:' embedded inside another value — must NOT match '^bypass:'
    writeGateFile(tmp, `approved: not a bypass: case\napproved-sha: ${SHA}\n`);
    const result = runGate(tmp, binDir);
    // Should be blocked (no standalone ^bypass:) but approved: and sha match so it should PASS
    // Actually this test verifies the bypass check: 'bypass:' mid-line is ignored.
    // The gate file above has valid approved: and approved-sha: so it should exit 0 (approved).
    assert.equal(result.status, 0, `expected exit 0 (valid approval), got ${result.status}.\nstderr: ${result.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("M1: ^bypass: on its own line bypasses the gate", () => {
  const tmp = mkdtempSync(join(tmpdir(), "gate-test-"));
  try {
    const binDir = join(tmp, "bin");
    mkdirSync(binDir);
    writeGh(binDir);
    writeGateFile(tmp, `bypass: emergency hotfix\n`);
    const result = runGate(tmp, binDir);
    assert.equal(result.status, 0, `expected exit 0 (bypass), got ${result.status}.\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /bypass accepted/, "success message must mention bypass");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("M1: text containing 'bypass:' not at start of line does not bypass (blocked)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "gate-test-"));
  try {
    const binDir = join(tmp, "bin");
    mkdirSync(binDir);
    writeGh(binDir);
    // Gate file has no approved: or bypass: on its own line — should block
    writeGateFile(tmp, `reason: not a bypass: this should block\n`);
    const result = runGate(tmp, binDir);
    assert.equal(result.status, 2, `expected exit 2 (blocked), got ${result.status}.\nstderr: ${result.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── SHA binding ─────────────────────────────────────────────────────────────

test("SHA mismatch exits 2 (PR moved after approval)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "gate-test-"));
  try {
    const binDir = join(tmp, "bin");
    mkdirSync(binDir);
    writeGh(binDir);  // HEAD_SHA = SHA
    writeGateFile(tmp, `approved: canary-verified\napproved-sha: deadbeef0000000000000000000000000000000000\n`);
    const result = runGate(tmp, binDir);
    assert.equal(result.status, 2, `expected exit 2, got ${result.status}.\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /head has moved/, "error must mention SHA mismatch");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("matching SHA + approved: exits 0 (gate cleared)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "gate-test-"));
  try {
    const binDir = join(tmp, "bin");
    mkdirSync(binDir);
    writeGh(binDir);
    writeGateFile(tmp, `approved: canary-verified\napproved-sha: ${SHA}\n`);
    const result = runGate(tmp, binDir);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}.\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /skill-file approval confirmed/, "success message expected");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── No skill files ───────────────────────────────────────────────────────────

test("no skill files exits 0 (gate not required)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "gate-test-"));
  try {
    const binDir = join(tmp, "bin");
    mkdirSync(binDir);
    writeGh(binDir, { filesOutput: ["src/index.ts", "scripts/helper.mjs"] });
    const result = runGate(tmp, binDir);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}.\nstderr: ${result.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
