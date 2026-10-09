/**
 * Validation-gate enforcer (RIG-77).
 *
 * Pure domain validator — sibling of human-route-enforcer.ts. Called inline
 * from QueueRepository write paths before a qitem is dispatched to an
 * impl-seat. Throws QueueRepositoryError when evidence is missing in enforce
 * mode; logs in warn mode; no-ops in off mode.
 *
 * Trigger: destination matches an impl-seat pattern AND the qitem is NOT
 * tagged work:mechanical.
 *
 * M1 — evidence must come from a CLOSER matching the configured validator
 * pattern, not just 'any different seat'.
 *
 * M2 — work:mechanical bypass is explicit and auditable. Strip work:mechanical
 * from inherited tags in handoff chains (queue-repository.ts handles this).
 *
 * M3 — workflow projection is exempt via the viaWorkflow flag (same pattern
 * as workflowFrontierPredicate bypass).
 */

import type Database from "better-sqlite3";
import type { ValidationGateConfig } from "./validation-gate-predicate.js";
import {
  matchesImplSeatPattern,
  matchesValidatorPattern,
  findValidationEvidence,
  resolveEffectiveMode,
} from "./validation-gate-predicate.js";

export { ValidationGateConfig };

export const WORK_MECHANICAL_TAG = "work:mechanical";

export interface ValidationGateCheckInput {
  /** Logical id of the destination seat (e.g. "dev.impl"). */
  destinationLogicalId: string | null;
  /** Tags on the qitem being dispatched. */
  tags: string[] | null | undefined;
  /** True when called from a workflow projection path — exempt from the gate. */
  viaWorkflow?: boolean;
  /** True when the bypass tag audit has already been logged this call. */
  bypassAlreadyLogged?: boolean;
}

export interface ValidationGateOk {
  ok: true;
  /** "bypassed:mechanical" when the work:mechanical tag was present. */
  reason?: string;
}

export interface ValidationGateErr {
  ok: false;
  code: "validation_gate_missing";
  message: string;
  meta: { what: string; why: string; fix: string };
}

export type ValidationGateResult = ValidationGateOk | ValidationGateErr;

export interface ValidationGateCheckOpts {
  db: Database.Database;
  config: ValidationGateConfig;
  input: ValidationGateCheckInput;
  /** Called when the gate emits a warning log line. */
  onWarn?: (message: string) => void;
  /** Called when the work:mechanical bypass fires (M2 audit). */
  onBypass?: (message: string) => void;
}

/**
 * Check whether validation evidence exists for a dispatch to an impl-seat.
 * Returns ok:true when the gate does not fire, the evidence exists, or the
 * item carries work:mechanical. Returns ok:false only in enforce mode when
 * evidence is absent.
 */
export function checkValidationGate(opts: ValidationGateCheckOpts): ValidationGateResult {
  const { db, config, input, onWarn, onBypass } = opts;

  const effectiveMode = resolveEffectiveMode(config);
  if (effectiveMode === "off") return { ok: true };

  // Gate only fires for impl-seat destinations.
  if (!input.destinationLogicalId) return { ok: true };
  if (!matchesImplSeatPattern(config.implSeats, input.destinationLogicalId)) return { ok: true };

  // Workflow projection is exempt (M3).
  if (input.viaWorkflow) return { ok: true };

  // work:mechanical bypass (M2): explicit opt-out, auditable.
  const tags = input.tags ?? [];
  if (tags.includes(WORK_MECHANICAL_TAG)) {
    const msg = `[validation-gate] bypass: work:mechanical tag on dispatch to ${input.destinationLogicalId}`;
    onBypass?.(msg);
    return { ok: true, reason: "bypassed:mechanical" };
  }

  // Look up evidence.
  const evidence = findValidationEvidence(db, config);
  if (evidence.found) return { ok: true };

  // Evidence absent.
  const what = `Dispatch to impl-seat '${input.destinationLogicalId}' has no validation evidence`;
  const why = `No done gate:validation qitem closed by a configured validator (${config.validators.join(", ")}) was found in the queue`;
  const fix = `Run /codex-second-opinion or /symmetric-debate, close the gate:validation qitem as done from a validator seat, then re-dispatch`;

  if (effectiveMode === "warn") {
    onWarn?.(`[validation-gate] WARNING: ${what}. ${why}. ${fix}`);
    return { ok: true };
  }

  // enforce mode — reject.
  return {
    ok: false,
    code: "validation_gate_missing",
    message: `${what}. ${why}. ${fix}.`,
    meta: { what, why, fix },
  };
}

/**
 * Factory for the injected predicate that startup wires into QueueRepository.
 *
 * The returned function lazily reads the current rig's validation_gate config
 * from the database on each call. When no rig has a validation_gate block the
 * predicate is a no-op, preserving pre-RIG-77 behavior for all existing rigs.
 *
 * Destination resolution: the predicate receives the raw destinationSession
 * (e.g. "dev-impl@openrig"). It queries the nodes table to get the logical_id
 * for that session, then delegates to matchesImplSeatPattern. When no node
 * record is found the gate is skipped (conservative: unknown destination is
 * not treated as an impl-seat).
 */
export function createValidationGatePredicate(
  db: Database.Database,
): (input: { destinationSession: string; tags: string[] | null; viaWorkflowProjection?: boolean }) => ValidationGateResult {
  return (input): ValidationGateResult => {
    let config: ValidationGateConfig | null = null;
    try {
      const row = db.prepare(`
        SELECT r.spec_json
          FROM rigs r
         WHERE r.spec_json IS NOT NULL
           AND r.archived_at IS NULL
         ORDER BY r.created_at DESC
         LIMIT 1
      `).get() as { spec_json: string } | undefined;
      if (!row) return { ok: true };
      const spec = JSON.parse(row.spec_json) as Record<string, unknown>;
      const vg = spec["validation_gate"] as Record<string, unknown> | undefined;
      if (!vg) return { ok: true };
      config = {
        mode: (vg["mode"] as ValidationGateConfig["mode"]) ?? "warn",
        validators: (vg["validators"] as string[]) ?? [],
        implSeats: (vg["impl_seats"] as string[]) ?? [],
        warnUntil: vg["warn_until"] as string | undefined,
      };
    } catch {
      return { ok: true };
    }

    // Resolve the logical_id for this destination session.
    let destinationLogicalId: string | null = null;
    try {
      const node = db.prepare(`
        SELECT n.logical_id
          FROM nodes n
          JOIN sessions s ON s.node_id = n.id
         WHERE s.session_name = ?
         LIMIT 1
      `).get(input.destinationSession) as { logical_id: string } | undefined;
      destinationLogicalId = node?.logical_id ?? null;
    } catch {
      return { ok: true };
    }

    if (!destinationLogicalId) return { ok: true };
    if (!matchesImplSeatPattern(config.implSeats, destinationLogicalId)) return { ok: true };
    if (input.viaWorkflowProjection) return { ok: true };

    const tags = input.tags ?? [];
    if (tags.includes("work:mechanical")) {
      console.log(`[validation-gate] bypass: work:mechanical tag on dispatch to ${destinationLogicalId}`);
      return { ok: true, reason: "bypassed:mechanical" };
    }

    const evidence = findValidationEvidence(db, config);
    if (evidence.found) return { ok: true };

    const effectiveMode = resolveEffectiveMode(config);
    if (effectiveMode === "off") return { ok: true };

    const what = `Dispatch to impl-seat '${destinationLogicalId}' has no validation evidence`;
    const why = `No done gate:validation qitem closed by a configured validator (${config.validators.join(", ")}) was found in the queue`;
    const fix = `Run /codex-second-opinion or /symmetric-debate, close the gate:validation qitem as done from a validator seat, then re-dispatch`;

    if (effectiveMode === "warn") {
      console.warn(`[validation-gate] WARNING: ${what}. ${why}. ${fix}`);
      return { ok: true };
    }

    return {
      ok: false,
      code: "validation_gate_missing",
      message: `${what}. ${why}. ${fix}.`,
      meta: { what, why, fix },
    };
  };
}
