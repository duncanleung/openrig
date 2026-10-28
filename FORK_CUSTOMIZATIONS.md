# Fork customizations

This fork (`duncanleung/openrig`) carries code that `mvschwarz/openrig` (`upstream`) does not have.
A clean `git merge upstream/main` can silently remove it: git has no conflict when upstream deletes or
rewrites a region the fork only added to. Two merges did this and passed build and tests both times:

| Ticket | Commit | What was lost |
|---|---|---|
| RIG-136 | `c4302704d` | RIG-43 runtime fallback code in `seat-handover-service.ts` and `native-permission-store.ts` |
| RIG-130 | `91fb7c0bf` | 16 fleet-store migrations from the `ALL_MIGRATIONS` array |

Later drops found while building this manifest are listed under [Known gaps](#known-gaps).

## How to use this file

```bash
scripts/pre-merge-upstream.sh      # snapshot customized files (needs a clean tracked tree)
git merge upstream/main
scripts/post-merge-verify.sh       # exit 1 if any customization was dropped
```

`post-merge-verify.sh` runs every line of the `fork-checks` block below. A check is a behavior test, not
a name grep: a callsite check fails if a function is still defined but nothing calls it (the RIG-136
failure shape), an array check fails if an entry is missing or its import is gone, and the snapshot
comparison warns when a customized file loses RIG-tagged lines.

### Check types

| Type | Arguments | Passes when |
|---|---|---|
| `file` | `path` | the file exists |
| `has` | `path \| ERE` | the extended regex matches a line in the file |
| `callsite` | `defFile \| symbol \| callerFile` | `symbol` is declared in `defFile` and called (not declared, not in a comment) in `callerFile` |
| `array_min` | `file \| ARRAY \| N` | the exported array has at least `N` entries |
| `array_has` | `file \| ARRAY \| id1,id2` | each identifier is an entry of the array and is imported |

A leading `!` on an ID marks a **known gap**: the check fails today, reports `GAP`, and does not fail the
run. When the gap is fixed the check passes, which fails the run until the `!` is removed. That keeps the
gap list honest.

## How to add or update an entry

1. Find the fork code: `git diff upstream/main...origin/main --stat`, then
   `git diff upstream/main...origin/main -- <file>` for each file.
2. Pick a marker that proves the behavior, not the name. Prefer, in order: a `callsite` check that ties a
   definition to its caller; an `array_has`/`array_min` on a registry; a `has` on the one line that wires
   the feature (the route mount, the constructor call, the option pass-through).
3. Add the lines to the `fork-checks` block and a section below with the file, line range, ticket, and
   what the marker proves.
4. Run `scripts/post-merge-verify.sh` on a tree where the code is present (must PASS), then delete the
   marker line locally and run it again (must FAIL). A check you have not seen fail is not a check.

Line ranges are approximate and drift; the checks do not depend on them.

## Customizations

### RIG-43 runtime fallback (provider usage limit)

- `packages/daemon/src/domain/seat-handover-service.ts` ~L330-L560: `input.fallback` / `input.reverseSwap` force rebuild, pick `effectiveRuntime`, and pass `fallbackAuthorized` / `fallbackStateOpts` / `reverseSwapEvent` to the commit.
- `packages/daemon/src/domain/runtime-fallback-service.ts` (whole file): the service that calls `seatHandoverService.handover({ fallback: ... })` (~L104) and the reverse swap (~L175).
- `packages/daemon/src/db/migrations/090_node_runtime_fallback.ts`, `091_node_fallback_expires_at.ts`.
- Marker: `handover` is declared in the handover service and called from the fallback service, and `fallbackAuthorized: true` is still set. A rename or removal on either side fails the callsite check.

### RIG-138 cross-runtime permission derivation

- `packages/daemon/src/domain/native-permission-store.ts` ~L48-L62: `launchOverride(nodeId, runtime, { ignoreForeignRuntimeSelection })` derives the target runtime's defaults instead of throwing.
- `packages/daemon/src/domain/seat-handover-service.ts` ~L512: passes `{ ignoreForeignRuntimeSelection: crossRuntime }`.
- Marker: the option exists in the store, the handover service passes it, and `launchOverride` is called from the handover service. Dropping the pass-through is the semantic drop that string checks miss.

### Fleet store and digest migrations (RIG-79/80/9/60/87/88/89/84)

- `packages/daemon/src/db/all-migrations.ts` ~L1-L150 imports and ~L151-L300 array: 17 fork migrations (090, 091, 096-109, 129).
- Marker: all 17 schema identifiers are array entries and imports, and the array has at least 140 entries (140 on 2026-10-27). Raise the minimum when a migration lands.
- Update the count: `awk '/^export const ALL_MIGRATIONS/{f=1;next} f&&/^\];/{exit} f&&/^  [A-Za-z0-9_]+,/{n++} END{print n}' packages/daemon/src/db/all-migrations.ts`.

### RIG-139 statusLine override handling

- `packages/daemon/src/adapters/claude-code-adapter.ts` `provisionContextCollector` ~L1042-L1110: deletes an OpenRig-owned `statusLine` from `settings.local.json` when a user statusLine exists, and resolves the global path from `fs.homedir`.
- Marker: the `delete existing["statusLine"]` branch and the `fs.homedir ?? process.env["HOME"]` resolution.

### RIG-84 daemon cron

- `packages/daemon/src/domain/cron-job-scheduler.ts`, `cron-jobs-repository.ts`, `cron-schedule.ts`, `cron-command-path.ts`, `cron-default-jobs.ts`; `packages/daemon/src/routes/cron.ts`; migration 107.
- `packages/daemon/src/server.ts` ~L831: `app.route("/api/cron", cronRoutes())`.
- Marker: files present, route mounted. Construction and start are a known gap.

### RIG-79 turn-anomaly watchdog and RIG-123 stuck-seat observer

- `packages/daemon/src/domain/turn-anomaly-detector.ts`, `policies/turn-anomaly.ts`, migration 129; `startup.ts` ~L569 builds the detector and ~L2200 registers `makeTurnAnomalyPolicy({ detector })`.
- `packages/daemon/src/domain/stuck-seat-observer.ts`, `delivery-attempt-ledger.ts`; `startup.ts` ~L570 `new StuckSeatObserver(`.
- `packages/daemon/src/domain/operational-summary.ts` reads `turnAnomalies`.
- Marker: construction and policy registration lines in `startup.ts`, plus the summary field.

### RIG-80/60/9 fleet aggregation, digest redaction, suppress rules

- `packages/daemon/src/domain/fleet-store.ts`, `fleet-ingestion-service.ts`, `fleet-dashboard.ts`, `routes/fleet-store.ts`; `server.ts` ~L867 mounts `fleetStoreRoutes`; `packages/cli/src/commands/fleet.ts` registered in `packages/cli/src/index.ts`.
- `fleet-ingestion-service.ts` calls `redactDigestValue` (RIG-60); `review-suppress-rules.ts` + migration 109 (RIG-9).
- Marker: route mount, CLI registration, the redaction call, and the suppress-rules module.

### RIG-112/121 memory coverage

- `packages/daemon/src/domain/memory-coverage.ts`, `routes/memory-coverage.ts`; `server.ts` ~L875.
- Marker: `computeMemoryCoverage` is declared in the domain file and called from the route, and the route is mounted.

### RIG-120 operational summary

- `packages/daemon/src/domain/operational-summary.ts`, `routes/health.ts` ~L61, `packages/cli/src/commands/health.ts`.
- Marker: `computeOperationalSummary` is declared and called from the health route.

### RIG-61 rig rename

- `packages/daemon/src/domain/rig-rename-service.ts`, `rig-rename-db.ts`, `rig-rename-files.ts`, `rig-rename-manifest.ts`, `routes/rig-rename.ts`; `server.ts` ~L832; `packages/cli/src/commands/rename.ts` registered in `packages/cli/src/index.ts`.
- Marker: route mount and CLI registration.

### RIG-118 compaction lifecycle

- `packages/daemon/src/domain/claude-compaction-enforcer.ts`, `policies/compaction-lifecycle.ts`; `startup.ts` ~L2498 `new ClaudeCompactionEnforcer(`.

### RIG-116 and RIG-63 hooks

- `packages/daemon/assets/plugins/openrig-core/hooks/claude.json` registers `compaction-restore-bridge.cjs` (RIG-116) and `gateguard.cjs` (RIG-63); both scripts live in `hooks/scripts/`.
- Marker: both hook commands are in `claude.json` and both script files exist.

### RIG-87/88/89 ticket factory

- `packages/daemon/src/domain/ticket-admission-service.ts`, `ticket-factory-config.ts`, `ticket-factory-controller.ts`, `ticket-factory-cutover.ts`, `policies/ticket-factory-poll.ts`, `builtins/workflow-specs/ticket-factory.yaml`; migrations 104-106; `packages/cli/src/commands/ticket-factory.ts` registered in `packages/cli/src/index.ts`.
- Marker: files, migrations, CLI registration. Construction in `startup.ts` is a known gap.

### RIG-97/99 Jev classifier

- `packages/daemon/src/domain/jev-classifier.ts`, `src/jev-classifier-surface.ts`, `packages/cli/src/commands/ticket-factory-jev.ts`; `ticket-factory.ts` calls `runJevClassify`.

### RIG-83, RIG-101, RIG-116, RIG-117/118, RIG-111, RIG-98 (restored by RIG-146)

- `packages/cli/src/commands/start.ts`: `--last` applies `selectLastRunning` after upstream's stopped-on-purpose rule. `packages/cli/src/commands/ps.ts`, `packages/daemon/src/domain/node-inventory.ts`, `seat-status-service.ts`, `types.ts`: runtime fallback visibility.
- `packages/daemon/src/adapters/claude-code-adapter.ts`: `reconcileClaudeCompactionBridgeHooks`. `claude-compaction-enforcer.ts`: `stampRestoreRequestSent`. `watchdog-jobs-repository.ts`: `compaction-lifecycle`, `ticket-factory-poll`.
- `packages/daemon/src/domain/startup-orchestrator.ts`: `shouldDeliverAfterDecay`. `session-transport.ts`: `sendSerializedByName` and the post-Enter gap.
- Markers: the callsite checks `CF-19` to `CF-24` pin each function to its caller; they fail if either side is dropped again.

### RIG-77 validation gate (restored by RIG-145)

- `packages/daemon/src/domain/rigspec-schema.ts`: `"validation_gate"` in `RIG_KEYS`; the parse call in `validate`; `validateValidationGateBlock` and `normalizeValidationGate` at the end of the file; `validationGate` in `normalize`.
- `packages/daemon/src/domain/types.ts`: `ValidationGateConfigSpec` and `RigSpec.validationGate`.
- `packages/daemon/src/domain/queue-repository.ts`: `validationGatePredicate` option; the gate call in `createInTransactionalContext`, `handoff` and `handoffAndComplete`; `viaWorkflowProjection` on `QueueCreateInput`; `flushGateRequests` (advisor wake); stripping `work:mechanical` from inherited tags on handoff.
- `packages/daemon/src/startup.ts`: `validationGatePredicate: createValidationGatePredicate(db)` passed to `QueueRepository`; RIG-91 `workspaceRoot` passed to `WorkflowRuntime` so gate evidence files resolve.
- `packages/daemon/src/domain/validation-gate-enforcer.ts`: the predicate and checker. Its own tests passed while every seam above was missing, so the checks below pin the seams, not the enforcer.
- Marker: the schema accepts the key (15 of 22 live specs carry a block), the queue calls the gate at all three sites, and startup injects it.

### RIG-125 post-tool truncation hook

- `scripts/hooks/post-tool-truncate.sh`.

## Known gaps

A `!` ID in the checks block marks a customization that is known to be missing. It reports `GAP` and does
not fail the run. When it is restored the check passes, which fails the run until the `!` is removed.

Restored by RIG-142 (merge `e02d09c64`, "Merge tag v0.6.12", 2026-10-23, had dropped them): `new RuntimeFallbackService`
and the `runtimeFallbackTrigger` wiring (RIG-43), `new CronJobScheduler` with `cronJobScheduler?.start()` and the
`cron` shutdown phase (RIG-84), and `new TicketFactoryController` with the admission service and poll policy
(RIG-87/88/89).

Restored by RIG-143 (same merge): `new FleetIngestionService` with its lifecycle subscription, boot rollup and
reconcile timer (RIG-80), and the `shutdown-manifest` shutdown phase that calls `writeShutdownManifest` (RIG-83).

Restored by RIG-145 (same merge): the RIG-77 validation gate (schema, queue wiring, startup injection) and the
RIG-91 `workspaceRoot` pass-through.

Restored by RIG-146 (same merge): `rig start --last` applies the shutdown manifest (RIG-83); `formatRuntimeFallback`
and the fallback fields in `rig ps` and `rig seat status` (RIG-101); compaction restore bridge registration
(RIG-116); `stampRestoreRequestSent`, the `compaction-lifecycle` and `ticket-factory-poll` policy names, and the
shorter restore audit prompt (RIG-118, RIG-117); the delivery decay filter hook (RIG-111); the post-Enter gap and
send FIFO (RIG-98). Details are in the RIG-146 commits.

Restored by RIG-147 (the last two): the `node.startup_delivery_manifest` event, its type and its emission in
the startup orchestrator (RIG-36), and `globalSettingsCoversRelayEvents` hook dedup in the Claude adapter (RIG-3).

No gaps are open. One test, "an auto file that resolves to guidance_merge is not a bundle candidate" in
`startup-orchestrator.test.ts`, still fails for a different reason: upstream now routes per-seat role files such
as `guidance/role.md` to `send_text`, so the test premise is outdated. It is not a drop.

Pre-merge source for all of the above: `git show e02d09c64^1:packages/daemon/src/{startup,index}.ts`.

## Checks

Format: `ID | type | arg1 | arg2 | arg3`. Whitespace around `|` is trimmed. A regex may not contain `|`.

```fork-checks
# RIG-43 runtime fallback
CF-01-handover   | callsite  | packages/daemon/src/domain/seat-handover-service.ts | handover | packages/daemon/src/domain/runtime-fallback-service.ts
CF-01-fallback   | has       | packages/daemon/src/domain/seat-handover-service.ts | input\.fallback
CF-01-reverse    | has       | packages/daemon/src/domain/seat-handover-service.ts | input\.reverseSwap
CF-01-authorized | has       | packages/daemon/src/domain/seat-handover-service.ts | fallbackAuthorized: true
CF-01-orig       | has       | packages/daemon/src/domain/seat-handover-service.ts | fallback_original_runtime
CF-01-passes     | has       | packages/daemon/src/domain/runtime-fallback-service.ts | fallback: \{
CF-01-wired     | has       | packages/daemon/src/startup.ts | new RuntimeFallbackService

# RIG-138 cross-runtime permission derivation
CF-02-option     | has       | packages/daemon/src/domain/native-permission-store.ts | ignoreForeignRuntimeSelection\?: boolean
CF-02-passthru   | has       | packages/daemon/src/domain/seat-handover-service.ts | ignoreForeignRuntimeSelection: crossRuntime
CF-02-callsite   | callsite  | packages/daemon/src/domain/native-permission-store.ts | launchOverride | packages/daemon/src/domain/seat-handover-service.ts

# Fleet / digest / cron / ticket-factory migrations
CF-03-count      | array_min | packages/daemon/src/db/all-migrations.ts | ALL_MIGRATIONS | 140
CF-03-members    | array_has | packages/daemon/src/db/all-migrations.ts | ALL_MIGRATIONS | nodeRuntimeFallbackSchema,nodeFallbackExpiresAtSchema,sessionDigestsSchema,reviewRunsSchema,reviewFindingsSchema,dailyTokenSnapshotsSchema,digestTokenUsageSchema,digestEscalationCountSchema,digestSessionTimestampsSchema,digestSkillInvocationsSchema,ticketAdmissionsSchema,ticketFactoryControlSchema,ticketFactoryCutoverSchema,cronJobsSchema,digestStallPatternsSchema,reviewSuppressRulesSchema,turnAnomalySchema
CF-03-f090       | file      | packages/daemon/src/db/migrations/090_node_runtime_fallback.ts
CF-03-f091       | file      | packages/daemon/src/db/migrations/091_node_fallback_expires_at.ts
CF-03-f096       | file      | packages/daemon/src/db/migrations/096_session_digests.ts
CF-03-f097       | file      | packages/daemon/src/db/migrations/097_review_runs.ts
CF-03-f098       | file      | packages/daemon/src/db/migrations/098_review_findings.ts
CF-03-f099       | file      | packages/daemon/src/db/migrations/099_daily_token_snapshots.ts
CF-03-f100       | file      | packages/daemon/src/db/migrations/100_digest_token_usage.ts
CF-03-f101       | file      | packages/daemon/src/db/migrations/101_digest_escalation_count.ts
CF-03-f102       | file      | packages/daemon/src/db/migrations/102_digest_session_timestamps.ts
CF-03-f103       | file      | packages/daemon/src/db/migrations/103_digest_skill_invocations.ts
CF-03-f104       | file      | packages/daemon/src/db/migrations/104_ticket_admissions.ts
CF-03-f105       | file      | packages/daemon/src/db/migrations/105_ticket_factory_control.ts
CF-03-f106       | file      | packages/daemon/src/db/migrations/106_ticket_factory_cutover.ts
CF-03-f107       | file      | packages/daemon/src/db/migrations/107_cron_jobs.ts
CF-03-f108       | file      | packages/daemon/src/db/migrations/108_session_digest_stall_patterns.ts
CF-03-f109       | file      | packages/daemon/src/db/migrations/109_review_suppress_rules.ts
CF-03-f129       | file      | packages/daemon/src/db/migrations/129_turn_anomaly.ts

# RIG-139 statusLine override handling
CF-04-delete     | has       | packages/daemon/src/adapters/claude-code-adapter.ts | delete existing\["statusLine"\]
CF-04-home       | has       | packages/daemon/src/adapters/claude-code-adapter.ts | this\.fs\.homedir \?\? process\.env\["HOME"\]

# RIG-84 daemon cron
CF-05-scheduler  | file      | packages/daemon/src/domain/cron-job-scheduler.ts
CF-05-repo       | file      | packages/daemon/src/domain/cron-jobs-repository.ts
CF-05-route      | has       | packages/daemon/src/server.ts | app\.route\("/api/cron", cronRoutes\(\)\)
CF-05-wired     | has       | packages/daemon/src/startup.ts | new CronJobScheduler
CF-05-start     | has       | packages/daemon/src/index.ts | cronJobScheduler\?\.start\(\)

# RIG-79 turn anomaly, RIG-123 stuck-seat observer
CF-06-detector   | has       | packages/daemon/src/startup.ts | new TurnAnomalyDetector\(
CF-06-policy     | has       | packages/daemon/src/startup.ts | makeTurnAnomalyPolicy\(\{ detector: turnAnomalyDetector \}\)
CF-06-summary    | has       | packages/daemon/src/domain/operational-summary.ts | turnAnomalies
CF-07-observer   | has       | packages/daemon/src/startup.ts | new StuckSeatObserver\(
CF-07-ledger     | file      | packages/daemon/src/domain/delivery-attempt-ledger.ts

# RIG-80 fleet, RIG-60 redaction, RIG-9 suppress rules
CF-08-ingestion | has | packages/daemon/src/index.ts | new FleetIngestionService
CF-17-shutdown-manifest | has | packages/daemon/src/index.ts | writeShutdownManifest
CF-08-route      | has       | packages/daemon/src/server.ts | app\.route\("/api/fleet", fleetStoreRoutes\(
CF-08-cli        | has       | packages/cli/src/index.ts | fleetCommand
CF-08-redact     | callsite  | packages/daemon/src/domain/digest-redaction.ts | redactDigestValue | packages/daemon/src/domain/fleet-ingestion-service.ts
CF-08-suppress   | file      | packages/daemon/src/domain/review-suppress-rules.ts

# RIG-112/121 memory coverage
CF-09-route      | has       | packages/daemon/src/server.ts | app\.route\("/api/memory", memoryCoverageRoutes\(\)\)
CF-09-callsite   | callsite  | packages/daemon/src/domain/memory-coverage.ts | computeMemoryCoverage | packages/daemon/src/routes/memory-coverage.ts

# RIG-120 operational summary
CF-10-callsite   | callsite  | packages/daemon/src/domain/operational-summary.ts | computeOperationalSummary | packages/daemon/src/routes/health.ts

# RIG-61 rig rename
CF-11-route      | has       | packages/daemon/src/server.ts | rigRenameRoutes\(\)
CF-11-cli        | has       | packages/cli/src/index.ts | program\.addCommand\(renameCommand\(\)\)
CF-11-service    | file      | packages/daemon/src/domain/rig-rename-service.ts

# RIG-118 compaction lifecycle
CF-12-enforcer   | has       | packages/daemon/src/startup.ts | new ClaudeCompactionEnforcer\(
CF-12-policy     | file      | packages/daemon/src/domain/policies/compaction-lifecycle.ts

# RIG-116 / RIG-63 hooks
CF-13-bridge     | has       | packages/daemon/assets/plugins/openrig-core/hooks/claude.json | compaction-restore-bridge\.cjs
CF-13-gateguard  | has       | packages/daemon/assets/plugins/openrig-core/hooks/claude.json | gateguard\.cjs
CF-13-bridge-file| file      | packages/daemon/assets/plugins/openrig-core/hooks/scripts/compaction-restore-bridge.cjs
CF-13-gate-file  | file      | packages/daemon/assets/plugins/openrig-core/hooks/scripts/gateguard.cjs

# RIG-87/88/89 ticket factory
CF-14-yaml       | file      | packages/daemon/src/builtins/workflow-specs/ticket-factory.yaml
CF-14-cli        | has       | packages/cli/src/index.ts | program\.addCommand\(ticketFactoryCommand\(\)\)
CF-14-poll       | file      | packages/daemon/src/domain/policies/ticket-factory-poll.ts
CF-14-wired     | has       | packages/daemon/src/startup.ts | new TicketFactoryController

# RIG-97/99 Jev classifier
CF-15-surface    | file      | packages/daemon/src/jev-classifier-surface.ts
CF-15-callsite   | callsite  | packages/cli/src/commands/ticket-factory-jev.ts | runJevClassify | packages/cli/src/commands/ticket-factory.ts

# RIG-77 validation gate (and RIG-91 workspaceRoot)
CF-18-key        | has       | packages/daemon/src/domain/rigspec-schema.ts | "non_interruptive", "env", "validation_gate"
CF-18-parse      | callsite  | packages/daemon/src/domain/rigspec-schema.ts | validateValidationGateBlock | packages/daemon/src/domain/rigspec-schema.ts
CF-18-normalize  | callsite  | packages/daemon/src/domain/rigspec-schema.ts | normalizeValidationGate | packages/daemon/src/domain/rigspec-schema.ts
CF-18-type       | has       | packages/daemon/src/domain/types.ts | validationGate\?: ValidationGateConfigSpec
CF-18-inject     | has       | packages/daemon/src/startup.ts | validationGatePredicate: createValidationGatePredicate\(db\)
CF-18-predicate  | callsite  | packages/daemon/src/domain/validation-gate-enforcer.ts | createValidationGatePredicate | packages/daemon/src/startup.ts
CF-18-create     | has       | packages/daemon/src/domain/queue-repository.ts | viaWorkflowProjection: input\.viaWorkflowProjection
CF-18-handoff    | has       | packages/daemon/src/domain/queue-repository.ts | tags: rawTags,
CF-18-handoffac  | has       | packages/daemon/src/domain/queue-repository.ts | tags: rawTagsHAC,
CF-18-flush      | callsite  | packages/daemon/src/domain/queue-repository.ts | flushGateRequests | packages/daemon/src/domain/queue-repository.ts
CF-18-workspace  | has       | packages/daemon/src/startup.ts | workspaceRoot: \(\) => healthSettingsStore

# Restored by RIG-146 (symbols that existed in e02d09c64^1)
CF-19-ps-fallback    | callsite | packages/cli/src/commands/ps.ts | formatRuntimeFallback | packages/cli/src/commands/ps.ts
CF-20-decay-filter   | callsite | packages/daemon/src/domain/startup-orchestrator.ts | shouldDeliverAfterDecay | packages/daemon/src/domain/startup-orchestrator.ts
CF-21-delivery-gap   | callsite | packages/daemon/src/domain/session-transport.ts | sendSerializedByName | packages/daemon/src/domain/session-transport.ts
CF-22-restore-stamp  | callsite | packages/daemon/src/domain/claude-compaction-enforcer.ts | stampRestoreRequestSent | packages/daemon/src/domain/claude-compaction-enforcer.ts
CF-23-start-last     | has | packages/cli/src/commands/start.ts | selectLastRunning\(
CF-24-bridge-register | callsite | packages/daemon/src/adapters/claude-code-adapter.ts | reconcileClaudeCompactionBridgeHooks | packages/daemon/src/adapters/claude-code-adapter.ts

# Open gaps found by RIG-146 (present in e02d09c64^1, absent now)
CF-25-delivery-manifest | has | packages/daemon/src/domain/types.ts | type: "node.startup_delivery_manifest"
CF-26-hook-dedup | callsite | packages/daemon/src/adapters/claude-code-adapter.ts | globalSettingsCoversRelayEvents | packages/daemon/src/adapters/claude-code-adapter.ts
CF-25-emit | has | packages/daemon/src/domain/startup-orchestrator.ts | type: "node.startup_delivery_manifest"
CF-25-record | has | packages/daemon/src/domain/startup-orchestrator.ts | recordDelivered\(f, "post_launch"\)

# RIG-125 truncation hook
CF-16-hook       | file      | scripts/hooks/post-tool-truncate.sh
```
