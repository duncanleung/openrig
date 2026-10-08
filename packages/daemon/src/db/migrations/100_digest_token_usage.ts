import type { Migration } from "../migrate.js";

export const digestTokenUsageSchema: Migration = {
  name: "100_digest_token_usage.sql",
  sql: `
ALTER TABLE session_digests ADD COLUMN token_usage TEXT NOT NULL DEFAULT '[]';
ALTER TABLE session_digests ADD COLUMN total_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_digests ADD COLUMN total_output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_digests ADD COLUMN total_cache_creation_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_digests ADD COLUMN total_cache_read_tokens INTEGER NOT NULL DEFAULT 0;
  `.trim(),
};
