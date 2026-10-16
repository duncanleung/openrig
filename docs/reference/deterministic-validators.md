# Design: deterministic validators before LLM-as-judge (RIG-10)

Goal: let a compiler, test runner, or linter settle a code review finding before any LLM validator
runs. A tool result does not share the errors of a language model. A conclusive tool result also
saves the validator calls for that finding.

Status: the code is NOT applied. It lives in two skills outside this repo
(`~/.claude/skills/code-review-validate-findings/` and `~/.claude/skills/code-review-dual/`). This
repo does not edit them. A human applies two diffs by hand (see "How to apply").

## Scope

In scope:

- A pre-check that runs before the LLM validator panel in `/code-review-validate-findings`.
- Three tools, for TypeScript only: `tsc --noEmit`, `vitest run <file>`, `eslint <file>`.
- A `deterministic_verdict` field on finding records, `validator_calls_saved` in `metrics.json`,
  and `outcome_label` written at run time.

Not in scope: Go or Python checks, replacing the `--repro` gate, worktree integration.

## Where the code runs (deviation from the ticket wording)

The ticket says the pre-check runs "in the validate-findings workflow". That is not possible as
written. A Workflow script has no Node API access: it cannot start a process. Every command in the
current workflows runs inside an `agent()` call, which means a model decides the command line.
That breaks the rule "finding text never reaches a shell".

So the design splits the work in two:

1. `deterministic-check.mjs` (a new file in the skill directory) runs in the invoking session
   before the Workflow starts. It starts each tool with `execFile` and `shell: false`.
2. The invoking session copies each result onto its finding as `finding.deterministic`. The
   Workflow reads that field and skips the LLM validators for a conclusive result.

The pre-check still runs before LLM validator dispatch. Only the process launch moved out of the
script body.

## Verified line references

The ticket cites lines in the dual workflow. All three match the file with sha256 `c18967e7...`:

| Ticket reference | Actual lines | Content |
|------------------|--------------|---------|
| Repro gate ~2186-2241 | 2186-2266 (comment from 2186, `if (repro && ...)` at 2192, agent dispatch to 2233, demotion logic to 2266) | Repro gate |
| Lifecycle records ~2331-2380 | 2331-2380 | `buildLifecycleRecord`, with `deterministic_verdict: null` at 2376 and `outcome_label: null` at 2380 |
| `outcome_label` always null | 2380 | Confirmed |

Two facts the ticket does not state:

- The repro gate and the lifecycle records live in `code-review-dual/workflow.js`. The
  `code-review-validate-findings/workflow.js` file has neither. Its `metrics` object has no
  `findings_lifecycle`.
- The two workflows each run their own validators. `/code-review-dual` does not call
  `/code-review-validate-findings`.

## Finding classification

A finding gets at most one tool. Unsure means no check. The classification also records how the
tool was chosen (`classifiedBy`), because that decides whether a clean run may refute the finding.

1. Structured field first. If the finding has `deterministicKind`, use it:
   `type-error` -> `tsc`, `test-failure` -> `vitest`, `lint` -> `eslint`. Any other value means no
   check. `classifiedBy` is `structured`. The current finding schema has no such field, so the
   invoking session may set it.
2. Keyword fallback. Search `category` plus the first 300 characters of `description`:

   | Tool | Pattern (case-insensitive) |
   |------|----------------------------|
   | `tsc` | `TS` plus four digits, "does not compile", "fail(s) (to) typecheck" or "type-check", "compile error" |
   | `vitest` | "vitest", "failing/failed/broken test", "test fails/failing/failure" |
   | `eslint` | "eslint", "lint", "linter", "linting" |

   The bare words "type error", "tsc", and "type-check" do NOT select `tsc`. They also describe
   runtime errors and type-system bypasses, which a compiler cannot refute. A case-sensitive
   `TypeError` (the runtime class) in the text means the finding never selects `tsc`.
   `classifiedBy` is `ts-code` when the tool is `tsc` and the text holds an explicit `TSnnnn` code.
   Otherwise it is `keyword`.
3. If two or more patterns match, or none match, run no check.

Only `standard` track findings get a check. `deep-research` and `already-addressed-*` findings do
not.

### Who may refute

A keyword match proves nothing about which claim the finding makes. So a clean run refutes a
finding only if the claim is known:

| Tool | `refuted` allowed when |
|------|------------------------|
| tsc | `classifiedBy` is `structured` or `ts-code` |
| vitest | `classifiedBy` is `structured`, or the finding names a test file (path validation passes), says that test fails ("the test fails", "failing test"; "failing test helper" does not count), AND makes no conditional or intermittent claim. The first 300 characters must not match words such as flaky, intermittent, sometimes, race, timezone, locale, "on CI", "only when", "when run in", "under load". A `structured` finding skips this check. |
| eslint | Always. The eslint rule already needs a named, enabled rule. |

Otherwise a clean run gives `inconclusive` with reason `refute-needs-structured-claim`. `confirmed`
needs no such rule: a tool failure at the claimed location is evidence whatever picked the tool.

## Where the check runs

- In the PR checkout the skill already verified in Step 0. The checker re-verifies: `git rev-parse
  HEAD` must equal the PR head SHA, and `git status --porcelain` must be empty. If not, every
  finding is `inconclusive` (`head-mismatch` or `dirty-tree`).
- The checker does not create a worktree.
- The tools must not change the repo. The checker runs `git status --porcelain` after each tool.
  If the tree changed, that result and all later results are `inconclusive` (`tree-mutated`).
  Ignored paths such as `node_modules` do not count.

## Command allowlist (normative)

Exactly these invocations are allowed. The only variable part is a validated repo-relative path.

| Tool | argv (after the binary) |
|------|-------------------------|
| tsc | `--noEmit -p <tsconfig> --listFiles --pretty false` |
| vitest | `run --reporter=json --coverage.enabled=false <test-file>` |
| eslint | `--format json <file>` |
| eslint | `--print-config <file>` (only to check that a named rule is enabled) |
| git | `rev-parse HEAD`, `status --porcelain` (tree checks) |

Rules:

- The binary is `<repo>/node_modules/.bin/<tool>`, found by walking up from the claimed file. Its
  real path must be inside the repo root. The checker never searches `PATH` and never uses `npx`.
- The checker starts every process with `execFile`, `shell: false`, an argv array, a timeout of
  180 seconds (`SIGKILL`), and an output cap of 8 MiB.
- Finding text never becomes an argument. The checker reads findings from a JSON file. The only
  values that reach argv are the fixed flags above and paths that passed validation.
- The environment holds only `PATH` (the Node directory plus `/usr/bin:/bin`), `HOME`, `CI=1`, and
  `NO_COLOR=1`. No token or secret passes through.

Not allowed: any other binary, `npx` or any package download, `sh -c`, any flag not in the table,
a path that failed validation, a command string.

The tools run repo code (vitest imports test files, eslint loads config). Treat this as the same
trust level as `npm test` on that PR. Use it only on PRs you opened, as the code review rules
already require.

## Path validation

Every path must pass all of these. A failure gives `inconclusive` with the listed reason.

| Check | Reason |
|-------|--------|
| Not empty | `empty-path` |
| No NUL byte | `nul-byte` |
| Does not start with `-` | `leading-dash` |
| No `..` segment | `parent-segment` |
| `realpath` exists | `not-found` |
| `realpath` is inside the `realpath` of the repo root (catches symlink escape and absolute paths outside the root) | `outside-root` |
| Is a regular file | `not-a-file` |
| For `tsc` and `eslint`: the path is in the PR diff file list | `not-in-pr-diff` |
| For `vitest`: the path is the finding's own test file, or a test file the description names, and it exists at the PR head. It need not be in the diff. | `no-test-file` |

A test file matches `*.test.*` or `*.spec.*` (`.js`, `.ts`, `.jsx`, `.tsx`, `.mjs`, `.cjs`, `.mts`,
`.cts`).

## Verdict table (normative)

`confirmed` needs the tool to fail AND the failure to point at the claimed file (and at the claimed
line, when the finding names one). `refuted` needs a clean run, proof that the run covered the
claimed file, AND the provenance rule below. Everything else is `inconclusive`.

A line matches when it falls in the claimed range (inclusive, no tolerance). Without a claimed
line, any failure in the claimed file matches.

| Tool | confirmed | refuted | inconclusive |
|------|-----------|---------|--------------|
| tsc | Exit non-zero and an `error TSnnnn` line names the claimed file (and line) | Exit 0 and `--listFiles` lists the claimed file (it is in the tsconfig program) | Exit 0 but file not listed; failure only in other files or other lines; no tsconfig |
| vitest | The named test file ran and has at least one failed test | The named test file ran, has at least one passed test, no failed test, and the exit code is 0 | File did not run; only skipped tests; JSON not parseable |
| eslint | Exit 1 and an error-severity message in the claimed file (and line). If the finding names rules in backticks, the message `ruleId` must match one. | Exit 0, file linted and not ignored, the finding names a rule, and `--print-config` shows that rule enabled | File ignored; no rule named; named rule not enabled; errors only elsewhere |
| any | | | Tool missing, no `node_modules`, timeout, output cap, crash (eslint exit above 1), spawn failure, unparseable output, head mismatch, dirty tree, tree mutated |

Provenance rule: a `refuted` result also needs the "Who may refute" condition above. If it fails,
the result becomes `inconclusive` (`refute-needs-structured-claim`). Every result carries
`classifiedBy`.

Why eslint is strict: a clean lint run proves nothing about a rule that the config does not enable.
A clean run only refutes a finding that names an enabled rule.

Line numbers for vitest are not checked. A test failure is a file-level fact in this design.

## Interaction with the LLM validators

In `workflow.js`, before the panel dispatch for a `standard` finding:

- `deterministic.verdict` is `confirmed` or `refuted`: the Workflow reserves no agents and
  dispatches no validators. It builds one synthetic verdict (`validatorStack: 'deterministic'`) and
  classifies the finding: `confirmed` -> `MUST_FIX`, `refuted` -> `DISMISSED`. A `MUST_FIX` finding
  still goes to solution design as before. The result carries `mode: 'deterministic'`, and
  `pairYes` is `null`.
- `inconclusive`, missing, or malformed (`verdict` or `method` outside the allowed sets): the
  Workflow runs the panel with no change.

The Workflow trusts only the two enums. It does not re-run the tool.

## Lifecycle and metrics fields

`finding.deterministic` (input, set by the invoking session):

```json
{ "verdict": "confirmed|refuted|inconclusive", "method": "tsc|vitest|eslint", "reason": "...", "evidence": "..." }
```

Every classified finding in `code-review-validate-findings` output gets:

| Field | Value |
|-------|-------|
| `deterministic_verdict` | `confirmed`, `refuted`, `inconclusive`, or `null` (no check ran) |
| `deterministic_method` | `tsc`, `vitest`, `eslint`, or `null` |
| `outcome_label` | `true_positive`, `false_positive`, or `null` |
| `outcome_source` | `deterministic`, `llm_validator`, or `null` |

New `metrics` keys in `code-review-validate-findings` (written to `metrics.json` by Step 4):

| Key | Meaning |
|-----|---------|
| `validator_calls_saved` | Sum over skipped findings of the validator calls the Workflow would have reserved |
| `deterministic` | `{ confirmed, refuted, inconclusive, skipped_finding_ids }` |
| `findings_outcomes` | One record per finding: `finding_id`, `verdict`, `deterministic_verdict`, `deterministic_method`, `outcome_label`, `outcome_source` |

In `code-review-dual`, `buildLifecycleRecord` now fills `deterministic_verdict`,
`deterministic_method`, `outcome_label`, and `outcome_source`. The dual Workflow runs no
deterministic check itself. It reads `_args.deterministicResults = [{file, lines, verdict, method}]`
if the caller passes it, matched by exact `file` and `lines`. Without it, the two deterministic
fields stay `null`, and `outcome_label` comes from the LLM verdict.

### How `validator_calls_saved` is counted

The Workflow reserves its validator agents up front per standard finding:

| Mode | Calls reserved per finding | Source |
|------|---------------------------|--------|
| `validate-findings`, dual-stack | 6 (3 Claude, 3 Codex) | `reserve(6, ...)` |
| `validate-findings`, claude-only | 3 | `reserve(3, ...)` |

A skipped finding adds 6 or 3. Calls that a panel would add later (adjudication, Opus fallback,
solution design for a `DISMISSED` finding) are not counted, because nobody knows if they would have
run. The number is therefore a lower bound. The merged dual workflow uses 2 calls (default mode,
one Claude plus one Codex) or 4 calls (in-depth mode) per finding. It does not skip any, so it
adds nothing to this counter.

## `outcome_label` precedence

Before this change `outcome_label` was always `null`. The Workflow now writes it at run time:

1. `deterministic_verdict` is `confirmed` -> `true_positive`, source `deterministic`.
2. `deterministic_verdict` is `refuted` -> `false_positive`, source `deterministic`.
3. Otherwise (`inconclusive` or none), use the LLM verdict: `MUST_FIX` -> `true_positive`,
   `DISMISSED` -> `false_positive`, source `llm_validator`. `SUGGESTION`, `ESCALATED`, and `SMELL`
   stay `null`.

The deterministic verdict wins even when the LLM verdict disagrees. In practice the LLM did not run
for that finding. The case arises in `code-review-dual` when `deterministicResults` and the panel
both exist.

The post-merge `--annotate` step in the audit skill can still overwrite `outcome_label`. Readers
that need a human-confirmed label must check `outcome_source`.

## Interaction with the `--repro` gate

The repro gate stays unchanged in `code-review-dual`. It runs after validation, on must-fix
findings, and a model drives it. The deterministic pre-check runs before validation, and a script
drives it. A finding that the pre-check confirmed can still go to the repro gate. A finding that
the pre-check refuted is already dismissed and never reaches it.

## Failure modes

| Failure | Result |
|---------|--------|
| Checker missing, crashes, or exits non-zero | The session prints one line and continues. No finding has `deterministic`. Nothing blocks. |
| Tool missing or no `node_modules` | `inconclusive` for that finding |
| Timeout (180 s) or output over 8 MiB | `inconclusive` |
| Checkout is not the PR head, or tree is dirty | `inconclusive` for all findings |
| Tool wrote to the tree | `inconclusive` for that finding and all later ones |
| Monorepo `tsc` project with `references` and no `files` | The claimed file is not in the program, so `inconclusive` |
| Wrong `confirmed` | Possible when the same file has a pre-existing error on the claimed line. Mitigation: the PR head is checked, but the checker does not diff against the base. See "Not verified". |
| Runtime error mistaken for a type error (for example "throws a `TypeError` when rows is undefined") | Keyword classification does not select `tsc` for it. If a guess still selects a tool, a clean run gives `inconclusive`, never `refuted`. |
| Hostile finding text | Never reaches argv. A path with shell characters fails `realpath` and gives `inconclusive`. |

## How to apply

The diffs use paths relative to `~/.claude/skills/` (`-p1`). Check for drift first. The diffs apply
only to these originals:

| File | sha256 |
|------|--------|
| `code-review-validate-findings/workflow.js` | `9a6918a22ba31f5f8c0e2a5255bab3da25601c57f66c04b099bcaa175f8a392e` |
| `code-review-validate-findings/SKILL.md` | `8ed20d39c0c708ea927cb7501277c123b81bc77820fbda657c11050d9d031865` |
| `code-review-dual/workflow.js` | `c18967e79007bd19cce3926c59c467edde73486d0a0f9f5834a5d3606fe12d39` |
| `code-review-dual/SKILL.md` | `86f5329ad87fa7fa496bf656d26583f2797fa241f29adaa8fb632005b9f49f08` |

```bash
cd ~/.claude/skills
shasum -a 256 code-review-validate-findings/workflow.js code-review-validate-findings/SKILL.md \
  code-review-dual/workflow.js code-review-dual/SKILL.md      # compare with the table
cp -R code-review-validate-findings /tmp/rig10-backup-validate
cp -R code-review-dual /tmp/rig10-backup-dual
patch -p1 --dry-run < <repo>/docs/reference/deterministic-validators-validate-findings.diff
patch -p1 --dry-run < <repo>/docs/reference/deterministic-validators-code-review-dual.diff
patch -p1 < <repo>/docs/reference/deterministic-validators-validate-findings.diff
patch -p1 < <repo>/docs/reference/deterministic-validators-code-review-dual.diff
```

If a hash differs, the skill changed since this diff was made. Do not force the patch. Rebase the
diff on the new file.

The validate-findings diff creates `code-review-validate-findings/deterministic-check.mjs`. The
dual diff is independent. You can apply the validate-findings diff alone and skip the dual diff.

## How to verify after applying

1. Syntax: `node --check` on both `workflow.js` files and on `deterministic-check.mjs`.
2. Helper usage error: run `node ~/.claude/skills/code-review-validate-findings/deterministic-check.mjs`
   with no arguments. It must print a usage line and exit 2.
3. Helper on a real PR checkout (head SHA, clean tree, `node_modules` installed). Write one finding
   with a known `tsc` error to a JSON file, run the helper, and expect `confirmed`. Then run it
   on a finding for a clean file in the tsconfig program, with `deterministicKind: "type-error"` or a `TSnnnn` code in the text, and expect `refuted`. The same finding with neither must give `inconclusive` (`refute-needs-structured-claim`).
4. Run `/code-review-validate-findings` on a PR. Check `metrics.json` for `validator_calls_saved`,
   `deterministic`, and `findings_outcomes`. With no conclusive result, `validator_calls_saved` is
   `0` and the panel behavior matches the old run.
5. Check `findings_lifecycle[].outcome_label` in a new `/code-review-dual` `metrics.json`.

## Rollback

```bash
cd ~/.claude/skills
patch -R -p1 < <repo>/docs/reference/deterministic-validators-code-review-dual.diff
patch -R -p1 < <repo>/docs/reference/deterministic-validators-validate-findings.diff
rm code-review-validate-findings/deterministic-check.mjs   # if patch -R left an empty file
shasum -a 256 code-review-validate-findings/workflow.js    # must equal the table above
```

Or restore the `/tmp/rig10-backup-*` copies. Skipping Step 1.5 in `SKILL.md` is also a soft
rollback: with no `deterministic` field on any finding, the Workflow behaves as before.

## Not verified

- The edited Workflow scripts did not run in a real Workflow session. Syntax passes
  (`node --check`) and the pure functions pass a unit test. The pipeline path
  (short-circuit in stage 1 and stage 2) is reviewed by reading only.
- The helper ran against fake `tsc`, `vitest`, and `eslint` scripts in a temporary git repo. It did
  not run against the real tools. Real output formats (tsc `--listFiles` paths, vitest JSON, eslint
  JSON, `--print-config`) are coded from their documented shapes.
- Network access is not blocked. The helper does not pass credentials, but it does not sandbox
  the process. Run it under an OS sandbox if the PR code is not trusted.
- The checker does not compare against the base branch, so a pre-existing error on the claimed
  line can read as `confirmed`.
- The `deterministicKind` structured field does not exist in any hunter schema today. Only the
  keyword fallback is active until a hunter sets it.
- Step 1.5 in `SKILL.md` is instructions for the invoking session. Nothing enforces that the
  session follows it.
- The `deterministicResults` path in `code-review-dual` has no caller. No dual `SKILL.md` step
  runs the checker.
- `eslint` never ran against the real tool. This repo has no eslint config. Only fake scripts
  covered it.
- `tsc` checks the whole project, not one file. On a large monorepo the 180 s timeout turns the
  result into `inconclusive`.
- The keyword patterns are a heuristic. They can still select a tool for a finding that makes a
  different claim. The provenance rule limits the damage: such a guess can `confirm` or stay
  `inconclusive`, and cannot refute. `deterministicKind` or an explicit `TSnnnn` code is needed
  for `tsc` to refute.
- The qualifier detection for vitest (flaky, timezone, "on CI", and similar words) is a heuristic
  word list over the first 300 characters. A conditional claim phrased with other words can still
  be refuted by one clean run. Set `deterministicKind` only for claims one local run can settle.
