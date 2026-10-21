import { describe, it, expect } from "vitest";
import {
  applySuppressRules,
  fileGlobMatches,
  findStaleSuppressRules,
  isSuppressExempt,
  isUserAction,
  ruleAppliesToReview,
  ruleMatchesFinding,
  type SuppressRule,
  type SuppressibleFinding,
} from "../src/domain/review-suppress-rules.js";

const REPO = "duncanleung/openrig";

const rule = (over: Partial<SuppressRule> = {}): SuppressRule => ({
  id: 1,
  repo: REPO,
  category: "style",
  fileGlob: null,
  descriptionHash: null,
  reason: "team does not enforce this",
  status: "active",
  quarantinedPr: null,
  createdAt: "2026-10-01 00:00:00",
  lastMatchedAt: null,
  matchCount: 0,
  ...over,
});

const finding = (over: Partial<SuppressibleFinding> = {}): SuppressibleFinding => ({
  findingId: "f-1",
  file: "src/a/b.ts",
  category: "style",
  verdict: "SUGGESTION",
  descriptionHash: "h1",
  ...over,
});

const opts = { repo: REPO, prNumber: 7 };

describe("isUserAction", () => {
  it("accepts the four actions and nothing else", () => {
    for (const a of ["accepted", "dismissed", "fixed-before-merge", "deferred"]) expect(isUserAction(a)).toBe(true);
    for (const a of ["ignored", "", null, 3, undefined]) expect(isUserAction(a)).toBe(false);
  });
});

describe("safety valve", () => {
  it("never suppresses a must-fix verdict, in any spelling", () => {
    for (const verdict of ["MUST_FIX", "must-fix", "Must Fix", " must_fix "]) {
      const f = finding({ verdict });
      const r = applySuppressRules([f], [rule()], opts);
      expect(r.shown).toEqual([f]);
      expect(r.suppressed).toEqual([]);
    }
  });

  it("never suppresses a security finding, in any spelling", () => {
    for (const category of ["security", "Security", " SECURITY "]) {
      const f = finding({ category });
      const r = applySuppressRules([f], [rule({ category: null, fileGlob: "**/*.ts" })], opts);
      expect(r.shown).toEqual([f]);
      expect(r.suppressed).toEqual([]);
    }
  });

  it("isSuppressExempt is false for an ordinary finding", () => {
    expect(isSuppressExempt(finding())).toBe(false);
    expect(isSuppressExempt({ verdict: null, category: null })).toBe(false);
  });

  it("override shows every finding and suppresses nothing", () => {
    const fs = [finding({ findingId: "a" }), finding({ findingId: "b", category: "other" })];
    const r = applySuppressRules(fs, [rule()], { ...opts, override: true });
    expect(r.shown).toEqual(fs);
    expect(r.suppressed).toEqual([]);
    expect(r.overridden).toBe(true);
  });

  it("reports overridden=false without override", () => {
    expect(applySuppressRules([], [], opts).overridden).toBe(false);
  });
});

describe("rule scope", () => {
  it("applies an active rule to the whole repo, with or without a PR", () => {
    expect(ruleAppliesToReview(rule(), { repo: REPO })).toBe(true);
    expect(ruleAppliesToReview(rule(), { repo: REPO, prNumber: 99 })).toBe(true);
  });

  it("applies a quarantined rule only to its source PR", () => {
    const q = rule({ status: "quarantined", quarantinedPr: 7 });
    expect(ruleAppliesToReview(q, { repo: REPO, prNumber: 7 })).toBe(true);
    expect(ruleAppliesToReview(q, { repo: REPO, prNumber: 8 })).toBe(false);
    expect(ruleAppliesToReview(q, { repo: REPO })).toBe(false);
    expect(ruleAppliesToReview(q, { repo: REPO, prNumber: null })).toBe(false);
  });

  it("does not apply a quarantined rule with no source PR", () => {
    const q = rule({ status: "quarantined", quarantinedPr: null });
    expect(ruleAppliesToReview(q, { repo: REPO, prNumber: 7 })).toBe(false);
  });

  it("never applies a retired rule", () => {
    const r = rule({ status: "retired", quarantinedPr: 7 });
    expect(ruleAppliesToReview(r, opts)).toBe(false);
  });

  it("never applies a rule from another repo", () => {
    expect(ruleAppliesToReview(rule({ repo: "someone/else" }), opts)).toBe(false);
    const q = rule({ repo: "someone/else", status: "quarantined", quarantinedPr: 7 });
    expect(ruleAppliesToReview(q, opts)).toBe(false);
  });

  it("keeps a quarantined finding visible on a different PR", () => {
    const f = finding();
    const q = rule({ status: "quarantined", quarantinedPr: 7 });
    expect(applySuppressRules([f], [q], { repo: REPO, prNumber: 8 }).shown).toEqual([f]);
    expect(applySuppressRules([f], [q], { repo: REPO, prNumber: 7 }).shown).toEqual([]);
  });
});

describe("matching", () => {
  it("ANDs every set matcher", () => {
    const r = rule({ category: "style", fileGlob: "src/**/*.ts", descriptionHash: "h1" });
    expect(ruleMatchesFinding(r, finding())).toBe(true);
    expect(ruleMatchesFinding(r, finding({ category: "perf" }))).toBe(false);
    expect(ruleMatchesFinding(r, finding({ file: "lib/x.ts" }))).toBe(false);
    expect(ruleMatchesFinding(r, finding({ descriptionHash: "h2" }))).toBe(false);
  });

  it("matches nothing when the rule has no matcher", () => {
    const r = rule({ category: null });
    expect(ruleMatchesFinding(r, finding())).toBe(false);
    expect(applySuppressRules([finding()], [r], opts).shown).toHaveLength(1);
  });

  it("does not match a file glob against a finding with no file", () => {
    expect(ruleMatchesFinding(rule({ category: null, fileGlob: "*.ts" }), finding({ file: null }))).toBe(false);
  });

  it("compares category case-insensitively", () => {
    expect(ruleMatchesFinding(rule({ category: "Style" }), finding({ category: "STYLE" }))).toBe(true);
  });
});

describe("fileGlobMatches", () => {
  it("matches a slash-less glob against the base name in any directory", () => {
    expect(fileGlobMatches("*_test.go", "pkg/deep/foo_test.go")).toBe(true);
    expect(fileGlobMatches("*_test.go", "foo_test.go")).toBe(true);
    expect(fileGlobMatches("*_test.go", "pkg/foo.go")).toBe(false);
  });

  it("lets ** cross directories and * stay in one", () => {
    expect(fileGlobMatches("src/**/*.ts", "src/a/b/c.ts")).toBe(true);
    expect(fileGlobMatches("src/**/*.ts", "src/c.ts")).toBe(true);
    expect(fileGlobMatches("src/*.ts", "src/a/c.ts")).toBe(false);
  });

  it("matches ? as one non-slash character", () => {
    expect(fileGlobMatches("a?.ts", "ab.ts")).toBe(true);
    expect(fileGlobMatches("src/a?.ts", "src/a/.ts")).toBe(false);
  });

  it("treats a dot as a literal dot", () => {
    expect(fileGlobMatches("a.ts", "axts")).toBe(false);
  });
});

describe("audit shape", () => {
  it("returns the original finding object, the rule id and the reason", () => {
    const f = finding();
    const r = applySuppressRules([f], [rule({ id: 42, reason: "noise" })], opts);
    expect(r.shown).toEqual([]);
    expect(r.suppressed).toHaveLength(1);
    expect(r.suppressed[0]!.finding).toBe(f);
    expect(r.suppressed[0]).toEqual({ finding: f, ruleId: 42, reason: "noise" });
  });

  it("uses the first matching rule and splits shown from suppressed", () => {
    const a = finding({ findingId: "a" });
    const b = finding({ findingId: "b", category: "perf" });
    const r = applySuppressRules([a, b], [rule({ id: 1 }), rule({ id: 2 })], opts);
    expect(r.suppressed.map((s) => s.ruleId)).toEqual([1]);
    expect(r.shown).toEqual([b]);
  });
});

describe("findStaleSuppressRules", () => {
  const runsAfter = (n: number, repo = REPO) =>
    Array.from({ length: n }, (_, i) => ({ repo, startedAt: `2026-10-02 00:00:0${i % 10}` }));

  it("flags a rule at the threshold and reports the run count", () => {
    const s = findStaleSuppressRules([rule()], runsAfter(10), 10);
    expect(s).toHaveLength(1);
    expect(s[0]!.runsSinceMatch).toBe(10);
    expect(findStaleSuppressRules([rule()], runsAfter(9), 10)).toEqual([]);
  });

  it("defaults to 10 runs", () => {
    expect(findStaleSuppressRules([rule()], runsAfter(10))).toHaveLength(1);
    expect(findStaleSuppressRules([rule()], runsAfter(9))).toEqual([]);
  });

  it("counts runs only after the last match", () => {
    const r = rule({ lastMatchedAt: "2026-10-02 00:00:05" });
    expect(findStaleSuppressRules([r], runsAfter(10), 10)).toEqual([]);
  });

  it("skips retired rules", () => {
    expect(findStaleSuppressRules([rule({ status: "retired" })], runsAfter(20), 10)).toEqual([]);
  });

  it("ignores runs of another repo", () => {
    expect(findStaleSuppressRules([rule()], runsAfter(20, "other/repo"), 10)).toEqual([]);
  });

  it("reads SQLite datetime text (no zone) as UTC and also accepts ISO", () => {
    const r = rule({ createdAt: "2026-10-01 00:00:00" });
    const runs = [{ repo: REPO, startedAt: "2026-10-01T00:00:01Z" }, { repo: REPO, startedAt: "2026-10-01T00:00:00Z" }];
    expect(findStaleSuppressRules([r], runs, 1)[0]!.runsSinceMatch).toBe(1);
  });

  it("ignores runs with no start time", () => {
    expect(findStaleSuppressRules([rule()], [{ repo: REPO, startedAt: null }], 1)).toEqual([]);
  });
});
