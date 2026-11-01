// Tests for pr-risk-classifier.mjs — pure-function unit tests (RIG-176) plus a
// subprocess integration test for the skillFileGate output using a fake gh stub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { isSkillFile, fileKind, classify } from "./pr-risk-classifier.mjs";

const CLASSIFIER = fileURLToPath(new URL("./pr-risk-classifier.mjs", import.meta.url));

// ─── isSkillFile ────────────────────────────────────────────────────────────

test("isSkillFile — root-level skills/ .md is a skill file", () => {
  assert.equal(isSkillFile("skills/my-skill.md"), true);
});

test("isSkillFile — nested .claude/skills/ .md is a skill file", () => {
  assert.equal(isSkillFile(".claude/skills/my-skill/SKILL.md"), true);
});

test("isSkillFile — deep canonical path is a skill file", () => {
  assert.equal(isSkillFile("skills/_canonical/factory-loop/SKILL.md"), true);
});

test("isSkillFile — sub-path mid-tree is a skill file", () => {
  assert.equal(isSkillFile("packages/openrig-core/skills/some-skill.md"), true);
});

test("isSkillFile — non-.md under skills/ is not a skill file", () => {
  assert.equal(isSkillFile("skills/foo.ts"), false);
  assert.equal(isSkillFile("skills/helper.js"), false);
});

test("isSkillFile — .md outside skills/ is not a skill file", () => {
  assert.equal(isSkillFile("docs/guide.md"), false);
  assert.equal(isSkillFile("README.md"), false);
  assert.equal(isSkillFile("packages/daemon/CHANGES.md"), false);
});

test("isSkillFile — xskills/ prefix does not match skills/", () => {
  assert.equal(isSkillFile("xskills/foo.md"), false);
});

// ─── fileKind ───────────────────────────────────────────────────────────────

test("fileKind — TypeScript source", () => {
  assert.equal(fileKind("src/index.ts"), "source");
  assert.equal(fileKind("packages/cli/src/commands/provider.ts"), "source");
});

test("fileKind — test files", () => {
  assert.equal(fileKind("scripts/pr-risk-classifier.test.mjs"), "test");
  assert.equal(fileKind("src/__tests__/foo.ts"), "test");
  assert.equal(fileKind("src/foo.spec.ts"), "test");
});

test("fileKind — markdown docs", () => {
  assert.equal(fileKind("docs/guide.md"), "docs");
  assert.equal(fileKind("README.md"), "docs");
});

test("fileKind — config files", () => {
  assert.equal(fileKind("package.json"), "config");
  assert.equal(fileKind(".eslintrc"), "config");
  assert.equal(fileKind("config/app.yaml"), "config");
});

test("fileKind — migration files", () => {
  assert.equal(fileKind("migrations/001_init.sql"), "migration");
  assert.equal(fileKind("db/migration/add_column.ts"), "migration");
});

// ─── classify ───────────────────────────────────────────────────────────────

function inputs(overrides = {}) {
  return {
    diffSize: 0,
    additions: 0,
    deletions: 0,
    totalFiles: 1,
    kindCounts: { test: 0, docs: 0, source: 0, config: 0, migration: 0, other: 0 },
    testFileRatio: 0,
    ...overrides,
  };
}

test("classify — trivial: docs-only small diff", () => {
  const result = classify(inputs({
    diffSize: 50,
    kindCounts: { test: 0, docs: 2, source: 0, config: 0, migration: 0, other: 0 },
  }));
  assert.equal(result.level, "trivial");
});

test("classify — moderate: bounded source with test coverage", () => {
  const result = classify(inputs({
    diffSize: 200,
    additions: 150,
    deletions: 50,
    totalFiles: 5,
    kindCounts: { test: 2, docs: 0, source: 3, config: 0, migration: 0, other: 0 },
    testFileRatio: 0.4,
  }));
  assert.equal(result.level, "moderate");
});

test("classify — moderate: net-deletion refactor with test coverage", () => {
  const result = classify(inputs({
    diffSize: 400,
    additions: 100,
    deletions: 300,
    totalFiles: 6,
    kindCounts: { test: 2, docs: 0, source: 4, config: 0, migration: 0, other: 0 },
    testFileRatio: 0.33,
  }));
  assert.equal(result.level, "moderate");
});

test("classify — high: migration present", () => {
  const result = classify(inputs({
    diffSize: 50,
    kindCounts: { test: 0, docs: 0, source: 1, config: 0, migration: 1, other: 0 },
  }));
  assert.equal(result.level, "high");
});

test("classify — high: large diff", () => {
  const result = classify(inputs({
    diffSize: 500,
    additions: 300,
    deletions: 200,
    totalFiles: 4,
    kindCounts: { test: 1, docs: 0, source: 3, config: 0, migration: 0, other: 0 },
    testFileRatio: 0.25,
  }));
  assert.equal(result.level, "high");
});

// ─── skillFileGate integration (subprocess with fake gh) ────────────────────

test("subprocess: skill file detected → level forced to high and skillFileGate attached", () => {
  const tmp = mkdtempSync(join(tmpdir(), "rig176-test-"));
  try {
    const ghBin = join(tmp, "gh");
    // Fake gh: responds to every sub-command combination used by the classifier.
    // Commands needed:
    //   gh repo view --json nameWithOwner -q .nameWithOwner
    //   gh api --paginate "repos/.../pulls/42/files" --jq '...'
    //   gh pr view 42 --repo owner/repo --json body,headRefOid --jq '...'
    writeFileSync(ghBin, `#!/usr/bin/env node
const args = process.argv.slice(2).join(' ');
if (args.includes('nameWithOwner')) {
  process.stdout.write('owner/repo\\n');
} else if (args.includes('--paginate') && args.includes('/files')) {
  // Output NDJSON (one JSON object per line) — the classifier uses --jq to project each file.
  const files = [
    { path: '.claude/skills/my-skill/SKILL.md', additions: 5, deletions: 2 },
    { path: 'src/index.ts', additions: 10, deletions: 3 },
  ];
  for (const f of files) process.stdout.write(JSON.stringify(f) + '\\n');
} else if (args.includes('headRefOid')) {
  // Simulate jq "[.body, .headRefOid] | @json" — output the JSON array directly.
  // JSON.parse on this produces ["", "<sha>"] as expected by the classifier.
  const sha = 'abc1234def5678901234567890123456789012345678';
  process.stdout.write(JSON.stringify(['', sha]) + '\\n');
} else {
  process.stderr.write('fake-gh: unhandled: ' + args + '\\n');
  process.exit(1);
}
`, { mode: 0o755 });

    const env = { ...process.env, PATH: `${tmp}:${process.env.PATH}` };
    const result = spawnSync(process.execPath, [CLASSIFIER, "42"], {
      encoding: "utf8",
      env,
    });

    assert.equal(result.status, 0, `classifier exited non-zero: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.level, "high", "skill-file PRs must be classified as high");
    assert.ok(parsed.skillFileGate, "skillFileGate must be present");
    assert.equal(parsed.skillFileGate.required, true);
    assert.deepEqual(parsed.skillFileGate.skillFiles, [".claude/skills/my-skill/SKILL.md"]);
    assert.equal(parsed.skillFileGate.sha, "abc1234def5678901234567890123456789012345678");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("subprocess: no skill files → skillFileGate absent", () => {
  const tmp = mkdtempSync(join(tmpdir(), "rig176-test-"));
  try {
    const ghBin = join(tmp, "gh");
    writeFileSync(ghBin, `#!/usr/bin/env node
const args = process.argv.slice(2).join(' ');
if (args.includes('nameWithOwner')) {
  process.stdout.write('owner/repo\\n');
} else if (args.includes('--paginate') && args.includes('/files')) {
  const files = [
    { path: 'src/index.ts', additions: 10, deletions: 3 },
    { path: 'scripts/helper.mjs', additions: 5, deletions: 1 },
  ];
  for (const f of files) process.stdout.write(JSON.stringify(f) + '\\n');
} else if (args.includes('headRefOid')) {
  const sha = 'abc1234def5678901234567890123456789012345678';
  process.stdout.write(JSON.stringify(['', sha]) + '\\n');
} else {
  process.stderr.write('fake-gh: unhandled: ' + args + '\\n');
  process.exit(1);
}
`, { mode: 0o755 });

    const env = { ...process.env, PATH: `${tmp}:${process.env.PATH}` };
    const result = spawnSync(process.execPath, [CLASSIFIER, "42"], {
      encoding: "utf8",
      env,
    });

    assert.equal(result.status, 0, `classifier exited non-zero: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal("skillFileGate" in parsed, false, "skillFileGate must be absent when no skill files");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
