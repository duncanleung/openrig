import type { Migration } from "../migrate.js";

/**
 * RIG-190 — sweep_attempts table.
 *
 * Tracks each Enter attempt made by the stuck-message sweeper.
 * State machine: attempting → confirmed | failed | indeterminate
 *
 * On daemon start, all rows in state 'attempting' are upgraded to
 * 'indeterminate' (crash = indeterminate, never auto-retried).
 */
export const sweepAttemptSchema: Migration = {
  name: "131_sweep_attempt.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS sweep_attempts (
      id TEXT PRIMARY KEY,
      delivery_id TEXT NOT NULL,
      occupant_generation TEXT NOT NULL,
      pane_id TEXT,
      fingerprint TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'attempting',
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS sweep_attempts_delivery_id
      ON sweep_attempts(delivery_id);
    CREATE INDEX IF NOT EXISTS sweep_attempts_state_attempting
      ON sweep_attempts(state) WHERE state = 'attempting';
  `,
};
