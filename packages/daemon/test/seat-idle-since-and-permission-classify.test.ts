// RIG-123 — two additions to the one activity oracle: an explicit idleSince taken from activity transitions
// (never from changedAt), and an on-demand permission classification that needs no pre-tracked request.
import { describe, it, expect } from "vitest";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import type { ActivityEvidence, ActivityValue, AdapterRungInventory } from "../src/domain/activity-taxonomy.js";
import { readComposerOccupancy } from "../src/domain/session-transport.js";

const SEAT = "node-1";
const SESSION = "dev-impl@alpha";
const INVENTORY: AdapterRungInventory = {
  adapterId: "claude-code-adapter",
  runtime: "claude-code",
  rungs: [
    { rung: "lifecycle-hooks", lifecycleCoverage: "full", initialTrust: "authoritative" },
    { rung: "needs-input-chrome", lifecycleCoverage: "full", initialTrust: "authoritative" },
    { rung: "window-sampling", lifecycleCoverage: "full", initialTrust: "authoritative" },
  ],
};

function harness(reader?: (s: string, r: string) => Promise<boolean | null>) {
  const clock = { now: Date.parse("2026-10-24T00:00:00Z") };
  const svc = new SeatActivityService({
    tmux: { readPaneLastActivity: async () => null },
    defaultWindowSeconds: 3,
    now: () => new Date(clock.now),
    permissionPromptReader: reader,
  });
  svc.declareRungInventory({ seatNodeId: SEAT, sessionName: SESSION }, INVENTORY);
  let seq = 0;
  const hook = (activity: ActivityValue, extra: Partial<ActivityEvidence> = {}) =>
    svc.reportEvidence({ seatNodeId: SEAT, sessionName: SESSION, rung: "lifecycle-hooks", sourceId: "lifecycle-hooks", seq: ++seq, observedAt: new Date(clock.now).toISOString(), activity, ...extra });
  const chrome = (count: number, reason: string | null, activity?: ActivityValue) =>
    svc.reportEvidence({ seatNodeId: SEAT, sessionName: SESSION, rung: "needs-input-chrome", sourceId: "needs-input-chrome", seq: ++seq, observedAt: new Date(clock.now).toISOString(), needsInput: { count, reason }, ...(activity ? { activity } : {}) });
  return { clock, svc, hook, chrome, state: () => svc.getSeatStateBySession(SESSION)! };
}

describe("idleSince from activity transitions (RIG-123)", () => {
  it("starts at the working→idle transition and marks it observed", () => {
    const h = harness();
    h.hook("working");
    h.clock.now += 5_000;
    h.hook("idle-at-prompt");
    expect(h.state().idleSince).toEqual({ at: new Date(h.clock.now).toISOString(), transitionObserved: true });
  });

  it("is not observed when the first arbitration is already idle (for example after a daemon restart)", () => {
    const h = harness();
    h.hook("idle-at-prompt");
    expect(h.state().idleSince).toMatchObject({ transitionObserved: false });
  });

  it("survives changes that advance changedAt without ending the idle spell", () => {
    const h = harness();
    h.hook("working");
    h.clock.now += 1_000;
    h.hook("idle-at-prompt");
    const since = h.state().idleSince!;
    const changedBefore = h.state().changedAt;
    h.clock.now += 5_000; // inside the hook authority window, so the hook still decides "idle"
    h.chrome(1, "permission_prompt", "idle-at-prompt"); // needsInput change advances changedAt, activity stays idle
    expect(h.state().changedAt).not.toBe(changedBefore);
    expect(h.state().idleSince).toEqual(since);
  });

  it("clears when the seat works again and restarts at the next idle", () => {
    const h = harness();
    h.hook("working");
    h.clock.now += 1_000;
    h.hook("idle-at-prompt");
    h.clock.now += 1_000;
    h.hook("working");
    expect(h.state().idleSince).toBeNull();
    h.clock.now += 1_000;
    h.hook("idle-at-prompt");
    expect(h.state().idleSince).toEqual({ at: new Date(h.clock.now).toISOString(), transitionObserved: true });
  });
});

describe("classifyPermissionPrompt (RIG-123)", () => {
  it("an oracle-confirmed permission prompt is confirmed without any capture", async () => {
    let reads = 0;
    const h = harness(async () => { reads++; return null; });
    h.hook("idle-at-prompt");
    h.chrome(1, "permission_prompt");
    expect(await h.svc.classifyPermissionPrompt(SESSION)).toEqual({ state: "confirmed", source: "oracle" });
    expect(reads).toBe(0);
  });

  it("an unverified oracle request is suspected", async () => {
    const h = harness();
    h.hook("idle-at-prompt");
    h.chrome(1, "permission_request_unverified");
    expect(await h.svc.classifyPermissionPrompt(SESSION)).toEqual({ state: "suspected", source: "oracle" });
  });

  it("with no tracked request, a visible prompt is suspected (the reader also answers true for a selection prompt)", async () => {
    const h = harness(async () => true);
    h.hook("idle-at-prompt");
    expect(await h.svc.classifyPermissionPrompt(SESSION)).toEqual({ state: "suspected", source: "reader" });
  });

  it("no visible prompt is none; an unreadable screen is unavailable, never none", async () => {
    const none = harness(async () => false);
    none.hook("idle-at-prompt");
    expect(await none.svc.classifyPermissionPrompt(SESSION)).toEqual({ state: "none", source: "reader" });
    const unknown = harness(async () => null);
    unknown.hook("idle-at-prompt");
    expect(await unknown.svc.classifyPermissionPrompt(SESSION)).toEqual({ state: "unavailable", source: null });
    const throwing = harness(async () => { throw new Error("capture failed"); });
    throwing.hook("idle-at-prompt");
    expect(await throwing.svc.classifyPermissionPrompt(SESSION)).toEqual({ state: "unavailable", source: null });
  });

  it("an unknown session or an unwired reader is unavailable", async () => {
    const h = harness();
    h.hook("idle-at-prompt");
    expect(await h.svc.classifyPermissionPrompt(SESSION)).toEqual({ state: "unavailable", source: null });
    expect(await h.svc.classifyPermissionPrompt("nobody@alpha")).toEqual({ state: "unavailable", source: null });
  });
});

describe("readComposerOccupancy (RIG-123)", () => {
  it("never reads an unrecognized or blank pane as empty", () => {
    expect(readComposerOccupancy(null, "claude-code")).toBe("unknown");
    expect(readComposerOccupancy("   \n", "codex")).toBe("unknown");
    expect(readComposerOccupancy("some unrelated shell output\n$ ", "claude-code")).toBe("unknown");
    expect(readComposerOccupancy("some unrelated shell output\n$ ", "codex")).toBe("unknown");
  });
});
