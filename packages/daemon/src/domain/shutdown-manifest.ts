import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type Database from "better-sqlite3";
import { RigRepository } from "./rig-repository.js";
import { getNodeInventoryForRigs } from "./node-inventory.js";
import { deriveRigLifecycleState } from "./ps-projection.js";

export const SHUTDOWN_MANIFEST_FILE = "shutdown-manifest.json";
export const SHUTDOWN_MANIFEST_SCHEMA = "openrig.shutdown-manifest/v1";

export interface ShutdownManifest {
  schema: typeof SHUTDOWN_MANIFEST_SCHEMA;
  /** ISO time the daemon began shutting down. */
  at: string;
  /** Rigs with at least one live (running) seat when the daemon began shutting down. */
  rigs: Array<{ id: string; name: string }>;
}

/**
 * Rigs worth restoring: running, plus degraded or attention_required rigs that still have a live
 * session. A rig with no live seat (stopped, recoverable, or attention_required with nothing up)
 * stays out, so a manual `rig down` is respected.
 */
export function collectRunningRigs(db: Database.Database): ShutdownManifest["rigs"] {
  const summaries = new RigRepository(db).getRigSummaries({});
  const inventory = getNodeInventoryForRigs(db, new Set(summaries.map((s) => s.id)));
  return summaries
    .filter((s) => {
      const states = (inventory.get(s.id) ?? []).map((e) => e.lifecycleState);
      const rigState = deriveRigLifecycleState(states);
      if (rigState === "running") return true;
      return (rigState === "degraded" || rigState === "attention_required") && states.some((st) => st === "running");
    })
    .map((s) => ({ id: s.id, name: s.name }));
}

/** Atomically write the manifest. Must run before shutdown phases change rig state. */
export function writeShutdownManifest(path: string, db: Database.Database, now: Date = new Date()): ShutdownManifest {
  const manifest: ShutdownManifest = {
    schema: SHUTDOWN_MANIFEST_SCHEMA,
    at: now.toISOString(),
    rigs: collectRunningRigs(db),
  };
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(manifest) + "\n");
  renameSync(temp, path);
  return manifest;
}
