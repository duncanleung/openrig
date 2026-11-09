import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, daemonStatusGuard } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export interface SweepStuckDeps extends StatusDeps {}

interface SweepItem {
  rig: string;
  logicalId: string;
  session: string;
  runtime: string | null;
  action: string;
  attribution: string;
  unchangedMs: number | null;
  excerpt: string;
  detail: string;
  deliveryAttemptId?: string | null;
  verified?: boolean;
}

interface SweepReport {
  scannedAt: string;
  dryRun: boolean;
  graceMs: number;
  examined: number;
  items: SweepItem[];
  unresolved: boolean;
  error?: string;
  message?: string;
}

function renderHuman(report: SweepReport): void {
  console.log(
    `stuck-message sweep: examined=${report.examined} items=${report.items.length}`
    + ` unresolved=${report.unresolved ? "yes" : "no"}`
    + ` dry-run=${report.dryRun ? "yes" : "no"}`
    + ` grace=${Math.round(report.graceMs / 1000)}s`
    + ` at ${report.scannedAt}`,
  );
  if (report.items.length === 0) {
    console.log("No stuck composer input found.");
    return;
  }
  for (const item of report.items) {
    const age = item.unchangedMs == null ? "" : ` unchanged=${Math.round(item.unchangedMs / 1000)}s`;
    console.log(`  ${item.session}: ${item.action} [${item.attribution}]${age}`);
    if (item.excerpt) console.log(`    excerpt: ${item.excerpt}`);
    console.log(`    ${item.detail}`);
  }
}

export function sweepStuckCommand(depsOverride?: SweepStuckDeps): Command {
  const getDeps = (): SweepStuckDeps =>
    depsOverride ?? {
      lifecycleDeps: realDeps(),
      clientFactory: (url: string) => new DaemonClient(url, { timeoutMs: 30_000 }),
    };

  return new Command("sweep-stuck")
    .description(
      "Scan managed seats for idle composers holding unsubmitted OpenRig messages; "
      + "auto-Enter only when attribution + idle + prompt guards pass",
    )
    .option("--dry-run", "Report only; never press Enter")
    .option("--json", "Machine-readable report")
    .option("--grace-ms <ms>", "Unchanged-text grace interval in milliseconds (default 60000)", (v) => Number.parseInt(v, 10))
    .option("--rig <name-or-id>", "Limit the scan to one rig")
    .option("--no-auto-enter", "Report attributable stuck text without pressing Enter")
    .action(async (opts: {
      dryRun?: boolean;
      json?: boolean;
      graceMs?: number;
      rig?: string;
      autoEnter?: boolean;
    }) => {
      const deps = getDeps();
      const daemon = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(daemon)) return;
      const client = deps.clientFactory(getDaemonUrl(daemon));

      const body: Record<string, unknown> = {
        dryRun: opts.dryRun === true,
        autoEnter: opts.autoEnter !== false,
      };
      if (typeof opts.graceMs === "number" && Number.isFinite(opts.graceMs) && opts.graceMs > 0) {
        body.graceMs = opts.graceMs;
      }
      if (opts.rig?.trim()) body.rig = opts.rig.trim();

      let status = 0;
      let report: SweepReport;
      try {
        const res = await client.post<SweepReport>("/api/transport/sweep-stuck", body);
        status = res.status;
        report = res.data;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (opts.json) {
          console.error(JSON.stringify({ error: "sweep_stuck_transport_error", message }));
        } else {
          console.error(`stuck-message sweep failed: ${message}`);
        }
        process.exitCode = 1;
        return;
      }

      if (report.error) {
        if (opts.json) console.log(JSON.stringify(report));
        else console.error(`stuck-message sweep refused: ${report.message ?? report.error}`);
        process.exitCode = status >= 500 ? 2 : 1;
        return;
      }

      if (opts.json) console.log(JSON.stringify(report));
      else renderHuman(report);

      // Non-zero when something stuck remains unresolved (needs human or auto-Enter failed).
      if (report.unresolved || status === 409) process.exitCode = 1;
    });
}
