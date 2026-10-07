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
    .command("digests")
    .description("List session digests")
    .option("--rig <name>", "Filter by rig name")
    .option("--seat <name>", "Filter by seat name")
    .option("--since <date>", "Filter digests ingested on or after this date (ISO 8601)")
    .option("--until <date>", "Filter digests ingested on or before this date (ISO 8601)")
    .option("--limit <n>", "Maximum rows to return (default 50, max 200)", "50")
    .option("--offset <n>", "Offset for pagination", "0")
    .option("--json", "Output as JSON")
    .action(async (opts: { rig?: string; seat?: string; since?: string; until?: string; limit: string; offset: string; json?: boolean }) => {
      const client = await getClient();
      if (!client) return;
      const params = new URLSearchParams();
      if (opts.rig) params.set("rig", opts.rig);
      if (opts.seat) params.set("seat", opts.seat);
      if (opts.since) params.set("since", opts.since);
      if (opts.until) params.set("until", opts.until);
      params.set("limit", opts.limit);
      params.set("offset", opts.offset);
      const qs = params.toString();
      const response = await client.get<{ ok: boolean; rows?: unknown[]; total?: number; error?: string }>(`/api/fleet/digests?${qs}`);
      if (response.status >= 400) {
        console.error(`Error: ${response.data.error ?? "Unknown error"}`);
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify(response.data, null, 2));
        return;
      }
      const rows = response.data.rows ?? [];
      console.log(`Session Digests (${rows.length} of ${response.data.total ?? 0})`);
      console.log("─".repeat(100));
      for (const r of rows as Array<Record<string, unknown>>) {
        const rig = (r.rig_name as string) ?? "—";
        const seat = (r.seat_name as string) ?? "—";
        const turns = `${r.conversation_turns}/${r.total_turns} turns`;
        const bytes = r.transcript_bytes ? `${Math.round((r.transcript_bytes as number) / 1024)}KB` : "—";
        const ts = (r.ingested_at as string) ?? "";
        console.log(`  ${rig.padEnd(20)} ${seat.padEnd(25)} ${turns.padEnd(14)} ${bytes.padEnd(8)} ${ts}`);
      }
    });

  command
    .command("reviews")
    .description("List code review runs")
    .option("--rig <name>", "Filter by rig name")
    .option("--seat <name>", "Filter by seat name")
    .option("--repo <repo>", "Filter by repository")
    .option("--branch <branch>", "Filter by branch name")
    .option("--pr <n>", "Filter by PR number")
    .option("--since <date>", "Filter reviews completed on or after this date (ISO 8601)")
    .option("--until <date>", "Filter reviews completed on or before this date (ISO 8601)")
    .option("--limit <n>", "Maximum rows to return (default 50, max 200)", "50")
    .option("--offset <n>", "Offset for pagination", "0")
    .option("--json", "Output as JSON")
    .action(async (opts: { rig?: string; seat?: string; repo?: string; branch?: string; pr?: string; since?: string; until?: string; limit: string; offset: string; json?: boolean }) => {
      const client = await getClient();
      if (!client) return;
      const params = new URLSearchParams();
      if (opts.rig) params.set("rig", opts.rig);
      if (opts.seat) params.set("seat", opts.seat);
      if (opts.repo) params.set("repo", opts.repo);
      if (opts.branch) params.set("branch", opts.branch);
      if (opts.pr) params.set("pr", opts.pr);
      if (opts.since) params.set("since", opts.since);
      if (opts.until) params.set("until", opts.until);
      params.set("limit", opts.limit);
      params.set("offset", opts.offset);
      const qs = params.toString();
      const response = await client.get<{ ok: boolean; rows?: unknown[]; total?: number; error?: string }>(`/api/fleet/reviews?${qs}`);
      if (response.status >= 400) {
        console.error(`Error: ${response.data.error ?? "Unknown error"}`);
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify(response.data, null, 2));
        return;
      }
      const rows = response.data.rows ?? [];
      console.log(`Review Runs (${rows.length} of ${response.data.total ?? 0})`);
      console.log("─".repeat(110));
      for (const r of rows as Array<Record<string, unknown>>) {
        const pr = r.pr_number ? `PR#${r.pr_number}` : "—";
        const branch = (r.branch as string) ?? "—";
        const findings = `MF:${r.must_fix} S:${r.suggestion} D:${r.dismissed}`;
        const rig = (r.rig_name as string) ?? "—";
        const dur = r.duration_seconds ? `${r.duration_seconds}s` : "—";
        const ts = (r.completed_at as string) ?? "";
        console.log(`  ${pr.padEnd(8)} ${branch.padEnd(30)} ${findings.padEnd(20)} ${rig.padEnd(15)} ${dur.padEnd(8)} ${ts}`);
      }
    });

  command
    .command("findings")
    .description("List findings for a specific review run")
    .argument("<traceId>", "Review run trace ID")
    .option("--json", "Output as JSON")
    .action(async (traceId: string, opts: { json?: boolean }) => {
      const client = await getClient();
      if (!client) return;
      const response = await client.get<{ ok: boolean; findings?: unknown[]; error?: string }>(`/api/fleet/reviews/${encodeURIComponent(traceId)}/findings`);
      if (response.status >= 400) {
        console.error(`Error: ${response.data.error ?? "Unknown error"}`);
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify(response.data, null, 2));
        return;
      }
      const findings = response.data.findings ?? [];
      console.log(`Findings for ${traceId} (${findings.length} total)`);
      console.log("─".repeat(100));
      for (const f of findings as Array<Record<string, unknown>>) {
        const file = (f.file as string) ?? "—";
        const lines = (f.lines as string) ?? "";
        const cat = (f.category as string) ?? "—";
        const verdict = (f.verdict as string) ?? "—";
        const score = f.score !== null ? `${f.score}` : "—";
        const desc = (f.description_prefix as string) ?? "";
        const loc = lines ? `${file}:${lines}` : file;
        console.log(`  [${verdict.padEnd(7)}] ${score.padEnd(4)} ${cat.padEnd(18)} ${loc.padEnd(35)} ${desc.substring(0, 50)}`);
      }
    });

  command
    .command("snapshots")
    .description("List daily token snapshots")
    .option("--rig <name>", "Filter by rig name")
    .option("--seat <name>", "Filter by seat name")
    .option("--since <date>", "Filter snapshots on or after this date (YYYY-MM-DD)")
    .option("--until <date>", "Filter snapshots on or before this date (YYYY-MM-DD)")
    .option("--limit <n>", "Maximum rows to return (default 50, max 200)", "50")
    .option("--offset <n>", "Offset for pagination", "0")
    .option("--json", "Output as JSON")
    .action(async (opts: { rig?: string; seat?: string; since?: string; until?: string; limit: string; offset: string; json?: boolean }) => {
      const client = await getClient();
      if (!client) return;
      const params = new URLSearchParams();
      if (opts.rig) params.set("rig", opts.rig);
      if (opts.seat) params.set("seat", opts.seat);
      if (opts.since) params.set("since", opts.since);
      if (opts.until) params.set("until", opts.until);
      params.set("limit", opts.limit);
      params.set("offset", opts.offset);
      const qs = params.toString();
      const response = await client.get<{ ok: boolean; rows?: unknown[]; total?: number; error?: string }>(`/api/fleet/snapshots?${qs}`);
      if (response.status >= 400) {
        console.error(`Error: ${response.data.error ?? "Unknown error"}`);
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify(response.data, null, 2));
        return;
      }
      const rows = response.data.rows ?? [];
      console.log(`Daily Token Snapshots (${rows.length} of ${response.data.total ?? 0})`);
      console.log("─".repeat(100));
      for (const r of rows as Array<Record<string, unknown>>) {
        const day = (r.day as string) ?? "—";
        const rig = (r.rig_name as string) ?? "—";
        const seat = (r.seat_name as string) ?? "—";
        const model = (r.model as string) ?? "—";
        const input = r.input_tokens_delta != null ? `${Math.round((r.input_tokens_delta as number) / 1000)}K in` : "—";
        const output = r.output_tokens_delta != null ? `${Math.round((r.output_tokens_delta as number) / 1000)}K out` : "—";
        const samples = r.samples != null ? `${r.samples} samples` : "";
        console.log(`  ${day}  ${rig.padEnd(20)} ${seat.padEnd(20)} ${model.padEnd(20)} ${input.padEnd(10)} ${output.padEnd(10)} ${samples}`);
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
