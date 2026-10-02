// RIG-43: runtime fallback on provider usage limit.
// This service executes forward (usage-limit triggered) and reverse (expiry triggered) runtime swaps.
// It is wired into the wake-ladder and queue-repository callbacks at startup.

import type Database from "better-sqlite3";
import type { EventBus } from "./event-bus.js";
import type { SeatHandoverService } from "./seat-handover-service.js";
import type { FallbackSwapBack } from "./types.js";

interface NodeFallbackRow {
  id: string;
  rig_id: string;
  logical_id: string;
  runtime: string | null;
  fallback_runtime: string | null;
  fallback_model: string | null;
  fallback_state: string | null;
  fallback_swap_back: string | null;
  fallback_original_runtime: string | null;
  fallback_expires_at: string | null;
}

interface RigNameRow {
  name: string;
}

export interface RuntimeFallbackDeps {
  db: Database.Database;
  eventBus: EventBus;
  /** Pre-constructed SeatHandoverService with full runtime adapter support. */
  seatHandoverService: SeatHandoverService;
  log?: (msg: string) => void;
}

export class RuntimeFallbackService {
  private db: Database.Database;
  private eventBus: EventBus;
  private seatHandoverService: SeatHandoverService;
  private log: (msg: string) => void;
  private readonly inFlight = new Set<string>();
  private sweeping = false;
  private sweepRerunRequested = false;
  private unsubscribe?: () => void;

  constructor(deps: RuntimeFallbackDeps) {
    this.db = deps.db;
    this.eventBus = deps.eventBus;
    this.seatHandoverService = deps.seatHandoverService;
    this.log = deps.log ?? ((msg) => console.log(`[runtime-fallback] ${msg}`));
  }

  /** Called from the wake-ladder when a NEW usage-limit blocker is created for a node
   *  that has a fallback spec declared and is not already on fallback. Fire-and-forget
   *  (wake-ladder tick must not block). */
  async triggerForwardSwap(opts: {
    nodeId: string;
    poolKey: string;
    expiresAt: string;
  }): Promise<void> {
    const { nodeId, poolKey, expiresAt } = opts;

    if (this.inFlight.has(nodeId)) {
      this.log(`forward swap skipped — already in flight for node ${nodeId}`);
      return;
    }
    this.inFlight.add(nodeId);

    try {
      const node = this.queryNode(nodeId);
      if (!node) {
        this.log(`forward swap skipped — node ${nodeId} not found`);
        return;
      }

      // Idempotency: skip if already on fallback.
      if (node.fallback_state != null) {
        this.log(`forward swap skipped — node ${nodeId} already in fallback state: ${node.fallback_state}`);
        return;
      }

      if (!node.fallback_runtime) {
        this.log(`forward swap skipped — node ${nodeId} has no fallback_runtime declared`);
        return;
      }

      // Freshness: don't swap if the usage-limit expiry has already passed.
      const expiryMs = Date.parse(expiresAt);
      if (!Number.isNaN(expiryMs) && Date.now() >= expiryMs) {
        this.log(`forward swap skipped — node ${nodeId} usage-limit expiry has already passed (${expiresAt})`);
        return;
      }

      const seatRef = this.resolveSeatRef(node);
      if (!seatRef) {
        this.log(`forward swap skipped — could not resolve seatRef for node ${nodeId}`);
        return;
      }

      this.log(`triggering forward swap for ${seatRef} (pool=${poolKey}, fallback_runtime=${node.fallback_runtime})`);

      const swapBack = (node.fallback_swap_back as FallbackSwapBack | null) ?? "at_expiry";

      try {
        const result = await this.seatHandoverService.handover({
          seatRef,
          reason: `usage-limit fallback: pool=${poolKey}`,
          source: "rebuild",
          fallback: {
            runtime: node.fallback_runtime,
            model: node.fallback_model ?? undefined,
            poolKey,
            expiresAt,
            swapBack,
          },
        });
        if (!result.ok) {
          this.log(`forward swap failed for ${seatRef}: ${result.message}`);
        } else {
          this.log(`forward swap complete for ${seatRef} → ${node.fallback_runtime}`);
        }
      } catch (err) {
        this.log(`forward swap threw for ${seatRef}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } catch (err) {
      this.log(`forward swap error for node ${nodeId}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.inFlight.delete(nodeId);
    }
  }

  /** Called from queue-repository after usage_limit_expiry_fired resolves the blocker.
   *  For at_expiry: triggers the reverse handover back to the original runtime.
   *  For manual: emits swap_back_pending escalation event and sets node state. */
  async triggerReverseSwap(opts: {
    nodeId: string;
    poolKey: string;
  }): Promise<void> {
    const { nodeId, poolKey } = opts;

    if (this.inFlight.has(nodeId)) {
      this.log(`reverse swap skipped — already in flight for node ${nodeId}`);
      return;
    }
    this.inFlight.add(nodeId);

    try {
      const node = this.queryNode(nodeId);
      if (!node) {
        this.log(`reverse swap skipped — node ${nodeId} not found`);
        return;
      }

      if (node.fallback_state !== "on_fallback" && node.fallback_state !== "swap_back_pending") {
        this.log(`reverse swap skipped — node ${nodeId} is not in a fallback state (state=${node.fallback_state})`);
        return;
      }

      const swapBack = (node.fallback_swap_back as FallbackSwapBack | null) ?? "at_expiry";

      if (swapBack === "manual" && node.fallback_state === "on_fallback") {
        this.handleManualSwapBack(node, poolKey);
        return;
      }

      const seatRef = this.resolveSeatRef(node);
      if (!seatRef) {
        this.log(`reverse swap skipped — could not resolve seatRef for node ${nodeId}`);
        return;
      }

      this.log(`triggering reverse swap for ${seatRef} (pool=${poolKey}, restoring to ${node.fallback_original_runtime ?? node.runtime})`);

      const trigger = node.fallback_state === "swap_back_pending" ? "manual_operator" as const : "at_expiry" as const;
      try {
        const result = await this.seatHandoverService.handover({
          seatRef,
          reason: `usage-limit ${trigger === "manual_operator" ? "manual" : "expiry"} swap-back: pool=${poolKey}`,
          source: "rebuild",
          reverseSwap: {
            poolKey,
            trigger,
          },
        });
        if (!result.ok) {
          this.log(`reverse swap failed for ${seatRef}: ${result.message}`);
        } else {
          this.log(`reverse swap complete for ${seatRef} → ${node.fallback_original_runtime}`);
        }
      } catch (err) {
        this.log(`reverse swap threw for ${seatRef}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } catch (err) {
      this.log(`reverse swap error for node ${nodeId}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.inFlight.delete(nodeId);
    }
  }

  /** For manual swap-back: emit escalation event and mark state as swap_back_pending. */
  private handleManualSwapBack(node: NodeFallbackRow, poolKey: string): void {
    this.log(`manual swap-back configured for node ${node.id} — setting swap_back_pending`);

    const result = this.db.prepare(
      "UPDATE nodes SET fallback_state = 'swap_back_pending' WHERE id = ? AND fallback_state = 'on_fallback'"
    ).run(node.id);
    if (result.changes === 0) {
      this.log(`handleManualSwapBack: no rows updated for node ${node.id} — state was not on_fallback`);
      return;
    }
    try {
      this.eventBus.emit({
        type: "seat.runtime_fallback_swap_back_pending",
        rigId: node.rig_id,
        nodeId: node.id,
        logicalId: node.logical_id,
        poolKey,
        originalRuntime: node.fallback_original_runtime,
      });
    } catch (err) {
      this.log(`handleManualSwapBack: emit failed for node ${node.id} (DB state committed, sweep will recover): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Sweeps all nodes in swap_back_pending state and triggers the reverse handover for each.
   *  Called when seat.runtime_fallback_swap_back_pending fires so the pending state does not
   *  become a dead end. */
  async executeManualSwapBack(): Promise<void> {
    if (this.sweeping) { this.sweepRerunRequested = true; return; }
    this.sweeping = true;
    try {
      do {
        this.sweepRerunRequested = false;
        const pendingNodes = this.db.prepare(
          "SELECT id, fallback_pool_key FROM nodes WHERE fallback_state = 'swap_back_pending'"
        ).all() as Array<{ id: string; fallback_pool_key: string | null }>;

        for (const node of pendingNodes) {
          if (!node.fallback_pool_key) {
            this.log(`executeManualSwapBack: skipping node ${node.id} — no fallback_pool_key`);
            continue;
          }
          await this.triggerReverseSwap({ nodeId: node.id, poolKey: node.fallback_pool_key });
        }
      } while (this.sweepRerunRequested);
    } catch (err) {
      this.log(`executeManualSwapBack error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.sweeping = false;
    }
  }

  private queryNode(nodeId: string): NodeFallbackRow | null {
    return this.db.prepare(
      `SELECT id, rig_id, logical_id, runtime, fallback_runtime, fallback_model,
              fallback_state, fallback_swap_back, fallback_original_runtime,
              fallback_expires_at
       FROM nodes WHERE id = ?`
    ).get(nodeId) as NodeFallbackRow | undefined ?? null;
  }

  bindEventSubscription(unsub: () => void): void {
    this.unsubscribe = unsub;
  }

  dispose(): void {
    this.unsubscribe?.();
  }

  private resolveSeatRef(node: NodeFallbackRow): string | null {
    const rig = this.db.prepare("SELECT name FROM rigs WHERE id = ?")
      .get(node.rig_id) as RigNameRow | undefined;
    if (!rig) return null;
    return `${node.logical_id}@${rig.name}`;
  }
}
