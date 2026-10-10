import { randomBytes } from "node:crypto";
import { Command } from "commander";
import { DaemonClient, DaemonConnectionError, DaemonResponseError } from "../client.js";
import { getDaemonStatus, getDaemonUrl, daemonStatusGuard } from "../daemon-lifecycle.js";
import { readOpenRigEnv } from "../openrig-compat.js";
import { isHumanSeatSessionRef } from "../session-name.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export function escalateCommand(depsOverride?: StatusDeps): Command {
  const getDeps = () =>
    depsOverride ?? {
      lifecycleDeps: realDeps(),
      clientFactory: (url: string) => new DaemonClient(url),
    };

  return new Command("escalate")
    .description("Escalate work to another seat — creates a queue item with escalation context")
    .argument("<target>", "Destination session (e.g. human-ops@kernel, advisor@openrig)")
    .argument("<summary>", "Short plain-language description of what is being escalated and why")
    .option("--evidence-ref <path>", "Durable artifact the recipient needs to judge (required when target is a human seat, convention C3)")
    .option("--body <text>", "Additional body text (optional; supplement to --summary)")
    .option("--json", "JSON output for agents")
    .action(async (target: string, summary: string, opts: { evidenceRef?: string; body?: string; json?: boolean }) => {
      // Human-route enforcement: human seat destinations require evidence-ref.
      if (isHumanSeatSessionRef(target) && !opts.evidenceRef) {
        const msg =
          "escalation to a human seat requires --evidence-ref (a durable artifact the human can judge, convention C3). " +
          "Provide --evidence-ref <path> pointing to a PROOF.md or equivalent decision artifact.";
        if (opts.json) {
          console.error(JSON.stringify({ error: "human_route_fields_required", message: msg }));
        } else {
          console.error(msg);
        }
        process.exitCode = 1;
        return;
      }

      const managedSource = readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME");
      if (!managedSource) {
        const msg =
          "Source session unknown: OPENRIG_SESSION_NAME is not set. Run rig escalate from a managed seat.";
        if (opts.json) console.error(JSON.stringify({ error: "source_required", message: msg }));
        else console.error(msg);
        process.exitCode = 1;
        return;
      }

      const deps = getDeps();
      const daemon = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(daemon)) return;
      const client = deps.clientFactory(getDaemonUrl(daemon));

      const qitemId = `qitem-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomBytes(8).toString("hex")}`;
      // Print to stderr so --json stdout stays clean; this is an identity, not a commit receipt.
      console.error(
        `Escalation request ID: ${qitemId} (not proof of persistence). ` +
        `To reconcile: rig queue show ${qitemId} --full --json`,
      );

      try {
        const res = await client.post<Record<string, unknown>>("/api/queue/create", {
          qitemId,
          destinationSession: target,
          body: opts.body ?? "",
          summary,
          evidenceRef: opts.evidenceRef,
          tags: ["escalation"],
        });
        if (res.status >= 400) {
          const errMsg =
            typeof res.data?.error === "string" ? res.data.error : `HTTP ${res.status}`;
          if (opts.json) {
            console.error(JSON.stringify({ ok: false, error: "escalation_failed", message: errMsg, qitemId }));
          } else {
            console.error(`Escalation failed: ${errMsg}`);
          }
          process.exitCode = 1;
          return;
        }
        const resQitemId =
          typeof res.data?.qitemId === "string" ? res.data.qitemId : qitemId;
        if (opts.json) {
          console.log(JSON.stringify({ ok: true, qitemId: resQitemId, destination: target, summary }));
        } else {
          console.log(`Escalated to ${target} — queue item: ${resQitemId}`);
        }
      } catch (err) {
        const msg = err instanceof DaemonConnectionError || err instanceof DaemonResponseError
          ? err.message
          : err instanceof Error ? err.message : String(err);
        if (opts.json) {
          console.error(JSON.stringify({ ok: false, error: "transport_error", message: msg, qitemId }));
        } else {
          console.error(`Escalation transport error: ${msg}`);
          console.error(`Reconcile: rig queue show ${qitemId} --full --json`);
        }
        process.exitCode = 1;
      }
    });
}
