// RIG-123 — independent stuck-seat observation service. It acquires findings on its own cadence and caches
// them; `computeOperationalSummary` only reads `snapshot()`, so a summary request does no terminal I/O.
// Three detectors, each reporting `found | clear | unobserved` per seat so that "could not look" never reads
// as healthy:
//   permission_blocked        extends the permission oracle (SeatActivityService.classifyPermissionPrompt)
//   persistent_composer_input composer text that outlives a grace interval, correlated with a delivery attempt
//   idle_with_expected_work   explicit idleSince from activity transitions, joined with owed queue work
// Findings live in per-seat, per-kind episodes: opened on detection, closed on recovery, refreshed in place.
// This lifecycle differs from watchdog one-shot suppression per occupant generation. The service is read-only:
// it never sends Enter and never retries a send. Resolution is a separate concern.
import type { SeatActivityService } from "./seat-activity-service.js";
import type { DeliveryAttemptRef } from "./delivery-attempt-ledger.js";

export type StuckKind = "permission_blocked" | "persistent_composer_input" | "idle_with_expected_work";
export type StuckConfidence = "confirmed" | "suspected";
export type ComposerReading = "empty" | "text" | "unknown";

export const STUCK_DETECTORS: readonly StuckKind[] = ["permission_blocked", "persistent_composer_input", "idle_with_expected_work"];
/** Composer text must persist this long before it is reported. */
export const DEFAULT_COMPOSER_GRACE_MS = 60_000;
/** A seat must be idle this long, with owed work, before it is reported. */
export const DEFAULT_IDLE_THRESHOLD_MS = 30 * 60_000;
/** A scan older than this no longer proves the fleet state; findings turn stale and coverage turns partial. */
export const DEFAULT_STALE_AFTER_MS = 5 * 60_000;
/** Fleet scan cadence. Terminal capture is batched, so this stays well above the 1s activity sweep. */
export const DEFAULT_SCAN_INTERVAL_MS = 30_000;
const CLASSIFY_CONCURRENCY = 8;
const RECENTLY_CLOSED_LIMIT = 50;

export interface SeatTarget {
  rig: string;
  logicalId: string;
  /** Canonical session name, for example `dev-impl@openrig`. */
  session: string;
  runtime: string | null;
}

export interface StuckFinding {
  episodeId: string;
  kind: StuckKind;
  rig: string;
  logicalId: string;
  session: string;
  confidence: StuckConfidence;
  openedAt: string;
  lastObservedAt: string;
  /** True when the latest scan that covers this seat is older than the stale window. */
  stale: boolean;
  detail: string;
  /** persistent_composer_input only. */
  correlation?: "attempt-correlated" | "uncorrelated";
  deliveryAttempt?: { attemptId: string; completedAt: string } | null;
  /** idle_with_expected_work only. */
  idleSince?: string;
  /** True when the idle start was not observed in this process (for example after a daemon restart). */
  durationUncertain?: boolean;
  expectedWork?: number;
}

export interface ClosedEpisode {
  episodeId: string;
  kind: StuckKind;
  session: string;
  openedAt: string;
  closedAt: string;
  reason: "recovered" | "occupant_changed" | "seat_gone";
}

export interface StuckDetectorCoverage {
  detector: StuckKind;
  status: "complete" | "partial" | "unavailable";
  examined: number;
  reason?: string;
}

export interface StuckSeatSnapshot {
  scannedAt: string | null;
  findings: StuckFinding[];
  recentlyClosed: ClosedEpisode[];
  coverage: StuckDetectorCoverage[];
}

export interface StuckSeatObserverDeps {
  /** Running agent seats, optionally scoped to one rig (name or id). */
  listSeats(rig?: string): SeatTarget[];
  seatActivity: Pick<SeatActivityService, "getSeatStateBySession" | "classifyPermissionPrompt">;
  /** One batched read of composer state for many seats. Absent = the composer detector is unavailable. */
  readComposers?(seats: SeatTarget[]): Promise<Map<string, ComposerReading>>;
  /** Latest delivery attempts per session, newest first. Absent = correlation is unavailable. */
  attempts?: { attemptsFor(session: string): DeliveryAttemptRef[] };
  /** Pending or in-progress queue obligations owed to a seat. Absent = the idle detector is unavailable. */
  expectedWork?(session: string): number;
  now?: () => Date;
  composerGraceMs?: number;
  idleThresholdMs?: number;
  staleAfterMs?: number;
}

type Verdict =
  | { status: "found"; confidence: StuckConfidence; detail: string; extra?: Partial<StuckFinding> }
  | { status: "clear" }
  | { status: "unobserved"; reason: string };

interface Episode {
  finding: StuckFinding;
  /** Occupant generation the episode opened under. */
  generation: string;
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      try { await fn(item); } catch { /* one seat's failure never aborts the scan */ }
    }
  });
  await Promise.all(workers);
}

export class StuckSeatObserver {
  private readonly episodes = new Map<string, Episode>();
  private readonly closed: ClosedEpisode[] = [];
  /** Composer text first seen per session, for the grace interval. */
  private readonly composerSince = new Map<string, { sinceMs: number; generation: string }>();
  private scannedAtMs: number | null = null;
  private coverage: StuckDetectorCoverage[] = STUCK_DETECTORS.map((detector) => ({ detector, status: "unavailable", examined: 0, reason: "no scan has completed" }));
  private scanning: Promise<void> | null = null;
  private readonly now: () => Date;

  constructor(private readonly deps: StuckSeatObserverDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Observe the fleet (or one rig) and update episodes. Single-flight: a scan that starts while one runs joins it,
   * so a slow tmux can never stack overlapping sweeps. Terminal I/O happens only here.
   */
  scan(opts: { rig?: string } = {}): Promise<void> {
    if (this.scanning) return this.scanning;
    this.scanning = this.runScan(opts.rig).finally(() => { this.scanning = null; });
    return this.scanning;
  }

  private timer: ReturnType<typeof setInterval> | null = null;

  /** Scan the whole fleet now and every `intervalMs`. Idempotent. A failed scan never crashes the daemon. */
  start(intervalMs: number = DEFAULT_SCAN_INTERVAL_MS): void {
    if (this.timer) return;
    const run = () => { void this.scan().catch((err: unknown) => console.error(`[stuck-seat-observer] scan error: ${err instanceof Error ? err.message : String(err)}`)); };
    run();
    this.timer = setInterval(run, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Cheap projection of cached state. No terminal I/O. */
  snapshot(opts: { rig?: string; rigNames?: ReadonlySet<string> } = {}): StuckSeatSnapshot {
    const nowMs = this.now().getTime();
    const staleAfter = this.deps.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    const scanStale = this.scannedAtMs === null || nowMs - this.scannedAtMs > staleAfter;
    const inScope = (rig: string) => !opts.rigNames || opts.rigNames.has(rig);
    const findings = [...this.episodes.values()]
      .map((e) => ({ ...e.finding, stale: scanStale || nowMs - Date.parse(e.finding.lastObservedAt) > staleAfter }))
      .filter((f) => inScope(f.rig));
    const coverage = this.coverage.map((c): StuckDetectorCoverage =>
      scanStale && this.scannedAtMs !== null && c.status === "complete"
        ? { ...c, status: "partial", reason: `last scan older than ${Math.round(staleAfter / 1000)}s` }
        : c);
    return {
      scannedAt: this.scannedAtMs === null ? null : new Date(this.scannedAtMs).toISOString(),
      findings,
      recentlyClosed: [...this.closed],
      coverage,
    };
  }

  private async runScan(rig?: string): Promise<void> {
    const seats = this.deps.listSeats(rig);
    const nowMs = this.now().getTime();
    const nowIso = new Date(nowMs).toISOString();
    const states = new Map(seats.map((s) => [s.session, this.deps.seatActivity.getSeatStateBySession(s.session)]));

    const verdicts = new Map<string, Map<StuckKind, Verdict>>();
    const set = (session: string, kind: StuckKind, v: Verdict) => {
      let m = verdicts.get(session);
      if (!m) { m = new Map(); verdicts.set(session, m); }
      m.set(kind, v);
    };

    // Permission: oracle first (free), reader capture only for seats the oracle has not already classified.
    await pool(seats, CLASSIFY_CONCURRENCY, async (seat) => {
      const state = states.get(seat.session);
      if (!state) { set(seat.session, "permission_blocked", { status: "unobserved", reason: "no arbitrated activity state" }); return; }
      const r = await this.deps.seatActivity.classifyPermissionPrompt(seat.session);
      if (r.state === "confirmed" || r.state === "suspected") {
        set(seat.session, "permission_blocked", {
          status: "found", confidence: r.state,
          detail: r.state === "confirmed" ? "permission prompt confirmed by the activity oracle" : r.source === "reader"
            ? "a prompt is visible; the reader cannot tell a permission prompt from a selection prompt"
            : "a permission request is unverified",
        });
      } else if (r.state === "none") set(seat.session, "permission_blocked", { status: "clear" });
      else set(seat.session, "permission_blocked", { status: "unobserved", reason: "prompt reader gave no answer" });
    });

    // Composer: one batched read, only for seats that are not mid-turn.
    if (this.deps.readComposers) {
      const candidates = seats.filter((s) => states.get(s.session)?.activity !== "working");
      for (const s of seats) if (!candidates.includes(s)) { this.composerSince.delete(s.session); set(s.session, "persistent_composer_input", { status: "clear" }); }
      let readings: Map<string, ComposerReading> | null = null;
      try { readings = candidates.length ? await this.deps.readComposers(candidates) : new Map(); } catch { readings = null; }
      for (const seat of candidates) {
        const state = states.get(seat.session);
        const reading = readings?.get(seat.session) ?? "unknown";
        const generation = state?.lastSwap?.generation ?? "";
        if (reading === "unknown") { set(seat.session, "persistent_composer_input", { status: "unobserved", reason: "composer not readable" }); continue; }
        if (reading === "empty") { this.composerSince.delete(seat.session); set(seat.session, "persistent_composer_input", { status: "clear" }); continue; }
        let seen = this.composerSince.get(seat.session);
        if (!seen || seen.generation !== generation) { seen = { sinceMs: nowMs, generation }; this.composerSince.set(seat.session, seen); }
        if (nowMs - seen.sinceMs < (this.deps.composerGraceMs ?? DEFAULT_COMPOSER_GRACE_MS)) {
          set(seat.session, "persistent_composer_input", { status: "clear" }); // within grace: not yet a finding
          continue;
        }
        const attempt = this.correlate(seat.session, state ?? null, nowMs);
        set(seat.session, "persistent_composer_input", {
          status: "found", confidence: "suspected",
          detail: attempt
            ? `composer has held text since ${new Date(seen.sinceMs).toISOString()}; delivery attempt ${attempt.attemptId} completed ${attempt.completedAt} on this occupant. The text is not proven to be that send.`
            : `composer has held text since ${new Date(seen.sinceMs).toISOString()}; no delivery attempt correlates. It can be a draft, a suggestion or queued input.`,
          extra: {
            correlation: attempt ? "attempt-correlated" : "uncorrelated",
            deliveryAttempt: attempt ? { attemptId: attempt.attemptId, completedAt: attempt.completedAt } : null,
          },
        });
      }
    } else {
      for (const s of seats) set(s.session, "persistent_composer_input", { status: "unobserved", reason: "composer reader is not wired" });
    }

    // Idle with expected work: explicit idleSince, never oracle changedAt.
    for (const seat of seats) {
      const state = states.get(seat.session);
      if (!this.deps.expectedWork) { set(seat.session, "idle_with_expected_work", { status: "unobserved", reason: "queue join is not wired" }); continue; }
      if (!state || state.activity === "unknown") { set(seat.session, "idle_with_expected_work", { status: "unobserved", reason: "no arbitrated activity state" }); continue; }
      const idle = state.activity === "idle-at-prompt" ? state.idleSince : null;
      if (!idle) { set(seat.session, "idle_with_expected_work", { status: "clear" }); continue; }
      const owed = this.deps.expectedWork(seat.session);
      const idleMs = nowMs - Date.parse(idle.at);
      if (owed > 0 && idleMs >= (this.deps.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS)) {
        set(seat.session, "idle_with_expected_work", {
          status: "found", confidence: idle.transitionObserved ? "confirmed" : "suspected",
          detail: `idle at prompt for ${Math.round(idleMs / 60000)} min${idle.transitionObserved ? "" : " or more (idle start not observed in this daemon run)"} with ${owed} owed queue item(s)`,
          extra: { idleSince: idle.at, durationUncertain: !idle.transitionObserved, expectedWork: owed },
        });
      } else set(seat.session, "idle_with_expected_work", { status: "clear" });
    }

    this.applyVerdicts(seats, states, verdicts, nowIso, rig);
    this.scannedAtMs = nowMs;
    this.coverage = STUCK_DETECTORS.map((detector) => {
      let examined = 0; let unobserved = 0; let reason: string | undefined;
      for (const seat of seats) {
        const v = verdicts.get(seat.session)?.get(detector);
        if (!v) continue;
        if (v.status === "unobserved") { unobserved++; reason ??= v.reason; } else examined++;
      }
      if (examined === 0 && unobserved > 0) return { detector, status: "unavailable" as const, examined, reason };
      if (unobserved > 0) return { detector, status: "partial" as const, examined, reason: `${unobserved} seat(s) not observed: ${reason}` };
      if (detector === "persistent_composer_input" && !this.deps.attempts) {
        return { detector, status: "partial" as const, examined, reason: "delivery-attempt correlation is not wired; findings are uncorrelated" };
      }
      return { detector, status: "complete" as const, examined };
    });
  }

  /** The newest attempt on this occupant that finished before the grace interval began. */
  private correlate(session: string, state: ReturnType<StuckSeatObserverDeps["seatActivity"]["getSeatStateBySession"]>, nowMs: number): DeliveryAttemptRef | null {
    const attempts = this.deps.attempts?.attemptsFor(session) ?? [];
    const swapAt = state?.lastSwap ? Date.parse(state.lastSwap.at) : null;
    for (const a of attempts) {
      if (state && a.nodeId !== null && a.nodeId !== state.seatNodeId) continue;
      const doneMs = Date.parse(a.completedAt);
      if (!Number.isFinite(doneMs) || doneMs > nowMs) continue;
      if (swapAt !== null && Number.isFinite(swapAt) && doneMs < swapAt) continue; // sent to a previous occupant
      return a;
    }
    return null;
  }

  private applyVerdicts(
    seats: SeatTarget[],
    states: Map<string, ReturnType<StuckSeatObserverDeps["seatActivity"]["getSeatStateBySession"]>>,
    verdicts: Map<string, Map<StuckKind, Verdict>>,
    nowIso: string,
    scopeRig: string | undefined,
  ): void {
    const bySession = new Map(seats.map((s) => [s.session, s]));
    const scannedRigs = new Set(seats.map((s) => s.rig));
    for (const seat of seats) {
      const generation = states.get(seat.session)?.lastSwap?.generation ?? "";
      for (const kind of STUCK_DETECTORS) {
        const key = `${kind}|${seat.session}`;
        const v = verdicts.get(seat.session)?.get(kind);
        const open = this.episodes.get(key);
        if (!v || v.status === "unobserved") continue; // an unread seat keeps its episode; coverage reports the gap
        if (open && open.generation !== generation) { this.close(key, open, nowIso, "occupant_changed"); }
        const current = this.episodes.get(key);
        if (v.status === "clear") { if (current) this.close(key, current, nowIso, "recovered"); continue; }
        if (current) {
          current.finding = { ...current.finding, ...v.extra, confidence: v.confidence, detail: v.detail, lastObservedAt: nowIso, stale: false };
        } else {
          this.episodes.set(key, {
            generation,
            finding: {
              episodeId: `${kind}:${seat.session}:${Date.parse(nowIso)}`,
              kind, rig: seat.rig, logicalId: seat.logicalId, session: seat.session,
              confidence: v.confidence, openedAt: nowIso, lastObservedAt: nowIso, stale: false, detail: v.detail, ...v.extra,
            },
          });
        }
      }
    }
    // A seat that left the scanned set (stopped, removed) ends its episodes. Out-of-scope rigs are left alone.
    for (const [key, e] of [...this.episodes]) {
      if (bySession.has(e.finding.session)) continue;
      if (scopeRig && !scannedRigs.has(e.finding.rig)) continue;
      this.close(key, e, nowIso, "seat_gone");
    }
  }

  private close(key: string, e: Episode, closedAt: string, reason: ClosedEpisode["reason"]): void {
    this.episodes.delete(key);
    this.closed.unshift({ episodeId: e.finding.episodeId, kind: e.finding.kind, session: e.finding.session, openedAt: e.finding.openedAt, closedAt, reason });
    if (this.closed.length > RECENTLY_CLOSED_LIMIT) this.closed.length = RECENTLY_CLOSED_LIMIT;
  }
}
