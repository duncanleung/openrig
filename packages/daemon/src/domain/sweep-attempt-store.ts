// RIG-190 — persisted sweep attempt record.
// State machine: attempting → confirmed | failed | indeterminate
// On daemon restart, all 'attempting' rows are upgraded to 'indeterminate'.
// Indeterminate rows are never auto-retried.
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type SweepAttemptState = "attempting" | "confirmed" | "failed" | "failed_transient" | "indeterminate";

export interface SweepAttemptRecord {
  id: string;
  deliveryId: string;
  occupantGeneration: string;
  paneId: string | null;
  fingerprint: string;
  state: SweepAttemptState;
  createdAt: string;
  resolvedAt: string | null;
}

interface SweepAttemptRow {
  id: string;
  delivery_id: string;
  occupant_generation: string;
  pane_id: string | null;
  fingerprint: string;
  state: string;
  created_at: string;
  resolved_at: string | null;
}

function toRecord(row: SweepAttemptRow): SweepAttemptRecord {
  return {
    id: row.id,
    deliveryId: row.delivery_id,
    occupantGeneration: row.occupant_generation,
    paneId: row.pane_id,
    fingerprint: row.fingerprint,
    state: row.state as SweepAttemptState,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export class SweepAttemptStore {
  constructor(private readonly db: Database.Database) {}

  /** Write a row in state 'attempting' before pressing Enter. Returns the new row id. */
  writeAttempting(opts: {
    deliveryId: string;
    occupantGeneration: string;
    paneId: string | null;
    fingerprint: string;
    now?: Date;
  }): string {
    const id = randomUUID();
    const now = (opts.now ?? new Date()).toISOString();
    this.db
      .prepare(
        `INSERT INTO sweep_attempts
         (id, delivery_id, occupant_generation, pane_id, fingerprint, state, created_at)
         VALUES (?, ?, ?, ?, ?, 'attempting', ?)`,
      )
      .run(id, opts.deliveryId, opts.occupantGeneration, opts.paneId, opts.fingerprint, now);
    return id;
  }

  /** Mark a row confirmed after a successful Enter. */
  markConfirmed(id: string, now?: Date): void {
    this.db
      .prepare(`UPDATE sweep_attempts SET state = 'confirmed', resolved_at = ? WHERE id = ?`)
      .run((now ?? new Date()).toISOString(), id);
  }

  /** Mark a row failed after a failed Enter (staged_mismatch, transport failure, etc.). */
  markFailed(id: string, now?: Date): void {
    this.db
      .prepare(`UPDATE sweep_attempts SET state = 'failed', resolved_at = ? WHERE id = ?`)
      .run((now ?? new Date()).toISOString(), id);
  }

  /**
   * Mark a row as transiently failed — a timeout or transient transport error where the Enter
   * outcome is unknown. Unlike markFailed, this state does NOT block future retries:
   * hasAttemptForDelivery treats failed_transient as non-blocking.
   */
  markTransientFailure(id: string, now?: Date): void {
    this.db
      .prepare(`UPDATE sweep_attempts SET state = 'failed_transient', resolved_at = ? WHERE id = ?`)
      .run((now ?? new Date()).toISOString(), id);
  }

  /**
   * On daemon start: upgrade ALL 'attempting' rows to 'indeterminate'.
   * A crash while 'attempting' leaves the row ambiguous. Indeterminate rows
   * are never auto-retried.
   */
  upgradeAttempingToIndeterminate(now?: Date): number {
    const result = this.db
      .prepare(
        `UPDATE sweep_attempts SET state = 'indeterminate', resolved_at = ?
         WHERE state = 'attempting'`,
      )
      .run((now ?? new Date()).toISOString());
    return result.changes;
  }

  /**
   * Guard: has a blocking attempt already been recorded for this delivery ID?
   * One Enter per delivery ID maximum (R5). failed_transient is non-blocking —
   * it records a timeout where the outcome was unknown, allowing future retries.
   */
  hasAttemptForDelivery(deliveryId: string): boolean {
    const row = this.db
      .prepare(`SELECT id FROM sweep_attempts WHERE delivery_id = ? AND state != 'failed_transient' LIMIT 1`)
      .get(deliveryId);
    return row !== undefined;
  }

  /** All records for a delivery ID, newest first. */
  attemptsForDelivery(deliveryId: string): SweepAttemptRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, delivery_id, occupant_generation, pane_id, fingerprint, state, created_at, resolved_at
         FROM sweep_attempts WHERE delivery_id = ? ORDER BY created_at DESC`,
      )
      .all(deliveryId) as SweepAttemptRow[];
    return rows.map(toRecord);
  }
}
