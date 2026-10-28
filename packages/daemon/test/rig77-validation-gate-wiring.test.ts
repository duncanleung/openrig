import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { watchdogJobsSchema } from "../src/db/migrations/031_watchdog_jobs.js";
import { watchdogHistorySchema } from "../src/db/migrations/032_watchdog_history.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemEvidenceRefSchema } from "../src/db/migrations/048_queue_item_evidence_ref.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, QueueRepositoryError } from "../src/domain/queue-repository.js";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import type { ValidationGateResult } from "../src/domain/validation-gate-enforcer.js";

// RIG-145: merge e02d09c64 dropped the RIG-77 validation_gate schema key, parser, startup
// injection, and the queue-repository call sites. The enforcer's own tests kept passing because
// they never touch these seams. These tests pin the seams.

const RIG = {
  version: "0.2",
  name: "gate-rig",
  pods: [{
    id: "dev",
    label: "Dev",
    members: [{ id: "impl", agent_ref: "local:agents/impl", profile: "tdd", runtime: "claude-code", cwd: "." }],
    edges: [],
  }],
  edges: [],
};

describe("RIG-77 validation_gate in the rig spec schema", () => {
  it("accepts a validation_gate block and normalizes it", () => {
    const raw = { ...RIG, validation_gate: { mode: "enforce", validators: ["advisor@*"], impl_seats: ["dev.impl"], warn_until: "2026-12-01" } };
    expect(RigSpecSchema.validate(raw)).toMatchObject({ valid: true, errors: [] });
    expect(RigSpecSchema.normalize(raw).validationGate).toEqual({
      mode: "enforce", validators: ["advisor@*"], impl_seats: ["dev.impl"], warn_until: "2026-12-01",
    });
  });

  it("defaults mode to warn and lists to empty", () => {
    expect(RigSpecSchema.normalize({ ...RIG, validation_gate: {} }).validationGate)
      .toEqual({ mode: "warn", validators: [], impl_seats: [], warn_until: undefined });
  });

  it("rejects a bad mode and non-string lists with field paths", () => {
    const result = RigSpecSchema.validate({
      ...RIG,
      validation_gate: { mode: "strict", validators: [1], impl_seats: "dev.impl", warn_until: 5 },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("validation_gate.mode"),
      expect.stringContaining("validation_gate.validators"),
      expect.stringContaining("validation_gate.impl_seats"),
      expect.stringContaining("validation_gate.warn_until"),
    ]));
  });

  it("is absent from the normalized spec when the block is omitted", () => {
    expect(RigSpecSchema.normalize(RIG).validationGate).toBeUndefined();
  });
});

describe("RIG-77 validation gate wired into the queue repository", () => {
  let db: Database.Database;
  let calls: Array<{ destinationSession: string; tags: string[] | null; viaWorkflowProjection?: boolean; dedupSeed?: string }>;
  let verdict: ValidationGateResult;
  let repo: QueueRepository;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, outboxEntriesSchema,
      watchdogJobsSchema, watchdogHistorySchema, queueItemSummarySchema, queueItemEvidenceRefSchema,
    ]);
    calls = [];
    verdict = { ok: true };
    repo = new QueueRepository(db, new EventBus(db), {
      // Like the real gate, only a dispatch to the impl seat is judged; the advisor wake item passes.
      validationGatePredicate: (input) => {
        calls.push(input);
        return input.destinationSession === "impl@rig" ? verdict : { ok: true };
      },
    });
  });

  afterEach(() => db.close());

  const BLOCK: ValidationGateResult = {
    ok: false,
    code: "validation_gate_missing",
    message: "validation evidence is missing",
    meta: { what: "dispatch to dev.impl", why: "no gate:validation done", fix: "run /codex-second-opinion" },
    advisorRequest: { dedupKey: "k1", advisorSession: "advisor@rig", destinationLogicalId: "dev.impl", mode: "enforce", what: "dispatch to dev.impl" },
  };

  it("create asks the gate, throws its code when blocked, and writes no row for the blocked dispatch", async () => {
    verdict = BLOCK;
    await expect(repo.create({ sourceSession: "lead@rig", destinationSession: "impl@rig", body: "do it", nudge: false }))
      .rejects.toMatchObject({ code: "validation_gate_missing" });
    expect(calls.filter((c) => c.destinationSession === "impl@rig")).toHaveLength(1);
    const rows = db.prepare("SELECT destination_session FROM queue_items").all() as Array<{ destination_session: string }>;
    expect(rows.map((r) => r.destination_session)).not.toContain("impl@rig");
  });

  it("a blocked create still wakes the advisor once with a gate-for tag", async () => {
    verdict = BLOCK;
    await repo.create({ sourceSession: "lead@rig", destinationSession: "impl@rig", body: "do it", nudge: false }).catch(() => undefined);
    await repo.create({ sourceSession: "lead@rig", destinationSession: "impl@rig", body: "do it", nudge: false }).catch(() => undefined);
    const rows = db.prepare("SELECT destination_session, tags FROM queue_items").all() as Array<{ destination_session: string; tags: string }>;
    const advisorRows = rows.filter((r) => r.destination_session === "advisor@rig");
    expect(advisorRows).toHaveLength(1);
    expect(JSON.parse(advisorRows[0]!.tags)).toEqual(["gate:validation-request", "gate-for:k1"]);
  });

  it("passes viaWorkflowProjection through so workflow projections are exempt", async () => {
    await repo.create({ sourceSession: "wf@rig", destinationSession: "impl@rig", body: "x", nudge: false, viaWorkflowProjection: true });
    expect(calls[0]).toMatchObject({ viaWorkflowProjection: true });
  });

  it("handoff asks the gate and does not inherit work:mechanical", async () => {
    const source = await repo.create({
      sourceSession: "lead@rig", destinationSession: "orch@rig", body: "plan", nudge: false, tags: ["work:mechanical", "keep"],
    });
    calls.length = 0;
    await repo.handoff({ qitemId: source.qitemId, fromSession: "orch@rig", toSession: "impl@rig", nudge: false } as never);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tags).toEqual(["keep"]);
    expect(calls[0]).toMatchObject({ destinationSession: "impl@rig", dedupSeed: `handoff:${source.qitemId}` });
  });

  it("surfaces the gate error as a QueueRepositoryError", async () => {
    verdict = BLOCK;
    const err = await repo.create({ sourceSession: "lead@rig", destinationSession: "impl@rig", body: "x", nudge: false }).catch((e) => e);
    expect(err).toBeInstanceOf(QueueRepositoryError);
    expect(err.meta).toMatchObject({ fix: "run /codex-second-opinion" });
  });
});
