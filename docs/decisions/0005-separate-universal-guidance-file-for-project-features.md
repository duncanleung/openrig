---
id: ADR-0005
title: Separate universal guidance file for project-level features
status: proposed
date: 2026-09-28
tags: [architecture, startup, guidance, wiki]
supersedes: []
related: [ADR-0003]
---

# 0005 — Separate universal guidance file for project-level features

Date: 2026-09-28
Status: Proposed

## Context

RIG-33 required extending wiki-read guidance from the orchestrator role to all
agent seats. The initial implementation placed the wiki section directly in
`openrig-start.md` — the universal boot overlay delivered unconditionally to
every seat via step 7 of `buildResolvedStartupFiles`.

A dual-stack code review (25 agents, PR #4) found two problems:

1. **Thin-overlay contract violation.** `openrig-start.md` has a tested contract
   (`pod-rigspec-instantiator.test.ts:518-545`) stating: "no operating-model
   SDLC and no skill-library routing may ride the default boot overlay — they
   are opt-in layers, delivered by profile/startup config, never hardcoded
   here." The file declares itself identity-only (line 6: "Its only job is to
   get you your identity"). A 2500-byte ceiling enforces this.

2. **First fork divergence in a universal file.** Before this PR,
   `openrig-start.md` had zero diff from upstream. ADR-0003 placed its
   fork-specific content in `role.md` because validation is an orchestrator
   responsibility — a placement-by-responsibility decision. That precedent
   supports choosing the file whose responsibility matches the content, not a
   blanket rule against fork content in universal files.

The review's adversarial challenge found that the obvious alternative —
routing through `rigSpec.startup.files` — would not be truly universal. There
are 13 independent `rig.yaml` files with no base-template inheritance, and the
existing analog (`culture_file`) is inconsistently applied (8-9 of 13). This
would reproduce the same per-rig-manual-wiring gap that RIG-33 was filed to
eliminate.

## Decision

Add a second unconditional guidance file — `openrig-project-guidance.md` —
delivered alongside `openrig-start.md` in step 7b of
`buildResolvedStartupFiles`. This file carries project-level features that
apply to all seats but do not belong in the thin identity overlay.

A third unconditional surface already exists: `CULTURE-default.md` is
delivered before the optional rig culture overlay
(`rigspec-instantiator.ts:324`). Feature instructions belong in a separate
file from operating principles, so culture is not the right home for wiki
guidance. The two new files have distinct scopes:

| File | Scope | Contract |
|------|-------|----------|
| `openrig-start.md` | Identity resolution: whoami, peer verbs, transcript warning, ask-don't-infer | Thin overlay, 2500-byte ceiling, zero fork divergence |
| `openrig-project-guidance.md` | Project features delivered to all seats: wiki read, future cross-seat guidance | 4000-byte budget (soft), fork-specific content expected |

Both are unconditionally selected (no resolver gate, no per-rig opt-in).
Both use `deliveryHint: "guidance_merge"`, `required: false`,
`appliesOn: ["fresh_start", "restore"]`. Because `required` is `false`, a
delivery failure (e.g., missing asset file) is silently skipped rather than
blocking startup. Unconditional selection guarantees the file is always
*attempted*; it does not guarantee the seat receives it.

## Rejected Alternatives

**Keep wiki in openrig-start.md and raise the byte ceiling.** Simplest change,
but contradicts the thin-overlay contract's stated intent. The contract exists
to prevent accretion — raising the ceiling each time a feature needs universal
delivery defeats the guard. The file's own documentation says it is
identity-only; adding features silently redefines it.

**Route through rigSpec.startup.files.** Satisfies the contract but is not
universal. 13 independent `rig.yaml` files would each need a `startup.files`
entry, with no inheritance mechanism to ensure consistency. The existing
`culture_file` field demonstrates this failure mode: only 8-9 of 13 templates
set it.

**Route through rigSpec.cultureFile.** Same inconsistency problem as
`startup.files`. Culture files are rig-configured, not daemon-delivered. A
project feature that must reach every seat regardless of rig configuration
cannot depend on per-rig opt-in.

**Revert to orchestrator-only wiki read.** Abandons the RIG-33 requirement.
Non-orchestrator seats (implementers, reviewers, QA) lose cross-session
context, reducing wiki utility to a fraction of the topology.

## Rationale

The thin-overlay contract on `openrig-start.md` is a real, tested design
boundary. It prevents the universal file from growing into an everything-file
that is impossible to merge with upstream and impossible to reason about at
session start. Respecting it costs one additional file push in the
instantiator — a trivial mechanical cost.

The separate file preserves universality (unconditional delivery, no per-rig
opt-in) while keeping identity resolution isolated. Future project-level
features that need all-seat delivery have a clear home without reopening the
thin-overlay question each time.

ADR-0003 placed fork-specific content in the file whose responsibility matched
the content (orchestrator validation → `role.md`). This decision applies the
same principle: project-level feature guidance goes in
`openrig-project-guidance.md` (whose responsibility is project features) rather
than `openrig-start.md` (whose responsibility is identity resolution).

## Consequences

- `openrig-project-guidance.md` is a new unconditional selection point with a
  4000-byte soft budget. Future all-seat guidance (e.g., LEARNED.md conventions,
  cross-seat protocols) has a home without touching `openrig-start.md`. The
  budget prevents the same accretion problem the thin-overlay ceiling guards
  against.
- The file will diverge from upstream by design. Merge conflicts are expected
  and localized to this file.
- The instantiator now has two unconditional pushes in step 7 (7 and 7b).
  Adding more requires the same ADR-level justification — unconditional
  delivery is powerful and should remain deliberate.
- `openrig-start.md` can maintain zero upstream divergence indefinitely. The
  thin-overlay test continues to guard it without exceptions.

## Revisit Triggers

- Upstream adds a built-in mechanism for project-level guidance delivery (a
  resolver, a config field, or a convention). Evaluate whether it replaces the
  unconditional push.
- The number of unconditional guidance files grows past 3. At that point,
  consider a single `openrig-project-guidance/` directory with a manifest
  instead of individual pushes.
- `rigSpec.startup.files` gains base-template inheritance, making per-rig
  delivery as reliable as unconditional delivery. Re-evaluate the tradeoff.
