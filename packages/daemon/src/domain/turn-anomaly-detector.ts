// RIG-79 — fleet turn-anomaly detector: finds sessions whose assistant turns run far ahead of the user messages
// that steer them.
//
// Metric. assistant-turn : user-message, from the fleet store's `total_turns` (assistant messages that carry text or
// tool_use) and `conversation_turns` (non-tool-result user messages, compaction summaries included). It is NOT a
// tool-call ratio. Both columns are lifetime counters, so the ratio is taken over a recent WINDOW: the delta between the
// current digest and the newest sample at or before the window start. A lifetime ratio dilutes an acute spike and keeps
// an old anomaly alive after the session recovered.
//
// Arithmetic. The comparison is `assistantDelta > threshold * userDelta`: no integer division, and no NULLIF that
// would drop a session with zero user messages. A window with assistant turns and zero user messages is its own
// finding kind (`zero_conversation`), because no ratio exists for it and it is the most suspicious shape.
//
// Latency bound. The fleet store is fed by fleet ingestion (default cadence 5 minutes). The detector reads the store
// and never the transcripts, so it cannot see a pattern shorter than one ingestion interval, and a finding appears at
// most one ingestion interval plus one scan interval after the pattern starts. Advisory only: it never touches a session.
//
// Boundary. This is NOT a stuck-seat detector (terminal capture, `stuck-seat-observer.ts`). It reads a database and
// runs on the watchdog substrate (`policies/turn-anomaly.ts`) plus its own timer, so health stays populated when no
// watchdog job is registered. The subject (the watched session) is tracked here by its native session id and
// generation; the watchdog engine's `targetGeneration` describes only the delivery recipient.
import type Database from "better-sqlite3";

export type TurnRole = "orchestrator" | "reviewer" | "implementer" | "other";
export type TurnAnomalyKind = "high_ratio" | "zero_conversation";

export const DEFAULT_TURN_WINDOW_MS = 30 * 60_000;
export const DEFAULT_TURN_THRESHOLDS: Readonly<Record<TurnRole, number>> = {
  orchestrator: 50,
  reviewer: 40,
  implementer: 20,
  other: 30,
};
/** A window needs at least this share of its length covered by samples before it can raise a finding. */
const MIN_WINDOW_COVERAGE = 0.5;
/** A digest this much older than the window is not a live session; its episodes close. */
const STALE_DIGEST_WINDOWS = 2;
/** The newest sample is refreshed at least this often so the baseline never lags further than the window. */
const HEARTBEAT_DIVISOR = 6;
const DEFAULT_SCAN_MAX_AGE_MS = 30_000;
const RECENTLY_CLOSED_MS = 60 * 60_000;
const RECENTLY_CLOSED_LIMIT = 10;
export const TURN_ANOMALY_SCAN_INTERVAL_MS = 60_000;

export interface TurnAnomalyConfig {
  windowMs: number;
  thresholds: Record<TurnRole, number>;
  /** Exact seat session or node logical id → role. Wins over the name-derived role. */
  roleOverrides: Record<string, TurnRole>;
}

export interface WindowEvidence {
  windowMs: number;
  /** Time actually covered by the baseline sample; shorter than `windowMs` while history is still building. */
  coveredMs: number;
  assistantTurns: number;
  userMessages: number;
  /** assistantTurns / userMessages as a float; null when userMessages is 0. */
  ratio: number | null;
  threshold: number;
}

export interface StallCorroboration {
  type: string;
  turnRange: [number, number] | null;
  details: Record<string, unknown>;
}

export interface TurnAnomalyFinding {
  episodeId: number;
  kind: TurnAnomalyKind;
  session: string;
  rig: string | null;
  role: TurnRole;
  /** The watched session's identity. Independent of any watchdog delivery recipient. */
  subject: { nativeSessionId: string; generation: string | null };
  window: WindowEvidence;
  lifetime: { assistantTurns: number; userMessages: number; zeroConversation: boolean };
  /** Reducer stall signals that fall inside the window. Evidence only: the detector never re-derives them. */
  corroboration: StallCorroboration[];
  openedAt: string;
  lastSeenAt: string;
}

export interface ClosedTurnEpisode {
  episodeId: number;
  kind: TurnAnomalyKind;
  session: string;
  rig: string | null;
  openedAt: string;
  closedAt: string;
  reason: string;
}

export interface TurnAnomalySnapshot {
  scannedAt: string | null;
  windowMs: number;
  findings: TurnAnomalyFinding[];
  recentlyClosed: ClosedTurnEpisode[];
  /** Sessions seen but without enough sampled history to judge yet. Not a finding and not a coverage gap. */
  warming: number;
  coverage: { status: "complete" | "partial" | "unavailable"; examined: number; reason?: string };
}

interface DigestRow {
  native_session_id: string;
  seat_session: string;
  seat_name: string | null;
  node_logical_id: string | null;
  rig_name: string | null;
  generation_uuid: string | null;
  total_turns: number;
  conversation_turns: number;
  stall_patterns: string | null;
  ingested_at: string;
}

interface SampleRow { sampled_at: string; total_turns: number; conversation_turns: number }

interface EpisodeRow {
  id: number;
  native_session_id: string;
  subject_generation: string | null;
  seat_session: string;
  rig_name: string | null;
  kind: TurnAnomalyKind;
  role: TurnRole;
  opened_at: string;
  last_seen_at: string;
  closed_at: string | null;
  close_reason: string | null;
  evidence_json: string;
}

export type WindowVerdict =
  | { kind: TurnAnomalyKind; window: WindowEvidence }
  | { kind: null; reason: "below_threshold" | "insufficient_history" | "counter_reset" };

/**
 * Judge one window. Pure, so the threshold arithmetic is testable without a database.
 * `baseline` is the newest sample at or before the window start (or the oldest sample when history is shorter).
 */
export function judgeWindow(input: {
  role: TurnRole;
  thresholds: Record<TurnRole, number>;
  windowMs: number;
  now: number;
  current: { total: number; conversation: number };
  baseline: { at: number; total: number; conversation: number } | null;
}): WindowVerdict {
  const { baseline, current } = input;
  if (!baseline) return { kind: null, reason: "insufficient_history" };
  const assistantTurns = current.total - baseline.total;
  const userMessages = current.conversation - baseline.conversation;
  // A transcript that shrank (rewrite, compaction rebuild) invalidates the baseline.
  if (assistantTurns < 0 || userMessages < 0) return { kind: null, reason: "counter_reset" };
  const coveredMs = Math.min(input.windowMs, Math.max(0, input.now - baseline.at));
  if (coveredMs < input.windowMs * MIN_WINDOW_COVERAGE) return { kind: null, reason: "insufficient_history" };
  const threshold = input.thresholds[input.role];
  const window: WindowEvidence = {
    windowMs: input.windowMs,
    coveredMs,
    assistantTurns,
    userMessages,
    ratio: userMessages === 0 ? null : assistantTurns / userMessages,
    threshold,
  };
  // Multiply, never divide. With no user message there is no ratio, so the window is judged as if it held one:
  // it must exceed the role threshold, which keeps a nearly idle session from being flagged.
  if (userMessages === 0) {
    return assistantTurns > threshold ? { kind: "zero_conversation", window } : { kind: null, reason: "below_threshold" };
  }
  return assistantTurns > threshold * userMessages ? { kind: "high_ratio", window } : { kind: null, reason: "below_threshold" };
}

/** Role from an override or the seat's names. Orchestrator / reviewer / implementer names follow OpenRig's pod and member conventions. */
export function resolveTurnRole(
  row: { seat_session: string; seat_name: string | null; node_logical_id: string | null },
  overrides: Record<string, TurnRole>,
): TurnRole {
  const forced = overrides[row.seat_session] ?? (row.node_logical_id ? overrides[row.node_logical_id] : undefined);
  if (forced) return forced;
  const member = (row.seat_name ?? row.seat_session.split("@")[0] ?? "").toLowerCase();
  const logical = (row.node_logical_id ?? "").toLowerCase();
  const names = `${member} ${logical}`;
  if (/review/.test(names)) return "reviewer";
  if (/(^|[\s.\-_])(orch|orchestrator|lead)([\s.\-_]|$)/.test(names) || /^orch/.test(logical)) return "orchestrator";
  if (/(^|[\s.\-_])(impl|implementer|dev|builder|qa)([\s.\-_]|$)/.test(names) || /^dev/.test(logical)) return "implementer";
  return "other";
}

function parseStall(raw: string | null): StallCorroboration[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    const out: StallCorroboration[] = [];
    for (const p of v) {
      if (!p || typeof p !== "object") continue;
      const o = p as { type?: unknown; turnRange?: unknown; details?: unknown };
      if (typeof o.type !== "string") continue;
      const r = o.turnRange;
      const turnRange = Array.isArray(r) && r.length === 2 && typeof r[0] === "number" && typeof r[1] === "number"
        ? ([r[0], r[1]] as [number, number]) : null;
      out.push({ type: o.type, turnRange, details: o.details && typeof o.details === "object" ? (o.details as Record<string, unknown>) : {} });
    }
    return out;
  } catch { return []; }
}

export interface TurnAnomalyDetectorDeps {
  db: Database.Database;
  config?: Partial<TurnAnomalyConfig>;
  now?: () => Date;
}

export class TurnAnomalyDetector {
  readonly config: TurnAnomalyConfig;
  private readonly db: Database.Database;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastScan: { at: number; examined: number; warming: number; total: number; unavailable?: string } | null = null;

  constructor(deps: TurnAnomalyDetectorDeps) {
    this.db = deps.db;
    this.now = deps.now ?? (() => new Date());
    this.config = {
      windowMs: deps.config?.windowMs ?? DEFAULT_TURN_WINDOW_MS,
      thresholds: { ...DEFAULT_TURN_THRESHOLDS, ...(deps.config?.thresholds ?? {}) },
      roleOverrides: { ...(deps.config?.roleOverrides ?? {}) },
    };
  }

  /** Run `scan` on a timer. The timer never keeps the process alive, and a failed scan leaves the last snapshot in place. */
  start(intervalMs = TURN_ANOMALY_SCAN_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => { try { this.scan(); } catch { /* the next tick retries */ } }, intervalMs);
    this.timer.unref?.();
    try { this.scan(); } catch { /* first tick retries */ }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Scan unless a scan already ran within `maxAgeMs`; the watchdog policy and the timer share one pass. */
  scanIfStale(maxAgeMs = DEFAULT_SCAN_MAX_AGE_MS): void {
    if (this.lastScan && this.now().getTime() - this.lastScan.at < maxAgeMs) return;
    this.scan();
  }

  scan(): void {
    const nowDate = this.now();
    const now = nowDate.getTime();
    const nowIso = nowDate.toISOString();
    const { windowMs } = this.config;

    // The fleet-store tables come from migrations that a database may not carry. Without them there is nothing to
    // judge, and that must read as "not covered", never as "clear".
    const columns = new Set((this.db.prepare(`PRAGMA table_info(session_digests)`).all() as Array<{ name: string }>).map((c) => c.name));
    if (!columns.has("total_turns") || !columns.has("conversation_turns")) {
      this.lastScan = { at: now, examined: 0, warming: 0, total: 0, unavailable: "fleet store has no session_digests table; fleet migrations are not applied" };
      return;
    }
    // `stall_patterns` arrived in a later migration; corroboration is simply absent on a database that lacks it.
    const stallColumn = columns.has("stall_patterns") ? "d.stall_patterns" : "'[]' AS stall_patterns";

    // The current session of each seat is its newest digest. Older digests of the same seat are replaced sessions.
    const rows = this.db.prepare(`
      SELECT d.native_session_id, d.seat_session, d.seat_name, d.node_logical_id, d.rig_name, d.generation_uuid,
             d.total_turns, d.conversation_turns, ${stallColumn}, d.ingested_at
        FROM session_digests d
       WHERE d.id = (SELECT d2.id FROM session_digests d2 WHERE d2.seat_session = d.seat_session ORDER BY d2.ingested_at DESC, d2.id DESC LIMIT 1)
    `).all() as DigestRow[];

    const seenCurrent = new Set<string>();
    let examined = 0;
    let warming = 0;
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        const ingestedMs = Date.parse(row.ingested_at.includes("T") ? row.ingested_at : `${row.ingested_at.replace(" ", "T")}Z`);
        // A digest that stopped refreshing is a session that ended or a fleet feed that stalled: either way, it is no
        // longer evidence of a live runaway, so its episodes close instead of staying open forever.
        if (!Number.isFinite(ingestedMs) || now - ingestedMs > windowMs * STALE_DIGEST_WINDOWS) continue;
        seenCurrent.add(row.native_session_id);
        examined++;
        const verdict = this.evaluateSession(row, now, nowIso);
        if (verdict === "warming") warming++;
      }
      // Episodes whose subject is no longer a current, fresh session.
      const open = this.db.prepare(`SELECT id, native_session_id, seat_session FROM turn_anomaly_episodes WHERE closed_at IS NULL`)
        .all() as Array<{ id: number; native_session_id: string; seat_session: string }>;
      const currentBySeat = new Map(rows.map((r) => [r.seat_session, r.native_session_id]));
      for (const ep of open) {
        if (seenCurrent.has(ep.native_session_id)) continue;
        const replaced = currentBySeat.has(ep.seat_session) && currentBySeat.get(ep.seat_session) !== ep.native_session_id;
        this.closeEpisode(ep.id, nowIso, replaced ? "subject_replaced" : "digest_stale");
      }
      // Samples only matter inside the window; keep one extra window of slack for the baseline lookup.
      this.db.prepare(`DELETE FROM turn_anomaly_samples WHERE sampled_at < ?`).run(new Date(now - windowMs * 2).toISOString());
    });
    tx();
    this.lastScan = { at: now, examined, warming, total: rows.length };
  }

  private evaluateSession(row: DigestRow, now: number, nowIso: string): "judged" | "warming" {
    const { windowMs } = this.config;
    const role = resolveTurnRole(row, this.config.roleOverrides);
    const windowStart = new Date(now - windowMs).toISOString();

    const baselineRow = (this.db.prepare(`
      SELECT sampled_at, total_turns, conversation_turns FROM turn_anomaly_samples
       WHERE native_session_id = ? AND sampled_at <= ? ORDER BY sampled_at DESC LIMIT 1
    `).get(row.native_session_id, windowStart) as SampleRow | undefined)
      // History shorter than the window: the oldest sample stands in, and `judgeWindow` requires half the window.
      ?? (this.db.prepare(`
        SELECT sampled_at, total_turns, conversation_turns FROM turn_anomaly_samples
         WHERE native_session_id = ? ORDER BY sampled_at ASC LIMIT 1
      `).get(row.native_session_id) as SampleRow | undefined);

    const verdict = judgeWindow({
      role,
      thresholds: this.config.thresholds,
      windowMs,
      now,
      current: { total: row.total_turns, conversation: row.conversation_turns },
      baseline: baselineRow
        ? { at: Date.parse(baselineRow.sampled_at), total: baselineRow.total_turns, conversation: baselineRow.conversation_turns }
        : null,
    });

    if (verdict.kind === null && verdict.reason === "counter_reset") {
      this.db.prepare(`DELETE FROM turn_anomaly_samples WHERE native_session_id = ?`).run(row.native_session_id);
      this.closeSessionEpisodes(row.native_session_id, nowIso, "counter_reset");
    }
    this.recordSample(row, now, nowIso);

    if (verdict.kind === null) {
      if (verdict.reason === "below_threshold") this.closeSessionEpisodes(row.native_session_id, nowIso, "recovered");
      else if (verdict.reason === "insufficient_history") return "warming";
      return "judged";
    }

    // Kinds are exclusive; a switch closes the other kind's episode before the new one opens.
    this.closeSessionEpisodes(row.native_session_id, nowIso, "kind_changed", verdict.kind);
    const baselineTotal = row.total_turns - verdict.window.assistantTurns;
    const corroboration = parseStall(row.stall_patterns).filter((p) => p.turnRange === null || p.turnRange[1] > baselineTotal);
    const evidence = {
      window: verdict.window,
      lifetime: { assistantTurns: row.total_turns, userMessages: row.conversation_turns, zeroConversation: row.conversation_turns === 0 },
      corroboration,
    };
    const existing = this.db.prepare(`SELECT id FROM turn_anomaly_episodes WHERE native_session_id = ? AND kind = ? AND closed_at IS NULL`)
      .get(row.native_session_id, verdict.kind) as { id: number } | undefined;
    if (existing) {
      this.db.prepare(`UPDATE turn_anomaly_episodes SET last_seen_at = ?, role = ?, subject_generation = ?, evidence_json = ? WHERE id = ?`)
        .run(nowIso, role, row.generation_uuid, JSON.stringify(evidence), existing.id);
    } else {
      this.db.prepare(`
        INSERT INTO turn_anomaly_episodes
          (native_session_id, subject_generation, seat_session, rig_name, kind, role, opened_at, last_seen_at, evidence_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(row.native_session_id, row.generation_uuid, row.seat_session, row.rig_name, verdict.kind, role, nowIso, nowIso, JSON.stringify(evidence));
    }
    return "judged";
  }

  /** Write a sample when the counts moved, or when the newest one is older than a sixth of the window. */
  private recordSample(row: DigestRow, now: number, nowIso: string): void {
    const last = this.db.prepare(`
      SELECT sampled_at, total_turns, conversation_turns FROM turn_anomaly_samples
       WHERE native_session_id = ? ORDER BY sampled_at DESC LIMIT 1
    `).get(row.native_session_id) as SampleRow | undefined;
    const same = last && last.total_turns === row.total_turns && last.conversation_turns === row.conversation_turns;
    if (same && now - Date.parse(last.sampled_at) < this.config.windowMs / HEARTBEAT_DIVISOR) return;
    this.db.prepare(`INSERT INTO turn_anomaly_samples (native_session_id, sampled_at, total_turns, conversation_turns) VALUES (?, ?, ?, ?)`)
      .run(row.native_session_id, nowIso, row.total_turns, row.conversation_turns);
  }

  private closeSessionEpisodes(nativeSessionId: string, at: string, reason: string, exceptKind?: TurnAnomalyKind): void {
    const open = this.db.prepare(`SELECT id, kind FROM turn_anomaly_episodes WHERE native_session_id = ? AND closed_at IS NULL`)
      .all(nativeSessionId) as Array<{ id: number; kind: TurnAnomalyKind }>;
    for (const ep of open) if (ep.kind !== exceptKind) this.closeEpisode(ep.id, at, reason);
  }

  private closeEpisode(id: number, at: string, reason: string): void {
    this.db.prepare(`UPDATE turn_anomaly_episodes SET closed_at = ?, close_reason = ? WHERE id = ? AND closed_at IS NULL`).run(at, reason, id);
  }

  /** Cached episodes: reading never scans. `rigNames` limits the result to those rigs; omitted = every rig. */
  snapshot(opts: { rigNames?: readonly string[] } = {}): TurnAnomalySnapshot {
    const inRig = (rig: string | null) => !opts.rigNames || (rig !== null && opts.rigNames.includes(rig));
    const open = (this.db.prepare(`SELECT * FROM turn_anomaly_episodes WHERE closed_at IS NULL ORDER BY opened_at ASC, id ASC`).all() as EpisodeRow[])
      .filter((e) => inRig(e.rig_name));
    const cutoff = new Date(this.now().getTime() - RECENTLY_CLOSED_MS).toISOString();
    const closed = (this.db.prepare(`SELECT * FROM turn_anomaly_episodes WHERE closed_at IS NOT NULL AND closed_at >= ? ORDER BY closed_at DESC, id DESC`)
      .all(cutoff) as EpisodeRow[]).filter((e) => inRig(e.rig_name)).slice(0, RECENTLY_CLOSED_LIMIT);

    const findings: TurnAnomalyFinding[] = open.map((e) => {
      const ev = JSON.parse(e.evidence_json) as { window: WindowEvidence; lifetime: TurnAnomalyFinding["lifetime"]; corroboration: StallCorroboration[] };
      return {
        episodeId: e.id,
        kind: e.kind,
        session: e.seat_session,
        rig: e.rig_name,
        role: e.role,
        subject: { nativeSessionId: e.native_session_id, generation: e.subject_generation },
        window: ev.window,
        lifetime: ev.lifetime,
        corroboration: ev.corroboration,
        openedAt: e.opened_at,
        lastSeenAt: e.last_seen_at,
      };
    });

    const staleAfterMs = TURN_ANOMALY_SCAN_INTERVAL_MS * 5;
    let coverage: TurnAnomalySnapshot["coverage"];
    if (!this.lastScan) {
      coverage = { status: "unavailable", examined: 0, reason: "turn-anomaly detector has not scanned yet" };
    } else if (this.lastScan.unavailable) {
      coverage = { status: "unavailable", examined: 0, reason: this.lastScan.unavailable };
    } else if (this.now().getTime() - this.lastScan.at > staleAfterMs) {
      coverage = { status: "partial", examined: this.lastScan.examined, reason: "turn-anomaly scan is stale" };
    } else if (this.lastScan.examined === 0) {
      coverage = { status: "partial", examined: 0, reason: this.lastScan.total === 0 ? "fleet store holds no session digests" : "no session digest is fresh; fleet ingestion may be stalled" };
    } else {
      coverage = { status: "complete", examined: this.lastScan.examined };
    }

    return {
      scannedAt: this.lastScan ? new Date(this.lastScan.at).toISOString() : null,
      windowMs: this.config.windowMs,
      findings,
      recentlyClosed: closed.map((e) => ({
        episodeId: e.id, kind: e.kind, session: e.seat_session, rig: e.rig_name, openedAt: e.opened_at,
        closedAt: e.closed_at as string, reason: e.close_reason ?? "closed",
      })),
      warming: this.lastScan?.warming ?? 0,
      coverage,
    };
  }
}
