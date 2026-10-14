import { Hono } from "hono";
import path from "node:path";
import type { TicketFactoryController } from "../domain/ticket-factory-controller.js";
import { CutoverGateError } from "../domain/ticket-factory-controller.js";
import { CutoverError, type TicketFactoryCutoverService, type LegacySnapshot } from "../domain/ticket-factory-cutover.js";
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
 * Cutover from the /factory-loop skill (RIG-89):
 *   GET  /api/ticket-factory/cutover            phase, daemon-admitted tickets, legacy claims, completion facts
 *   POST /api/ticket-factory/cutover/reconcile  body: LegacySnapshot; fences legacy-owned tickets
 *   POST /api/ticket-factory/cutover/start      body: { legacyProducerDisabled: true }
 *   POST /api/ticket-factory/cutover/rollback   drain the daemon factory, hand admission back to the skill
 *   POST /api/ticket-factory/cutover/tripwire   check for a still-running legacy producer
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
      if (!ctl) return unavailable(c);
      try {
        return c.json(ctl[verb]());
      } catch (err) {
        if (err instanceof CutoverGateError) return c.json({ error: "cutover_gate", message: err.message }, 409);
        throw err;
      }
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

  const cutover = (c: { get: (key: string) => unknown }) => c.get("ticketFactoryCutover" as never) as TicketFactoryCutoverService | undefined;
  const noCutover = (c: { json: (b: unknown, s?: number) => Response }) =>
    c.json({ error: "ticket_factory_cutover_unavailable", message: "cutover service is not running in this daemon" }, 503);
  app.get("/cutover", (c) => {
    const svc = cutover(c);
    return svc ? c.json(svc.status()) : noCutover(c);
  });
  app.post("/cutover/reconcile", async (c) => {
    const svc = cutover(c);
    if (!svc) return noCutover(c);
    const body = (await c.req.json().catch(() => null)) as LegacySnapshot | null;
    if (!body || !Array.isArray(body.items) || !Array.isArray(body.prs) || typeof body.tickets !== "object" || body.tickets === null) {
      return c.json({ error: "invalid_snapshot", message: "body must be { items: [], prs: [], tickets: {} }" }, 400);
    }
    return c.json({ report: svc.reconcileLegacy(body), status: svc.status() });
  });
  app.post("/cutover/start", async (c) => {
    const svc = cutover(c);
    if (!svc) return noCutover(c);
    const body = (await c.req.json().catch(() => ({}))) as { legacyProducerDisabled?: boolean };
    try {
      svc.cutOver({ legacyProducerDisabled: body.legacyProducerDisabled === true });
    } catch (err) {
      if (err instanceof CutoverError) return c.json({ error: "cutover_refused", message: err.message }, 409);
      throw err;
    }
    return c.json(svc.status());
  });
  app.post("/cutover/rollback", (c) => {
    const svc = cutover(c);
    if (!svc) return noCutover(c);
    svc.rollback();
    return c.json(svc.status());
  });
  app.post("/cutover/tripwire", async (c) => {
    const svc = cutover(c);
    return svc ? c.json(await svc.tripwire()) : noCutover(c);
  });
  return app;
}
