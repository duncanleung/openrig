---
id: ADR-0007
title: Daemon cron for orchestration-layer scheduled jobs
status: proposed
date: 2026-10-15
tags: [daemon, cron, scheduling, launchd, orchestration]
supersedes: []
related: [ADR-0006]
---

## Context

Scheduled work on the operator's machine runs from two places. launchd runs the data-pipeline jobs
(EDGAR, price feeds, rebalance, pure-compute quality-investor) and, until now, one orchestration
job: `com.openrig.fleet-audit`, the daily token audit from ADR-0006 (`scripts/fleet-audit.sh`).

The fleet audit reads the daemon's own database (`daily_token_snapshots`, `review_runs`) and alerts
about the daemon's own rigs. It is orchestration-layer work, but it lives outside the daemon. Its
schedule, last result, and failures are invisible to `rig` and to the daemon API. Each new
orchestration job would need its own plist, its own log path, and its own `launchctl` steps.

The daemon already has two schedulers. `WatchdogScheduler` runs session-targeted policy jobs on an
interval. `PeriodicSnapshotScheduler` runs one fixed loop. Neither runs a wall-clock job such as
"daily 06:00".

## Decision

Orchestration-layer jobs, the ones that depend on the daemon's database or queue, run inside the
daemon through `CronJobScheduler` (`packages/daemon/src/domain/cron-job-scheduler.ts`). Data-pipeline
jobs stay on launchd.

The scheduler has these properties:

1. **Shell kind only.** The `cron_jobs.kind` column accepts `shell` and nothing else. A command is an
   absolute path whose real path sits under `OPENRIG_HOME` or an explicitly allow-listed directory.
   It runs as an argv array with no shell.
2. **Catch-up guard.** `last_run_at` is the slot time. The scheduler writes it in the same synchronous
   UPDATE that decides the job is due, before the child starts. After a restart it runs the most
   recent missed slot at most once, and only inside `catchup_window_seconds` (default 6 hours).
3. **Minimal child environment.** The child receives `PATH`, `HOME`, and `OPENRIG_HOME`. The
   daemon's `process.env` is never passed through.
4. **Execution timeout.** Each job has a `timeout_seconds` (default 300). On timeout the scheduler
   sends SIGTERM to the child's process group, then SIGKILL after a short grace period.
5. **Non-blocking lifecycle.** The scheduler starts post-bind. The first (catch-up) tick runs from a
   timer, so a slow or failing job cannot delay or crash startup. `stop()` runs in the named `cron`
   shutdown phase, kills any child, and is idempotent.

Schedules support `daily HH:MM` and `weekly <sun..sat> HH:MM` in the daemon's local timezone. The
first job is `fleet-audit` (`daily 06:00`), running the existing `fleet-audit.sh` unchanged.

## Rejected Alternatives

- **One launchd agent per orchestration job.** This is the status quo. Each job adds a plist, a
  log path, and manual `launchctl` steps. The daemon cannot see the result. Rejected because the
  visibility and registration gap grows with every job.
- **An agent `/loop` or `ScheduleWakeup` poll.** A loop lives in an agent session and dies on
  compaction or seat replacement (the failure ADR-0006 documents). A daily audit must not depend
  on an agent staying alive. Rejected.
- **Extend watchdog jobs.** Watchdog jobs target a session and run on a fixed interval. A wall-clock
  slot with catch-up and a shell command does not fit that model, and bending the model would
  weaken the session-targeted contract. Rejected.
- **A cron npm dependency.** A new dependency is an escalation, and daily and weekly slots need
  about 60 lines of date math with full tests. Rejected for now. Revisit if 5-field cron
  expressions become necessary.

## Rationale

The daemon already owns the data the audit reads, the queue the alerts will route through, and a
supervised lifecycle with ordered shutdown. Running the job there gives one registration API, one
place to read the last result, and one process to monitor.

The split follows the dependency, not the job's importance. A job that needs the daemon's database
or queue belongs in the daemon. A job that must keep running when the daemon is down, such as a
market-data pull, belongs in launchd. launchd stays the dependable layer under the daemon; the
daemon does not replace it.

The shell-only, path-validated, minimal-environment design keeps the new execution surface small.
Registration is an HTTP call on the daemon's local API, so the command allow-list is the main
control. The scheduler never inherits the daemon's secrets. `fleet-audit.sh` already sources its own
`fleet-audit.env`.

## Consequences

- The audit does not run while the daemon is down. The catch-up window (6 hours) covers a short
  outage across 06:00. A longer outage skips that day's audit.
- During cutover, both launchd and the daemon can run the audit and send double Pushover alerts.
  The runbook (`docs/reference/daemon-cron.md`) sets the order: register, verify one run, then
  `launchctl bootout` the launchd agent. Rollback disables the cron job first.
- A new table, `cron_jobs` (migration 107), and a new API, `/api/cron/jobs`.
- Only the `shell` kind exists. A `queue-create` kind is deliberately absent. Add it only with a
  consumer and its own decision.
- Schedules are local time. A slot inside a spring-forward gap runs once at the first valid
  instant. A slot inside a fall-back hour runs once, at its first occurrence.

## Revisit Triggers

- The daemon is down at 06:00 often enough that audits are missed. Consider a longer catch-up
  window, or move the job back to launchd.
- The job count grows past a handful, or jobs need dependencies, retries, or overlap rules.
- A job needs to create queue items. That needs a `queue-create` kind and a consumer.
- A schedule needs more than daily or weekly. That needs 5-field cron expressions, and a decision
  on a dependency.
