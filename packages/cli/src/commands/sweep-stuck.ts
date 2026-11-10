// RIG-190 — `rig sweep-stuck`: trigger the stuck-message sweeper.
// Detects and recovers unsubmitted OpenRig deliveries (messages stuck in a
// terminal's input buffer without a final Enter).
import { Command } from "commander";
import { DaemonClient, terminalAuthHeaders } from "../client.js";
import { getDaemonStatus, getDaemonUrl, daemonStatusGuard } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export interface SweepStuckDeps extends StatusDeps {}

export function sweepStuckCommand(depsOverride?: SweepStuckDeps): Command {
  const cmd = new Command("sweep-stuck")
    .description("Detect and recover messages stuck in a seat's input buffer without a final Enter");

  const getDeps = (): SweepStuckDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd
    .option("--rig <name>", "Restrict sweep to one rig (name or id); default is fleet-wide")
    .option("--dry-run", "Scan and report without pressing Enter or writing attempt records")
    .option("--json", "JSON output for agents")
    .addHelpText("after", `
Examples:
  rig sweep-stuck
  rig sweep-stuck --rig my-rig
  rig sweep-stuck --dry-run
  rig sweep-stuck --json

Notes:
  - The sweeper delegates detection to the stuck-seat observer. Seats with
    persistent composer text (>60s, attempt-correlated) are acted on.
  - Collapsed pastes are skipped (R3 redirect: ownership cannot be proven
    from delivery-time data alone). They appear as skipped_collapsed in --json.
  - Each delivery ID gets at most one Enter attempt. A prior successful or
    failed attempt for the same delivery ID suppresses a new attempt.
  - On daemon restart, in-flight attempts (state: attempting) are upgraded
    to indeterminate and are never auto-retried.
  - R8 fast path: if a seat's activity is already "running" when the sweep
    reaches it, the agent submitted on its own — no Enter is pressed.
`)
    .action(async (opts: { rig?: string; dryRun?: boolean; json?: boolean }) => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;

      const client = deps.clientFactory(getDaemonUrl(status));
      const body: Record<string, unknown> = {};
      if (opts.rig) body.rig = opts.rig;
      if (opts.dryRun) body.dryRun = true;

      const res = await client.post<Record<string, unknown>>(
        "/api/transport/sweep-stuck",
        body,
        { headers: terminalAuthHeaders() },
      );

      if (opts.json) {
        if (res.status >= 400) {
          process.exitCode = 1;
          console.error(JSON.stringify({ ok: false, status: res.status, error: res.data }));
        } else {
          console.log(JSON.stringify(res.data, null, 2));
        }
        return;
      }

      if (res.status >= 400) {
        const error = (res.data as { error?: string } | null)?.error ?? "Sweep failed.";
        console.error(`rig sweep-stuck: ${error}`);
        process.exitCode = 1;
        return;
      }

      const data = res.data as {
        findings?: number;
        seats?: Array<{ session: string; outcome: string; deliveryId?: string | null; error?: string }>;
        dryRun?: boolean;
        degraded?: boolean;
        durationMs?: number;
      };

      const dryRun = data.dryRun ? " (dry run)" : "";
      const findings = data.findings ?? 0;
      const seats = data.seats ?? [];
      const durationS = ((data.durationMs ?? 0) / 1000).toFixed(1);

      if (findings === 0) {
        console.log(`rig sweep-stuck: no stuck messages found${dryRun} (${durationS}s)`);
        return;
      }

      const confirmed = seats.filter((s) => s.outcome === "confirmed").length;
      const skipped = seats.filter((s) => s.outcome.startsWith("skipped")).length;
      const failed = seats.filter((s) => s.outcome === "failed").length;
      const degraded = seats.filter((s) => s.outcome === "degraded").length;
      const fastPath = seats.filter((s) => s.outcome === "fast_path").length;

      console.log(
        `rig sweep-stuck: ${findings} finding${findings === 1 ? "" : "s"} — ` +
        `${confirmed} submitted, ${fastPath} fast-path, ${skipped} skipped, ${failed} failed, ${degraded} degraded${dryRun} (${durationS}s)`,
      );
      if (data.degraded) {
        console.error("rig sweep-stuck: warning: one or more seats timed out (degraded)");
      }
      for (const s of seats) {
        const marker = s.outcome === "confirmed" ? "+" : s.outcome === "fast_path" ? "~" : s.outcome === "failed" ? "!" : "-";
        console.log(`  [${marker}] ${s.session}: ${s.outcome}${s.error ? ` (${s.error})` : ""}`);
      }
    });

  return cmd;
}
