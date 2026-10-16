import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, daemonStatusGuard } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { runJevClassify, realJevDeps, type JevClassifyDeps } from "./ticket-factory-jev.js";

/**
 * `rig ticket-factory` — controls for the recurring ticket-factory (RIG-88).
 * Backed by `/api/ticket-factory`. Pause is a drain: no new tickets are admitted and active
 * workflow instances finish.
 */

export interface TicketFactoryDeps extends StatusDeps {}

export interface TicketFactoryStatusBody {
  state: string;
  pollIntervalSeconds: number;
  capacity: number;
  live: number;
  run: { runId: string | null; admitted: number; maxTickets: number };
  wallClockPerTicketSeconds: number;
  cooldownSeconds: number;
  budget: { tokensPerTicket: string; tokenCapPerTicket: number | null };
  merge: { gate: string; policy: string; effective: string; reason: string };
  failStreak: number;
  lastPollAt: string | null;
  nextPollAt: string | null;
  lastError: string | null;
}

export function renderTicketFactoryStatus(s: TicketFactoryStatusBody): string[] {
  const lines = [
    `ticket-factory: ${s.state}`,
    `  cadence:   every ${s.pollIntervalSeconds}s (last poll ${s.lastPollAt ?? "never"}, next ${s.nextPollAt ?? "next tick"})`,
    `  capacity:  ${s.live}/${s.capacity} live`,
    `  run:       ${s.run.admitted}/${s.run.maxTickets} tickets admitted${s.run.runId ? ` (run ${s.run.runId})` : " (no open run)"}`,
    `  budget:    ${s.wallClockPerTicketSeconds}s wall clock per ticket, ${s.cooldownSeconds}s re-admit cooldown, tokens per ticket: ${s.budget.tokensPerTicket}`,
    `  merge:     ${s.merge.effective} (${s.merge.reason})`,
  ];
  if (s.failStreak > 0) lines.push(`  backoff:   ${s.failStreak} consecutive failure(s)`);
  if (s.lastError) lines.push(`  last error: ${s.lastError}`);
  return lines;
}

async function call(deps: TicketFactoryDeps, method: "get" | "post", path: string, json: boolean): Promise<void> {
  const status = await getDaemonStatus(deps.lifecycleDeps);
  if (!daemonStatusGuard(status)) return;
  const client = deps.clientFactory(getDaemonUrl(status));
  const res = method === "get" ? await client.get<unknown>(path) : await client.post<unknown>(path, {});
  if (res.status >= 400) {
    console.log(JSON.stringify(res.data, null, json ? 0 : 2));
    process.exitCode = res.status >= 500 ? 2 : 1;
    return;
  }
  const body = res.data as Record<string, unknown>;
  if (json) console.log(JSON.stringify(body));
  else if (body && typeof body === "object" && "state" in body) for (const line of renderTicketFactoryStatus(body as unknown as TicketFactoryStatusBody)) console.log(line);
  else console.log(JSON.stringify(body, null, 2));
}

export async function ticketFactoryStatus(deps: TicketFactoryDeps, json: boolean): Promise<void> {
  await call(deps, "get", "/api/ticket-factory/status", json);
}

export function ticketFactoryCommand(depsOverride?: TicketFactoryDeps, jevDepsOverride?: JevClassifyDeps): Command {
  const cmd = new Command("ticket-factory").description("Recurring ticket-factory controls: status, enable, pause, resume (RIG-88)");
  const getDeps = (): TicketFactoryDeps =>
    depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd.command("status").description("State, cadence, capacity, run budget, backoff and merge precedence")
    .option("--json", "JSON output for agents")
    .action(async (opts: { json?: boolean }) => ticketFactoryStatus(getDeps(), opts.json ?? false));

  cmd.command("jev-classify")
    .description("Shadow-mode Jev risk verdict for a PR next to its rule bucket; never changes merge behavior (RIG-99)")
    .option("--pr <number>", "Pull request number")
    .option("--bucket <bucket>", "Rule-based bucket: AUTO, ADJUDICATE_LIGHT, ADJUDICATE_HEAVY or ESCALATE")
    .option("--repo <owner/name>", "Repository (default: current gh repo)")
    .option("--threshold <0..1>", "auto_merge_safe threshold")
    .option("--model <id>", "Jev model id")
    .option("--json", "JSON output for agents")
    .action(async (opts: { pr?: string; bucket?: string; repo?: string; threshold?: string; model?: string; json?: boolean }) => {
      process.exitCode = await runJevClassify(opts, jevDepsOverride ?? realJevDeps());
    });

  const verbs: Array<[string, string]> = [
    ["enable", "Start polling the backlog (opens a run if none is open)"],
    ["disable", "Stop polling and close the run"],
    ["pause", "Drain: stop admitting new tickets; active tickets finish"],
    ["resume", "Resume admitting after a pause"],
    ["new-run", "Open a fresh run (resets the max-tickets budget)"],
    ["reload", "Re-read .factory.yml over the stored settings"],
  ];
  for (const [verb, description] of verbs) {
    cmd.command(verb).description(description).option("--json", "JSON output for agents")
      .action(async (opts: { json?: boolean }) => call(getDeps(), "post", `/api/ticket-factory/${verb}`, opts.json ?? false));
  }
  return cmd;
}
