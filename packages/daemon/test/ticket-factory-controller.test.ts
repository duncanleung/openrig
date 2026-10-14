// RIG-88 — recurring operation of the ticket-factory: scheduling, pause/resume, capacity,
// budgets, backoff, cooldown, restart durability, and the RIG-87 prerequisite fixes.

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

const SPEC = resolve(import.meta.dirname, "../src/builtins/workflow-specs/ticket-factory.yaml");
const MIGRATIONS = [
  outboxEntriesSchema, coreSchema, bindingsSessionsSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema,
  workflowSpecsSchema, workflowInstancesSchema, workflowStepTrailsSchema, queueItemSummarySchema,
  queueItemEvidenceRefSchema, workflowInstanceVersionSchema, workflowSpecJsonSchema, missionControlActionsSchema,
  ticketAdmissionsSchema, ticketFactoryControlSchema,
];
const HOUR = 3600_000;

describe("ticket-factory recurring operation (RIG-88)", () => {
  let tmp: string;
  let file: string;
  let db: Database.Database;
  let runtime: WorkflowRuntime;
  let t: number;
  let backlog: () => Promise<string[]>;

  const settings = (over: Partial<FactorySettings> = {}): FactorySettings => ({ ...FACTORY_DEFAULTS, ...over });
  const now = () => new Date(t);

  const boot = (over: Partial<FactorySettings> = {}, ctlOpts: { pollTimeoutMs?: number } = {}) => {
    db = createDb(file);
    migrate(db, MIGRATIONS);
    const bus = new EventBus(db);
    const queue = new QueueRepository(db, bus, { validateRig: () => true });
    queue.attachOutbox(new OutboxHandler(db));
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue });
    db.prepare(`INSERT OR IGNORE INTO rigs (id, name) VALUES ('r-openrig', 'openrig')`).run();
    const control = () => db.prepare(`SELECT capacity, cooldown_s FROM ticket_factory_control WHERE id = 1`).get() as { capacity: number; cooldown_s: number };
    const admissions = new TicketAdmissionService({
      db, runtime, specPath: SPEC, createdBySession: "orch-lead@openrig", now,
      capacity: () => control().capacity, cooldownSeconds: () => control().cooldown_s,
      runChecks: async (): Promise<AdmissionEvidence> => ({
        baseSha: "abc", ticketRevision: "r1", checks: [], proposedFixLayer: "daemon", disposition: "ready",
      }),
    });
    const controller = new TicketFactoryController({ db, admissions, listBacklog: () => backlog(), now, ...ctlOpts });
    controller.seed(settings(over));
    return { admissions, controller };
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ticket-factory-"));
    file = join(tmp, "daemon.sqlite");
    t = Date.UTC(2026, 9, 14);
    backlog = async () => [];
  });
  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("scheduling", () => {
    it("is disabled by default: a poll does nothing and never calls the tracker", async () => {
      let calls = 0;
      backlog = async () => { calls++; return ["RIG-90"]; };
      const { controller } = boot();
      expect(await controller.pollOnce()).toMatchObject({ ran: false, skipped: "disabled" });
      expect(calls).toBe(0);
    });

    it("polls on the configured cadence: not due inside the interval, due after it", async () => {
      let calls = 0;
      backlog = async () => { calls++; return []; };
      const { controller } = boot({ pollIntervalSeconds: 600 });
      controller.enable();
      expect((await controller.pollOnce()).ran).toBe(true);
      t += 599_000;
      expect(await controller.pollOnce()).toMatchObject({ ran: false, skipped: "not-due" });
      t += 2_000;
      expect((await controller.pollOnce()).ran).toBe(true);
      expect(calls).toBe(2);
    });

    it("runs one poll at a time: a second call during a slow poll returns in-flight", async () => {
      let release!: (ids: string[]) => void;
      backlog = () => new Promise<string[]>((r) => { release = r; });
      const { controller } = boot();
      controller.enable();
      const first = controller.pollOnce();
      expect(await controller.pollOnce()).toMatchObject({ ran: false, skipped: "in-flight" });
      release([]);
      expect((await first).ran).toBe(true);
    });

    it("triggerPoll returns at once; a slow tracker does not block the caller", async () => {
      let release: ((ids: string[]) => void) | undefined;
      backlog = () => new Promise<string[]>((r) => { release = r; });
      const { controller } = boot();
      controller.enable();
      const started = Date.now();
      controller.triggerPoll();
      expect(Date.now() - started).toBeLessThan(50);
      // The worker reaches the tracker on its own, after the caller has already returned.
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      release!([]);
      await vi.waitFor(() => expect(controller.status().lastPollAt).not.toBeNull());
    });

    it("the watchdog policy only triggers the controller and reports a skip", async () => {
      let triggered = 0;
      const policy = makeTicketFactoryPollPolicy({ trigger: () => { triggered++; } });
      expect(await policy.evaluate({} as never)).toMatchObject({ action: "skip" });
      expect(triggered).toBe(1);
    });
  });

  describe("pause, resume and restart", () => {
    it("pause drains: nothing new is admitted, the active ticket keeps running, resume admits again", async () => {
      backlog = async () => ["RIG-90", "RIG-91"];
      const { controller, admissions } = boot({ capacity: 2, maxTicketsPerRun: 5, pollIntervalSeconds: 60 });
      controller.enable();
      controller.pause();
      expect(await controller.pollOnce()).toMatchObject({ ran: false, skipped: "paused" });
      expect(admissions.liveAdmissionCount()).toBe(0);
      controller.resume();
      expect((await controller.pollOnce()).admitted).toEqual(["RIG-90", "RIG-91"]);
      controller.pause();
      t += 120_000;
      await controller.pollOnce();
      expect(admissions.liveAdmissionCount()).toBe(2);
      for (const i of runtime.instanceStore.listAll()) expect(i.status).toBe("active");
    });

    it("a paused poll still settles finished tickets so the drain frees capacity", async () => {
      backlog = async () => ["RIG-90"];
      const { controller, admissions } = boot();
      controller.enable();
      await controller.pollOnce();
      controller.pause();
      const inst = runtime.instanceStore.listAll()[0]!;
      await runtime.abort({ instanceId: inst.instanceId, reason: "done", actorSession: "orch-lead@openrig" });
      await controller.pollOnce();
      expect(admissions.liveAdmissionCount()).toBe(0);
    });

    it("enable/pause state and the run id survive a daemon restart", async () => {
      const first = boot();
      first.controller.enable();
      first.controller.pause();
      const runId = first.controller.status().run.runId;
      expect(runId).toBeTruthy();
      db.close();
      const second = boot();
      expect(second.controller.status()).toMatchObject({ state: "paused", run: { runId } });
    });

    it("disable closes the run; enable opens a new one", () => {
      const { controller } = boot();
      const a = controller.enable().run.runId;
      expect(controller.disable()).toMatchObject({ state: "disabled", run: { runId: null } });
      const b = controller.enable().run.runId;
      expect(b).toBeTruthy();
      expect(b).not.toBe(a);
      expect((db.prepare(`SELECT end_reason FROM ticket_factory_runs WHERE run_id = ?`).get(a) as { end_reason: string }).end_reason).toBe("disabled");
    });
  });

  describe("capacity and budgets", () => {
    it("default capacity is 1: one ticket is admitted per poll window", async () => {
      backlog = async () => ["RIG-90", "RIG-91", "RIG-92"];
      const { controller } = boot();
      controller.enable();
      expect(await controller.pollOnce()).toMatchObject({ admitted: ["RIG-90"], stopped: "capacity" });
    });

    it("capacity is configurable and a reload applies without a restart", async () => {
      backlog = async () => ["RIG-90", "RIG-91", "RIG-92"];
      const { controller } = boot({ maxTicketsPerRun: 10, pollIntervalSeconds: 60 });
      controller.enable();
      await controller.pollOnce();
      controller.applySettings(settings({ capacity: 3, maxTicketsPerRun: 10, pollIntervalSeconds: 60 }));
      t += 61_000;
      expect((await controller.pollOnce()).admitted).toEqual(["RIG-91", "RIG-92"]);
    });

    it("stops admitting at max tickets per run and counts survive a restart", async () => {
      backlog = async () => ["RIG-90", "RIG-91", "RIG-92"];
      const first = boot({ capacity: 5, maxTicketsPerRun: 2 });
      first.controller.enable();
      expect(await first.controller.pollOnce()).toMatchObject({ admitted: ["RIG-90", "RIG-91"], stopped: "run-budget" });
      db.close();
      const second = boot({ capacity: 5, maxTicketsPerRun: 2 });
      expect(second.controller.status().run).toMatchObject({ admitted: 2, maxTickets: 2 });
      t += 301_000;
      expect(await second.controller.pollOnce()).toMatchObject({ admitted: [], stopped: "run-budget" });
      second.controller.newRun();
      t += 301_000;
      expect((await second.controller.pollOnce()).admitted).toEqual(["RIG-92"]);
    });

    it("a rejected (not ready) ticket does not spend the run budget", async () => {
      backlog = async () => ["RIG-90"];
      const { controller, admissions } = boot({ capacity: 5, maxTicketsPerRun: 1 });
      controller.enable();
      const runId = controller.status().run.runId!;
      db.prepare(`INSERT INTO ticket_admissions (id,ticket_id,instance_key,state,disposition,evidence_json,created_at,updated_at,run_id)
        VALUES ('r1','RIG-80','RIG-80@k','rejected','blocked','{}','t','t',?)`).run(runId);
      expect(admissions.admittedInRun(runId)).toBe(0);
      expect((await controller.pollOnce()).admitted).toEqual(["RIG-90"]);
    });

    it("aborts and closes a ticket that exceeds its wall-clock budget", async () => {
      backlog = async () => ["RIG-90"];
      const { controller, admissions } = boot({ wallClockPerTicketSeconds: 1800, pollIntervalSeconds: 60 });
      controller.enable();
      await controller.pollOnce();
      const inst = runtime.instanceStore.listAll()[0]!;
      t += 1801_000;
      const out = await controller.pollOnce();
      expect(out.expired).toEqual(["RIG-90"]);
      expect(runtime.instanceStore.getById(inst.instanceId)?.status).toBe("aborted");
      expect(admissions.liveAdmissionCount()).toBe(0);
    });
  });

  describe("poll robustness", () => {
    it("a pause that lands while the backlog is being read stops the admits", async () => {
      const { controller, admissions } = boot({ capacity: 2, maxTicketsPerRun: 5, pollIntervalSeconds: 60 });
      controller.enable();
      backlog = async () => { controller.pause(); return ["RIG-90", "RIG-91"]; };
      expect(await controller.pollOnce()).toMatchObject({ admitted: [], stopped: "interrupted" });
      expect(admissions.liveAdmissionCount()).toBe(0);
      expect(controller.status().state).toBe("paused");
    });

    it("a new run that starts mid-poll does not receive admits from the ended run", async () => {
      const { controller, admissions } = boot({ capacity: 2, maxTicketsPerRun: 5, pollIntervalSeconds: 60 });
      controller.enable();
      const first = controller.status().run.runId!;
      backlog = async () => { controller.newRun(); return ["RIG-90"]; };
      expect(await controller.pollOnce()).toMatchObject({ admitted: [], stopped: "interrupted" });
      expect(admissions.admittedInRun(first)).toBe(0);
      expect(admissions.liveAdmissionCount()).toBe(0);
    });

    it("a housekeeping failure is recorded and backs off instead of escaping the poll", async () => {
      const { controller, admissions } = boot({ pollIntervalSeconds: 60 });
      controller.enable();
      vi.spyOn(admissions, "expireOverBudget").mockRejectedValueOnce(new Error("abort exploded"));
      const out = await controller.pollOnce();
      expect(out.error).toBe("abort exploded");
      expect(controller.status()).toMatchObject({ failStreak: 1, lastError: "abort exploded" });
      expect(Date.parse(controller.status().nextPollAt!)).toBeGreaterThan(t);
    });

    it("one failing abort does not strand the other expired tickets, and the failed row stays live for retry", async () => {
      backlog = async () => ["RIG-90", "RIG-91"];
      const { controller, admissions } = boot({ capacity: 2, maxTicketsPerRun: 5, wallClockPerTicketSeconds: 1800, pollIntervalSeconds: 60 });
      controller.enable();
      await controller.pollOnce();
      const [a] = runtime.instanceStore.listAll();
      const realAbort = runtime.abort.bind(runtime);
      vi.spyOn(runtime, "abort").mockImplementation(async (input) => {
        if (input.instanceId === a!.instanceId) throw new Error("abort refused");
        return realAbort(input);
      });
      t += 1801_000;
      const out = await controller.pollOnce();
      expect(out.error).toMatch(/abort refused/);
      expect(admissions.liveAdmissionCount()).toBe(1);
      expect(runtime.instanceStore.getById(a!.instanceId)?.status).toBe("active");
      const other = runtime.instanceStore.listAll().find((i) => i.instanceId !== a!.instanceId)!;
      expect(other.status).toBe("aborted");
    });
  });

  describe("backoff", () => {
    it("doubles the wait on each consecutive failure, caps it, and resets on success", async () => {
      let fail = true;
      backlog = async () => { if (fail) throw new Error("linear down"); return []; };
      const { controller } = boot({ pollIntervalSeconds: 100 });
      controller.enable();
      const waits: number[] = [];
      for (let i = 0; i < 6; i++) {
        const out = await controller.pollOnce();
        expect(out.error).toBe("linear down");
        const s = controller.status();
        waits.push((Date.parse(s.nextPollAt!) - t) / 1000);
        t = Date.parse(s.nextPollAt!);
      }
      expect(waits).toEqual([200, 400, 800, 1600, 1600, 1600]);
      expect(controller.status()).toMatchObject({ failStreak: 6, lastError: "linear down" });
      fail = false;
      await controller.pollOnce();
      expect(controller.status()).toMatchObject({ failStreak: 0, lastError: null });
      expect((Date.parse(controller.status().nextPollAt!) - t) / 1000).toBe(100);
    });

    it("a tracker that never answers times out and backs off", async () => {
      backlog = () => new Promise<string[]>(() => {});
      const { controller } = boot({}, { pollTimeoutMs: 20 });
      controller.enable();
      const out = await controller.pollOnce();
      expect(out.error).toMatch(/timed out/);
      expect(controller.status().failStreak).toBe(1);
    });

    it("failure state survives a restart", async () => {
      backlog = async () => { throw new Error("linear down"); };
      const first = boot();
      first.controller.enable();
      await first.controller.pollOnce();
      db.close();
      const second = boot();
      expect(second.controller.status()).toMatchObject({ failStreak: 1, lastError: "linear down" });
    });
  });

  describe("closed-ticket cooldown", () => {
    it("does not re-admit a ticket it just closed, then admits it after the window", async () => {
      backlog = async () => ["RIG-90"];
      const { controller, admissions } = boot({ cooldownSeconds: 3600, pollIntervalSeconds: 60 });
      controller.enable();
      await controller.pollOnce();
      await admissions.reconcile("RIG-90", "closed");
      t += 120_000;
      expect(await controller.pollOnce()).toMatchObject({ admitted: [] });
      expect(admissions.liveAdmissionCount()).toBe(0);
      t += 3600_000;
      expect((await controller.pollOnce()).admitted).toEqual(["RIG-90"]);
    });
  });

  describe("RIG-87 prerequisites", () => {
    it("a failed orphan instance is closed on recovery, not reactivated, so capacity is not double-booked", async () => {
      const { admissions } = boot();
      const r = await admissions.admit("RIG-90");
      if (!r.admitted) throw new Error("expected admitted");
      db.prepare(`UPDATE workflow_instances SET status = 'failed' WHERE instance_id = ?`).run(r.admission.instanceId);
      db.prepare(`UPDATE ticket_admissions SET state = 'pending', instance_id = NULL WHERE id = ?`).run(r.admission.id);
      expect(await admissions.recoverPending()).toEqual({ resumed: 0, adopted: 1 });
      expect(admissions.getById(r.admission.id)).toMatchObject({ state: "closed", stateReason: "workflow failed" });
      expect(admissions.liveAdmissionCount()).toBe(0);
    });

    it("confirming a reconciling admission open does not revive a finished workflow", async () => {
      const { admissions } = boot();
      const r = await admissions.admit("RIG-90");
      if (!r.admitted) throw new Error("expected admitted");
      await admissions.reconcile("RIG-90", "unknown");
      db.prepare(`UPDATE workflow_instances SET status = 'failed' WHERE instance_id = ?`).run(r.admission.instanceId);
      expect(await admissions.reconcile("RIG-90", "open")).toBe("closed");
      expect(admissions.liveAdmissionCount()).toBe(0);
    });

    it("orphan matching uses the exact Root objective line, not a substring hit in another packet", async () => {
      const { admissions } = boot({ capacity: 5 });
      const other = await admissions.admit("RIG-91");
      if (!other.admitted) throw new Error("expected admitted");
      const key = "RIG-90@2026-10-14T01:00:00.000Z";
      db.prepare(`INSERT INTO ticket_admissions (id,ticket_id,instance_key,state,disposition,evidence_json,created_at,updated_at)
        VALUES ('p1','RIG-90',?,'pending','ready','{}','t','t')`).run(key);
      // RIG-91's entry packet merely mentions RIG-90's key in prose.
      db.prepare(`UPDATE queue_items SET body = body || ? WHERE body LIKE ?`).run(`\nsee also ${key}`, `%${other.admission.instanceKey}%`);
      expect(await admissions.recoverPending()).toEqual({ resumed: 1, adopted: 0 });
      expect(runtime.instanceStore.listAll()).toHaveLength(2);
    });
  });

  describe("config mapping and merge precedence", () => {
    it("merge_gate: all overrides merge_policy: auto-low-risk", () => {
      expect(resolveMergePolicy("all", "auto-low-risk")).toMatchObject({ effective: "human-approval", reason: expect.stringContaining("overrides") });
      expect(resolveMergePolicy("all", "human").effective).toBe("human-approval");
    });

    it("auto-low-risk applies only when the gate is not all", () => {
      expect(resolveMergePolicy("escalate-only", "auto-low-risk").effective).toBe("auto-low-risk");
      expect(resolveMergePolicy("escalate-only", "human").effective).toBe("human-approval");
    });

    it("maps the project's .factory.yml onto settings", () => {
      const text = readFileSync(resolve(import.meta.dirname, "../../../.factory.yml"), "utf8");
      expect(parseFactorySettings(text)).toMatchObject({
        maxTicketsPerRun: 3, wallClockPerTicketSeconds: 3600, mergeGate: "all", mergePolicy: "auto-low-risk",
        tokenCapPerTicket: 500000, capacity: 1, cooldownSeconds: 3600,
      });
    });

    it("scheduler keys override the defaults and bad values fall back", () => {
      expect(parseFactorySettings("scheduler:\n  poll_interval_seconds: 90\n  capacity: 2\n  cooldown_seconds: 10\n"))
        .toMatchObject({ pollIntervalSeconds: 90, capacity: 2, cooldownSeconds: 10 });
      expect(parseFactorySettings("scheduler:\n  capacity: -4\n").capacity).toBe(1);
    });

    it("status reports the effective merge policy from the stored settings", () => {
      const { controller } = boot({ mergeGate: "all", mergePolicy: "auto-low-risk" });
      expect(controller.status().merge).toMatchObject({ effective: "human-approval", gate: "all", policy: "auto-low-risk" });
    });

    it("status states that token-per-ticket is advisory", () => {
      const { controller } = boot();
      expect(controller.status().budget.tokensPerTicket).toMatch(/advisory/);
    });
  });

  describe("routes", () => {
    const app = (controller?: TicketFactoryController) => {
      const root = new Hono();
      root.use("*", async (c, next) => { c.set("ticketFactory" as never, controller as never); await next(); });
      root.route("/api/ticket-factory", ticketFactoryRoutes());
      return root;
    };

    it("answers 503 when no controller runs", async () => {
      boot();
      expect((await app().request("/api/ticket-factory/status")).status).toBe(503);
    });

    it("serves status and applies verbs", async () => {
      const { controller } = boot();
      const a = app(controller);
      expect(await (await a.request("/api/ticket-factory/status")).json()).toMatchObject({ state: "disabled", capacity: 1 });
      expect(await (await a.request("/api/ticket-factory/enable", { method: "POST" })).json()).toMatchObject({ state: "running" });
      expect(await (await a.request("/api/ticket-factory/pause", { method: "POST" })).json()).toMatchObject({ state: "paused" });
      expect(await (await a.request("/api/ticket-factory/resume", { method: "POST" })).json()).toMatchObject({ state: "running" });
    });
  });
});
