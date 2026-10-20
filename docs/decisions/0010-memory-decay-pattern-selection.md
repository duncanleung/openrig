---
id: ADR-0010
title: Memory decay pattern selection waits for a live evaluation
status: proposed
date: 2026-10-20
tags: [memory, decay, evaluation, delivery]
supersedes: []
related: [ADR-0009]
---

# ADR-0010: Memory decay pattern selection waits for a live evaluation

## Context

RIG-111 (child of RIG-36) asks the daemon to decay memory so that stale surfaces stop reaching agents. Two candidate patterns exist:

1. **Access-weighted retention.** Surfaces that are accessed more often persist longer. Unused surfaces decay on a schedule.
2. **Dreaming promotion gates.** A periodic pass promotes high-value ephemeral knowledge to durable surfaces and demotes stale durable knowledge.

The RIG-110 evaluation harness uses a stub runner with canned transcripts. A score from it is an input the test author wrote, not a measurement. It can check mechanics. It cannot show which pattern makes agents behave better. A real comparison needs live seat runs, which need keys and a fixture seat that a human provides.

Wiki pages, LEARNED.md entries and auto-memory are operated on by openrig-memory. The daemon only decides what it delivers at startup.

## Decision

1. Add a `DeliveryDecayFilter` to the startup delivery pipeline: `shouldDeliver(item: { surface, path, lastAccess, accessCount }): boolean`. It runs per file, between classification and phase partition:
   resolve files -> classify by surface -> filter by decay -> partition by phase -> deliver.
   It is not a watchdog `Policy`, which runs per session on a timer tick.
2. Ship both candidates as pluggable implementations (`AccessWeightedRetention`, `DreamingPromotionGates`). Select neither.
3. Decay is off by default. With no filter set, delivery is unchanged. A filter or stat failure delivers the file.
4. v1 staleness signal is file mtime. Access count is not tracked, so it is passed as 0 and the access-weighted bonus has no effect until v2 records accesses.
5. Selection of a winner waits for a human-gated live evaluation run that scores each candidate with the RIG-110 scorer (`scoreMemoryComparison`). That run produces a superseding or amending ADR.
6. Promotion is a write to a durable surface. It belongs to openrig-memory. The daemon only names candidates (`promotionCandidates`).

## Rejected alternatives

### Choose a winner now from the stub harness
Rejected. The scores would be authored, so the ADR would rest on invented evidence.

### Implement decay as a watchdog policy
Rejected. A policy evaluates one job per timer tick. Decay is a per-file decision at delivery time.

### Turn a candidate on by default
Rejected. A wrong default silently removes memory from agents, and no evidence yet shows either pattern helps.

## Rationale

The interface lets the live run swap candidates without changing the daemon. Keeping decay off by default and failing open means the change cannot lose context until someone enables a filter on purpose.

## Consequences

- No behavior change until a filter is wired in and enabled. The daemon has no setting for it yet.
- Under mtime only, the access-weighted pattern behaves as a plain age cutoff.
- A later ADR must record the evaluation result and the chosen pattern.

## Revisit triggers

- A live with/without-decay evaluation run exists.
- The daemon records per-surface access counts.
- A surface is found to be dropped by decay while still needed.
