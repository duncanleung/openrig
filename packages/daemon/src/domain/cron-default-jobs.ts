import fs from "node:fs";
import path from "node:path";
import type { CronJobScheduler } from "./cron-job-scheduler.js";

/**
 * Optional default job seeding (RIG-84). OFF unless OPENRIG_CRON_SEED_FLEET_AUDIT=1, so a
 * daemon never starts running a job its operator did not choose. The explicit path is
 * `POST /api/cron/jobs` (see docs/reference/daemon-cron.md).
 *
 * Seeding only ever creates: an existing `fleet-audit` row, edited or disabled by an operator,
 * is left untouched. It also skips when the installed script is missing.
 */

export const FLEET_AUDIT_JOB = {
  name: "fleet-audit",
  schedule: "daily 06:00",
  // The script sources its own fleet-audit.env, so the daemon passes no secrets.
  timeoutSeconds: 300,
  catchupWindowSeconds: 21_600,
} as const;

export function fleetAuditCommand(openrigHome: string): string {
  return path.join(openrigHome, "fleet-audit.sh");
}

export function seedDefaultCronJobs(
  scheduler: CronJobScheduler,
  openrigHome: string,
  env: NodeJS.ProcessEnv = process.env,
  log: (msg: string) => void = (msg) => console.log(msg),
): void {
  if (env["OPENRIG_CRON_SEED_FLEET_AUDIT"] !== "1") return;
  if (scheduler.get(FLEET_AUDIT_JOB.name)) return;
  const command = fleetAuditCommand(openrigHome);
  if (!fs.existsSync(command)) {
    log(`[cron] fleet-audit seed skipped: ${command} does not exist`);
    return;
  }
  try {
    scheduler.register({ ...FLEET_AUDIT_JOB, command, args: [] });
    log("[cron] seeded fleet-audit (daily 06:00)");
  } catch (err) {
    log(`[cron] fleet-audit seed failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
