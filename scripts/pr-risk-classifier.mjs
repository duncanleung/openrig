#!/usr/bin/env node
// Deterministic PR risk classifier. V1 inputs: diff size, FileKind distribution, test-file ratio.
// See RIG-163. ADR-0008 governs LLM classifiers (jev-classifier.ts); this script is rule-based only.
// RIG-176: skill-file detection — any PR touching a skills/ .md file forces high + skillFileGate.
//
// Usage: node scripts/pr-risk-classifier.mjs <PR_NUMBER> [--repo owner/repo]
// Output: JSON { level, inputs, reason, override, skillFileGate? } to stdout.
//   skillFileGate: { required: true, skillFiles: string[], sha: string } — present when skill files detected.
//   The pre-merge-skill-gate.sh hook enforces this gate independently of the risk level.
// Logs every classification to ~/.claude/logs/merge-classifier/classifications.jsonl.
//
// File list: uses gh api --paginate (REST, no 200-file truncation). Falls back to gh pr view --json
// files if the REST call fails (e.g. no repo name available and not in a git repo).

import { execSync } from "child_process";
import { mkdirSync, appendFileSync } from "fs";
import { homedir } from "os";
import { fileURLToPath } from "url";

// Conservative thresholds. Tune down with calibration data after 50+ PRs.
const THRESHOLDS = {
  TRIVIAL_MAX_DIFF: 100,         // total additions+deletions
  MODERATE_MAX_DIFF: 300,
  MODERATE_MIN_TEST_RATIO: 0.20, // fraction of changed files that are tests
  MODERATE_MAX_SOURCE_FILES: 8,
};

/**
 * A skill file is any .md file under a directory named "skills" (at any depth).
 * This covers skills/, .claude/skills/, skills/_canonical/, and similar structures.
 * RIG-176: skill-file PRs require a separate mandatory human approval gate.
 */
export function isSkillFile(path) {
  return /(^|\/)skills\//.test(path) && /\.md$/i.test(path);
}

/** Same regex as jev-classifier.ts fileKind — must stay in sync if that changes. */
export function fileKind(path) {
  const p = path.toLowerCase();
  if (/(^|\/)migrations?\//.test(p)) return "migration";
  if (/(^|\/)(tests?|__tests__)\//.test(p) || /\.(test|spec)\.[a-z0-9]+$/.test(p)) return "test";
  if (/(^|\/)docs?\//.test(p) || /\.(md|mdx|txt|rst)$/.test(p)) return "docs";
  if (/\.(ya?ml|toml|json|ini|env)$/.test(p) || /(^|\/)\.[a-z]+rc$/.test(p)) return "config";
  if (/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|sh|sql|css|html)$/.test(p)) return "source";
  return "other";
}

export function classify(inputs) {
  const { diffSize, additions, deletions, kindCounts, testFileRatio } = inputs;

  // Trivial: no source or migration changes, small diff (docs/tests/config only)
  if (
    kindCounts.source === 0 &&
    kindCounts.migration === 0 &&
    diffSize <= THRESHOLDS.TRIVIAL_MAX_DIFF
  ) {
    return {
      level: "trivial",
      reason: `no source/migration changes; diff ${diffSize} ≤ ${THRESHOLDS.TRIVIAL_MAX_DIFF}`,
    };
  }

  // Moderate: no migrations, bounded diff with test coverage
  if (
    kindCounts.migration === 0 &&
    diffSize <= THRESHOLDS.MODERATE_MAX_DIFF &&
    testFileRatio >= THRESHOLDS.MODERATE_MIN_TEST_RATIO &&
    kindCounts.source <= THRESHOLDS.MODERATE_MAX_SOURCE_FILES
  ) {
    return {
      level: "moderate",
      reason: [
        `no migrations`,
        `diff ${diffSize} ≤ ${THRESHOLDS.MODERATE_MAX_DIFF}`,
        `test ratio ${testFileRatio.toFixed(2)} ≥ ${THRESHOLDS.MODERATE_MIN_TEST_RATIO}`,
        `source files ${kindCounts.source} ≤ ${THRESHOLDS.MODERATE_MAX_SOURCE_FILES}`,
      ].join("; "),
    };
  }

  // Net-deletion refactors: deletions exceed additions with good test coverage.
  // Raw diffSize overstates risk when most changes are removals (RIG-171).
  if (
    kindCounts.migration === 0 &&
    deletions > additions &&
    testFileRatio >= THRESHOLDS.MODERATE_MIN_TEST_RATIO &&
    kindCounts.source <= THRESHOLDS.MODERATE_MAX_SOURCE_FILES
  ) {
    return {
      level: "moderate",
      reason: [
        `net-deletion refactor (${additions}+ / ${deletions}-)`,
        `test ratio ${testFileRatio.toFixed(2)} ≥ ${THRESHOLDS.MODERATE_MIN_TEST_RATIO}`,
        `source files ${kindCounts.source} ≤ ${THRESHOLDS.MODERATE_MAX_SOURCE_FILES}`,
      ].join("; "),
    };
  }

  // High: default — list which threshold(s) triggered it
  const triggers = [];
  if (kindCounts.migration > 0) triggers.push(`${kindCounts.migration} migration file(s)`);
  if (diffSize > THRESHOLDS.MODERATE_MAX_DIFF) triggers.push(`diff ${diffSize} > ${THRESHOLDS.MODERATE_MAX_DIFF}`);
  if (kindCounts.source > 0 && testFileRatio < THRESHOLDS.MODERATE_MIN_TEST_RATIO) {
    triggers.push(`test ratio ${testFileRatio.toFixed(2)} < ${THRESHOLDS.MODERATE_MIN_TEST_RATIO}`);
  }
  if (kindCounts.source > THRESHOLDS.MODERATE_MAX_SOURCE_FILES) {
    triggers.push(`source files ${kindCounts.source} > ${THRESHOLDS.MODERATE_MAX_SOURCE_FILES}`);
  }
  return {
    level: "high",
    reason: triggers.length > 0 ? triggers.join("; ") : "default high",
  };
}

function run(cmd) {
  return execSync(cmd, { encoding: "utf8", timeout: 30_000 }).trim();
}

async function main() {
  const args = process.argv.slice(2);
  const prNum = args.find((a) => /^\d+$/.test(a));
  const repoIdx = args.indexOf("--repo");
  const repo = repoIdx !== -1 ? args[repoIdx + 1] : null;
  if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    console.error(`[pr-risk-classifier] Invalid --repo format: ${repo} (expected owner/repo)`);
    process.exit(1);
  }
  const repoFlag = repo ? `--repo ${repo}` : "";

  if (!prNum) {
    console.error("Usage: node scripts/pr-risk-classifier.mjs <PR_NUMBER> [--repo owner/repo]");
    process.exit(1);
  }

  // Resolve repo path for REST API (required for pagination; falls back to gh pr view on error).
  // RIG-176: uses REST API --paginate to avoid the 200-file GraphQL truncation in gh pr view.
  let repoPath = repo;
  if (!repoPath) {
    try {
      repoPath = run(`gh repo view --json nameWithOwner -q .nameWithOwner`);
    } catch {
      repoPath = null;
    }
  }

  // Fetch complete PR file list using paginated REST API (no 200-file cap).
  let files;
  if (repoPath) {
    const filesRaw = run(
      `gh api --paginate "repos/${repoPath}/pulls/${prNum}/files" --jq '.[] | {path: .filename, additions: .additions, deletions: .deletions}'`
    );
    files = filesRaw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } else {
    // Fallback: gh pr view (truncates at 200 files; reachable only when repo cannot be resolved).
    console.error("[pr-risk-classifier] Warning: could not resolve repo; falling back to gh pr view (may truncate at 200 files)");
    const filesRaw = run(`gh pr view ${prNum} ${repoFlag} --json files --jq '.files[]'`);
    files = filesRaw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  // Fetch PR body and head SHA.
  const body = run(`gh pr view ${prNum} ${repoFlag} --json body,headRefOid --jq '[.body, .headRefOid] | @json'`);
  const [prBody, headSha] = JSON.parse(body ?? "[\"\", \"\"]");

  // Compute inputs and detect skill files (RIG-176).
  const kindCounts = { test: 0, docs: 0, source: 0, config: 0, migration: 0, other: 0 };
  let additions = 0;
  let deletions = 0;
  const detectedSkillFiles = [];
  for (const f of files) {
    const kind = fileKind(f.path);
    kindCounts[kind] += 1;
    additions += f.additions ?? 0;
    deletions += f.deletions ?? 0;
    if (isSkillFile(f.path)) detectedSkillFiles.push(f.path);
  }
  const diffSize = additions + deletions;
  const totalFiles = files.length;
  const testFileRatio = totalFiles === 0 ? 0 : Math.min(1, kindCounts.test / totalFiles);

  const inputs = { diffSize, additions, deletions, totalFiles, kindCounts, testFileRatio };

  // Check PR description for manual override
  const overrideMatch = typeof prBody === "string"
    ? prBody.match(/risk_override:\s*(trivial|moderate|high)/i)
    : null;

  let level, reason, override;

  if (overrideMatch) {
    override = overrideMatch[1].toLowerCase();
    level = override;
    const computed = classify(inputs);
    reason = `manual override via risk_override in PR description (computed: ${computed.level} — ${computed.reason})`;
  } else {
    override = null;
    const computed = classify(inputs);
    level = computed.level;
    reason = computed.reason;
  }

  // RIG-176: skill-file gate — force high and attach gate descriptor.
  // This is separate from the risk level: the gate must be cleared regardless of auto-risk-classifier
  // outcome (auto-after-advisor cannot bypass it; only a human-approved gate file clears it).
  let skillFileGate = undefined;
  if (detectedSkillFiles.length > 0) {
    if (level !== "high") {
      level = "high";
      reason = `skill-file gate: ${detectedSkillFiles.length} skill file(s) changed (${detectedSkillFiles.slice(0, 3).join(", ")}${detectedSkillFiles.length > 3 ? ", …" : ""}); elevated from computed level`;
    } else {
      reason = `${reason}; skill-file gate: ${detectedSkillFiles.length} skill file(s) changed`;
    }
    skillFileGate = {
      required: true,
      skillFiles: detectedSkillFiles,
      sha: headSha || null,
    };
  }

  const result = skillFileGate !== undefined
    ? { level, inputs, reason, override, skillFileGate }
    : { level, inputs, reason, override };

  // Log to ~/.claude/logs/merge-classifier/classifications.jsonl
  const logDir = `${homedir()}/.claude/logs/merge-classifier`;
  try {
    mkdirSync(logDir, { recursive: true });
    appendFileSync(
      `${logDir}/classifications.jsonl`,
      JSON.stringify({ timestamp: new Date().toISOString(), pr: parseInt(prNum, 10), ...result }) + "\n",
    );
  } catch (logErr) {
    console.error(`[pr-risk-classifier] Warning: failed to write classification log: ${logErr.message}`);
  }

  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[pr-risk-classifier] Fatal:", err.message);
    process.exit(1);
  });
}
