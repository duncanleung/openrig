import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OPENRIG_HOME } from "./openrig-compat.js";

export const SHUTDOWN_MANIFEST_FILE = "shutdown-manifest.json";
const SCHEMA = "openrig.shutdown-manifest/v1";
/** A manifest older than this belongs to a stop we can no longer vouch for. */
export const SHUTDOWN_MANIFEST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface ShutdownManifest {
  at: string;
  rigs: Array<{ id: string; name: string }>;
}

export type ManifestRead =
  | { ok: true; manifest: ShutdownManifest }
  | { ok: false; reason: "missing" | "corrupt" | "stale" };

export function shutdownManifestPath(home: string = OPENRIG_HOME): string {
  return join(home, SHUTDOWN_MANIFEST_FILE);
}

/**
 * Read the manifest the daemon wrote at its last stop. Reading never consumes it: it stays the
 * record of the last running set until the next daemon shutdown overwrites it.
 */
export function readShutdownManifest(path: string = shutdownManifestPath(), now: number = Date.now()): ManifestRead {
  if (!existsSync(path)) return { ok: false, reason: "missing" };
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const at = typeof raw["at"] === "string" ? Date.parse(raw["at"]) : NaN;
    const rigs = raw["rigs"];
    if (raw["schema"] !== SCHEMA || Number.isNaN(at) || !Array.isArray(rigs)
      || !rigs.every((r) => r && typeof (r as Record<string, unknown>)["id"] === "string")) {
      return { ok: false, reason: "corrupt" };
    }
    if (now - at > SHUTDOWN_MANIFEST_MAX_AGE_MS) return { ok: false, reason: "stale" };
    return {
      ok: true,
      manifest: {
        at: raw["at"] as string,
        rigs: rigs.map((r) => ({ id: (r as { id: string }).id, name: String((r as { name?: unknown }).name ?? "") })),
      },
    };
  } catch {
    return { ok: false, reason: "corrupt" };
  }
}

/**
 * Pick the `--last` candidates: only rigs that were running at daemon stop.
 * Without a usable manifest (crash, upgrade, corrupt, stale) restore every
 * candidate and say why — restoring too much is recoverable, nothing is not.
 */
export function selectLastRunning<T extends { rigId: string }>(
  candidates: T[],
  read: ManifestRead,
): { selected: T[]; warning?: string } {
  if (!read.ok) {
    return {
      selected: [...candidates],
      warning: `No usable shutdown manifest (${read.reason}); restoring all ${candidates.length} candidate rig(s). Use \`rig start --rigs <names>\` to pick.`,
    };
  }
  const running = new Set(read.manifest.rigs.map((r) => r.id));
  return { selected: candidates.filter((c) => running.has(c.rigId)) };
}
