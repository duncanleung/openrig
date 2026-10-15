import type { Migration } from "../migrate.js";

// RIG-84: daemon cron for orchestration-layer scheduled jobs.
//   - cron_jobs: one row per registered job. `last_run_at` is the schedule guard: the slot time
//     (ISO, UTC) most recently claimed for a scheduled run. It is written before the job starts
//     so a crash mid-run cannot fire the same slot again. A manual run never changes it.
//   - kind is shell-only. The command is an absolute path validated against OPENRIG_HOME at
//     registration and again at every run.
export const cronJobsSchema: Migration = {
  name: "107_cron_jobs.sql",
  sql: `
CREATE TABLE IF NOT EXISTS cron_jobs (
  job_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  schedule TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('shell')),
  command TEXT NOT NULL,
  args_json TEXT NOT NULL DEFAULT '[]',
  timeout_seconds INTEGER NOT NULL DEFAULT 300,
  catchup_window_seconds INTEGER NOT NULL DEFAULT 21600,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  last_status TEXT,
  last_exit_code INTEGER,
  last_duration_ms INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
  `.trim(),
};
