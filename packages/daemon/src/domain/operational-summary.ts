// RIG-120 — one read-only operational summary joined from projections that already exist.
// No new data plumbing: seats and terminal input come from node inventory (the needsInput
// arbitration oracle), human gates from QueueRepository.listAttention, stalled work from the
// derived `pickup` receipt (derivePickup), watchdog freshness from the watchdog jobs table.
// Three concepts stay separate: terminal input needed (seat), human gate (queue), stalled work
// (queue). An unread or truncated source never reads as healthy: the verdict is `indeterminate`.
import type { RigRepository } from "./rig-repository.js";
import type { QueueRepository } from "./queue-repository.js";
import { hasLiveHumanGate } from "./queue-repository.js";
import type { WatchdogJobsRepository } from "./watchdog-jobs-repository.js";
import type { SeatActivityService } from "./seat-activity-service.js";
import type { ClosedEpisode, StuckFinding, StuckSeatObserver } from "./stuck-seat-observer.js";
import { isHumanSeatSessionRef } from "./session-name.js";
import { attachTerminalActivityAndWork, getNodeInventoryForRigs } from "./node-inventory.js";

export const OPERATIONAL_SUMMARY_SCHEMA = "openrig.health-operational/v0alpha1" as const;

/** Rows read per queue source. A source that returns this many rows is reported as truncated. */
export const OPERATIONAL_QUEUE_LIMIT = 500;
/** A watchdog job is stale when its last evaluation is older than this many of its own intervals. */
export const WATCHDOG_STALE_INTERVALS = 3;

export type SourceStatus = "complete" | "partial" | "unavailable";
export type OperationalVerdict = "attention" | "clear" | "indeterminate";

export interface CoverageEntry {
  source: "seats" | "terminalInput" | "humanGates" | "stalledWork" | "watchdog"
    | "stuckSeats:permission_blocked" | "stuckSeats:persistent_composer_input" | "stuckSeats:idle_with_expected_work";
  status: SourceStatus;
  examined: number;
  /** Row cap of the source read, when it has one. */
  limit?: number;
  /** Why the join is not complete. Present only when status is not complete. */
  reason?: string;
}

export interface OperationalSummary {
  schema: typeof OPERATIONAL_SUMMARY_SCHEMA;
  observedAt: string;
  scope: { kind: "daemon" | "rig"; rig: string | null; hosts: "this-daemon-only" };
  seats: { total: number; bySessionStatus: Record<string, number>; byLifecycle: Record<string, number>; attentionRequired: number };
  terminalInput: { count: number; seats: Array<{ rig: string; logicalId: string; session: string | null; count: number; reason: string | null }> };
  humanGates: { count: number; items: Array<{ qitemId: string; state: string; destination: string; blockedOn: string | null; summary: string | null; evidenceRef: string | null; updatedAt: string }> };
  stalledWork: { count: number; items: Array<{ qitemId: string; owner: string; evidence: string | null; updatedAt: string }> };
  watchdog: {
    activeJobs: number;
    newestEvaluationAt: string | null;
    neverEvaluated: number;
    stale: Array<{ jobId: string; policy: string; target: string; lastEvaluationAt: string | null; intervalSeconds: number }>;
  } | null;
  /** RIG-123 — cached stuck-seat findings from the independent observer. Null when the observer is not wired. */
  stuckSeats: { count: number; scannedAt: string | null; findings: StuckFinding[]; recentlyClosed: ClosedEpisode[] } | null;
  coverage: CoverageEntry[];
  verdict: OperationalVerdict;
}

export interface OperationalSummaryDeps {
  rigRepo: RigRepository;
  queueRepo?: QueueRepository;
  watchdogRepo?: WatchdogJobsRepository;
  seatActivity?: SeatActivityService;
  /** Cached findings only: the summary reads `snapshot()` and never triggers a scan. */
  stuckSeats?: Pick<StuckSeatObserver, "snapshot">;
  /** Rig name or id. Omitted = every unarchived rig on this daemon. */
  rig?: string;
  now?: Date;
}

export class UnknownRigError extends Error {
  constructor(public readonly rig: string) {
    super(`rig not found: ${rig}`);
    this.name = "UnknownRigError";
  }
}

function endsWithRig(session: string | null | undefined, names: ReadonlySet<string>): boolean {
  if (!session) return false;
  const at = session.lastIndexOf("@");
  return at >= 0 && names.has(session.slice(at + 1));
}

/** The seat that owns the work behind a row: the destination, or the source when the row is owed to a human. */
function owningSession(q: { destinationSession: string; sourceSession: string }): string {
  return isHumanSeatSessionRef(q.destinationSession) ? q.sourceSession : q.destinationSession;
}

export function computeOperationalSummary(deps: OperationalSummaryDeps): OperationalSummary {
  const now = deps.now ?? new Date();
  const db = deps.rigRepo.db;
  const allRigs = deps.rigRepo.listRigs();
  const rigs = deps.rig ? allRigs.filter((r) => r.id === deps.rig || r.name === deps.rig) : allRigs;
  if (deps.rig && rigs.length === 0) throw new UnknownRigError(deps.rig);
  const rigNames = new Set(rigs.map((r) => r.name));
  const scoped = Boolean(deps.rig);
  const coverage: CoverageEntry[] = [];

  // Seats and terminal input: node inventory, with the arbitrated activity oracle attached.
  const rigIds = new Set(rigs.map((r) => r.id));
  const byRig = getNodeInventoryForRigs(db, rigIds);
  const seatsList = [...byRig.values()].flat();
  const bySessionStatus: Record<string, number> = {};
  const byLifecycle: Record<string, number> = {};
  let attentionRequired = 0;
  for (const node of seatsList) {
    const status = node.sessionStatus ?? "unknown";
    bySessionStatus[status] = (bySessionStatus[status] ?? 0) + 1;
    const lifecycle = (node as { lifecycleState?: string }).lifecycleState ?? "unknown";
    byLifecycle[lifecycle] = (byLifecycle[lifecycle] ?? 0) + 1;
    if (lifecycle === "attention_required") attentionRequired++;
  }
  coverage.push({ source: "seats", status: "complete", examined: seatsList.length });

  const terminalSeats: OperationalSummary["terminalInput"]["seats"] = [];
  if (deps.seatActivity) {
    const withActivity = attachTerminalActivityAndWork(seatsList, { db, seatActivity: deps.seatActivity });
    let unobserved = 0;
    let agentSeats = 0;
    for (const node of withActivity) {
      if (node.nodeKind !== "agent") continue;
      agentSeats++;
      const needs = node.activityState?.needsInput;
      if (needs && needs.count > 0) {
        terminalSeats.push({ rig: node.rigName, logicalId: node.logicalId, session: node.canonicalSessionName, count: needs.count, reason: needs.reason });
      } else if (node.sessionStatus === "running" && !node.activityState) {
        // A running seat the oracle has no state for is unknown, not "no input needed".
        unobserved++;
      }
    }
    coverage.push(unobserved > 0
      ? { source: "terminalInput", status: "partial", examined: agentSeats - unobserved, reason: `${unobserved} running seat(s) have no arbitrated activity state` }
      : { source: "terminalInput", status: "complete", examined: agentSeats });
  } else {
    coverage.push({ source: "terminalInput", status: "unavailable", examined: 0, reason: "seat activity service is not wired" });
  }

  // Human gates and stalled work: queue projections.
  const gateItems: OperationalSummary["humanGates"]["items"] = [];
  const stalledItems: OperationalSummary["stalledWork"]["items"] = [];
  if (deps.queueRepo) {
    const attention = deps.queueRepo.listAttention({ limit: OPERATIONAL_QUEUE_LIMIT });
    const gates = attention.filter((q) => hasLiveHumanGate(q)
      && (!scoped || endsWithRig(owningSession(q), rigNames)));
    for (const q of gates) {
      gateItems.push({
        qitemId: q.qitemId, state: q.state, destination: q.destinationSession, blockedOn: q.blockedOn,
        summary: q.summary ?? null, evidenceRef: q.evidenceRef ?? null, updatedAt: q.tsUpdated,
      });
    }
    coverage.push(attention.length >= OPERATIONAL_QUEUE_LIMIT
      ? { source: "humanGates", status: "partial", examined: attention.length, limit: OPERATIONAL_QUEUE_LIMIT, reason: "the attention read hit its row limit; more gates may exist" }
      : { source: "humanGates", status: "complete", examined: attention.length, limit: OPERATIONAL_QUEUE_LIMIT });

    const claimed = deps.queueRepo.list({ state: "in-progress", limit: OPERATIONAL_QUEUE_LIMIT, });
    for (const q of claimed) {
      if (q.pickup?.state !== "stalled-after-claim") continue;
      // A row owed to a human is a human gate, not stalled work: keep the concepts apart.
      if (hasLiveHumanGate(q)) continue;
      if (scoped && !endsWithRig(owningSession(q), rigNames)) continue;
      stalledItems.push({ qitemId: q.qitemId, owner: q.destinationSession, evidence: q.pickup.evidence ?? null, updatedAt: q.tsUpdated });
    }
    coverage.push(claimed.length >= OPERATIONAL_QUEUE_LIMIT
      ? { source: "stalledWork", status: "partial", examined: claimed.length, limit: OPERATIONAL_QUEUE_LIMIT, reason: "the in-progress read hit its row limit; more stalled rows may exist" }
      : { source: "stalledWork", status: "complete", examined: claimed.length, limit: OPERATIONAL_QUEUE_LIMIT });
  } else {
    coverage.push({ source: "humanGates", status: "unavailable", examined: 0, reason: "queue repository is not wired" });
    coverage.push({ source: "stalledWork", status: "unavailable", examined: 0, reason: "queue repository is not wired" });
  }

  // Watchdog freshness: silence is not evidence of health.
  let watchdog: OperationalSummary["watchdog"] = null;
  if (deps.watchdogRepo) {
    const jobs = deps.watchdogRepo.listActive().filter((j) => !scoped || endsWithRig(j.targetSession, rigNames));
    let newest: string | null = null;
    let neverEvaluated = 0;
    const stale: NonNullable<OperationalSummary["watchdog"]>["stale"] = [];
    for (const job of jobs) {
      if (!job.lastEvaluationAt) {
        neverEvaluated++;
        continue;
      }
      if (!newest || job.lastEvaluationAt > newest) newest = job.lastEvaluationAt;
      const ageMs = now.getTime() - Date.parse(job.lastEvaluationAt);
      if (!Number.isFinite(ageMs) || ageMs > WATCHDOG_STALE_INTERVALS * job.intervalSeconds * 1000) {
        stale.push({ jobId: job.jobId, policy: job.policy, target: job.targetSession, lastEvaluationAt: job.lastEvaluationAt, intervalSeconds: job.intervalSeconds });
      }
    }
    watchdog = { activeJobs: jobs.length, newestEvaluationAt: newest, neverEvaluated, stale };
    if (jobs.length === 0) {
      coverage.push({ source: "watchdog", status: "partial", examined: 0, reason: "no active watchdog job; nothing proves the fleet is being watched" });
    } else if (neverEvaluated > 0 || stale.length > 0) {
      coverage.push({ source: "watchdog", status: "partial", examined: jobs.length, reason: `${stale.length} stale and ${neverEvaluated} never-evaluated active job(s)` });
    } else {
      coverage.push({ source: "watchdog", status: "complete", examined: jobs.length });
    }
  } else {
    coverage.push({ source: "watchdog", status: "unavailable", examined: 0, reason: "watchdog repository is not wired" });
  }

  // Stuck seats: a projection of the observer's cached episodes. Per-detector coverage keeps "not observed" from
  // reading as healthy: a detector without fresh evidence is partial or unavailable, so the verdict stays indeterminate.
  let stuckSeats: OperationalSummary["stuckSeats"] = null;
  if (deps.stuckSeats) {
    const snap = deps.stuckSeats.snapshot({ rigNames, ...(scoped ? { rig: deps.rig } : {}) });
    stuckSeats = {
      count: snap.findings.length,
      scannedAt: snap.scannedAt,
      findings: snap.findings,
      recentlyClosed: snap.recentlyClosed.filter((c) => endsWithRig(c.session, rigNames) || !scoped),
    };
    for (const c of snap.coverage) {
      coverage.push({ source: `stuckSeats:${c.detector}`, status: c.status === "complete" ? "complete" : c.status, examined: c.examined, ...(c.reason ? { reason: c.reason } : {}) });
    }
  } else {
    for (const detector of ["permission_blocked", "persistent_composer_input", "idle_with_expected_work"] as const) {
      coverage.push({ source: `stuckSeats:${detector}`, status: "unavailable", examined: 0, reason: "stuck-seat observer is not wired" });
    }
  }

  // An attention_required seat is a finding on its own (failed restore, startup or identity mismatch).
  const anyFinding = terminalSeats.length > 0 || gateItems.length > 0 || stalledItems.length > 0 || attentionRequired > 0
    || (stuckSeats?.count ?? 0) > 0;
  const complete = coverage.every((c) => c.status === "complete");
  const verdict: OperationalVerdict = anyFinding ? "attention" : complete ? "clear" : "indeterminate";

  return {
    schema: OPERATIONAL_SUMMARY_SCHEMA,
    observedAt: now.toISOString(),
    scope: { kind: scoped ? "rig" : "daemon", rig: scoped ? (rigs[0]?.name ?? deps.rig ?? null) : null, hosts: "this-daemon-only" },
    seats: { total: seatsList.length, bySessionStatus, byLifecycle, attentionRequired },
    terminalInput: { count: terminalSeats.length, seats: terminalSeats },
    humanGates: { count: gateItems.length, items: gateItems },
    stalledWork: { count: stalledItems.length, items: stalledItems },
    watchdog,
    stuckSeats,
    coverage,
    verdict,
  };
}
