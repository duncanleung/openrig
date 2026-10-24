// RIG-123 — always-on record of the latest `rig send` delivery attempts per session, so a stuck-seat detector
// can correlate composer text with an attempt (attempt id, occupant/pane identity, sent hash, completion time).
// It is a CaptureObserverSink: the transport already records every attempt into its sink. This ledger keeps
// metadata only (the observer never carries sent text, only a hash) and is bounded per session and in total.
import type { CaptureObserverSink, ObservationInput } from "./capture-observer.js";

export interface DeliveryAttemptRef {
  attemptId: string;
  sessionName: string;
  nodeId: string | null;
  occupant: string | null;
  pane: string | null;
  sentHash: string;
  completedAt: string;
}

export const LEDGER_ATTEMPTS_PER_SESSION = 4;
export const LEDGER_MAX_SESSIONS = 512;

export class DeliveryAttemptLedger implements CaptureObserverSink {
  private readonly bySession = new Map<string, DeliveryAttemptRef[]>();

  /** Never throws and never blocks the send path: a malformed input is dropped. */
  record(input: ObservationInput): void {
    try {
      if (!input.sentHash || !input.binding?.sessionName) return;
      const session = input.binding.sessionName;
      const list = this.bySession.get(session) ?? [];
      // Several seams record one attempt; keep one row per attempt id.
      if (list.some((a) => a.attemptId === input.attemptId)) return;
      list.push({
        attemptId: input.attemptId,
        sessionName: session,
        nodeId: input.binding.nodeId,
        occupant: input.binding.occupant,
        pane: input.binding.pane,
        sentHash: input.sentHash,
        completedAt: input.completedAt,
      });
      if (list.length > LEDGER_ATTEMPTS_PER_SESSION) list.shift();
      this.bySession.delete(session);
      this.bySession.set(session, list);
      while (this.bySession.size > LEDGER_MAX_SESSIONS) {
        const oldest = this.bySession.keys().next().value;
        if (oldest === undefined) break;
        this.bySession.delete(oldest);
      }
    } catch { /* observation must never affect delivery */ }
  }

  /** Newest attempt first. */
  attemptsFor(sessionName: string): DeliveryAttemptRef[] {
    return [...(this.bySession.get(sessionName) ?? [])].reverse();
  }
}

/** Feed one input to several sinks; one sink's failure never reaches the others or the caller. */
export function teeObserverSinks(...sinks: Array<CaptureObserverSink | undefined>): CaptureObserverSink {
  const live = sinks.filter((s): s is CaptureObserverSink => Boolean(s));
  return { record(input) { for (const s of live) { try { s.record(input); } catch { /* isolate */ } } } };
}
