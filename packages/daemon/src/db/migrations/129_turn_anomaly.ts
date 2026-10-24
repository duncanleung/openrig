import type { Migration } from "../migrate.js";

// RIG-79 — turn-anomaly watchdog state. The fleet store keeps ONE row per native session (upserted), so it holds
// lifetime totals and no history. A windowed delta needs earlier readings, so the detector records its own samples.
// Episodes are the persisted per-session finding state; one open episode per (native session, kind).
export const turnAnomalySchema: Migration = {
  name: "129_turn_anomaly.sql",
  sql: `
CREATE TABLE turn_anomaly_samples (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  native_session_id   TEXT NOT NULL,
  sampled_at          TEXT NOT NULL,
  total_turns         INTEGER NOT NULL,
  conversation_turns  INTEGER NOT NULL
);
CREATE INDEX idx_turn_anomaly_samples_session ON turn_anomaly_samples(native_session_id, sampled_at);

CREATE TABLE turn_anomaly_episodes (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  native_session_id   TEXT NOT NULL,
  subject_generation  TEXT,
  seat_session        TEXT NOT NULL,
  rig_name            TEXT,
  kind                TEXT NOT NULL,
  role                TEXT NOT NULL,
  opened_at           TEXT NOT NULL,
  last_seen_at        TEXT NOT NULL,
  closed_at           TEXT,
  close_reason        TEXT,
  evidence_json       TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_turn_anomaly_episodes_open
  ON turn_anomaly_episodes(native_session_id, kind) WHERE closed_at IS NULL;
CREATE INDEX idx_turn_anomaly_episodes_closed ON turn_anomaly_episodes(closed_at);
  `.trim(),
};
