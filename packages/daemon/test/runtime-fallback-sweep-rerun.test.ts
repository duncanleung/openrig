// RIG-43 regression test: lost-wakeup in executeManualSwapBack sweeping guard.
// A node that becomes swap_back_pending while a sweep is in-flight must be
// processed in a rerun after the in-flight sweep finishes.
import { describe, it, expect, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RuntimeFallbackService } from "../src/domain/runtime-fallback-service.js";
import type { SeatHandoverService } from "../src/domain/seat-handover-service.js";
import type { SeatHandoverMutationResult } from "../src/domain/seat-handover-service.js";

type HandoverResult = Awaited<ReturnType<SeatHandoverService["handover"]>>;
const ok = (): HandoverResult =>
  ({ ok: true, result: {} as unknown as SeatHandoverMutationResult }) as HandoverResult;

/** Simulate what the real handover does: clear fallback_state for the node identified by seatRef. */
function clearFallbackState(db: Database.Database, seatRef: string | undefined): void {
  if (!seatRef) return;
  const [logicalId, rigName] = seatRef.split("@");
  db.prepare(
    "UPDATE nodes SET fallback_state = NULL, fallback_pool_key = NULL WHERE logical_id = ? AND rig_id = (SELECT id FROM rigs WHERE name = ?)"
  ).run(logicalId, rigName);
}

describe("RuntimeFallbackService — sweep rerun on concurrent event", () => {
  it("processes a node that becomes swap_back_pending while a sweep is in-flight", async () => {
    const db = createFullTestDb();
    const eventBus = new EventBus(db);

    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'rig')").run();
    db.prepare(
      "INSERT INTO nodes (id, rig_id, logical_id, fallback_state, fallback_pool_key) VALUES ('node-a', 'rig-1', 'seat-a', 'swap_back_pending', 'pool-1')"
    ).run();

    // Barrier lets us control when node-a's handover resolves.
    let unblockA!: () => void;
    const barrierA = new Promise<void>(r => { unblockA = r; });
    let notifyHandoverStarted!: () => void;
    const handoverStarted = new Promise<void>(r => { notifyHandoverStarted = r; });

    const handover = vi.fn().mockImplementation(async (input: Parameters<SeatHandoverService["handover"]>[0]) => {
      if (input.seatRef === "seat-a@rig") {
        notifyHandoverStarted();
        await barrierA;
      }
      // Simulate the real handover clearing fallback_state for the processed node.
      clearFallbackState(db, input.seatRef);
      return ok();
    });

    const shs = { handover } as unknown as SeatHandoverService;
    const svc = new RuntimeFallbackService({ db, eventBus, seatHandoverService: shs });

    // Start the first sweep. It will pause inside node-a's handover.
    const firstSweep = svc.executeManualSwapBack();

    // Wait until node-a's handover has actually been called (sweep is now in-flight).
    await handoverStarted;

    // Node-b arrives while the sweep is in-flight.
    db.prepare(
      "INSERT INTO nodes (id, rig_id, logical_id, fallback_state, fallback_pool_key) VALUES ('node-b', 'rig-1', 'seat-b', 'swap_back_pending', 'pool-1')"
    ).run();

    // Second executeManualSwapBack() — would silently drop without the fix.
    // With the fix: sets sweepRerunRequested = true.
    const secondSweep = svc.executeManualSwapBack();

    // Unblock node-a so the first sweep can finish and the rerun can start.
    unblockA();

    await firstSweep;
    await secondSweep;

    // Both nodes must have been processed: node-a in the first pass,
    // node-b in the rerun triggered by sweepRerunRequested.
    expect(handover).toHaveBeenCalledTimes(2);
  });

  it("does not rerun when no concurrent event arrived", async () => {
    const db = createFullTestDb();
    const eventBus = new EventBus(db);

    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'rig')").run();
    db.prepare(
      "INSERT INTO nodes (id, rig_id, logical_id, fallback_state, fallback_pool_key) VALUES ('node-a', 'rig-1', 'seat-a', 'swap_back_pending', 'pool-1')"
    ).run();

    const handover = vi.fn().mockImplementation(async (input: Parameters<SeatHandoverService["handover"]>[0]) => {
      clearFallbackState(db, input.seatRef);
      return ok();
    });
    const shs = { handover } as unknown as SeatHandoverService;
    const svc = new RuntimeFallbackService({ db, eventBus, seatHandoverService: shs });

    await svc.executeManualSwapBack();

    // Only node-a, no concurrent event — handover called exactly once.
    expect(handover).toHaveBeenCalledTimes(1);
  });
});
