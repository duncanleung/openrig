/**
 * RIG-110 — with/without-memory CORRECTION comparison, built on the slice-07 eval harness.
 *
 * Question: does the memory system make an agent apply a prior correction and route knowledge to
 * the right surface? One scenario runs twice through the SAME runEvals + door grader — once under a
 * provider with memory present, once under a provider with memory wiped. The improvement score is
 * the pass-rate difference. Nothing here makes a model call: the live providers (a real seat with
 * and without memory) are a separate, human-gated step that plugs in as two EvalProviders.
 *
 * RIG-111 (decay patterns) reuses this unchanged: run the same scenarios under a baseline provider
 * and a decay-variant provider, then pass the two summaries to scoreMemoryComparison.
 */

import type { EvalCase } from "./eval-grader.js";
import { validateEvalCase } from "./eval-schema.js";
import { runEvals, type EvalRunSummary } from "./eval-runner.js";
import { failReason } from "./eval-report.js";
import type { EvalProvider } from "./eval-provider.js";

/** One correction scenario: a correction the agent was given before, and a prompt that tests it. */
export interface CorrectionScenario {
  id: string;
  name: string;
  /** The prior correction the memory condition holds. The live provider seeds it; the grader never reads it. */
  priorCorrection: string;
  /** The natural prompt sent in BOTH conditions. */
  prompt: string;
  /** Regex sources that must ALL match the transcript: the corrected behaviour. */
  expectedBehavior: string[];
  /** Regex sources that must NOT match: the uncorrected behaviour. */
  forbiddenBehavior?: string[];
  /** Regex source for where the knowledge must be routed (a surface path or command). Graded with expectedBehavior. */
  expectedSurface?: string;
  rubric?: string;
}

export type CorrectionScenarioErrorCode =
  | "SCENARIO_NOT_OBJECT"
  | "PRIOR_CORRECTION_MISSING"
  | "EXPECTED_BEHAVIOR_MISSING"
  | "EXPECTED_SURFACE_NOT_STRING"
  | "SCENARIO_INVALID";

export interface CorrectionScenarioError {
  code: CorrectionScenarioErrorCode | string;
  message: string;
  path: string;
}

export type ValidateScenarioResult =
  | { ok: true; scenario: CorrectionScenario }
  | { ok: false; errors: CorrectionScenarioError[] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate a parsed scenario. Collects ALL errors; reuses the eval-case validator for the shared fields. */
export function validateCorrectionScenario(doc: unknown): ValidateScenarioResult {
  if (!isPlainObject(doc)) {
    return { ok: false, errors: [{ code: "SCENARIO_NOT_OBJECT", message: "scenario must be a mapping/object", path: "" }] };
  }
  const errors: CorrectionScenarioError[] = [];
  if (typeof doc.priorCorrection !== "string" || doc.priorCorrection.trim().length === 0) {
    errors.push({ code: "PRIOR_CORRECTION_MISSING", message: "priorCorrection: a non-empty string is required", path: "priorCorrection" });
  }
  if (!Array.isArray(doc.expectedBehavior) || doc.expectedBehavior.length === 0) {
    errors.push({ code: "EXPECTED_BEHAVIOR_MISSING", message: "expectedBehavior: a non-empty array of regex sources is required", path: "expectedBehavior" });
  }
  if (doc.expectedSurface !== undefined && typeof doc.expectedSurface !== "string") {
    errors.push({ code: "EXPECTED_SURFACE_NOT_STRING", message: "expectedSurface: must be a regex source string when present", path: "expectedSurface" });
  }

  // Shared fields (id, name, prompt, regex compilability) go through the one eval-case validator.
  const asCase = validateEvalCase({
    id: doc.id,
    name: doc.name,
    category: "behavior",
    prompt: doc.prompt,
    expectedPatterns: [
      ...(Array.isArray(doc.expectedBehavior) ? doc.expectedBehavior : []),
      ...(typeof doc.expectedSurface === "string" ? [doc.expectedSurface] : []),
    ],
    forbiddenPatterns: doc.forbiddenBehavior,
    rubric: doc.rubric,
  });
  if (!asCase.ok) {
    for (const e of asCase.errors) {
      // An empty expectedBehavior is already reported by its own named code.
      if (e.code === "EXPECTED_PATTERNS_MISSING" && errors.some((x) => x.code === "EXPECTED_BEHAVIOR_MISSING")) continue;
      errors.push({ code: e.code, message: e.message, path: e.path });
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, scenario: doc as unknown as CorrectionScenario };
}

/** The scenario as a standard eval case, so the existing runner and door grader score it unchanged. */
export function scenarioToEvalCase(scenario: CorrectionScenario): EvalCase {
  return {
    id: scenario.id,
    name: scenario.name,
    category: "behavior",
    prompt: scenario.prompt,
    expectedPatterns: [
      ...scenario.expectedBehavior,
      ...(scenario.expectedSurface ? [scenario.expectedSurface] : []),
    ],
    forbiddenPatterns: scenario.forbiddenBehavior,
    rubric: scenario.rubric,
  };
}

export type ScenarioVerdict = "improved" | "regressed" | "both_pass" | "both_fail" | "excluded";

export interface ConditionResult {
  pass: boolean;
  /** Provider execution failure (not a graded FAIL). */
  error: string | null;
  /** Why a graded FAIL failed. */
  reason: string | null;
}

export interface ScenarioComparison {
  id: string;
  name: string;
  /** The first (treatment) condition: memory present, or the decay variant. */
  treatment: ConditionResult;
  /** The second (baseline) condition: memory wiped, or the current decay pattern. */
  baseline: ConditionResult;
  verdict: ScenarioVerdict;
}

export interface MemoryEvalReport {
  total: number;
  /** Scenarios that ran cleanly in both conditions; only these enter the score. */
  scored: number;
  /** Scenarios dropped because a provider errored in either condition. */
  excluded: number;
  passTreatment: number;
  passBaseline: number;
  rateTreatment: number | null;
  rateBaseline: number | null;
  /** rateTreatment - rateBaseline, in [-1, 1]. Null when nothing was scored. */
  improvementScore: number | null;
  improved: number;
  regressed: number;
  bothPass: number;
  bothFail: number;
  scenarios: ScenarioComparison[];
}

function conditionResult(summary: EvalRunSummary, id: string): ConditionResult {
  const outcome = summary.outcomes.find((o) => o.case.id === id);
  if (!outcome) throw new Error(`scoreMemoryComparison: scenario ${id} missing from a run summary`);
  if (outcome.error !== undefined) return { pass: false, error: outcome.error, reason: null };
  return { pass: outcome.grade.pass, error: null, reason: outcome.grade.pass ? null : failReason(outcome.grade) };
}

/**
 * Pure scorer over two run summaries of the SAME scenarios. `treatment` is the condition expected
 * to do better (with memory); `baseline` is the control (memory wiped). Throws when the two
 * summaries do not cover the same scenario ids, so a skewed comparison cannot be scored silently.
 */
export function scoreMemoryComparison(treatment: EvalRunSummary, baseline: EvalRunSummary): MemoryEvalReport {
  const ids = treatment.outcomes.map((o) => o.case.id);
  const baselineIds = baseline.outcomes.map((o) => o.case.id);
  const same = ids.length === baselineIds.length && new Set(ids).size === ids.length
    && ids.every((id) => baselineIds.includes(id));
  if (!same) throw new Error("scoreMemoryComparison: the two runs must cover the same unique scenario ids");

  const scenarios: ScenarioComparison[] = treatment.outcomes.map((o) => {
    const t = conditionResult(treatment, o.case.id);
    const b = conditionResult(baseline, o.case.id);
    const verdict: ScenarioVerdict = t.error !== null || b.error !== null ? "excluded"
      : t.pass && !b.pass ? "improved"
        : !t.pass && b.pass ? "regressed"
          : t.pass ? "both_pass" : "both_fail";
    return { id: o.case.id, name: o.case.name, treatment: t, baseline: b, verdict };
  });

  const scoredList = scenarios.filter((s) => s.verdict !== "excluded");
  const scored = scoredList.length;
  const passTreatment = scoredList.filter((s) => s.treatment.pass).length;
  const passBaseline = scoredList.filter((s) => s.baseline.pass).length;
  const rateTreatment = scored === 0 ? null : passTreatment / scored;
  const rateBaseline = scored === 0 ? null : passBaseline / scored;
  const count = (v: ScenarioVerdict) => scenarios.filter((s) => s.verdict === v).length;

  return {
    total: scenarios.length,
    scored,
    excluded: scenarios.length - scored,
    passTreatment,
    passBaseline,
    rateTreatment,
    rateBaseline,
    improvementScore: rateTreatment === null || rateBaseline === null ? null : rateTreatment - rateBaseline,
    improved: count("improved"),
    regressed: count("regressed"),
    bothPass: count("both_pass"),
    bothFail: count("both_fail"),
    scenarios,
  };
}

export interface MemoryConditionProviders {
  /** A provider whose seat holds the prior corrections (full memory). */
  withMemory: EvalProvider;
  /** A provider whose seat has memory wiped. */
  withoutMemory: EvalProvider;
}

/** Run every scenario under both conditions through the shared runner and score the difference. */
export async function runMemoryComparison(
  scenarios: CorrectionScenario[],
  providers: MemoryConditionProviders,
): Promise<MemoryEvalReport> {
  const cases = scenarios.map(scenarioToEvalCase);
  const [withMemory, withoutMemory] = await Promise.all([
    runEvals(cases, providers.withMemory),
    runEvals(cases, providers.withoutMemory),
  ]);
  return scoreMemoryComparison(withMemory, withoutMemory);
}
