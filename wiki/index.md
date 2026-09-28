---
title: Project Wiki Index
last_updated: 2026-09-27
---

# OpenRig Project Wiki

Agent-curated project memory. Orchestrators read this index at session start.
Agents update pages via the `/wiki-update` skill at session wrap-up.

Pages carry `confidence` and `last_verified` metadata. Treat `low` confidence
pages as leads, not facts. Verify before acting on stale entries.

## Active topics

- [[hook-dedup-and-cwd-home]] — activity-hook dedup logic, cwdIsHome guard removal, and why global/project scopes are distinct
- [[research-analyst-seat]] — research pod added to all rigs, rationale and runtime choices
- [[ope-to-rig-rename]] — Linear project renamed from OPE to RIG, codebase references updated
- [[observer-capture-and-activity-hooks]] — OPE-2/3/5 implementation: observer provisioning, statusLine dedup, activity-hook delivery

## Decisions

- [[adr-index]] — pointer to formal ADRs in `docs/decisions/`

## Corrections

- [[no-upstream-pr-review]] — never review PRs on upstream when working from a fork
