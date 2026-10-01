import type { Migration } from "../migrate.js";

// RIG-43 follow-up: fallback_expires_at was missing from 090.
// Added as migration 091 (not an edit to 090) because 090 may already be applied.
export const nodeFallbackExpiresAtSchema: Migration = {
  name: "091_node_fallback_expires_at.sql",
  sql: `
    ALTER TABLE nodes ADD COLUMN fallback_expires_at TEXT;
  `,
};
