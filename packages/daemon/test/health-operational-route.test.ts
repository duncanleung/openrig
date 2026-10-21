// RIG-120 — GET /api/health/operational is registered before /:findingId and maps errors to HTTP.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { healthRoutes } from "../src/routes/health.js";

describe("GET /api/health/operational", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
  });
  afterEach(() => db.close());

  function appWith(ctx: Record<string, unknown>): Hono {
    const app = new Hono();
    app.use("*", async (c, next) => {
      for (const [k, v] of Object.entries(ctx)) if (v !== undefined) c.set(k as never, v as never);
      await next();
    });
    app.route("/api/health", healthRoutes());
    return app;
  }
  const full = () => ({
    rigRepo,
    queueRepo: new QueueRepository(db, new EventBus(db), { validateRig: () => true }),
    watchdogJobsRepo: new WatchdogJobsRepository(db),
    // A healthProjection that would answer /:findingId, to prove the route order.
    healthProjection: { get: () => ({ id: "from-finding-route" }), list: () => ({}) },
  });

  it("is served by the operational route, not read as a finding id", async () => {
    const res = await appWith(full()).request("/api/health/operational");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.schema).toBe("openrig.health-operational/v0alpha1");
    expect(body.id).toBeUndefined();
    expect(body.scope).toEqual({ kind: "daemon", rig: null, hosts: "this-daemon-only" });
    // No activity oracle and no watchdog job: the join is incomplete, so it is not "clear".
    expect(body.verdict).toBe("indeterminate");
  });

  it("scopes to a rig by name", async () => {
    rigRepo.createRig("alpha");
    const res = await appWith(full()).request("/api/health/operational?rig=alpha");
    expect(res.status).toBe(200);
    expect((await res.json() as { scope: unknown }).scope).toEqual({ kind: "rig", rig: "alpha", hosts: "this-daemon-only" });
  });

  it("returns 404 rig_not_found for an unknown rig", async () => {
    const res = await appWith(full()).request("/api/health/operational?rig=nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "rig_not_found" });
  });

  it("returns 503 when the rig repository is not wired", async () => {
    const res = await appWith({}).request("/api/health/operational");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "operational_summary_unavailable" });
  });

  it("reports missing queue and watchdog dependencies as unavailable, not healthy", async () => {
    const res = await appWith({ rigRepo }).request("/api/health/operational");
    const body = await res.json() as { coverage: Array<{ source: string; status: string }>; verdict: string };
    const status = (s: string) => body.coverage.find((c) => c.source === s)?.status;
    expect([status("humanGates"), status("stalledWork"), status("watchdog")]).toEqual(["unavailable", "unavailable", "unavailable"]);
    expect(body.verdict).toBe("indeterminate");
  });

  it("still serves a finding id on /:findingId", async () => {
    const res = await appWith(full()).request("/api/health/health-abc");
    expect(await res.json()).toEqual({ id: "from-finding-route" });
  });
});
