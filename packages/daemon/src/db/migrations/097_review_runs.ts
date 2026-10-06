import type { Migration } from "../migrate.js";

export const reviewRunsSchema: Migration = {
  name: "097_review_runs.sql",
  sql: `
CREATE TABLE review_runs (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id              TEXT NOT NULL,
  pr_number             INTEGER,
  repo                  TEXT,
  branch                TEXT,
  ticket                TEXT,
  head_sha              TEXT,
  mode                  TEXT,
  validation_mode       TEXT,
  model_review          TEXT,
  model_validator       TEXT,
  bundle_size_chars     INTEGER,
  must_fix              INTEGER NOT NULL DEFAULT 0,
  suggestion            INTEGER NOT NULL DEFAULT 0,
  dismissed             INTEGER NOT NULL DEFAULT 0,
  deferred              INTEGER NOT NULL DEFAULT 0,
  escalated             INTEGER NOT NULL DEFAULT 0,
  cross_agreed          INTEGER NOT NULL DEFAULT 0,
  cross_claude_only     INTEGER NOT NULL DEFAULT 0,
  cross_codex_only      INTEGER NOT NULL DEFAULT 0,
  metrics_json          TEXT NOT NULL,
  rig_name              TEXT,
  seat_name             TEXT,
  started_at            TEXT,
  completed_at          TEXT,
  duration_seconds      INTEGER,
  log_dir               TEXT,
  source_hash           TEXT,
  parser_version        TEXT,
  ingested_at           TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(trace_id)
);
CREATE INDEX idx_review_runs_pr         ON review_runs(repo, pr_number);
CREATE INDEX idx_review_runs_sha        ON review_runs(head_sha);
CREATE INDEX idx_review_runs_ticket     ON review_runs(ticket);
CREATE INDEX idx_review_runs_time       ON review_runs(started_at);
CREATE INDEX idx_review_runs_rig        ON review_runs(rig_name);
  `.trim(),
};
