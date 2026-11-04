// Tests for classifier-drift-report.mjs (RIG-175)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const DRIFT_REPORT = fileURLToPath(new URL("./classifier-drift-report.mjs", import.meta.url));

function writePrediction(opts = {}) {
  return JSON.stringify({
    event: "prediction",
    version: 1,
    timestamp: new Date().toISOString(),
    pr: opts.pr ?? 1,
    repo: opts.repo ?? "owner/repo",
    sha: opts.sha ?? "abc123",
    level: opts.level ?? "moderate",
    reason: opts.reason ?? "test",
    override: null,
    inputs: {
      diffSize: opts.diffSize ?? 150,
      additions: opts.additions ?? 100,
      deletions: opts.deletions ?? 50,
      totalFiles: opts.totalFiles ?? 2,
      kindCounts: { test: 0, docs: 0, source: 2, config: 0, migration: 0, other: 0 },
      testFileRatio: 0,
      shellSourceFiles: 0,
      ...(opts.inputs ?? {}),
    },
  });
}

function writeOutcome(opts = {}) {
  return JSON.stringify({
    event: "outcome",
    version: 1,
    timestamp: new Date().toISOString(),
    pr: opts.pr ?? 1,
    repo: opts.repo ?? "owner/repo",
    sha: opts.sha ?? "merge123",
    review_cycles: opts.review_cycles ?? 1,
    must_fix_count: opts.must_fix_count ?? 0,
    merge_result: opts.merge_result ?? "merged",
    time_to_merge_min: opts.time_to_merge_min ?? null,
  });
}

test("drift report: exits 0 and prints summary with prediction-only data", () => {
  const tmp = mkdtempSync(join(tmpdir(), "rig175-drift-"));
  try {
    const logPath = join(tmp, "classifications.jsonl");
    writeFileSync(logPath, [
      writePrediction({ pr: 1, level: "moderate" }),
      writePrediction({ pr: 2, level: "high" }),
      writePrediction({ pr: 3, level: "trivial" }),
    ].join("\n") + "\n");

    const result = spawnSync(process.execPath, [DRIFT_REPORT, "--log-dir", tmp], { encoding: "utf8" });
    assert.equal(result.status, 0, `drift-report exited non-zero: ${result.stderr}`);
    assert.ok(result.stdout.includes("Total predictions: 3"), "summary must show 3 predictions");
    assert.ok(result.stdout.includes("Outcome events: 0"), "summary must show 0 outcome events");
    assert.ok(result.stdout.includes("No outcome events found"), "data quality note must mention missing outcomes");
    assert.ok(result.stdout.includes("No mismatches detected"), "no mismatches without outcomes");
    assert.ok(result.stdout.includes("No threshold changes proposed"), "no proposals without outcomes");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("drift report: detects trivial mismatch (must_fix > 0)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "rig175-drift-"));
  try {
    const logPath = join(tmp, "classifications.jsonl");
    writeFileSync(logPath, [
      writePrediction({ pr: 10, level: "trivial" }),
      writeOutcome({ pr: 10, must_fix_count: 2 }),
    ].join("\n") + "\n");

    const result = spawnSync(process.execPath, [DRIFT_REPORT, "--log-dir", tmp], { encoding: "utf8" });
    assert.equal(result.status, 0, `drift-report exited non-zero: ${result.stderr}`);
    assert.ok(result.stdout.includes("PR #10"), "mismatch report must name the PR");
    assert.ok(result.stdout.includes("must_fix=2"), "mismatch must state must_fix signal");
    assert.ok(result.stdout.includes("trivial prediction but had must-fix"), "mismatch note must name the issue");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("drift report: detects moderate mismatch (review_cycles > 2)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "rig175-drift-"));
  try {
    const logPath = join(tmp, "classifications.jsonl");
    writeFileSync(logPath, [
      writePrediction({ pr: 20, level: "moderate" }),
      writeOutcome({ pr: 20, review_cycles: 3 }),
    ].join("\n") + "\n");

    const result = spawnSync(process.execPath, [DRIFT_REPORT, "--log-dir", tmp], { encoding: "utf8" });
    assert.equal(result.status, 0, `drift-report exited non-zero: ${result.stderr}`);
    assert.ok(result.stdout.includes("PR #20"), "mismatch report must name the PR");
    assert.ok(result.stdout.includes("review_cycles=3"), "mismatch must state review_cycles signal");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("drift report: detects high mismatch (must_fix=0, merged)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "rig175-drift-"));
  try {
    const logPath = join(tmp, "classifications.jsonl");
    writeFileSync(logPath, [
      writePrediction({ pr: 30, level: "high" }),
      writeOutcome({ pr: 30, must_fix_count: 0, merge_result: "merged" }),
    ].join("\n") + "\n");

    const result = spawnSync(process.execPath, [DRIFT_REPORT, "--log-dir", tmp], { encoding: "utf8" });
    assert.equal(result.status, 0, `drift-report exited non-zero: ${result.stderr}`);
    assert.ok(result.stdout.includes("PR #30"), "mismatch report must name the PR");
    assert.ok(result.stdout.includes("must_fix=0, merged"), "mismatch must state signal");
    assert.ok(result.stdout.includes("over-sensitive"), "mismatch note must name over-sensitivity");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("drift report: flags legacy rows (no event field) in data quality notes", () => {
  const tmp = mkdtempSync(join(tmpdir(), "rig175-drift-"));
  try {
    const logPath = join(tmp, "classifications.jsonl");
    // Legacy row: no event field
    const legacyRow = JSON.stringify({
      timestamp: new Date().toISOString(),
      pr: 99,
      level: "moderate",
      reason: "legacy",
      override: null,
      inputs: { diffSize: 100 },
    });
    writeFileSync(logPath, legacyRow + "\n");

    const result = spawnSync(process.execPath, [DRIFT_REPORT, "--log-dir", tmp], { encoding: "utf8" });
    assert.equal(result.status, 0, `drift-report exited non-zero: ${result.stderr}`);
    assert.ok(result.stdout.includes("pre-RIG-175 format"), "data quality note must flag legacy rows");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("drift report: exits 0 with message when log file is missing", () => {
  const tmp = mkdtempSync(join(tmpdir(), "rig175-drift-"));
  try {
    const result = spawnSync(process.execPath, [DRIFT_REPORT, "--log-dir", tmp], { encoding: "utf8" });
    assert.equal(result.status, 0, "must exit 0 on missing log");
    assert.ok(result.stdout.includes("No classification events found"), "must print the missing-log message");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("drift report: null-repo prediction joins outcome via PR-number fallback (MF2)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "rig175-drift-"));
  try {
    const logPath = join(tmp, "classifications.jsonl");
    // Prediction has no repo (pre-RIG-175 or repo-resolution failure)
    const prediction = JSON.stringify({
      event: "prediction", version: 1, timestamp: new Date().toISOString(),
      pr: 42, repo: null, sha: null,
      level: "trivial", reason: "docs-only", override: null,
      inputs: { diffSize: 10, additions: 10, deletions: 0, totalFiles: 1,
        kindCounts: { test: 0, docs: 1, source: 0, config: 0, migration: 0, other: 0 },
        testFileRatio: 0, shellSourceFiles: 0 },
    });
    // Outcome has repo (written at merge time)
    const outcome = writeOutcome({ pr: 42, repo: "owner/repo", must_fix_count: 1 });
    writeFileSync(logPath, [prediction, outcome].join("\n") + "\n");

    const result = spawnSync(process.execPath, [DRIFT_REPORT, "--log-dir", tmp], { encoding: "utf8" });
    assert.equal(result.status, 0, `drift-report exited non-zero: ${result.stderr}`);
    // MF2 fix: null-repo prediction must still find the outcome and register the mismatch
    assert.ok(result.stdout.includes("PR #42"), "null-repo prediction must match outcome via PR-number fallback");
    assert.ok(result.stdout.includes("must_fix=1"), "mismatch signal must be reported");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("drift report: accuracy denominator counts joined pairs not total outcome rows (MF1+MF3)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "rig175-drift-"));
  try {
    const logPath = join(tmp, "classifications.jsonl");
    // 3 outcome rows but only 2 have matching predictions — no mismatches
    writeFileSync(logPath, [
      writePrediction({ pr: 1, level: "moderate" }),
      writeOutcome({ pr: 1, review_cycles: 1, must_fix_count: 0 }),
      writePrediction({ pr: 2, level: "moderate" }),
      writeOutcome({ pr: 2, review_cycles: 1, must_fix_count: 0 }),
      // Outcome with no matching prediction — must not inflate denominator
      writeOutcome({ pr: 99, review_cycles: 0, must_fix_count: 0, merge_result: "merged" }),
    ].join("\n") + "\n");

    const result = spawnSync(process.execPath, [DRIFT_REPORT, "--log-dir", tmp], { encoding: "utf8" });
    assert.equal(result.status, 0, `drift-report exited non-zero: ${result.stderr}`);
    // 3 outcome rows but only 2 joined → accuracy should be 100% (2 joined, 0 mismatches)
    // If MF1+MF3 bug persists, denominator would be 3 and accuracy "66.7%"
    assert.ok(result.stdout.includes("100.0%"), "accuracy must use joined count (2), not total outcomes (3)");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
