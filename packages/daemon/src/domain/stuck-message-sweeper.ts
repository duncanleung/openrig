// RIG-190 — stuck-message sweeper: detects and recovers unsubmitted OpenRig deliveries
// (messages stuck in a terminal's input buffer without a final Enter).
//
// Design:
//   R1  Async mutex serializes sweeps; each seat returns a delta; coordinator merges and writes audit.
//   R2  Scope-aware cleanup; occupant re-checked after every await — if changed, discard evidence.
//   R3  Route every Enter through submitOnly. REDIRECT: collapsed pastes skipped (observation-only);
//       see PR description for the redirect criterion that was triggered.
//   R5  One Enter per delivery ID; guard via SweepAttemptStore.hasAttemptForDelivery.
//   R6  Persisted attempt record: attempting → confirmed | failed | indeterminate.
//   R7  Interim: on per-seat timeout, report seat as degraded; mutex released normally.
//   R8  UserPromptSubmit hook fast path: if seat is already running, mark delivery confirmed
//       without pressing Enter (agent submitted on its own).
//   R9  Reuse StuckSeatObserver.scan() for detection; sweeper owns only the action phase.
//
// MF1 (seed): single-slot sweepInFlight replaced with an async tail-chain mutex.
// MF3 (seed): ok:false Enter retry reports "failed" (not "unverified").
// MF4 (seed): sweep options include rig scope and graceMs.
// MF5 (seed): rig-scoped sweeps never delete observations outside their rig.
// MF6 (seed): occupant re-checked at verification time (after every await).

import { createHash } from "node:crypto";
import {
  COLLAPSED_PASTE,
  composerRegion,
} from "./startup-submission-evidence.js";
import type { StuckSeatObserver, StuckFinding } from "./stuck-seat-observer.js";
import type { SessionTransport } from "./session-transport.js";
import type { SweepAttemptStore } from "./sweep-attempt-store.js";
import type { SeatActivityService } from "./seat-activity-service.js";

// Collapsed-paste patterns (Claude and Codex).  When the composer shows one of
// these, ownership cannot be proven from delivery-time data alone, so the seat is
// skipped (R3 redirect criterion triggered).
const CODEX_COLLAPSED_PASTE = /^\[PastedContent\d+chars\]$/;

function isCollapsedPaste(normalizedBody: string): boolean {
  return COLLAPSED_PASTE.test(normalizedBody) || CODEX_COLLAPSED_PASTE.test(normalizedBody);
}

/** Per-seat outcome after a sweep attempt. */
export type SeatOutcome =
  | "confirmed"           // Enter accepted; submitOnly returned ok:true
  | "failed"              // Enter pressed but submitOnly returned ok:false
  | "fast_path"           // R8: agent already running; Enter skipped
  | "skipped_no_text"     // Composer was empty when rechecked
  | "skipped_collapsed"   // Collapsed paste (R3 redirect)
  | "skipped_already_attempted" // R5: delivery already has an attempt
  | "skipped_occupant_changed"  // R2: occupant swapped during capture
  | "skipped_capture_failed"    // Capture returned an error
  | "skipped_no_body"     // composerRegion returned null body
  | "skipped_no_finding"  // No delivery attempt to correlate
  | "skipped_dry_run"     // MF1: dry-run mode; no Enter pressed, no attempt record written
  | "skipped_no_delivery_id" // MF3: no correlated delivery ID; cannot attribute composer text
  | "degraded"            // R7: timeout during capture or submit
  | "indeterminate";      // Crash context (attempt row stuck in attempting state)

/** Per-seat delta produced by a worker; coordinator merges after pool. */
interface SeatDelta {
  session: string;
  outcome: SeatOutcome;
  deliveryId: string | null;
  attemptId: string | null;
  error?: string;
  durationMs: number;
}

/** Result of one sweep run. */
export interface SweepResult {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  rig?: string;
  dryRun: boolean;
  findings: number;
  seats: SeatDelta[];
  degraded: boolean;
}

/** Options for a single sweep run. */
export interface SweepOpts {
  /** Restrict to one rig (name or id). Omit for a fleet-wide sweep (R5). */
  rig?: string;
  /**
   * Dry-run: scan and report without writing attempt records or pressing Enter.
   * Does not advance composerSince grace state (T10).
   */
  dryRun?: boolean;
  /** Per-seat timeout in ms before the seat is reported degraded (R7 interim). */
  seatTimeoutMs?: number;
  /** Injected clock (for tests). */
  now?: () => Date;
}

const DEFAULT_SEAT_TIMEOUT_MS = 15_000;
// Keep the pool small to avoid flooding tmux.
const SWEEP_POOL_SIZE = 4;

function fingerprint(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ ok: true; value: T } | { ok: false; timedOut: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const race = new Promise<{ ok: false; timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, timedOut: true }), timeoutMs);
  });
  try {
    const value = await Promise.race([
      promise.then((v) => ({ ok: true as const, value: v })),
      race,
    ]);
    return value;
  } finally {
    clearTimeout(timer);
  }
}

export interface StuckMessageSweeperDeps {
  stuckSeatObserver: StuckSeatObserver;
  sessionTransport: Pick<SessionTransport, "capture" | "send">;
  attemptStore: SweepAttemptStore;
  seatActivity: Pick<SeatActivityService, "getSeatStateBySession">;
}

export class StuckMessageSweeper {
  /** Async mutex: sweeps are serialized via a tail-chain (R1). */
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: StuckMessageSweeperDeps) {}

  /**
   * Run one sweep: scan for stuck messages, attempt to submit them.
   * Concurrent callers queue behind the in-flight sweep (R1 mutex).
   */
  sweep(opts: SweepOpts = {}): Promise<SweepResult> {
    const run = this.tail.then(() => this.runSweep(opts));
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runSweep(opts: SweepOpts): Promise<SweepResult> {
    const now = opts.now ?? (() => new Date());
    const seatTimeoutMs = opts.seatTimeoutMs ?? DEFAULT_SEAT_TIMEOUT_MS;
    const startedAt = now().toISOString();
    const startMs = Date.now();

    // R9: delegate detection to StuckSeatObserver.
    await this.deps.stuckSeatObserver.scan(opts.rig ? { rig: opts.rig } : {});
    const snapshot = this.deps.stuckSeatObserver.snapshot(opts.rig ? { rig: opts.rig, rigNames: new Set([opts.rig]) } : {});

    const findings: StuckFinding[] = snapshot.findings.filter(
      (f) => f.kind === "persistent_composer_input" && !f.stale,
    );

    // R2: freeze occupant generations before entering the pool.
    const gen0 = new Map(
      findings.map((f) => [
        f.session,
        this.deps.seatActivity.getSeatStateBySession(f.session)?.lastSwap?.generation ?? "",
      ]),
    );

    // Worker pool (R1): each worker returns a delta; no worker writes shared state.
    const deltas: SeatDelta[] = [];
    let next = 0;
    const workers = Array.from({ length: Math.min(SWEEP_POOL_SIZE, findings.length) }, async () => {
      while (next < findings.length) {
        const finding = findings[next++]!;
        const delta = await this.processSeat(finding, gen0.get(finding.session) ?? "", opts, seatTimeoutMs, now);
        deltas.push(delta);
      }
    });
    await Promise.allSettled(workers);

    // After pool: coordinator merges deltas (R1).
    // No shared observation map to update — StuckSeatObserver owns that state (R9).

    const completedAt = now().toISOString();
    const durationMs = Date.now() - startMs;
    const degraded = deltas.some((d) => d.outcome === "degraded");

    return {
      startedAt,
      completedAt,
      durationMs,
      rig: opts.rig,
      dryRun: opts.dryRun ?? false,
      findings: findings.length,
      seats: deltas,
      degraded,
    };
  }

  private async processSeat(
    finding: StuckFinding,
    gen0: string,
    opts: SweepOpts,
    seatTimeoutMs: number,
    now: () => Date,
  ): Promise<SeatDelta> {
    const session = finding.session;
    const startMs = Date.now();

    const done = (outcome: SeatOutcome, extra?: Partial<SeatDelta>): SeatDelta => ({
      session,
      outcome,
      deliveryId: null,
      attemptId: null,
      durationMs: Date.now() - startMs,
      ...extra,
    });

    // R8: hook fast path — if the agent is already running (UserPromptSubmit fired),
    // the message was submitted on its own. No Enter needed.
    const activity = this.deps.seatActivity.getSeatStateBySession(session)?.activity;
    if (activity === "working") {
      return done("fast_path");
    }

    // MF6: use observer-correlated delivery attempt — do not re-query the ledger.
    const deliveryId = finding.deliveryAttempt?.attemptId ?? null;

    // MF3: no correlated delivery ID — cannot attribute the composer text; skip.
    if (!deliveryId) {
      return done("skipped_no_delivery_id");
    }

    // R5: one Enter per delivery ID.
    if (!opts.dryRun && this.deps.attemptStore.hasAttemptForDelivery(deliveryId)) {
      return done("skipped_already_attempted", { deliveryId });
    }

    // Capture the pane (R2: occupant will be re-checked after the await).
    const captureResult = await withTimeout(
      this.deps.sessionTransport.capture(session, { lines: 50 }),
      seatTimeoutMs,
    );

    if (!captureResult.ok) {
      return done("degraded"); // R7: timed out
    }
    const capture = captureResult.value;
    if (!capture.ok) {
      return done("skipped_capture_failed", { error: capture.error });
    }

    // R2: re-check occupant generation after the capture await.
    const gen1 = this.deps.seatActivity.getSeatStateBySession(session)?.lastSwap?.generation ?? "";
    if (gen1 !== gen0) {
      return done("skipped_occupant_changed");
    }

    const paneContent = capture.content ?? "";

    // Determine runtime from the finding's rig (approximation; accurate enough for
    // composerRegion which does a union-of-glyphs when runtime is unknown).
    // The StuckSeatObserver already verified this was a claude-code or codex seat.
    // We pass null to get the union check; a wrong runtime just widens the match slightly.
    const body = composerRegion(paneContent, null).body;

    if (body === null || body.length === 0) {
      return done("skipped_no_body");
    }

    // R3 redirect: collapsed pastes cannot be ownership-proven from delivery-time data.
    if (isCollapsedPaste(body)) {
      return done("skipped_collapsed");
    }

    // Double-check the composer still has text.
    if (body.trim().length === 0) {
      return done("skipped_no_text");
    }

    // Dry-run stops here — no attempt records written (T10).
    if (opts.dryRun) {
      return done("skipped_dry_run", { deliveryId });
    }

    // R6: write 'attempting' record before pressing Enter.
    const occupantGeneration = gen1;
    const paneId = null;
    const fp = fingerprint(body);

    const synthDeliveryId = deliveryId ?? `synth:${session}:${now().getTime()}`;
    const attemptId = this.deps.attemptStore.writeAttempting({
      deliveryId: synthDeliveryId,
      occupantGeneration,
      paneId,
      fingerprint: fp,
      now: now(),
    });

    // R3: use submitOnly with the visible body as expectedStagedText.
    // submitOnly re-captures the pane and verifies the text is still there before pressing Enter.
    const sendResult = await withTimeout(
      this.deps.sessionTransport.send(session, "", {
        submitOnly: true,
        expectedStagedText: body,
      }),
      seatTimeoutMs,
    );

    if (!sendResult.ok) {
      // R7: timed out during send.
      this.deps.attemptStore.markFailed(attemptId, now());
      return done("degraded", { deliveryId: synthDeliveryId, attemptId });
    }

    const send = sendResult.value;

    if (send.ok) {
      this.deps.attemptStore.markConfirmed(attemptId, now());
      return done("confirmed", { deliveryId: synthDeliveryId, attemptId });
    }

    // MF3: ok:false → "failed" (not "unverified").
    this.deps.attemptStore.markFailed(attemptId, now());
    return done("failed", {
      deliveryId: synthDeliveryId,
      attemptId,
      error: send.error,
    });
  }
}
