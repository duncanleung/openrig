// RIG-87: durable admission for the ticket-factory workflow. Owns ticket -> instance
// identity, duplicate suppression, the eligibility checks, capacity, and recovery from
// uncertain external state. The workflow engine owns the admitted ticket's steps.
// External lookups (code, git, tracker) are injected; this service calls none of them.

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { WorkflowRuntime } from "./workflow-runtime.js";

export const TICKET_FACTORY_SPEC = "ticket-factory";

export type AdmissionDisposition = "ready" | "blocked" | "already-resolved" | "needs-investigation";
export type AdmissionState = "pending" | "active" | "reconciling" | "closed" | "rejected";
export type ExternalTicketState = "open" | "closed" | "unknown";

export interface AdmissionCheckResult { name: string; passed: boolean; detail?: string }
export interface AdmissionEvidence {
  baseSha: string;
  ticketRevision: string;
  checks: AdmissionCheckResult[];
  proposedFixLayer: string | null;
  disposition: AdmissionDisposition;
}

export interface AdmissionRow {
  id: string;
  ticketId: string;
  instanceKey: string;
  instanceId: string | null;
  state: AdmissionState;
  disposition: AdmissionDisposition;
  evidence: AdmissionEvidence;
  stateReason: string | null;
}

export type AdmissionResult =
  | { admitted: true; admission: AdmissionRow }
  | { admitted: false; reason: "duplicate" | "capacity" | "cooldown" | "not-ready"; admission: AdmissionRow | null };

const TERMINAL_INSTANCE = new Set(["completed", "failed", "aborted"]);

export interface TicketAdmissionDeps {
  db: Database.Database;
  runtime: Pick<WorkflowRuntime, "instantiate" | "abort" | "instanceStore">;
  /** Runs the five prep checks (code existence, fix-layer triage, bug verification, smoke test, dependency detection). */
  runChecks: (ticketId: string) => Promise<AdmissionEvidence>;
  createdBySession: string;
  specPath?: string;
  now?: () => Date;
  /** Max live admissions. A function lets the recurring controller change it without a restart. */
  capacity?: number | (() => number);
  /** A ticket closed less than this many seconds ago is not re-admitted (RIG-88). 0 disables. */
  cooldownSeconds?: number | (() => number);
}

interface Raw {
  id: string; ticket_id: string; instance_key: string; instance_id: string | null;
  state: AdmissionState; disposition: AdmissionDisposition; evidence_json: string; state_reason: string | null;
}

export class TicketAdmissionService {
  private readonly now: () => Date;
  private readonly capacityOf: () => number;
  private readonly cooldownOf: () => number;
  private readonly specPath: string;

  constructor(private readonly deps: TicketAdmissionDeps) {
    this.now = deps.now ?? (() => new Date());
    const cap = deps.capacity ?? 1;
    this.capacityOf = typeof cap === "function" ? cap : () => cap;
    const cool = deps.cooldownSeconds ?? 0;
    this.cooldownOf = typeof cool === "function" ? cool : () => cool;
    this.specPath = deps.specPath ?? TICKET_FACTORY_SPEC;
  }

  /** Deterministic run identity: ticket id + admission timestamp. */
  static instanceKey(ticketId: string, at: Date): string {
    return `${ticketId}@${at.toISOString()}`;
  }

  async admit(ticketId: string, opts: { runId?: string } = {}): Promise<AdmissionResult> {
    // Cheap pre-checks; the partial unique index below is the real guarantee.
    const live = this.liveRowFor(ticketId);
    if (live) return { admitted: false, reason: "duplicate", admission: live };
    if (this.liveCount() >= this.capacityOf()) return { admitted: false, reason: "capacity", admission: null };
    if (this.inCooldown(ticketId)) return { admitted: false, reason: "cooldown", admission: null };

    const evidence = await this.deps.runChecks(ticketId);
    const ready = evidence.disposition === "ready";
    const at = this.now();
    const id = randomUUID();
    const key = TicketAdmissionService.instanceKey(ticketId, at);
    try {
      this.deps.db.transaction(() => {
        // Capacity re-check inside the write transaction (counts live rows only; non-ready rows are terminal).
        if (ready && this.liveCount() >= this.capacityOf()) throw new CapacityError();
        this.deps.db.prepare(
          `INSERT INTO ticket_admissions (id, ticket_id, instance_key, state, disposition, evidence_json, state_reason, created_at, updated_at, run_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, ticketId, key, ready ? "pending" : "rejected", evidence.disposition, JSON.stringify(evidence),
          ready ? null : `disposition ${evidence.disposition}`, at.toISOString(), at.toISOString(), opts.runId ?? null);
      })();
    } catch (err) {
      if (err instanceof CapacityError) return { admitted: false, reason: "capacity", admission: null };
      if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) {
        return { admitted: false, reason: "duplicate", admission: this.liveRowFor(ticketId) };
      }
      throw err;
    }
    if (!ready) return { admitted: false, reason: "not-ready", admission: this.getById(id) };
    await this.startInstance(id);
    return { admitted: true, admission: this.getById(id)! };
  }

  /** Boot recovery: finish admissions a crash left half-done. Safe to run repeatedly. */
  async recoverPending(): Promise<{ resumed: number; adopted: number }> {
    let resumed = 0;
    let adopted = 0;
    const rows = this.deps.db.prepare(`SELECT * FROM ticket_admissions WHERE state = 'pending'`).all() as Raw[];
    for (const raw of rows) {
      const orphan = this.findOrphanInstance(raw);
      if (orphan) {
        // A finished orphan is terminal: closing it keeps a failed run from holding a capacity slot.
        const status = this.deps.runtime.instanceStore.getById(orphan)?.status;
        if (status && TERMINAL_INSTANCE.has(status)) {
          this.deps.db.prepare(`UPDATE ticket_admissions SET instance_id = ? WHERE id = ?`).run(orphan, raw.id);
          this.setState(raw.id, "closed", `workflow ${status}`);
        } else {
          this.setActive(raw.id, orphan);
        }
        adopted++;
      } else {
        await this.startInstance(raw.id);
        resumed++;
      }
    }
    return { resumed, adopted };
  }

  /** Reconcile one active admission with the ticket's real external state. Never guesses on unknown. */
  async reconcile(ticketId: string, external: ExternalTicketState): Promise<AdmissionState | null> {
    const row = this.liveRowFor(ticketId);
    if (!row || row.state === "pending") return row?.state ?? null;
    if (external === "unknown") {
      this.setState(row.id, "reconciling", "external ticket state unknown; left in place");
      return "reconciling";
    }
    if (external === "open") {
      if (row.state !== "reconciling") return row.state;
      const status = row.instanceId ? this.deps.runtime.instanceStore.getById(row.instanceId)?.status : undefined;
      if (status && TERMINAL_INSTANCE.has(status)) {
        this.setState(row.id, "closed", `workflow ${status}`);
        return "closed";
      }
      this.setState(row.id, "active", "external state confirmed open");
      return "active";
    }
    if (row.instanceId) {
      const inst = this.deps.runtime.instanceStore.getById(row.instanceId);
      if (inst && (inst.status === "active" || inst.status === "waiting")) {
        await this.deps.runtime.abort({
          instanceId: row.instanceId,
          reason: `ticket ${ticketId} closed externally`,
          actorSession: this.deps.createdBySession,
        });
      }
    }
    this.setState(row.id, "closed", "ticket closed externally");
    return "closed";
  }

  /** Close an admission whose workflow instance finished on its own. */
  settleFinished(): number {
    let n = 0;
    for (const raw of this.deps.db.prepare(`SELECT * FROM ticket_admissions WHERE state IN ('active','reconciling') AND instance_id IS NOT NULL`).all() as Raw[]) {
      const inst = this.deps.runtime.instanceStore.getById(raw.instance_id!);
      if (inst && TERMINAL_INSTANCE.has(inst.status)) {
        this.setState(raw.id, "closed", `workflow ${inst.status}`);
        n++;
      }
    }
    return n;
  }

  /** Abort and close live admissions older than maxAgeSeconds (wall-clock budget per ticket). */
  async expireOverBudget(maxAgeSeconds: number): Promise<string[]> {
    const cutoff = new Date(this.now().getTime() - maxAgeSeconds * 1000).toISOString();
    const rows = this.deps.db.prepare(
      `SELECT * FROM ticket_admissions WHERE state IN ('active','reconciling') AND created_at < ?`,
    ).all(cutoff) as Raw[];
    const expired: string[] = [];
    for (const raw of rows) {
      const inst = raw.instance_id ? this.deps.runtime.instanceStore.getById(raw.instance_id) : null;
      if (inst && (inst.status === "active" || inst.status === "waiting")) {
        await this.deps.runtime.abort({
          instanceId: raw.instance_id!,
          reason: `ticket ${raw.ticket_id} exceeded its wall-clock budget`,
          actorSession: this.deps.createdBySession,
        });
      }
      this.setState(raw.id, "closed", `wall-clock budget exceeded (${maxAgeSeconds}s)`);
      expired.push(raw.ticket_id);
    }
    return expired;
  }

  /** Admissions that started a workflow in this run. Derived from rows, so it survives restart. */
  admittedInRun(runId: string): number {
    return (this.deps.db.prepare(`SELECT COUNT(*) AS c FROM ticket_admissions WHERE run_id = ? AND disposition = 'ready'`).get(runId) as { c: number }).c;
  }

  liveAdmissionCount(): number {
    return this.liveCount();
  }

  private inCooldown(ticketId: string): boolean {
    const seconds = this.cooldownOf();
    if (seconds <= 0) return false;
    const since = new Date(this.now().getTime() - seconds * 1000).toISOString();
    return !!this.deps.db.prepare(
      `SELECT 1 FROM ticket_admissions WHERE ticket_id = ? AND state = 'closed' AND updated_at > ? LIMIT 1`,
    ).get(ticketId, since);
  }

  getById(id: string): AdmissionRow | null {
    const raw = this.deps.db.prepare(`SELECT * FROM ticket_admissions WHERE id = ?`).get(id) as Raw | undefined;
    return raw ? toRow(raw) : null;
  }

  private liveRowFor(ticketId: string): AdmissionRow | null {
    const raw = this.deps.db.prepare(
      `SELECT * FROM ticket_admissions WHERE ticket_id = ? AND state IN ('pending','active','reconciling')`,
    ).get(ticketId) as Raw | undefined;
    return raw ? toRow(raw) : null;
  }

  private liveCount(): number {
    return (this.deps.db.prepare(`SELECT COUNT(*) AS c FROM ticket_admissions WHERE state IN ('pending','active','reconciling')`).get() as { c: number }).c;
  }

  private async startInstance(admissionId: string): Promise<void> {
    const row = this.getById(admissionId)!;
    // The key rides in the root objective so a crash after instantiate can be recognised on recovery.
    const created = await this.deps.runtime.instantiate({
      specPath: this.specPath,
      rootObjective: rootObjectiveFor(row.ticketId, row.instanceKey),
      createdBySession: this.deps.createdBySession,
    });
    this.setActive(admissionId, created.instance.instanceId);
  }

  /**
   * An instance created before a crash. The key rides on the entry packet's exact
   * "Root objective:" line; a loose LIKE hit is only a prefilter and never decides the match.
   */
  private findOrphanInstance(row: Raw): string | null {
    const wanted = `Root objective: ${rootObjectiveFor(row.ticket_id, row.instance_key)}`;
    const candidates = this.deps.db.prepare(`SELECT qitem_id, body FROM queue_items WHERE body LIKE ? ESCAPE '\\'`)
      .all(`%${row.instance_key.replace(/[\\%_]/g, "\\$&")}%`) as Array<{ qitem_id: string; body: string }>;
    const exact = candidates.filter((q) => q.body.split("\n").some((line) => line.trim() === wanted)).map((q) => q.qitem_id);
    if (exact.length === 0) return null;
    const inst = this.deps.runtime.instanceStore.listAll().find(
      (i) => i.workflowName === TICKET_FACTORY_SPEC && i.currentFrontier.some((id) => exact.includes(id)),
    );
    return inst?.instanceId ?? null;
  }

  private setActive(id: string, instanceId: string): void {
    this.deps.db.prepare(`UPDATE ticket_admissions SET state = 'active', instance_id = ?, updated_at = ? WHERE id = ?`)
      .run(instanceId, this.now().toISOString(), id);
  }

  private setState(id: string, state: AdmissionState, reason: string): void {
    this.deps.db.prepare(`UPDATE ticket_admissions SET state = ?, state_reason = ?, updated_at = ? WHERE id = ?`)
      .run(state, reason, this.now().toISOString(), id);
  }
}

class CapacityError extends Error {}

function rootObjectiveFor(ticketId: string, instanceKey: string): string {
  return `${ticketId} [admission ${instanceKey}]`;
}

function toRow(raw: Raw): AdmissionRow {
  return {
    id: raw.id, ticketId: raw.ticket_id, instanceKey: raw.instance_key, instanceId: raw.instance_id,
    state: raw.state, disposition: raw.disposition, evidence: JSON.parse(raw.evidence_json) as AdmissionEvidence,
    stateReason: raw.state_reason,
  };
}
