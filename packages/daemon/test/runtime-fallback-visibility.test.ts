// RIG-101 — read-only fallback visibility in node inventory and seat status.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatStatusService } from "../src/domain/seat-status-service.js";
import { nodeRuntimeFallbackSchema } from "../src/db/migrations/090_node_runtime_fallback.js";
import { nodeFallbackExpiresAtSchema } from "../src/db/migrations/091_node_fallback_expires_at.js";
import { getNodeInventory } from "../src/domain/node-inventory.js";

describe("runtime fallback visibility", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let registry: SessionRegistry;

  beforeEach(() => {
    db = createFullTestDb();
    // createFullTestDb omits 090/091 today; a daemon database has them.
    db.exec(nodeRuntimeFallbackSchema.sql);
    db.exec(nodeFallbackExpiresAtSchema.sql);
    rigRepo = new RigRepository(db);
    registry = new SessionRegistry(db);
  });
  afterEach(() => db.close());

  function seat(logicalId: string, rigName = "fb-rig") {
    const rig = rigRepo.findUnarchivedRigsByName(rigName)[0] ?? rigRepo.createRig(rigName);
    const node = rigRepo.addNode(rig.id, logicalId, { runtime: "claude-code" });
    const session = registry.registerSession(node.id, `${logicalId.replace(".", "-")}@${rigName}`);
    registry.updateStatus(session.id, "running");
    registry.updateStartupStatus(session.id, "ready");
    return { rig, node, session };
  }

  const enterFallback = (nodeId: string, state = "on_fallback") =>
    db.prepare(`UPDATE nodes SET fallback_state = ?, fallback_original_runtime = 'codex', fallback_pool_key = 'codex:pool',
      fallback_entered_at = '2026-10-21T10:00:00Z', fallback_expires_at = '2026-10-21T15:00:00Z', fallback_swap_back = 'manual' WHERE id = ?`)
      .run(state, nodeId);

  it("omits runtimeFallback entirely for a seat that is not on fallback", () => {
    const { rig } = seat("dev.impl");
    const [entry] = getNodeInventory(db, rig.id);
    expect("runtimeFallback" in entry!).toBe(false);
  });

  it("projects the fallback columns for a seat on fallback", () => {
    const { rig, node } = seat("dev.impl");
    enterFallback(node.id);
    const [entry] = getNodeInventory(db, rig.id);
    expect(entry!.runtimeFallback).toEqual({
      state: "on_fallback",
      originalRuntime: "codex",
      currentRuntime: "claude-code",
      poolKey: "codex:pool",
      enteredAt: "2026-10-21T10:00:00Z",
      expiresAt: "2026-10-21T15:00:00Z",
      swapBack: "manual",
      swapBackPending: false,
    });
    // Lifecycle is not replaced.
    expect(entry!.lifecycleState).toBeDefined();
    expect(entry!.sessionStatus).toBe("running");
  });

  it("flags swapBackPending only for swap_back_pending", () => {
    const { rig, node } = seat("dev.impl");
    enterFallback(node.id, "swap_back_pending");
    const [entry] = getNodeInventory(db, rig.id);
    expect(entry!.runtimeFallback).toMatchObject({ state: "swap_back_pending", swapBackPending: true });
  });

  it("keeps a null swap-back policy as null, not a default", () => {
    const { rig, node } = seat("dev.impl");
    enterFallback(node.id);
    db.prepare("UPDATE nodes SET fallback_swap_back = NULL WHERE id = ?").run(node.id);
    expect(getNodeInventory(db, rig.id)[0]!.runtimeFallback!.swapBack).toBeNull();
  });

  it("does not leak fallback state between seats", () => {
    const a = seat("dev.impl");
    seat("dev.qa");
    enterFallback(a.node.id);
    const byId = new Map(getNodeInventory(db, a.rig.id).map((e) => [e.logicalId, e]));
    expect(byId.get("dev.impl")!.runtimeFallback).toBeDefined();
    expect(byId.get("dev.qa")!.runtimeFallback).toBeUndefined();
  });

  it("still lists seats on a database without the fallback columns", () => {
    const old = createFullTestDb();
    try {
      const cols = old.prepare("PRAGMA table_info(nodes)").all().map((c) => (c as { name: string }).name);
      expect(cols).not.toContain("fallback_state");
      const repo = new RigRepository(old);
      const rig = repo.createRig("old-rig");
      repo.addNode(rig.id, "dev.impl", { runtime: "codex" });
      const entries = getNodeInventory(old, rig.id);
      expect(entries).toHaveLength(1);
      expect("runtimeFallback" in entries[0]!).toBe(false);
    } finally {
      old.close();
    }
  });

  describe("seat status", () => {
    it("exposes runtime_fallback only while on fallback", () => {
      const { node } = seat("dev.impl");
      const svc = new SeatStatusService({ rigRepo });
      const before = svc.getStatus("dev-impl@fb-rig");
      if (!before.ok) throw new Error(before.message);
      expect("runtime_fallback" in before.status).toBe(false);

      enterFallback(node.id);
      const after = svc.getStatus("dev-impl@fb-rig");
      if (!after.ok) throw new Error(after.message);
      expect(after.status.runtime_fallback).toMatchObject({
        state: "on_fallback", originalRuntime: "codex", currentRuntime: "claude-code",
        expiresAt: "2026-10-21T15:00:00Z", swapBack: "manual", swapBackPending: false,
      });
    });

    it("exposes a pending return", () => {
      const { node } = seat("dev.impl");
      enterFallback(node.id, "swap_back_pending");
      const r = new SeatStatusService({ rigRepo }).getStatus("dev-impl@fb-rig");
      if (!r.ok) throw new Error(r.message);
      expect(r.status.runtime_fallback!.swapBackPending).toBe(true);
    });
  });
});
