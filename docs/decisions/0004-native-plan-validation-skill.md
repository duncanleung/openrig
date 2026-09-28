---
id: ADR-0004
title: Native plan-validation skill to replace fork-specific validation gate
status: accepted
date: 2026-09-27
tags: [orchestration, validation, skills]
related: [ADR-0003]
---

## Context

ADR-0003 introduced a mandatory validation gate in the orchestrator role guidance.
The gate routes decisions to one of three validation methods before implementation
dispatch:

| Decision type | Method |
|---|---|
| Pattern choice, approach within decided scope | `/codex-second-opinion` |
| Architecture, hard-to-reverse | `/symmetric-debate` |
| Multiple implementation approaches | `/solution-design` |

This gate works, but it references operator-specific skills that live in
`~/.claude/skills/`. A rig without those skills cannot use the gate. ADR-0003's
revisit trigger says: "OpenRig introduces its own plan-validation protocol —
evaluate whether to adopt it and retire this gate."

Three verification mechanisms exist today, each at a different scope:

1. **Pre-dispatch unknowns check** (`orchestration-team/SKILL.md`) — fires before
   planning. Catches misunderstood requirements. Already native.
2. **Validation gate** (`role.md`) — fires after planning, before implementation.
   Routes decisions to cross-family or multi-perspective validation. Fork-specific.
3. **Verification-before-completion** (vendored from Obra Superpowers) — fires
   before claiming work is done. Covers individual agent completion. Already native.

The gap is #2: plan validation between "I have a plan" and "I am dispatching
implementation."

## Decision

Do not build a native plan-validation skill. Keep the validation gate as
fork-specific orchestrator guidance.

## Rejected Alternatives

**A. Native skill that generalizes the routing table.** Would replace specific
skill names with categories (e.g., "cross-family second opinion" instead of
`/codex-second-opinion`). The skill would detect available validation methods
and dispatch the best available one.

Rejected because:
- The routing table is 3 rows. A skill that wraps 3 rows adds indirection
  without adding capability.
- The skill names ARE the interface. `/codex-second-opinion` is a concrete
  action an orchestrator can dispatch. "Cross-family second opinion" is a
  category that still needs to resolve to a concrete skill.
- Operators who lack these skills lack them because they chose not to build
  them, not because the gate is hard to port. Wrapping the table in a skill
  does not create the missing validation methods.

**B. Native skill with built-in validation methods.** Would ship
cross-family validation, debate, and solution design as OpenRig-native skills,
then wrap them in a routing skill.

Rejected because:
- These skills depend on operator-specific tooling (Codex CLI, specific
  models, API keys). OpenRig cannot ship them as universal capabilities.
- The validation methods are actively evolving — locking them into the daemon
  package freezes them at the wrong level.

## Rationale

The validation gate is lightweight guidance (7 lines of markdown in `role.md`)
that references operator-provided skills. This is the correct architecture:

- OpenRig provides the **hook point** (the orchestrator role guidance that says
  "validate before implementing").
- Operators provide the **validation methods** (skills that do the actual
  cross-family checking).
- The routing table is operator-customizable by editing `role.md`.

The pre-dispatch unknowns check and verification-before-completion already
cover the before-planning and after-implementation scopes natively. The
middle scope (plan validation) is intentionally left to operator skills because
the methods are operator-specific.

## Consequences

- ADR-0003's validation gate stays as fork-specific guidance. Its revisit
  trigger is resolved: OpenRig chose not to introduce a native protocol.
- Operators who want plan validation write their own validation skills and
  add them to their orchestrator's `role.md`.
- The three-layer verification stack (unknowns → plan validation → completion)
  remains stable with native coverage at layers 1 and 3.

## Revisit Triggers

- OpenRig ships a native cross-family validation primitive (e.g., built-in
  Codex integration). That changes the "operator-specific tooling" rationale.
- Three or more forks independently build equivalent validation gates. That
  signals the pattern is universal enough to promote.
