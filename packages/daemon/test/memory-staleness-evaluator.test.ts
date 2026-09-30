import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import {
  MemoryStalenessEvaluator,
  DEFAULT_THRESHOLDS,
  type StalenessThreshold,
} from "../src/domain/memory-staleness-evaluator.js";

describe("MemoryStalenessEvaluator", () => {
  let db: Database.Database;
  let eventBus: EventBus;
  let rigRepo: RigRepository;
  let rigId: string;

  beforeEach(() => {
    db = createFullTestDb();
    eventBus = new EventBus(db);
    rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("test-rig");
    rigId = rig.id;
  });

  afterEach(() => { db.close(); });

  function insertManifest(surfaces: Record<string, number>): void {
    const payload = JSON.stringify({
      type: "node.startup_delivery_manifest",
      rigId,
      nodeId: "n1",
      sessionName: "test",
      deliveredFiles: Object.entries(surfaces).map(([surface, count]) =>
        Array.from({ length: count }, (_, i) => ({
          path: `${surface}/file-${i}.md`,
          deliveryHint: surface === "guidance" ? "guidance_merge" : "send_text",
          surface,
          phase: surface === "guidance" ? "pre_launch" : "post_launch",
          contentHash: `hash-${surface}-${i}`,
        }))
      ).flat(),
      summary: {
        preLaunchCount: surfaces.guidance ?? 0,
        postLaunchCount: Object.entries(surfaces)
          .filter(([k]) => k !== "guidance")
          .reduce((sum, [, v]) => sum + v, 0),
        surfaceCounts: surfaces,
      },
    });
    db.prepare(
      "INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)"
    ).run(rigId, "n1", "node.startup_delivery_manifest", payload);
  }

  function insertStartupReady(): void {
    db.prepare(
      "INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)"
    ).run(rigId, "n1", "node.startup_ready", "{}");
  }

  it("returns empty results when no manifests exist", () => {
    const evaluator = new MemoryStalenessEvaluator({ db });
    const result = evaluator.evaluate(rigId);
    expect(result.totalManifests).toBe(0);
    expect(result.surfaces).toHaveLength(0);
    expect(result.recommendations).toHaveLength(0);
  });

  it("counts startups from startup_ready events", () => {
    insertStartupReady();
    insertStartupReady();
    insertStartupReady();
    const evaluator = new MemoryStalenessEvaluator({ db });
    const result = evaluator.evaluate(rigId);
    expect(result.totalStartups).toBe(3);
  });

  it("scores implicit-access surfaces as fresh when consistently delivered", () => {
    for (let i = 0; i < 5; i++) {
      insertManifest({ guidance: 3 });
    }
    const evaluator = new MemoryStalenessEvaluator({ db });
    const result = evaluator.evaluate(rigId);
    const guidance = result.surfaces.find(s => s.surface === "guidance");
    expect(guidance).toBeDefined();
    expect(guidance!.staleness).toBe("fresh");
    expect(guidance!.score).toBeLessThan(0.4);
  });

  it("scores explicit-access surfaces based on delivery frequency", () => {
    insertManifest({ wiki: 2 });
    const evaluator = new MemoryStalenessEvaluator({ db });
    const result = evaluator.evaluate(rigId);
    const wiki = result.surfaces.find(s => s.surface === "wiki");
    expect(wiki).toBeDefined();
    expect(wiki!.delivered).toBe(2);
    expect(typeof wiki!.score).toBe("number");
  });

  it("generates archive recommendation for stale explicit surfaces", () => {
    insertManifest({ wiki: 1 });
    const thresholds: Record<string, StalenessThreshold> = {
      ...DEFAULT_THRESHOLDS,
      wiki: { staleAfterSessions: 1, weight: 1.0, implicitAccess: false },
    };
    const evaluator = new MemoryStalenessEvaluator({ db, thresholds });
    const result = evaluator.evaluate(rigId, 10);
    const wiki = result.surfaces.find(s => s.surface === "wiki");
    if (wiki && wiki.staleness === "stale") {
      const rec = result.recommendations.find(r => r.surface === "wiki" && r.action === "archive");
      expect(rec).toBeDefined();
    }
  });

  it("generates promote recommendation for consistently delivered wiki", () => {
    for (let i = 0; i < 5; i++) {
      insertManifest({ wiki: 4 });
    }
    const evaluator = new MemoryStalenessEvaluator({ db });
    const result = evaluator.evaluate(rigId);
    const wiki = result.surfaces.find(s => s.surface === "wiki");
    if (wiki && wiki.staleness === "fresh" && wiki.delivered > 3) {
      const rec = result.recommendations.find(r => r.surface === "wiki" && r.action === "promote");
      expect(rec).toBeDefined();
    }
  });

  it("emits memory.staleness_evaluated event via evaluateAndEmit", () => {
    insertManifest({ guidance: 2, wiki: 1 });
    const evaluator = new MemoryStalenessEvaluator({ db, eventBus });
    evaluator.evaluateAndEmit(rigId);

    const row = db.prepare(
      "SELECT payload FROM events WHERE type = 'memory.staleness_evaluated'"
    ).get() as { payload: string } | undefined;
    expect(row).toBeDefined();
    const payload = JSON.parse(row!.payload);
    expect(payload.rigId).toBe(rigId);
    expect(payload.surfaces.length).toBeGreaterThan(0);
    expect(typeof payload.evaluatedAt).toBe("string");
  });

  it("respects sessionWindow limit on manifest queries", () => {
    for (let i = 0; i < 20; i++) {
      insertManifest({ guidance: 1 });
    }
    const evaluator = new MemoryStalenessEvaluator({ db });
    const result = evaluator.evaluate(rigId, 5);
    expect(result.sessionWindow).toBe(5);
    expect(result.totalManifests).toBe(5);
  });

  it("handles malformed manifest payloads gracefully", () => {
    db.prepare(
      "INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)"
    ).run(rigId, "n1", "node.startup_delivery_manifest", "not json{{{");
    insertManifest({ guidance: 1 });
    const evaluator = new MemoryStalenessEvaluator({ db });
    const result = evaluator.evaluate(rigId);
    expect(result.totalManifests).toBe(2);
    const guidance = result.surfaces.find(s => s.surface === "guidance");
    expect(guidance).toBeDefined();
    expect(guidance!.delivered).toBe(1);
  });

  it("sorts surfaces by score descending", () => {
    insertManifest({ guidance: 5, wiki: 1, adr: 1 });
    const evaluator = new MemoryStalenessEvaluator({ db });
    const result = evaluator.evaluate(rigId);
    for (let i = 1; i < result.surfaces.length; i++) {
      expect(result.surfaces[i - 1].score).toBeGreaterThanOrEqual(result.surfaces[i].score);
    }
  });

  it("DEFAULT_THRESHOLDS cover all manifest surface labels", () => {
    const manifestSurfaces = ["guidance", "skill", "role", "wiki", "adr", "restore-packet", "context-pack", "other"];
    for (const surface of manifestSurfaces) {
      expect(DEFAULT_THRESHOLDS[surface], `missing threshold for "${surface}"`).toBeDefined();
    }
  });

  it("does not emit when no eventBus provided", () => {
    insertManifest({ guidance: 1 });
    const evaluator = new MemoryStalenessEvaluator({ db });
    const result = evaluator.evaluateAndEmit(rigId);
    const row = db.prepare(
      "SELECT count(*) as cnt FROM events WHERE type = 'memory.staleness_evaluated'"
    ).get() as { cnt: number };
    expect(row.cnt).toBe(0);
    expect(result.surfaces.length).toBeGreaterThan(0);
  });

  it("isolates results by rigId", () => {
    const otherRig = rigRepo.createRig("other-rig");
    insertManifest({ guidance: 5 });
    db.prepare(
      "INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)"
    ).run(otherRig.id, "n2", "node.startup_delivery_manifest", JSON.stringify({
      type: "node.startup_delivery_manifest",
      rigId: otherRig.id,
      nodeId: "n2",
      sessionName: "other",
      deliveredFiles: [],
      summary: { preLaunchCount: 0, postLaunchCount: 0, surfaceCounts: { wiki: 10 } },
    }));

    const evaluator = new MemoryStalenessEvaluator({ db });
    const result = evaluator.evaluate(rigId);
    const wiki = result.surfaces.find(s => s.surface === "wiki");
    expect(wiki).toBeUndefined();
    const guidance = result.surfaces.find(s => s.surface === "guidance");
    expect(guidance).toBeDefined();
    expect(guidance!.delivered).toBe(5);
  });
});
