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
import { nodeRuntimeFallbackSchema } from "../src/db/migrations/090_node_runtime_fallback.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { USAGE_LIMIT_BLOCKER_TAG } from "../src/domain/queue-wake-repository.js";

// RIG-144: the RIG-43 reverse-swap trigger must fire only for a provider-limit blocker that the
// timer actually resolved. A retained delivery leaves the blocker unresolved and the expiry job
// active, so the usage limit is still in force.
describe("RIG-144 — swap-back trigger fires only for resolved provider-limit blockers", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let triggered: Array<{ nodeId: string; poolKey: string }>;

  function createWakeContractTable(d: Database.Database): void {
    d.exec(`
      CREATE TABLE queue_transition_wakes (
        transition_id INTEGER PRIMARY KEY,
        qitem_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        wake_kind TEXT NOT NULL,
        wake_ref TEXT NOT NULL,
        delivery_status TEXT
      );
      CREATE INDEX idx_queue_transition_wakes_qitem ON queue_transition_wakes(qitem_id, transition_id);
      CREATE INDEX idx_queue_transition_wakes_ref ON queue_transition_wakes(wake_ref, phase);
    `);
  }

  async function parkedProviderLimitBlocker(): Promise<{ qitemId: string; ref: string }> {
    const blocker = await repo.create({
      sourceSession: "wake-ladder@system",
      destinationSession: "wake-ladder@rig",
      body: "provider limit for one account pool",
      tags: [USAGE_LIMIT_BLOCKER_TAG, "usage-limit-pool:claude%3Alocal"],
      nudge: false,
    });
    repo.update({
      qitemId: blocker.qitemId, actorSession: "wake-ladder@system", state: "blocked",
      blockedOn: "external:provider-limit:claude:local",
      transitionNote: "usage-limit park until stated reset", wakeAfterSeconds: 60,
    } as never);
    return { qitemId: blocker.qitemId, ref: repo.getParkWakeStatus(blocker.qitemId)!.ref };
  }

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, outboxEntriesSchema,
      watchdogJobsSchema, watchdogHistorySchema, queueItemSummarySchema, queueItemEvidenceRefSchema,
      nodeRuntimeFallbackSchema,
    ]);
    createWakeContractTable(db);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'r')").run();
    db.prepare(
      "INSERT INTO nodes (id, rig_id, logical_id, runtime, fallback_state, fallback_pool_key) VALUES ('node-1', 'rig-1', 'dev.impl', 'claude-code', 'on_fallback', 'claude%3Alocal')",
    ).run();
    repo = new QueueRepository(db, new EventBus(db));
    repo.attachOutbox(new OutboxHandler(db));
    triggered = [];
    repo.attachRuntimeFallbackSwapBackTrigger((opts) => triggered.push(opts));
  });

  afterEach(() => db.close());

  it("fires for a node on fallback when the timer resolves the blocker", async () => {
    const { qitemId, ref } = await parkedProviderLimitBlocker();

    repo.recordWatchdogWakeAttempt(ref, "verified");

    expect(repo.getById(qitemId)!.state).toBe("done");
    expect(triggered).toEqual([{ nodeId: "node-1", poolKey: "claude%3Alocal" }]);
  });

  it("does not fire when delivery is retained: the blocker is unresolved and the limit still applies", async () => {
    const { qitemId, ref } = await parkedProviderLimitBlocker();

    repo.recordWatchdogWakeAttempt(ref, "retained");

    expect(repo.getById(qitemId)!.state).toBe("blocked");
    expect(triggered).toEqual([]);
  });
});
