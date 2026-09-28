---
title: OPE to RIG rename
type: episode
confidence: high
last_verified: 2026-09-27
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
