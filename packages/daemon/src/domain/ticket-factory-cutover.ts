// RIG-89: cutover from the skill-based /factory-loop to the daemon ticket-factory.
// Owns: reconciling in-flight legacy work, the legacy claim fence that the admission path
// consults (no double-dispatch), the cutover phase, rollback, and the three separate
// completion facts. All external state (queue, GitHub, tracker, worktrees) arrives as an
// injected snapshot; this service calls none of them.

import type Database from "better-sqlite3";
import type { TicketFactoryController } from "./ticket-factory-controller.js";
import type { QueueRepository } from "./queue-repository.js";

export type CutoverPhase = "legacy" | "reconciled" | "daemon" | "rolled-back";
export type Fact = boolean | null;

const LEGACY_TERMINAL = new Set(["merged", "abandoned"]);
const LEGACY_STALE_CLAIM = new Set(["claimed", "planning"]);

export interface LegacyItem {
  ticketId: string;
  /** State from the factory-loop queue item or status file. */
  legacyState: string;
  prNumber?: number | null;
  branch?: string | null;
  hasWorktree?: boolean;
  source?: "queue" | "status-file";
}
export interface LegacyPr { ticketId: string; number: number; state: "open" | "merged" | "closed" }
export interface LegacySnapshot {
  items: LegacyItem[];
  prs: LegacyPr[];
  /** Tracker state per ticket. Missing entry means unknown. */
  tickets: Record<string, "open" | "closed" | "unknown">;
}

export type ReconcileAction =
  | "hold"            // legacy still owns it: fence the ticket
  | "release-merged"  // PR merged: legacy work is done, nothing to fence
  | "release-resolved"// tracker closed it: nothing to fence
  | "stale-claim"     // claimed/planning with no branch, PR or worktree: back to the backlog
  | "blocked";        // PR closed unmerged or lost worktree: a human decides; stays fenced

export interface ReconciledTicket {
  ticketId: string;
  legacyState: string;
  action: ReconcileAction;
  prNumber: number | null;
  facts: { workflowCompleted: Fact; prMerged: Fact; ticketResolved: Fact };
  detail: string;
}
export interface ReconcileReport { tickets: ReconciledTicket[]; held: string[] }

export interface CompletionRow {
  ticketId: string; admissionId: string | null;
  workflowCompleted: Fact; prMerged: Fact; ticketResolved: Fact; prNumber: number | null;
}

export interface TripwireResult { unexpected: string[]; doubleDispatch: string[]; paused: boolean; /** Set only when the probe threw: the tripwire failed open (warning logged, no pause). */ probeUnavailable?: true }

export interface CutoverDeps {
  db: Database.Database;
  controller: Pick<TicketFactoryController, "enable" | "pause">;
  now?: () => Date;
  /**
   * Ticket ids of factory-loop tagged queue items that are active right now and were created at or
   * after `sinceIso` (the cutover time; null when unknown). Injected. Must be read-only.
   */
  probeLegacyQueue?: (sinceIso: string | null) => Promise<string[]>;
}

export class CutoverError extends Error {}

export function classify(item: LegacyItem, prs: LegacyPr[], tickets: LegacySnapshot["tickets"]): ReconciledTicket {
  const pr = prs.filter((p) => p.ticketId === item.ticketId)
    .sort((a, b) => b.number - a.number)[0];
  const ext = tickets[item.ticketId] ?? "unknown";
  const prNumber = pr?.number ?? item.prNumber ?? null;
  const facts = {
    // Legacy "workflow completed" = the pipeline reached merge-ready or later. Not implied by a merged PR.
    workflowCompleted: item.legacyState === "merge-ready" || item.legacyState === "merged" ? true : false,
    prMerged: pr ? pr.state === "merged" : null,
    ticketResolved: ext === "unknown" ? null : ext === "closed",
  };
  const base = { ticketId: item.ticketId, legacyState: item.legacyState, prNumber, facts };
  if (pr?.state === "merged") return { ...base, action: "release-merged", detail: `PR #${pr.number} merged` };
  if (ext === "closed") return { ...base, action: "release-resolved", detail: "ticket resolved in the tracker" };
  if (LEGACY_TERMINAL.has(item.legacyState)) return { ...base, action: "release-resolved", detail: `legacy state ${item.legacyState}` };
  if (pr?.state === "closed") return { ...base, action: "blocked", detail: `PR #${pr.number} closed without merge: human decision` };
  if (LEGACY_STALE_CLAIM.has(item.legacyState) && !pr && !item.branch && !item.hasWorktree) {
    return { ...base, action: "stale-claim", detail: "claim without branch, PR or worktree" };
  }
  if (item.legacyState === "implementing" && !pr && !item.hasWorktree) {
    return { ...base, action: "blocked", detail: "lost worktree: human confirmation needed" };
  }
  return { ...base, action: "hold", detail: pr ? `PR #${pr.number} open` : "in flight" };
}

export class TicketFactoryCutoverService {
  private readonly now: () => Date;
  constructor(private readonly deps: CutoverDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  // ---- fence, consulted by TicketAdmissionService ----------------------------------------

  /** True while the old skill still owns this ticket. */
  isLegacyHeld = (ticketId: string): boolean =>
    !!this.deps.db.prepare(`SELECT 1 FROM ticket_factory_legacy_claims WHERE ticket_id = ? AND released_at IS NULL`).get(ticketId);

  /** True when the tracker already resolved the ticket (recorded completion fact). */
  isResolved = (ticketId: string): boolean =>
    !!this.deps.db.prepare(`SELECT 1 FROM ticket_completion WHERE ticket_id = ? AND ticket_resolved = 1`).get(ticketId);

  // ---- phase -----------------------------------------------------------------------------

  phase(): CutoverPhase | null {
    const row = this.deps.db.prepare(`SELECT phase FROM ticket_factory_cutover WHERE id = 1`).get() as { phase: CutoverPhase } | undefined;
    return row?.phase ?? null;
  }

  private setPhase(phase: CutoverPhase, note: string): void {
    const at = this.now().toISOString();
    this.deps.db.prepare(
      `INSERT INTO ticket_factory_cutover (id, phase, note, updated_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET phase = excluded.phase, note = excluded.note, updated_at = excluded.updated_at`,
    ).run(phase, note, at);
  }

  // ---- reconcile -------------------------------------------------------------------------

  /** Classify in-flight legacy work, fence what the old system still owns, record completion facts. Idempotent. */
  reconcileLegacy(snapshot: LegacySnapshot): ReconcileReport {
    const tickets = snapshot.items.map((i) => classify(i, snapshot.prs, snapshot.tickets));
    const itemById = new Map(snapshot.items.map((i) => [i.ticketId, i]));
    const at = this.now().toISOString();
    const held: string[] = [];
    this.deps.db.transaction(() => {
      for (const t of tickets) {
        const item = itemById.get(t.ticketId)!;
        this.recordFacts(t.ticketId, null, t.facts, t.prNumber);
        if (t.action === "hold" || t.action === "blocked") {
          held.push(t.ticketId);
          this.deps.db.prepare(
            `INSERT INTO ticket_factory_legacy_claims (ticket_id, source, legacy_state, pr_number, branch, claimed_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(ticket_id) DO UPDATE SET legacy_state = excluded.legacy_state, pr_number = excluded.pr_number,
               branch = excluded.branch, released_at = NULL, release_reason = NULL`,
          ).run(t.ticketId, item.source ?? "queue", t.legacyState, t.prNumber, item.branch ?? null, at);
        } else {
          this.releaseLegacyClaim(t.ticketId, t.detail);
        }
      }
      // Legacy claims absent from this snapshot stay fenced: absence is not evidence of completion.
      // A re-reconcile while the daemon owns admission refreshes claims but must not demote the phase.
      if (this.phase() !== "daemon") this.setPhase("reconciled", `reconciled ${tickets.length} legacy ticket(s), ${held.length} held`);
    })();
    return { tickets, held };
  }

  /** The old system finished with this ticket. Releases the fence; records why. */
  releaseLegacyClaim(ticketId: string, reason: string): void {
    this.deps.db.prepare(
      `UPDATE ticket_factory_legacy_claims SET released_at = ?, release_reason = ? WHERE ticket_id = ? AND released_at IS NULL`,
    ).run(this.now().toISOString(), reason, ticketId);
  }

  legacyClaims(): Array<{ ticketId: string; legacyState: string; prNumber: number | null; released: boolean }> {
    return (this.deps.db.prepare(`SELECT * FROM ticket_factory_legacy_claims ORDER BY ticket_id`).all() as Array<Record<string, unknown>>)
      .map((r) => ({ ticketId: r.ticket_id as string, legacyState: r.legacy_state as string, prNumber: (r.pr_number as number | null) ?? null, released: r.released_at != null }));
  }

  // ---- completion facts ------------------------------------------------------------------

  /** Merge facts for a ticket. A null input keeps the stored value; a known value overwrites it. */
  recordFacts(ticketId: string, admissionId: string | null, facts: Partial<ReconciledTicket["facts"]>, prNumber: number | null = null): void {
    const cur = this.completion(ticketId);
    const pick = (next: Fact | undefined, old: Fact): Fact => (next === undefined || next === null ? old : next);
    const merged = {
      workflowCompleted: pick(facts.workflowCompleted, cur?.workflowCompleted ?? null),
      prMerged: pick(facts.prMerged, cur?.prMerged ?? null),
      ticketResolved: pick(facts.ticketResolved, cur?.ticketResolved ?? null),
    };
    const bit = (f: Fact): number | null => (f === null ? null : f ? 1 : 0);
    this.deps.db.prepare(
      `INSERT INTO ticket_completion (ticket_id, admission_id, workflow_completed, pr_merged, ticket_resolved, pr_number, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ticket_id) DO UPDATE SET admission_id = COALESCE(excluded.admission_id, admission_id),
         workflow_completed = excluded.workflow_completed, pr_merged = excluded.pr_merged,
         ticket_resolved = excluded.ticket_resolved, pr_number = COALESCE(excluded.pr_number, pr_number),
         updated_at = excluded.updated_at`,
    ).run(ticketId, admissionId, bit(merged.workflowCompleted), bit(merged.prMerged), bit(merged.ticketResolved), prNumber, this.now().toISOString());
  }

  /** Record workflowCompleted for daemon admissions whose workflow finished. PR and ticket facts stay as reported. */
  syncDaemonCompletion(): number {
    const rows = this.deps.db.prepare(
      `SELECT id, ticket_id FROM ticket_admissions WHERE state = 'closed' AND state_reason = 'workflow completed'`,
    ).all() as Array<{ id: string; ticket_id: string }>;
    for (const r of rows) this.recordFacts(r.ticket_id, r.id, { workflowCompleted: true });
    return rows.length;
  }

  completion(ticketId: string): CompletionRow | null {
    const r = this.deps.db.prepare(`SELECT * FROM ticket_completion WHERE ticket_id = ?`).get(ticketId) as Record<string, unknown> | undefined;
    return r ? rowToCompletion(r) : null;
  }

  completions(): CompletionRow[] {
    return (this.deps.db.prepare(`SELECT * FROM ticket_completion ORDER BY ticket_id`).all() as Array<Record<string, unknown>>).map(rowToCompletion);
  }

  // ---- cutover and rollback --------------------------------------------------------------

  /**
   * Hand admission to the daemon. Requires a completed reconcile and an operator attestation
   * that the legacy producer is disabled (the daemon cannot observe the skill).
   */
  cutOver(opts: { legacyProducerDisabled: boolean }): CutoverPhase {
    const phase = this.phase();
    if (phase !== "reconciled" && phase !== "rolled-back") {
      throw new CutoverError(`cutover requires a completed reconcile (phase is ${phase ?? "none"})`);
    }
    if (!opts.legacyProducerDisabled) {
      throw new CutoverError("cutover requires confirmation that the legacy /factory-loop producer is disabled");
    }
    this.setPhase("daemon", "daemon owns admission");
    try {
      this.deps.controller.enable();
    } catch (err) {
      this.setPhase("reconciled", `enable failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    return "daemon";
  }

  /** Drain the daemon factory and give admission back to the skill. Active daemon tickets keep running. */
  rollback(reason = "operator rollback"): CutoverPhase {
    this.deps.controller.pause();
    this.setPhase("rolled-back", reason);
    return "rolled-back";
  }

  /**
   * After cutover, any active factory-loop queue item the daemon did not hand over means the
   * old producer is still running. Pause the daemon (drain) and report; never abort tickets.
   */
  async tripwire(): Promise<TripwireResult> {
    const none: TripwireResult = { unexpected: [], doubleDispatch: [], paused: false };
    if (this.phase() !== "daemon" || !this.deps.probeLegacyQueue) return none;
    const since = (this.deps.db.prepare(`SELECT updated_at FROM ticket_factory_cutover WHERE id = 1`).get() as { updated_at: string } | undefined)?.updated_at ?? null;
    let active: string[];
    try {
      active = await this.deps.probeLegacyQueue(since);
    } catch (err) {
      // Fail open: an unreadable queue must not drain the factory.
      console.warn(`ticket-factory tripwire: legacy queue probe unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return { ...none, probeUnavailable: true };
    }
    const held = new Set(this.legacyClaims().filter((c) => !c.released).map((c) => c.ticketId));
    const live = new Set((this.deps.db.prepare(
      `SELECT ticket_id FROM ticket_admissions WHERE state IN ('pending','active','reconciling')`,
    ).all() as Array<{ ticket_id: string }>).map((r) => r.ticket_id));
    const doubleDispatch = active.filter((t) => live.has(t));
    const unexpected = active.filter((t) => !held.has(t) && !live.has(t));
    if (doubleDispatch.length === 0 && unexpected.length === 0) return none;
    this.deps.controller.pause();
    return { unexpected, doubleDispatch, paused: true };
  }

  // ---- read model ------------------------------------------------------------------------

  status(): {
    phase: CutoverPhase | null;
    daemonAdmitted: string[];
    legacyClaims: ReturnType<TicketFactoryCutoverService["legacyClaims"]>;
    completion: CompletionRow[];
  } {
    const daemonAdmitted = (this.deps.db.prepare(
      `SELECT ticket_id FROM ticket_admissions WHERE state IN ('pending','active','reconciling') ORDER BY ticket_id`,
    ).all() as Array<{ ticket_id: string }>).map((r) => r.ticket_id);
    return { phase: this.phase(), daemonAdmitted, legacyClaims: this.legacyClaims(), completion: this.completions() };
  }
}

function rowToCompletion(r: Record<string, unknown>): CompletionRow {
  const f = (v: unknown): Fact => (v === null || v === undefined ? null : v === 1);
  return {
    ticketId: r.ticket_id as string, admissionId: (r.admission_id as string | null) ?? null,
    workflowCompleted: f(r.workflow_completed), prMerged: f(r.pr_merged), ticketResolved: f(r.ticket_resolved),
    prNumber: (r.pr_number as number | null) ?? null,
  };
}

const ACTIVE_LEGACY_STATES = ["pending", "in-progress", "blocked"] as const;

/**
 * Read-only probe over the OpenRig queue: ids of active factory-loop items created at or after
 * the cutover time. Uses only `list` (a SELECT); never mutates queue state.
 */
export function createLegacyQueueProbe(queue: Pick<QueueRepository, "list">): (sinceIso: string | null) => Promise<string[]> {
  return async (sinceIso) => {
    const sinceMs = sinceIso ? Date.parse(sinceIso) : Number.NEGATIVE_INFINITY;
    const items = queue.list({ tag: "factory-loop", state: [...ACTIVE_LEGACY_STATES], limit: 1000 });
    const ids = items
      .filter((i) => !(Date.parse(i.tsCreated) < sinceMs))
      .map((i) => (i.tags ?? []).find((t) => t.startsWith("ticket:"))?.slice("ticket:".length) ?? i.qitemId);
    return [...new Set(ids)];
  };
}
