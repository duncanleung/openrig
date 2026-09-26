---
id: ADR-0002
title: Create pr-review-lifecycle as a standalone OpenRig skill
status: accepted
date: 2026-09-26
tags: [code-review, skills, pr-lifecycle, agent-coordination]
supersedes: []
related: [ADR-0001]
---

# 0002 — Create pr-review-lifecycle as a standalone OpenRig skill

Date: 2026-09-26
Status: Proposed

## Context

The `/orchestrate-review` custom skill (~507 lines) contained a complete PR review→fix→merge protocol: SHA-tracked staleness detection, bot review integration via GraphQL, scoped re-reviews after fix pushes, 3-cycle escalation, and a 5-condition merge gate. This protocol needed a home in OpenRig's native skill system (→ ADR-0001).

The protocol is large (~370 lines after condensation) and serves a specific lifecycle that crosses multiple agent roles — orchestrators dispatch it, reviewers execute parts of it, and fix agents follow its SHA-tracking contract. No existing native skill covers this lifecycle.

## Decision

Create `pr-review-lifecycle` as a new standalone skill under `packages/daemon/assets/plugins/openrig-core/skills/pr-review-lifecycle/SKILL.md`.

The skill loads automatically for any agent whose YAML declares `plugins: [shared:openrig-core]`. Both orchestrator and independent-reviewer agent YAMLs already declare this plugin — no YAML changes needed.

The skill carries:
- 6-step review loop (discover → status check → review dispatch → fix dispatch → scoped re-review → merge gate)
- SHA-tracked staleness decision matrix (fix-push vs. unknown-change detection)
- Bot review integration (CodeRabbit + Greptile GraphQL polling, severity mapping, finding extraction)
- Model selection guidance (Opus for reviews, Sonnet for fixes)
- 3-cycle escalation limit (per-PR, complements the ticket-level limit in `orchestration-team`)
- 5-condition merge gate
- Context discipline rules (never review in the orchestrator's own context)

## Rejected Alternatives

**Embed in orchestration-team.** The `orchestration-team` skill is already ~300 lines and covers general coordination. Adding ~370 lines of review-specific protocol would make it ~670 lines and blur its scope. The review lifecycle is a distinct concern that not every orchestration task needs.

**Embed in reviewer role guidance.** The protocol governs the full lifecycle including orchestrator dispatch decisions, fix agent contracts, and merge gates. Placing it in reviewer guidance would force orchestrators to read reviewer-scoped files for dispatch rules.

**Split across multiple files.** Separate the dispatch rules (orchestrator-facing) from the execution rules (reviewer-facing). Rejected because the protocol's value is its end-to-end determinism — splitting it creates gaps where steps fall between owners.

## Rationale

The review lifecycle is the largest single protocol from the custom skills and the one with the most cross-role coordination. A standalone skill makes it loadable by any agent that needs it (orchestrator, reviewer, or a future review-babysitter seat) without pulling in unrelated orchestration guidance. The `openrig-core` plugin mechanism delivers it to the right agents without per-agent configuration.

## Consequences

- New file in the plugin tree that ships with the daemon.
- Upstream OpenRig does not have this skill — it exists only in the fork. Upstream plugin updates will not conflict (new file, not a modification), but upstream reorganizations of the plugin directory could require a move.
- The skill references operator-specific conventions (dual review + validate-findings workflow, CodeRabbit/Greptile bot logins). These may need updating if the operator changes review tooling.

## Revisit Triggers

- OpenRig introduces its own review lifecycle protocol — evaluate whether to adopt upstream's version or maintain the fork's.
- The skill grows past ~500 lines — consider splitting into dispatch (orchestrator-facing) and execution (reviewer-facing) at that point.
- The operator adds or removes external review bots — the bot integration section needs updating.
