---
title: Hook dedup and cwdIsHome guard
type: context
confidence: high
last_verified: 2026-10-06
tags: [daemon, hooks, dedup, claude-code]
related: [[observer-capture-and-activity-hooks]]
source: session
---

# Hook dedup and cwdIsHome guard

## What happened

The daemon's `claude-code-adapter.ts` had a `cwdIsHome` guard that skipped
activity-hook dedup when a node's `cwd` was `$HOME`. The guard was introduced
to prevent "oscillating hook state" when project and global scopes share the
same `.claude/` directory.

## Why it was removed

A dual-stack code review (PR #2) found the guard was based on a false premise.
Deep research confirmed two facts:

1. Claude Code has native handler-level dedup: "If you define the same handler
   in more than one settings file, it runs once." The adapter writes to
   `settings.local.json` (line 626), never `settings.json`.
2. `settings.json` and `settings.local.json` are distinct tiers regardless of
   sharing the same `.claude/` directory. The cwd=home scenario does not create
   a collision.

The guard forced `globalCoversRelay = false` when cwd was home, which meant
relay hooks were written to the project scope even when the global scope
already covered all events — the opposite of what dedup should do.

## Current behavior

Dedup applies unconditionally. If global `settings.json` covers all relay
events, no project-level relay hooks are written — even when cwd is `$HOME`.

## Relay deployment path (PR #13, 2026-10-06)

The relay script (`activity-relay.cjs`) now deploys to `~/.openrig/hooks/scripts/`
instead of `<cwd>/.openrig/hooks/scripts/`. The old project-local path was
vulnerable to `git clean -fdx` removing the relay script, which caused silent
hook failure.

The home directory is resolved via `this.fs.homedir ?? process.env.HOME ?? cwd`.
The `restore-check-service.ts` relay path uses the same resolution chain.

Delivery uses an atomic temp+rename pattern (`deliverFileAtomically`): write to
a temp sibling, `preserveMode`, then `rename(2)`. This prevents a concurrent
hook invocation from reading a half-written relay. The method skips the copy
when the destination content already matches the source, and falls back to
non-atomic `copyFile` when `rename` is unavailable or throws.

## Files

- `packages/daemon/src/adapters/claude-code-adapter.ts` — dedup logic at the
  `globalCoversRelay` assignment; `deliverFileAtomically` helper; relay path
  construction at `reconcileClaudeActivityHooks`
- `packages/daemon/test/observer-dedup-e2e.test.ts` — E2E tests for all dedup
  scenarios including cwd=home
- `packages/daemon/test/claude-activity-hook-delivery.test.ts` — unit tests
  for hook delivery with cwd=home, atomic delivery, skip-when-identical,
  and rename-throws fallback
