---
title: Observer capture and activity hooks
type: context
confidence: high
last_verified: 2026-09-27
tags: [daemon, observer, hooks, ope-2, ope-3, ope-5]
related: [[hook-dedup-and-cwd-home]]
source: session
---

# Observer capture and activity hooks (RIG-2/3/5)

## What was built

Three tickets implemented together in PR #1 and PR #2:

- **RIG-2**: Observer provisioning — statusLine context collector injection
  with dedup when a global user statusLine exists
- **RIG-3**: Activity hooks — relay script delivery to project-level
  `settings.local.json` with global-covers-relay dedup
- **RIG-5**: E2E test suite for dedup logic with real filesystem operations

## Key design decisions

1. **statusLine dedup**: if the user has a global statusLine in
   `~/.claude/settings.json`, the daemon removes any OpenRig statusLine from
   the project. User-defined project statusLines are preserved.

2. **Activity hook dedup**: the daemon checks whether global `settings.json`
   already covers all relay events. If yes, no project-level hooks are written.
   This prevents duplicate event delivery.

3. **settings.local.json**: the adapter writes to `settings.local.json`, never
   `settings.json`. This is a Claude Code convention — `.local` files are
   project-scoped and gitignored.

## ADRs

- ADR-0004 (accepted): native plan-validation skill, created during this work
