# test-system/evals — the live-model eval harness (a DIFFERENT gate from scenarios)

Two gates, one per question-kind — the legible split the desk ruled
(qitem-20260824042353-045e8f4a):

- `../scenarios/` = the DETERMINISM gate. Stub seats, scripted replies, judgment-free.
  Asks: does the STRUCTURE hold? (`run-scenarios.mjs`, `packages/daemon/test/helpers/scenario-*.ts`)
- `./` (evals) = the LIVE-MODEL gate. A REAL seat receives a NATURAL prompt and DECIDES.
  Asks: does a seat pull the right context entry BEFORE acting, and follow it AFTER loading?
  (`run-evals.mjs`, `packages/daemon/test/helpers/eval-*.ts`)

ONE eval harness serves BOTH slices through one portable `EvalCase` shape (anti-fork — the ruling
also amends slice-05 Q3 so there is one eval convention, not two):
- slice-07: SELECTION-before-LOADING — does the seat pull `rig context get <ref>` for a natural prompt?
- slice-05: BEHAVIOR-after-DELIVERY — does it follow what it loaded?

Grading:
- DOOR grade = deterministic expected-command-pattern match (+ loading order: get precedes action).
  This is what the CE-08 thinning gate consumes.
- Rubric (1-5) rides each case as authored text; the LLM-judge is OPTIONAL and DEFERRED (API-gated,
  agent-browser's `--judge` shape) — switch it on later without re-authoring the cases.

Layout:
- `cases/selection.yaml`, `cases/loading.yaml` — selection + loading `EvalCase`s as YAML lists
  (natural prompt, expected patterns, order, rubric), validated by `eval-schema.ts` at load.
- `fixtures/` — canonical-ref packs backing the structural canonical-ref checks only. The LIVE run
  does NOT point a seat at these; per Repair 2 the eval resolves refs against the EXACT production
  package (built by `generate-context-packs.mjs`), so fixture-vs-production drift fails structurally.
- runner + grader code lives in `packages/daemon/test/helpers/eval-*.ts` (vitest-wired); the standalone
  entry is `packages/daemon/scripts/run-evals.mjs` (`--provider fake`, the default, grades transcripts
  from `--transcripts`; `--provider rig` drives a live seat), run via
  `npm run eval -w packages/daemon -- [args]`
  (the TS helpers need the tsx loader, which that command supplies) — mirroring the scenario system's
  split, node/tsx/vitest.

Status: built. `npm test` covers the harness without a model (`packages/daemon/test/eval-*.test.ts`);
live `--provider rig` runs are manual, and CI does not run them.

## With/without-memory comparison (RIG-110)

`packages/daemon/test/helpers/eval-memory-comparison.ts` measures whether memory changes behaviour.
A `CorrectionScenario` (prior correction, prompt, expected behaviour, optional expected surface) runs
through the SAME `runEvals` + door grader under two `EvalProvider`s: one whose seat holds the prior
corrections, one with memory wiped. `improvementScore = pass_rate(with) - pass_rate(without)`.
A scenario a provider could not run is excluded from the score, not counted as a fail.

- No model calls in the harness. The live providers (a real seat with and without memory) are a
  separate human-gated step; the scenarios themselves are authored in `openrig-memory`.
- RIG-111 (decay patterns) reuses `scoreMemoryComparison(variantSummary, baselineSummary)` on two
  runs of the same cases.
- Tests: `packages/daemon/test/eval-memory-comparison.test.ts` (stub providers only).
