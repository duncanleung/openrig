import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";

const lifecycle = vi.hoisted(() => ({ byRigName: new Map<string, string | string[]>() }));
vi.mock("../src/domain/node-inventory.js", () => ({
  getNodeInventoryForRigs: (db: Database.Database, ids: ReadonlySet<string>) => {
    const out = new Map<string, Array<{ lifecycleState: string }>>();
    for (const id of ids) {
      const name = (db.prepare("SELECT name FROM rigs WHERE id = ?").get(id) as { name: string }).name;
      const states = lifecycle.byRigName.get(name) ?? "detached";
      out.set(id, (Array.isArray(states) ? states : [states]).map((lifecycleState) => ({ lifecycleState })));
    }
    return out;
  },
}));

const { collectRunningRigs, writeShutdownManifest, SHUTDOWN_MANIFEST_SCHEMA } = await import("../src/domain/shutdown-manifest.js");

describe("shutdown manifest (RIG-83)", () => {
  let db: Database.Database;
  let dir: string;
  beforeEach(() => {
    db = createFullTestDb();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "shutdown-manifest-"));
    lifecycle.byRigName.clear();
  });
  afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  it("records only rigs whose lifecycle is running", () => {
    const repo = new RigRepository(db);
    const up = repo.createRig("up-rig");
    repo.createRig("downed-rig");
    lifecycle.byRigName.set("up-rig", "running");
    expect(collectRunningRigs(db)).toEqual([{ id: up.id, name: "up-rig" }]);
  });

  it("keeps degraded and attention_required rigs that still have a live seat", () => {
    const repo = new RigRepository(db);
    const degraded = repo.createRig("degraded-live");
    const attention = repo.createRig("attention-live");
    lifecycle.byRigName.set("degraded-live", ["running", "detached"]);
    lifecycle.byRigName.set("attention-live", ["running", "attention_required"]);
    expect(collectRunningRigs(db).map((r) => r.id).sort()).toEqual([degraded.id, attention.id].sort());
  });

  it("drops attention_required and recoverable rigs with no live seat", () => {
    const repo = new RigRepository(db);
    repo.createRig("attention-dead");
    repo.createRig("recoverable-dead");
    lifecycle.byRigName.set("attention-dead", ["attention_required", "detached"]);
    lifecycle.byRigName.set("recoverable-dead", ["recoverable"]);
    expect(collectRunningRigs(db)).toEqual([]);
  });

  it("writes an atomic, schema-tagged file", () => {
    const repo = new RigRepository(db);
    const up = repo.createRig("up-rig");
    lifecycle.byRigName.set("up-rig", "running");
    const file = path.join(dir, "shutdown-manifest.json");
    writeShutdownManifest(file, db, new Date("2026-10-12T00:00:00Z"));
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      schema: SHUTDOWN_MANIFEST_SCHEMA, at: "2026-10-12T00:00:00.000Z", rigs: [{ id: up.id, name: "up-rig" }],
    });
    expect(fs.readdirSync(dir)).toEqual(["shutdown-manifest.json"]);
  });

  it("removes the previous manifest when the new write fails, so an older stop is never trusted", () => {
    const file = path.join(dir, "shutdown-manifest.json");
    fs.writeFileSync(file, JSON.stringify({ schema: SHUTDOWN_MANIFEST_SCHEMA, at: "2026-10-01T00:00:00.000Z", rigs: [{ id: "old", name: "old-rig" }] }));
    db.close();
    expect(() => writeShutdownManifest(file, db)).toThrow();
    expect(fs.existsSync(file)).toBe(false);
    db = createFullTestDb();
  });

  it("replaces an existing manifest with the new one on success", () => {
    const repo = new RigRepository(db);
    const up = repo.createRig("up-rig");
    lifecycle.byRigName.set("up-rig", "running");
    const file = path.join(dir, "shutdown-manifest.json");
    fs.writeFileSync(file, JSON.stringify({ schema: SHUTDOWN_MANIFEST_SCHEMA, at: "2026-10-01T00:00:00.000Z", rigs: [{ id: "old", name: "old-rig" }] }));
    writeShutdownManifest(file, db, new Date("2026-10-12T00:00:00Z"));
    expect(JSON.parse(fs.readFileSync(file, "utf8")).rigs).toEqual([{ id: up.id, name: "up-rig" }]);
  });

  it("writes an empty list when nothing is running", () => {
    new RigRepository(db).createRig("downed-rig");
    const file = path.join(dir, "m.json");
    writeShutdownManifest(file, db);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).rigs).toEqual([]);
  });
});
