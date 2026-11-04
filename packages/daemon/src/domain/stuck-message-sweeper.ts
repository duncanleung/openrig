// Stuck-message sweeper — detect idle seats whose input box still holds an
// OpenRig-delivered message that never got Enter (upstream #14 / #2429), and
// safely press Enter once when attribution + idle + prompt guards all pass.
// Observation-only findings that are not safe to auto-submit are reported.
// Resolution is deliberately separate from StuckSeatObserver (RIG-123), which
// never presses Enter.
import type { SeatActivityService } from "./seat-activity-service.js";
import type { DeliveryAttemptRef } from "./delivery-attempt-ledger.js";
import type { EventBus } from "./event-bus.js";
import type { SessionTransport } from "./session-transport.js";
import { classifyPaneActivity, readComposerOccupancy } from "./session-transport.js";
import type { SeatTarget } from "./stuck-seat-observer.js";
import {
  attributionAllowsAutoEnter,
  classifyStuckAttribution,
  DEFAULT_STUCK_GRACE_MS,
  extractComposerVisibleText,
  fingerprintComposerText,
  truncateExcerpt,
  type StuckAction,
  type StuckAttribution,
} from "./stuck-message-attribution.js";

export { DEFAULT_STUCK_GRACE_MS } from "./stuck-message-attribution.js";

const CLASSIFY_CONCURRENCY = 8;
const POST_ENTER_SETTLE_MS = 400;

export interface StuckSweepItem {
  rig: string;
  logicalId: string;
  session: string;
  runtime: string | null;
  action: StuckAction;
  attribution: StuckAttribution;
  /** Milliseconds the fingerprint has been unchanged, when known. */
  unchangedMs: number | null;
  excerpt: string;
  detail: string;
  deliveryAttemptId?: string | null;
  verified?: boolean;
}

export interface StuckSweepReport {
  scannedAt: string;
  dryRun: boolean;
  graceMs: number;
  examined: number;
  items: StuckSweepItem[];
  /** True when at least one stuck item remains unresolved (needs human, or auto-Enter failed). */
  unresolved: boolean;
}

export interface StuckSweepOpts {
  dryRun?: boolean;
  graceMs?: number;
  rig?: string;
  /** When false, skip the Enter step even if attribution allows it (report only). Default true. */
  autoEnter?: boolean;
}

export interface StuckMessageSweeperDeps {
  listSeats(rig?: string): SeatTarget[];
  seatActivity: Pick<SeatActivityService, "getSeatStateBySession" | "classifyPermissionPrompt">;
  /** Capture pane text for one session. */
  capturePane(session: string): Promise<string | null>;
  /** Press Enter via the existing submitOnly path (visible staged text). */
  submitOnly?(session: string, expectedStagedText: string): Promise<{ ok: boolean; reason?: string; error?: string }>;
  /** Fingerprint-guarded Enter for attributed collapsed pastes (no full staged text available). */
  pressEnter?(session: string): Promise<{ ok: boolean; reason?: string; error?: string }>;
  /** Latest delivery attempts per session, newest first. */
  attempts?: { attemptsFor(session: string): DeliveryAttemptRef[] };
  resolveRig?(rig: string): string[];
  eventBus?: Pick<EventBus, "emit">;
  /** Optional webhook notifier; never throws into the sweep. */
  notify?(item: StuckSweepItem): Promise<void>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Resolve node id for audit events. */
  resolveNode?(session: string): { rigId: string; nodeId: string } | null;
}

interface Observation {
  fingerprint: string;
  firstSeenMs: number;
  generation: string;
  text: string;
  /** Sessions we already attempted auto-Enter for under this fingerprint (at most one retry). */
  enterAttempts: number;
}

type SeatState = ReturnType<StuckMessageSweeperDeps["seatActivity"]["getSeatStateBySession"]>;

const generationOf = (state: SeatState | undefined): string => state?.lastSwap?.generation ?? "";

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      try { await fn(item); } catch { /* one seat's failure never aborts the sweep */ }
    }
  });
  await Promise.all(workers);
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class StuckMessageSweeper {
  private readonly observations = new Map<string, Observation>();
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: StuckMessageSweeperDeps) {
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? sleepMs;
  }

  /** Scan every managed seat (or one rig) and optionally auto-Enter attributable stuck text. */
  async sweep(opts: StuckSweepOpts = {}): Promise<StuckSweepReport> {
    const dryRun = opts.dryRun === true;
    const autoEnter = opts.autoEnter !== false;
    const graceMs = opts.graceMs ?? DEFAULT_STUCK_GRACE_MS;
    const nowMs = this.now().getTime();
    const scannedAt = new Date(nowMs).toISOString();
    const seats = this.deps.listSeats(opts.rig);
    const items: StuckSweepItem[] = [];

    await pool(seats, CLASSIFY_CONCURRENCY, async (seat) => {
      const item = await this.examineSeat(seat, { dryRun, autoEnter, graceMs, nowMs });
      if (item) items.push(item);
    });

    // Drop observations for seats that left the fleet.
    const present = new Set(seats.map((s) => s.session));
    for (const session of [...this.observations.keys()]) {
      if (!present.has(session)) this.observations.delete(session);
    }

    items.sort((a, b) => a.session.localeCompare(b.session));
    const unresolved = items.some((i) =>
      i.action === "needs_human" || i.action === "auto_enter_failed");

    if (!dryRun) {
      for (const item of items) {
        if (item.action === "needs_human" || item.action === "auto_enter_verified" || item.action === "auto_enter_failed") {
          try { await this.deps.notify?.(item); } catch { /* notify must never abort the report */ }
        }
      }
    }

    return {
      scannedAt,
      dryRun,
      graceMs,
      examined: seats.length,
      items,
      unresolved,
    };
  }

  private async examineSeat(
    seat: SeatTarget,
    ctx: { dryRun: boolean; autoEnter: boolean; graceMs: number; nowMs: number },
  ): Promise<StuckSweepItem | null> {
    const state = this.deps.seatActivity.getSeatStateBySession(seat.session);
    const generation = generationOf(state);

    // Mid-turn: never touch; clear observation so a later idle draft restarts grace.
    if (state?.activity === "working") {
      this.observations.delete(seat.session);
      return null;
    }

    const prompt = await this.deps.seatActivity.classifyPermissionPrompt(seat.session);
    if (prompt.state === "confirmed" || prompt.state === "suspected") {
      this.observations.delete(seat.session);
      return {
        rig: seat.rig, logicalId: seat.logicalId, session: seat.session, runtime: seat.runtime,
        action: "skipped_prompt", attribution: "unknown", unchangedMs: null, excerpt: "",
        detail: `seat is at a ${prompt.state} permission/interactive prompt; sweeper will not press Enter`,
      };
    }

    let pane: string | null;
    try { pane = await this.deps.capturePane(seat.session); } catch { pane = null; }
    if (pane == null) {
      return {
        rig: seat.rig, logicalId: seat.logicalId, session: seat.session, runtime: seat.runtime,
        action: "unobserved", attribution: "unknown", unchangedMs: null, excerpt: "",
        detail: "pane capture unavailable",
      };
    }

    const runtime = seat.runtime === "claude-code" || seat.runtime === "codex" ? seat.runtime : null;
    if (!runtime) {
      // Only Claude Code / Codex composers are recognized today.
      this.observations.delete(seat.session);
      return null;
    }

    const occupancy = readComposerOccupancy(pane, runtime);
    if (occupancy === "unknown") {
      return {
        rig: seat.rig, logicalId: seat.logicalId, session: seat.session, runtime: seat.runtime,
        action: "unobserved", attribution: "unknown", unchangedMs: null, excerpt: "",
        detail: "composer not readable",
      };
    }
    if (occupancy === "empty") {
      this.observations.delete(seat.session);
      return null;
    }

    const text = extractComposerVisibleText(pane, runtime);
    if (text == null) {
      return {
        rig: seat.rig, logicalId: seat.logicalId, session: seat.session, runtime: seat.runtime,
        action: "unobserved", attribution: "unknown", unchangedMs: null, excerpt: "",
        detail: "composer region unrecognized",
      };
    }
    if (!text.trim()) {
      this.observations.delete(seat.session);
      return null;
    }

    // Idle layout check via the same classifier send --verify uses. A short collapsed-paste
    // pane can read as `unknown` (no status head above the box) while the activity oracle
    // already knows the seat is idle-at-prompt — treat that as idle for attribution, never
    // when the pane positively says attention or mid-work.
    const activity = classifyPaneActivity(pane, { runtime });
    if (activity.state === "attention") {
      this.observations.delete(seat.session);
      return {
        rig: seat.rig, logicalId: seat.logicalId, session: seat.session, runtime: seat.runtime,
        action: "skipped_prompt", attribution: "unknown", unchangedMs: null,
        excerpt: truncateExcerpt(text),
        detail: `pane activity is attention (${activity.reason}); sweeper will not press Enter`,
      };
    }
    if (activity.state === "agent_active") {
      this.observations.delete(seat.session);
      return null;
    }
    const oracleIdle = state?.activity === "idle-at-prompt";
    const verifiedIdle = activity.state === "agent_idle" || (activity.state === "unknown" && oracleIdle);

    const fingerprint = fingerprintComposerText(text);
    let seen = this.observations.get(seat.session);
    if (!seen || seen.fingerprint !== fingerprint || seen.generation !== generation) {
      seen = { fingerprint, firstSeenMs: ctx.nowMs, generation, text, enterAttempts: 0 };
      this.observations.set(seat.session, seen);
      return {
        rig: seat.rig, logicalId: seat.logicalId, session: seat.session, runtime: seat.runtime,
        action: "skipped_grace", attribution: classifyStuckAttribution(text), unchangedMs: 0,
        excerpt: truncateExcerpt(text),
        detail: `composer text first observed; waiting ${Math.round(ctx.graceMs / 1000)}s for unchanged confirmation`,
      };
    }

    const unchangedMs = ctx.nowMs - seen.firstSeenMs;
    if (unchangedMs < ctx.graceMs) {
      return {
        rig: seat.rig, logicalId: seat.logicalId, session: seat.session, runtime: seat.runtime,
        action: "skipped_grace", attribution: classifyStuckAttribution(text), unchangedMs,
        excerpt: truncateExcerpt(text),
        detail: `composer text unchanged for ${Math.round(unchangedMs / 1000)}s; grace is ${Math.round(ctx.graceMs / 1000)}s`,
      };
    }

    const attempt = this.correlate(seat.session, state ?? null, ctx.nowMs);
    const attribution = classifyStuckAttribution(text, { pasteAttributed: Boolean(attempt) });
    const base = {
      rig: seat.rig, logicalId: seat.logicalId, session: seat.session, runtime: seat.runtime,
      attribution, unchangedMs, excerpt: truncateExcerpt(text),
      deliveryAttemptId: attempt?.attemptId ?? null,
    };

    if (!attributionAllowsAutoEnter(attribution)) {
      return {
        ...base,
        action: "needs_human",
        detail: attribution === "human_draft"
          ? "composer holds text that is not an OpenRig envelope/queue-wake/attributed paste; report only — never auto-Enter a human draft"
          : attempt
            ? "collapsed paste is present but could not be safely attributed for auto-Enter"
            : "composer holds text with no OpenRig delivery signature; needs a human",
      };
    }

    // Must be verified idle before any Enter.
    if (!verifiedIdle) {
      return {
        ...base,
        action: "skipped_busy",
        detail: `attributable stuck text, but pane activity is ${activity.state} (${activity.reason}) and oracle is ${state?.activity ?? "absent"}; waiting for idle`,
      };
    }

    if (!ctx.autoEnter || ctx.dryRun) {
      return {
        ...base,
        action: "auto_enter",
        detail: ctx.dryRun
          ? `dry-run: would press Enter (${attribution}${attempt ? `, attempt ${attempt.attemptId}` : ""})`
          : `would press Enter (${attribution})`,
      };
    }

    if (seen.enterAttempts >= 2) {
      return {
        ...base,
        action: "auto_enter_failed",
        detail: "auto-Enter already attempted twice for this fingerprint; not retrying again",
        verified: false,
      };
    }

    const enterResult = await this.pressEnterOnce(seat, text, attribution, seen);
    seen.enterAttempts += 1;
    this.observations.set(seat.session, seen);

    if (!enterResult.ok) {
      if (enterResult.reason === "typing_guard_enabled") {
        return {
          ...base,
          action: "skipped_typing_guard",
          detail: enterResult.error ?? "typing guard prevented Enter",
        };
      }
      this.audit(seat, "failed", attribution, text, attempt?.attemptId ?? null, enterResult.error);
      return {
        ...base,
        action: "auto_enter_failed",
        detail: enterResult.error ?? "Enter failed",
        verified: false,
      };
    }

    await this.sleep(POST_ENTER_SETTLE_MS);
    let verified = await this.verifyCleared(seat.session, runtime, fingerprint);

    // One retry only when the first Enter landed but the box did not clear.
    if (!verified && seen.enterAttempts < 2) {
      const retry = await this.pressEnterOnce(seat, text, attribution, seen);
      seen.enterAttempts += 1;
      this.observations.set(seat.session, seen);
      if (retry.ok) {
        await this.sleep(POST_ENTER_SETTLE_MS);
        verified = await this.verifyCleared(seat.session, runtime, fingerprint);
      }
    }

    if (verified) {
      this.observations.delete(seat.session);
      this.audit(seat, "verified", attribution, text, attempt?.attemptId ?? null);
      return {
        ...base,
        action: "auto_enter_verified",
        detail: `pressed Enter for ${attribution}; composer cleared or turn started`,
        verified: true,
      };
    }

    this.audit(seat, "unverified", attribution, text, attempt?.attemptId ?? null);
    return {
      ...base,
      action: "auto_enter_failed",
      detail: "pressed Enter but composer still holds the same text after verification",
      verified: false,
    };
  }

  private async pressEnterOnce(
    seat: SeatTarget,
    text: string,
    attribution: StuckAttribution,
    _seen: Observation,
  ): Promise<{ ok: boolean; reason?: string; error?: string }> {
    // Visible envelope / queue-wake: reuse submitOnly so the pane must still show this text.
    if (attribution === "openrig_envelope" || attribution === "queue_wake") {
      if (!this.deps.submitOnly) {
        return { ok: false, reason: "submit_unavailable", error: "submitOnly is not wired" };
      }
      return this.deps.submitOnly(seat.session, text);
    }
    // Attributed collapsed paste: fingerprint was re-checked by the caller; press Enter once.
    if (!this.deps.pressEnter) {
      return { ok: false, reason: "submit_unavailable", error: "pressEnter is not wired" };
    }
    return this.deps.pressEnter(seat.session);
  }

  private async verifyCleared(session: string, runtime: "claude-code" | "codex", priorFingerprint: string): Promise<boolean> {
    let pane: string | null;
    try { pane = await this.deps.capturePane(session); } catch { return false; }
    if (pane == null) return false;
    const occupancy = readComposerOccupancy(pane, runtime);
    if (occupancy === "empty") return true;
    const activity = classifyPaneActivity(pane, { runtime });
    if (activity.state === "agent_active") return true;
    const text = extractComposerVisibleText(pane, runtime);
    if (text == null || !text.trim()) return true;
    return fingerprintComposerText(text) !== priorFingerprint;
  }

  private correlate(session: string, state: SeatState, nowMs: number): DeliveryAttemptRef | null {
    const attempts = this.deps.attempts?.attemptsFor(session) ?? [];
    const swap = state?.lastSwap ?? null;
    const swapAt = swap ? Date.parse(swap.at) : null;
    for (const a of attempts) {
      if (state && a.nodeId !== null && a.nodeId !== state.seatNodeId) continue;
      if (swap && a.occupant !== swap.generation) continue;
      const doneMs = Date.parse(a.completedAt);
      if (!Number.isFinite(doneMs) || doneMs > nowMs) continue;
      if (swapAt !== null && Number.isFinite(swapAt) && doneMs < swapAt) continue;
      return a;
    }
    return null;
  }

  private audit(
    seat: SeatTarget,
    outcome: "verified" | "unverified" | "failed",
    attribution: StuckAttribution,
    text: string,
    attemptId: string | null,
    error?: string,
  ): void {
    if (!this.deps.eventBus) return;
    const ids = this.deps.resolveNode?.(seat.session);
    try {
      this.deps.eventBus.emit({
        type: "transport.stuck_message_enter",
        rigId: ids?.rigId ?? seat.rig,
        nodeId: ids?.nodeId ?? seat.logicalId,
        sessionName: seat.session,
        outcome,
        attribution,
        excerpt: truncateExcerpt(text),
        deliveryAttemptId: attemptId,
        ...(error ? { error } : {}),
      });
    } catch { /* audit must never abort recovery */ }
  }
}

/** Wire SessionTransport.submitOnly for the sweeper's visible-text path. */
export function submitOnlyViaTransport(
  transport: Pick<SessionTransport, "send">,
): StuckMessageSweeperDeps["submitOnly"] {
  return async (session, expectedStagedText) => {
    const result = await transport.send(session, "", {
      submitOnly: true,
      expectedStagedText,
    });
    return {
      ok: result.ok === true,
      reason: result.reason,
      error: result.error,
    };
  };
}
