import type { Migration } from "../migrate.js";

/**
 * Durable daily rollup of token usage per seat.
 *
 * Relation to usage_samples (062): usage_samples holds raw append-only samples
 * with daemon-enforced retention (RETENTION_DEFAULTS.usageSamplesRetentionDays,
 * configurable via retention.usage_samples_days, default 14 days).
 * This table snapshots daily deltas BEFORE retention prunes them, so it is the
 * only long-horizon token usage record. It cannot be rebuilt from usage_samples
 * beyond the retention window.
 *
 * Idempotence: UNIQUE(day, seat_session) — upsert on re-snapshot.
 * Writer: periodic aggregation job (lands in a follow-up PR).
 */
export const dailyTokenSnapshotsSchema: Migration = {
  name: "099_daily_token_snapshots.sql",
  sql: `
CREATE TABLE daily_token_snapshots (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  day                   TEXT NOT NULL,
  seat_session          TEXT NOT NULL,
  rig_name              TEXT,
  seat_name             TEXT,
  model                 TEXT,
  input_tokens_delta    INTEGER,
  output_tokens_delta   INTEGER,
  total_tokens_delta    INTEGER,
  samples               INTEGER,
  resets                INTEGER DEFAULT 0,
  schema_version        TEXT,
  snapshot_at           TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(day, seat_session)
);
CREATE INDEX idx_daily_token_snapshots_day  ON daily_token_snapshots(day);
CREATE INDEX idx_daily_token_snapshots_rig  ON daily_token_snapshots(rig_name);
CREATE INDEX idx_daily_token_snapshots_seat ON daily_token_snapshots(seat_session);
  `.trim(),
};
