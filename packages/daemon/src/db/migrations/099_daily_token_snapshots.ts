import type { Migration } from "../migrate.js";

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
