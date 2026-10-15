import { Hono } from "hono";
import {
  RigRenameInvalidError,
  RigRenameNotFoundError,
  RigRenameRecoveryError,
  RigRenameRolledBackError,
  type RigRenameService,
} from "../domain/rig-rename-service.js";

/**
 * Rig rename routes (RIG-61). Backs `rig rename`. Mounted at /api.
 *   POST /api/rigs/:name/rename     body { newName, dryRun? }. dryRun returns the plan and changes nothing.
 *   GET  /api/rig-rename/journal    the journal of an unfinished rename, or { journal: null }
 *   POST /api/rig-rename/recover    roll back an unfinished rename from its journal
 * Status codes: 200 plan or done, 400 bad name, 404 no such rig, 409 blocked (body carries the plan and blockers),
 * 500 failed. A 500 with error "rename_recovery_required" means the journal is kept and a manual step is needed.
 */
export function rigRenameRoutes(): Hono {
  const app = new Hono();
  const service = (c: { get: (key: string) => unknown }) => c.get("rigRenameService" as never) as RigRenameService | undefined;
  const unavailable = (c: { json: (b: unknown, s?: number) => Response }) =>
    c.json({ error: "rig_rename_unavailable", message: "rig rename is not available in this daemon" }, 503);

  const fail = (c: { json: (b: unknown, s?: 400 | 404 | 500) => Response }, err: unknown) => {
    if (err instanceof RigRenameInvalidError) return c.json({ error: "invalid_rename", message: err.message }, 400);
    if (err instanceof RigRenameNotFoundError) return c.json({ error: "rig_not_found", message: err.message }, 404);
    if (err instanceof RigRenameRolledBackError) {
      return c.json({ error: "rename_failed_rolled_back", stage: err.stage, message: err.message }, 500);
    }
    if (err instanceof RigRenameRecoveryError) {
      return c.json({ error: "rename_recovery_required", message: err.message, journal: err.journalPath, state: err.state }, 500);
    }
    throw err;
  };

  app.post("/rigs/:name/rename", async (c) => {
    const svc = service(c);
    if (!svc) return unavailable(c);
    const body = (await c.req.json().catch(() => null)) as { newName?: unknown; dryRun?: unknown } | null;
    if (!body || typeof body.newName !== "string") {
      return c.json({ error: "invalid_rename", message: "body must be { newName: string, dryRun?: boolean }" }, 400);
    }
    try {
      const report = await svc.rename(c.req.param("name"), body.newName, { dryRun: body.dryRun === true });
      return c.json(report, report.blockers.length > 0 ? 409 : 200);
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get("/rig-rename/journal", (c) => {
    const svc = service(c);
    return svc ? c.json({ journal: svc.journal() }) : unavailable(c);
  });

  app.post("/rig-rename/recover", async (c) => {
    const svc = service(c);
    if (!svc) return unavailable(c);
    try {
      return c.json(await svc.recover());
    } catch (err) {
      return fail(c, err);
    }
  });

  return app;
}
