// RIG-120 — the operational summary composes existing projections and never reports an
// incomplete join as healthy. Three concepts stay apart: terminal input needed (seat),
// human gate (queue), stalled work (queue).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import type { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { STUCK_DETECTORS, type StuckFinding, type StuckSeatObserver, type StuckSeatSnapshot } from "../src/domain/stuck-seat-observer.js";
import {
  computeOperationalSummary,
  OPERATIONAL_QUEUE_LIMIT,
  UnknownRigError,
  type OperationalSummary,
} from "../src/domain/operational-summary.js";

const NOW = new Date("2026-10-21T22:00:00Z");

describe("operational summary (RIG-120)", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let registry: SessionRegistry;
  let queueRepo: QueueRepository;
  let watchdogRepo: WatchdogJobsRepository;
  /** session name -> arbitrated state the (stub) oracle returns */
  let oracle: Map<string, { activity: string; needsInput: { count: number; reason: string | null } }>;

  const seatActivity = (): SeatActivityService => ({
    getSeatActivity: () => null,
    getSeatStateBySession: (session: string) => {
      const s = oracle.get(session);
      return s ? { activity: s.activity, needsInput: s.needsInput, decidedBy: "test", seq: 1, lastSwap: null } : null;
    },
  } as unknown as SeatActivityService);

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
    registry = new SessionRegistry(db);
    queueRepo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    watchdogRepo = new WatchdogJobsRepository(db);
    oracle = new Map();
  });
  afterEach(() => db.close());

  function seat(logicalId: string, rigName: string, state?: { activity: string; needs?: number; reason?: string | null }) {
    const rig = rigRepo.findUnarchivedRigsByName(rigName)[0] ?? rigRepo.createRig(rigName);
    const node = rigRepo.addNode(rig.id, logicalId, { runtime: "claude-code" });
    const sessionName = `${logicalId.replace(".", "-")}@${rigName}`;
    const session = registry.registerSession(node.id, sessionName);
    registry.updateStatus(session.id, "running");
    registry.updateStartupStatus(session.id, "ready");
    if (state) oracle.set(sessionName, { activity: state.activity, needsInput: { count: state.needs ?? 0, reason: state.reason ?? null } });
    return sessionName;
  }

  /** A fresh, evaluated watchdog job so the watchdog source is complete. */
  function freshWatchdog(target = "dev-impl@alpha", evaluatedAt = new Date(NOW.getTime() - 30_000).toISOString()) {
    const job = watchdogRepo.register({ policy: "periodic-reminder", specYaml: "message: ping", targetSession: target, intervalSeconds: 60, registeredBySession: target });
    watchdogRepo.recordEvaluation(job.jobId, evaluatedAt, false);
    return job;
  }

  async function claimedRow(destination: string, minutesAgo: number) {
    const row = await queueRepo.create({ sourceSession: "orch-lead@alpha", destinationSession: destination, body: "work", summary: "do the work", evidenceRef: "docs/work.md" } as never);
    queueRepo.claim({ qitemId: row.qitemId, destinationSession: destination });
    const past = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const before = new Date(Date.now() - (minutesAgo + 1) * 60_000).toISOString();
    db.prepare("UPDATE queue_items SET claimed_at = ?, ts_created = ? WHERE qitem_id = ?").run(past, before, row.qitemId);
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ? AND transition_note = 'claimed'").run(past, row.qitemId);
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ? AND transition_note = 'created'").run(before, row.qitemId);
    return row;
  }

  async function humanBlockedRow(owner: string, human = "human-review@kernel") {
    const row = await queueRepo.create({ sourceSession: "orch-lead@alpha", destinationSession: owner, body: "needs a decision", summary: "approve the plan", evidenceRef: "docs/plan.md" } as never);
    queueRepo.claim({ qitemId: row.qitemId, destinationSession: owner });
    queueRepo.update({ qitemId: row.qitemId, actorSession: owner, state: "blocked", blockedOn: human, transitionNote: "waiting for approval" });
    return row;
  }

  /** RIG-123 — a stuck-seat observer whose last scan was clean and complete, so RIG-120 cases stay about their own sources. */
  const stuckStub = (over: Partial<StuckSeatSnapshot> = {}): Pick<StuckSeatObserver, "snapshot"> => ({
    snapshot: () => ({
      scannedAt: NOW.toISOString(), findings: [], recentlyClosed: [],
      coverage: STUCK_DETECTORS.map((detector) => ({ detector, status: "complete" as const, examined: 1 })),
      ...over,
    }),
  });
  const summarize = (extra: Partial<Parameters<typeof computeOperationalSummary>[0]> = {}): OperationalSummary =>
    computeOperationalSummary({ rigRepo, queueRepo, watchdogRepo, seatActivity: seatActivity(), stuckSeats: stuckStub(), now: NOW, ...extra });
  const cov = (s: OperationalSummary, source: string) => s.coverage.find((c) => c.source === source)!;

  it("reads terminal input from the node inventory oracle, not from queue rows", async () => {
    seat("dev.impl", "alpha", { activity: "idle-at-prompt", needs: 2, reason: "permission prompt" });
    seat("dev.qa", "alpha", { activity: "working" });
    freshWatchdog();
    const s = summarize();
    expect(s.terminalInput.count).toBe(1);
    expect(s.terminalInput.seats[0]).toMatchObject({ logicalId: "dev.impl", count: 2, reason: "permission prompt" });
    // No queue row exists, so a queue-derived count would be zero.
    expect(s.humanGates.count).toBe(0);
    expect(s.verdict).toBe("attention");
  });

  it("lists a human-blocked row as a human gate with its summary and evidence, and not as stalled work", async () => {
    seat("dev.impl", "alpha", { activity: "working" });
    const row = await humanBlockedRow("dev-impl@alpha");
    freshWatchdog();
    const s = summarize();
    expect(s.humanGates.count).toBe(1);
    expect(s.humanGates.items[0]).toMatchObject({ qitemId: row.qitemId, state: "blocked", blockedOn: "human-review@kernel", summary: "approve the plan", evidenceRef: "docs/plan.md" });
    expect(s.stalledWork.count).toBe(0);
    expect(s.terminalInput.count).toBe(0);
  });

  it("lists a claimed row with no meaningful change as stalled work, and not as a human gate", async () => {
    seat("dev.impl", "alpha", { activity: "working" });
    const row = await claimedRow("dev-impl@alpha", 60);
    freshWatchdog();
    const s = summarize();
    expect(s.stalledWork.count).toBe(1);
    expect(s.stalledWork.items[0]).toMatchObject({ qitemId: row.qitemId, owner: "dev-impl@alpha" });
    expect(s.stalledWork.items[0]!.evidence).toMatch(/no meaningful queue change/);
    expect(s.humanGates.count).toBe(0);
  });

  it("a stalled row owed to a human seat is a human gate only, never also stalled work", async () => {
    seat("dev.impl", "alpha", { activity: "working" });
    await claimedRow("human-review@kernel", 60);
    freshWatchdog();
    const s = summarize();
    expect(s.humanGates.count).toBe(1);
    expect(s.stalledWork.count).toBe(0);
  });

  it("keeps the three concepts distinct when all three hold at once", async () => {
    seat("dev.impl", "alpha", { activity: "idle-at-prompt", needs: 1, reason: "login prompt" });
    seat("dev.qa", "alpha", { activity: "working" });
    await humanBlockedRow("dev-qa@alpha");
    await claimedRow("dev-impl@alpha", 90);
    freshWatchdog();
    const s = summarize();
    expect([s.terminalInput.count, s.humanGates.count, s.stalledWork.count]).toEqual([1, 1, 1]);
    const ids = [...s.humanGates.items.map((i) => i.qitemId), ...s.stalledWork.items.map((i) => i.qitemId)];
    expect(new Set(ids).size).toBe(2);
  });

  it("scopes every source to one rig by name or by id", async () => {
    seat("dev.impl", "alpha", { activity: "idle-at-prompt", needs: 1 });
    seat("dev.impl", "beta", { activity: "idle-at-prompt", needs: 1 });
    await humanBlockedRow("dev-impl@alpha");
    await humanBlockedRow("dev-impl@beta");
    await claimedRow("dev-impl@beta", 60);
    freshWatchdog("dev-impl@alpha");
    const all = summarize();
    expect([all.seats.total, all.terminalInput.count, all.humanGates.count, all.stalledWork.count]).toEqual([2, 2, 2, 1]);
    expect(all.scope).toEqual({ kind: "daemon", rig: null, hosts: "this-daemon-only" });

    const alpha = summarize({ rig: "alpha" });
    expect(alpha.scope).toEqual({ kind: "rig", rig: "alpha", hosts: "this-daemon-only" });
    expect([alpha.seats.total, alpha.terminalInput.count, alpha.humanGates.count, alpha.stalledWork.count]).toEqual([1, 1, 1, 0]);
    expect(alpha.watchdog?.activeJobs).toBe(1);

    const betaId = rigRepo.findUnarchivedRigsByName("beta")[0]!.id;
    const beta = summarize({ rig: betaId });
    expect([beta.seats.total, beta.humanGates.count, beta.stalledWork.count]).toEqual([1, 1, 1]);
    expect(beta.watchdog?.activeJobs).toBe(0);
  });

  it("rejects an unknown rig instead of returning an empty (healthy-looking) summary", () => {
    seat("dev.impl", "alpha", { activity: "working" });
    expect(() => summarize({ rig: "nope" })).toThrow(UnknownRigError);
  });

  it("reads clear only when every source is complete and every count is zero", () => {
    seat("dev.impl", "alpha", { activity: "working" });
    freshWatchdog();
    const s = summarize();
    expect(s.coverage.every((c) => c.status === "complete")).toBe(true);
    expect(s.verdict).toBe("clear");
    expect(s.observedAt).toBe(NOW.toISOString());
  });

  it("reads indeterminate, not clear, when the queue read hits its row limit", () => {
    seat("dev.impl", "alpha", { activity: "working" });
    freshWatchdog();
    const full = Array.from({ length: OPERATIONAL_QUEUE_LIMIT }, () => ({ state: "pending", destinationSession: "dev-impl@alpha", sourceSession: "x@alpha", blockedOn: null, humanIntent: "update" }));
    const truncated = { listAttention: () => full, list: () => [] } as unknown as QueueRepository;
    const s = summarize({ queueRepo: truncated });
    expect(cov(s, "humanGates")).toMatchObject({ status: "partial", examined: OPERATIONAL_QUEUE_LIMIT, limit: OPERATIONAL_QUEUE_LIMIT });
    expect(s.verdict).toBe("indeterminate");
  });

  it("reads indeterminate when the in-progress read hits its row limit", () => {
    seat("dev.impl", "alpha", { activity: "working" });
    freshWatchdog();
    const rows = Array.from({ length: OPERATIONAL_QUEUE_LIMIT }, () => ({ state: "in-progress", pickup: { state: "working" }, destinationSession: "dev-impl@alpha", sourceSession: "x@alpha", blockedOn: null }));
    const truncated = { listAttention: () => [], list: () => rows } as unknown as QueueRepository;
    const s = summarize({ queueRepo: truncated });
    expect(cov(s, "stalledWork").status).toBe("partial");
    expect(s.verdict).toBe("indeterminate");
  });

  it("reads indeterminate when the watchdog repository is missing", () => {
    seat("dev.impl", "alpha", { activity: "working" });
    const s = summarize({ watchdogRepo: undefined });
    expect(s.watchdog).toBeNull();
    expect(cov(s, "watchdog").status).toBe("unavailable");
    expect(s.verdict).toBe("indeterminate");
  });

  it("reads indeterminate when no active watchdog job exists (silence is not evidence)", () => {
    seat("dev.impl", "alpha", { activity: "working" });
    const s = summarize();
    expect(cov(s, "watchdog")).toMatchObject({ status: "partial", examined: 0 });
    expect(s.verdict).toBe("indeterminate");
  });

  it("reads indeterminate when a watchdog job is stale or was never evaluated", () => {
    seat("dev.impl", "alpha", { activity: "working" });
    freshWatchdog("dev-impl@alpha", new Date(NOW.getTime() - 60 * 60_000).toISOString()); // 60 min old, 60 s interval
    const stale = summarize();
    expect(stale.watchdog?.stale).toHaveLength(1);
    expect(stale.verdict).toBe("indeterminate");

    db.exec("DELETE FROM watchdog_jobs");
    watchdogRepo.register({ policy: "periodic-reminder", specYaml: "message: ping", targetSession: "dev-impl@alpha", intervalSeconds: 60, registeredBySession: "dev-impl@alpha" });
    const never = summarize();
    expect(never.watchdog).toMatchObject({ activeJobs: 1, neverEvaluated: 1, newestEvaluationAt: null });
    expect(never.verdict).toBe("indeterminate");
  });

  it("reads indeterminate when the activity oracle is not wired or has no state for a running seat", () => {
    seat("dev.impl", "alpha"); // running, no oracle state
    freshWatchdog();
    const noState = summarize();
    expect(cov(noState, "terminalInput").status).toBe("partial");
    expect(noState.verdict).toBe("indeterminate");

    const noOracle = summarize({ seatActivity: undefined });
    expect(cov(noOracle, "terminalInput").status).toBe("unavailable");
    expect(noOracle.verdict).toBe("indeterminate");
  });

  it("reads indeterminate when the queue repository is missing", () => {
    seat("dev.impl", "alpha", { activity: "working" });
    freshWatchdog();
    const s = summarize({ queueRepo: undefined });
    expect(cov(s, "humanGates").status).toBe("unavailable");
    expect(cov(s, "stalledWork").status).toBe("unavailable");
    expect(s.verdict).toBe("indeterminate");
  });

  it("a finding wins over an incomplete source: attention, with the gap still reported", async () => {
    seat("dev.impl", "alpha", { activity: "working" });
    await humanBlockedRow("dev-impl@alpha");
    const s = summarize({ watchdogRepo: undefined });
    expect(s.verdict).toBe("attention");
    expect(cov(s, "watchdog").status).toBe("unavailable");
  });

  it("an attention_required seat alone is a finding: verdict is attention, never clear", () => {
    seat("dev.impl", "alpha", { activity: "working" });
    const bad = seat("dev.qa", "alpha", { activity: "working" });
    const sessionId = (db.prepare("SELECT id FROM sessions WHERE session_name = ?").get(bad) as { id: string }).id;
    registry.updateStartupStatus(sessionId, "attention_required");
    freshWatchdog();
    const s = summarize();
    expect(s.seats.attentionRequired).toBe(1);
    expect([s.terminalInput.count, s.humanGates.count, s.stalledWork.count]).toEqual([0, 0, 0]);
    expect(s.coverage.every((c) => c.status === "complete")).toBe(true);
    expect(s.verdict).toBe("attention");
  });

  it("an empty daemon with a fresh watchdog is clear only because every source was read", () => {
    freshWatchdog();
    const s = summarize();
    expect(s.seats.total).toBe(0);
    expect(s.verdict).toBe("clear");
  });

  describe("stuck-seat section (RIG-123)", () => {
    const finding = (over: Partial<StuckFinding> = {}): StuckFinding => ({
      episodeId: "permission_blocked:dev-impl@alpha:1", kind: "permission_blocked", rig: "alpha", logicalId: "dev.impl",
      session: "dev-impl@alpha", confidence: "confirmed", openedAt: NOW.toISOString(), lastObservedAt: NOW.toISOString(),
      stale: false, detail: "permission prompt confirmed by the activity oracle", ...over,
    });

    it("projects cached findings and any finding makes the verdict attention", () => {
      freshWatchdog();
      seat("dev.impl", "alpha", { activity: "idle-at-prompt" });
      const s = summarize({ stuckSeats: stuckStub({ findings: [finding()] }) });
      expect(s.stuckSeats).toMatchObject({ count: 1, findings: [{ kind: "permission_blocked", confidence: "confirmed" }] });
      expect(s.verdict).toBe("attention");
    });

    it("exposes one coverage entry per detector", () => {
      freshWatchdog();
      const s = summarize();
      expect(s.coverage.map((c) => c.source).filter((x) => x.startsWith("stuckSeats:")).sort()).toEqual([
        "stuckSeats:idle_with_expected_work", "stuckSeats:permission_blocked", "stuckSeats:persistent_composer_input",
      ]);
    });

    it("incomplete detector coverage without findings is indeterminate, not clear", () => {
      freshWatchdog();
      const s = summarize({ stuckSeats: stuckStub({ coverage: [
        { detector: "permission_blocked", status: "complete", examined: 3 },
        { detector: "persistent_composer_input", status: "partial", examined: 2, reason: "1 seat(s) not observed: composer not readable" },
        { detector: "idle_with_expected_work", status: "complete", examined: 3 },
      ] }) });
      expect(s.stuckSeats?.count).toBe(0);
      expect(cov(s, "stuckSeats:persistent_composer_input")).toMatchObject({ status: "partial" });
      expect(s.verdict).toBe("indeterminate");
    });

    it("an unwired observer reports unavailable coverage (indeterminate), not a healthy fleet", () => {
      freshWatchdog();
      const s = summarize({ stuckSeats: undefined });
      expect(s.stuckSeats).toBeNull();
      expect(cov(s, "stuckSeats:permission_blocked")).toMatchObject({ status: "unavailable" });
      expect(s.verdict).toBe("indeterminate");
    });

    it("a --rig summary asks the observer for that rig's findings only", () => {
      freshWatchdog();
      seat("dev.impl", "alpha", { activity: "idle-at-prompt" });
      let scope: ReadonlySet<string> | undefined;
      summarize({ rig: "alpha", stuckSeats: { snapshot: (o) => { scope = o?.rigNames; return stuckStub().snapshot(); } } });
      expect([...scope!]).toEqual(["alpha"]);
    });

    it("reads the cache only: the summary never calls scan", () => {
      freshWatchdog();
      const calls: string[] = [];
      const observer = { snapshot: () => { calls.push("snapshot"); return stuckStub().snapshot(); }, scan: () => { calls.push("scan"); } };
      summarize({ stuckSeats: observer as never });
      expect(calls).toEqual(["snapshot"]);
    });
  });
});
