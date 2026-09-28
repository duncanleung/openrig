---
title: OPE to RIG rename
type: episode
confidence: high
last_verified: 2026-09-28
tags: [linear, project-management]
source: session
---

# OPE to RIG rename

## What happened

The Linear project/team was renamed from "OPE" to "RIG" on 2026-09-27.
Linear updated existing issue prefixes automatically (OPE-1 → RIG-1, etc.).

## Codebase changes

Three test files had OPE ticket references in comments and describe blocks:

- `packages/daemon/test/observer-dedup-e2e.test.ts` — OPE-2 → RIG-2, OPE-3 → RIG-3
- `packages/daemon/test/claude-activity-hook-delivery.test.ts` — OPE-3 → RIG-3

Committed on `main` at `8bc1392`.

No ADR references needed updating. No source code (only comments) was affected.

## PIPE → RIG consolidation

On 2026-09-28, all 27 issues from the PIPE team ("Agent Pipeline") were moved
to the RIG team under the "open-rig" project. PIPE-1 through PIPE-27 became
RIG-6 through RIG-32. The PIPE team was then deleted.

PIPE had two clusters:
- **Orchestration/autonomy** (Done): authority boundaries, OPORD briefs,
  autonomous loop, fleet/lead skills, observer messaging, push notifications
- **Review pipeline** (Backlog): code review improvements (validators, scoring,
  DSPy optimization, judge routing, finding tracking)

Both are agent workflow work. RIG is the single team for all OpenRig and agent
infrastructure work.
