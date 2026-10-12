---
id: ADR-0006
title: RSI operational guards — worktree isolation, compaction limits, and output tracking
status: accepted
date: 2026-10-12
tags: [rsi, factory, operational, safety]
supersedes: []
related: []
---

## Context

The factory-rsi workflow (`packages/daemon/src/builtins/workflow-specs/factory-rsi.yaml`) drives a
recursive self-improvement loop: plan → implement → qa_check → review → release, with a decoupled
dogfood seat feeding findings into the next cycle. The workflow spec enforces bounded remediation
via `loop_guards.max_hops: 20`.

On 2026-10-06 the first production deployment (`mac-fan-speed-rsi`) entered a compaction spiral.
Three seats — `review.reviewer`, `check.qa`, `dogfood.tester` — consumed **1.55 billion tokens in
5 days** while producing **16 review runs** (97M tokens per useful output). The seats compacted
every ~2.4 minutes around the clock (8,500+ compactions per seat). The rig was restarted three
times on Oct 6 before being renamed to `mac-fan-speed-rsi2` with worktree isolation.

The `max_hops` guard did not prevent this because the failure was not unbounded hops — it was
unbounded *in-session* context churn caused by shared working directory state.

### Incident evidence

Source: `daily_token_snapshots` table in `~/.openrig/openrig.sqlite`, `rig_name = 'mac-fan-speed-rsi'`.

| Seat | Tokens (5 days) | Compactions | Useful output |
|---|---|---|---|
| review.reviewer | 607M | 8,569 | 16 review runs |
| check.qa | 592M | 8,536 | (same 16 runs) |
| dogfood.tester | 354M | 8,528 | 0 independent findings |
| orch.lead | 358K | 4 | normal |
| build.implementer | 160K | 2 | normal |

### Root cause chain

1. All seats shared a single git checkout (the project working directory).
2. When one seat wrote files (review output, QA artifacts), other seats detected dirty working
   tree state during their next orientation cycle.
3. Dirty state triggered re-evaluation, which consumed context, which triggered compaction.
4. Post-compaction restore re-read the working tree, found it dirty again (another seat wrote
   meanwhile), and the cycle repeated.
5. The `max_hops` workflow guard operates at the workflow step level, not the session level — it
   cannot detect or prevent in-session compaction spirals.

### Fix that resolved it

Commits `653a4aa` ("isolate rig seats from master and the shared checkout") and `f8c38d2`
("loop outputs write to build worktree, not shared checkout") gave each seat its own worktree.
The rig was renamed to `mac-fan-speed-rsi2`. The successor rig is healthy: the same three seats
use 27-32K tokens each with 0 compactions.

## Decision

Every RSI workflow deployment must satisfy five operational guards. These apply at rig spec
authoring time and are verified by the operator or orchestrator before launch.

### Guard 1 — Worktree isolation

Each seat in an RSI loop must have its own working directory. Seats must not share a git checkout.
Use `cwd` per member in the rig spec, or git worktrees, or separate clones. The build seat's
output directory must not be inside another seat's working tree.

**Why:** Shared checkouts cause cascading dirty-state detection across seats, which triggers
compaction spirals. This was the direct cause of the mac-fan-speed-rsi incident.

### Guard 2 — Compaction rate limit

If a seat compacts more than 10 times per day with no corresponding output (no commits, no review
runs, no queue item closures), the loop must stop that seat and alert the orchestrator.

**Why:** A compaction rate above 10/day with no output is the signature of a context spiral.
The mac-fan-speed-rsi seats hit 1,700 compactions/day. Detection at 10 would have caught it
in the first hour instead of after 5 days and 1.55B tokens.

**Enforcement path:** The `context_usage` and `daily_token_snapshots` tables already track
compaction counts. A watchdog job or the orchestrator's loop tick can query this.

### Guard 3 — Output-to-cost ratio tracking

Track the ratio of useful outputs (commits, merged PRs, review runs, queue closures) to tokens
consumed. Alert when any seat exceeds 10M tokens per useful output.

**Why:** The mac-fan-speed-rsi seats consumed 97M tokens per review run. Normal reviews cost ~1M
tokens. A 10M threshold gives a 10x margin before alerting.

**Enforcement path:** Join `daily_token_snapshots` with `review_runs`, git log, or queue
transition counts per seat.

### Guard 4 — Rig restart hygiene

Before restarting a rig spec with `rig up`, run `rig down` first to kill all existing sessions.
A restart without teardown accumulates orphaned sessions that continue consuming tokens.

**Why:** The mac-fan-speed-rsi rig was restarted 3 times on Oct 6 without full teardown. Each
restart added new sessions while old ones kept running. The three rig instances in the database
(`01M486WW`, `01M48BHM`, `01M48ZR9`) confirm the accumulation.

### Guard 5 — Loop cadence floor

Every seat that runs a polling loop (`/loop`, `ScheduleWakeup`, or the workflow engine's
step-to-step routing) must have a minimum delay between iterations. The factory-rsi spec sets
`max_hops: 20` for workflow steps; individual seat loop cadences should be no faster than 60
seconds for observation seats and 300 seconds for idle-check seats.

**Why:** The factory-rsi `max_hops` guard prevents unbounded workflow hops but does not limit
in-session loop frequency. A seat with no cadence floor can enter a tight
poll → compact → restore → poll cycle that consumes context without throttling.

## Rejected Alternatives

**A. Enforce guards only in daemon code.** Guards in the daemon engine would catch violations at
runtime but would not prevent them at authoring time. An agent writing a new rig spec would not
know the rules exist. The ADR places the guards in the read path agents follow before
architectural changes.

**B. Add guards to CLAUDE.md.** CLAUDE.md is loaded into every session in this project. RSI
guards are too specific — most sessions never author rig specs. An ADR is read selectively by
agents doing architectural work.

**C. Store guards only in the obsidian wiki.** The wiki is a personal knowledge base. No agent
in the rig creation flow reads it. The guards would not be discovered.

## Rationale

The factory-rsi workflow design is architecturally sound — plan → implement → qa_check → review →
release with bounded `max_hops`. The mac-fan-speed-rsi failure was operational, not architectural.
The guards address the operational gap without changing the workflow design.

The five guards cover the three failure modes observed:
- Shared state (Guard 1)
- Undetected spirals (Guards 2, 3)
- Session accumulation (Guard 4)
- Unbounded in-session polling (Guard 5)

The `mac-fan-speed-rsi2` successor validates that worktree isolation alone (Guard 1) resolves the
primary failure mode. Guards 2-5 provide defense in depth for failure modes that worktree
isolation does not prevent.

## Consequences

- Rig spec authors must assign per-seat working directories for RSI workflows.
- Orchestrators launching RSI rigs should verify worktree isolation before `rig up`.
- A future daemon enhancement can automate Guards 2 and 3 as watchdog jobs. Until then,
  orchestrators check manually or via `daily_token_snapshots` queries.
- Guard 4 is a convention enforced by operator discipline, not code. A future `rig up --replace`
  flag could automate teardown-before-restart.

## Revisit Triggers

- A second RSI rig enters a compaction spiral despite worktree isolation (Guard 1 insufficient).
- The daemon adds native loop-cadence enforcement (Guard 5 becomes engine-level).
- Token tracking moves from SQLite snapshots to real-time event stream (Guards 2-3 can become
  automated watchdogs).
