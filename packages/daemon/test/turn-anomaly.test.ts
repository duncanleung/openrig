import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { sessionDigestsSchema } from "../src/db/migrations/096_session_digests.js";
import { digestStallPatternsSchema } from "../src/db/migrations/108_session_digest_stall_patterns.js";
import {
  DEFAULT_TURN_THRESHOLDS, TurnAnomalyDetector, judgeWindow, resolveTurnRole,
} from "../src/domain/turn-anomaly-detector.js";
import { makeTurnAnomalyPolicy } from "../src/domain/policies/turn-anomaly.js";
import type { PolicyJob } from "../src/domain/policies/types.js";

const T0 = Date.parse("2026-10-24T10:00:00.000Z");
const MIN = 60_000;

describe("turn-anomaly: judgeWindow arithmetic", () => {
  const base = { thresholds: { ...DEFAULT_TURN_THRESHOLDS }, windowMs: 30 * MIN, now: T0 };
  const baseline = { at: T0 - 30 * MIN, total: 100, conversation: 10 };

  it("flags the window ratio, not the lifetime ratio (5:1 lifetime, 80:1 recent)", () => {
    // lifetime 180:11 is ~16:1, under the 20:1 implementer threshold; the window is 80:1.
    const v = judgeWindow({ ...base, role: "implementer", current: { total: 180, conversation: 11 }, baseline });
    expect(v).toMatchObject({ kind: "high_ratio", window: { assistantTurns: 80, userMessages: 1, ratio: 80 } });
  });

  it("does not flag a session whose lifetime ratio is high but whose window is calm", () => {
    const v = judgeWindow({ ...base, role: "implementer", current: { total: 4100, conversation: 50 }, baseline: { at: T0 - 30 * MIN, total: 4000, conversation: 45 } });
    expect(v).toEqual({ kind: null, reason: "below_threshold" });
  });

  it("compares with multiplication so a fractional ratio is exact: 61 turns over 3 messages at 20:1", () => {
    // 61/3 = 20.33 > 20 flags; 60/3 = 20 does not (strictly greater). Integer division would give 20 and 20.
    const over = judgeWindow({ ...base, role: "implementer", current: { total: 161, conversation: 13 }, baseline });
    const exact = judgeWindow({ ...base, role: "implementer", current: { total: 160, conversation: 13 }, baseline });
    expect(over.kind).toBe("high_ratio");
    expect(exact.kind).toBeNull();
  });

  it("flags zero user messages as its own kind instead of excluding it", () => {
    const v = judgeWindow({ ...base, role: "implementer", current: { total: 125, conversation: 10 }, baseline });
    expect(v).toMatchObject({ kind: "zero_conversation", window: { assistantTurns: 25, userMessages: 0, ratio: null } });
  });

  it("does not flag a zero-message window at or below the role threshold", () => {
    expect(judgeWindow({ ...base, role: "implementer", current: { total: 120, conversation: 10 }, baseline }).kind).toBeNull();
  });

  it("applies role thresholds: 50 orchestrator, 40 reviewer, 20 implementer, 30 other", () => {
    expect(DEFAULT_TURN_THRESHOLDS).toEqual({ orchestrator: 50, reviewer: 40, implementer: 20, other: 30 });
    const cur = { total: 100 + 45, conversation: 11 }; // 45:1
    const kind = (role: "orchestrator" | "reviewer" | "implementer" | "other") => judgeWindow({ ...base, role, current: cur, baseline }).kind;
    expect(kind("orchestrator")).toBeNull();
    expect(kind("reviewer")).toBe("high_ratio");
    expect(kind("implementer")).toBe("high_ratio");
    expect(kind("other")).toBe("high_ratio");
  });

  it("waits for half the window of history and ignores a counter reset", () => {
    expect(judgeWindow({ ...base, role: "other", current: { total: 500, conversation: 10 }, baseline: { at: T0 - 5 * MIN, total: 100, conversation: 10 } }))
      .toEqual({ kind: null, reason: "insufficient_history" });
    expect(judgeWindow({ ...base, role: "other", current: { total: 50, conversation: 10 }, baseline }))
      .toEqual({ kind: null, reason: "counter_reset" });
    expect(judgeWindow({ ...base, role: "other", current: { total: 500, conversation: 10 }, baseline: null }))
      .toEqual({ kind: null, reason: "insufficient_history" });
  });
});

describe("turn-anomaly: role resolution", () => {
  const row = (seat_session: string, node_logical_id: string | null = null) => ({ seat_session, seat_name: seat_session.split("@")[0]!, node_logical_id });
  it("derives roles from member and logical ids", () => {
    expect(resolveTurnRole(row("orch-lead@openrig", "orch.lead"), {})).toBe("orchestrator");
    expect(resolveTurnRole(row("quality-reviewer@openrig", "review.quality-reviewer"), {})).toBe("reviewer");
    expect(resolveTurnRole(row("dev-impl@openrig", "dev.impl"), {})).toBe("implementer");
    expect(resolveTurnRole(row("scribe@openrig", "docs.scribe"), {})).toBe("other");
  });
  it("lets a configured mapping win", () => {
    expect(resolveTurnRole(row("scribe@openrig", "docs.scribe"), { "docs.scribe": "reviewer" })).toBe("reviewer");
    expect(resolveTurnRole(row("dev-impl@openrig", "dev.impl"), { "dev-impl@openrig": "orchestrator" })).toBe("orchestrator");
  });
});

describe("turn-anomaly: detector episodes", () => {
  let db: Database.Database;
  let clock = T0;
  let detector: TurnAnomalyDetector;
  let n = 0;

  const digest = (o: { native?: string; seat?: string; logical?: string; rig?: string | null; gen?: string | null; total: number; conv: number; stall?: unknown[]; at?: number }) => {
    const native = o.native ?? "native-1";
    const at = new Date(o.at ?? clock).toISOString();
    const exists = db.prepare(`SELECT id FROM session_digests WHERE native_session_id = ?`).get(native);
    if (exists) {
      db.prepare(`UPDATE session_digests SET total_turns = ?, conversation_turns = ?, stall_patterns = ?, ingested_at = ?, generation_uuid = ? WHERE native_session_id = ?`)
        .run(o.total, o.conv, JSON.stringify(o.stall ?? []), at, o.gen ?? "gen-A", native);
      return;
    }
    db.prepare(`
      INSERT INTO session_digests (rig_name, seat_session, seat_name, node_logical_id, native_session_id, generation_uuid, transcript_path,
        total_turns, conversation_turns, tool_calls, repeated_reads, review_findings, handoff_events, claude_md_loaded, errors,
        irreversible_actions, compaction_boundaries, compaction_losses, stall_patterns, ingested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', '[]', '[]', '[]', '[]', '[]', '[]', '[]', ?, ?)
    `).run(o.rig === undefined ? "openrig" : o.rig, o.seat ?? "dev-impl@openrig", (o.seat ?? "dev-impl@openrig").split("@")[0], o.logical ?? "dev.impl",
      native, o.gen ?? "gen-A", `/t/${native}-${++n}.jsonl`, o.total, o.conv, JSON.stringify(o.stall ?? []), at);
  };
  const advance = (ms: number) => { clock += ms; };

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, [...ALL_MIGRATIONS, sessionDigestsSchema, digestStallPatternsSchema]);
    clock = T0;
    detector = new TurnAnomalyDetector({ db, now: () => new Date(clock) });
  });
  afterEach(() => db.close());

  /** Baseline now, then 31 min later with the given counts. */
  const runWindow = (start: { total: number; conv: number }, end: { total: number; conv: number }, extra: Partial<Parameters<typeof digest>[0]> = {}) => {
    digest({ ...start, ...extra }); detector.scan();
    advance(31 * MIN);
    digest({ ...end, ...extra }); detector.scan();
  };

  it("opens an episode with window, threshold, role and lifetime evidence", () => {
    runWindow({ total: 100, conv: 10 }, { total: 180, conv: 11 });
    const snap = detector.snapshot();
    expect(snap.findings).toHaveLength(1);
    expect(snap.findings[0]).toMatchObject({
      kind: "high_ratio", session: "dev-impl@openrig", role: "implementer", rig: "openrig",
      window: { assistantTurns: 80, userMessages: 1, ratio: 80, threshold: 20, windowMs: 30 * MIN },
      lifetime: { assistantTurns: 180, userMessages: 11, zeroConversation: false },
      subject: { nativeSessionId: "native-1", generation: "gen-A" },
    });
  });

  it("flags a zero-conversation window and marks lifetime zero-conversation", () => {
    runWindow({ total: 10, conv: 0 }, { total: 60, conv: 0 });
    expect(detector.snapshot().findings[0]).toMatchObject({ kind: "zero_conversation", lifetime: { zeroConversation: true }, window: { ratio: null } });
  });

  it("builds history before judging: the first scan is warming, not clear and not a finding", () => {
    digest({ total: 500, conv: 1 }); detector.scan();
    const snap = detector.snapshot();
    expect(snap.findings).toHaveLength(0);
    expect(snap.warming).toBe(1);
    expect(snap.coverage.status).toBe("complete");
  });

  it("keeps one episode while the anomaly lasts and closes it on recovery", () => {
    runWindow({ total: 100, conv: 10 }, { total: 180, conv: 11 });
    const first = detector.snapshot().findings[0]!;
    advance(5 * MIN); digest({ total: 200, conv: 11 }); detector.scan();
    expect(detector.snapshot().findings.map((f) => f.episodeId)).toEqual([first.episodeId]);
    advance(31 * MIN); digest({ total: 205, conv: 14 }); detector.scan();
    const after = detector.snapshot();
    expect(after.findings).toHaveLength(0);
    expect(after.recentlyClosed[0]).toMatchObject({ episodeId: first.episodeId, reason: "recovered" });
  });

  it("closes the episode when the seat's session is replaced, and does not carry it to the new session", () => {
    runWindow({ total: 100, conv: 10 }, { total: 180, conv: 11 });
    advance(MIN);
    digest({ native: "native-2", gen: "gen-B", total: 3, conv: 1 }); detector.scan();
    const snap = detector.snapshot();
    expect(snap.findings).toHaveLength(0);
    expect(snap.recentlyClosed[0]).toMatchObject({ reason: "subject_replaced" });
  });

  it("keeps the seat's current tenure when an older transcript is re-ingested later", () => {
    db.pragma("foreign_keys = OFF");
    db.prepare(`INSERT INTO occupant_tenures (id, node_id, generation_ordinal, generation_uuid, kind) VALUES ('t1', 'node-1', 1, 'gen-OLD', 'initial'), ('t2', 'node-1', 2, 'gen-A', 'handover')`).run();
    digest({ total: 100, conv: 10 });
    digest({ native: "native-old", gen: "gen-OLD", total: 900, conv: 300 });
    db.prepare(`UPDATE session_digests SET node_id = 'node-1'`).run();
    detector.scan();
    advance(31 * MIN);
    digest({ total: 180, conv: 11 });
    digest({ native: "native-old", gen: "gen-OLD", total: 900, conv: 300 }); // re-ingest: newest ingested_at
    detector.scan();
    const snap = detector.snapshot();
    expect(snap.findings).toHaveLength(1);
    expect(snap.findings[0]!.subject).toEqual({ nativeSessionId: "native-1", generation: "gen-A" });
    expect(snap.recentlyClosed).toHaveLength(0);
  });

  it("restarts history on a decrease that stays above the window baseline (180 after 200, baseline 100)", () => {
    runWindow({ total: 100, conv: 10 }, { total: 200, conv: 11 });
    expect(detector.snapshot().findings).toHaveLength(1);
    advance(MIN);
    digest({ total: 180, conv: 11 }); detector.scan();
    const snap = detector.snapshot();
    expect(snap.findings).toHaveLength(0);
    expect(snap.recentlyClosed[0]).toMatchObject({ reason: "counter_reset" });
    expect(snap.warming).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) AS c FROM turn_anomaly_samples`).get() as { c: number }).c).toBe(1);
  });

  it("rejects an expired baseline after a scan gap instead of reporting hours as one window", () => {
    digest({ total: 100, conv: 10 }); detector.scan();
    advance(3 * 60 * MIN);
    digest({ total: 400, conv: 11 }); detector.scan();
    const snap = detector.snapshot();
    expect(snap.findings).toHaveLength(0);
    expect(snap.warming).toBe(1);
    // History restarted from the current reading, so the next window judges only what follows the gap.
    advance(31 * MIN);
    digest({ total: 480, conv: 12 }); detector.scan();
    expect(detector.snapshot().findings[0]).toMatchObject({ kind: "high_ratio", window: { assistantTurns: 80 } });
  });

  it("reports coverage and warming for the requested rig only", () => {
    digest({ total: 10, conv: 5 });
    digest({ native: "native-b", seat: "dev-impl@alpha2", rig: "alpha2", total: 10, conv: 5 });
    detector.scan();
    expect(detector.snapshot().coverage).toMatchObject({ status: "complete", examined: 2 });
    expect(detector.snapshot({ rigNames: ["openrig"] })).toMatchObject({ warming: 1, coverage: { status: "complete", examined: 1 } });
    const beta = detector.snapshot({ rigNames: ["beta"] });
    expect(beta.warming).toBe(0);
    expect(beta.coverage).toMatchObject({ status: "partial", examined: 0 });
    expect(beta.coverage.reason).toMatch(/this rig/);
  });

  it("closes the episode when the digest stops refreshing", () => {
    runWindow({ total: 100, conv: 10 }, { total: 180, conv: 11 });
    advance(61 * MIN); detector.scan();
    expect(detector.snapshot().findings).toHaveLength(0);
    expect(detector.snapshot().recentlyClosed[0]).toMatchObject({ reason: "digest_stale" });
    expect(detector.snapshot().coverage.status).toBe("partial");
  });

  it("persists episodes across a detector restart", () => {
    runWindow({ total: 100, conv: 10 }, { total: 180, conv: 11 });
    const reborn = new TurnAnomalyDetector({ db, now: () => new Date(clock) });
    expect(reborn.snapshot().findings).toHaveLength(1);
    reborn.scan();
    expect(reborn.snapshot().findings).toHaveLength(1);
  });

  it("corroborates with reducer stall signals inside the window only", () => {
    const stall = [
      { type: "read-storm", turnRange: [2, 9], details: { path: "/old", count: 6, severity: "warn" } },
      { type: "retry-loop", turnRange: [120, 150], details: { tool: "Bash", count: 4 } },
    ];
    runWindow({ total: 100, conv: 10 }, { total: 180, conv: 11, stall } as never);
    const f = detector.snapshot().findings[0]!;
    expect(f.corroboration.map((c) => c.type)).toEqual(["retry-loop"]);
  });

  it("filters the snapshot by rig and treats a digest from another rig as out of scope", () => {
    runWindow({ total: 100, conv: 10 }, { total: 180, conv: 11 });
    expect(detector.snapshot({ rigNames: ["openrig"] }).findings).toHaveLength(1);
    expect(detector.snapshot({ rigNames: ["other"] }).findings).toHaveLength(0);
  });

  it("reports unavailable coverage, not clear, when the database carries no fleet-store tables", () => {
    const bare = new Database(":memory:");
    try {
      migrate(bare, ALL_MIGRATIONS);
      const d = new TurnAnomalyDetector({ db: bare, now: () => new Date(clock) });
      d.scan();
      expect(d.snapshot().coverage).toMatchObject({ status: "unavailable", examined: 0 });
      expect(d.snapshot().coverage.reason).toMatch(/session_digests/);
    } finally { bare.close(); }
  });

  it("still judges a database that lacks the later stall_patterns column, without corroboration", () => {
    db.exec(`ALTER TABLE session_digests DROP COLUMN stall_patterns`);
    db.prepare(`INSERT INTO session_digests (rig_name, seat_session, seat_name, node_logical_id, native_session_id, transcript_path, total_turns, conversation_turns, tool_calls, repeated_reads, review_findings, handoff_events, claude_md_loaded, errors, irreversible_actions, compaction_boundaries, compaction_losses, ingested_at) VALUES ('openrig','dev-impl@openrig','dev-impl','dev.impl','n9','/t/n9',100,10,'[]','[]','[]','[]','[]','[]','[]','[]','[]',?)`).run(new Date(clock).toISOString());
    detector.scan();
    clock += 31 * MIN;
    db.prepare(`UPDATE session_digests SET total_turns = 180, conversation_turns = 11, ingested_at = ?`).run(new Date(clock).toISOString());
    detector.scan();
    expect(detector.snapshot().findings[0]).toMatchObject({ kind: "high_ratio", corroboration: [] });
  });

  it("reports unavailable coverage before the first scan and partial when the store is empty", () => {
    expect(detector.snapshot().coverage.status).toBe("unavailable");
    detector.scan();
    expect(detector.snapshot().coverage).toMatchObject({ status: "partial", examined: 0 });
  });

  it("resets the baseline when the transcript counters shrink", () => {
    digest({ total: 400, conv: 20 }); detector.scan();
    advance(31 * MIN);
    digest({ total: 40, conv: 2 }); detector.scan();
    expect(detector.snapshot().findings).toHaveLength(0);
    expect((db.prepare(`SELECT COUNT(*) AS c FROM turn_anomaly_samples WHERE native_session_id = 'native-1'`).get() as { c: number }).c).toBe(1);
  });
});

describe("turn-anomaly: watchdog policy", () => {
  let db: Database.Database;
  let clock = T0;
  let detector: TurnAnomalyDetector;

  const job = (over: Partial<PolicyJob> = {}): PolicyJob => ({
    jobId: "job-1", policy: "turn-anomaly", target: { session: "orch-lead@openrig" }, intervalSeconds: 300,
    activeWakeIntervalSeconds: null, scanIntervalSeconds: null, context: {}, lastEvaluationAt: null, lastFireAt: null,
    registeredBySession: "orch-lead@openrig", registeredAt: "2026-10-24T00:00:00Z", watchedFilePath: null, thresholdBytes: null,
    thresholdTokens: null, thresholdPercent: null, contextUsageSample: null, requiresJobId: null, lastFiredGeneration: null,
    lastFiredCondition: null, occupantGeneration: "recipient-gen", currentGenerationTranscriptPending: false,
    requiredReceiptSatisfied: false, requiredReceiptDeferred: false, ...over,
  });
  const put = (total: number, conv: number) => {
    const at = new Date(clock).toISOString();
    if (db.prepare(`SELECT 1 FROM session_digests`).get()) {
      db.prepare(`UPDATE session_digests SET total_turns = ?, conversation_turns = ?, ingested_at = ?`).run(total, conv, at);
    } else {
      db.prepare(`
        INSERT INTO session_digests (rig_name, seat_session, seat_name, node_logical_id, native_session_id, generation_uuid, transcript_path,
          total_turns, conversation_turns, tool_calls, repeated_reads, review_findings, handoff_events, claude_md_loaded, errors,
          irreversible_actions, compaction_boundaries, compaction_losses, ingested_at)
        VALUES ('openrig','dev-impl@openrig','dev-impl','dev.impl','native-1','subject-gen','/t/a.jsonl',?,?,'[]','[]','[]','[]','[]','[]','[]','[]','[]',?)
      `).run(total, conv, at);
    }
  };

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, [...ALL_MIGRATIONS, sessionDigestsSchema, digestStallPatternsSchema]);
    clock = T0;
    detector = new TurnAnomalyDetector({ db, now: () => new Date(clock) });
  });
  afterEach(() => db.close());

  const openAnomaly = () => {
    put(100, 10); detector.scan();
    clock += 31 * MIN;
    put(180, 11);
  };

  it("skips quietly when nothing is anomalous", async () => {
    put(10, 5);
    const out = await makeTurnAnomalyPolicy({ detector }).evaluate(job());
    expect(out).toMatchObject({ action: "skip", reason: "no_turn_anomaly" });
  });

  it("sends an advisory notice to the job target and keeps the watched subject separate from the recipient", async () => {
    openAnomaly();
    const out = await makeTurnAnomalyPolicy({ detector }).evaluate(job());
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.target).toEqual({ session: "orch-lead@openrig" });
    expect(out.message).toContain("dev-impl@openrig");
    expect(out.message).toContain("80.0:1");
    expect(out.message).toMatch(/Advisory only/);
    expect(out.conditionReceipt).toBeTruthy();
    const notes = out.notes as { findings: Array<{ subject: { generation: string } }>; recipientGeneration: string };
    expect(notes.findings[0]!.subject.generation).toBe("subject-gen");
    expect(notes.recipientGeneration).toBe("recipient-gen");
  });

  it("tells the recipient again only when the episode set changes", async () => {
    openAnomaly();
    const policy = makeTurnAnomalyPolicy({ detector });
    const first = await policy.evaluate(job());
    if (first.action !== "send") throw new Error("expected send");
    const again = await policy.evaluate(job({ lastFiredCondition: first.conditionReceipt! }));
    expect(again).toMatchObject({ action: "skip", reason: "turn_anomaly_unchanged" });
  });

  it("tells a replaced recipient again even though the episode set is unchanged", async () => {
    openAnomaly();
    const policy = makeTurnAnomalyPolicy({ detector });
    const first = await policy.evaluate(job({ occupantGeneration: "R1" }));
    if (first.action !== "send") throw new Error("expected send");
    const same = await policy.evaluate(job({ occupantGeneration: "R1", lastFiredCondition: first.conditionReceipt! }));
    expect(same).toMatchObject({ action: "skip", reason: "turn_anomaly_unchanged" });
    const replaced = await policy.evaluate(job({ occupantGeneration: "R2", lastFiredCondition: first.conditionReceipt! }));
    expect(replaced.action).toBe("send");
  });

  it("rejects a job without a delivery target", async () => {
    await expect(makeTurnAnomalyPolicy({ detector }).evaluate(job({ target: { session: "" } })))
      .rejects.toMatchObject({ code: "policy_spec_invalid" });
  });

  it("never modifies the watched digest (advisory only)", async () => {
    openAnomaly();
    const before = JSON.stringify(db.prepare(`SELECT * FROM session_digests`).all());
    await makeTurnAnomalyPolicy({ detector }).evaluate(job());
    expect(JSON.stringify(db.prepare(`SELECT * FROM session_digests`).all())).toBe(before);
  });
});
