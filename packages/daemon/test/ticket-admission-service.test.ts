// RIG-87 — durable ticket admission: identity, dedup, capacity, restart recovery,
// external-state reconciliation, immutable evidence.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { workflowInstancesSchema } from "../src/db/migrations/034_workflow_instances.js";
import { workflowStepTrailsSchema } from "../src/db/migrations/035_workflow_step_trails.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemEvidenceRefSchema } from "../src/db/migrations/048_queue_item_evidence_ref.js";
import { workflowInstanceVersionSchema } from "../src/db/migrations/049_workflow_instance_version.js";
import { workflowSpecJsonSchema } from "../src/db/migrations/050_workflow_spec_json.js";
import { missionControlActionsSchema } from "../src/db/migrations/037_mission_control_actions.js";
import { ticketAdmissionsSchema } from "../src/db/migrations/104_ticket_admissions.js";
import { ticketFactoryControlSchema } from "../src/db/migrations/105_ticket_factory_control.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import {
  TicketAdmissionService,
  type AdmissionDisposition,
  type AdmissionEvidence,
} from "../src/domain/ticket-admission-service.js";

const SPEC = resolve(import.meta.dirname, "../src/builtins/workflow-specs/ticket-factory.yaml");
const MIGRATIONS = [
  outboxEntriesSchema, coreSchema, bindingsSessionsSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema,
  workflowSpecsSchema, workflowInstancesSchema, workflowStepTrailsSchema, queueItemSummarySchema,
  queueItemEvidenceRefSchema, workflowInstanceVersionSchema, workflowSpecJsonSchema, missionControlActionsSchema,
  ticketAdmissionsSchema, ticketFactoryControlSchema,
];

describe("ticket admission service (RIG-87)", () => {
  let tmp: string;
  let file: string;
  let db: Database.Database;
  let runtime: WorkflowRuntime;
  let disposition: AdmissionDisposition;
  let clock: number;

  const boot = () => {
    db = createDb(file);
    migrate(db, MIGRATIONS);
    const bus = new EventBus(db);
    const queue = new QueueRepository(db, bus, { validateRig: () => true });
    queue.attachOutbox(new OutboxHandler(db));
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue });
    return new TicketAdmissionService({
      db,
      runtime,
      specPath: SPEC,
      createdBySession: "orch-lead@openrig",
      now: () => new Date(Date.UTC(2026, 9, 14, 0, 0, clock++)),
      runChecks: async (): Promise<AdmissionEvidence> => ({
        baseSha: "abc123",
        ticketRevision: "r1",
        checks: [
          { name: "code-existence", passed: true },
          { name: "fix-layer-triage", passed: true },
          { name: "bug-verification", passed: true },
          { name: "smoke-test", passed: true },
          { name: "dependency-detection", passed: disposition !== "blocked" },
        ],
        proposedFixLayer: "daemon",
        disposition,
      }),
    });
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ticket-admission-"));
    file = join(tmp, "daemon.sqlite");
    disposition = "ready";
    clock = 0;
  });
  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const seedRig = () => db.prepare(`INSERT OR IGNORE INTO rigs (id, name) VALUES ('r-openrig', 'openrig')`).run();

  it("derives a deterministic instance key from ticket id and admission timestamp, and starts the workflow", async () => {
    const svc = boot(); seedRig();
    const r = await svc.admit("RIG-90");
    expect(r.admitted).toBe(true);
    if (!r.admitted) return;
    expect(r.admission.instanceKey).toBe("RIG-90@2026-10-14T00:00:00.000Z");
    expect(r.admission.state).toBe("active");
    expect(runtime.instanceStore.getById(r.admission.instanceId!)?.workflowName).toBe("ticket-factory");
  });

  it("records the evidence and references it from the instance's entry packet", async () => {
    const svc = boot(); seedRig();
    const r = await svc.admit("RIG-90");
    if (!r.admitted) throw new Error("expected admitted");
    expect(r.admission.evidence).toMatchObject({ baseSha: "abc123", ticketRevision: "r1", disposition: "ready", proposedFixLayer: "daemon" });
    expect(r.admission.evidence.checks.map((c) => c.name)).toEqual([
      "code-existence", "fix-layer-triage", "bug-verification", "smoke-test", "dependency-detection",
    ]);
    const body = (db.prepare(`SELECT body FROM queue_items WHERE body LIKE ?`).get(`%${r.admission.instanceKey}%`) as { body: string }).body;
    expect(body).toContain("RIG-90");
  });

  it("rejects re-admitting a ticket that has a live admission", async () => {
    const svc = boot(); seedRig();
    await svc.admit("RIG-90");
    const again = await svc.admit("RIG-90");
    expect(again).toMatchObject({ admitted: false, reason: "duplicate" });
    expect((db.prepare(`SELECT COUNT(*) c FROM ticket_admissions WHERE ticket_id='RIG-90'`).get() as { c: number }).c).toBe(1);
  });

  it("the database refuses a second live row for a ticket even if the service check is bypassed", async () => {
    const svc = boot(); seedRig();
    await svc.admit("RIG-90");
    const insert = () => db.prepare(
      `INSERT INTO ticket_admissions (id,ticket_id,instance_key,state,disposition,evidence_json,created_at,updated_at)
       VALUES ('x','RIG-90','RIG-90@other','pending','ready','{}','t','t')`).run();
    expect(insert).toThrow(/UNIQUE/);
  });

  it("enforces capacity=1: a second ticket is refused while one is in flight", async () => {
    const svc = boot(); seedRig();
    await svc.admit("RIG-90");
    expect(await svc.admit("RIG-91")).toMatchObject({ admitted: false, reason: "capacity" });
  });

  it("a non-ready disposition is recorded as rejected, starts nothing, and frees the slot", async () => {
    const svc = boot(); seedRig();
    disposition = "blocked";
    const r = await svc.admit("RIG-90");
    expect(r).toMatchObject({ admitted: false, reason: "not-ready" });
    expect(r.admission?.state).toBe("rejected");
    expect(runtime.instanceStore.listAll()).toHaveLength(0);
    disposition = "ready";
    expect((await svc.admit("RIG-91")).admitted).toBe(true);
  });

  it("allows re-admitting a ticket after its admission closed", async () => {
    const svc = boot(); seedRig();
    await svc.admit("RIG-90");
    await svc.reconcile("RIG-90", "closed");
    expect((await svc.admit("RIG-90")).admitted).toBe(true);
  });

  it("rejects the pending row, frees capacity and skips the cooldown when the workflow start rejects", async () => {
    const svc = boot(); seedRig();
    const spy = vi.spyOn(runtime, "instantiate").mockRejectedValueOnce(new Error("boom"));
    await expect(svc.admit("RIG-90")).rejects.toThrow("boom");
    spy.mockRestore();
    expect(svc.liveAdmissionCount()).toBe(0);
    const row = db.prepare(`SELECT state, state_reason FROM ticket_admissions WHERE ticket_id = 'RIG-90'`).get() as { state: string; state_reason: string };
    expect(row.state).toBe("rejected");
    expect(row.state_reason).toContain("workflow start failed: boom");
    expect((await svc.admit("RIG-90")).admitted).toBe(true);
  });

  describe("restart recovery", () => {
    it("a crash after the pending write but before instantiate resumes the instance on boot", async () => {
      let svc = boot(); seedRig();
      db.prepare(
        `INSERT INTO ticket_admissions (id,ticket_id,instance_key,state,disposition,evidence_json,created_at,updated_at)
         VALUES ('a1','RIG-90','RIG-90@2026-10-14T00:00:00.000Z','pending','ready','{"baseSha":"abc123"}','t','t')`).run();
      db.close();
      svc = boot();
      expect(await svc.recoverPending()).toEqual({ resumed: 1, adopted: 0 });
      const row = svc.getById("a1")!;
      expect(row.state).toBe("active");
      expect(runtime.instanceStore.getById(row.instanceId!)).toBeTruthy();
      expect(runtime.instanceStore.listAll()).toHaveLength(1);
    });

    it("a crash after instantiate but before the row update adopts the existing instance and does not create a second", async () => {
      let svc = boot(); seedRig();
      const r = await svc.admit("RIG-90");
      if (!r.admitted) throw new Error("expected admitted");
      // Simulate the lost update: the row is still pending with no instance id.
      db.prepare(`UPDATE ticket_admissions SET state='pending', instance_id=NULL WHERE id=?`).run(r.admission.id);
      db.close();
      svc = boot();
      expect(await svc.recoverPending()).toEqual({ resumed: 0, adopted: 1 });
      expect(svc.getById(r.admission.id)).toMatchObject({ state: "active", instanceId: r.admission.instanceId });
      expect(runtime.instanceStore.listAll()).toHaveLength(1);
    });

    it("recovery is idempotent and leaves active admissions alone", async () => {
      let svc = boot(); seedRig();
      await svc.admit("RIG-90");
      db.close();
      svc = boot();
      expect(await svc.recoverPending()).toEqual({ resumed: 0, adopted: 0 });
      expect(await svc.recoverPending()).toEqual({ resumed: 0, adopted: 0 });
      expect(runtime.instanceStore.listAll()).toHaveLength(1);
    });
  });

  describe("external-state reconciliation", () => {
    it("a ticket closed externally mid-workflow aborts the instance and closes the admission", async () => {
      const svc = boot(); seedRig();
      const r = await svc.admit("RIG-90");
      if (!r.admitted) throw new Error("expected admitted");
      expect(await svc.reconcile("RIG-90", "closed")).toBe("closed");
      expect(runtime.instanceStore.getById(r.admission.instanceId!)?.status).toBe("aborted");
      expect(svc.getById(r.admission.id)).toMatchObject({ state: "closed", stateReason: "ticket closed externally" });
    });

    it("unknown external state leaves the instance running and marks the admission reconciling", async () => {
      const svc = boot(); seedRig();
      const r = await svc.admit("RIG-90");
      if (!r.admitted) throw new Error("expected admitted");
      expect(await svc.reconcile("RIG-90", "unknown")).toBe("reconciling");
      expect(runtime.instanceStore.getById(r.admission.instanceId!)?.status).toBe("active");
      // Still occupies the slot and still blocks duplicates.
      expect(await svc.admit("RIG-90")).toMatchObject({ admitted: false, reason: "duplicate" });
    });

    it("a reconciling admission returns to active once the ticket is confirmed open", async () => {
      const svc = boot(); seedRig();
      await svc.admit("RIG-90");
      await svc.reconcile("RIG-90", "unknown");
      expect(await svc.reconcile("RIG-90", "open")).toBe("active");
    });

    it("settleFinished closes admissions whose workflow already ended", async () => {
      const svc = boot(); seedRig();
      const r = await svc.admit("RIG-90");
      if (!r.admitted) throw new Error("expected admitted");
      await runtime.abort({ instanceId: r.admission.instanceId!, reason: "test", actorSession: "orch-lead@openrig" });
      expect(svc.settleFinished()).toBe(1);
      expect(svc.getById(r.admission.id)?.state).toBe("closed");
    });
  });

  it("evidence, disposition and identity are immutable once written", async () => {
    const svc = boot(); seedRig();
    const r = await svc.admit("RIG-90");
    if (!r.admitted) throw new Error("expected admitted");
    for (const col of ["evidence_json", "disposition", "instance_key", "ticket_id"]) {
      expect(() => db.prepare(`UPDATE ticket_admissions SET ${col} = 'x' WHERE id = ?`).run(r.admission.id)).toThrow(/immutable/);
    }
  });
});
