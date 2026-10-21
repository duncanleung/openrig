// RIG-112 — live memory-delivery coverage over node.startup_delivery_manifest events.
// Read-only, no new event types, ADR-0009 attribute names.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { computeMemoryCoverage, MEMORY_ATTR } from "../src/domain/memory-coverage.js";

let db: Database.Database;
let n = 0;

function ready(nodeId: string, at: string, rigId = "rig-1") {
  db.prepare("INSERT INTO events (rig_id, node_id, type, payload, created_at) VALUES (?, ?, 'node.startup_ready', '{}', ?)").run(rigId, nodeId, at);
}
function manifest(nodeId: string, session: string, surfaces: string[], at: string, rigId = "rig-1") {
  const deliveredFiles = surfaces.map((surface) => ({
    path: `/x/${surface}-${n++}.md`, deliveryHint: "send_text", surface, phase: "post_launch", contentHash: `h-${surface}`,
  }));
  const payload = { type: "node.startup_delivery_manifest", rigId, nodeId, sessionName: session, deliveredFiles,
    summary: { preLaunchCount: 0, postLaunchCount: deliveredFiles.length, surfaceCounts: {} } };
  db.prepare("INSERT INTO events (rig_id, node_id, type, payload, created_at) VALUES (?, ?, 'node.startup_delivery_manifest', ?, ?)")
    .run(rigId, nodeId, JSON.stringify(payload), at);
}

beforeEach(() => { db = createFullTestDb(); n = 0; });
afterEach(() => db.close());

describe("computeMemoryCoverage", () => {
  it("returns an honest empty report with null coverage when nothing was emitted", () => {
    const r = computeMemoryCoverage(db);
    expect(r).toMatchObject({ startups: 0, startupsWithDelivery: 0, deliveryCoverage: null, seats: [], truncated: false });
    expect(r.observationCoverage.available).toBe(false);
  });

  it("computes delivery coverage as startups that delivered / startups", () => {
    for (const [node, at] of [["a", "2026-10-19 10:00:00"], ["b", "2026-10-19 10:01:00"], ["c", "2026-10-19 10:02:00"], ["d", "2026-10-19 10:03:00"]]) ready(node!, at!);
    manifest("a", "a@r", ["role", "guidance"], "2026-10-19 10:00:01");
    manifest("b", "b@r", ["role"], "2026-10-19 10:01:01");
    manifest("c", "c@r", ["wiki"], "2026-10-19 10:02:01");
    const r = computeMemoryCoverage(db);
    expect(r.startups).toBe(4);
    expect(r.startupsWithDelivery).toBe(3);
    expect(r.deliveryCoverage).toBe(0.75);
  });

  it("flags a seat that lost a surface it received in an earlier startup (history default)", () => {
    manifest("a", "a@r", ["role", "guidance", "wiki"], "2026-10-19 09:00:00");
    manifest("a", "a@r", ["role", "guidance"], "2026-10-19 11:00:00");
    const [seat] = computeMemoryCoverage(db).seats;
    expect(seat).toMatchObject({ expectedSource: "history", startups: 2, delivered: ["guidance", "role"], missing: ["wiki"] });
    expect(seat!.coverage).toBeCloseTo(2 / 3);
  });

  it("uses the expected list the caller passes, and finds a seat that never had a surface", () => {
    manifest("a", "a@r", ["role"], "2026-10-19 09:00:00");
    manifest("b", "b@r", ["role", "guidance", "wiki"], "2026-10-19 09:00:00");
    const r = computeMemoryCoverage(db, { expected: ["wiki", "role", "role"] });
    const a = r.seats.find((s) => s.nodeId === "a")!;
    expect(a).toMatchObject({ expectedSource: "caller", expected: ["role", "wiki"], missing: ["wiki"], coverage: 0.5 });
    expect(r.seats.find((s) => s.nodeId === "b")!.missing).toEqual([]);
    expect(r.seatsFullyDelivered).toBe(1);
    expect(r.seatsWithMissing).toBe(1);
  });

  it("reports delivered items under the ADR-0009 openrig.memory.* attribute names", () => {
    manifest("a", "a@r", ["role"], "2026-10-19 09:00:00");
    const item = computeMemoryCoverage(db).seats[0]!.latest[0]!;
    expect(item[MEMORY_ATTR.surface]).toBe("role");
    expect(item["openrig.memory.delivery_hint"]).toBe("send_text");
    expect(item["openrig.memory.content_hash"]).toBe("h-role");
    expect(item["openrig.memory.delivery_phase"]).toBe("startup");
    expect(item.launchPhase).toBe("post_launch");
    expect(Object.keys(item).filter((k) => k.startsWith("openrig.memory.")).sort()).toEqual([
      "openrig.memory.content_hash", "openrig.memory.delivery_hint", "openrig.memory.delivery_phase", "openrig.memory.surface",
    ]);
  });

  it("filters by since and by rig", () => {
    ready("a", "2026-10-18 10:00:00"); manifest("a", "a@r", ["role"], "2026-10-18 10:00:01");
    ready("a", "2026-10-19 10:00:00"); manifest("a", "a@r", ["role", "wiki"], "2026-10-19 10:00:01");
    ready("z", "2026-10-19 10:00:00", "rig-2"); manifest("z", "z@r2", ["role"], "2026-10-19 10:00:01", "rig-2");
    const since = computeMemoryCoverage(db, { since: "2026-10-19T00:00:00Z" });
    expect(since.startups).toBe(2);
    expect(since.seats.find((s) => s.nodeId === "a")).toMatchObject({ startups: 1 });
    const rig = computeMemoryCoverage(db, { rigId: "rig-2" });
    expect(rig.seats.map((s) => s.nodeId)).toEqual(["z"]);
    expect(rig.startups).toBe(1);
  });

  it("skips a malformed payload without failing, and never writes", () => {
    db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES ('rig-1','a','node.startup_delivery_manifest','{bad')").run();
    manifest("b", "b@r", ["role"], "2026-10-19 09:00:00");
    const before = (db.prepare("SELECT count(*) AS n FROM events").get() as { n: number }).n;
    const r = computeMemoryCoverage(db);
    expect(r.seats.map((s) => s.nodeId)).toEqual(["b"]);
    expect((db.prepare("SELECT count(*) AS n FROM events").get() as { n: number }).n).toBe(before);
  });

  it("never reports more than 100% when manifests outnumber startup_ready events", () => {
    manifest("a", "a@r", ["role"], "2026-10-19 09:00:00");
    manifest("a", "a@r", ["role"], "2026-10-19 10:00:00");
    ready("a", "2026-10-19 09:00:00");
    expect(computeMemoryCoverage(db).deliveryCoverage).toBe(1);
  });

  it("includes a seat with startup_ready but no manifest (empty startup)", () => {
    ready("a", "2026-10-19 10:00:00");
    ready("b", "2026-10-19 10:01:00");
    manifest("b", "b@r", ["role"], "2026-10-19 10:01:01");
    const r = computeMemoryCoverage(db, { expected: ["role"] });
    expect(r.seats.map((s) => s.nodeId).sort()).toEqual(["a", "b"]);
    const a = r.seats.find((s) => s.nodeId === "a")!;
    expect(a).toMatchObject({ delivered: [], missing: ["role"], coverage: 0, latest: [] });
    expect(r.seatsWithMissing).toBe(1);
    expect(r.seatsFullyDelivered).toBe(1);
  });

  it("treats delivered as empty when startup_ready is newer than the latest manifest", () => {
    manifest("a", "a@r", ["role", "guidance"], "2026-10-19 09:00:00");
    ready("a", "2026-10-19 10:00:00");
    const r = computeMemoryCoverage(db, { expected: ["role", "guidance"] });
    const a = r.seats.find((s) => s.nodeId === "a")!;
    expect(a).toMatchObject({ delivered: [], missing: ["guidance", "role"], coverage: 0, latest: [] });
  });

  it("uses the manifest when startup_ready is older than the latest manifest", () => {
    ready("a", "2026-10-19 09:00:00");
    manifest("a", "a@r", ["role", "guidance"], "2026-10-19 09:00:01");
    const r = computeMemoryCoverage(db, { expected: ["role", "guidance"] });
    const a = r.seats.find((s) => s.nodeId === "a")!;
    expect(a).toMatchObject({ delivered: ["guidance", "role"], missing: [], coverage: 1 });
    expect(a.latest.length).toBe(2);
  });
});

describe("GET /api/memory/coverage", () => {
  it("serves the report and passes the query through", async () => {
    ready("a", "2026-10-19 10:00:00"); manifest("a", "a@r", ["role"], "2026-10-19 10:00:01");
    const { app } = createTestApp(db);
    const res = await app.request("/api/memory/coverage?expected=role,wiki");
    expect(res.status).toBe(200);
    const body = await res.json() as { deliveryCoverage: number; seats: Array<{ missing: string[]; expectedSource: string }> };
    expect(body.deliveryCoverage).toBe(1);
    expect(body.seats[0]).toMatchObject({ expectedSource: "caller", missing: ["wiki"] });
  });

  it("refuses a bad since value", async () => {
    const { app } = createTestApp(db);
    const res = await app.request("/api/memory/coverage?since=yesterday-ish");
    expect(res.status).toBe(400);
  });

  it("normalizes non-ISO date strings to ISO before querying", async () => {
    ready("a", "2026-10-19 10:00:00"); manifest("a", "a@r", ["role"], "2026-10-19 10:00:01");
    const { app } = createTestApp(db);
    const res = await app.request("/api/memory/coverage?since=Oct+19+2026");
    expect(res.status).toBe(200);
    const body = await res.json() as { startups: number };
    expect(body.startups).toBe(1);
  });

  it("only answers GET", async () => {
    const { app } = createTestApp(db);
    const res = await app.request("/api/memory/coverage", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
