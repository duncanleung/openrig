// RIG-89 cutover tests
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hono } from "hono";
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
import { TicketAdmissionService, type AdmissionEvidence } from "../src/domain/ticket-admission-service.js";
import { TicketFactoryController } from "../src/domain/ticket-factory-controller.js";
import { FACTORY_DEFAULTS, parseFactorySettings, resolveMergePolicy, type FactorySettings } from "../src/domain/ticket-factory-config.js";
import { makeTicketFactoryPollPolicy } from "../src/domain/policies/ticket-factory-poll.js";
import { ticketFactoryRoutes } from "../src/routes/ticket-factory.js";
import { ticketFactoryCutoverSchema } from "../src/db/migrations/106_ticket_factory_cutover.js";
import { TicketFactoryCutoverService, classify, CutoverError, type LegacySnapshot } from "../src/domain/ticket-factory-cutover.js";
import { CutoverGateError } from "../src/domain/ticket-factory-controller.js";

// RIG-89 — cutover from the /factory-loop skill: reconciliation, the legacy fence
// (double-dispatch prevention), cutover gating, rollback, and the three completion facts.

const SPEC = resolve(import.meta.dirname, "../src/builtins/workflow-specs/ticket-factory.yaml");
const MIGRATIONS = [
  outboxEntriesSchema, coreSchema, bindingsSessionsSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema,
  workflowSpecsSchema, workflowInstancesSchema, workflowStepTrailsSchema, queueItemSummarySchema,
  queueItemEvidenceRefSchema, workflowInstanceVersionSchema, workflowSpecJsonSchema, missionControlActionsSchema,
  ticketAdmissionsSchema, ticketFactoryControlSchema, ticketFactoryCutoverSchema,
];

describe("ticket-factory cutover (RIG-89)", () => {
  let tmp: string;
  let file: string;
  let db: Database.Database;
  let t: number;
  let backlog: () => Promise<string[]>;
  let checksCalled: string[];
  let legacyQueue: string[];
  const now = () => new Date(t);

  const boot = () => {
    db = createDb(file);
    migrate(db, MIGRATIONS);
    const bus = new EventBus(db);
    const queue = new QueueRepository(db, bus, { validateRig: () => true });
    queue.attachOutbox(new OutboxHandler(db));
    const runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue });
    db.prepare(`INSERT OR IGNORE INTO rigs (id, name) VALUES ('r-openrig', 'openrig')`).run();
    const ref: { cutover?: TicketFactoryCutoverService } = {};
    const admissions = new TicketAdmissionService({
      db, runtime, specPath: SPEC, createdBySession: "orch-lead@openrig", now, capacity: 3,
      isLegacyHeld: (id) => ref.cutover?.isLegacyHeld(id) ?? false,
      isResolved: (id) => ref.cutover?.isResolved(id) ?? false,
      runChecks: async (id): Promise<AdmissionEvidence> => {
        checksCalled.push(id);
        return { baseSha: "abc", ticketRevision: "r1", checks: [], proposedFixLayer: "daemon", disposition: "ready" };
      },
    });
    const controller = new TicketFactoryController({ db, admissions, listBacklog: () => backlog(), now });
    controller.seed(FACTORY_DEFAULTS);
    const cutover = new TicketFactoryCutoverService({ db, controller, now, probeLegacyQueue: async () => legacyQueue });
    ref.cutover = cutover;
    return { admissions, controller, cutover };
  };

  const snap = (over: Partial<LegacySnapshot> = {}): LegacySnapshot => ({ items: [], prs: [], tickets: {}, ...over });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ticket-cutover-"));
    file = join(tmp, "daemon.sqlite");
    t = Date.UTC(2026, 9, 14);
    backlog = async () => [];
    checksCalled = [];
    legacyQueue = [];
  });
  afterEach(() => {
    db?.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("reconciliation", () => {
    it("classifies each legacy state and keeps the three facts independent", () => {
      const prs = [
        { ticketId: "A-1", number: 10, state: "merged" as const },
        { ticketId: "A-2", number: 11, state: "open" as const },
        { ticketId: "A-3", number: 12, state: "closed" as const },
      ];
      const tickets = { "A-1": "open" as const, "A-2": "closed" as const, "A-5": "open" as const };
      // PR merged, ticket still open, workflow never reached merge-ready.
      const a1 = classify({ ticketId: "A-1", legacyState: "reviewing" }, prs, tickets);
      expect(a1.action).toBe("release-merged");
      expect(a1.facts).toEqual({ workflowCompleted: false, prMerged: true, ticketResolved: false });
      // Ticket resolved in the tracker, PR still open, workflow completed.
      const a2 = classify({ ticketId: "A-2", legacyState: "merge-ready" }, prs, tickets);
      expect(a2.action).toBe("release-resolved");
      expect(a2.facts).toEqual({ workflowCompleted: true, prMerged: false, ticketResolved: true });
      // PR closed without merge needs a human and stays fenced.
      expect(classify({ ticketId: "A-3", legacyState: "reviewing" }, prs, tickets)).toMatchObject({ action: "blocked" });
      // Stale claim: nothing external exists.
      expect(classify({ ticketId: "A-4", legacyState: "claimed" }, prs, tickets)).toMatchObject({ action: "stale-claim" });
      // Lost worktree.
      expect(classify({ ticketId: "A-5", legacyState: "implementing" }, prs, tickets)).toMatchObject({ action: "blocked" });
      // Healthy in-flight work holds; unknown tracker state stays null, not false.
      const a6 = classify({ ticketId: "A-6", legacyState: "reviewing", branch: "feat/a-6" }, [{ ticketId: "A-6", number: 20, state: "open" }], {});
      expect(a6.action).toBe("hold");
      expect(a6.facts.ticketResolved).toBeNull();
    });

    it("fences held tickets, releases finished ones and records facts", () => {
      const { cutover } = boot();
      const report = cutover.reconcileLegacy(snap({
        items: [
          { ticketId: "A-1", legacyState: "reviewing", branch: "feat/a-1" },
          { ticketId: "A-2", legacyState: "reviewing", branch: "feat/a-2" },
        ],
        prs: [{ ticketId: "A-1", number: 1, state: "open" }, { ticketId: "A-2", number: 2, state: "merged" }],
        tickets: { "A-1": "open", "A-2": "open" },
      }));
      expect(report.held).toEqual(["A-1"]);
      expect(cutover.isLegacyHeld("A-1")).toBe(true);
      expect(cutover.isLegacyHeld("A-2")).toBe(false);
      expect(cutover.completion("A-2")).toMatchObject({ prMerged: true, ticketResolved: false });
      expect(cutover.phase()).toBe("reconciled");
    });

    it("is idempotent and survives a restart", () => {
      const { cutover } = boot();
      const s = snap({ items: [{ ticketId: "A-1", legacyState: "reviewing", branch: "b" }], prs: [{ ticketId: "A-1", number: 1, state: "open" }] });
      cutover.reconcileLegacy(s);
      cutover.reconcileLegacy(s);
      expect(cutover.legacyClaims()).toHaveLength(1);
      db.close();
      const again = boot().cutover;
      expect(again.phase()).toBe("reconciled");
      expect(again.isLegacyHeld("A-1")).toBe(true);
    });

    it("keeps an earlier known fact when a later snapshot reports unknown", () => {
      const { cutover } = boot();
      cutover.recordFacts("A-1", null, { ticketResolved: true });
      cutover.recordFacts("A-1", null, { ticketResolved: null, prMerged: false });
      expect(cutover.completion("A-1")).toMatchObject({ ticketResolved: true, prMerged: false, workflowCompleted: null });
    });
  });

  describe("double-dispatch prevention", () => {
    it("refuses a legacy-held ticket before running checks or creating an instance", async () => {
      const { admissions, cutover } = boot();
      cutover.reconcileLegacy(snap({ items: [{ ticketId: "A-1", legacyState: "reviewing", branch: "b" }], prs: [{ ticketId: "A-1", number: 1, state: "open" }] }));
      const res = await admissions.admit("A-1");
      expect(res).toMatchObject({ admitted: false, reason: "legacy-held" });
      expect(checksCalled).toEqual([]);
      expect((db.prepare(`SELECT COUNT(*) AS c FROM ticket_admissions`).get() as { c: number }).c).toBe(0);
    });

    it("catches a claim adopted while checks were running (in-transaction re-check)", async () => {
      const { admissions, cutover } = boot();
      // Replace checks so the legacy claim lands between the pre-check and the insert.
      (admissions as unknown as { deps: { runChecks: unknown } }).deps.runChecks = async (id: string) => {
        cutover.reconcileLegacy(snap({ items: [{ ticketId: id, legacyState: "reviewing", branch: "b" }], prs: [{ ticketId: id, number: 1, state: "open" }] }));
        return { baseSha: "abc", ticketRevision: "r1", checks: [], proposedFixLayer: "daemon", disposition: "ready" };
      };
      expect(await admissions.admit("A-1")).toMatchObject({ admitted: false, reason: "legacy-held" });
      expect((db.prepare(`SELECT COUNT(*) AS c FROM ticket_admissions`).get() as { c: number }).c).toBe(0);
    });

    it("lists daemon-admitted tickets for the skill-side fence", async () => {
      const { admissions, cutover } = boot();
      expect((await admissions.admit("A-9")).admitted).toBe(true);
      expect(cutover.status().daemonAdmitted).toEqual(["A-9"]);
    });

    it("after the old system finishes: resolved ticket is not admitted, open ticket is", async () => {
      const { admissions, cutover } = boot();
      cutover.reconcileLegacy(snap({
        items: [{ ticketId: "A-1", legacyState: "reviewing", branch: "b" }, { ticketId: "A-2", legacyState: "reviewing", branch: "b" }],
        prs: [{ ticketId: "A-1", number: 1, state: "open" }, { ticketId: "A-2", number: 2, state: "open" }],
      }));
      cutover.recordFacts("A-1", null, { ticketResolved: true });
      cutover.releaseLegacyClaim("A-1", "old system finished");
      cutover.releaseLegacyClaim("A-2", "old system finished");
      expect(await admissions.admit("A-1")).toMatchObject({ admitted: false, reason: "already-resolved" });
      expect((await admissions.admit("A-2")).admitted).toBe(true);
    });

    it("tripwire pauses the daemon when a legacy item overlaps a daemon admission or appears unannounced", async () => {
      const { admissions, controller, cutover } = boot();
      cutover.reconcileLegacy(snap());
      cutover.cutOver({ legacyProducerDisabled: true });
      expect((await admissions.admit("A-1")).admitted).toBe(true);
      legacyQueue = [];
      expect(await cutover.tripwire()).toMatchObject({ paused: false });
      legacyQueue = ["A-1", "A-7"];
      expect(await cutover.tripwire()).toEqual({ unexpected: ["A-7"], doubleDispatch: ["A-1"], paused: true });
      expect(controller.status().state).toBe("paused");
    });
  });

  describe("cutover gate and rollback", () => {
    it("leaves RIG-88 behaviour alone when no cutover row exists", () => {
      const { controller } = boot();
      expect(controller.enable().state).toBe("running");
    });

    it("refuses to enable the factory outside the daemon phase", () => {
      const { controller, cutover } = boot();
      cutover.reconcileLegacy(snap());
      expect(() => controller.enable()).toThrow(CutoverGateError);
    });

    it("refuses cutover before a reconcile or without the legacy-disabled attestation", () => {
      const { cutover, controller } = boot();
      expect(() => cutover.cutOver({ legacyProducerDisabled: true })).toThrow(CutoverError);
      cutover.reconcileLegacy(snap());
      expect(() => cutover.cutOver({ legacyProducerDisabled: false })).toThrow(/disabled/);
      expect(controller.status().state).toBe("disabled");
      expect(cutover.cutOver({ legacyProducerDisabled: true })).toBe("daemon");
      expect(controller.status().state).toBe("running");
    });

    it("rolls back: drains the daemon, keeps active tickets, keeps them visible, and allows a second cutover", async () => {
      const { admissions, controller, cutover } = boot();
      cutover.reconcileLegacy(snap());
      cutover.cutOver({ legacyProducerDisabled: true });
      expect((await admissions.admit("A-1")).admitted).toBe(true);
      cutover.rollback("daemon failed");
      expect(cutover.phase()).toBe("rolled-back");
      expect(controller.status().state).toBe("paused");
      expect(() => controller.enable()).toThrow(CutoverGateError);
      // Active daemon admission is untouched and still reported to the skill.
      expect(cutover.status().daemonAdmitted).toEqual(["A-1"]);
      expect(controller.status().live).toBe(1);
      // Cutover again after the cause is fixed.
      expect(cutover.cutOver({ legacyProducerDisabled: true })).toBe("daemon");
      expect(controller.status().state).toBe("running");
    });

    it("a re-reconcile during the daemon phase releases finished claims without demoting the phase", () => {
      const { cutover } = boot();
      cutover.reconcileLegacy(snap({ items: [{ ticketId: "A-1", legacyState: "reviewing", branch: "b" }], prs: [{ ticketId: "A-1", number: 1, state: "open" }] }));
      cutover.cutOver({ legacyProducerDisabled: true });
      cutover.reconcileLegacy(snap({ items: [{ ticketId: "A-1", legacyState: "reviewing", branch: "b" }], prs: [{ ticketId: "A-1", number: 1, state: "merged" }] }));
      expect(cutover.phase()).toBe("daemon");
      expect(cutover.isLegacyHeld("A-1")).toBe(false);
    });

    it("records workflow completion for daemon admissions separately from PR and ticket facts", async () => {
      const { admissions, cutover } = boot();
      const res = await admissions.admit("A-1");
      db.prepare(`UPDATE ticket_admissions SET state = 'closed', state_reason = 'workflow completed' WHERE id = ?`).run((res as { admission: { id: string } }).admission.id);
      expect(cutover.syncDaemonCompletion()).toBe(1);
      expect(cutover.completion("A-1")).toMatchObject({ workflowCompleted: true, prMerged: null, ticketResolved: null });
    });
  });

  describe("routes", () => {
    it("reconcile, start and rollback over HTTP; enable answers 409 during a cutover", async () => {
      const { controller, cutover } = boot();
      const app = new Hono();
      app.use("*", async (c, next) => { c.set("ticketFactory" as never, controller); c.set("ticketFactoryCutover" as never, cutover); await next(); });
      app.route("/api/ticket-factory", ticketFactoryRoutes());
      const post = (p: string, body?: unknown) => app.request(`/api/ticket-factory${p}`, { method: "POST", body: body ? JSON.stringify(body) : undefined, headers: { "content-type": "application/json" } });
      expect((await post("/cutover/reconcile", { nope: 1 })).status).toBe(400);
      expect((await post("/cutover/reconcile", snap())).status).toBe(200);
      expect((await post("/enable")).status).toBe(409);
      expect((await post("/cutover/start", {})).status).toBe(409);
      expect((await post("/cutover/start", { legacyProducerDisabled: true })).status).toBe(200);
      expect(((await (await app.request("/api/ticket-factory/cutover")).json()) as { phase: string }).phase).toBe("daemon");
      expect((await post("/cutover/rollback")).status).toBe(200);
      expect(controller.status().state).toBe("paused");
    });
  });
});
