import type { Migration } from "../migrate.js";

// RIG-87: durable ticket admission, the boundary between the backlog and the
// ticket-factory workflow. One row per admission attempt.
//   - instance_key is the deterministic run identity (ticket id + admission timestamp).
//   - The partial unique index makes duplicate suppression a database guarantee: at
//     most one live admission (pending, active, reconciling) exists per ticket.
//   - evidence_json is written once at insert and never updated (trigger below).
export const ticketAdmissionsSchema: Migration = {
  name: "104_ticket_admissions.sql",
  sql: `
CREATE TABLE IF NOT EXISTS ticket_admissions (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  instance_key TEXT NOT NULL UNIQUE,
  instance_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','active','reconciling','closed','rejected')),
  disposition TEXT NOT NULL CHECK (disposition IN ('ready','blocked','already-resolved','needs-investigation')),
  evidence_json TEXT NOT NULL,
  state_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_admissions_live_ticket
  ON ticket_admissions(ticket_id) WHERE state IN ('pending','active','reconciling');
CREATE TRIGGER IF NOT EXISTS ticket_admissions_evidence_immutable
  BEFORE UPDATE OF evidence_json, instance_key, ticket_id, disposition ON ticket_admissions
  BEGIN SELECT RAISE(ABORT, 'ticket_admissions evidence is immutable'); END;
  `.trim(),
};
