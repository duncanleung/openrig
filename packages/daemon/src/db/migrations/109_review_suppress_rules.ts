import type { Migration } from "../migrate.js";

// RIG-9: the storage half of downvote filtering for review findings.
// - review_findings.user_action: what the user did with a finding. Nullable: no row writes it yet
//   (the review skills that would are a separate change), and every existing row stays NULL.
// - review_suppress_rules: structured suppress rules. A rule needs at least one matcher, so a rule
//   can never match every finding. A quarantined rule applies only to its source PR's review until
//   it is made active (repo-wide). Retired rules stay for audit.
export const reviewSuppressRulesSchema: Migration = {
  name: "109_review_suppress_rules.sql",
  sql: `
ALTER TABLE review_findings ADD COLUMN user_action TEXT
  CHECK (user_action IS NULL OR user_action IN ('accepted', 'dismissed', 'fixed-before-merge', 'deferred'));

CREATE TABLE review_suppress_rules (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  repo              TEXT NOT NULL,
  category          TEXT,
  file_glob         TEXT,
  description_hash  TEXT,
  reason            TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'quarantined'
                      CHECK (status IN ('quarantined', 'active', 'retired')),
  quarantined_pr    INTEGER,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  last_matched_at   TEXT,
  match_count       INTEGER NOT NULL DEFAULT 0,
  CHECK (category IS NOT NULL OR file_glob IS NOT NULL OR description_hash IS NOT NULL),
  CHECK (status != 'quarantined' OR quarantined_pr IS NOT NULL)
);
CREATE INDEX idx_review_suppress_rules_repo_status ON review_suppress_rules(repo, status);
  `.trim(),
};
