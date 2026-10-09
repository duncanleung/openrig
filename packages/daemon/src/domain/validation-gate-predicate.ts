/**
 * Validation-gate evidence lookup (RIG-77).
 *
 * Checks whether a done gate:validation qitem exists whose CLOSER matches the
 * rig's configured validator seat pattern. The CLOSER must match — not just
 * 'any different seat' — so a self-close cannot forge evidence (M1).
 */

import type Database from "better-sqlite3";

export interface ValidationGateConfig {
  /** "off" | "warn" | "enforce" — default "warn" */
  mode: "off" | "warn" | "enforce";
  /** Glob-style patterns accepted as validator seats (e.g. ["advisor@*"]). */
  validators: string[];
  /** Logical-id patterns that trigger the gate (e.g. ["dev.impl"]). */
  implSeats: string[];
  /** ISO date string; when set and today >= this date, mode auto-promotes to "enforce". */
  warnUntil?: string;
}

export interface ValidationGateEvidence {
  found: boolean;
  /** The closing qitem id, or null when not found. */
  gateQitemId: string | null;
  /** The closer session that matched a validator pattern, or null. */
  closerSession: string | null;
}

/** Simple glob: only * wildcard, anchored to whole string. */
function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(
    "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
  );
  return re.test(value);
}

/** True when the sessionRef matches any of the configured validator patterns. */
export function matchesValidatorPattern(validators: string[], sessionRef: string): boolean {
  return validators.some((p) => globMatch(p, sessionRef));
}

/** True when the logical_id matches any impl-seat pattern. */
export function matchesImplSeatPattern(implSeats: string[], logicalId: string): boolean {
  return implSeats.some((p) => globMatch(p, logicalId));
}

/**
 * Look up gate:validation evidence for a pending dispatch.
 * Queries queue_items for a done qitem tagged gate:validation whose most recent
 * done-transition actor_session matches a configured validator pattern.
 */
export function findValidationEvidence(
  db: Database.Database,
  config: ValidationGateConfig,
): ValidationGateEvidence {
  const hasTransitions = (
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='queue_transitions'",
      )
      .get() as { c: number }
  ).c > 0;
  if (!hasTransitions) return { found: false, gateQitemId: null, closerSession: null };

  // Fetch done qitems that carry any tags (JSON), then filter in JS for gate:validation
  // and a matching validator actor. Limit to recent 200 rows to stay bounded.
  const candidates = db.prepare(`
    SELECT qi.qitem_id, qi.tags, qt.actor_session
      FROM queue_items qi
      JOIN queue_transitions qt ON qt.qitem_id = qi.qitem_id
     WHERE qi.state = 'done'
       AND qi.tags IS NOT NULL
       AND qt.state = 'done'
     ORDER BY qt.ts DESC
     LIMIT 200
  `).all() as Array<{ qitem_id: string; tags: string; actor_session: string }>;

  for (const row of candidates) {
    let tags: string[] = [];
    try {
      tags = JSON.parse(row.tags);
    } catch {
      /* skip malformed */
    }
    if (!Array.isArray(tags) || !tags.includes("gate:validation")) continue;
    if (matchesValidatorPattern(config.validators, row.actor_session)) {
      return { found: true, gateQitemId: row.qitem_id, closerSession: row.actor_session };
    }
  }
  return { found: false, gateQitemId: null, closerSession: null };
}

/**
 * Resolve the effective mode, auto-promoting warn → enforce after warnUntil.
 */
export function resolveEffectiveMode(
  config: ValidationGateConfig,
): "off" | "warn" | "enforce" {
  if (config.mode === "warn" && config.warnUntil) {
    const today = new Date().toISOString().slice(0, 10);
    if (today >= config.warnUntil) return "enforce";
  }
  return config.mode;
}
