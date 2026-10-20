// RIG-111 — delivery-time decay filter (v1 infrastructure; NO decay is on by default).
//
// A per-file decision at startup delivery:
//   resolve files -> classify by surface -> FILTER BY DECAY -> partition by phase -> deliver
// This is not a watchdog Policy (policies/types.ts): it runs once per delivered file, not once
// per session on a timer tick. Two candidate patterns plug in; none is selected. Selection waits
// for a human-gated live eval run (ADR-0010). Actual surface decay (wiki, LEARNED.md, auto-memory)
// belongs to openrig-memory; this only decides what the daemon delivers at startup.
//
// v1 staleness signal is file mtime. Access count is not tracked yet, so callers pass 0.

export interface DecayItem {
  surface: string;
  path: string;
  lastAccess: Date;
  accessCount: number;
}

export interface DeliveryDecayFilter {
  readonly name: string;
  shouldDeliver(item: DecayItem): boolean;
}

const DAY_MS = 86_400_000;

/** The default: deliver everything. */
export const noDecayFilter: DeliveryDecayFilter = { name: "none", shouldDeliver: () => true };

export interface AccessWeightedRetentionOptions {
  /** Days a surface persists with zero accesses. A surface not listed never decays. */
  ttlDaysBySurface: Record<string, number>;
  /** Each recorded access extends that surface's time-to-live by this fraction of its base. Default 0.5. */
  accessBonus?: number;
  now?: () => Date;
}

/** Candidate 1: surfaces accessed more persist longer; unused surfaces decay on a schedule. */
export class AccessWeightedRetention implements DeliveryDecayFilter {
  readonly name = "access-weighted-retention";
  constructor(private readonly opts: AccessWeightedRetentionOptions) {}

  shouldDeliver(item: DecayItem): boolean {
    const base = this.opts.ttlDaysBySurface[item.surface];
    if (base === undefined) return true;
    const ttlMs = base * (1 + Math.max(0, item.accessCount) * (this.opts.accessBonus ?? 0.5)) * DAY_MS;
    const ageMs = (this.opts.now?.() ?? new Date()).getTime() - item.lastAccess.getTime();
    return ageMs <= ttlMs;
  }
}

export interface DreamingPromotionGatesOptions {
  /** Short-lived surfaces: delivered only while fresh (days). */
  ephemeralTtlDays: Record<string, number>;
  /** Long-lived surfaces: demoted (not delivered) once untouched this many days. */
  durableDemoteAfterDays: Record<string, number>;
  /** An ephemeral item accessed at least this often is a promotion candidate. Default 3. */
  promoteMinAccessCount?: number;
  now?: () => Date;
}

/**
 * Candidate 2: ephemeral knowledge expires; stale durable knowledge is demoted. The daemon only
 * applies the demotion/expiry side at delivery. Promotion is a write to a durable surface, which
 * belongs to openrig-memory, so this class only NAMES candidates (promotionCandidates).
 */
export class DreamingPromotionGates implements DeliveryDecayFilter {
  readonly name = "dreaming-promotion-gates";
  constructor(private readonly opts: DreamingPromotionGatesOptions) {}

  private ageDays(item: DecayItem): number {
    return ((this.opts.now?.() ?? new Date()).getTime() - item.lastAccess.getTime()) / DAY_MS;
  }

  shouldDeliver(item: DecayItem): boolean {
    const ephemeral = this.opts.ephemeralTtlDays[item.surface];
    if (ephemeral !== undefined) return this.ageDays(item) <= ephemeral;
    const durable = this.opts.durableDemoteAfterDays[item.surface];
    if (durable !== undefined) return this.ageDays(item) <= durable;
    return true;
  }

  /** Ephemeral items worth promoting to a durable surface. Pure; performs no write. */
  promotionCandidates(items: DecayItem[]): DecayItem[] {
    const min = this.opts.promoteMinAccessCount ?? 3;
    return items.filter((i) => this.opts.ephemeralTtlDays[i.surface] !== undefined
      && i.accessCount >= min && this.shouldDeliver(i));
  }
}
