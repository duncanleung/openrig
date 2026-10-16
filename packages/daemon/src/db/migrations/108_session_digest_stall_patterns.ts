import type { Migration } from "../migrate.js";

// RIG-59: JSON array of { type, turnRange, details } stall patterns (retry-loop, read-storm, stall)
// detected by the transcript reducer. Rows ingested before this migration hold '[]' until the next
// reconcile re-parses them (PARSER_VERSION bump).
export const digestStallPatternsSchema: Migration = {
  name: "108_session_digest_stall_patterns.sql",
  sql: `
ALTER TABLE session_digests ADD COLUMN stall_patterns TEXT NOT NULL DEFAULT '[]';
  `.trim(),
};
