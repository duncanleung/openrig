import type { Migration } from "../migrate.js";

// RIG-88: recurring operation of the ticket-factory workflow.
//   - ticket_factory_control is a singleton (id = 1): persisted enable/pause state, cadence,
//     capacity, budgets, and the poll/backoff bookkeeping. SQLite is the source of truth, so
//     a daemon restart resumes the same state.
//   - ticket_factory_runs is the persisted run identity. Budget counters are derived from
//     ticket_admissions.run_id, so they cannot drift from the admissions themselves.
export const ticketFactoryControlSchema: Migration = {
  name: "105_ticket_factory_control.sql",
  sql: `
CREATE TABLE IF NOT EXISTS ticket_factory_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL DEFAULT 'disabled' CHECK (state IN ('disabled','running','paused')),
  poll_interval_s INTEGER NOT NULL DEFAULT 300,
  capacity INTEGER NOT NULL DEFAULT 1,
  max_tickets_per_run INTEGER NOT NULL DEFAULT 3,
  wall_clock_per_ticket_s INTEGER NOT NULL DEFAULT 3600,
  cooldown_s INTEGER NOT NULL DEFAULT 3600,
  merge_gate TEXT NOT NULL DEFAULT 'all',
  merge_policy TEXT NOT NULL DEFAULT 'human',
  current_run_id TEXT,
  fail_streak INTEGER NOT NULL DEFAULT 0,
  next_poll_at TEXT,
  last_poll_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ticket_factory_runs (
  run_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT
);
ALTER TABLE ticket_admissions ADD COLUMN run_id TEXT;
CREATE INDEX IF NOT EXISTS idx_ticket_admissions_run ON ticket_admissions(run_id);
CREATE INDEX IF NOT EXISTS idx_ticket_admissions_closed ON ticket_admissions(ticket_id, updated_at) WHERE state = 'closed';
  `.trim(),
};
