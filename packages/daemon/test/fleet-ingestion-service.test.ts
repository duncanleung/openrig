import { describe, it, expect, beforeEach, vi } from "vitest";
import BetterSqlite3, { type Database } from "better-sqlite3";
import { sessionDigestsSchema } from "../src/db/migrations/096_session_digests.js";
import { reviewRunsSchema } from "../src/db/migrations/097_review_runs.js";
import { reviewFindingsSchema } from "../src/db/migrations/098_review_findings.js";
import { dailyTokenSnapshotsSchema } from "../src/db/migrations/099_daily_token_snapshots.js";
import { digestTokenUsageSchema } from "../src/db/migrations/100_digest_token_usage.js";
import { digestEscalationCountSchema } from "../src/db/migrations/101_digest_escalation_count.js";
import { digestSessionTimestampsSchema } from "../src/db/migrations/102_digest_session_timestamps.js";
import { digestSkillInvocationsSchema } from "../src/db/migrations/103_digest_skill_invocations.js";
import { digestStallPatternsSchema } from "../src/db/migrations/108_session_digest_stall_patterns.js";
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
  db.exec(digestEscalationCountSchema.sql);
  db.exec(digestSessionTimestampsSchema.sql);
  db.exec(digestSkillInvocationsSchema.sql);
  db.exec(digestStallPatternsSchema.sql);
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

// ── Token usage dedup (real reducer, multi-line JSONL) ────────────────────────

describe("FleetIngestionService — token usage dedup across multi-line messages", () => {
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    db = freshDb();
    tmpDir = mkdtempSync(join(tmpdir(), "fleet-dedup-"));
  });

  it("deduplicates usage when one message.id spans text + tool_use lines", async () => {
    const realReducer = join(__dirname, "..", "assets", "plugins", "openrig-core", "skills", "retro", "scripts", "reduce-transcript.mjs");
    const projectsDir = join(tmpDir, ".claude", "projects", "test-project");
    mkdirSync(projectsDir, { recursive: true });
    const sessionId = "dedup-test-aaaa-bbbb-cccc-dddddddddddd";

    // 4 JSONL lines for one API response: thinking, text, tool_use, tool_use
    // All share message.id and carry identical usage
    const msgId = "msg_test_dedup_001";
    const usage = { input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 500, cache_read_input_tokens: 1000 };
    const lines = [
      JSON.stringify({ type: "assistant", message: { id: msgId, content: [{ type: "thinking", thinking: "hmm" }], usage } }),
      JSON.stringify({ type: "assistant", message: { id: msgId, content: [{ type: "text", text: "hello" }], usage } }),
      JSON.stringify({ type: "assistant", message: { id: msgId, content: [{ type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/tmp/x" } }], usage } }),
      JSON.stringify({ type: "assistant", message: { id: msgId, content: [{ type: "tool_use", id: "tu_2", name: "Bash", input: { command: "ls" } }], usage } }),
    ];
    writeFileSync(join(projectsDir, `${sessionId}.jsonl`), lines.join("\n") + "\n");

    const svc = makeService(db, tmpDir, realReducer);
    const result = await svc.reconcileDigests();

    expect(result.ingested).toBe(1);

    const row = db.prepare(
      "SELECT token_usage, total_input_tokens, total_output_tokens, total_cache_creation_tokens, total_cache_read_tokens FROM session_digests WHERE native_session_id = ?",
    ).get(sessionId) as Record<string, unknown>;

    expect(row).toBeDefined();
    // Should count usage exactly once, not 3x (text + 2 tool_use pass hasAction)
    expect(row.total_input_tokens).toBe(100);
    expect(row.total_output_tokens).toBe(200);
    expect(row.total_cache_creation_tokens).toBe(500);
    expect(row.total_cache_read_tokens).toBe(1000);

    const tokenUsage = JSON.parse(row.token_usage as string) as Array<Record<string, unknown>>;
    expect(tokenUsage).toHaveLength(1);
  });
});

// ── Session timespan (real reducer) ───────────────────────────────────────────

describe("FleetIngestionService — session started_at / ended_at / duration_ms", () => {
  let db: Database;
  let tmpDir: string;
  const realReducer = join(__dirname, "..", "assets", "plugins", "openrig-core", "skills", "retro", "scripts", "reduce-transcript.mjs");

  beforeEach(() => {
    db = freshDb();
    tmpDir = mkdtempSync(join(tmpdir(), "fleet-span-"));
  });

  const ingest = async (sessionId: string, lines: unknown[]) => {
    const projectsDir = join(tmpDir, ".claude", "projects", "test-project");
    mkdirSync(projectsDir, { recursive: true });
    writeFileSync(join(projectsDir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const svc = makeService(db, tmpDir, realReducer);
    await svc.reconcileDigests();
    return db.prepare(
      "SELECT started_at, ended_at, duration_ms FROM session_digests WHERE native_session_id = ?",
    ).get(sessionId) as { started_at: string | null; ended_at: string | null; duration_ms: number | null };
  };

  it("uses the first human turn as start and the last assistant turn as end", async () => {
    const row = await ingest("span-test-aaaa-bbbb-cccc-dddddddddddd", [
      { type: "user", timestamp: "2026-10-12T10:00:00.000Z", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "ignored" }] } },
      { type: "user", timestamp: "2026-10-12T10:00:05.000Z", message: { content: "first human turn" } },
      { type: "assistant", timestamp: "2026-10-12T10:00:10.000Z", message: { id: "m1", content: [{ type: "text", text: "a" }] } },
      { type: "user", timestamp: "2026-10-12T10:05:00.000Z", message: { content: "second human turn" } },
      { type: "assistant", timestamp: "2026-10-12T10:10:05.000Z", message: { id: "m2", content: [{ type: "text", text: "b" }] } },
    ]);
    expect(row.started_at).toBe("2026-10-12T10:00:05.000Z");
    expect(row.ended_at).toBe("2026-10-12T10:10:05.000Z");
    expect(row.duration_ms).toBe(10 * 60 * 1000);
  });

  it("leaves all three columns NULL when the transcript has no timestamps", async () => {
    const row = await ingest("span-none-aaaa-bbbb-cccc-dddddddddddd", [
      { type: "user", message: { content: "hi" } },
      { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "a" }] } },
    ]);
    expect(row).toEqual({ started_at: null, ended_at: null, duration_ms: null });
  });

  it("leaves duration_ms NULL when there is no assistant turn", async () => {
    const row = await ingest("span-half-aaaa-bbbb-cccc-dddddddddddd", [
      { type: "user", timestamp: "2026-10-12T10:00:05.000Z", message: { content: "hi" } },
    ]);
    expect(row.started_at).toBe("2026-10-12T10:00:05.000Z");
    expect(row.ended_at).toBeNull();
    expect(row.duration_ms).toBeNull();
  });
});

// ── Skill invocations (real reducer) ───────────────────────────────────────────

describe("FleetIngestionService — skill_invocations", () => {
  let db: Database;
  let tmpDir: string;
  const realReducer = join(__dirname, "..", "assets", "plugins", "openrig-core", "skills", "retro", "scripts", "reduce-transcript.mjs");

  beforeEach(() => {
    db = freshDb();
    tmpDir = mkdtempSync(join(tmpdir(), "fleet-skills-"));
  });

  const ingest = async (sessionId: string, lines: unknown[]) => {
    const projectsDir = join(tmpDir, ".claude", "projects", "test-project");
    mkdirSync(projectsDir, { recursive: true });
    writeFileSync(join(projectsDir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    await makeService(db, tmpDir, realReducer).reconcileDigests();
    const row = db.prepare("SELECT skill_invocations FROM session_digests WHERE native_session_id = ?").get(sessionId) as { skill_invocations: string };
    return JSON.parse(row.skill_invocations) as Array<{ skill: string; args: string | null; turn: number }>;
  };
  const skillCall = (id: string, input: Record<string, unknown>) => ({
    type: "assistant",
    message: { id, content: [{ type: "tool_use", id: `tu_${id}`, name: "Skill", input }] },
  });

  it("records skill name, args and turn for each Skill call, in order", async () => {
    const got = await ingest("skills-aaaa-bbbb-cccc-dddddddddddd", [
      { type: "assistant", message: { id: "m0", content: [{ type: "text", text: "hi" }] } },
      skillCall("m1", { skill: "ticket-loop", args: "RIG-57" }),
      skillCall("m2", { skill: "recap" }),
    ]);
    expect(got).toEqual([
      { skill: "ticket-loop", args: "RIG-57", turn: 2 },
      { skill: "recap", args: null, turn: 3 },
    ]);
  });

  it("truncates args to 200 characters", async () => {
    const got = await ingest("skills-long-bbbb-cccc-dddddddddddd", [
      skillCall("m1", { skill: "orchestrate", args: "ab ".repeat(200) }),
    ]);
    expect(got[0].args).toHaveLength(200);
  });

  it("stores [] when no Skill tool is called, and ignores malformed Skill inputs", async () => {
    const none = await ingest("skills-none-bbbb-cccc-dddddddddddd", [
      { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } },
      skillCall("m2", { args: "no skill name" }),
    ]);
    expect(none).toEqual([]);
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
    writeFileSync(join(logDir, "metrics.json"), JSON.stringify({ traceId: "trace-003", mode: "default", rig_name: "my-rig" }));

    const svc = makeService(db, tmpDir);
    const first = await svc.reconcileReviews();
    expect(first.ingested).toBe(1);

    const second = await svc.reconcileReviews();
    expect(second.ingested).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it("backfills rig/seat identity on unchanged rows where rig_name IS NULL", async () => {
    const logDir = join(tmpDir, ".claude", "logs", "code-review", "dual-20261006-backfill");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "metrics.json"), JSON.stringify({ traceId: "trace-bf", completed_at: "2026-10-06T10:05:00Z" }));

    const svc = makeService(db, tmpDir);
    await svc.reconcileReviews();
    const before = db.prepare("SELECT rig_name FROM review_runs WHERE trace_id = 'trace-bf'").get() as { rig_name: string | null };
    expect(before.rig_name).toBeNull();

    // Identity data arrives later; the file itself is unchanged.
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('rig-bf', 'bf-rig')`).run();
    db.prepare(`INSERT INTO nodes (id, rig_id, logical_id) VALUES ('node-bf', 'rig-bf', 'review.reviewer')`).run();
    db.prepare(`INSERT INTO usage_samples (lane, seat_session, node_id, captured_at) VALUES ('context', 'rr@bf-rig', 'node-bf', '2026-10-06 10:00:00')`).run();

    const second = await svc.reconcileReviews();
    expect(second.ingested).toBe(1);
    const after = db.prepare("SELECT rig_name, seat_name FROM review_runs WHERE trace_id = 'trace-bf'").get() as { rig_name: string | null; seat_name: string | null };
    expect(after).toEqual({ rig_name: "bf-rig", seat_name: "review.reviewer" });

    // Once populated, the row is skipped again.
    const third = await svc.reconcileReviews();
    expect(third.skipped).toBe(1);
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

// ── Digest redaction (RIG-60) ───────────────────────────────────────────────

describe("FleetIngestionService — digest redaction", () => {
  const SK = "sk-abcdefghijklmnopqrstuvwx";
  const GHP = "ghp_abcdefghijklmnopqrstuvwxyz0123";
  const BEARER = "abcdefghijklmnopqrstuvwxyz.0123456789";
  const CLI_TOKEN = "hunter2-cli-token";
  const EXPORT_KEY = "export-key-value-123";
  const URL_PASS = "p4ssw0rd-in-url";
  const RAW_SECRETS = [SK, GHP, BEARER, CLI_TOKEN, EXPORT_KEY, URL_PASS];

  let db: Database;
  let tmpDir: string;
  let reducerPath: string;
  const sessionId = "cccccccc-dddd-eeee-ffff-000000000000";

  function writeReducer(version = ""): void {
    writeFileSync(reducerPath, `
      const output = {
        seat: "redact-seat",
        totalTurns: 9,
        conversationTurns: 4,
        toolCalls: { Bash: 2 },
        repeatedReads: [{ path: "/tmp/a.txt", count: 3 }],
        reviewFindings: ["leaked ${SK} in config"],
        handoffEvents: [
          { type: "send", to: "orch-lead@openrig", message: "use ${GHP} for push" },
          { type: "queue", operation: "create", command: "rig queue create --token ${CLI_TOKEN}" },
        ],
        skillInvocations: [{ skill: "code-review-dual", args: "--api-key ${CLI_TOKEN} 42", turn: 5 }],
        claudeMdLoaded: [],
        errors: [{ tool: "Bash", message: "curl -H 'Authorization: Bearer ${BEARER}' failed", turn: 7 }],
        irreversibleActions: [
          { command: "export API_KEY=${EXPORT_KEY} && git push https://bob:${URL_PASS}@github.com/x/y.git", kind: "git-push", turn: 8 },
        ],
        compactionBoundaries: [],
        compactionLosses: [],
        turnTokenUsage: [{ turn: 1, input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 }],
        tokenTotals: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 },
      };
      process.stdout.write(JSON.stringify(output));
      // ${version}
    `);
  }

  beforeEach(() => {
    db = freshDb();
    tmpDir = mkdtempSync(join(tmpdir(), "fleet-redact-"));
    reducerPath = join(tmpDir, "reducer.mjs");
    writeReducer();
    const projectsDir = join(tmpDir, ".claude", "projects", "test-project");
    mkdirSync(projectsDir, { recursive: true });
    writeFileSync(join(projectsDir, `${sessionId}.jsonl`), '{"type":"test"}\n');
  });

  function readRow(): Record<string, string | number | null> {
    return db.prepare("SELECT * FROM session_digests WHERE native_session_id = ?").get(sessionId) as Record<string, string | number | null>;
  }

  it("redacts secrets in all five text-bearing fields and keeps the rest intact", async () => {
    const result = await makeService(db, tmpDir, reducerPath).reconcileDigests();
    expect(result.ingested).toBe(1);

    const row = readRow();
    const texts = [row.review_findings, row.handoff_events, row.skill_invocations, row.errors, row.irreversible_actions] as string[];
    for (const text of texts) {
      for (const secret of RAW_SECRETS) expect(text).not.toContain(secret);
      expect(() => JSON.parse(text)).not.toThrow();
    }
    for (const text of texts) expect(text).toContain("[REDACTED]");

    const errors = JSON.parse(row.errors as string);
    expect(errors).toEqual([{ tool: "Bash", message: "curl -H 'Authorization: [REDACTED]' failed", turn: 7 }]);

    const irreversible = JSON.parse(row.irreversible_actions as string);
    expect(irreversible[0].kind).toBe("git-push");
    expect(irreversible[0].turn).toBe(8);
    expect(irreversible[0].command).toContain("export API_KEY=[REDACTED]");
    expect(irreversible[0].command).toContain("https://bob:[REDACTED]@github.com/x/y.git");

    const handoffs = JSON.parse(row.handoff_events as string);
    expect(handoffs[0]).toEqual({ type: "send", to: "orch-lead@openrig", message: "use [REDACTED] for push" });
    expect(handoffs[1]).toEqual({ type: "queue", operation: "create", command: "rig queue create --token [REDACTED]" });

    expect(JSON.parse(row.skill_invocations as string)).toEqual([
      { skill: "code-review-dual", args: "--api-key [REDACTED] 42", turn: 5 },
    ]);
    expect(JSON.parse(row.review_findings as string)).toEqual(["leaked [REDACTED] in config"]);

    // Out-of-scope fields are untouched.
    expect(JSON.parse(row.tool_calls as string)).toEqual({ Bash: 2 });
    expect(JSON.parse(row.repeated_reads as string)).toEqual([{ path: "/tmp/a.txt", count: 3 }]);
    expect(row.total_turns).toBe(9);
    expect(JSON.parse(row.token_usage as string)[0].turn).toBe(1);
  });

  it("re-ingests and redacts an unchanged transcript stored under an older PARSER_VERSION", async () => {
    const svc = makeService(db, tmpDir, reducerPath);
    await svc.reconcileDigests();
    // Simulate a pre-redaction row: identity present, same source hash, old parser, raw secret stored.
    db.prepare(
      "UPDATE session_digests SET rig_name = 'r', parser_version = 'reduce-transcript.mjs@5', errors = ? WHERE native_session_id = ?",
    ).run(JSON.stringify([{ tool: "Bash", message: `raw ${SK}`, turn: 7 }]), sessionId);

    const result = await svc.reconcileDigests();
    expect(result.ingested).toBe(1);
    expect(result.skipped).toBe(0);
    const row = readRow();
    expect(row.errors).not.toContain(SK);
    expect(row.errors).toContain("[REDACTED]");
    expect(row.parser_version).not.toBe("reduce-transcript.mjs@5");

    // Control: with the current version and identity, the next pass skips.
    db.prepare("UPDATE session_digests SET rig_name = 'r' WHERE native_session_id = ?").run(sessionId);
    const again = await svc.reconcileDigests();
    expect(again.skipped).toBe(1);
  });
});

describe("redactDigestValue", () => {
  it("redacts each key=value shape, keeps names, and leaves normal names alone", async () => {
    const { redactDigestValue } = await import("../src/domain/digest-redaction.js");
    expect(redactDigestValue("tool --password s3cret --verbose")).toBe("tool --password [REDACTED] --verbose");
    expect(redactDigestValue("tool --token=abc123")).toBe("tool --token=[REDACTED]");
    expect(redactDigestValue("export GITHUB_TOKEN='a b' && ls")).toBe("export GITHUB_TOKEN=[REDACTED] && ls");
    expect(redactDigestValue("PASSWORD=hunter2 run")).toBe("PASSWORD=[REDACTED] run");
    expect(redactDigestValue("postgres://user:pw@db:5432/x")).toBe("postgres://user:[REDACTED]@db:5432/x");
    expect(redactDigestValue("Authorization: Basic dXNlcjpwdw==")).toBe("Authorization: [REDACTED]");
    expect(redactDigestValue("redis://:secret@h:6379")).toBe("redis://:[REDACTED]@h:6379");
    expect(redactDigestValue("amqp://guest:pw@mq:5672/v")).toBe("amqp://guest:[REDACTED]@mq:5672/v");
    expect(redactDigestValue("http://host:8080/path")).toBe("http://host:8080/path");
    expect(redactDigestValue("redis://h:6379")).toBe("redis://h:6379");
    expect(redactDigestValue('Authorization: "s3cret"')).toBe("Authorization: [REDACTED]");
    expect(redactDigestValue("Authorization: 's3cret' next")).toBe("Authorization: [REDACTED] next");
    expect(redactDigestValue('{"Authorization":"Basic dXNlcjpwdw=="}')).toBe('{"Authorization":[REDACTED]}');
    expect(redactDigestValue("curl -H 'Authorization: Bearer abc' x")).toBe("curl -H 'Authorization: [REDACTED]' x");
    expect(redactDigestValue({ skill: "code-review-dual", to: "orch-lead@openrig", turn: 3, n: null, ok: true })).toEqual({
      skill: "code-review-dual", to: "orch-lead@openrig", turn: 3, n: null, ok: true,
    });
    expect(redactDigestValue("git push origin main --force-with-lease")).toBe("git push origin main --force-with-lease");
    expect(redactDigestValue("ls --token-count")).toBe("ls --token-count");
  });
});
