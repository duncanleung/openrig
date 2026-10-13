import type { Migration } from "../migrate.js";

// started_at = first human turn timestamp, ended_at = last assistant turn timestamp (ISO 8601),
// duration_ms = ended_at - started_at. Nullable: rows ingested before this migration stay NULL
// until the next reconcile re-parses them (PARSER_VERSION bump).
export const digestSessionTimestampsSchema: Migration = {
  name: "102_digest_session_timestamps.sql",
  sql: `
ALTER TABLE session_digests ADD COLUMN started_at TEXT;
ALTER TABLE session_digests ADD COLUMN ended_at TEXT;
ALTER TABLE session_digests ADD COLUMN duration_ms INTEGER;
  `.trim(),
};
