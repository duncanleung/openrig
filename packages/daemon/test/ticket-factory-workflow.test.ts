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
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { missionControlActionsSchema } from "../src/db/migrations/037_mission_control_actions.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
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
    bindingsSessionsSchema,
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
    missionControlActionsSchema,
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

  function resolveGate(qitemId: string, decision: string) {
    return new MissionControlWriteContract({
      db,
      eventBus,
      queueRepo,
      actionLog: new MissionControlActionLog(db),
    }).act({ verb: "resolve", qitemId, actorSession: "human@kernel", decision });
  }

  async function start() {
    return runtime.instantiate({
      specPath: SPEC,
      rootObjective: "ticket RIG-99",
      createdBySession: SEATS.orchestrator,
    });
  }

  async function step(
    instanceId: string,
    packetId: string,
    exit: "handoff" | "failed" | "done",
    actor: string,
    rt = runtime,
    closureEvidence?: Record<string, unknown>,
  ) {
    // The validate step carries an enforced acceptance contract; supply it by default there.
    const atValidate = rt.instanceStore.getById(instanceId)?.currentStepId === "validate";
    const evidence = closureEvidence ?? (atValidate ? approval(exit === "failed" ? "rejected" : "approved") : undefined);
    return rt.project({ instanceId, currentPacketId: packetId, exit, actorSession: actor, closureEvidence: evidence });
  }

  const approval = (verdict: string) => ({
    acceptance: { candidate: "ticket-plan", verdict, evidence_ref: "proof/validation.md" },
  });

  /** Drive a fresh instance to the packet sitting at `target`. */
  async function driveTo(target: string) {
    const created = await start();
    const id = created.instance.instanceId;
    const route: Array<[string, string]> = [
      ["plan", SEATS.orchestrator],
      ["validate", SEATS.implementer],
      ["implement", SEATS.validator],
      ["qa_check", SEATS.implementer],
      ["review", SEATS.reviewer],
      ["merge_prep", SEATS.reviewer],
      ["merge_disposition", SEATS.orchestrator],
    ];
    let packet = created.entryQitemId;
    let last: Awaited<ReturnType<typeof step>> | null = null;
    for (const [next, actor] of route) {
      if (runtime.instanceStore.getById(id)?.currentStepId === target) break;
      last = await step(id, packet, "handoff", actor);
      expect(last.nextStepId).toBe(next);
      packet = last.nextQitemId!;
    }
    return { id, packet, last };
  }

  it("validates with no errors and names the required stages, an explicit validate step, and merge_prep before the gate", () => {
    const spec = parseWorkflowSpec(readFileSync(SPEC, "utf-8"), SPEC);
    const validation = new WorkflowValidator().validate(spec);
    expect(validation.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(validation.ok).toBe(true);
    const ids = spec.steps.map((s) => s.id);
    expect(ids).toEqual(["intake", "plan", "validate", "implement", "qa_check", "review", "merge_prep", "merge_disposition"]);
    expect(ids).not.toContain("release");
    expect(spec.exception_routing).toMatchObject({ default: "orchestrator", orchestrator_role: "orchestrator" });
    expect(spec.loop_guards?.max_hops).toBeGreaterThanOrEqual(1);
    // Fix: the gate compiles on ROUTING INTO the gated step, so the evidence step must precede it.
    expect(ids.indexOf("merge_prep")).toBe(ids.indexOf("merge_disposition") - 1);
    expect(spec.steps.find((st) => st.id === "merge_prep")?.gate).toBeUndefined();
    expect(spec.steps.find((st) => st.id === "merge_disposition")?.gate?.evidence_ref).toBe("proof/PROOF.md");
    expect(spec.steps.find((st) => st.id === "validate")?.acceptance).toMatchObject({
      candidate: "ticket-plan",
      evidence_ref: "proof/validation.md",
    });
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
      ["merge_prep", SEATS.orchestrator, SEATS.reviewer],
    ];
    for (const [nextStep, owner, actor] of walk) {
      const projected = await step(id, packet, "handoff", actor);
      expect(projected.nextStepId).toBe(nextStep);
      expect(projected.nextOwnerSession).toBe(owner);
      packet = projected.nextQitemId!;
    }
    // merge_prep -> merge_disposition parks on the human gate; the human resolves it, then the owner closes.
    const gated = await step(id, packet, "handoff", SEATS.orchestrator);
    expect(gated.nextStepId).toBe("merge_disposition");
    await resolveGate(gated.nextQitemId!, "approved - merge it");
    await step(id, gated.nextQitemId!, "done", SEATS.orchestrator);
    const done = runtime.instanceStore.getById(id);
    expect(done?.status).toBe("completed");
    expect(done?.currentFrontier).toEqual([]);
    // Documented in the spec header: a clean ticket uses 7 of the 30 hops.
    expect(done?.hopCount).toBe(7);
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
    const tripped = runtime.instanceStore.getById(id)!;
    expect(tripped.status).not.toBe("active");
    // The guard stops the loop at the declared bound; it never routes a 31st hop.
    expect(tripped.hopCount).toBeLessThanOrEqual(30);
  });

  describe("validate step acceptance contract (enforced, not just a transition)", () => {
    it("blocks the handoff when no acceptance evidence is supplied, and leaves the instance at validate", async () => {
      const { id, packet } = await driveTo("validate");
      const before = runtime.instanceStore.getById(id)!;
      await expect(
        runtime.project({ instanceId: id, currentPacketId: packet, exit: "handoff", actorSession: SEATS.validator }),
      ).rejects.toMatchObject({ code: "acceptance_payload_required" });
      const after = runtime.instanceStore.getById(id)!;
      expect(after.currentStepId).toBe("validate");
      expect(after.currentFrontier).toEqual(before.currentFrontier);
      expect(queueRepo.getById(packet)?.state).not.toBe("done");
    });

    it("blocks a failed (rejected-plan) exit without evidence too", async () => {
      const { id, packet } = await driveTo("validate");
      await expect(
        runtime.project({ instanceId: id, currentPacketId: packet, exit: "failed", actorSession: SEATS.validator }),
      ).rejects.toMatchObject({ code: "acceptance_payload_required" });
      expect(runtime.instanceStore.getById(id)?.currentStepId).toBe("validate");
    });

    it.each([
      ["wrong candidate", { candidate: "some-other-plan", verdict: "approved", evidence_ref: "proof/validation.md" }, "candidate"],
      ["unknown verdict", { candidate: "ticket-plan", verdict: "looks-fine", evidence_ref: "proof/validation.md" }, "verdict"],
      ["wrong evidence_ref", { candidate: "ticket-plan", verdict: "approved", evidence_ref: "proof/other.md" }, "evidence_ref"],
      ["missing evidence_ref", { candidate: "ticket-plan", verdict: "approved" }, "evidence_ref"],
    ])("blocks on %s and names the mismatched field", async (_label, acceptance, field) => {
      const { id, packet } = await driveTo("validate");
      await expect(
        step(id, packet, "handoff", SEATS.validator, runtime, { acceptance }),
      ).rejects.toMatchObject({ code: "acceptance_payload_mismatch", details: { mismatches: { [field]: expect.anything() } } });
      expect(runtime.instanceStore.getById(id)?.currentStepId).toBe("validate");
    });

    it("advances to implement once the full contract is supplied", async () => {
      const { id, packet } = await driveTo("validate");
      const ok = await step(id, packet, "handoff", SEATS.validator, runtime, approval("approved"));
      expect(ok.nextStepId).toBe("implement");
    });
  });

  describe("merge gate lifecycle (human@kernel)", () => {
    it("merge_prep runs before the gate: the gate item carries the evidence ref and summary when it is created", async () => {
      const { id, packet, last } = await driveTo("merge_prep");
      expect(last?.nextOwnerSession).toBe(SEATS.orchestrator);
      // Nothing is parked on the human while evidence is being prepared.
      expect(queueRepo.getById(packet)?.blockedOn ?? null).toBeNull();
      expect(runtime.instanceStore.getById(id)?.status).toBe("active");

      const gated = await step(id, packet, "handoff", SEATS.orchestrator);
      const gateItem = queueRepo.getById(gated.nextQitemId!)!;
      expect(gateItem.evidenceRef).toBe("proof/PROOF.md");
      expect(gateItem.summary).toMatch(/merge decision/);
    });

    it("the gate blocks the workflow: item parked on the human, instance waiting at merge_disposition", async () => {
      const { id, packet } = await driveTo("merge_prep");
      const gated = await step(id, packet, "handoff", SEATS.orchestrator);
      expect(gated.nextOwnerSession).toBe(SEATS.orchestrator);
      const gateItem = queueRepo.getById(gated.nextQitemId!)!;
      expect(gateItem.state).toBe("blocked");
      expect(gateItem.blockedOn).toBe("human@kernel");
      const waiting = runtime.instanceStore.getById(id)!;
      expect(waiting.status).toBe("waiting");
      expect(waiting.currentStepId).toBe("merge_disposition");
      expect(waiting.currentFrontier).toEqual([gated.nextQitemId]);
    });

    it("human approves: the gate unparks, the owner closes, and the instance completes", async () => {
      const { id, packet } = await driveTo("merge_prep");
      const gated = await step(id, packet, "handoff", SEATS.orchestrator);
      await resolveGate(gated.nextQitemId!, "approved - merge it");
      expect(queueRepo.getById(gated.nextQitemId!)?.state).toBe("in-progress");
      const done = await step(id, gated.nextQitemId!, "done", SEATS.orchestrator);
      expect(done.nextQitemId).toBeNull();
      const finished = runtime.instanceStore.getById(id)!;
      expect(finished.status).toBe("completed");
      expect(finished.currentFrontier).toEqual([]);
    });

    it("human rejects: the owner exits failed and the workflow routes back to implement for rework", async () => {
      const { id, packet } = await driveTo("merge_prep");
      const gated = await step(id, packet, "handoff", SEATS.orchestrator);
      await resolveGate(gated.nextQitemId!, "rejected - rework the error handling");
      const rework = await step(id, gated.nextQitemId!, "failed", SEATS.orchestrator);
      expect(rework.nextStepId).toBe("implement");
      expect(rework.nextOwnerSession).toBe(SEATS.implementer);
      const inst = runtime.instanceStore.getById(id)!;
      expect(inst.status).toBe("active");
      expect(inst.currentStepId).toBe("implement");
    });
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
