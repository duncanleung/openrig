import { describe, it, expect, beforeEach, vi } from "vitest";
import BetterSqlite3, { type Database } from "better-sqlite3";
import { sessionDigestsSchema } from "../src/db/migrations/096_session_digests.js";
import { reviewRunsSchema } from "../src/db/migrations/097_review_runs.js";
import { reviewFindingsSchema } from "../src/db/migrations/098_review_findings.js";
import { dailyTokenSnapshotsSchema } from "../src/db/migrations/099_daily_token_snapshots.js";
import { digestTokenUsageSchema } from "../src/db/migrations/100_digest_token_usage.js";
import { FleetStore } from "../src/domain/fleet-store.js";
import { FleetIngestionService, resolveFleetReconcileIntervalMs } from "../src/domain/fleet-ingestion-service.js";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function freshDb(): Database {
  const db = new BetterSqlite3(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = OFF");
  // Usage samples schema (minimal subset matching migration 062)
  db.exec(`
    CREATE TABLE rigs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      rig_id TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
      logical_id TEXT NOT NULL,
      role TEXT,
      runtime TEXT,
      model TEXT,
      cwd TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(rig_id, logical_id)
    )
  `);
  db.exec(`
    CREATE TABLE usage_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lane TEXT NOT NULL,
      seat_session TEXT NOT NULL,
      node_id TEXT,
      source TEXT,
      sampled_at TEXT,
      captured_at TEXT NOT NULL,
      total_input_tokens INTEGER,
      total_output_tokens INTEGER,
      used_percentage REAL,
      window TEXT,
      window_used_percent REAL,
      resets_at TEXT
    )
  `);
  db.exec(sessionDigestsSchema.sql);
  db.exec(reviewRunsSchema.sql);
  db.exec(reviewFindingsSchema.sql);
  db.exec(dailyTokenSnapshotsSchema.sql);
  db.exec(digestTokenUsageSchema.sql);
  return db;
}

function makeService(db: Database, homedir: string, reducerPath = "/nonexistent/reducer.mjs"): FleetIngestionService {
  return new FleetIngestionService({
    db,
    fleetStore: new FleetStore(db),
    homedir,
    reducerPath,
  });
}

// ── Snapshot rollup ─────────────────────────────────────────────────────────

describe("FleetIngestionService — rollUpSnapshots", () => {
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    db = freshDb();
    tmpDir = mkdtempSync(join(tmpdir(), "fleet-test-"));
  });

  it("produces zero snapshots when usage_samples is empty", async () => {
    const svc = makeService(db, tmpDir);
    const result = await svc.rollUpSnapshots({ days: 7 });
    expect(result.snapshotsUpserted).toBe(0);
    expect(result.daysRolledUp).toBe(0);
  });

  it("rolls up positive deltas for a single seat on one day", async () => {
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(`
      INSERT INTO usage_samples (lane, seat_session, captured_at, total_input_tokens, total_output_tokens)
      VALUES ('context', 'seat-a@rig', ?, 100, 50),
             ('context', 'seat-a@rig', ?, 200, 90),
             ('context', 'seat-a@rig', ?, 350, 150)
    `).run(`${today}T00:10:00Z`, `${today}T01:00:00Z`, `${today}T02:00:00Z`);

    const svc = makeService(db, tmpDir);
    const result = await svc.rollUpSnapshots({ days: 2 });

    expect(result.snapshotsUpserted).toBe(1);

    const row = db.prepare("SELECT * FROM daily_token_snapshots WHERE seat_session = 'seat-a@rig'").get() as Record<string, unknown>;
    expect(row.day).toBe(today);
    // input delta: (200-100) + (350-200) = 250; output delta: (90-50) + (150-90) = 100
    expect(row.input_tokens_delta).toBe(250);
    expect(row.output_tokens_delta).toBe(100);
    expect(row.total_tokens_delta).toBe(350);
    expect(row.samples).toBe(3);
    expect(row.resets).toBe(0);
  });

  it("counts session resets (negative total delta) without adding to deltas", async () => {
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(`
      INSERT INTO usage_samples (lane, seat_session, captured_at, total_input_tokens, total_output_tokens)
      VALUES ('context', 'seat-b@rig', ?, 1000, 500),
             ('context', 'seat-b@rig', ?, 50,   20)
    `).run(`${today}T00:10:00Z`, `${today}T01:00:00Z`);

    const svc = makeService(db, tmpDir);
    const result = await svc.rollUpSnapshots({ days: 2 });

    expect(result.snapshotsUpserted).toBe(1);
    const row = db.prepare("SELECT * FROM daily_token_snapshots WHERE seat_session = 'seat-b@rig'").get() as Record<string, unknown>;
    expect(row.resets).toBe(1);
    expect(row.input_tokens_delta).toBe(0);
    expect(row.output_tokens_delta).toBe(0);
  });

  it("includes the last sample of the previous day as a baseline", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    // Previous day anchor: total 300+100
    db.prepare(`
      INSERT INTO usage_samples (lane, seat_session, captured_at, total_input_tokens, total_output_tokens)
      VALUES ('context', 'seat-c@rig', ?, 300, 100),
             ('context', 'seat-c@rig', ?, 400, 140)
    `).run(`${yesterday}T23:55:00Z`, `${today}T00:30:00Z`);

    const svc = makeService(db, tmpDir);
    await svc.rollUpSnapshots({ days: 2 });

    const row = db.prepare("SELECT * FROM daily_token_snapshots WHERE seat_session = 'seat-c@rig' AND day = ?").get(today) as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    // delta: (400-300) input + (140-100) output = 100 + 40 = 140 total
    expect(row!.input_tokens_delta).toBe(100);
    expect(row!.output_tokens_delta).toBe(40);
    expect(row!.total_tokens_delta).toBe(140);
  });

  it("skips upsert when existing snapshot has >= sample count", async () => {
    const today = new Date().toISOString().slice(0, 10);
    // Pre-seed a snapshot with 10 samples
    db.prepare(`
      INSERT INTO daily_token_snapshots (day, seat_session, samples, input_tokens_delta, output_tokens_delta, total_tokens_delta, resets)
      VALUES (?, 'seat-d@rig', 10, 500, 200, 700, 0)
    `).run(today);

    // Only 3 samples in usage_samples — should NOT overwrite the 10-sample snapshot
    db.prepare(`
      INSERT INTO usage_samples (lane, seat_session, captured_at, total_input_tokens, total_output_tokens)
      VALUES ('context', 'seat-d@rig', ?, 100, 50),
             ('context', 'seat-d@rig', ?, 200, 80),
             ('context', 'seat-d@rig', ?, 350, 120)
    `).run(`${today}T00:00:00Z`, `${today}T01:00:00Z`, `${today}T02:00:00Z`);

    const svc = makeService(db, tmpDir);
    const result = await svc.rollUpSnapshots({ days: 2 });

    expect(result.snapshotsUpserted).toBe(0);
    const row = db.prepare("SELECT samples FROM daily_token_snapshots WHERE seat_session = 'seat-d@rig'").get() as { samples: number };
    expect(row.samples).toBe(10);
  });

  it("resolves model, rigName, and seatName from nodes/rigs", async () => {
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('rig-1', 'my-rig')`).run();
    db.prepare(`INSERT INTO nodes (id, rig_id, logical_id, model) VALUES ('node-1', 'rig-1', 'dev-impl', 'claude-sonnet-4-20250514')`).run();
    db.prepare(`
      INSERT INTO usage_samples (lane, seat_session, node_id, captured_at, total_input_tokens, total_output_tokens)
      VALUES ('context', 'seat-model@rig', 'node-1', ?, 100, 50),
             ('context', 'seat-model@rig', 'node-1', ?, 200, 80)
    `).run(`${today}T00:00:00Z`, `${today}T01:00:00Z`);

    const svc = makeService(db, tmpDir);
    await svc.rollUpSnapshots({ days: 2 });

    const row = db.prepare("SELECT * FROM daily_token_snapshots WHERE seat_session = 'seat-model@rig'").get() as Record<string, unknown>;
    expect(row.model).toBe("claude-sonnet-4-20250514");
    expect(row.rig_name).toBe("my-rig");
    expect(row.seat_name).toBe("dev-impl");
  });

  it("ignores non-context lane samples", async () => {
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(`
      INSERT INTO usage_samples (lane, seat_session, captured_at, total_input_tokens, total_output_tokens)
      VALUES ('provider_window', 'seat-e@rig', ?, 999, 999)
    `).run(`${today}T00:00:00Z`);

    const svc = makeService(db, tmpDir);
    const result = await svc.rollUpSnapshots({ days: 2 });

    expect(result.snapshotsUpserted).toBe(0);
  });
});

// ── Token usage wiring (adaptDigest) ────────────────────────────────────────

describe("FleetIngestionService — token usage in adaptDigest", () => {
  let db: Database;
  let tmpDir: string;
  let reducerPath: string;

  beforeEach(() => {
    db = freshDb();
    tmpDir = mkdtempSync(join(tmpdir(), "fleet-token-"));
    reducerPath = join(tmpDir, "reducer.mjs");
    writeFileSync(reducerPath, `
      const output = {
        seat: "test-seat",
        totalTurns: 3,
        conversationTurns: 1,
        toolCalls: { Read: 2, Bash: 1 },
        repeatedReads: [],
        reviewFindings: [],
        handoffEvents: [],
        claudeMdLoaded: [],
        errors: [],
        irreversibleActions: [],
        compactionBoundaries: [],
        compactionLosses: [],
        turnTokenUsage: [
          { turn: 1, input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 200, cache_read_input_tokens: 300 },
          { turn: 2, input_tokens: 150, output_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 500 },
          { turn: 3, input_tokens: 50, output_tokens: 30, cache_creation_input_tokens: 100, cache_read_input_tokens: 400 },
        ],
        tokenTotals: { input_tokens: 300, output_tokens: 160, cache_creation_input_tokens: 300, cache_read_input_tokens: 1200 },
      };
      process.stdout.write(JSON.stringify(output));
    `);
  });

  it("stores per-turn token usage and aggregate totals from reducer output", async () => {
    const projectsDir = join(tmpDir, ".claude", "projects", "test-project");
    mkdirSync(projectsDir, { recursive: true });
    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    writeFileSync(join(projectsDir, `${sessionId}.jsonl`), '{"type":"test"}\n');

    const svc = makeService(db, tmpDir, reducerPath);
    const result = await svc.reconcileDigests();

    expect(result.ingested).toBe(1);

    const row = db.prepare(
      "SELECT token_usage, total_input_tokens, total_output_tokens, total_cache_creation_tokens, total_cache_read_tokens FROM session_digests WHERE native_session_id = ?",
    ).get(sessionId) as Record<string, unknown>;

    expect(row).toBeDefined();
    expect(row.total_input_tokens).toBe(300);
    expect(row.total_output_tokens).toBe(160);
    expect(row.total_cache_creation_tokens).toBe(300);
    expect(row.total_cache_read_tokens).toBe(1200);

    const tokenUsage = JSON.parse(row.token_usage as string) as Array<Record<string, unknown>>;
    expect(tokenUsage).toHaveLength(3);
    expect(tokenUsage[0]).toEqual({
      turn: 1, input_tokens: 100, output_tokens: 50,
      cache_creation_input_tokens: 200, cache_read_input_tokens: 300,
    });
  });

  it("defaults token fields to zero when reducer output has no tokenTotals", async () => {
    const noTokenReducer = join(tmpDir, "reducer-no-tokens.mjs");
    writeFileSync(noTokenReducer, `
      const output = {
        seat: "no-tokens",
        totalTurns: 1,
        conversationTurns: 0,
        toolCalls: {},
        repeatedReads: [],
        reviewFindings: [],
        handoffEvents: [],
        claudeMdLoaded: [],
        errors: [],
        irreversibleActions: [],
        compactionBoundaries: [],
        compactionLosses: [],
      };
      process.stdout.write(JSON.stringify(output));
    `);

    const projectsDir = join(tmpDir, ".claude", "projects", "test-project");
    mkdirSync(projectsDir, { recursive: true });
    const sessionId = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
    writeFileSync(join(projectsDir, `${sessionId}.jsonl`), '{"type":"test"}\n');

    const svc = makeService(db, tmpDir, noTokenReducer);
    const result = await svc.reconcileDigests();

    expect(result.ingested).toBe(1);

    const row = db.prepare(
      "SELECT total_input_tokens, total_output_tokens, total_cache_creation_tokens, total_cache_read_tokens, token_usage FROM session_digests WHERE native_session_id = ?",
    ).get(sessionId) as Record<string, unknown>;

    expect(row.total_input_tokens).toBe(0);
    expect(row.total_output_tokens).toBe(0);
    expect(row.total_cache_creation_tokens).toBe(0);
    expect(row.total_cache_read_tokens).toBe(0);
    expect(JSON.parse(row.token_usage as string)).toEqual([]);
  });
});

// ── Digest discovery (filesystem) ───────────────────────────────────────────

describe("FleetIngestionService — reconcileDigests (fs)", () => {
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    db = freshDb();
    tmpDir = mkdtempSync(join(tmpdir(), "fleet-test-"));
  });

  it("discovers no transcripts when projects dir is absent", async () => {
    const svc = makeService(db, tmpDir);
    const result = await svc.reconcileDigests();
    expect(result.discovered).toBe(0);
    expect(result.ingested).toBe(0);
  });

  it("skips when reducer path is absent (errors are captured, not thrown)", async () => {
    const projectsDir = join(tmpDir, ".claude", "projects", "test-project");
    mkdirSync(projectsDir, { recursive: true });
    writeFileSync(join(projectsDir, "01ABCDEF12345678901234567890.jsonl"), '{"type":"test"}\n');

    const svc = makeService(db, tmpDir, "/nonexistent/reducer.mjs");
    const result = await svc.reconcileDigests();

    expect(result.discovered).toBe(1);
    expect(result.ingested).toBe(0);
    expect(result.errors.length).toBe(1);
  });
});

// ── Review discovery (filesystem) ───────────────────────────────────────────

describe("FleetIngestionService — reconcileReviews (fs)", () => {
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    db = freshDb();
    tmpDir = mkdtempSync(join(tmpdir(), "fleet-test-"));
  });

  it("discovers no reviews when logs dir is absent", async () => {
    const svc = makeService(db, tmpDir);
    const result = await svc.reconcileReviews();
    expect(result.discovered).toBe(0);
    expect(result.ingested).toBe(0);
  });

  it("ingests a valid metrics.json", async () => {
    const logDir = join(tmpDir, ".claude", "logs", "code-review", "dual-20261006-abc123");
    mkdirSync(logDir, { recursive: true });

    const metrics = {
      traceId: "trace-001",
      pr_number: 42,
      repo: "duncanleung/openrig",
      branch: "main",
      head_sha: "abc123",
      mode: "default",
      validation_mode: "dual-stack",
      started_at: "2026-10-06T10:00:00Z",
      completed_at: "2026-10-06T10:05:00Z",
      duration_seconds: 300,
      must_fix: 2,
      suggestion: 3,
      dismissed: 1,
      deferred: 0,
      escalated: 0,
    };
    writeFileSync(join(logDir, "metrics.json"), JSON.stringify(metrics));

    const svc = makeService(db, tmpDir);
    const result = await svc.reconcileReviews();

    expect(result.discovered).toBe(1);
    expect(result.ingested).toBe(1);
    expect(result.errors.length).toBe(0);

    const row = db.prepare("SELECT * FROM review_runs WHERE trace_id = 'trace-001'").get() as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row!.pr_number).toBe(42);
    expect(row!.must_fix).toBe(2);
  });

  it("ingests findings from report.json when present", async () => {
    const logDir = join(tmpDir, ".claude", "logs", "code-review", "dual-20261006-xyz");
    mkdirSync(logDir, { recursive: true });

    writeFileSync(join(logDir, "metrics.json"), JSON.stringify({ traceId: "trace-002" }));
    const findings = [
      { findingId: "f001", file: "src/foo.ts", verdict: "MUST_FIX", summary: "null deref" },
      { findingId: "f002", file: "src/bar.ts", verdict: "SUGGESTION", description: "extract helper" },
    ];
    writeFileSync(join(logDir, "report.json"), JSON.stringify(findings));

    const svc = makeService(db, tmpDir);
    await svc.reconcileReviews();

    const count = (db.prepare("SELECT COUNT(*) AS n FROM review_findings WHERE run_trace_id = 'trace-002'").get() as { n: number }).n;
    expect(count).toBe(2);
  });

  it("skips unchanged source on second reconcile (source_hash check)", async () => {
    const logDir = join(tmpDir, ".claude", "logs", "code-review", "dual-20261006-stable");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "metrics.json"), JSON.stringify({ traceId: "trace-003", mode: "default" }));

    const svc = makeService(db, tmpDir);
    const first = await svc.reconcileReviews();
    expect(first.ingested).toBe(1);

    const second = await svc.reconcileReviews();
    expect(second.ingested).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it("re-ingests when force=true even if source_hash matches", async () => {
    const logDir = join(tmpDir, ".claude", "logs", "code-review", "dual-20261006-force");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "metrics.json"), JSON.stringify({ traceId: "trace-004", mode: "default" }));

    const svc = makeService(db, tmpDir);
    await svc.reconcileReviews();
    const second = await svc.reconcileReviews({ force: true });
    expect(second.ingested).toBe(1);
    expect(second.skipped).toBe(0);
  });
});

// ── reconcile orchestrator ───────────────────────────────────────────────────

describe("FleetIngestionService — reconcile()", () => {
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    db = freshDb();
    tmpDir = mkdtempSync(join(tmpdir(), "fleet-test-"));
  });

  it("returns a ReconcileResult with all three sections and a durationMs", async () => {
    const svc = makeService(db, tmpDir);
    const result = await svc.reconcile();
    expect(result).toHaveProperty("digests");
    expect(result).toHaveProperty("reviews");
    expect(result).toHaveProperty("snapshots");
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ── Retention coordination ───────────────────────────────────────────────────

describe("runQueueRetentionSweep — snapshot rollup before prune", () => {
  it("calls fleetIngestion.rollUpSnapshots before pruning usage_samples", async () => {
    const { runQueueRetentionSweep } = await import("../src/domain/queue-retention.js");
    const db = freshDb();

    // Minimal tables for retention sweep
    db.exec(`
      CREATE TABLE IF NOT EXISTS queue_items (qitem_id TEXT PRIMARY KEY, state TEXT);
      CREATE TABLE IF NOT EXISTS queue_transitions (transition_id TEXT PRIMARY KEY, qitem_id TEXT, ts TEXT, state TEXT, transition_note TEXT, actor_session TEXT, closure_reason TEXT, closure_target TEXT);
      CREATE TABLE IF NOT EXISTS queue_transitions_archive (transition_id TEXT PRIMARY KEY, qitem_id TEXT, ts TEXT, state TEXT, transition_note TEXT, actor_session TEXT, closure_reason TEXT, closure_target TEXT, archived_at TEXT);
      CREATE TABLE IF NOT EXISTS watchdog_history (history_id TEXT PRIMARY KEY, job_id TEXT, evaluated_at TEXT);
      CREATE TABLE IF NOT EXISTS workflow_instances (status TEXT, current_frontier_json TEXT);
    `);

    const callOrder: string[] = [];
    const fleetIngestion = {
      rollUpSnapshots: vi.fn().mockImplementation(async () => {
        callOrder.push("rollup");
        return { daysRolledUp: 0, snapshotsUpserted: 0 };
      }),
    };

    // Spy on pruneUsageSamples by inserting a sample that would be pruned
    const past = new Date(Date.now() - 20 * 86400000).toISOString();
    db.prepare("INSERT INTO usage_samples (lane, seat_session, captured_at) VALUES ('context', 'x', ?)").run(past);

    let pruneRan = false;
    const origPrepare = db.prepare.bind(db);
    const prepSpy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      const stmt = origPrepare(sql);
      if (sql.includes("DELETE FROM usage_samples")) {
        const origRun = stmt.run.bind(stmt);
        vi.spyOn(stmt, "run").mockImplementation((...args: unknown[]) => {
          callOrder.push("prune");
          pruneRan = true;
          return origRun(...args);
        });
      }
      return stmt;
    });

    await runQueueRetentionSweep(db, { nowIso: new Date().toISOString() }, { fleetIngestion });

    prepSpy.mockRestore();
    expect(callOrder.indexOf("rollup")).toBeLessThan(callOrder.indexOf("prune") !== -1 ? callOrder.indexOf("prune") : Infinity);
    expect(fleetIngestion.rollUpSnapshots).toHaveBeenCalledOnce();
    expect(pruneRan).toBe(true);
  });
});

// ── Phase 2: Lifecycle event subscription ──────────────────────────────────

describe("FleetIngestionService — lifecycle events", () => {
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    db = freshDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS occupant_tenures (
        id TEXT PRIMARY KEY,
        node_id TEXT,
        generation_ordinal INTEGER,
        generation_uuid TEXT,
        kind TEXT,
        native_session_id_at_boot TEXT
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        node_id TEXT PRIMARY KEY,
        rig_id TEXT,
        logical_id TEXT,
        session_name TEXT
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS rigs (
        rig_id TEXT PRIMARY KEY,
        name TEXT
      )
    `);
    tmpDir = mkdtempSync(join(tmpdir(), "fleet-lifecycle-"));
  });

  it("ingestSessionByNodeId returns error when no native session ID exists", async () => {
    const svc = makeService(db, tmpDir);
    const result = await svc.ingestSessionByNodeId("nonexistent-node");
    expect(result.ingested).toBe(false);
    expect(result.nativeSessionId).toBeNull();
    expect(result.error).toBe("no native session ID for node");
  });

  it("ingestSessionByNodeId returns error when transcript file not found", async () => {
    db.prepare(
      "INSERT INTO occupant_tenures (id, node_id, generation_ordinal, generation_uuid, kind, native_session_id_at_boot) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("t1", "node-1", 1, "gen-1", "claude", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

    const svc = makeService(db, tmpDir);
    const result = await svc.ingestSessionByNodeId("node-1");
    expect(result.ingested).toBe(false);
    expect(result.nativeSessionId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(result.error).toBe("transcript file not found");
  });

  it("subscribeLifecycleEvents fires ingestSessionByNodeId on session.stopped", async () => {
    type Subscriber = (event: { type: string; nodeId?: string }) => void;
    const subscribers: Subscriber[] = [];
    const mockEventBus = {
      subscribe: (cb: Subscriber) => {
        subscribers.push(cb);
        return () => { subscribers.splice(subscribers.indexOf(cb), 1); };
      },
    };

    const svc = new FleetIngestionService({
      db,
      fleetStore: new FleetStore(db),
      homedir: tmpDir,
      reducerPath: "/nonexistent/reducer.mjs",
      eventBus: mockEventBus,
    });

    const ingestSpy = vi.spyOn(svc, "ingestSessionByNodeId").mockResolvedValue({
      ingested: true,
      nativeSessionId: "test-session-id",
    });

    svc.subscribeLifecycleEvents();
    expect(subscribers).toHaveLength(1);

    subscribers[0]!({ type: "session.stopped", nodeId: "node-42" });

    await vi.waitFor(() => expect(ingestSpy).toHaveBeenCalledWith("node-42"));

    svc.unsubscribeLifecycleEvents();
    expect(subscribers).toHaveLength(0);
  });

  it("subscribeLifecycleEvents ignores non-session.stopped events", () => {
    type Subscriber = (event: { type: string; nodeId?: string }) => void;
    const subscribers: Subscriber[] = [];
    const mockEventBus = {
      subscribe: (cb: Subscriber) => {
        subscribers.push(cb);
        return () => { subscribers.splice(subscribers.indexOf(cb), 1); };
      },
    };

    const svc = new FleetIngestionService({
      db,
      fleetStore: new FleetStore(db),
      homedir: tmpDir,
      reducerPath: "/nonexistent/reducer.mjs",
      eventBus: mockEventBus,
    });

    const ingestSpy = vi.spyOn(svc, "ingestSessionByNodeId").mockResolvedValue({
      ingested: false,
      nativeSessionId: null,
    });

    svc.subscribeLifecycleEvents();
    subscribers[0]!({ type: "node.added", nodeId: "node-99" });
    expect(ingestSpy).not.toHaveBeenCalled();
    svc.unsubscribeLifecycleEvents();
  });

  it("ingestRecentReviews only processes review logs modified within the window", async () => {
    const logsDir = join(tmpDir, ".claude", "logs", "code-review");
    const recentDir = join(logsDir, "dual-repo-branch-20261006T200000Z");
    const oldDir = join(logsDir, "dual-repo-branch-20260901T100000Z");

    mkdirSync(recentDir, { recursive: true });
    mkdirSync(oldDir, { recursive: true });

    const recentMetrics = {
      traceId: "recent-trace",
      metricsJson: "{}",
    };
    const oldMetrics = {
      traceId: "old-trace",
      metricsJson: "{}",
    };

    writeFileSync(join(recentDir, "metrics.json"), JSON.stringify(recentMetrics));
    writeFileSync(join(oldDir, "metrics.json"), JSON.stringify(oldMetrics));

    const { utimesSync } = await import("node:fs");
    const oldTime = new Date(Date.now() - 30 * 60 * 1000);
    utimesSync(join(oldDir, "metrics.json"), oldTime, oldTime);

    const svc = makeService(db, tmpDir);
    const result = await svc.ingestRecentReviews(10 * 60 * 1000);

    expect(result.discovered).toBe(1);
    expect(result.ingested).toBe(1);

    const row = db.prepare("SELECT trace_id FROM review_runs WHERE trace_id = ?").get("recent-trace");
    expect(row).toBeDefined();

    const oldRow = db.prepare("SELECT trace_id FROM review_runs WHERE trace_id = ?").get("old-trace");
    expect(oldRow).toBeUndefined();
  });
});

describe("overlap guard — concurrent reconcile calls", () => {
  it("second concurrent reconcile returns skippedOverlap without running", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "fleet-overlap-"));
    const db = freshDb();
    const svc = makeService(db, tmpDir);

    const first = svc.reconcile();
    const second = svc.reconcile();

    const [r1, r2] = await Promise.all([first, second]);

    expect(r2.skippedOverlap).toBe(true);
    expect(r2.durationMs).toBe(0);
    expect(r1.skippedOverlap).toBeUndefined();
  });

  it("reconcile runs normally after a prior one completes", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "fleet-overlap-"));
    const db = freshDb();
    const svc = makeService(db, tmpDir);

    const r1 = await svc.reconcile();
    expect(r1.skippedOverlap).toBeUndefined();

    const r2 = await svc.reconcile();
    expect(r2.skippedOverlap).toBeUndefined();
  });

  it("force reconcile waits for active run then runs its own", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "fleet-overlap-"));
    const db = freshDb();
    const svc = makeService(db, tmpDir);

    const first = svc.reconcile();
    const forced = svc.reconcile({ force: true });

    const [r1, r2] = await Promise.all([first, forced]);

    expect(r1.skippedOverlap).toBeUndefined();
    expect(r2.skippedOverlap).toBeUndefined();
    expect(r1).not.toBe(r2);
  });

  it("non-force call after a forced run completes works normally", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "fleet-overlap-"));
    const db = freshDb();
    const svc = makeService(db, tmpDir);

    await svc.reconcile({ force: true });
    const r = await svc.reconcile();
    expect(r.skippedOverlap).toBeUndefined();
  });
});

describe("resolveFleetReconcileIntervalMs — env var validation", () => {
  it("returns default for undefined", () => {
    expect(resolveFleetReconcileIntervalMs(undefined)).toBe(5 * 60 * 1000);
  });

  it("returns default for empty string", () => {
    expect(resolveFleetReconcileIntervalMs("")).toBe(5 * 60 * 1000);
  });

  it("returns default for non-numeric input", () => {
    expect(resolveFleetReconcileIntervalMs("abc")).toBe(5 * 60 * 1000);
  });

  it("returns default for negative values", () => {
    expect(resolveFleetReconcileIntervalMs("-1")).toBe(5 * 60 * 1000);
  });

  it("returns default for zero", () => {
    expect(resolveFleetReconcileIntervalMs("0")).toBe(5 * 60 * 1000);
  });

  it("returns default for values below minimum (60s)", () => {
    expect(resolveFleetReconcileIntervalMs("1000")).toBe(5 * 60 * 1000);
  });

  it("accepts valid values at the minimum", () => {
    expect(resolveFleetReconcileIntervalMs("60000")).toBe(60000);
  });

  it("accepts valid values in range", () => {
    expect(resolveFleetReconcileIntervalMs("300000")).toBe(300000);
  });

  it("clamps values above maximum (24h) to the maximum", () => {
    expect(resolveFleetReconcileIntervalMs("86400001")).toBe(86_400_000);
  });

  it("clamps overflow values that exceed Node timer limit", () => {
    expect(resolveFleetReconcileIntervalMs("2147483648")).toBe(86_400_000);
  });

  it("returns default for trailing-junk strings like '300000ms'", () => {
    expect(resolveFleetReconcileIntervalMs("300000ms")).toBe(5 * 60 * 1000);
  });

  it("returns default for floating point values", () => {
    expect(resolveFleetReconcileIntervalMs("1500.7")).toBe(5 * 60 * 1000);
  });
});
