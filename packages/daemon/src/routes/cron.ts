import { Hono } from "hono";
import {
  CronBusyError,
  CronNotFoundError,
  CronValidationError,
  type CronJobScheduler,
} from "../domain/cron-job-scheduler.js";

/**
 * Daemon cron routes (RIG-84). Backs the orchestration-layer scheduled jobs.
 *   GET   /api/cron/jobs              registered jobs with last run result and next slot
 *   POST  /api/cron/jobs              register or update by name (idempotent upsert)
 *   PATCH /api/cron/jobs/:name        enable/disable, schedule, timeout, catch-up window
 *   POST  /api/cron/jobs/:name/run    run now; ?async=1 returns 202 once started
 * A manual run records last_status/exit code/duration and never moves the schedule guard
 * (last_run_at), so it neither consumes the next slot nor hides a missed one.
 */
export function cronRoutes(): Hono {
  const app = new Hono();
  const scheduler = (c: { get: (key: string) => unknown }) => c.get("cronJobScheduler" as never) as CronJobScheduler | undefined;
  const unavailable = (c: { json: (b: unknown, s?: number) => Response }) =>
    c.json({ error: "cron_unavailable", message: "cron scheduler is not running in this daemon" }, 503);
  const fail = (c: { json: (b: unknown, s?: 400 | 404 | 409) => Response }, err: unknown) => {
    if (err instanceof CronValidationError) return c.json({ error: "invalid_cron_job", message: err.message }, 400);
    if (err instanceof CronNotFoundError) return c.json({ error: "cron_job_not_found", message: err.message }, 404);
    if (err instanceof CronBusyError) return c.json({ error: "cron_busy", message: err.message }, 409);
    throw err;
  };
  const readBody = async (c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown> | null> => {
    const body = await c.req.json().catch(() => null);
    return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  };

  app.get("/jobs", (c) => {
    const s = scheduler(c);
    return s ? c.json({ running: s.isRunning(), jobs: s.list() }) : unavailable(c);
  });

  app.post("/jobs", async (c) => {
    const s = scheduler(c);
    if (!s) return unavailable(c);
    const body = await readBody(c);
    if (!body) return c.json({ error: "invalid_cron_job", message: "body must be a JSON object" }, 400);
    try {
      const { job, created } = s.register(body);
      return c.json({ job, created }, created ? 201 : 200);
    } catch (err) {
      return fail(c, err);
    }
  });

  app.patch("/jobs/:name", async (c) => {
    const s = scheduler(c);
    if (!s) return unavailable(c);
    const body = await readBody(c);
    if (!body) return c.json({ error: "invalid_cron_job", message: "body must be a JSON object" }, 400);
    const allowed = new Set(["schedule", "enabled", "timeoutSeconds", "catchupWindowSeconds"]);
    const unknown = Object.keys(body).filter((k) => !allowed.has(k));
    if (unknown.length) return c.json({ error: "invalid_cron_job", message: `unknown fields: ${unknown.join(", ")}` }, 400);
    try {
      return c.json({ job: s.patch(c.req.param("name"), body) });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post("/jobs/:name/run", async (c) => {
    const s = scheduler(c);
    if (!s) return unavailable(c);
    const wait = c.req.query("async") !== "1";
    try {
      const outcome = await s.runNow(c.req.param("name"), { wait });
      return c.json(outcome, wait ? 200 : 202);
    } catch (err) {
      return fail(c, err);
    }
  });

  return app;
}
