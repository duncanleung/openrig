// RIG-77 — validation-gate enforcer tests.
//
// Tests the pure checkValidationGate() function and the
// createValidationGatePredicate() factory across the key behavioral axes:
// off/warn/enforce mode, evidence found vs. absent, work:mechanical bypass
// (M2), and viaWorkflow bypass (M3).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import {
  checkValidationGate,
  createValidationGatePredicate,
  WORK_MECHANICAL_TAG,
} from "../src/domain/validation-gate-enforcer.js";
import type { ValidationGateConfig } from "../src/domain/validation-gate-predicate.js";

function buildDb(): Database.Database {
  const db = createDb(":memory:");
  migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema]);
  return db;
}

function seedEvidence(db: Database.Database, actorSession: string): void {
  const qitemId = "qi-gate-001";
  const ts = new Date().toISOString();
  db.prepare(`
    INSERT INTO queue_items
      (qitem_id, ts_created, ts_updated, source_session, destination_session,
       state, priority, tags, body)
    VALUES (?, ?, ?, 'src@rig', 'dst@rig', 'done', 'routine', ?, '')
  `).run(qitemId, ts, ts, JSON.stringify(["gate:validation"]));
  db.prepare(`
    INSERT INTO queue_transitions
      (qitem_id, state, actor_session, ts)
    VALUES (?, 'done', ?, ?)
  `).run(qitemId, actorSession, ts);
}

const BASE_CONFIG: ValidationGateConfig = {
  mode: "enforce",
  validators: ["advisor@*"],
  implSeats: ["dev.impl"],
};

describe("checkValidationGate", () => {
  let db: Database.Database;

  beforeEach(() => { db = buildDb(); });
  afterEach(() => { db.close(); });

  it("off mode — always ok regardless of evidence", () => {
    const result = checkValidationGate({
      db,
      config: { ...BASE_CONFIG, mode: "off" },
      input: { destinationLogicalId: "dev.impl", tags: [] },
    });
    expect(result.ok).toBe(true);
  });

  it("warn mode — ok even when no evidence (warning logged)", () => {
    const warnings: string[] = [];
    const result = checkValidationGate({
      db,
      config: { ...BASE_CONFIG, mode: "warn" },
      input: { destinationLogicalId: "dev.impl", tags: [] },
      onWarn: (msg) => warnings.push(msg),
    });
    expect(result.ok).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("[validation-gate] WARNING");
  });

  it("enforce mode — ok:false when evidence absent", () => {
    const result = checkValidationGate({
      db,
      config: BASE_CONFIG,
      input: { destinationLogicalId: "dev.impl", tags: [] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("validation_gate_missing");
      expect(result.message).toContain("dev.impl");
    }
  });

  it("enforce mode — ok:true when gate:validation qitem closed by matching validator", () => {
    seedEvidence(db, "advisor@openrig");
    const result = checkValidationGate({
      db,
      config: BASE_CONFIG,
      input: { destinationLogicalId: "dev.impl", tags: [] },
    });
    expect(result.ok).toBe(true);
  });

  it("M2 work:mechanical bypass — ok:true in enforce mode, bypass audited", () => {
    const bypasses: string[] = [];
    const result = checkValidationGate({
      db,
      config: BASE_CONFIG,
      input: { destinationLogicalId: "dev.impl", tags: [WORK_MECHANICAL_TAG] },
      onBypass: (msg) => bypasses.push(msg),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reason).toBe("bypassed:mechanical");
    expect(bypasses).toHaveLength(1);
  });

  it("M3 viaWorkflow bypass — ok:true in enforce mode", () => {
    const result = checkValidationGate({
      db,
      config: BASE_CONFIG,
      input: { destinationLogicalId: "dev.impl", tags: [], viaWorkflow: true },
    });
    expect(result.ok).toBe(true);
  });
});
