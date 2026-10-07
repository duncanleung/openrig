import { describe, it, expect, beforeEach } from "vitest";
import BetterSqlite3, { type Database } from "better-sqlite3";
import { sessionDigestsSchema } from "../src/db/migrations/096_session_digests.js";
import { reviewRunsSchema } from "../src/db/migrations/097_review_runs.js";
import { reviewFindingsSchema } from "../src/db/migrations/098_review_findings.js";
import { dailyTokenSnapshotsSchema } from "../src/db/migrations/099_daily_token_snapshots.js";
import {
  FleetStore,
  type SessionDigestInput,
  type ReviewRunInput,
  type ReviewFindingInput,
  type DailyTokenSnapshotInput,
  type FleetStoreStats,
} from "../src/domain/fleet-store.js";

function freshDb(): Database {
  const db = new BetterSqlite3(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(reviewRunsSchema.sql);
  db.exec(reviewFindingsSchema.sql);
  db.exec(sessionDigestsSchema.sql);
  db.exec(dailyTokenSnapshotsSchema.sql);
  return db;
}

const digest = (over: Partial<SessionDigestInput> = {}): SessionDigestInput => ({
  rigName: "atlas-app",
  seatSession: "dev-impl@atlas-app",
  seatName: "dev-impl",
  nodeLogicalId: "node-1",
  rigId: "rig-abc",
  nodeId: "node-abc",
  nativeSessionId: "sess-001",
  generationUuid: "gen-001",
  occupantGeneration: 1,
  transcriptPath: "/tmp/transcript.jsonl",
  transcriptBytes: 4096,
  transcriptModifiedAt: "2026-10-05T10:00:00Z",
  totalTurns: 42,
  conversationTurns: 20,
  toolCalls: "{}",
  repeatedReads: "{}",
  reviewFindings: "{}",
  handoffEvents: "[]",
  claudeMdLoaded: "[]",
  errors: "[]",
  irreversibleActions: "[]",
  compactionBoundaries: "[]",
  compactionLosses: "[]",
  sourceHash: "abc123",
  parserVersion: "1.0.0",
  ...over,
});

const run = (over: Partial<ReviewRunInput> = {}): ReviewRunInput => ({
  traceId: "trace-001",
  prNumber: 11,
  repo: "duncanleung/openrig",
  branch: "feat/fleet-store",
  ticket: null,
  headSha: "f698f89b",
  mode: "default",
  validationMode: "dual-stack",
  modelReview: "claude-sonnet-5-5",
  modelValidator: "gpt-5.6-terra",
  bundleSizeChars: 12000,
  mustFix: 0,
  suggestion: 2,
  dismissed: 0,
  deferred: 0,
  escalated: 0,
  crossAgreed: 2,
  crossClaudeOnly: 0,
  crossCodexOnly: 0,
  metricsJson: '{"agents_used": 23}',
  rigName: "openrig-dev",
  seatName: "orch-lead",
  startedAt: "2026-10-05T23:49:58Z",
  completedAt: "2026-10-05T23:55:00Z",
  durationSeconds: 302,
  logDir: "/tmp/review-log",
  sourceHash: "def456",
  parserVersion: "1.0.0",
  ...over,
});

const finding = (over: Partial<ReviewFindingInput> = {}): ReviewFindingInput => ({
  runTraceId: "trace-001",
  findingId: "f-001",
  file: "src/routes/fleet-store.ts",
  lines: "10-20",
  category: "architecture-consistency",
  hunterKey: "claude-arch-1",
  stack: "claude",
  score: 65,
  verdict: "SUGGESTION",
  hasFixSpec: 1,
  descriptionPrefix: "Missing FK on review_findings",
  descriptionHash: "hash-001",
  ...over,
});

const snapshot = (over: Partial<DailyTokenSnapshotInput> = {}): DailyTokenSnapshotInput => ({
  day: "2026-10-05",
  seatSession: "dev-impl@atlas-app",
  rigName: "atlas-app",
  seatName: "dev-impl",
  model: "claude-opus-4-6",
  inputTokensDelta: 50000,
  outputTokensDelta: 12000,
  totalTokensDelta: 62000,
  samples: 48,
  resets: 0,
  schemaVersion: "1",
  ...over,
});

describe("096 session_digests — upsert idempotence", () => {
  let db: Database;
  let store: FleetStore;
  beforeEach(() => {
    db = freshDb();
    store = new FleetStore(db);
  });

  const count = () => (db.prepare("SELECT COUNT(*) AS n FROM session_digests").get() as { n: number }).n;

  it("inserts a new digest and reports created=true", () => {
    const result = store.upsertDigest(digest());
    expect(result.created).toBe(true);
    expect(result.id).toBeGreaterThan(0);
    expect(count()).toBe(1);
  });

  it("re-inserting the same native_session_id updates in place (idempotent)", () => {
    store.upsertDigest(digest());
    const result = store.upsertDigest(digest({ totalTurns: 99 }));
    expect(result.created).toBe(false);
    expect(count()).toBe(1);
    const row = db.prepare("SELECT total_turns FROM session_digests WHERE native_session_id = 'sess-001'").get() as { total_turns: number };
    expect(row.total_turns).toBe(99);
  });

  it("different native_session_ids create separate rows", () => {
    store.upsertDigest(digest());
    store.upsertDigest(digest({ nativeSessionId: "sess-002" }));
    expect(count()).toBe(2);
  });
});

describe("097+098 review_runs + review_findings — transactional upsert", () => {
  let db: Database;
  let store: FleetStore;
  beforeEach(() => {
    db = freshDb();
    store = new FleetStore(db);
  });

  const runCount = () => (db.prepare("SELECT COUNT(*) AS n FROM review_runs").get() as { n: number }).n;
  const findingCount = () => (db.prepare("SELECT COUNT(*) AS n FROM review_findings").get() as { n: number }).n;

  it("inserts run and findings atomically", () => {
    const result = store.upsertReviewRun(run(), [
      finding(),
      finding({ findingId: "f-002", category: "architecture-layering" }),
    ]);
    expect(result.created).toBe(true);
    expect(result.findingsUpserted).toBe(2);
    expect(runCount()).toBe(1);
    expect(findingCount()).toBe(2);
  });

  it("re-inserting same trace_id updates run and findings (idempotent)", () => {
    store.upsertReviewRun(run(), [finding()]);
    const result = store.upsertReviewRun(run({ mustFix: 1 }), [finding({ score: 90 })]);
    expect(result.created).toBe(false);
    expect(runCount()).toBe(1);
    expect(findingCount()).toBe(1);
    const row = db.prepare("SELECT must_fix FROM review_runs WHERE trace_id = 'trace-001'").get() as { must_fix: number };
    expect(row.must_fix).toBe(1);
    const fRow = db.prepare("SELECT score FROM review_findings WHERE finding_id = 'f-001'").get() as { score: number };
    expect(fRow.score).toBe(90);
  });

  it("inserting run with no findings works", () => {
    const result = store.upsertReviewRun(run(), []);
    expect(result.created).toBe(true);
    expect(result.findingsUpserted).toBe(0);
    expect(runCount()).toBe(1);
    expect(findingCount()).toBe(0);
  });

  it("FK constraint: findings with a non-existent run_trace_id are rejected", () => {
    expect(() => {
      store.upsertReviewRun(run(), [finding({ runTraceId: "non-existent" })]);
    }).toThrow();
  });

  it("ON DELETE CASCADE: deleting a run removes its findings", () => {
    store.upsertReviewRun(run(), [finding(), finding({ findingId: "f-002" })]);
    db.prepare("DELETE FROM review_runs WHERE trace_id = 'trace-001'").run();
    expect(findingCount()).toBe(0);
  });

  it("re-ingestion with fewer findings deletes stale ones", () => {
    store.upsertReviewRun(run(), [
      finding(),
      finding({ findingId: "f-002" }),
      finding({ findingId: "f-003" }),
    ]);
    expect(findingCount()).toBe(3);

    const result = store.upsertReviewRun(run(), [finding()]);
    expect(result.findingsUpserted).toBe(1);
    expect(result.findingsDeleted).toBe(2);
    expect(findingCount()).toBe(1);
    const remaining = db.prepare("SELECT finding_id FROM review_findings").all() as { finding_id: string }[];
    expect(remaining.map((r) => r.finding_id)).toEqual(["f-001"]);
  });

  it("re-ingestion with empty findings deletes all existing findings", () => {
    store.upsertReviewRun(run(), [finding(), finding({ findingId: "f-002" })]);
    expect(findingCount()).toBe(2);

    const result = store.upsertReviewRun(run(), []);
    expect(result.findingsUpserted).toBe(0);
    expect(result.findingsDeleted).toBe(2);
    expect(findingCount()).toBe(0);
  });

  it("first insertion with findings reports zero deletions", () => {
    const result = store.upsertReviewRun(run(), [finding()]);
    expect(result.created).toBe(true);
    expect(result.findingsDeleted).toBe(0);
  });

  it("null findings preserves existing findings (parse-error safety)", () => {
    store.upsertReviewRun(run(), [finding(), finding({ findingId: "f-002" })]);
    expect(findingCount()).toBe(2);

    const result = store.upsertReviewRun(run({ mustFix: 1 }), null);
    expect(result.findingsUpserted).toBe(0);
    expect(result.findingsDeleted).toBe(0);
    expect(findingCount()).toBe(2);
  });
});

describe("099 daily_token_snapshots — upsert idempotence", () => {
  let db: Database;
  let store: FleetStore;
  beforeEach(() => {
    db = freshDb();
    store = new FleetStore(db);
  });

  const count = () => (db.prepare("SELECT COUNT(*) AS n FROM daily_token_snapshots").get() as { n: number }).n;

  it("inserts a new snapshot and reports created=true", () => {
    const result = store.upsertSnapshot(snapshot());
    expect(result.created).toBe(true);
    expect(count()).toBe(1);
  });

  it("re-inserting same (day, seat_session) updates in place", () => {
    store.upsertSnapshot(snapshot());
    store.upsertSnapshot(snapshot({ totalTokensDelta: 99999 }));
    expect(count()).toBe(1);
    const row = db.prepare("SELECT total_tokens_delta FROM daily_token_snapshots").get() as { total_tokens_delta: number };
    expect(row.total_tokens_delta).toBe(99999);
  });

  it("different day or seat_session creates separate rows", () => {
    store.upsertSnapshot(snapshot());
    store.upsertSnapshot(snapshot({ day: "2026-10-06" }));
    store.upsertSnapshot(snapshot({ seatSession: "orch-lead@openrig-dev" }));
    expect(count()).toBe(3);
  });

  it("batch upsert inserts multiple snapshots in a transaction", () => {
    const result = store.upsertSnapshots([
      snapshot(),
      snapshot({ day: "2026-10-06" }),
      snapshot({ seatSession: "orch-lead@openrig-dev" }),
    ]);
    expect(result.upserted).toBe(3);
    expect(count()).toBe(3);
  });
});

describe("upsert returned id — regression for stale lastInsertRowid", () => {
  let db: Database;
  let store: FleetStore;
  beforeEach(() => {
    db = freshDb();
    store = new FleetStore(db);
  });

  it("upsertDigest returns the correct id on the update path", () => {
    const first = store.upsertDigest(digest());
    expect(first.created).toBe(true);
    const expectedId = first.id;

    store.upsertSnapshot(snapshot());

    const second = store.upsertDigest(digest({ totalTurns: 99 }));
    expect(second.created).toBe(false);
    expect(second.id).toBe(expectedId);
  });

  it("upsertReviewRun returns the correct runId on the update path", () => {
    const first = store.upsertReviewRun(run(), [finding()]);
    expect(first.created).toBe(true);
    const expectedId = first.runId;

    store.upsertDigest(digest());

    const second = store.upsertReviewRun(run({ mustFix: 1 }), [finding({ score: 90 })]);
    expect(second.created).toBe(false);
    expect(second.runId).toBe(expectedId);
  });

  it("upsertSnapshot returns the correct id on the update path", () => {
    const first = store.upsertSnapshot(snapshot());
    expect(first.created).toBe(true);
    const expectedId = first.id;

    store.upsertDigest(digest());

    const second = store.upsertSnapshot(snapshot({ totalTokensDelta: 99999 }));
    expect(second.created).toBe(false);
    expect(second.id).toBe(expectedId);
  });
});

describe("stats — MAX(timestamp) regression for re-ingest ordering", () => {
  let db: Database;
  let store: FleetStore;
  beforeEach(() => {
    db = freshDb();
    store = new FleetStore(db);
  });

  it("last_ingested_at reflects the most recent re-ingest, not the highest rowid", () => {
    store.upsertDigest(digest({ nativeSessionId: "old" }));
    store.upsertDigest(digest({ nativeSessionId: "new" }));

    db.prepare("UPDATE session_digests SET ingested_at = '2026-01-01T00:00:00' WHERE native_session_id = 'new'").run();
    db.prepare("UPDATE session_digests SET ingested_at = '2026-12-31T23:59:59' WHERE native_session_id = 'old'").run();

    const s = store.stats();
    expect(s.session_digests.last_ingested_at).toBe("2026-12-31T23:59:59");
  });

  it("last_snapshot_at reflects the most recent re-ingest, not the highest rowid", () => {
    store.upsertSnapshot(snapshot({ day: "2026-01-01" }));
    store.upsertSnapshot(snapshot({ day: "2026-12-31" }));

    db.prepare("UPDATE daily_token_snapshots SET snapshot_at = '2026-01-01T00:00:00' WHERE day = '2026-12-31'").run();
    db.prepare("UPDATE daily_token_snapshots SET snapshot_at = '2026-12-31T23:59:59' WHERE day = '2026-01-01'").run();

    const s = store.stats();
    expect(s.daily_token_snapshots.last_snapshot_at).toBe("2026-12-31T23:59:59");
  });
});

describe("fleet store stats — row counts and last timestamps", () => {
  let db: Database;
  let store: FleetStore;
  beforeEach(() => {
    db = freshDb();
    store = new FleetStore(db);
  });

  it("returns zero counts on an empty store", () => {
    const s = store.stats();
    expect(s.session_digests.count).toBe(0);
    expect(s.session_digests.last_ingested_at).toBeNull();
    expect(s.review_runs.count).toBe(0);
    expect(s.review_findings.count).toBe(0);
    expect(s.daily_token_snapshots.count).toBe(0);
    expect(s.daily_token_snapshots.last_snapshot_at).toBeNull();
  });

  it("reflects counts after inserts across all tables", () => {
    store.upsertDigest(digest());
    store.upsertDigest(digest({ nativeSessionId: "sess-002" }));
    store.upsertReviewRun(run(), [finding(), finding({ findingId: "f-002" })]);
    store.upsertSnapshot(snapshot());

    const s = store.stats();
    expect(s.session_digests.count).toBe(2);
    expect(s.session_digests.last_ingested_at).not.toBeNull();
    expect(s.review_runs.count).toBe(1);
    expect(s.review_runs.last_ingested_at).not.toBeNull();
    expect(s.review_findings.count).toBe(2);
    expect(s.daily_token_snapshots.count).toBe(1);
    expect(s.daily_token_snapshots.last_snapshot_at).not.toBeNull();
  });
});

describe("listDigests — query with filters", () => {
  let store: FleetStore;
  beforeEach(() => {
    const db = freshDb();
    store = new FleetStore(db);
    store.upsertDigest(digest({ nativeSessionId: "sess-001", rigName: "rig-a", seatName: "dev-impl" }));
    store.upsertDigest(digest({ nativeSessionId: "sess-002", rigName: "rig-a", seatName: "orch-lead" }));
    store.upsertDigest(digest({ nativeSessionId: "sess-003", rigName: "rig-b", seatName: "dev-impl" }));
  });

  it("returns all digests when no filter is set", () => {
    const result = store.listDigests();
    expect(result.total).toBe(3);
    expect(result.rows).toHaveLength(3);
  });

  it("filters by rig name", () => {
    const result = store.listDigests({ rig: "rig-a" });
    expect(result.total).toBe(2);
    expect(result.rows.every((r) => r.rig_name === "rig-a")).toBe(true);
  });

  it("filters by seat name", () => {
    const result = store.listDigests({ seat: "dev-impl" });
    expect(result.total).toBe(2);
    expect(result.rows.every((r) => r.seat_name === "dev-impl")).toBe(true);
  });

  it("respects limit and offset", () => {
    const page1 = store.listDigests({ limit: 2, offset: 0 });
    expect(page1.rows).toHaveLength(2);
    expect(page1.total).toBe(3);
    const page2 = store.listDigests({ limit: 2, offset: 2 });
    expect(page2.rows).toHaveLength(1);
  });

  it("clamps limit to 200", () => {
    const result = store.listDigests({ limit: 999 });
    expect(result.rows).toHaveLength(3);
  });
});

describe("listReviews — query with filters", () => {
  let store: FleetStore;
  beforeEach(() => {
    const db = freshDb();
    store = new FleetStore(db);
    store.upsertReviewRun(run({ traceId: "t-1", prNumber: 10, repo: "owner/repo-a", branch: "feat-a", rigName: "rig-a" }), []);
    store.upsertReviewRun(run({ traceId: "t-2", prNumber: 11, repo: "owner/repo-a", branch: "feat-b", rigName: "rig-a" }), []);
    store.upsertReviewRun(run({ traceId: "t-3", prNumber: 5, repo: "owner/repo-b", branch: "feat-c", rigName: "rig-b" }), []);
  });

  it("returns all reviews unfiltered", () => {
    const result = store.listReviews();
    expect(result.total).toBe(3);
  });

  it("filters by PR number", () => {
    const result = store.listReviews({ pr: 11 });
    expect(result.total).toBe(1);
    expect(result.rows[0]!.trace_id).toBe("t-2");
  });

  it("filters by repo", () => {
    const result = store.listReviews({ repo: "owner/repo-a" });
    expect(result.total).toBe(2);
  });

  it("filters by rig", () => {
    const result = store.listReviews({ rig: "rig-b" });
    expect(result.total).toBe(1);
    expect(result.rows[0]!.trace_id).toBe("t-3");
  });
});

describe("getReviewFindings — returns findings for a trace", () => {
  let store: FleetStore;
  beforeEach(() => {
    const db = freshDb();
    store = new FleetStore(db);
    store.upsertReviewRun(run({ traceId: "t-1" }), [
      finding({ runTraceId: "t-1", findingId: "f-1", score: 80, verdict: "MUST_FIX" }),
      finding({ runTraceId: "t-1", findingId: "f-2", score: 40, verdict: "SUGGESTION" }),
    ]);
  });

  it("returns findings ordered by score descending", () => {
    const findings = store.getReviewFindings("t-1");
    expect(findings).toHaveLength(2);
    expect(findings[0]!.finding_id).toBe("f-1");
    expect(findings[1]!.finding_id).toBe("f-2");
  });

  it("returns empty array for unknown trace", () => {
    expect(store.getReviewFindings("nonexistent")).toHaveLength(0);
  });
});

describe("listSnapshots — query with filters", () => {
  let store: FleetStore;
  beforeEach(() => {
    const db = freshDb();
    store = new FleetStore(db);
    store.upsertSnapshot(snapshot({ day: "2026-10-05", seatSession: "s1", rigName: "rig-a" }));
    store.upsertSnapshot(snapshot({ day: "2026-10-06", seatSession: "s2", rigName: "rig-a" }));
    store.upsertSnapshot(snapshot({ day: "2026-10-07", seatSession: "s3", rigName: "rig-b" }));
  });

  it("returns all snapshots unfiltered", () => {
    const result = store.listSnapshots();
    expect(result.total).toBe(3);
  });

  it("filters by rig name", () => {
    const result = store.listSnapshots({ rig: "rig-a" });
    expect(result.total).toBe(2);
  });

  it("filters by date range", () => {
    const result = store.listSnapshots({ since: "2026-10-06" });
    expect(result.total).toBe(2);
    expect(result.rows.every((r) => r.day >= "2026-10-06")).toBe(true);
  });

  it("respects limit", () => {
    const result = store.listSnapshots({ limit: 1 });
    expect(result.rows).toHaveLength(1);
    expect(result.total).toBe(3);
  });
});
