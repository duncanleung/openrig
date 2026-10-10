import type { Migration } from "../migrate.js";

export const digestEscalationCountSchema: Migration = {
  name: "101_digest_escalation_count.sql",
  sql: `
ALTER TABLE session_digests ADD COLUMN escalation_count INTEGER NOT NULL DEFAULT 0;
  `.trim(),
};
