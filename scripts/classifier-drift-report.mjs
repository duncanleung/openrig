#!/usr/bin/env node
/**
 * scripts/classifier-drift-report.mjs
 *
 * Reads ~/.claude/logs/merge-classifier/classifications.jsonl, joins prediction
 * events with outcome events (when present), detects calibration drift, and
 * proposes threshold edits with evidence.
 *
 * Usage: node scripts/classifier-drift-report.mjs [--log-dir /path/to/dir]
 *
 * Does NOT auto-apply threshold changes — outputs a structured report only.
 *
 * ---
 * Outcome event schema (written by factory-loop merge step or post-merge hook):
 *
 *   {
 *     event: "outcome",
 *     version: 1,
 *     timestamp: <ISO 8601>,
 *     pr: <number>,
 *     repo: <string>,          // owner/repo
 *     sha: <string>,           // merge commit SHA
 *     review_cycles: <number>, // count of review→fix rounds
 *     must_fix_count: <number>,// total must-fix findings across all cycles
 *     merge_result: "merged" | "closed" | "abandoned",
 *     time_to_merge_min: <number | null>
 *   }
 *
 * Prediction event schema (written by pr-risk-classifier.mjs):
 *
 *   {
 *     event: "prediction",
 *     version: 1,
 *     timestamp: <ISO 8601>,
 *     pr: <number>,
 *     repo: <string | null>,
 *     sha: <string | null>,    // PR head SHA at classification time
 *     level: "trivial" | "moderate" | "high",
 *     reason: <string>,
 *     override: <string | null>,
 *     inputs: {
 *       diffSize, additions, deletions, totalFiles,
 *       kindCounts: { test, docs, source, config, migration, other },
 *       testFileRatio, shellSourceFiles
 *     }
 *   }
 */

import { readFileSync, existsSync } from "fs";
import { homedir } from "os";

// ── Helpers ──────────────────────────────────────────────────────────────────

function readJsonlFile(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch {
        process.stderr.write(`[drift-report] Skipping malformed JSONL at line ${i + 1}\n`);
        return null;
      }
    })
    .filter(Boolean);
}

/** Build a join key: "repo:pr" if repo present, else "pr". */
function joinKey(row) {
  return row.repo ? `${row.repo}:${row.pr}` : String(row.pr);
}

// ── Core logic ────────────────────────────────────────────────────────────────

function buildReport(rows) {
  const predictions = rows.filter((r) => r.event === "prediction" || !r.event); // legacy rows lack event
  const outcomes = rows.filter((r) => r.event === "outcome");

  const outcomeMap = new Map();
  for (const o of outcomes) outcomeMap.set(joinKey(o), o);

  // ── Summary stats by predicted level ──────────────────────────────────────
  const stats = {
    trivial: { count: 0, withOutcome: 0, mustFixTotal: 0, reviewCyclesTotal: 0, diffSizes: [] },
    moderate: { count: 0, withOutcome: 0, mustFixTotal: 0, reviewCyclesTotal: 0, diffSizes: [] },
    high: { count: 0, withOutcome: 0, mustFixTotal: 0, reviewCyclesTotal: 0, diffSizes: [] },
  };

  const mismatches = [];

  for (const p of predictions) {
    const level = p.level ?? "unknown";
    if (!stats[level]) continue;
    const s = stats[level];
    s.count++;
    if (p.inputs?.diffSize != null) s.diffSizes.push(p.inputs.diffSize);

    const outcome = outcomeMap.get(joinKey(p));
    if (!outcome) continue;
    s.withOutcome++;
    s.mustFixTotal += outcome.must_fix_count ?? 0;
    s.reviewCyclesTotal += outcome.review_cycles ?? 0;

    // Mismatch detection
    const cycles = outcome.review_cycles ?? 0;
    const mustFix = outcome.must_fix_count ?? 0;

    if (level === "trivial" && mustFix > 0) {
      mismatches.push({
        pr: p.pr, repo: p.repo ?? null, predicted: level,
        signal: `must_fix=${mustFix}`,
        note: "trivial prediction but had must-fix findings — classifier may be under-sensitive",
      });
    }
    if (level === "moderate" && cycles > 2) {
      mismatches.push({
        pr: p.pr, repo: p.repo ?? null, predicted: level,
        signal: `review_cycles=${cycles}`,
        note: "moderate prediction but required >2 review cycles — may warrant high",
      });
    }
    if (level === "high" && mustFix === 0 && outcome.merge_result === "merged") {
      mismatches.push({
        pr: p.pr, repo: p.repo ?? null, predicted: level,
        signal: "must_fix=0, merged",
        note: "high prediction but merged with 0 must-fix — classifier may be over-sensitive",
      });
    }
  }

  // ── Accuracy ──────────────────────────────────────────────────────────────
  const totalWithOutcome = outcomes.length;
  const mismatchCount = mismatches.length;
  const accuracyPct = totalWithOutcome > 0
    ? (((totalWithOutcome - mismatchCount) / totalWithOutcome) * 100).toFixed(1)
    : null;

  // ── Threshold proposals ───────────────────────────────────────────────────
  const proposals = [];

  // Proposal: MODERATE_MAX_DIFF — if most moderate-predicted PRs with outcomes needed >2 cycles
  // and their diffSize > some lower value, suggest lowering the threshold.
  const moderateDrifted = predictions.filter((p) => {
    if (p.level !== "moderate") return false;
    const o = outcomeMap.get(joinKey(p));
    return o && (o.review_cycles ?? 0) > 2 && (p.inputs?.diffSize ?? 0) > 200;
  });
  if (moderateDrifted.length >= 3) {
    const driftSizes = moderateDrifted.map((p) => p.inputs?.diffSize ?? 0).sort((a, b) => a - b);
    const p50 = driftSizes[Math.floor(driftSizes.length / 2)];
    proposals.push({
      threshold: "MODERATE_MAX_DIFF",
      current: 300,
      proposed: Math.min(p50, 250),
      evidence: `${moderateDrifted.length} moderate PRs with diffSize >${200} required >2 review cycles (p50 diffSize: ${p50})`,
    });
  }

  // Proposal: MODERATE_MIN_TEST_RATIO — if trivial PRs with must-fix findings had low test ratios
  const trivialMustFix = predictions.filter((p) => {
    if (p.level !== "trivial") return false;
    const o = outcomeMap.get(joinKey(p));
    return o && (o.must_fix_count ?? 0) > 0;
  });
  if (trivialMustFix.length >= 2) {
    proposals.push({
      threshold: "TRIVIAL_MAX_DIFF",
      current: 100,
      proposed: 75,
      evidence: `${trivialMustFix.length} trivial-classified PRs had must-fix findings — lower trivial ceiling to tighten gate`,
    });
  }

  return { predictions, outcomes, stats, mismatches, accuracyPct, totalWithOutcome, proposals };
}

function formatReport(report) {
  const { predictions, outcomes, stats, mismatches, accuracyPct, totalWithOutcome, proposals } = report;

  const lines = [];
  lines.push("# Classifier Drift Report");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");

  lines.push("## Summary");
  lines.push(`- Total predictions: ${predictions.length}`);
  lines.push(`- Outcome events: ${outcomes.length}`);
  lines.push(`- Joined (prediction + outcome): ${totalWithOutcome}`);
  if (accuracyPct !== null) {
    lines.push(`- Classification accuracy (no mismatch): ${accuracyPct}%`);
  } else {
    lines.push("- Classification accuracy: insufficient outcome data");
  }
  lines.push("");

  lines.push("## By Level");
  for (const [level, s] of Object.entries(stats)) {
    if (s.count === 0) continue;
    const avgCycles = s.withOutcome > 0 ? (s.reviewCyclesTotal / s.withOutcome).toFixed(1) : "n/a";
    const avgMustFix = s.withOutcome > 0 ? (s.mustFixTotal / s.withOutcome).toFixed(1) : "n/a";
    const diffRange = s.diffSizes.length > 0
      ? `${Math.min(...s.diffSizes)}–${Math.max(...s.diffSizes)}`
      : "n/a";
    lines.push(`### ${level}`);
    lines.push(`- Count: ${s.count} (${s.withOutcome} with outcome)`);
    lines.push(`- Avg review cycles: ${avgCycles}`);
    lines.push(`- Avg must-fix findings: ${avgMustFix}`);
    lines.push(`- Diff size range: ${diffRange}`);
    lines.push("");
  }

  lines.push("## Mismatches");
  if (mismatches.length === 0) {
    lines.push("No mismatches detected.");
  } else {
    for (const m of mismatches) {
      lines.push(`- PR #${m.pr}${m.repo ? ` (${m.repo})` : ""}: predicted **${m.predicted}**, signal: ${m.signal} — ${m.note}`);
    }
  }
  lines.push("");

  lines.push("## Threshold Proposals");
  if (proposals.length === 0) {
    lines.push("No threshold changes proposed (insufficient drift signal or outcome data).");
  } else {
    for (const p of proposals) {
      lines.push(`### ${p.threshold}`);
      lines.push(`- Current value: ${p.current}`);
      lines.push(`- Proposed value: ${p.proposed}`);
      lines.push(`- Evidence: ${p.evidence}`);
      lines.push("");
    }
    lines.push("> **Review required.** These proposals are based on observed patterns. Apply changes");
    lines.push("> manually in `scripts/pr-risk-classifier.mjs` after reviewing the evidence.");
  }
  lines.push("");

  lines.push("## Data Quality Notes");
  const noRepo = predictions.filter((p) => !p.repo).length;
  const noSha = predictions.filter((p) => !p.sha).length;
  const legacy = predictions.filter((p) => !p.event).length;
  if (legacy > 0) lines.push(`- ${legacy} prediction(s) lack the \`event\` field (pre-RIG-175 format; repo/sha not available for join)`);
  if (noRepo > 0) lines.push(`- ${noRepo} prediction(s) lack \`repo\` — joined by PR number only (may collide across repos)`);
  if (noSha > 0) lines.push(`- ${noSha} prediction(s) lack \`sha\` — cannot cross-reference with review metrics`);
  if (outcomes.length === 0) lines.push("- No outcome events found — accuracy and mismatch analysis requires outcome events (written by factory-loop merge step)");

  return lines.join("\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const logDirIdx = args.indexOf("--log-dir");
  const logDir = logDirIdx !== -1
    ? args[logDirIdx + 1]
    : (process.env.CLASSIFIER_LOG_DIR ?? `${homedir()}/.claude/logs/merge-classifier`);

  const logPath = `${logDir}/classifications.jsonl`;
  const rows = readJsonlFile(logPath);

  if (rows.length === 0) {
    console.log(`No classification events found at ${logPath}.`);
    process.exit(0);
  }

  const report = buildReport(rows);
  console.log(formatReport(report));
}

main();
