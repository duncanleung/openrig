import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SHUTDOWN_MANIFEST_MAX_AGE_MS,
  clearShutdownManifest,
  readShutdownManifest,
  selectLastRunning,
} from "../src/shutdown-manifest.js";

let dir: string;
let file: string;
const NOW = Date.parse("2026-10-13T00:00:00Z");
const write = (obj: unknown) => fs.writeFileSync(file, typeof obj === "string" ? obj : JSON.stringify(obj));
const good = (over: object = {}) => ({
  schema: "openrig.shutdown-manifest/v1", at: "2026-10-12T00:00:00Z", rigs: [{ id: "r1", name: "a" }, { id: "r2", name: "b" }], ...over,
});
const cands = [{ rigId: "r1" }, { rigId: "r2" }, { rigId: "r3" }];

beforeEach(() => { dir = fs.mkdtempSync(join(tmpdir(), "cli-shutdown-manifest-")); file = join(dir, "shutdown-manifest.json"); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("shutdown manifest (RIG-83)", () => {
  it("--last keeps only rigs that were running at stop (manually downed rig stays down)", () => {
    write(good());
    const picked = selectLastRunning(cands, readShutdownManifest(file, NOW));
    expect(picked.selected.map((c) => c.rigId)).toEqual(["r1", "r2"]);
    expect(picked.warning).toBeUndefined();
  });

  it("an empty manifest restores nothing", () => {
    write(good({ rigs: [] }));
    expect(selectLastRunning(cands, readShutdownManifest(file, NOW)).selected).toEqual([]);
  });

  it.each([
    ["missing", () => undefined],
    ["corrupt (bad JSON)", () => write("{nope")],
    ["corrupt (wrong schema)", () => write(good({ schema: "other" }))],
    ["corrupt (rig without id)", () => write(good({ rigs: [{ name: "x" }] }))],
    ["stale", () => write(good({ at: new Date(NOW - SHUTDOWN_MANIFEST_MAX_AGE_MS - 1000).toISOString() }))],
  ])("falls back to all candidates with a warning when %s", (_label, setup) => {
    setup();
    const read = readShutdownManifest(file, NOW);
    expect(read.ok).toBe(false);
    const picked = selectLastRunning(cands, read);
    expect(picked.selected).toHaveLength(3);
    expect(picked.warning).toMatch(/No usable shutdown manifest/);
  });

  it("clear removes the file and tolerates a missing one", () => {
    write(good());
    clearShutdownManifest(file);
    expect(fs.existsSync(file)).toBe(false);
    expect(() => clearShutdownManifest(file)).not.toThrow();
  });
});
