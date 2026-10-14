import { Hono } from "hono";
import path from "node:path";
import type { TicketFactoryController } from "../domain/ticket-factory-controller.js";
import { loadFactorySettings } from "../domain/ticket-factory-config.js";

/**
 * Ticket-factory control routes (RIG-88). Backs `rig ticket-factory`.
 *   GET  /api/ticket-factory/status     state, cadence, capacity, run budget, backoff, merge precedence
 *   POST /api/ticket-factory/enable     start running (opens a run if none is open)
 *   POST /api/ticket-factory/disable    stop and close the run
 *   POST /api/ticket-factory/pause      drain: stop admitting, active tickets finish
 *   POST /api/ticket-factory/resume
 *   POST /api/ticket-factory/new-run    reset the per-run ticket budget
 *   POST /api/ticket-factory/reload     re-read .factory.yml over the stored settings
 *   POST /api/ticket-factory/poll       run one poll now (waits for it)
 */
export function ticketFactoryRoutes(): Hono {
  const app = new Hono();
  const controller = (c: { get: (key: string) => unknown }) => c.get("ticketFactory" as never) as TicketFactoryController | undefined;
  const unavailable = (c: { json: (b: unknown, s?: number) => Response }) =>
    c.json({ error: "ticket_factory_unavailable", message: "ticket-factory controller is not running in this daemon" }, 503);

  app.get("/status", (c) => {
    const ctl = controller(c);
    return ctl ? c.json(ctl.status()) : unavailable(c);
  });

  for (const verb of ["enable", "disable", "pause", "resume"] as const) {
    app.post(`/${verb}`, (c) => {
      const ctl = controller(c);
      return ctl ? c.json(ctl[verb]()) : unavailable(c);
    });
  }
  app.post("/new-run", (c) => {
    const ctl = controller(c);
    return ctl ? c.json(ctl.newRun()) : unavailable(c);
  });
  app.post("/reload", (c) => {
    const ctl = controller(c);
    if (!ctl) return unavailable(c);
    try {
      ctl.applySettings(loadFactorySettings(process.env["OPENRIG_FACTORY_CONFIG"] ?? path.join(process.cwd(), ".factory.yml")));
    } catch (err) {
      return c.json({ error: "factory_config_invalid", message: err instanceof Error ? err.message : String(err) }, 400);
    }
    return c.json(ctl.status());
  });
  app.post("/poll", async (c) => {
    const ctl = controller(c);
    if (!ctl) return unavailable(c);
    return c.json({ outcome: await ctl.pollOnce(), status: ctl.status() });
  });
  return app;
}
