import { describe, it, expect } from "vitest";
import {
  validateCorrectionScenario,
  scenarioToEvalCase,
  scoreMemoryComparison,
  runMemoryComparison,
  type CorrectionScenario,
} from "./helpers/eval-memory-comparison.js";
import { FakeProvider } from "./helpers/eval-provider.js";
import { runEvals } from "./helpers/eval-runner.js";

// RIG-110 — the with/without-memory comparison. No model calls: FakeProvider stands in for both seats.

const S1: CorrectionScenario = {
  id: "c1", name: "applies the no-attribution correction", priorCorrection: "Never add Co-Authored-By to commits.",
  prompt: "Commit the change", expectedBehavior: ["git commit"], forbiddenBehavior: ["Co-Authored-By"],
};
const S2: CorrectionScenario = {
  id: "c2", name: "routes a lesson to LEARNED.md", priorCorrection: "Seat lessons belong in LEARNED.md.",
  prompt: "Note this lesson", expectedBehavior: ["lesson"], expectedSurface: "LEARNED\\.md",
};
const S3: CorrectionScenario = {
  id: "c3", name: "uses the fork flag", priorCorrection: "Always pass --repo to gh.",
  prompt: "Open the PR", expectedBehavior: ["gh pr create.*--repo"],
};
const S4: CorrectionScenario = {
  id: "c4", name: "needs no memory", priorCorrection: "Run tests before commit.",
  prompt: "Ship it", expectedBehavior: ["npm test"],
};
const ALL = [S1, S2, S3, S4];

const WITH = new FakeProvider({
  "Commit the change": "git commit -m fix",
  "Note this lesson": "lesson written to LEARNED.md",
  "Open the PR": "gh pr create --repo me/x",
  "Ship it": "npm test && git commit",
});
const WITHOUT = new FakeProvider({
  "Commit the change": "git commit -m fix\nCo-Authored-By: bot",
  "Note this lesson": "lesson written to NOTES.md",
  "Open the PR": "gh pr create",
  "Ship it": "npm test && git commit",
});

describe("validateCorrectionScenario", () => {
  it("accepts a complete scenario", () => {
    expect(validateCorrectionScenario(S2)).toMatchObject({ ok: true });
  });

  it("names every missing field, not just the first", () => {
    const r = validateCorrectionScenario({ id: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = r.errors.map((e) => e.code);
      expect(codes).toEqual(expect.arrayContaining(["PRIOR_CORRECTION_MISSING", "EXPECTED_BEHAVIOR_MISSING", "NAME_MISSING", "PROMPT_MISSING"]));
      expect(codes.filter((c) => c === "EXPECTED_PATTERNS_MISSING")).toHaveLength(0);
    }
  });

  it("rejects a non-regex pattern and a non-string surface", () => {
    const bad = validateCorrectionScenario({ ...S1, expectedBehavior: ["("] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.map((e) => e.code)).toContain("PATTERN_NOT_REGEX");
    const surf = validateCorrectionScenario({ ...S1, expectedSurface: 5 });
    expect(surf.ok).toBe(false);
    if (!surf.ok) expect(surf.errors.map((e) => e.code)).toContain("EXPECTED_SURFACE_NOT_STRING");
  });

  it("rejects a non-object", () => {
    expect(validateCorrectionScenario("x")).toMatchObject({ ok: false });
  });
});

describe("scenarioToEvalCase", () => {
  it("folds the surface into the expected patterns and keeps forbidden behaviour", () => {
    const c = scenarioToEvalCase(S2);
    expect(c.category).toBe("behavior");
    expect(c.expectedPatterns).toEqual(["lesson", "LEARNED\\.md"]);
    expect(scenarioToEvalCase(S1).forbiddenPatterns).toEqual(["Co-Authored-By"]);
  });
});

describe("runMemoryComparison", () => {
  it("scores pass_with - pass_without across the scenarios", async () => {
    const r = await runMemoryComparison(ALL, { withMemory: WITH, withoutMemory: WITHOUT });
    expect(r.total).toBe(4);
    expect(r.scored).toBe(4);
    expect(r.passTreatment).toBe(4);
    expect(r.passBaseline).toBe(1);
    expect(r.rateTreatment).toBe(1);
    expect(r.rateBaseline).toBe(0.25);
    expect(r.improvementScore).toBe(0.75);
    expect(r.improved).toBe(3);
    expect(r.bothPass).toBe(1);
    expect(r.regressed).toBe(0);
    expect(r.scenarios.map((s) => s.verdict)).toEqual(["improved", "improved", "improved", "both_pass"]);
  });

  it("explains each failing scenario", async () => {
    const r = await runMemoryComparison(ALL, { withMemory: WITH, withoutMemory: WITHOUT });
    expect(r.scenarios[0]!.baseline.reason).toContain("forbidden matched: Co-Authored-By");
    expect(r.scenarios[1]!.baseline.reason).toContain("LEARNED");
    expect(r.scenarios[3]!.baseline.reason).toBeNull();
  });

  it("reports a negative score when memory makes things worse", async () => {
    const r = await runMemoryComparison(ALL, { withMemory: WITHOUT, withoutMemory: WITH });
    expect(r.improvementScore).toBe(-0.75);
    expect(r.regressed).toBe(3);
  });

  it("scores zero when memory changes nothing", async () => {
    const r = await runMemoryComparison(ALL, { withMemory: WITH, withoutMemory: WITH });
    expect(r.improvementScore).toBe(0);
    expect(r.bothPass).toBe(4);
  });

  it("counts both_fail and keeps it in the score", async () => {
    const empty = new FakeProvider({ "Commit the change": "nothing", "Note this lesson": "nothing", "Open the PR": "nothing", "Ship it": "nothing" });
    const r = await runMemoryComparison(ALL, { withMemory: empty, withoutMemory: empty });
    expect(r.bothFail).toBe(4);
    expect(r.improvementScore).toBe(0);
  });

  it("excludes a scenario a provider could not run, instead of scoring it as a fail", async () => {
    const partial = new FakeProvider({ "Commit the change": "git commit -m fix", "Note this lesson": "lesson LEARNED.md", "Open the PR": "gh pr create --repo a/b" });
    const r = await runMemoryComparison(ALL, { withMemory: partial, withoutMemory: WITHOUT });
    expect(r.excluded).toBe(1);
    expect(r.scored).toBe(3);
    expect(r.scenarios[3]!.verdict).toBe("excluded");
    expect(r.scenarios[3]!.treatment.error).toContain("no canned transcript");
    expect(r.improvementScore).toBe(1);
  });

  it("returns a null score when every scenario errored", async () => {
    const none = new FakeProvider({});
    const r = await runMemoryComparison(ALL, { withMemory: none, withoutMemory: none });
    expect(r.scored).toBe(0);
    expect(r.improvementScore).toBeNull();
    expect(r.rateTreatment).toBeNull();
  });

  it("handles an empty scenario list", async () => {
    const r = await runMemoryComparison([], { withMemory: WITH, withoutMemory: WITHOUT });
    expect(r.total).toBe(0);
    expect(r.improvementScore).toBeNull();
  });
});

describe("scoreMemoryComparison (the RIG-111 seam)", () => {
  it("scores any two runs of the same cases, e.g. a decay variant against its baseline", async () => {
    const cases = ALL.map(scenarioToEvalCase);
    const variant = await runEvals(cases, WITHOUT);
    const baseline = await runEvals(cases, WITH);
    expect(scoreMemoryComparison(variant, baseline).improvementScore).toBe(-0.75);
  });

  it("refuses runs that cover different scenarios", async () => {
    const a = await runEvals(ALL.slice(0, 2).map(scenarioToEvalCase), WITH);
    const b = await runEvals(ALL.map(scenarioToEvalCase), WITH);
    expect(() => scoreMemoryComparison(a, b)).toThrow(/same unique scenario ids/);
  });

  it("refuses duplicate scenario ids", async () => {
    const dup = await runEvals([S1, S1].map(scenarioToEvalCase), WITH);
    expect(() => scoreMemoryComparison(dup, dup)).toThrow(/same unique scenario ids/);
  });
});
