import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Policy, PolicyEvaluation, PolicyJob } from "./types.js";

// RIG-118 v1 — a per-seat watchdog for one managed compaction attempt. The enforcer
// registers the job when it sends /compact (job.context carries the attempt). The
// policy observes three states the daemon can verify alone:
//   marker_pending -> delivered -> acknowledged
//   marker_pending: no delivery signal on the seat's restore-pending marker yet.
//   delivered:      the marker shows the restore request was sent (enforcer stamp
//                   restoreRequestSentAt) or the bridge ran (postCompactAt / lastBridgeEvent).
//                   deliveredAt is NOT used: only the bridge writes it, and a managed
//                   compaction restores by prompt without the bridge.
//   acknowledged:   a RESTORED-*.md written after the attempt started sits beside the
//                   attempt's RESTORE-MAP.md. The job ends (terminal).
// It never sends to the seat and never retries. A missed window logs a WARN; the second
// consecutive missed observation raises one advisory item, deduped per attempt and stage.

export const COMPACTION_LIFECYCLE_POLICY_NAME = "compaction-lifecycle";
export const MARKER_PENDING_LIMIT_MS = 5 * 60_000;
export const DELIVERED_LIMIT_MS = 30 * 60_000;
export const LIFECYCLE_EXPIRY_MS = 24 * 60 * 60_000;
const CONSECUTIVE_TIMEOUTS_FOR_ADVISORY = 2;
// The PreCompact hook writes the marker just after /compact is sent; allow clock skew
// so a marker from this attempt is not read as an older one.
const MARKER_SKEW_MS = 60_000;

export interface CompactionAdvisory {
  dedupeKey: string;
  session: string;
  attemptId: string;
  stage: "marker_pending" | "delivered";
  body: string;
}

export interface CompactionLifecycleDeps {
  openrigHome: () => string;
  warn: (message: string, notes: Record<string, unknown>) => void;
  createAdvisory: (advisory: CompactionAdvisory) => Promise<void> | void;
  now?: () => number;
}

export function compactionMarkerPath(openrigHome: string, sessionName: string): string {
  return path.join(openrigHome, "compaction", "restore-pending", `${sessionName.replace(/[^a-zA-Z0-9_.@-]/g, "_")}.json`);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readMarker(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function hasRestoredNote(mapPath: string, startedMs: number): boolean {
  const dir = path.dirname(mapPath);
  try {
    return readdirSync(dir).some((name) => {
      if (!/^RESTORED-.*\.md$/.test(name)) return false;
      try { return statSync(path.join(dir, name)).mtimeMs >= startedMs; } catch { return false; }
    });
  } catch {
    return false;
  }
}

export function makeCompactionLifecyclePolicy(deps: CompactionLifecycleDeps): Policy {
  const now = deps.now ?? (() => Date.now());
  // Consecutive missed-window observations, per job. Memory only: a daemon restart resets
  // the count, which delays an advisory and never repeats one (the dedupe set below and the
  // advisory's own dedupe key cover repeats).
  const misses = new Map<string, { key: string; count: number }>();
  const advised = new Set<string>();

  return {
    name: COMPACTION_LIFECYCLE_POLICY_NAME,
    async evaluate(job: PolicyJob): Promise<PolicyEvaluation> {
      const attemptId = str(job.context["attemptId"]);
      const mapPath = str(job.context["mapPath"]);
      const startedMs = Date.parse(str(job.context["startedAt"]) ?? "");
      if (!attemptId || !mapPath || !Number.isFinite(startedMs)) {
        return { action: "terminal", reason: "compaction_lifecycle_context_invalid", notes: { targetSession: job.target.session } };
      }
      const ageMs = now() - startedMs;
      if (ageMs > LIFECYCLE_EXPIRY_MS) {
        return { action: "terminal", reason: "compaction_lifecycle_expired", notes: { attemptId, ageMs } };
      }
      if (hasRestoredNote(mapPath, startedMs)) {
        misses.delete(job.jobId);
        return { action: "terminal", reason: "compaction_acknowledged", notes: { attemptId } };
      }

      const markerFile = compactionMarkerPath(deps.openrigHome(), job.target.session);
      const marker = existsSync(markerFile) ? readMarker(markerFile) : null;
      const markerCreated = Date.parse(str(marker?.["createdAt"]) ?? "");
      const forThisAttempt = marker !== null && Number.isFinite(markerCreated) && markerCreated >= startedMs - MARKER_SKEW_MS;
      const delivered = forThisAttempt
        && Boolean(str(marker?.["restoreRequestSentAt"]) || str(marker?.["postCompactAt"]) || str(marker?.["lastBridgeEvent"]));
      const stage = delivered ? "delivered" : "marker_pending";
      const limitMs = delivered ? DELIVERED_LIMIT_MS : MARKER_PENDING_LIMIT_MS;

      if (ageMs <= limitMs) {
        misses.delete(job.jobId);
        return { action: "skip", reason: `${stage}_within_window`, notes: { attemptId, ageMs } };
      }

      const key = `${attemptId}:${stage}`;
      const prior = misses.get(job.jobId);
      const count = prior && prior.key === key ? prior.count + 1 : 1;
      misses.set(job.jobId, { key, count });
      const what = delivered
        ? "the restore request was sent but no RESTORED note has appeared; the session may be stuck"
        : "no restore delivery signal on the marker; the bridge or the restore request may have failed";
      deps.warn(`compaction lifecycle: ${job.target.session} attempt ${attemptId} stage ${stage} past its window — ${what}`,
        { session: job.target.session, attemptId, stage, ageMs, count });
      if (count >= CONSECUTIVE_TIMEOUTS_FOR_ADVISORY && !advised.has(key)) {
        try {
          await deps.createAdvisory({
            dedupeKey: key,
            session: job.target.session,
            attemptId,
            stage,
            body: `compaction-lifecycle ${key}: ${job.target.session} — ${what}. Age ${Math.round(ageMs / 60_000)} min. `
              + `Check the seat with rig capture ${job.target.session}; the map is ${mapPath}. Advisory only: nothing was retried.`,
          });
          advised.add(key);
        } catch (error) {
          deps.warn(`compaction lifecycle: advisory for ${key} failed`, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      return { action: "skip", reason: `${stage}_timeout`, notes: { attemptId, ageMs, count } };
    },
  };
}
