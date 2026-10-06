import { Hono } from "hono";
import type { Database } from "better-sqlite3";
import { FleetStore } from "../domain/fleet-store.js";
import type {
  SessionDigestInput,
  ReviewRunInput,
  ReviewFindingInput,
  DailyTokenSnapshotInput,
} from "../domain/fleet-store.js";

export interface FleetStoreRouteDeps {
  db: () => Database;
}

export function fleetStoreRoutes(deps: FleetStoreRouteDeps): Hono {
  const app = new Hono();

  function store(): FleetStore {
    return new FleetStore(deps.db());
  }

  function requireActivityToken(c: { req: { header: (name: string) => string | undefined }; get: (key: string) => unknown; json: (body: unknown, status: number) => Response }): Response | null {
    const expectedToken = c.get("activityHookToken" as never) as string | undefined;
    if (!expectedToken) {
      return c.json({ ok: false, code: "fleet_store_unconfigured", error: "Fleet store ingestion requires the activity hook token." }, 503);
    }
    const authHeader = c.req.header("authorization");
    const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : null;
    const headerToken = c.req.header("x-openrig-activity-token") ?? null;
    if (bearerToken !== expectedToken && headerToken !== expectedToken) {
      return c.json({ ok: false, code: "fleet_store_unauthorized", error: "Fleet store ingestion requires the configured local hook token." }, 401);
    }
    return null;
  }

  app.post("/digests", async (c) => {
    const authErr = requireActivityToken(c);
    if (authErr) return authErr;

    let body: SessionDigestInput;
    try {
      body = await c.req.json<SessionDigestInput>();
    } catch {
      return c.json({ ok: false, code: "invalid_json", error: "Request body must be JSON." }, 400);
    }

    if (!body.nativeSessionId || typeof body.nativeSessionId !== "string") {
      return c.json({ ok: false, code: "missing_field", error: "nativeSessionId is required." }, 400);
    }
    if (!body.seatSession || typeof body.seatSession !== "string") {
      return c.json({ ok: false, code: "missing_field", error: "seatSession is required." }, 400);
    }
    if (!body.transcriptPath || typeof body.transcriptPath !== "string") {
      return c.json({ ok: false, code: "missing_field", error: "transcriptPath is required." }, 400);
    }
    if (typeof body.totalTurns !== "number" || typeof body.conversationTurns !== "number") {
      return c.json({ ok: false, code: "missing_field", error: "totalTurns and conversationTurns are required numbers." }, 400);
    }

    try {
      const result = store().upsertDigest(body);
      return c.json({ ok: true, ...result }, result.created ? 201 : 200);
    } catch (err) {
      return c.json({ ok: false, code: "fleet_store_error", error: String(err) }, 500);
    }
  });

  app.post("/reviews", async (c) => {
    const authErr = requireActivityToken(c);
    if (authErr) return authErr;

    let body: { run: ReviewRunInput; findings?: ReviewFindingInput[] };
    try {
      body = await c.req.json<{ run: ReviewRunInput; findings?: ReviewFindingInput[] }>();
    } catch {
      return c.json({ ok: false, code: "invalid_json", error: "Request body must be JSON." }, 400);
    }

    if (!body.run || !body.run.traceId || typeof body.run.traceId !== "string") {
      return c.json({ ok: false, code: "missing_field", error: "run.traceId is required." }, 400);
    }
    if (typeof body.run.metricsJson !== "string") {
      return c.json({ ok: false, code: "missing_field", error: "run.metricsJson is required." }, 400);
    }

    const findings = body.findings ?? [];
    for (let i = 0; i < findings.length; i++) {
      const f = findings[i]!;
      if (!f.findingId || typeof f.findingId !== "string") {
        return c.json({ ok: false, code: "missing_field", error: `findings[${i}].findingId is required.` }, 400);
      }
      f.runTraceId = body.run.traceId;
    }

    try {
      const result = store().upsertReviewRun(body.run, findings);
      return c.json({ ok: true, ...result }, result.created ? 201 : 200);
    } catch (err) {
      return c.json({ ok: false, code: "fleet_store_error", error: String(err) }, 500);
    }
  });

  app.post("/snapshots", async (c) => {
    const authErr = requireActivityToken(c);
    if (authErr) return authErr;

    let body: DailyTokenSnapshotInput | DailyTokenSnapshotInput[];
    try {
      body = await c.req.json<DailyTokenSnapshotInput | DailyTokenSnapshotInput[]>();
    } catch {
      return c.json({ ok: false, code: "invalid_json", error: "Request body must be JSON." }, 400);
    }

    const items = Array.isArray(body) ? body : [body];
    for (let i = 0; i < items.length; i++) {
      const s = items[i]!;
      if (!s.day || typeof s.day !== "string") {
        return c.json({ ok: false, code: "missing_field", error: `items[${i}].day is required.` }, 400);
      }
      if (!s.seatSession || typeof s.seatSession !== "string") {
        return c.json({ ok: false, code: "missing_field", error: `items[${i}].seatSession is required.` }, 400);
      }
    }

    try {
      if (items.length === 1) {
        const result = store().upsertSnapshot(items[0]!);
        return c.json({ ok: true, ...result }, result.created ? 201 : 200);
      }
      const result = store().upsertSnapshots(items);
      return c.json({ ok: true, ...result }, 200);
    } catch (err) {
      return c.json({ ok: false, code: "fleet_store_error", error: String(err) }, 500);
    }
  });

  app.get("/stats", (c) => {
    try {
      const result = store().stats();
      return c.json({ ok: true, ...result });
    } catch (err) {
      return c.json({ ok: false, code: "fleet_store_error", error: String(err) }, 500);
    }
  });

  return app;
}
