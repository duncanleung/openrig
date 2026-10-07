---
title: Fleet store ingestion service
type: context
confidence: high
last_verified: 2026-10-06
tags: [daemon, fleet, ingestion, analytics]
related: [[observer-capture-and-activity-hooks]]
source: session
---

# Fleet store ingestion service (PR #14)

## What was built

`FleetIngestionService` — daemon-internal service that discovers source files,
transforms them, and upserts into the four fleet analytics tables introduced in
migrations 096–099.

**Tables populated:**
- `session_digests` — transcript summaries (tool calls, errors, handoff events)
- `review_runs` — code review execution metadata
- `review_findings` — individual findings from code reviews
- `daily_token_snapshots` — per-seat per-day token usage deltas

**Three trigger paths:**
- **A — Daemon scheduler** (primary): boot + 5-minute timer
- **B — CLI commands** (backfill/repair): `rig fleet reconcile`
- **C — Lifecycle hooks** (Phase 2): `session.stopped` event triggers immediate single-session digest ingestion + recent review log scan

## Key design decisions

1. **Retention ordering is critical.** `rollUpSnapshots` must run BEFORE
   `pruneUsageSamples` in the retention sweep. If pruning runs first, token data
   is lost permanently. Coordinated via optional `deps.fleetIngestion` in
   `runQueueRetentionSweep`, and at boot (rollup runs before retention scheduler
   starts).

2. **Route wiring uses a getter.** `fleetIngestion` is passed to routes as
   `() => deps.fleetIngestion` (not a plain value) because the service is
   constructed after `createApp` runs. Matches the `db: () => deps.rigRepo.db`
   pattern. Original PR had an eager-copy bug (always 503); fixed before merge.

3. **Digest adaptation gap.** `reduce-transcript.mjs` output schema differs from
   `SessionDigestInput`. `adaptDigest()` maps `seat` → `seatSession`, stringifies
   object fields, extracts `nativeSessionId` from filename, defaults missing
   fields to `"[]"`.

4. **Token snapshot rollup algorithm.** Computes positive-delta per day per seat
   from `usage_samples`. Includes previous-day baseline for the first sample.
   Counts resets. Guards against overwriting higher-sample-count rows.

5. **Identity enrichment is best-effort.** Rig name, seat name, node ID, and
   generation UUID come from joining the session registry by `nativeSessionId`.
   If no match, fields stay `null`.

6. **Source hash for idempotence.** `sourceHash()` (first 4KB + size + mtime)
   lets the service skip unchanged files on subsequent runs.

7. **Review findings: full reconciliation.** `upsertReviewRun` accepts
   `findings: ReviewFindingInput[] | null`. An array deletes stale rows
   via `NOT IN (...)`; `null` preserves existing findings (parse-error
   safety). Both callers build into a local array and assign only after
   the loop completes.

## Files

| File | Role |
|------|------|
| `packages/daemon/src/domain/fleet-ingestion-service.ts` | Core service (~539 lines) |
| `packages/daemon/test/fleet-ingestion-service.test.ts` | 15 unit tests |
| `packages/daemon/src/domain/queue-retention.ts` | Modified — rollup before prune |
| `packages/daemon/src/index.ts` | Modified — boot wiring, timer lifecycle |
| `packages/daemon/src/routes/fleet-store.ts` | Modified — POST /reconcile endpoint |
| `packages/daemon/src/server.ts` | Modified — route registration with getter |
| `packages/cli/src/commands/fleet.ts` | Modified — `fleet reconcile` subcommand |

## Follow-up items

- ~~**Phase 2: Lifecycle hooks**~~ — shipped. `session.stopped` events trigger
  `ingestSessionByNodeId` (single transcript) + debounced `ingestRecentReviews`
  (10-min window). Event bus subscription wired at boot, unsubscribed at shutdown.
- ~~**Review findings full reconciliation**~~ — shipped. `upsertReviewRun` now
  DELETEs stale findings inside the transaction after upserting the current batch.
- ~~**Overlap guard**~~ — shipped. `reconciling` flag on the service skips
  concurrent `reconcile()` calls and returns `skippedOverlap: true`.
- ~~**Configurable interval**~~ — shipped. `OPENRIG_FLEET_RECONCILE_INTERVAL_MS`
  env var overrides the default 5-min scheduler interval.
