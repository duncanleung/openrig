import type { Migration } from "../migrate.js";

export const sessionDigestsSchema: Migration = {
  name: "096_session_digests.sql",
  sql: `
CREATE TABLE session_digests (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  rig_name              TEXT,
  seat_session          TEXT NOT NULL,
  seat_name             TEXT,
  node_logical_id       TEXT,
  rig_id                TEXT,
  node_id               TEXT,
  native_session_id     TEXT NOT NULL,
  generation_uuid       TEXT,
  occupant_generation   INTEGER,
  transcript_path       TEXT NOT NULL,
  transcript_bytes      INTEGER,
  transcript_modified_at TEXT,
  total_turns           INTEGER NOT NULL,
  conversation_turns    INTEGER NOT NULL,
  tool_calls            TEXT NOT NULL,
  repeated_reads        TEXT NOT NULL,
  review_findings       TEXT NOT NULL,
  handoff_events        TEXT NOT NULL,
  claude_md_loaded      TEXT NOT NULL,
  errors                TEXT NOT NULL,
  irreversible_actions  TEXT NOT NULL,
  compaction_boundaries TEXT NOT NULL,
  compaction_losses     TEXT NOT NULL,
  source_hash           TEXT,
  parser_version        TEXT,
  ingested_at           TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(native_session_id)
);
CREATE INDEX idx_session_digests_seat    ON session_digests(seat_session);
CREATE INDEX idx_session_digests_rig     ON session_digests(rig_name);
CREATE INDEX idx_session_digests_time    ON session_digests(ingested_at);
CREATE INDEX idx_session_digests_gen     ON session_digests(generation_uuid);
  `.trim(),
};
