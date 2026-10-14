// RIG-91 — a gate's evidence_ref must exist (workspace-contained) when the gate item is projected.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { checkGateEvidence } from "../src/domain/workflow-projector.js";

const TICKET_FACTORY = resolve(import.meta.dirname, "../src/builtins/workflow-specs/ticket-factory.yaml");
const ORCH = "orch-lead@openrig";

const graphSpec = (ref: string) => `workflow:
  id: graph-gate
  version: 1
  entry: {role: owner}
  roles:
    owner: {preferred_targets: [owner@rig]}
  exception_routing: {orchestrator_role: owner}
  steps:
    - id: build
      actor_role: owner
      depends_on: []
      allowed_exits: [handoff, failed]
    - id: signoff
      actor_role: owner
      depends_on: [build]
      allowed_exits: [done, failed]
      gate: {target: human@host, summary: Sign-off, evidence_ref: "${ref}"}
`;

describe("gate evidence file check (RIG-91)", () => {
  let db: Database.Database;
  let queueRepo: QueueRepository;
  let eventBus: EventBus;
  let tmp: string;
  let root: string;
  let outside: string;

  const makeRuntime = (workspaceRoot?: () => string | null | undefined) =>
    new WorkflowRuntime({ db, eventBus, queueRepo, workspaceRoot });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gate-evidence-"));
    root = join(tmp, "ws");
    outside = join(tmp, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    db = createDb(join(tmp, "daemon.sqlite"));
    migrate(db, ALL_MIGRATIONS);
    eventBus = new EventBus(db);
    queueRepo = new QueueRepository(db, eventBus, { validateRig: () => true });
    queueRepo.attachOutbox(new OutboxHandler(db));
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-openrig', 'openrig')`).run();
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('rig', 'rig')`).run();
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Drive ticket-factory up to merge_prep; return the merge_prep packet. */
  async function toMergePrep(runtime: WorkflowRuntime) {
    const created = await runtime.instantiate({ specPath: TICKET_FACTORY, rootObjective: "ticket RIG-99", createdBySession: ORCH });
    const id = created.instance.instanceId;
    let packet = created.entryQitemId;
    for (const stepId of ["intake", "plan", "validate", "implement", "qa_check", "review"]) {
      const evidence = stepId === "validate"
        ? { acceptance: { candidate: "ticket-plan", verdict: "approved", evidence_ref: "proof/validation.md" } }
        : undefined;
      packet = (await runtime.project({ instanceId: id, currentPacketId: packet, exit: "handoff", actorSession: ORCH, closureEvidence: evidence })).nextQitemId!;
    }
    return { id, packet };
  }
  const handoff = (runtime: WorkflowRuntime, id: string, packet: string) =>
    runtime.project({ instanceId: id, currentPacketId: packet, exit: "handoff", actorSession: ORCH });

  describe("projectStep (linear route)", () => {
    it("rejects a missing evidence file and leaves state untouched", async () => {
      const runtime = makeRuntime(() => root);
      const { id, packet } = await toMergePrep(runtime);
      await expect(handoff(runtime, id, packet)).rejects.toMatchObject({ code: "gate_evidence_missing" });
      expect(queueRepo.getById(packet)?.state).not.toBe("done");
    });

    it("accepts when the evidence file exists", async () => {
      mkdirSync(join(root, "proof"));
      writeFileSync(join(root, "proof/PROOF.md"), "evidence");
      const runtime = makeRuntime(() => root);
      const { id, packet } = await toMergePrep(runtime);
      const r = await handoff(runtime, id, packet);
      expect(queueRepo.getById(r.nextQitemId!)?.blockedOn).toBe("human@kernel");
    });

    it.each([["undefined", undefined], ["null", () => null], ["getter returning undefined", () => undefined]])(
      "skips the check when workspace root is %s",
      async (_name, getter) => {
        const runtime = makeRuntime(getter as never);
        const { id, packet } = await toMergePrep(runtime);
        const r = await handoff(runtime, id, packet);
        expect(r.nextQitemId).toBeTruthy();
      },
    );
  });

  describe("dependency-graph advance", () => {
    async function start(ref: string, workspaceRoot: () => string | null) {
      const runtime = makeRuntime(workspaceRoot);
      const specPath = join(tmp, "graph.yaml");
      writeFileSync(specPath, graphSpec(ref));
      const started = await runtime.instantiate({ specPath, rootObjective: "graph", createdBySession: "owner@rig" });
      return { runtime, id: started.instance.instanceId, entry: started.entryQitemId };
    }
    const advance = (s: { runtime: WorkflowRuntime; id: string; entry: string }) =>
      s.runtime.project({ instanceId: s.id, currentPacketId: s.entry, exit: "handoff", actorSession: "owner@rig" });

    it("rejects a missing evidence file", async () => {
      const s = await start("proof/build.md", () => root);
      await expect(advance(s)).rejects.toMatchObject({ code: "gate_evidence_missing" });
      expect(queueRepo.getById(s.entry)?.state).not.toBe("done");
    });

    it("accepts a present file", async () => {
      mkdirSync(join(root, "proof"));
      writeFileSync(join(root, "proof/build.md"), "ok");
      const s = await start("proof/build.md", () => root);
      expect((await advance(s)).nextStepIds).toEqual(["signoff"]);
    });

    it("skips with a null root", async () => {
      const s = await start("proof/build.md", () => null);
      expect((await advance(s)).nextStepIds).toEqual(["signoff"]);
    });

    it("rejects an escaping ref", async () => {
      writeFileSync(join(outside, "x.md"), "x");
      const s = await start("../outside/x.md", () => root);
      await expect(advance(s)).rejects.toMatchObject({ code: "gate_evidence_outside_workspace" });
    });
  });

  describe("checkGateEvidence", () => {
    const check = (ref: string | null | undefined, ws: string | null | undefined = root) =>
      checkGateEvidence(ref, ws, { stepId: "s" });

    it.each(["https://example.com/proof", "file:///nope", "rig whoami --json", "  rig queue list"])(
      "skips non-file ref %s", (ref) => { expect(() => check(ref)).not.toThrow(); });

    it("skips empty ref and missing root", () => {
      expect(() => check(undefined)).not.toThrow();
      expect(() => check("")).not.toThrow();
      expect(() => check("proof/x.md", null)).not.toThrow();
      expect(() => check("proof/x.md", "")).not.toThrow();
    });

    it("rejects ../ escape even when the target exists", () => {
      writeFileSync(join(outside, "secret.md"), "s");
      expect(() => check("../outside/secret.md")).toThrowError(expect.objectContaining({ code: "gate_evidence_outside_workspace" }));
    });

    it("rejects ../ escape when the target does not exist (no existence oracle)", () => {
      expect(() => check("../outside/nope.md")).toThrowError(expect.objectContaining({ code: "gate_evidence_outside_workspace" }));
    });

    it("rejects an absolute path", () => {
      writeFileSync(join(outside, "abs.md"), "s");
      expect(() => check(join(outside, "abs.md"))).toThrowError(expect.objectContaining({ code: "gate_evidence_outside_workspace" }));
    });

    it("rejects a symlink inside the root that points outside", () => {
      writeFileSync(join(outside, "target.md"), "s");
      symlinkSync(join(outside, "target.md"), join(root, "link.md"));
      expect(() => check("link.md")).toThrowError(expect.objectContaining({ code: "gate_evidence_outside_workspace" }));
    });

    it("accepts a nested relative file and a ..-prefixed file name", () => {
      mkdirSync(join(root, "a"));
      writeFileSync(join(root, "a/b.md"), "x");
      writeFileSync(join(root, "..notes.md"), "x");
      expect(() => check("a/b.md")).not.toThrow();
      expect(() => check("./a/b.md")).not.toThrow();
      expect(() => check("..notes.md")).not.toThrow();
    });

    it("reports missing for an in-root absent file", () => {
      expect(() => check("proof/PROOF.md")).toThrowError(expect.objectContaining({ code: "gate_evidence_missing" }));
    });
  });
});
