---
id: ADR-0003
title: Fork-specific validation gate referencing operator skills in orchestrator role guidance
status: proposed
date: 2026-09-26
tags: [orchestration, validation, fork-specific, code-review]
supersedes: []
related: [ADR-0001]
---

# 0003 — Fork-specific validation gate referencing operator skills in orchestrator role guidance

Date: 2026-09-26
Status: Proposed

## Context

The `/orchestrate-goal` custom skill required orchestrators to validate plans before dispatching implementation. This "validation gate" routes decisions to different validation methods by type: pattern choices to `/codex-second-opinion`, architecture decisions to `/symmetric-debate`, implementation approaches to `/solution-design`.

These three skills (`/codex-second-opinion`, `/symmetric-debate`, `/solution-design`) are operator-specific — they live in the operator's `~/.claude/skills/` and are not part of OpenRig. Porting the validation gate into native OpenRig files (→ ADR-0001) means placing references to operator-specific skills inside upstream-tracked files.

This creates a tension: `orchestration-team`'s existing design uses a "selected-boundary" approach where validation methods are chosen by the authored composition, not prescribed by the skill. The validation gate prescribes specific methods by decision type. Codex (gpt-6-astra) flagged this as a potential conflict.

## Decision

Add the validation gate to `packages/daemon/specs/agents/orchestration/orchestrator/guidance/role.md` with explicit references to `/codex-second-opinion`, `/symmetric-debate`, and `/solution-design`. Accept that this is fork-specific content in an upstream-tracked file.

The gate sits between "Start from the assignment" and "Working contract" in `role.md`:

| Decision type | Validation method | When |
|---|---|---|
| Pattern choice, approach within decided scope | `/codex-second-opinion` | After plan, before impl dispatch |
| Architecture, schema, API contract, hard-to-reverse | `/symmetric-debate` | After plan, before impl dispatch |
| Multiple implementation approaches to fit existing code | `/solution-design` | After plan, before impl dispatch |

The gate skips for pure mechanical work (rebases, renames, config changes).

## Rejected Alternatives

**Use generic validation language.** Replace skill references with generic instructions like "validate the plan using an appropriate method." Rejected because the routing table is the value — without it, orchestrators either skip validation or always use the same method regardless of decision type. The original custom skill proved that decision-type routing catches more plan defects than a single validation method.

**Place the gate in orchestration-team instead of role.md.** The `orchestration-team` skill governs team coordination; `role.md` governs individual orchestrator behavior. The validation gate is a personal discipline (the orchestrator validates before dispatching), not a team coordination protocol. It fits `role.md`.

**Remove the gate entirely and rely on orchestration-team's selected-boundary approach.** The selected-boundary approach decides *whether* to validate based on authored composition. The validation gate decides *how* to validate once the decision to validate is made. They complement each other — the gate does not override selected-boundary; it provides the method once the boundary triggers validation.

## Rationale

The validation gate prevents the most expensive orchestrator failure: dispatching implementation of a bad plan. The decision-type routing table is what makes it effective — a generic "validate somehow" instruction does not change orchestrator behavior. The operator-specific skill references are the cost of that specificity.

The conflict with `orchestration-team`'s selected-boundary is resolved by scope: selected-boundary decides *if* validation runs; the gate decides *which method*. The Wave 2 planning pre-flight (unknowns check) will add a third layer: *what to check before planning*. The ordering is: unknowns check → planning → validation gate → implementation dispatch.

## Consequences

- `role.md` contains fork-specific content that will conflict on upstream merges touching that file. The section is self-contained (20 lines between two existing sections), so merge conflicts will be localized.
- Orchestrator agents that do not have `/codex-second-opinion`, `/symmetric-debate`, or `/solution-design` in their skill profile will see references to skills they cannot invoke. The gate instructs "dispatch validation as a subagent," so the orchestrator's own skill profile is not the constraint — the subagent needs access.
- The operator's global `CLAUDE.md` also references these skills in its `AskUserQuestion` section, creating a second source of truth for the routing table. Changes to the routing must update both locations.

## Revisit Triggers

- The operator stops using any of the three referenced skills — remove or replace that row in the routing table.
- OpenRig introduces its own plan-validation protocol — evaluate whether to adopt it and retire this gate.
- Upstream modifies `role.md` structure in a way that makes the gate's placement ambiguous — re-evaluate placement.
- The ordering question (unknowns check → planning → validation gate) proves confusing in practice — simplify or merge the pre-dispatch checks.
