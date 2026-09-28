---
title: Research analyst seat
type: context
confidence: high
last_verified: 2026-09-27
tags: [rigs, seats, research]
related: [[observer-capture-and-activity-hooks]]
source: session
---

# Research analyst seat

## What was added

A `research` pod with an `analyst` member was added to all 9 live rigs in
`~/.openrig/specs/`. The seat uses the `research/analyst` agent spec at
`packages/daemon/specs/agents/research/analyst`.

## Runtime choices

Most rigs use `claude-code` runtime for the analyst. The `first-project` rig
uses `codex` runtime with `gpt-6-astra` — this was a deliberate choice to
give the starter rig cross-family diversity.

## How it was applied

Used `rig expand` with pod fragment YAML files. Each fragment specifies the
pod structure (id, label, members with agent_ref, runtime, cwd). The command
requires the ULID rig ID (not the name) — use `rig ps --json` to get it.

Four of 8 `rig expand` calls timed out (5000ms daemon timeout) but all
expansions landed. Verify with node counts after batch expand.

## Scope decision

The shipped rig templates (`packages/daemon/specs/rigs/launch/`) were NOT
modified. Those are stock defaults for all OpenRig users. The research seat
was added only to personal live rigs. Modifying stock templates is a product
decision, not a personal configuration choice.
