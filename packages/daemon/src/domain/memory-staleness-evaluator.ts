import type Database from "better-sqlite3";
import type { EventBus } from "./event-bus.js";

export interface StalenessThreshold {
  staleAfterSessions: number;
  weight: number;
  implicitAccess: boolean;
}

export const DEFAULT_THRESHOLDS: Record<string, StalenessThreshold> = {
  guidance: { staleAfterSessions: 15, weight: 0.4, implicitAccess: true },
  skill: { staleAfterSessions: 15, weight: 0.4, implicitAccess: true },
  role: { staleAfterSessions: 15, weight: 0.6, implicitAccess: true },
  wiki: { staleAfterSessions: 5, weight: 1.0, implicitAccess: false },
  adr: { staleAfterSessions: 10, weight: 0.8, implicitAccess: false },
  "restore-packet": { staleAfterSessions: 2, weight: 0.5, implicitAccess: false },
  "context-pack": { staleAfterSessions: 7, weight: 0.8, implicitAccess: false },
  other: { staleAfterSessions: 5, weight: 1.0, implicitAccess: false },
};

interface ManifestRow {
  payload: string;
  created_at: string;
}

interface SurfaceDeliveryStats {
  delivered: number;
  firstDelivered: string | null;
  lastDelivered: string | null;
}

export interface StalenessResult {
  surface: string;
  delivered: number;
  deliveryRate: number;
  staleness: "fresh" | "aging" | "stale";
  score: number;
}

export interface DecayRecommendation {
  action: "review" | "archive" | "promote" | "demote";
  surface: string;
  reason: string;
}

export interface EvaluationResult {
  evaluatedAt: string;
  sessionWindow: number;
  totalStartups: number;
  totalManifests: number;
  surfaces: StalenessResult[];
  recommendations: DecayRecommendation[];
}

export interface MemoryStalenessEvaluatorDeps {
  db: Database.Database;
  eventBus?: EventBus;
  thresholds?: Record<string, StalenessThreshold>;
}

export class MemoryStalenessEvaluator {
  private readonly db: Database.Database;
  private readonly eventBus?: EventBus;
  private readonly thresholds: Record<string, StalenessThreshold>;

  constructor(deps: MemoryStalenessEvaluatorDeps) {
    this.db = deps.db;
    this.eventBus = deps.eventBus;
    this.thresholds = deps.thresholds ?? DEFAULT_THRESHOLDS;
  }

  evaluate(rigId: string, sessionWindow: number = 10): EvaluationResult {
    const totalStartups = this.countStartups(rigId);
    const manifests = this.queryManifests(rigId, sessionWindow);
    const totalManifests = manifests.length;

    const surfaceStats = this.aggregateSurfaceDelivery(manifests);
    const surfaces = this.scoreSurfaces(surfaceStats, totalManifests, sessionWindow);
    const recommendations = this.generateRecommendations(surfaces, surfaceStats);

    return {
      evaluatedAt: new Date().toISOString(),
      sessionWindow,
      totalStartups,
      totalManifests,
      surfaces,
      recommendations,
    };
  }

  evaluateAndEmit(rigId: string, sessionWindow: number = 10): EvaluationResult {
    const result = this.evaluate(rigId, sessionWindow);
    if (this.eventBus) {
      this.eventBus.emit({
        type: "memory.staleness_evaluated",
        rigId,
        evaluatedAt: result.evaluatedAt,
        sessionWindow,
        surfaces: result.surfaces,
        recommendations: result.recommendations,
      });
    }
    return result;
  }

  private countStartups(rigId: string): number {
    const row = this.db.prepare(
      "SELECT count(*) as cnt FROM events WHERE rig_id = ? AND type = 'node.startup_ready'"
    ).get(rigId) as { cnt: number };
    return row.cnt;
  }

  private queryManifests(rigId: string, limit: number): ManifestRow[] {
    return this.db.prepare(
      "SELECT payload, created_at FROM events " +
      "WHERE rig_id = ? AND type = 'node.startup_delivery_manifest' " +
      "ORDER BY created_at DESC LIMIT ?"
    ).all(rigId, limit) as ManifestRow[];
  }

  private aggregateSurfaceDelivery(manifests: ManifestRow[]): Map<string, SurfaceDeliveryStats> {
    const stats = new Map<string, SurfaceDeliveryStats>();

    for (const row of manifests) {
      let payload: {
        summary?: { surfaceCounts?: Record<string, number> };
      };
      try {
        payload = JSON.parse(row.payload);
      } catch {
        continue;
      }

      const surfaceCounts = payload.summary?.surfaceCounts ?? {};
      for (const [surface, count] of Object.entries(surfaceCounts)) {
        const existing = stats.get(surface) ?? {
          delivered: 0,
          firstDelivered: null,
          lastDelivered: null,
        };
        existing.delivered += count;
        if (!existing.lastDelivered || row.created_at > existing.lastDelivered) {
          existing.lastDelivered = row.created_at;
        }
        if (!existing.firstDelivered || row.created_at < existing.firstDelivered) {
          existing.firstDelivered = row.created_at;
        }
        stats.set(surface, existing);
      }
    }

    return stats;
  }

  private scoreSurfaces(
    stats: Map<string, SurfaceDeliveryStats>,
    totalManifests: number,
    sessionWindow: number,
  ): StalenessResult[] {
    const results: StalenessResult[] = [];

    for (const [surface, delivery] of stats) {
      const threshold = this.thresholds[surface] ?? DEFAULT_THRESHOLDS.other;
      const deliveryRate = delivery.delivered / Math.max(totalManifests, 1);

      let score: number;
      if (threshold.implicitAccess) {
        // Implicitly consumed surfaces: delivery = access.
        // Score based on delivery consistency, not access.
        const consistency = Math.min(deliveryRate / sessionWindow, 1.0);
        score = Math.round((1.0 - consistency) * threshold.weight * 1000) / 1000;
      } else {
        // Explicitly accessed surfaces: without transcript data,
        // use delivery-only heuristic — surfaces delivered but with
        // decreasing frequency are aging.
        const sessionsSinceDelivery = totalManifests > 0 ? 0 : sessionWindow;
        const frequencyScore = 1.0 - Math.min(deliveryRate / sessionWindow, 1.0);
        score = Math.round(frequencyScore * threshold.weight * 1000) / 1000;
      }

      let staleness: "fresh" | "aging" | "stale";
      if (score >= 0.7) staleness = "stale";
      else if (score >= 0.4) staleness = "aging";
      else staleness = "fresh";

      results.push({ surface, delivered: delivery.delivered, deliveryRate, staleness, score });
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  private generateRecommendations(
    surfaces: StalenessResult[],
    stats: Map<string, SurfaceDeliveryStats>,
  ): DecayRecommendation[] {
    const recommendations: DecayRecommendation[] = [];

    for (const s of surfaces) {
      if (s.staleness === "stale") {
        const threshold = this.thresholds[s.surface] ?? DEFAULT_THRESHOLDS.other;
        if (threshold.implicitAccess) {
          recommendations.push({
            action: "review",
            surface: s.surface,
            reason: `${s.surface} delivery inconsistent (score ${s.score}) — verify content is still relevant`,
          });
        } else {
          recommendations.push({
            action: "archive",
            surface: s.surface,
            reason: `${s.surface} delivered ${s.delivered}x but not accessed — candidate for archival`,
          });
        }
      }

      // Promotion gate: surfaces delivered in every manifest are candidates
      // for promotion to a higher-authority tier.
      const delivery = stats.get(s.surface);
      if (delivery && s.staleness === "fresh" && s.delivered > 3) {
        const threshold = this.thresholds[s.surface];
        if (threshold && !threshold.implicitAccess && s.surface === "wiki") {
          recommendations.push({
            action: "promote",
            surface: s.surface,
            reason: `${s.surface} consistently delivered and accessed — evaluate for promotion to guidance`,
          });
        }
      }
    }

    return recommendations;
  }
}
