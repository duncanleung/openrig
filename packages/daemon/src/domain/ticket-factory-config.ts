// RIG-88: maps the project's .factory.yml onto ticket-factory control settings, and defines
// the merge-approval precedence. The file seeds the control row; after that SQLite is the
// source of truth until an explicit reload.

import fs from "node:fs";
import { parse as parseYaml } from "yaml";

export interface FactorySettings {
  pollIntervalSeconds: number;
  capacity: number;
  maxTicketsPerRun: number;
  wallClockPerTicketSeconds: number;
  cooldownSeconds: number;
  mergeGate: string;
  mergePolicy: string;
  /** Advisory only: no session-level token attribution exists yet. */
  tokenCapPerTicket: number | null;
}

export const FACTORY_DEFAULTS: FactorySettings = {
  pollIntervalSeconds: 300,
  capacity: 1,
  maxTicketsPerRun: 3,
  wallClockPerTicketSeconds: 3600,
  cooldownSeconds: 3600,
  mergeGate: "all",
  mergePolicy: "human",
  tokenCapPerTicket: null,
};

export type EffectiveMerge = "human-approval" | "auto-low-risk";

/**
 * Precedence: explicit approval wins. `merge_gate: all` means every merge needs a human, so it
 * overrides `merge_policy: auto-low-risk`. Auto-merge is reachable only when the gate is not `all`.
 */
export function resolveMergePolicy(mergeGate: string, mergePolicy: string): { effective: EffectiveMerge; reason: string } {
  if (mergeGate === "all") {
    return {
      effective: "human-approval",
      reason: mergePolicy === "auto-low-risk"
        ? "merge_gate: all overrides merge_policy: auto-low-risk (explicit approval wins)"
        : "merge_gate: all requires human approval for every merge",
    };
  }
  if (mergePolicy === "auto-low-risk") return { effective: "auto-low-risk", reason: `merge_gate: ${mergeGate} allows auto-low-risk` };
  return { effective: "human-approval", reason: `merge_policy: ${mergePolicy} requires human approval` };
}

function posInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

export function parseFactorySettings(text: string): FactorySettings {
  const doc = (parseYaml(text) ?? {}) as Record<string, any>;
  const budget = (doc.budget ?? {}) as Record<string, unknown>;
  const sched = (doc.scheduler ?? {}) as Record<string, unknown>;
  const approval = (doc.approval_batching ?? {}) as Record<string, unknown>;
  const d = FACTORY_DEFAULTS;
  return {
    pollIntervalSeconds: posInt(sched.poll_interval_seconds, d.pollIntervalSeconds),
    capacity: posInt(sched.capacity, d.capacity),
    maxTicketsPerRun: posInt(budget.max_tickets_per_run, d.maxTicketsPerRun),
    wallClockPerTicketSeconds: typeof budget.wall_clock_per_ticket_min === "number" && budget.wall_clock_per_ticket_min > 0
      ? Math.floor(budget.wall_clock_per_ticket_min * 60) : d.wallClockPerTicketSeconds,
    cooldownSeconds: posInt(sched.cooldown_seconds, d.cooldownSeconds),
    mergeGate: typeof approval.merge_gate === "string" ? approval.merge_gate : d.mergeGate,
    mergePolicy: typeof doc.merge_policy === "string" ? doc.merge_policy : d.mergePolicy,
    tokenCapPerTicket: typeof budget.token_cap_per_ticket === "number" ? budget.token_cap_per_ticket : null,
  };
}

/** Missing or unreadable file yields the defaults; a malformed file throws. */
export function loadFactorySettings(path: string): FactorySettings {
  let text: string;
  try { text = fs.readFileSync(path, "utf8"); } catch { return { ...FACTORY_DEFAULTS }; }
  return parseFactorySettings(text);
}
