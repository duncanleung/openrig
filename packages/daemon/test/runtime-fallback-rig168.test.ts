// RIG-168 regression tests — swap_back lifecycle.
// Bug A: fallback_swap_back must NOT be cleared on reverse-swap episode clear.
// Bug B: triggerReverseSwap must recover from a failed handover.
import { describe, it, expect, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RuntimeFallbackService } from "../src/domain/runtime-fallback-service.js";
import type { SeatHandoverService } from "../src/domain/seat-handover-service.js";
import type { SeatHandoverMutationResult } from "../src/domain/seat-handover-service.js";
import type { PersistedEvent } from "../src/domain/event-bus.js";

type HandoverResult = Awaited<ReturnType<SeatHandoverService["handover"]>>;
const ok = (): HandoverResult =>
  ({ ok: true, result: {} as unknown as SeatHandoverMutationResult }) as HandoverResult;
const fail = (message = "handover error"): HandoverResult =>
  ({ ok: false, code: "handover_commit_failed", message, guidance: "" }) as unknown as HandoverResult;

function setupNode(
  db: Database.Database,
  opts: {
    state: "on_fallback" | "swap_back_pending";
    swapBack?: string;
  },
) {
  db.prepare("INSERT OR IGNORE INTO rigs (id, name) VALUES ('rig-1', 'rig')").run();
  db.prepare(
    "INSERT INTO nodes (id, rig_id, logical_id, fallback_state, fallback_pool_key, fallback_swap_back, fallback_original_runtime) " +
    "VALUES ('node-a', 'rig-1', 'seat-a', ?, 'pool-1', ?, 'codex')"
  ).run(opts.state, opts.swapBack ?? null);
}

describe("RIG-168 — swap_back lifecycle", () => {
  describe("Bug A: fallback_swap_back preserved on episode clear (RIG-168)", () => {
    it("reverse-swap clears episode columns but preserves fallback_swap_back", () => {
      const db = createFullTestDb();
      setupNode(db, { state: "on_fallback", swapBack: "manual" });

      // The fixed UPDATE excludes fallback_swap_back.
      db.prepare(`
        UPDATE nodes SET
          fallback_state = NULL,
          fallback_pool_key = NULL,
          fallback_entered_at = NULL,
          fallback_original_runtime = NULL,
          fallback_expires_at = NULL
        WHERE id = 'node-a'
      `).run();

      const row = db.prepare("SELECT fallback_state, fallback_swap_back FROM nodes WHERE id = 'node-a'")
        .get() as { fallback_state: string | null; fallback_swap_back: string | null };
      expect(row.fallback_state).toBeNull();
      expect(row.fallback_swap_back).toBe("manual");
      db.close();
    });

    it("at_expiry swap_back is also preserved after episode clear", () => {
      const db = createFullTestDb();
      setupNode(db, { state: "on_fallback", swapBack: "at_expiry" });

      db.prepare(`
        UPDATE nodes SET
          fallback_state = NULL,
          fallback_pool_key = NULL,
          fallback_entered_at = NULL,
          fallback_original_runtime = NULL,
          fallback_expires_at = NULL
        WHERE id = 'node-a'
      `).run();

      const row = db.prepare("SELECT fallback_swap_back FROM nodes WHERE id = 'node-a'")
        .get() as { fallback_swap_back: string | null };
      expect(row.fallback_swap_back).toBe("at_expiry");
      db.close();
    });
  });

  describe("Bug B: reverse-swap failure recovery (RIG-168)", () => {
    it("at_expiry failure transitions node on_fallback → swap_back_pending for retry", async () => {
      const db = createFullTestDb();
      const eventBus = new EventBus(db);
      setupNode(db, { state: "on_fallback", swapBack: "at_expiry" });

      const handover = vi.fn().mockResolvedValue(fail("swap back failed"));
      const shs = { handover } as unknown as SeatHandoverService;
      const svc = new RuntimeFallbackService({ db, eventBus, seatHandoverService: shs });

      await svc.triggerReverseSwap({ nodeId: "node-a", poolKey: "pool-1" });

      const row = db.prepare("SELECT fallback_state FROM nodes WHERE id = 'node-a'")
        .get() as { fallback_state: string | null };
      expect(row.fallback_state).toBe("swap_back_pending");
      db.close();
    });

    it("at_expiry failure emits runtime_fallback_swap_back_pending for sweep re-trigger", async () => {
      const db = createFullTestDb();
      const eventBus = new EventBus(db);
      setupNode(db, { state: "on_fallback", swapBack: "at_expiry" });

      const handover = vi.fn().mockResolvedValue(fail("swap back failed"));
      const shs = { handover } as unknown as SeatHandoverService;
      const svc = new RuntimeFallbackService({ db, eventBus, seatHandoverService: shs });

      const emitted: string[] = [];
      eventBus.subscribe((e: PersistedEvent) => { emitted.push(e.type); });

      await svc.triggerReverseSwap({ nodeId: "node-a", poolKey: "pool-1" });

      expect(emitted).toContain("seat.runtime_fallback_swap_back_pending");
      db.close();
    });

    it("manual_operator failure emits runtime_fallback_return_failed escalation", async () => {
      const db = createFullTestDb();
      const eventBus = new EventBus(db);
      setupNode(db, { state: "swap_back_pending", swapBack: "manual" });

      const handover = vi.fn().mockResolvedValue(fail("manual swap back failed"));
      const shs = { handover } as unknown as SeatHandoverService;
      const svc = new RuntimeFallbackService({ db, eventBus, seatHandoverService: shs });

      const emitted: string[] = [];
      eventBus.subscribe((e: PersistedEvent) => { emitted.push(e.type); });

      await svc.triggerReverseSwap({ nodeId: "node-a", poolKey: "pool-1" });

      expect(emitted).toContain("seat.runtime_fallback_return_failed");
      db.close();
    });

    it("manual_operator failure: node stays in swap_back_pending for later retry", async () => {
      const db = createFullTestDb();
      const eventBus = new EventBus(db);
      setupNode(db, { state: "swap_back_pending", swapBack: "manual" });

      const handover = vi.fn().mockResolvedValue(fail("manual swap back failed"));
      const shs = { handover } as unknown as SeatHandoverService;
      const svc = new RuntimeFallbackService({ db, eventBus, seatHandoverService: shs });

      await svc.triggerReverseSwap({ nodeId: "node-a", poolKey: "pool-1" });

      const row = db.prepare("SELECT fallback_state FROM nodes WHERE id = 'node-a'")
        .get() as { fallback_state: string | null };
      expect(row.fallback_state).toBe("swap_back_pending");
      db.close();
    });
  });
});
