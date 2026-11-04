// Optional webhook notify for the stuck-message sweeper. Credentials come only
// from env / config — never hard-coded. A missing URL means the notifier is a no-op.
import type { StuckSweepItem } from "./stuck-message-sweeper.js";

export const STUCK_SWEEP_NOTIFY_URL_ENV = "OPENRIG_STUCK_SWEEP_NOTIFY_URL";
export const STUCK_SWEEP_NOTIFY_BEARER_ENV = "OPENRIG_STUCK_SWEEP_NOTIFY_BEARER";

export interface StuckNotifyConfig {
  url: string;
  bearer?: string;
}

export function readStuckNotifyConfig(
  env: NodeJS.ProcessEnv = process.env,
): StuckNotifyConfig | null {
  const url = env[STUCK_SWEEP_NOTIFY_URL_ENV]?.trim();
  if (!url) return null;
  const bearer = env[STUCK_SWEEP_NOTIFY_BEARER_ENV]?.trim() || undefined;
  return { url, bearer };
}

export function stuckNotifyPayload(item: StuckSweepItem): Record<string, unknown> {
  return {
    kind: "openrig.stuck_message",
    seat: item.logicalId,
    session: item.session,
    rig: item.rig,
    action: item.action === "auto_enter_verified" ? "auto_fixed" : "needs_human",
    attribution: item.attribution,
    excerpt: item.excerpt,
    detail: item.detail,
    deliveryAttemptId: item.deliveryAttemptId ?? null,
    verified: item.verified ?? null,
  };
}

/** POST one JSON summary per unresolved / auto-fixed item. Never throws. */
export async function postStuckNotify(
  item: StuckSweepItem,
  config: StuckNotifyConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.bearer) headers["authorization"] = `Bearer ${config.bearer}`;
  try {
    await fetchImpl(config.url, {
      method: "POST",
      headers,
      body: JSON.stringify(stuckNotifyPayload(item)),
    });
  } catch {
    // Notify is best-effort; the sweep report already carries the finding.
  }
}

export function makeStuckNotifyHook(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): ((item: StuckSweepItem) => Promise<void>) | undefined {
  const config = readStuckNotifyConfig(env);
  if (!config) return undefined;
  return (item) => postStuckNotify(item, config, fetchImpl);
}
