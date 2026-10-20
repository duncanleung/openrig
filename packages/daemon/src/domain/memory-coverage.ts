import type Database from "better-sqlite3";

// RIG-112 — live memory-delivery coverage, derived from the existing
// node.startup_delivery_manifest events (no new event types, read-only).
//
// Attribute names follow ADR-0009 (openrig.memory.*). The manifest carries four of the six
// attributes: surface, delivery_hint, content_hash, delivery_phase. authority_tier and token_cost
// are not in the manifest, so they are not reported.
//
// Two definitions the reader needs:
//  - delivery coverage = startups that delivered at least one memory file / startups
//    (a manifest is emitted only when something was delivered, so a startup with no manifest
//    delivered nothing).
//  - expected surfaces per seat = `expected` when the caller passes it; otherwise every surface
//    the seat received in any earlier startup in the window. The default finds a seat that LOST a
//    surface; it cannot find one that never had it, so pass `expected` for that check.
// "Sessions that touch memory surfaces" (observation coverage) comes from transcripts, not from
// manifests, so it stays in scripts/analyze-memory-usage.py and is reported here as unavailable.

export const MEMORY_ATTR = {
  surface: "openrig.memory.surface",
  deliveryPhase: "openrig.memory.delivery_phase",
  contentHash: "openrig.memory.content_hash",
  deliveryHint: "openrig.memory.delivery_hint",
} as const;

const MAX_MANIFEST_EVENTS = 20_000;

export interface MemoryCoverageOptions {
  /** Only events at or after this ISO timestamp. */
  since?: string;
  /** Only events of this rig. */
  rigId?: string;
  /** Surfaces every seat is expected to receive. Overrides the per-seat history default. */
  expected?: string[];
}

export interface DeliveredItem {
  [MEMORY_ATTR.surface]: string;
  [MEMORY_ATTR.deliveryHint]: string;
  [MEMORY_ATTR.contentHash]: string;
  [MEMORY_ATTR.deliveryPhase]: "startup";
  path: string;
  launchPhase: string;
}

export interface SeatCoverage {
  nodeId: string;
  sessionName: string;
  startups: number;
  latestAt: string;
  expectedSource: "caller" | "history";
  expected: string[];
  delivered: string[];
  missing: string[];
  /** delivered ∩ expected over expected; null when nothing is expected. */
  coverage: number | null;
  latest: DeliveredItem[];
}

export interface MemoryCoverageReport {
  window: { since: string | null; rigId: string | null };
  startups: number;
  startupsWithDelivery: number;
  deliveryCoverage: number | null;
  observationCoverage: { available: false; reason: string };
  seats: SeatCoverage[];
  seatsFullyDelivered: number;
  seatsWithMissing: number;
  truncated: boolean;
}

interface ManifestFile {
  path?: unknown; deliveryHint?: unknown; surface?: unknown; phase?: unknown; contentHash?: unknown;
}

function asString(v: unknown): string { return typeof v === "string" ? v : ""; }

export function computeMemoryCoverage(db: Database.Database, opts: MemoryCoverageOptions = {}): MemoryCoverageReport {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.since) { where.push("datetime(created_at) >= datetime(?)"); args.push(opts.since); }
  if (opts.rigId) { where.push("rig_id = ?"); args.push(opts.rigId); }
  const filter = where.length ? ` AND ${where.join(" AND ")}` : "";

  const startups = (db.prepare(`SELECT count(*) AS n FROM events WHERE type = 'node.startup_ready'${filter}`).get(...args) as { n: number }).n;
  const rows = db.prepare(
    `SELECT node_id, payload, created_at FROM events WHERE type = 'node.startup_delivery_manifest'${filter} ORDER BY seq DESC LIMIT ?`,
  ).all(...args, MAX_MANIFEST_EVENTS + 1) as Array<{ node_id: string | null; payload: string; created_at: string }>;
  const truncated = rows.length > MAX_MANIFEST_EVENTS;
  const manifests = (truncated ? rows.slice(0, MAX_MANIFEST_EVENTS) : rows).reverse(); // oldest first

  const bySeat = new Map<string, Array<{ at: string; sessionName: string; files: ManifestFile[] }>>();
  let withDelivery = 0;
  for (const row of manifests) {
    let payload: { sessionName?: unknown; deliveredFiles?: unknown };
    try { payload = JSON.parse(row.payload); } catch { continue; }
    const files = Array.isArray(payload.deliveredFiles) ? payload.deliveredFiles as ManifestFile[] : [];
    if (files.length > 0) withDelivery += 1;
    const key = row.node_id ?? asString(payload.sessionName);
    if (!key) continue;
    const list = bySeat.get(key) ?? [];
    list.push({ at: row.created_at, sessionName: asString(payload.sessionName), files });
    bySeat.set(key, list);
  }

  const callerExpected = opts.expected && opts.expected.length > 0 ? [...new Set(opts.expected)].sort() : null;
  const seats: SeatCoverage[] = [];
  for (const [nodeId, list] of bySeat) {
    const latest = list[list.length - 1]!;
    const surfacesOf = (files: ManifestFile[]) => new Set(files.map((f) => asString(f.surface)).filter(Boolean));
    const delivered = [...surfacesOf(latest.files)].sort();
    let expected: string[];
    if (callerExpected) {
      expected = callerExpected;
    } else {
      const seen = new Set<string>();
      for (const m of list) for (const s of surfacesOf(m.files)) seen.add(s);
      expected = [...seen].sort();
    }
    const missing = expected.filter((s) => !delivered.includes(s));
    seats.push({
      nodeId,
      sessionName: latest.sessionName,
      startups: list.length,
      latestAt: latest.at,
      expectedSource: callerExpected ? "caller" : "history",
      expected,
      delivered,
      missing,
      coverage: expected.length === 0 ? null : (expected.length - missing.length) / expected.length,
      latest: latest.files.map((f) => ({
        [MEMORY_ATTR.surface]: asString(f.surface),
        [MEMORY_ATTR.deliveryHint]: asString(f.deliveryHint),
        [MEMORY_ATTR.contentHash]: asString(f.contentHash),
        [MEMORY_ATTR.deliveryPhase]: "startup" as const,
        path: asString(f.path),
        launchPhase: asString(f.phase),
      })),
    });
  }
  seats.sort((a, b) => a.sessionName.localeCompare(b.sessionName) || a.nodeId.localeCompare(b.nodeId));

  return {
    window: { since: opts.since ?? null, rigId: opts.rigId ?? null },
    startups,
    startupsWithDelivery: withDelivery,
    deliveryCoverage: startups === 0 ? null : Math.min(1, withDelivery / startups),
    observationCoverage: {
      available: false,
      reason: "Sessions that touch memory surfaces are measured from transcripts (scripts/analyze-memory-usage.py in openrig-memory), not from delivery manifests.",
    },
    seats,
    seatsFullyDelivered: seats.filter((s) => s.missing.length === 0).length,
    seatsWithMissing: seats.filter((s) => s.missing.length > 0).length,
    truncated,
  };
}
