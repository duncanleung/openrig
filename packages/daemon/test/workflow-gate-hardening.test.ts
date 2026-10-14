// RIG-90 — engine gate hardening: (1) a human gate packet cannot be closed
// with done|handoff while it is still parked on the human; (3) a gated step's
// re_present_after_seconds is carried as the wake on the gate park.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { WorkflowValidator } from "../src/domain/workflow-validator.js";
import { parseWorkflowSpec } from "../src/domain/workflow-spec-cache.js";

const SPECS = resolve(import.meta.dirname, "../src/builtins/workflow-specs");
const TICKET_FACTORY = join(SPECS, "ticket-factory.yaml");
const ORCH = "orch-lead@openrig";

describe("workflow gate hardening (RIG-90)", () => {
  let db: Database.Database;
  let eventBus: EventBus;
  let queueRepo: QueueRepository;
  let runtime: WorkflowRuntime;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gate-hardening-"));
    db = createDb(join(tmp, "daemon.sqlite"));
    migrate(db, ALL_MIGRATIONS);
    eventBus = new EventBus(db);
    queueRepo = new QueueRepository(db, eventBus, { validateRig: () => true });
    queueRepo.attachOutbox(new OutboxHandler(db));
    runtime = new WorkflowRuntime({ db, eventBus, queueRepo });
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-openrig', 'openrig')`).run();
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const resolveGate = (qitemId: string, decision: string) =>
    new MissionControlWriteContract({
      db,
      eventBus,
      queueRepo,
      actionLog: new MissionControlActionLog(db),
    }).act({ verb: "resolve", qitemId, actorSession: "human@kernel", decision });

  const project = (instanceId: string, packetId: string, exit: "handoff" | "failed" | "done" | "waiting", closureEvidence?: Record<string, unknown>, blockedOn?: string) =>
    runtime.project({ instanceId, currentPacketId: packetId, exit, actorSession: ORCH, closureEvidence, blockedOn });

  const wakeJobsAll = () => db.prepare(`SELECT target_session FROM watchdog_jobs WHERE policy = 'periodic-reminder'`).all();

  /** Drive a ticket-factory instance to the parked merge_disposition gate packet. */
  async function driveToGate() {
    const created = await runtime.instantiate({ specPath: TICKET_FACTORY, rootObjective: "ticket RIG-99", createdBySession: ORCH });
    const id = created.instance.instanceId;
    let packet = created.entryQitemId;
    for (const stepId of ["intake", "plan", "validate", "implement", "qa_check", "review", "merge_prep"]) {
      const evidence = stepId === "validate"
        ? { acceptance: { candidate: "ticket-plan", verdict: "approved", evidence_ref: "proof/validation.md" } }
        : undefined;
      const r = await project(id, packet, "handoff", evidence);
      packet = r.nextQitemId!;
    }
    return { id, gatePacket: packet };
  }

  describe("item 1: gate must be resolved before the packet closes", () => {
    it("rejects done while the gate packet is still parked on the human, and leaves state untouched", async () => {
      const { id, gatePacket } = await driveToGate();
      expect(queueRepo.getById(gatePacket)?.state).toBe("blocked");
      // Forced unresolved state: no resolve call. The check must fire.
      await expect(project(id, gatePacket, "done")).rejects.toMatchObject({ code: "gate_unresolved" });
      expect(queueRepo.getById(gatePacket)?.state).toBe("blocked");
      expect(runtime.instanceStore.getById(id)?.status).toBe("waiting");
    });

    it("allows done after the human resolves the gate", async () => {
      const { id, gatePacket } = await driveToGate();
      await resolveGate(gatePacket, "approved - merge it");
      const done = await project(id, gatePacket, "done");
      expect(done.closureReason).toBe("done");
      expect(runtime.instanceStore.getById(id)?.status).toBe("completed");
    });

    it("still allows failed while the gate is unresolved", async () => {
      const { id, gatePacket } = await driveToGate();
      const failed = await project(id, gatePacket, "failed");
      expect(failed.nextStepId).toBe("implement");
    });

    it("rejects waiting at an unresolved gate, so waiting-then-done cannot bypass", async () => {
      const { id, gatePacket } = await driveToGate();
      for (const blockedOn of [undefined, "external-gate", "human@kernel"]) {
        await expect(project(id, gatePacket, "waiting", undefined, blockedOn)).rejects.toMatchObject({ code: "gate_unresolved" });
      }
      expect(queueRepo.getById(gatePacket)?.blockedOn).toBe("human@kernel");
      expect(wakeJobsAll()).toHaveLength(1);
      await expect(project(id, gatePacket, "done")).rejects.toMatchObject({ code: "gate_unresolved" });
    });
  });

  describe("item 3: re_present_after_seconds rides the gate park", () => {
    const wakeJobs = () =>
      db.prepare(`SELECT target_session, interval_seconds, spec_yaml FROM watchdog_jobs WHERE policy = 'periodic-reminder'`).all() as Array<{
        target_session: string;
        interval_seconds: number;
        spec_yaml: string;
      }>;

    it("declares 86400s on every shipped human-gated step", () => {
      for (const [file, stepId] of [
        ["ticket-factory.yaml", "merge_disposition"],
        ["factory-rsi.yaml", "release_signoff"],
        ["gated-release.yaml", "ship-signoff"],
      ] as const) {
        const spec = parseWorkflowSpec(readFileSync(join(SPECS, file), "utf-8"), join(SPECS, file));
        expect(new WorkflowValidator().validate(spec).issues.filter((i) => i.severity === "error")).toEqual([]);
        const step = spec.steps.find((s) => s.id === stepId)!;
        expect(step.gate?.target).toBe("human@kernel");
        expect(step.re_present_after_seconds).toBe(86400);
      }
    });

    it("arms a 24h reminder aimed at the step owner (not the human) when the gate parks", async () => {
      const { id, gatePacket } = await driveToGate();
      const parked = queueRepo.getById(gatePacket)!;
      expect(parked.state).toBe("blocked");
      expect(parked.blockedOn).toBe("human@kernel");
      const jobs = wakeJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.interval_seconds).toBe(86400);
      // Repeating, not one-shot: both bounds are armed (max defaults to after).
      expect(jobs[0]!.spec_yaml).toMatch(/max_?seconds\D+86400/i);
      expect(jobs[0]!.target_session).toBe(parked.destinationSession);
      expect(jobs[0]!.target_session).toBe(ORCH);
      expect(jobs[0]!.target_session).not.toBe("human@kernel");
      expect(jobs[0]!.spec_yaml).toContain(id);
      expect(jobs[0]!.spec_yaml).toContain("merge_disposition");
    });

    it("arms no reminder for a gate step that declares no re_present_after_seconds", async () => {
      // Same flow on a copy of the spec with the field removed.
      const stripped = join(tmp, "ticket-factory-no-timer.yaml");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(stripped, readFileSync(TICKET_FACTORY, "utf-8").replace(/^\s*re_present_after_seconds: 86400\n/m, ""));
      const created = await runtime.instantiate({ specPath: stripped, rootObjective: "ticket RIG-99", createdBySession: ORCH });
      let packet = created.entryQitemId;
      const id = created.instance.instanceId;
      for (const stepId of ["intake", "plan", "validate", "implement", "qa_check", "review", "merge_prep"]) {
        const evidence = stepId === "validate"
          ? { acceptance: { candidate: "ticket-plan", verdict: "approved", evidence_ref: "proof/validation.md" } }
          : undefined;
        packet = (await project(id, packet, "handoff", evidence)).nextQitemId!;
      }
      expect(queueRepo.getById(packet)?.state).toBe("blocked");
      expect(wakeJobs()).toHaveLength(0);
    });
  });
});
