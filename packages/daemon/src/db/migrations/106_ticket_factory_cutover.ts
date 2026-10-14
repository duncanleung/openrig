import type { Migration } from "../migrate.js";

// RIG-89: cutover from the skill-based /factory-loop to the daemon ticket-factory.
//   - ticket_factory_legacy_claims: tickets the old skill still owns. The admission path refuses
//     them (the fence), so the two producers cannot both admit one ticket.
//   - ticket_factory_cutover: singleton cutover phase. An absent row means no cutover is in
//     progress and the controller behaves as it did in RIG-88.
//   - ticket_completion: three separate facts per ticket (workflow completed, PR merged, ticket
//     resolved). NULL means unknown. No fact is inferred from another.
export const ticketFactoryCutoverSchema: Migration = {
  name: "106_ticket_factory_cutover.sql",
  sql: `
CREATE TABLE IF NOT EXISTS ticket_factory_legacy_claims (
  ticket_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  legacy_state TEXT NOT NULL,
  pr_number INTEGER,
  branch TEXT,
  claimed_at TEXT NOT NULL,
  released_at TEXT,
  release_reason TEXT
);
CREATE TABLE IF NOT EXISTS ticket_factory_cutover (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  phase TEXT NOT NULL DEFAULT 'legacy' CHECK (phase IN ('legacy','reconciled','daemon','rolled-back')),
  note TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ticket_completion (
  ticket_id TEXT PRIMARY KEY,
  admission_id TEXT,
  workflow_completed INTEGER CHECK (workflow_completed IN (0,1)),
  pr_merged INTEGER CHECK (pr_merged IN (0,1)),
  ticket_resolved INTEGER CHECK (ticket_resolved IN (0,1)),
  pr_number INTEGER,
  updated_at TEXT NOT NULL
);
  `.trim(),
};
