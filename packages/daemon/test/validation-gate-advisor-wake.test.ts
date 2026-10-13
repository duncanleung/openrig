// RIG-77 — the validation gate wakes the advisor on demand: one deduplicated request
// qitem per blocked dispatch, written after the gate decision (no poll loop).

import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { createValidationGatePredicate } from "../src/domain/validation-gate-enforcer.js";
import type { ValidationGateConfig } from "../src/domain/validation-gate-predicate.js";

const CONFIG: ValidationGateConfig = { mode: "enforce", validators: ["advisor@*"], implSeats: ["dev.impl"] };

function seedSeat(db: Database.Database, rigId: string, logicalId: string, sessionName: string): void {
  db.prepare("INSERT OR IGNORE INTO rigs (id, name) VALUES (?, ?)").run(rigId, rigId);
  db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)").run(`node-${logicalId}`, rigId, logicalId);
  db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, 'running')")
    .run(`sess-${logicalId}`, `node-${logicalId}`, sessionName);
}

describe("validation gate — advisor wake (RIG-77)", () => {
  let db: Database.Database;
  const build = (config: ValidationGateConfig) =>
    new QueueRepository(db, new EventBus(db), { validationGatePredicate: createValidationGatePredicate(db, () => config) });
  const requests = () =>
    db.prepare("SELECT destination_session, state, tags FROM queue_items WHERE tags LIKE '%gate:validation-request%'").all() as Array<{
      destination_session: string; state: string; tags: string;
    }>;
  const dispatch = (repo: QueueRepository) =>
    repo.create({ sourceSession: "orch-lead@rig", destinationSession: "dev-impl@rig", body: "implement the plan" });

  beforeEach(() => {
    db = createFullTestDb();
    seedSeat(db, "rig", "dev.impl", "dev-impl@rig");
  });
  afterEach(() => db.close());

  it("a blocked dispatch creates exactly one pending request row for the advisor", async () => {
    seedSeat(db, "rig", "orch.advisor", "advisor@rig");
    await expect(dispatch(build(CONFIG))).rejects.toMatchObject({ code: "validation_gate_missing" });
    const rows = requests();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.destination_session).toBe("advisor@rig");
    expect(rows[0]!.state).toBe("pending");
    expect(JSON.parse(rows[0]!.tags)).toEqual(expect.arrayContaining(["gate:validation-request", expect.stringMatching(/^gate-for:create:/)]));
  });

  it("repeating the same blocked dispatch is idempotent", async () => {
    seedSeat(db, "rig", "orch.advisor", "advisor@rig");
    const repo = build(CONFIG);
    await expect(dispatch(repo)).rejects.toMatchObject({ code: "validation_gate_missing" });
    await expect(dispatch(repo)).rejects.toMatchObject({ code: "validation_gate_missing" });
    expect(requests()).toHaveLength(1);
  });

  it("warn mode lets the dispatch through and still wakes the advisor once", async () => {
    seedSeat(db, "rig", "orch.advisor", "advisor@rig");
    const item = await dispatch(build({ ...CONFIG, mode: "warn" }));
    expect(item.destinationSession).toBe("dev-impl@rig");
    expect(requests()).toHaveLength(1);
  });

  it("createWithinTransaction (workflow / mission-control path) wakes the advisor after the caller's transaction", async () => {
    seedSeat(db, "rig", "orch.advisor", "advisor@rig");
    const repo = build(CONFIG);
    const input = { sourceSession: "orch-lead@rig", destinationSession: "dev-impl@rig", body: "implement the plan" };
    expect(() => db.transaction(() => repo.createWithinTransaction(input))()).toThrowError(/validation/i);
    expect(requests()).toHaveLength(0);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(requests()).toHaveLength(1);
  });

  it("no advisor seat running: the gate still blocks, with no request row", async () => {
    await expect(dispatch(build(CONFIG))).rejects.toMatchObject({ code: "validation_gate_missing" });
    expect(requests()).toHaveLength(0);
  });

  it("off mode creates nothing", async () => {
    seedSeat(db, "rig", "orch.advisor", "advisor@rig");
    const item = await dispatch(build({ ...CONFIG, mode: "off" }));
    expect(item.destinationSession).toBe("dev-impl@rig");
    expect(requests()).toHaveLength(0);
  });

  describe("config source: rig spec file (no spec_json column)", () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "vg-spec-")); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
    const realRepo = () => new QueueRepository(db, new EventBus(db), { validationGatePredicate: createValidationGatePredicate(db) });
    const writeSpec = (body: string) => {
      const file = nodePath.join(dir, "rig.yaml");
      fs.writeFileSync(file, body);
      db.prepare("INSERT INTO bootstrap_runs (id, source_kind, source_ref, status, rig_id) VALUES ('b1', 'rig_spec', ?, 'completed', 'rig')").run(file);
    };

    it("enforces validation_gate read from the spec file and wakes the advisor", async () => {
      expect(() => db.prepare("SELECT spec_json FROM rigs").all()).toThrow();
      seedSeat(db, "rig", "orch.advisor", "advisor@rig");
      writeSpec("name: rig\nvalidation_gate:\n  mode: enforce\n  validators: ['advisor@*']\n  impl_seats: [dev.impl]\n");
      await expect(dispatch(realRepo())).rejects.toMatchObject({ code: "validation_gate_missing" });
      expect(requests()).toHaveLength(1);
    });

    it("a missing spec file means no gate", async () => {
      db.prepare("INSERT INTO bootstrap_runs (id, source_kind, source_ref, status, rig_id) VALUES ('b2', 'rig_spec', ?, 'completed', 'rig')").run(nodePath.join(dir, "gone.yaml"));
      const item = await dispatch(realRepo());
      expect(item.destinationSession).toBe("dev-impl@rig");
    });

    it("a spec without a validation_gate block means no gate", async () => {
      writeSpec("name: rig\n");
      const item = await dispatch(realRepo());
      expect(item.destinationSession).toBe("dev-impl@rig");
    });
  });
});
