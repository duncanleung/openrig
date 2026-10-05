import type { Migration } from "../migrate.js";

export const reviewFindingsSchema: Migration = {
  name: "098_review_findings.sql",
  sql: `
CREATE TABLE review_findings (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  run_trace_id          TEXT NOT NULL,
  finding_id            TEXT NOT NULL,
  file                  TEXT,
  lines                 TEXT,
  category              TEXT,
  hunter_key            TEXT,
  stack                 TEXT,
  score                 INTEGER,
  verdict               TEXT,
  has_fix_spec          INTEGER,
  description_prefix    TEXT,
  description_hash      TEXT,
  UNIQUE(run_trace_id, finding_id)
);
CREATE INDEX idx_review_findings_category ON review_findings(category);
CREATE INDEX idx_review_findings_file     ON review_findings(file);
CREATE INDEX idx_review_findings_hash     ON review_findings(description_hash);
CREATE INDEX idx_review_findings_verdict  ON review_findings(verdict);
  `.trim(),
};
