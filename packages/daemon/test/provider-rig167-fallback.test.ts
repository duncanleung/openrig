// RIG-167 — seat fallback status in provider read model.
// Verifies listSeatFallbacks() populates seatFallbacks in getReadModel() and
// that nodes without fallback state are not included.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { ProviderServiceImpl } from "../src/domain/provider/provider-service-impl.js";

const ASOF = "2026-11-01T00:00:00.000Z";

function emptyCodexHomeEnv(): NodeJS.ProcessEnv {
  const home = fs.mkdtempSync(nodePath.join(os.tmpdir(), "provider-rig167-"));
  return { CODEX_HOME: home } as NodeJS.ProcessEnv;
}

function setupRigWithSeat(db: ReturnType<typeof createFullTestDb>, opts: {
  rigName?: string;
  logicalId?: string;
  fallback?: {
    state: "on_fallback" | "swap_back_pending";
    swapBack?: "at_expiry" | "manual";
    poolKey?: string;
    originalRuntime?: string;
    enteredAt?: string;
    expiresAt?: string;
  };
}) {
  const rigName = opts.rigName ?? "test-rig";
  const logicalId = opts.logicalId ?? "dev-impl";
  const rigRepo = new RigRepository(db);
  const registry = new SessionRegistry(db);
  const rig = rigRepo.createRig(rigName);
  const node = rigRepo.addNode(rig.id, logicalId, { runtime: "claude-code" });
  const session = registry.registerSession(node.id, `${logicalId}@${rigName}`);
  registry.updateStatus(session.id, "running");
  registry.updateStartupStatus(session.id, "ready");

  if (opts.fallback) {
    const { state, swapBack, poolKey, originalRuntime, enteredAt, expiresAt } = opts.fallback;
    db.prepare(
      "UPDATE nodes SET fallback_state = ?, fallback_swap_back = ?, fallback_pool_key = ?, " +
      "fallback_original_runtime = ?, fallback_entered_at = ?, fallback_expires_at = ? WHERE id = ?"
    ).run(
      state,
      swapBack ?? "at_expiry",
      poolKey ?? "codex:pool",
      originalRuntime ?? "codex",
      enteredAt ?? "2026-11-01T00:00:00Z",
      expiresAt ?? "2026-11-01T06:00:00Z",
      node.id,
    );
  }

  return { rig, node };
}

describe("RIG-167 — provider read model seatFallbacks", () => {
  it("seatFallbacks is absent when no seat is on fallback", async () => {
    const db = createFullTestDb();
    const { rig } = setupRigWithSeat(db, {});
    const svc = new ProviderServiceImpl({
      db,
      listRigs: () => [rig],
      env: emptyCodexHomeEnv(),
      now: () => ASOF,
    });
    const model = await svc.getReadModel();
    expect(model.seatFallbacks).toBeUndefined();
    db.close();
  });

  it("seatFallbacks contains on_fallback seats", async () => {
    const db = createFullTestDb();
    const { rig } = setupRigWithSeat(db, {
      fallback: { state: "on_fallback", swapBack: "at_expiry", poolKey: "codex:pool-1", originalRuntime: "codex" },
    });
    const svc = new ProviderServiceImpl({
      db,
      listRigs: () => [rig],
      env: emptyCodexHomeEnv(),
      now: () => ASOF,
    });
    const model = await svc.getReadModel();
    expect(model.seatFallbacks).toHaveLength(1);
    const entry = model.seatFallbacks![0]!;
    expect(entry.seatSession).toBe("dev-impl@test-rig");
    expect(entry.rigName).toBe("test-rig");
    expect(entry.state).toBe("on_fallback");
    expect(entry.originalRuntime).toBe("codex");
    expect(entry.currentRuntime).toBe("claude-code");
    expect(entry.poolKey).toBe("codex:pool-1");
    expect(entry.swapBack).toBe("at_expiry");
    expect(entry.swapBackPending).toBe(false);
    db.close();
  });

  it("seatFallbacks contains swap_back_pending seats with swapBackPending=true", async () => {
    const db = createFullTestDb();
    const { rig } = setupRigWithSeat(db, {
      fallback: { state: "swap_back_pending", swapBack: "manual" },
    });
    const svc = new ProviderServiceImpl({
      db,
      listRigs: () => [rig],
      env: emptyCodexHomeEnv(),
      now: () => ASOF,
    });
    const model = await svc.getReadModel();
    expect(model.seatFallbacks).toHaveLength(1);
    const entry = model.seatFallbacks![0]!;
    expect(entry.state).toBe("swap_back_pending");
    expect(entry.swapBack).toBe("manual");
    expect(entry.swapBackPending).toBe(true);
    db.close();
  });

  it("seatFallbacks includes all rigs with fallback seats", async () => {
    const db = createFullTestDb();
    const { rig: rigA } = setupRigWithSeat(db, {
      rigName: "rig-a", logicalId: "seat-a",
      fallback: { state: "on_fallback" },
    });
    const { rig: rigB } = setupRigWithSeat(db, {
      rigName: "rig-b", logicalId: "seat-b",
      fallback: { state: "on_fallback" },
    });
    const { rig: rigC } = setupRigWithSeat(db, {
      rigName: "rig-c", logicalId: "seat-c",
      // no fallback
    });
    const svc = new ProviderServiceImpl({
      db,
      listRigs: () => [rigA, rigB, rigC],
      env: emptyCodexHomeEnv(),
      now: () => ASOF,
    });
    const model = await svc.getReadModel();
    expect(model.seatFallbacks).toHaveLength(2);
    const sessions = model.seatFallbacks!.map((e) => e.seatSession).sort();
    expect(sessions).toEqual(["seat-a@rig-a", "seat-b@rig-b"]);
    db.close();
  });

  it("seatFallbacks is absent when listRigs returns empty (existing getReadModel shape unchanged)", async () => {
    const db = createFullTestDb();
    const svc = new ProviderServiceImpl({
      db,
      listRigs: () => [],
      env: emptyCodexHomeEnv(),
      now: () => ASOF,
    });
    const model = await svc.getReadModel();
    // Existing baseline shape unchanged.
    expect(model).toMatchObject({ accounts: [], bindings: [], signals: [], asOf: ASOF });
    expect(model.seatFallbacks).toBeUndefined();
    db.close();
  });
});
