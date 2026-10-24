import { Hono } from "hono";
import {
  HEALTH_SEVERITIES,
  HEALTH_STATUSES,
  type HealthScope,
} from "../domain/health-projection.js";
import type { HealthProjectionService } from "../domain/health-detectors.js";
import { computeOperationalSummary, UnknownRigError } from "../domain/operational-summary.js";
import type { StuckSeatObserver } from "../domain/stuck-seat-observer.js";
import type { TurnAnomalyDetector } from "../domain/turn-anomaly-detector.js";
import type { RigRepository } from "../domain/rig-repository.js";
import type { QueueRepository } from "../domain/queue-repository.js";
import type { WatchdogJobsRepository } from "../domain/watchdog-jobs-repository.js";
import type { SeatActivityService } from "../domain/seat-activity-service.js";

const SCOPE_TYPES: HealthScope["type"][] = ["instance", "rig", "seat", "mission", "slice"];

export function healthRoutes(): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const service = c.get("healthProjection" as never) as HealthProjectionService | undefined;
    if (!service) return c.json({ error: "health_projection_unavailable" }, 503);
    const scopeTypeRaw = c.req.query("scope_type");
    const scopeId = c.req.query("scope_id");
    if ((scopeTypeRaw === undefined) !== (scopeId === undefined)) {
      return c.json({ error: "scope_type and scope_id must be provided together" }, 400);
    }
    if (scopeTypeRaw !== undefined && !SCOPE_TYPES.includes(scopeTypeRaw as HealthScope["type"])) {
      return c.json({ error: `scope_type must be one of: ${SCOPE_TYPES.join(", ")}` }, 400);
    }
    const severity = c.req.query("severity");
    if (severity !== undefined && !HEALTH_SEVERITIES.includes(severity as never)) {
      return c.json({ error: `severity must be one of: ${HEALTH_SEVERITIES.join(", ")}` }, 400);
    }
    const status = c.req.query("status");
    if (status !== undefined && !HEALTH_STATUSES.includes(status as never)) {
      return c.json({ error: `status must be one of: ${HEALTH_STATUSES.join(", ")}` }, 400);
    }
    const limitRaw = c.req.query("limit");
    const limit = limitRaw === undefined ? 100 : Number(limitRaw);
    try {
      return c.json(service.list({
        limit,
        scopeType: scopeTypeRaw as HealthScope["type"] | undefined,
        scopeId,
        severity: severity as (typeof HEALTH_SEVERITIES)[number] | undefined,
        status: status as (typeof HEALTH_STATUSES)[number] | undefined,
      }));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  // RIG-120 — one operational summary composed from existing projections. Registered BEFORE
  // /:findingId so "operational" is not read as a finding id.
  app.get("/operational", (c) => {
    const rigRepo = c.get("rigRepo" as never) as RigRepository | undefined;
    if (!rigRepo) return c.json({ error: "operational_summary_unavailable", message: "rig repository is not wired" }, 503);
    try {
      return c.json(computeOperationalSummary({
        rigRepo,
        queueRepo: c.get("queueRepo" as never) as QueueRepository | undefined,
        watchdogRepo: c.get("watchdogJobsRepo" as never) as WatchdogJobsRepository | undefined,
        seatActivity: c.get("seatActivityService" as never) as SeatActivityService | undefined,
        stuckSeats: c.get("stuckSeatObserver" as never) as StuckSeatObserver | undefined,
        turnAnomalies: c.get("turnAnomalyDetector" as never) as TurnAnomalyDetector | undefined,
        rig: c.req.query("rig") || undefined,
      }));
    } catch (error) {
      if (error instanceof UnknownRigError) return c.json({ error: "rig_not_found", message: error.message }, 404);
      return c.json({ error: "operational_summary_failed", message: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  // RIG-123 — an explicit, scoped stuck-seat scan. The summary above never scans; this route is the only
  // request-time acquisition, and the caller asks for it. `?rig=<name>` scopes the capture to one rig.
  app.post("/operational/scan", async (c) => {
    const observer = c.get("stuckSeatObserver" as never) as StuckSeatObserver | undefined;
    if (!observer) return c.json({ error: "stuck_seat_observer_unavailable", message: "stuck-seat observer is not wired" }, 503);
    const rig = c.req.query("rig") || undefined;
    try {
      await observer.scan({ rig });
      return c.json({ ok: true, scope: rig ?? null });
    } catch (error) {
      return c.json({ error: "stuck_seat_scan_failed", message: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.get("/:findingId", (c) => {
    const service = c.get("healthProjection" as never) as HealthProjectionService | undefined;
    if (!service) return c.json({ error: "health_projection_unavailable" }, 503);
    const record = service.get(c.req.param("findingId"));
    return record ? c.json(record) : c.json({ error: "health_finding_not_found" }, 404);
  });

  return app;
}
