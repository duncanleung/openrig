// RIG-88: recurring operation of the ticket-factory. A watchdog policy calls triggerPoll();
// the poll and admission run in a detached, single-flight worker with a timeout, so a slow
// tracker request cannot stall the scheduler tick. State, budgets and backoff live in SQLite
// (migration 105). Pause is an admission-level drain: stop admitting, let active tickets finish.

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { TicketAdmissionService } from "./ticket-admission-service.js";
import { FACTORY_DEFAULTS, resolveMergePolicy, type FactorySettings } from "./ticket-factory-config.js";

export class CutoverGateError extends Error {}

export type FactoryState = "disabled" | "running" | "paused";

export interface FactoryStatus {
  state: FactoryState;
  pollIntervalSeconds: number;
  capacity: number;
  live: number;
  run: { runId: string | null; admitted: number; maxTickets: number };
  wallClockPerTicketSeconds: number;
  cooldownSeconds: number;
  budget: { tokensPerTicket: "advisory: no session attribution yet"; tokenCapPerTicket: number | null };
  merge: { gate: string; policy: string; effective: string; reason: string };
  failStreak: number;
  lastPollAt: string | null;
  nextPollAt: string | null;
  lastError: string | null;
}

export interface PollOutcome {
  ran: boolean;
  skipped?: "disabled" | "paused" | "not-due" | "in-flight";
  admitted: string[];
  stopped?: "capacity" | "run-budget" | "empty" | "interrupted";
  expired: string[];
  error?: string;
}

export interface TicketFactoryDeps {
  db: Database.Database;
  admissions: TicketAdmissionService;
  /** Eligible backlog ticket ids, best first. Injected: the tracker adapter is a later slice. */
  listBacklog: () => Promise<string[]>;
  now?: () => Date;
  tokenCapPerTicket?: number | null;
  pollTimeoutMs?: number;
  /** Backoff ceiling as a multiple of the poll interval. */
  maxBackoffFactor?: number;
}

interface ControlRow {
  state: FactoryState; poll_interval_s: number; capacity: number; max_tickets_per_run: number;
  wall_clock_per_ticket_s: number; cooldown_s: number; merge_gate: string; merge_policy: string;
  current_run_id: string | null; fail_streak: number; next_poll_at: string | null;
  last_poll_at: string | null; last_error: string | null;
}

export class TicketFactoryController {
  private readonly now: () => Date;
  private inflight: Promise<PollOutcome> | null = null;

  constructor(private readonly deps: TicketFactoryDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Create the singleton control row from settings. An existing row is left alone. */
  seed(settings: FactorySettings = FACTORY_DEFAULTS): void {
    this.deps.db.prepare(
      `INSERT OR IGNORE INTO ticket_factory_control
         (id, state, poll_interval_s, capacity, max_tickets_per_run, wall_clock_per_ticket_s, cooldown_s, merge_gate, merge_policy, updated_at)
       VALUES (1, 'disabled', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(settings.pollIntervalSeconds, settings.capacity, settings.maxTicketsPerRun, settings.wallClockPerTicketSeconds,
      settings.cooldownSeconds, settings.mergeGate, settings.mergePolicy, this.now().toISOString());
  }

  /** Explicit reload of file settings over the stored ones. State, run and backoff are kept. */
  applySettings(settings: FactorySettings): void {
    this.seed(settings);
    this.deps.db.prepare(
      `UPDATE ticket_factory_control SET poll_interval_s = ?, capacity = ?, max_tickets_per_run = ?, wall_clock_per_ticket_s = ?,
         cooldown_s = ?, merge_gate = ?, merge_policy = ?, updated_at = ? WHERE id = 1`,
    ).run(settings.pollIntervalSeconds, settings.capacity, settings.maxTicketsPerRun, settings.wallClockPerTicketSeconds,
      settings.cooldownSeconds, settings.mergeGate, settings.mergePolicy, this.now().toISOString());
  }

  /** Enable (or re-enable) the factory: starts a new run and schedules an immediate poll. */
  enable(): FactoryStatus {
    this.seed();
    this.assertRunnablePhase("enabled");
    if (!this.control().current_run_id) this.startRun();
    this.update({ state: "running", next_poll_at: null, fail_streak: 0, last_error: null });
    return this.status();
  }

  /**
   * RIG-89: while a cutover is in progress, only the `daemon` phase may run the factory.
   * No cutover row (or no cutover table) means no cutover is in progress. Every path into
   * `running` (enable and resume) must call this, or a rollback can be undone by a resume.
   */
  private assertRunnablePhase(verb: "enabled" | "resumed"): void {
    const phase = this.cutoverPhase();
    if (phase && phase !== "daemon") {
      throw new CutoverGateError(`factory cannot be ${verb} while cutover phase is ${phase}; complete the cutover first`);
    }
  }

  private cutoverPhase(): string | null {
    try {
      const row = this.deps.db.prepare(`SELECT phase FROM ticket_factory_cutover WHERE id = 1`).get() as { phase: string } | undefined;
      return row?.phase ?? null;
    } catch (err) {
      if (err instanceof Error && /no such table/.test(err.message)) return null;
      throw err;
    }
  }

  disable(): FactoryStatus {
    this.seed();
    this.endRun("disabled");
    this.update({ state: "disabled" });
    return this.status();
  }

  /** Drain: stop admitting. Active workflow instances keep running. The run stays open. */
  pause(): FactoryStatus {
    this.seed();
    if (this.control().state === "running") this.update({ state: "paused" });
    return this.status();
  }

  resume(): FactoryStatus {
    this.seed();
    const c = this.control();
    if (c.state === "paused") {
      this.assertRunnablePhase("resumed");
      this.update({ state: "running", next_poll_at: null });
    }
    return this.status();
  }

  /** Begin a fresh run (resets the max-tickets budget) without changing state. */
  newRun(): FactoryStatus {
    this.seed();
    this.endRun("new run requested");
    this.startRun();
    return this.status();
  }

  status(): FactoryStatus {
    this.seed();
    const c = this.control();
    const merge = resolveMergePolicy(c.merge_gate, c.merge_policy);
    return {
      state: c.state,
      pollIntervalSeconds: c.poll_interval_s,
      capacity: c.capacity,
      live: this.deps.admissions.liveAdmissionCount(),
      run: {
        runId: c.current_run_id,
        admitted: c.current_run_id ? this.deps.admissions.admittedInRun(c.current_run_id) : 0,
        maxTickets: c.max_tickets_per_run,
      },
      wallClockPerTicketSeconds: c.wall_clock_per_ticket_s,
      cooldownSeconds: c.cooldown_s,
      budget: { tokensPerTicket: "advisory: no session attribution yet", tokenCapPerTicket: this.deps.tokenCapPerTicket ?? null },
      merge: { gate: c.merge_gate, policy: c.merge_policy, effective: merge.effective, reason: merge.reason },
      failStreak: c.fail_streak,
      lastPollAt: c.last_poll_at,
      nextPollAt: c.next_poll_at,
      lastError: c.last_error,
    };
  }

  /** Scheduler entry point: start the worker and return at once. Never throws, never blocks. */
  triggerPoll(): void {
    void this.pollOnce().catch(() => { /* run() records every failure in last_error */ });
  }

  /** One poll cycle. Single-flight: a second call while one runs returns `in-flight`. */
  pollOnce(): Promise<PollOutcome> {
    if (this.inflight) return Promise.resolve({ ran: false, skipped: "in-flight", admitted: [], expired: [] });
    this.inflight = this.run().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async run(): Promise<PollOutcome> {
    this.seed();
    const c = this.control();
    const out: PollOutcome = { ran: false, admitted: [], expired: [] };
    if (c.state === "disabled") return { ...out, skipped: "disabled" };
    // Housekeeping, the backlog read and admission all sit in one boundary, so any failure is recorded and backs off.
    try {
      // Housekeeping runs even while paused so finished tickets free capacity during a drain.
      this.deps.admissions.settleFinished();
      out.expired = await this.deps.admissions.expireOverBudget(c.wall_clock_per_ticket_s);
      if (c.state === "paused") return { ...out, skipped: "paused" };
      const nowMs = this.now().getTime();
      if (c.next_poll_at && nowMs < Date.parse(c.next_poll_at)) return { ...out, skipped: "not-due" };

      out.ran = true;
      const runId = c.current_run_id ?? this.startRun();
      const outcome = await this.admitFromBacklog(runId);
      out.admitted = outcome.admitted;
      out.stopped = outcome.stopped;
      // An operator verb changed the factory mid-poll; that verb owns the schedule, so leave it alone.
      if (outcome.stopped !== "interrupted") {
        this.update({ fail_streak: 0, last_error: null, last_poll_at: this.now().toISOString(), next_poll_at: this.afterSeconds(c.poll_interval_s) });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const streak = c.fail_streak + 1;
      const factor = Math.min(2 ** streak, this.deps.maxBackoffFactor ?? 16);
      this.update({
        fail_streak: streak, last_error: message, last_poll_at: this.now().toISOString(),
        next_poll_at: this.afterSeconds(c.poll_interval_s * factor),
      });
      out.error = message;
    }
    return out;
  }

  /** True when pause, disable or a new run landed while this poll was awaiting. */
  private changedSince(runId: string): ControlRow | null {
    const cur = this.control();
    return cur.state !== "running" || cur.current_run_id !== runId ? cur : null;
  }

  private async admitFromBacklog(runId: string): Promise<{ admitted: string[]; stopped?: PollOutcome["stopped"] }> {
    const admitted: string[] = [];
    // Limits come from the live row each time, so a settings reload applies inside a running poll.
    let c = this.control();
    if (this.deps.admissions.admittedInRun(runId) >= c.max_tickets_per_run) return { admitted, stopped: "run-budget" };
    if (this.deps.admissions.liveAdmissionCount() >= c.capacity) return { admitted, stopped: "capacity" };
    const backlog = await withTimeout(this.deps.listBacklog(), this.deps.pollTimeoutMs ?? 60_000, "backlog poll timed out");
    if (backlog.length === 0) return { admitted, stopped: "empty" };
    for (const ticketId of backlog) {
      if (this.changedSince(runId)) return { admitted, stopped: "interrupted" };
      c = this.control();
      if (this.deps.admissions.admittedInRun(runId) >= c.max_tickets_per_run) return { admitted, stopped: "run-budget" };
      if (this.deps.admissions.liveAdmissionCount() >= c.capacity) return { admitted, stopped: "capacity" };
      const result = await this.deps.admissions.admit(ticketId, { runId });
      if (result.admitted) admitted.push(ticketId);
      else if (result.reason === "capacity") return { admitted, stopped: "capacity" };
    }
    return { admitted };
  }

  private afterSeconds(s: number): string {
    return new Date(this.now().getTime() + s * 1000).toISOString();
  }

  private control(): ControlRow {
    return this.deps.db.prepare(`SELECT * FROM ticket_factory_control WHERE id = 1`).get() as ControlRow;
  }

  private update(fields: Partial<ControlRow>): void {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    this.deps.db.prepare(`UPDATE ticket_factory_control SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = 1`)
      .run(...keys.map((k) => (fields as Record<string, unknown>)[k] ?? null), this.now().toISOString());
  }

  private startRun(): string {
    const runId = randomUUID();
    this.deps.db.prepare(`INSERT INTO ticket_factory_runs (run_id, started_at) VALUES (?, ?)`).run(runId, this.now().toISOString());
    this.update({ current_run_id: runId });
    return runId;
  }

  private endRun(reason: string): void {
    const runId = this.control().current_run_id;
    if (!runId) return;
    this.deps.db.prepare(`UPDATE ticket_factory_runs SET ended_at = ?, end_reason = ? WHERE run_id = ?`).run(this.now().toISOString(), reason, runId);
    this.update({ current_run_id: null });
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
