import type { Migration } from "../migrate.js";

// JSON array of { skill, args, turn } from Skill tool calls (args truncated to 200 chars by the reducer).
// Rows ingested before this migration hold '[]' until the next reconcile re-parses them (PARSER_VERSION bump).
export const digestSkillInvocationsSchema: Migration = {
  name: "103_digest_skill_invocations.sql",
  sql: `
ALTER TABLE session_digests ADD COLUMN skill_invocations TEXT NOT NULL DEFAULT '[]';
  `.trim(),
};
