---
id: ADR-0001
title: Migrate custom orchestration skills to OpenRig native skills
status: proposed
date: 2026-09-26
tags: [orchestration, skills, migration, agent-coordination]
supersedes: []
related: [ADR-0002, ADR-0003]
---

# 0001 — Migrate custom orchestration skills to OpenRig native skills

Date: 2026-09-26
Status: Proposed

## Context

Four custom Claude Code skills governed multi-agent orchestration:

- `/orchestrate-lead` — pipeline routing, agent dispatch, OPORD briefing
- `/orchestrate-goal` — goal decomposition, epistemic-gap pre-flight, gate sequencing
- `/orchestrate-review` — PR review→fix→merge lifecycle with bot integration
- `/orchestrate-handoff` — external state ledger, continuation records, restore contracts

These skills lived in `~/.claude/skills/orchestrate-*/` on the operator's machine. They accumulated hard-won operational knowledge over months of multi-agent work: the 3-cycle escalation limit that prevents infinite review→fix loops, the external state ledger that makes Phase B recovery possible, the validation gate that catches bad plans before implementation burns context.

The problem: custom skills are machine-local. They do not ship with the daemon, do not load automatically for rig agents, and do not survive across machines or operator accounts. An orchestrator agent loads them only when the operator's `~/.claude/skills/` directory is present and the agent's profile includes them. A fresh seat, a new machine, or a different operator gets none of this knowledge.

OpenRig 0.5.x introduced native skill infrastructure: skills in `packages/daemon/assets/plugins/openrig-core/skills/` ship with the daemon and load automatically via the `openrig-core` plugin declared in agent YAML. Every agent in every rig gets them without per-machine setup.

## Decision

Port the operational protocols from the four custom skills into OpenRig's native skill surfaces, then delete the custom skills. Condense during the port — do not copy verbatim.

Ports land in existing native skills where the content fits naturally:

- External state ledger → `queue-handoff`
- Worktree dispatch convention → `orchestration-team`
- 3-cycle review-fix escalation → `orchestration-team`
- Continuation records, prior-art checks, OPORD extensions → `orchestration-team` and `session-compaction-and-restore`

Two decisions that introduce new structural choices have their own ADRs:
- → ADR-0002: `pr-review-lifecycle` as a standalone skill
- → ADR-0003: fork-specific validation gate in orchestrator role guidance

The custom skills totaled ~1200 lines across four files plus references. The condensed ports total ~185 lines. The reduction comes from removing ceremony, merging overlapping sections, and dropping content already covered by existing native skills (`product-journey-sdlc`, `requirements-writer`, `openrig-operating-model`). Codex validation (gpt-6-astra, read-only) reduced 13 candidate port items to 5 by checking each against existing native coverage.

## Rejected Alternatives

**Keep custom skills alongside OpenRig native skills.** Dual sources create precedence ambiguity — when the custom skill says one thing and the native skill says another, agents follow whichever they read last. Maintenance burden doubles. The custom skills also reference `herdr` commands and pane management that no longer apply in OpenRig's `rig send`/`rig capture` model.

**Port everything verbatim.** ~60% of the custom skill content is already covered by existing native skills. Verbatim ports would create duplication and contradictions with `product-journey-sdlc.md` and `orchestration-team`.

**Write a new unified orchestration skill.** The protocols serve different concerns (handoff mechanics, review lifecycle, dispatch conventions, compaction continuity) that belong in their respective skill homes. A monolithic skill would duplicate content already in `queue-handoff`, `orchestration-team`, and `session-compaction-and-restore`.

## Rationale

Custom skills were the right vehicle when OpenRig's skill infrastructure did not exist. Now that it does, the knowledge must move to where every agent reads it automatically. The native skill system is the durable home.

The condensation is deliberate. The custom skills grew organically and accumulated redundancy with each other and with OpenRig's own skills. The port is a chance to merge overlapping content and drop what the native system already covers.

## Consequences

- All rig agents gain the operational protocols without per-machine setup.
- The operator's `~/.claude/skills/orchestrate-*/` directory can be deleted after ports complete.
- The custom skills' wiki documentation (in Obsidian) preserves the original design for reference.
- Future operational knowledge accrues in native skills, not in personal dotfiles.
- Fork-specific content in native skill files creates a merge surface with upstream. Upstream updates to `queue-handoff`, `orchestration-team`, or `role.md` may conflict with ported sections.

## Revisit Triggers

- OpenRig introduces its own validation or review protocol that conflicts with ported content.
- The fork diverges far enough from upstream that maintaining ported content becomes a merge burden.
- OpenRig adds a plugin mechanism for operator-specific skill extensions (would remove the need to edit native files directly).
