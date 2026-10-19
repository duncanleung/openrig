// RIG-118 v1: the compaction-lifecycle watchdog policy for one managed compaction attempt.
// marker_pending -> delivered -> acknowledged, observed from the restore-pending marker
// (enforcer stamp or bridge stamp) and a RESTORED note beside the attempt's map.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  makeCompactionLifecyclePolicy,
  compactionMarkerPath,
  MARKER_PENDING_LIMIT_MS,
  DELIVERED_LIMIT_MS,
  LIFECYCLE_EXPIRY_MS,
  type CompactionAdvisory,
} from "../src/domain/policies/compaction-lifecycle.js";
import type { PolicyJob } from "../src/domain/policies/types.js";

const SEAT = "dev-impl@openrig";
const START = Date.parse("2026-10-19T23:00:00.000Z");
const MIN = 60_000;

let home: string;
let clock: number;
let mapPath: string;
const warn = vi.fn();
const advisories: CompactionAdvisory[] = [];
let advisoryFails = false;

function policy() {
  return makeCompactionLifecyclePolicy({
    openrigHome: () => home,
    now: () => clock,
    warn,
    createAdvisory: (a) => {
      if (advisoryFails) throw new Error("queue unavailable");
      advisories.push(a);
    },
  });
}

function job(context: Record<string, unknown> | null = {}): PolicyJob {
  return {
    jobId: "job-1", policy: "compaction-lifecycle", target: { session: SEAT }, intervalSeconds: 60,
    activeWakeIntervalSeconds: null, scanIntervalSeconds: null,
    context: context === null ? {} : {
      attemptId: "attempt-1", mapPath, startedAt: new Date(START).toISOString(), ...context,
    },
    lastEvaluationAt: null, lastFireAt: null, registeredBySession: "daemon@kernel", registeredAt: new Date(START).toISOString(),
    watchedFilePath: null, thresholdBytes: null, requiresJobId: null, lastFiredGeneration: null, occupantGeneration: null,
    currentGenerationTranscriptPending: false, requiredReceiptSatisfied: true, requiredReceiptDeferred: false,
  } as PolicyJob;
}

function writeMarker(data: Record<string, unknown>) {
  const file = compactionMarkerPath(home, SEAT);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ version: 1, createdAt: new Date(START + 2_000).toISOString(), ...data })}\n`);
}

function writeRestored(name = "RESTORED-20261019-2310.md", mtimeMs = START + 10 * MIN) {
  mkdirSync(dirname(mapPath), { recursive: true });
  const file = join(dirname(mapPath), name);
  writeFileSync(file, "# Restored\n");
  utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "rig118-policy-"));
  mapPath = join(home, "repo", ".openrig", "compaction", "preparation", SEAT, "attempt-1", "RESTORE-MAP.md");
  clock = START;
  warn.mockClear();
  advisories.length = 0;
  advisoryFails = false;
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe("compaction-lifecycle policy (RIG-118)", () => {
  it("ends with a named reason when the job context is incomplete", async () => {
    const result = await policy().evaluate(job(null));
    expect(result).toMatchObject({ action: "terminal", reason: "compaction_lifecycle_context_invalid" });
  });

  it("marker_pending inside its window is a quiet skip", async () => {
    clock = START + MARKER_PENDING_LIMIT_MS;
    expect(await policy().evaluate(job())).toMatchObject({ action: "skip", reason: "marker_pending_within_window" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("marker_pending past 5 min: WARN on the first miss, one advisory on the second, never a repeat", async () => {
    const p = policy();
    clock = START + MARKER_PENDING_LIMIT_MS + 1;
    expect(await p.evaluate(job())).toMatchObject({ action: "skip", reason: "marker_pending_timeout" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(advisories).toHaveLength(0);

    clock += MIN;
    await p.evaluate(job());
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toMatchObject({ dedupeKey: "attempt-1:marker_pending", session: SEAT, stage: "marker_pending" });
    expect(advisories[0]!.body).toContain("attempt-1:marker_pending");
    expect(advisories[0]!.body).toContain("Advisory only");

    clock += MIN;
    await p.evaluate(job());
    clock += MIN;
    await p.evaluate(job());
    expect(advisories).toHaveLength(1);
  });

  it("the policy never asks the engine to send to the seat", async () => {
    const p = policy();
    for (const age of [MIN, 6 * MIN, 7 * MIN, 40 * MIN]) {
      clock = START + age;
      expect((await p.evaluate(job())).action).not.toBe("send");
    }
  });

  it.each([
    ["the enforcer stamp restoreRequestSentAt", { restoreRequestSentAt: new Date(START + 3_000).toISOString() }],
    ["the bridge stamp postCompactAt", { postCompactAt: new Date(START + 3_000).toISOString() }],
    ["the bridge stamp lastBridgeEvent", { lastBridgeEvent: "PostCompact" }],
  ])("%s moves the attempt to delivered", async (_label, stamp) => {
    writeMarker(stamp);
    clock = START + 20 * MIN;
    expect(await policy().evaluate(job())).toMatchObject({ action: "skip", reason: "delivered_within_window" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("deliveredAt alone is not a delivery signal (only the bridge writes it)", async () => {
    writeMarker({ deliveredAt: new Date(START + 3_000).toISOString(), deliveryCount: 1 });
    clock = START + MARKER_PENDING_LIMIT_MS + 1;
    expect(await policy().evaluate(job())).toMatchObject({ reason: "marker_pending_timeout" });
  });

  it("a stamp on a marker from an OLDER compaction does not count for this attempt", async () => {
    writeMarker({ createdAt: new Date(START - 3 * 60 * MIN).toISOString(), restoreRequestSentAt: new Date(START - 3 * 60 * MIN).toISOString() });
    clock = START + MARKER_PENDING_LIMIT_MS + 1;
    expect(await policy().evaluate(job())).toMatchObject({ reason: "marker_pending_timeout" });
  });

  it("delivered past 30 min with no RESTORED note: WARN, then one advisory on the second miss", async () => {
    const p = policy();
    writeMarker({ restoreRequestSentAt: new Date(START + 3_000).toISOString() });
    clock = START + DELIVERED_LIMIT_MS + 1;
    expect(await p.evaluate(job())).toMatchObject({ action: "skip", reason: "delivered_timeout" });
    expect(advisories).toHaveLength(0);
    clock += MIN;
    await p.evaluate(job());
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toMatchObject({ dedupeKey: "attempt-1:delivered", stage: "delivered" });
  });

  it("a RESTORED note written after the attempt started acknowledges it and ends the job", async () => {
    writeMarker({ restoreRequestSentAt: new Date(START + 3_000).toISOString() });
    writeRestored();
    clock = START + 2 * DELIVERED_LIMIT_MS;
    expect(await policy().evaluate(job())).toMatchObject({ action: "terminal", reason: "compaction_acknowledged" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("a RESTORED note older than the attempt (an earlier compaction in the same folder) does not acknowledge", async () => {
    writeRestored("RESTORED-20261019-2053.md", START - 60 * MIN);
    clock = START + MARKER_PENDING_LIMIT_MS + 1;
    expect(await policy().evaluate(job())).toMatchObject({ reason: "marker_pending_timeout" });
  });

  it("a note that is not RESTORED-*.md does not acknowledge", async () => {
    writeRestored("NOTES.md", START + MIN);
    clock = START + MARKER_PENDING_LIMIT_MS + 1;
    expect(await policy().evaluate(job())).toMatchObject({ reason: "marker_pending_timeout" });
  });

  it("recovery resets the consecutive count: one miss, a delivery, then another miss raises no advisory", async () => {
    const p = policy();
    clock = START + MARKER_PENDING_LIMIT_MS + 1;
    await p.evaluate(job()); // miss 1 (marker_pending)
    writeMarker({ restoreRequestSentAt: new Date(START + 3_000).toISOString() });
    clock = START + 20 * MIN;
    await p.evaluate(job()); // delivered, inside its window: count cleared
    clock = START + DELIVERED_LIMIT_MS + 1;
    await p.evaluate(job()); // miss 1 (delivered)
    expect(advisories).toHaveLength(0);
  });

  it("a failed advisory is logged, does not throw, and is retried on the next miss", async () => {
    const p = policy();
    advisoryFails = true;
    clock = START + MARKER_PENDING_LIMIT_MS + 1;
    await p.evaluate(job());
    clock += MIN;
    await expect(p.evaluate(job())).resolves.toMatchObject({ reason: "marker_pending_timeout" });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("advisory for attempt-1:marker_pending failed"))).toBe(true);
    expect(advisories).toHaveLength(0);
    advisoryFails = false;
    clock += MIN;
    await p.evaluate(job());
    expect(advisories).toHaveLength(1);
  });

  it("ends after 24 hours so a forgotten job cannot live forever", async () => {
    clock = START + LIFECYCLE_EXPIRY_MS + 1;
    expect(await policy().evaluate(job())).toMatchObject({ action: "terminal", reason: "compaction_lifecycle_expired" });
  });

  it("an unreadable marker reads as no marker, not as a crash", async () => {
    const file = compactionMarkerPath(home, SEAT);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{not json");
    clock = START + MARKER_PENDING_LIMIT_MS + 1;
    expect(await policy().evaluate(job())).toMatchObject({ reason: "marker_pending_timeout" });
  });
});
