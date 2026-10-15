import type Database from "better-sqlite3";
import { ulid } from "ulid";

/**
 * cron_jobs persistence (RIG-84). Pure reads/writes; no scheduling, no spawning.
 *
 * `claim` is the catch-up guard: one synchronous UPDATE that both decides the slot is still
 * unclaimed and records it, so a restart after a crash mid-run sees the slot as taken.
 */

export interface CronJob {
  jobId: string;
  name: string;
  schedule: string;
  kind: "shell";
  command: string;
  args: string[];
  timeoutSeconds: number;
  catchupWindowSeconds: number;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastExitCode: number | null;
  lastDurationMs: number | null;
  createdAt: string;
  updatedAt: string;
}

interface CronJobRow {
  job_id: string;
  name: string;
  schedule: string;
  kind: "shell";
  command: string;
  args_json: string;
  timeout_seconds: number;
  catchup_window_seconds: number;
  enabled: number;
  last_run_at: string | null;
  last_status: string | null;
  last_exit_code: number | null;
  last_duration_ms: number | null;
  created_at: string;
  updated_at: string;
}

export interface CronJobInput {
  name: string;
  schedule: string;
  command: string;
  args: string[];
  timeoutSeconds: number;
  catchupWindowSeconds: number;
  enabled: boolean;
}

export interface CronRunResult {
  status: string;
  exitCode: number | null;
  durationMs: number | null;
}

function toJob(row: CronJobRow): CronJob {
  return {
    jobId: row.job_id,
    name: row.name,
    schedule: row.schedule,
    kind: row.kind,
    command: row.command,
    args: JSON.parse(row.args_json) as string[],
    timeoutSeconds: row.timeout_seconds,
    catchupWindowSeconds: row.catchup_window_seconds,
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    lastExitCode: row.last_exit_code,
    lastDurationMs: row.last_duration_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CronJobsRepository {
  constructor(private readonly db: Database.Database, private readonly now: () => Date = () => new Date()) {}

  list(): CronJob[] {
    return (this.db.prepare("SELECT * FROM cron_jobs ORDER BY name").all() as CronJobRow[]).map(toJob);
  }

  get(name: string): CronJob | null {
    const row = this.db.prepare("SELECT * FROM cron_jobs WHERE name = ?").get(name) as CronJobRow | undefined;
    return row ? toJob(row) : null;
  }

  /** Insert or update by name. An update keeps the run history and the schedule guard. */
  upsert(input: CronJobInput): { job: CronJob; created: boolean } {
    const at = this.now().toISOString();
    const existing = this.get(input.name);
    if (existing) {
      this.db.prepare(
        `UPDATE cron_jobs SET schedule = ?, command = ?, args_json = ?, timeout_seconds = ?,
           catchup_window_seconds = ?, enabled = ?, updated_at = ? WHERE name = ?`,
      ).run(input.schedule, input.command, JSON.stringify(input.args), input.timeoutSeconds,
        input.catchupWindowSeconds, input.enabled ? 1 : 0, at, input.name);
    } else {
      this.db.prepare(
        `INSERT INTO cron_jobs (job_id, name, schedule, kind, command, args_json, timeout_seconds,
           catchup_window_seconds, enabled, created_at, updated_at)
         VALUES (?, ?, ?, 'shell', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(ulid(), input.name, input.schedule, input.command, JSON.stringify(input.args),
        input.timeoutSeconds, input.catchupWindowSeconds, input.enabled ? 1 : 0, at, at);
    }
    return { job: this.get(input.name)!, created: !existing };
  }

  /** Atomically claim a slot. True when this call took it; false when it was already claimed or the job is disabled. */
  claim(name: string, slotIso: string): boolean {
    const at = this.now().toISOString();
    const res = this.db.prepare(
      `UPDATE cron_jobs SET last_run_at = ?, last_status = 'running', updated_at = ?
       WHERE name = ? AND enabled = 1 AND (last_run_at IS NULL OR last_run_at < ?)`,
    ).run(slotIso, at, name, slotIso);
    return res.changes === 1;
  }

  /** Mark a manual run started. Leaves the schedule guard alone. */
  markRunning(name: string): void {
    this.db.prepare("UPDATE cron_jobs SET last_status = 'running', updated_at = ? WHERE name = ?").run(this.now().toISOString(), name);
  }

  recordResult(name: string, result: CronRunResult): void {
    this.db.prepare(
      "UPDATE cron_jobs SET last_status = ?, last_exit_code = ?, last_duration_ms = ?, updated_at = ? WHERE name = ?",
    ).run(result.status, result.exitCode, result.durationMs, this.now().toISOString(), name);
  }

  /** At boot no child can still be running; a leftover 'running' row means the daemon died mid-run. */
  markInterrupted(): number {
    return this.db.prepare(
      "UPDATE cron_jobs SET last_status = 'interrupted', updated_at = ? WHERE last_status = 'running'",
    ).run(this.now().toISOString()).changes;
  }
}
