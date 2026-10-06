import { Command } from "commander";
import { readFileSync } from "node:fs";
import { DaemonClient, terminalAuthHeaders } from "../client.js";
import { getDaemonStatus, getDaemonUrl, daemonStatusGuard } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export function fleetCommand(depsOverride?: StatusDeps): Command {
  const command = new Command("fleet").description("Fleet store analytics — ingest and query session digests, review runs, and token snapshots");

  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  const getClient = async () => {
    const deps = getDeps();
    const daemon = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(daemon)) return null;
    return deps.clientFactory(getDaemonUrl(daemon));
  };

  command
    .command("ingest-digest")
    .description("Ingest a session digest JSON file into the fleet store")
    .argument("<file>", "Path to session digest JSON file")
    .action(async (file: string) => {
      const client = await getClient();
      if (!client) return;
      const data = JSON.parse(readFileSync(file, "utf-8"));
      const response = await client.post<{ ok: boolean; id?: number; created?: boolean; error?: string }>("/api/fleet/digests", data, { headers: terminalAuthHeaders() });
      if (response.status >= 400) {
        console.error(`Error: ${response.data.error ?? "Unknown error"}`);
        process.exitCode = 1;
        return;
      }
      console.log(`Digest ${response.data.created ? "created" : "updated"} (id: ${response.data.id})`);
    });

  command
    .command("ingest-review")
    .description("Ingest a code review metrics.json and its findings into the fleet store")
    .argument("<file>", "Path to review metrics JSON file")
    .action(async (file: string) => {
      const client = await getClient();
      if (!client) return;
      const data = JSON.parse(readFileSync(file, "utf-8"));
      const response = await client.post<{ ok: boolean; runId?: number; created?: boolean; findingsUpserted?: number; error?: string }>("/api/fleet/reviews", data, { headers: terminalAuthHeaders() });
      if (response.status >= 400) {
        console.error(`Error: ${response.data.error ?? "Unknown error"}`);
        process.exitCode = 1;
        return;
      }
      console.log(`Review run ${response.data.created ? "created" : "updated"} (id: ${response.data.runId}, findings: ${response.data.findingsUpserted})`);
    });

  command
    .command("ingest-snapshot")
    .description("Ingest daily token snapshot(s) into the fleet store")
    .argument("<file>", "Path to token snapshot JSON file (single object or array)")
    .action(async (file: string) => {
      const client = await getClient();
      if (!client) return;
      const data = JSON.parse(readFileSync(file, "utf-8"));
      const response = await client.post<{ ok: boolean; id?: number; created?: boolean; upserted?: number; error?: string }>("/api/fleet/snapshots", data, { headers: terminalAuthHeaders() });
      if (response.status >= 400) {
        console.error(`Error: ${response.data.error ?? "Unknown error"}`);
        process.exitCode = 1;
        return;
      }
      if (response.data.upserted !== undefined) {
        console.log(`${response.data.upserted} snapshot(s) upserted`);
      } else {
        console.log(`Snapshot ${response.data.created ? "created" : "updated"} (id: ${response.data.id})`);
      }
    });

  command
    .command("reconcile")
    .description("Trigger fleet store reconciliation (discovers + ingests transcripts, reviews, and snapshots)")
    .option("--digests", "Reconcile session digests only")
    .option("--reviews", "Reconcile review runs only")
    .option("--snapshots", "Roll up token snapshots only")
    .option("--force", "Re-ingest even if source hash is unchanged")
    .action(async (opts: { digests?: boolean; reviews?: boolean; snapshots?: boolean; force?: boolean }) => {
      const client = await getClient();
      if (!client) return;
      const body: Record<string, boolean> = {};
      if (opts.digests) body.digests = true;
      if (opts.reviews) body.reviews = true;
      if (opts.snapshots) body.snapshots = true;
      if (opts.force) body.force = true;
      const response = await client.post<Record<string, unknown>>("/api/fleet/reconcile", body, { headers: terminalAuthHeaders() });
      if (response.status >= 400) {
        console.error(`Error: ${String((response.data as Record<string, unknown>).error ?? "Unknown error")}`);
        process.exitCode = 1;
        return;
      }
      const d = response.data;
      if (d.digests) {
        const dg = d.digests as Record<string, unknown>;
        console.log(`Digests:   ${dg.ingested} ingested, ${dg.skipped} skipped, ${(dg.errors as unknown[]).length} errors`);
      }
      if (d.reviews) {
        const rv = d.reviews as Record<string, unknown>;
        console.log(`Reviews:   ${rv.ingested} ingested, ${rv.skipped} skipped, ${(rv.errors as unknown[]).length} errors`);
      }
      if (d.snapshots) {
        const sn = d.snapshots as Record<string, unknown>;
        console.log(`Snapshots: ${sn.snapshotsUpserted} upserted (${sn.daysRolledUp} days)`);
      }
      if (typeof d.durationMs === "number") {
        console.log(`Duration:  ${d.durationMs}ms`);
      }
    });

  command
    .command("stats")
    .description("Show fleet store row counts and last ingestion timestamps")
    .action(async () => {
      const client = await getClient();
      if (!client) return;
      const response = await client.get<{
        ok: boolean;
        session_digests?: { count: number; last_ingested_at: string | null };
        review_runs?: { count: number; last_ingested_at: string | null };
        review_findings?: { count: number };
        daily_token_snapshots?: { count: number; last_snapshot_at: string | null };
        error?: string;
      }>("/api/fleet/stats");
      if (response.status >= 400) {
        console.error(`Error: ${response.data.error ?? "Unknown error"}`);
        process.exitCode = 1;
        return;
      }
      const d = response.data;
      console.log("Fleet Store Stats");
      console.log("─────────────────────────────────────────────────");
      console.log(`session_digests        ${d.session_digests?.count ?? 0} rows   last: ${d.session_digests?.last_ingested_at ?? "—"}`);
      console.log(`review_runs            ${d.review_runs?.count ?? 0} rows   last: ${d.review_runs?.last_ingested_at ?? "—"}`);
      console.log(`review_findings        ${d.review_findings?.count ?? 0} rows`);
      console.log(`daily_token_snapshots  ${d.daily_token_snapshots?.count ?? 0} rows   last: ${d.daily_token_snapshots?.last_snapshot_at ?? "—"}`);
    });

  return command;
}
