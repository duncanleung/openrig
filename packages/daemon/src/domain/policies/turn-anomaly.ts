// RIG-79 — turn-anomaly watchdog policy: tells ONE recipient (the job's target, normally an orchestrator) which
// sessions run far more assistant turns than user messages. Advisory only: it sends a message and touches no session.
//
// The watched sessions are not this job's target. `job.target` / `job.occupantGeneration` describe the delivery
// recipient (the engine's targetGeneration gate checks them). Each finding carries its own subject (native session id
// and generation), which the detector tracks independently, so a recipient handover never closes a subject's episode
// and a subject replacement never suppresses the recipient.
import { createHash } from "node:crypto";
import type { Policy, PolicyEvaluation, PolicyJob } from "./types.js";
import type { TurnAnomalyDetector, TurnAnomalyFinding } from "../turn-anomaly-detector.js";

const MAX_LISTED = 10;

export interface TurnAnomalyPolicyDeps {
  detector: Pick<TurnAnomalyDetector, "scanIfStale" | "snapshot">;
}

function describe(f: TurnAnomalyFinding): string {
  const w = f.window;
  const mins = Math.round(w.windowMs / 60_000);
  const head = f.kind === "zero_conversation"
    ? `${f.session} [${f.role}] ${w.assistantTurns} assistant turns, 0 user messages in ${mins} min (threshold ${w.threshold}:1)`
    : `${f.session} [${f.role}] ${w.assistantTurns}:${w.userMessages} = ${(w.ratio ?? 0).toFixed(1)}:1 in ${mins} min (threshold ${w.threshold}:1)`;
  const stall = f.corroboration.length ? `; reducer: ${[...new Set(f.corroboration.map((c) => c.type))].join(", ")}` : "";
  return `- ${head}${stall}`;
}

export function makeTurnAnomalyPolicy(deps: TurnAnomalyPolicyDeps): Policy {
  return {
    name: "turn-anomaly",
    async evaluate(job: PolicyJob): Promise<PolicyEvaluation> {
      if (!job.target?.session) {
        throw Object.assign(new Error("turn-anomaly: target.session is required"), {
          code: "policy_spec_invalid", policy: "turn-anomaly", field: "target.session",
        });
      }
      deps.detector.scanIfStale();
      const snap = deps.detector.snapshot();
      if (snap.findings.length === 0) return { action: "skip", reason: "no_turn_anomaly" };

      // A recipient is told again only when the set of open episodes changes, or when the recipient itself changes
      // (a replaced occupant has not been told). Episode ids are never reused.
      const condition = createHash("sha256").update(`${job.occupantGeneration ?? ""}|${snap.findings.map((f) => f.episodeId).sort((a, b) => a - b).join(",")}`).digest("hex").slice(0, 16);
      if (job.lastFiredCondition === condition) {
        return { action: "skip", reason: "turn_anomaly_unchanged", notes: { condition, open: snap.findings.length } };
      }

      const listed = snap.findings.slice(0, MAX_LISTED).map(describe);
      const more = snap.findings.length > MAX_LISTED ? [`- and ${snap.findings.length - MAX_LISTED} more: rig health --operational`] : [];
      const message = job.message ?? [
        `Turn anomaly: ${snap.findings.length} session(s) run far more assistant turns than user messages. Advisory only; inspect before acting.`,
        ...listed, ...more,
      ].join("\n");
      return {
        action: "send",
        target: job.target,
        message,
        conditionReceipt: condition,
        notes: {
          condition,
          findings: snap.findings.map((f) => ({ episodeId: f.episodeId, session: f.session, kind: f.kind, subject: f.subject })),
          recipientGeneration: job.occupantGeneration,
        },
      };
    },
  };
}
