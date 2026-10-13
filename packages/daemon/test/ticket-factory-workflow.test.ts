// RIG-86 — the ticket-factory workflow: one ticket through the daemon workflow
// engine (intake -> plan -> validate -> implement -> qa_check -> review ->
// merge_disposition) with bounded remediation and restart recovery.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
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
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { WorkflowValidator } from "../src/domain/workflow-validator.js";
import { parseWorkflowSpec } from "../src/domain/workflow-spec-cache.js";

const SPEC = resolve(import.meta.dirname, "../src/builtins/workflow-specs/ticket-factory.yaml");

const SEATS = {
  orchestrator: "orch-lead@openrig",
  implementer: "dev-impl@openrig",
  validator: "orch-advisor@openrig",
  reviewer: "quality-reviewer@openrig",
};

describe("ticket-factory workflow (RIG-86)", () => {
  let db: Database.Database;
  let eventBus: EventBus;
  let queueRepo: QueueRepository;
  let runtime: WorkflowRuntime;

  let tmp: string;
  let dbFile: string;

  const MIGRATIONS = [
    outboxEntriesSchema,
    coreSchema,
    eventsSchema,
    queueItemsSchema,
    queueTransitionsSchema,
    workflowSpecsSchema,
    workflowInstancesSchema,
    workflowStepTrailsSchema,
    queueItemSummarySchema,
    queueItemEvidenceRefSchema,
    workflowInstanceVersionSchema,
    workflowSpecJsonSchema,
  ];

  // Wires a full daemon-side stack over the SQLite file, as a daemon boot does.
  const boot = (file: string) => {
    const conn = createDb(file);
    migrate(conn, MIGRATIONS);
    const bus = new EventBus(conn);
    const queue = new QueueRepository(conn, bus, { validateRig: () => true });
    queue.attachOutbox(new OutboxHandler(conn));
    return { conn, bus, queue, rt: new WorkflowRuntime({ db: conn, eventBus: bus, queueRepo: queue }) };
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ticket-factory-"));
    dbFile = join(tmp, "daemon.sqlite");
    const stack = boot(dbFile);
    db = stack.conn;
    eventBus = stack.bus;
    queueRepo = stack.queue;
    runtime = stack.rt;
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-openrig', 'openrig')`).run();
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function start() {
    return runtime.instantiate({
      specPath: SPEC,
      rootObjective: "ticket RIG-99",
      createdBySession: SEATS.orchestrator,
    });
  }

  async function step(instanceId: string, packetId: string, exit: "handoff" | "failed" | "done", actor: string, rt = runtime) {
    return rt.project({ instanceId, currentPacketId: packetId, exit, actorSession: actor });
  }

  it("validates with no errors and names the five required stages plus an explicit validate step", () => {
    const spec = parseWorkflowSpec(readFileSync(SPEC, "utf-8"), SPEC);
    const validation = new WorkflowValidator().validate(spec);
    expect(validation.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(validation.ok).toBe(true);
    const ids = spec.steps.map((s) => s.id);
    expect(ids).toEqual(["intake", "plan", "validate", "implement", "qa_check", "review", "merge_disposition"]);
    expect(ids).not.toContain("release");
    expect(spec.exception_routing).toMatchObject({ default: "orchestrator", orchestrator_role: "orchestrator" });
    expect(spec.loop_guards?.max_hops).toBeGreaterThanOrEqual(1);
  });

  it("creates an instance at intake owned by the orchestrator", async () => {
    const created = await start();
    expect(created.instance.currentStepId).toBe("intake");
    expect(created.instance.status).toBe("active");
    expect(created.entryOwnerSession).toBe(SEATS.orchestrator);
    expect(created.instance.currentFrontier).toEqual([created.entryQitemId]);
  });

  it("walks the happy path through validate to a done merge disposition", async () => {
    const created = await start();
    const id = created.instance.instanceId;
    let packet = created.entryQitemId;
    const walk: Array<[string, string, string]> = [
      ["plan", SEATS.implementer, SEATS.orchestrator],
      ["validate", SEATS.validator, SEATS.implementer],
      ["implement", SEATS.implementer, SEATS.validator],
      ["qa_check", SEATS.reviewer, SEATS.implementer],
      ["review", SEATS.reviewer, SEATS.reviewer],
      ["merge_disposition", SEATS.orchestrator, SEATS.reviewer],
    ];
    for (const [nextStep, owner, actor] of walk) {
      const projected = await step(id, packet, "handoff", actor);
      expect(projected.nextStepId).toBe(nextStep);
      expect(projected.nextOwnerSession).toBe(owner);
      packet = projected.nextQitemId!;
    }
    await step(id, packet, "done", SEATS.orchestrator);
    const done = runtime.instanceStore.getById(id);
    expect(done?.status).toBe("completed");
    expect(done?.currentFrontier).toEqual([]);
  });

  it("routes a failed validation back to plan, and a failed qa_check or review back to implement", async () => {
    const created = await start();
    const id = created.instance.instanceId;
    let p = await step(id, created.entryQitemId, "handoff", SEATS.orchestrator); // -> plan
    p = await step(id, p.nextQitemId!, "handoff", SEATS.implementer); // -> validate
    p = await step(id, p.nextQitemId!, "failed", SEATS.validator); // rejected plan
    expect(p.nextStepId).toBe("plan");
    p = await step(id, p.nextQitemId!, "handoff", SEATS.implementer); // -> validate
    p = await step(id, p.nextQitemId!, "handoff", SEATS.validator); // -> implement
    expect(p.nextStepId).toBe("implement");
    p = await step(id, p.nextQitemId!, "handoff", SEATS.implementer); // -> qa_check
    p = await step(id, p.nextQitemId!, "failed", SEATS.reviewer); // qa failure
    expect(p.nextStepId).toBe("implement");
    expect(p.nextOwnerSession).toBe(SEATS.implementer);
    p = await step(id, p.nextQitemId!, "handoff", SEATS.implementer); // -> qa_check
    p = await step(id, p.nextQitemId!, "handoff", SEATS.reviewer); // -> review
    p = await step(id, p.nextQitemId!, "failed", SEATS.reviewer); // review failure
    expect(p.nextStepId).toBe("implement");
    expect(runtime.instanceStore.getById(id)?.status).toBe("active");
  });

  it("bounds the remediation loop with max_hops instead of looping forever", async () => {
    const created = await start();
    const id = created.instance.instanceId;
    let p = await step(id, created.entryQitemId, "handoff", SEATS.orchestrator); // plan
    p = await step(id, p.nextQitemId!, "handoff", SEATS.implementer); // validate
    p = await step(id, p.nextQitemId!, "handoff", SEATS.validator); // implement
    let guard = 0;
    while (runtime.instanceStore.getById(id)?.status === "active" && guard++ < 60) {
      const frontier = runtime.instanceStore.getById(id)!.currentFrontier[0]!;
      const stepId = runtime.instanceStore.getById(id)!.currentStepId;
      if (stepId === "implement") p = await step(id, frontier, "handoff", SEATS.implementer);
      else p = await step(id, frontier, "failed", SEATS.reviewer); // qa_check keeps failing
    }
    expect(guard).toBeLessThan(60);
    expect(runtime.instanceStore.getById(id)?.status).not.toBe("active");
  });

  it("recovers across a daemon restart: a fresh runtime on the same database continues the instance", async () => {
    const created = await start();
    const id = created.instance.instanceId;
    const planned = await step(id, created.entryQitemId, "handoff", SEATS.orchestrator);
    expect(planned.nextStepId).toBe("plan");

    // Close the connection and boot a fresh stack over the same SQLite file: a restarted daemon.
    db.close();
    const restartedStack = boot(dbFile);
    db = restartedStack.conn;
    const restarted = restartedStack.rt;

    const survivor = restarted.instanceStore.getById(id);
    expect(survivor?.status).toBe("active");
    expect(survivor?.currentStepId).toBe("plan");
    expect(survivor?.currentFrontier).toEqual([planned.nextQitemId]);
    expect(restarted.instanceStore.listByStatus("active").map((i) => i.instanceId)).toContain(id);

    const next = await step(id, planned.nextQitemId!, "handoff", SEATS.implementer, restarted);
    expect(next.nextStepId).toBe("validate");
    expect(next.nextOwnerSession).toBe(SEATS.validator);
  });
});
