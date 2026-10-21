// RIG-112 — GET /api/memory/coverage: read-only memory-delivery coverage over the existing
// node.startup_delivery_manifest events. Query: ?since=<ISO>&rig=<rigId>&expected=a,b,c.
import { Hono } from "hono";
import type { RigRepository } from "../domain/rig-repository.js";
import { computeMemoryCoverage } from "../domain/memory-coverage.js";

export function memoryCoverageRoutes(): Hono {
  const app = new Hono();

  app.get("/coverage", (c) => {
    const rigRepo = c.get("rigRepo" as never) as RigRepository | undefined;
    if (!rigRepo) return c.json({ error: "memory_coverage_unavailable" }, 503);
    const sinceRaw = c.req.query("since");
    if (sinceRaw && Number.isNaN(Date.parse(sinceRaw))) return c.json({ error: "since must be an ISO timestamp" }, 400);
    const since = sinceRaw ? new Date(sinceRaw).toISOString() : undefined;
    const expectedRaw = c.req.query("expected");
    const expected = expectedRaw ? expectedRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    return c.json(computeMemoryCoverage(rigRepo.db, { since, rigId: c.req.query("rig") || undefined, expected }));
  });

  return app;
}
