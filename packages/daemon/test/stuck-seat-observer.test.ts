// RIG-123 — stuck-seat observation: permission classification, delivery-attempt correlation of composer text,
// idle-with-expected-work from explicit idleSince, per-episode lifecycle, and detector-specific coverage.
import { describe, it, expect, beforeEach } from "vitest";
import {
  StuckSeatObserver,
  DEFAULT_COMPOSER_GRACE_MS,
  DEFAULT_IDLE_THRESHOLD_MS,
  type ComposerReading,
  type SeatTarget,
  type StuckSeatObserverDeps,
} from "../src/domain/stuck-seat-observer.js";
import { DeliveryAttemptLedger, teeObserverSinks, LEDGER_ATTEMPTS_PER_SESSION } from "../src/domain/delivery-attempt-ledger.js";
import type { ObservationInput } from "../src/domain/capture-observer.js";

const T0 = Date.parse("2026-10-24T00:00:00Z");
const SEAT: SeatTarget = { rig: "alpha", logicalId: "dev.impl", session: "dev-impl@alpha", runtime: "claude-code" };
const OTHER: SeatTarget = { rig: "beta", logicalId: "dev.qa", session: "dev-qa@beta", runtime: "codex" };

type State = { seatNodeId: string; activity: string; idleSince?: { at: string; transitionObserved: boolean } | null; lastSwap: { generation: string; at: string } | null };

describe("StuckSeatObserver (RIG-123)", () => {
  let nowMs: number;
  let seats: SeatTarget[];
  let states: Map<string, State>;
  let permission: Map<string, { state: "confirmed" | "suspected" | "none" | "unavailable"; source: "oracle" | "reader" | null }>;
  let composer: Map<string, ComposerReading>;
  let owed: Map<string, number>;
  let ledger: DeliveryAttemptLedger;
  let composerCalls: number;

  const iso = (ms: number) => new Date(ms).toISOString();

  function build(over: Partial<StuckSeatObserverDeps> = {}): StuckSeatObserver {
    return new StuckSeatObserver({
      listSeats: (rig) => seats.filter((s) => !rig || s.rig === rig),
      seatActivity: {
        getSeatStateBySession: (s: string) => (states.get(s) ?? null) as never,
        classifyPermissionPrompt: async (s: string) => permission.get(s) ?? { state: "none", source: "reader" },
      },
      readComposers: async (targets) => { composerCalls++; return new Map(targets.map((t) => [t.session, composer.get(t.session) ?? "empty"])); },
      attempts: ledger,
      expectedWork: (s) => owed.get(s) ?? 0,
      now: () => new Date(nowMs),
      ...over,
    });
  }

  beforeEach(() => {
    nowMs = T0;
    seats = [SEAT];
    states = new Map([[SEAT.session, { seatNodeId: "n1", activity: "idle-at-prompt", idleSince: null, lastSwap: null }]]);
    permission = new Map();
    composer = new Map();
    owed = new Map();
    ledger = new DeliveryAttemptLedger();
    composerCalls = 0;
  });

  describe("permission_blocked", () => {
    it("reports an oracle-confirmed prompt as confirmed and a reader-only sighting as suspected", async () => {
      const obs = build();
      permission.set(SEAT.session, { state: "confirmed", source: "oracle" });
      await obs.scan();
      expect(obs.snapshot().findings).toMatchObject([{ kind: "permission_blocked", confidence: "confirmed" }]);
      permission.set(SEAT.session, { state: "suspected", source: "reader" });
      nowMs += 1000;
      await obs.scan();
      const f = obs.snapshot().findings;
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ confidence: "suspected" });
    });

    it("treats an unreadable prompt as unobserved, not clear, so coverage is partial and no finding opens", async () => {
      permission.set(SEAT.session, { state: "unavailable", source: null });
      const obs = build();
      await obs.scan();
      const snap = obs.snapshot();
      expect(snap.findings).toEqual([]);
      expect(snap.coverage.find((c) => c.detector === "permission_blocked")).toMatchObject({ status: "unavailable" });
    });
  });

  describe("persistent_composer_input", () => {
    it("reports nothing inside the grace interval", async () => {
      composer.set(SEAT.session, "text");
      const obs = build();
      await obs.scan();
      nowMs += DEFAULT_COMPOSER_GRACE_MS - 1;
      await obs.scan();
      expect(obs.snapshot().findings).toEqual([]);
    });

    it("reports uncorrelated persistent input with uncertainty, never as an undelivered send", async () => {
      composer.set(SEAT.session, "text");
      const obs = build();
      await obs.scan();
      nowMs += DEFAULT_COMPOSER_GRACE_MS;
      await obs.scan();
      const [f] = obs.snapshot().findings;
      expect(f).toMatchObject({ kind: "persistent_composer_input", confidence: "suspected", correlation: "uncorrelated", deliveryAttempt: null });
      expect(f!.detail).toMatch(/draft|suggestion|queued/);
      expect(f!.detail).not.toMatch(/undelivered/i);
    });

    it("correlates with a delivery attempt on the same node and occupant, still without claiming delivery failed", async () => {
      ledger.record({ seam: "send_verify", attemptId: "att-1", binding: { sessionName: SEAT.session, nodeId: "n1", occupant: "g1", pane: "%1" }, runtime: "claude-code", sentHash: "h1", pre: { state: "not_requested" }, post: { state: "not_requested" }, regexResult: {}, completedAt: iso(T0 - 5000) } as ObservationInput);
      composer.set(SEAT.session, "text");
      const obs = build();
      await obs.scan();
      nowMs += DEFAULT_COMPOSER_GRACE_MS;
      await obs.scan();
      const [f] = obs.snapshot().findings;
      expect(f).toMatchObject({ correlation: "attempt-correlated", deliveryAttempt: { attemptId: "att-1" } });
      expect(f!.detail).toMatch(/not proven/);
    });

    it("ignores an attempt sent to a previous occupant (before the swap)", async () => {
      ledger.record({ seam: "send_verify", attemptId: "old", binding: { sessionName: SEAT.session, nodeId: "n1", occupant: "g0", pane: "%1" }, runtime: "claude-code", sentHash: "h0", pre: { state: "not_requested" }, post: { state: "not_requested" }, regexResult: {}, completedAt: iso(T0 - 60_000) } as ObservationInput);
      states.set(SEAT.session, { seatNodeId: "n1", activity: "idle-at-prompt", lastSwap: { generation: "g1", at: iso(T0 - 10_000) } });
      composer.set(SEAT.session, "text");
      const obs = build();
      await obs.scan();
      nowMs += DEFAULT_COMPOSER_GRACE_MS;
      await obs.scan();
      expect(obs.snapshot().findings[0]).toMatchObject({ correlation: "uncorrelated" });
    });

    it("does not capture a seat that is mid-turn", async () => {
      states.set(SEAT.session, { seatNodeId: "n1", activity: "working", lastSwap: null });
      const obs = build();
      await obs.scan();
      expect(composerCalls).toBe(0);
    });

    it("an unreadable composer is unobserved; an unwired reader makes the detector unavailable", async () => {
      composer.set(SEAT.session, "unknown");
      const a = build();
      await a.scan();
      expect(a.snapshot().coverage.find((c) => c.detector === "persistent_composer_input")?.status).toBe("unavailable");
      const b = build({ readComposers: undefined });
      await b.scan();
      expect(b.snapshot().findings).toEqual([]);
      expect(b.snapshot().coverage.find((c) => c.detector === "persistent_composer_input")?.status).toBe("unavailable");
    });

    it("without delivery-attempt wiring the detector is partial: findings are uncorrelated", async () => {
      const obs = build({ attempts: undefined });
      await obs.scan();
      expect(obs.snapshot().coverage.find((c) => c.detector === "persistent_composer_input")).toMatchObject({ status: "partial" });
    });
  });

  describe("idle_with_expected_work", () => {
    const idleFor = (ms: number, observed = true) => ({ at: iso(T0 - ms), transitionObserved: observed });

    it("reports idle past the threshold only when queue work is owed", async () => {
      states.set(SEAT.session, { seatNodeId: "n1", activity: "idle-at-prompt", idleSince: idleFor(DEFAULT_IDLE_THRESHOLD_MS), lastSwap: null });
      const obs = build();
      await obs.scan(); // nothing owed: healthy standby
      expect(obs.snapshot().findings).toEqual([]);
      owed.set(SEAT.session, 2);
      await obs.scan();
      expect(obs.snapshot().findings[0]).toMatchObject({ kind: "idle_with_expected_work", confidence: "confirmed", durationUncertain: false, expectedWork: 2 });
    });

    it("does not report below the threshold", async () => {
      states.set(SEAT.session, { seatNodeId: "n1", activity: "idle-at-prompt", idleSince: idleFor(DEFAULT_IDLE_THRESHOLD_MS - 1000), lastSwap: null });
      owed.set(SEAT.session, 1);
      const obs = build();
      await obs.scan();
      expect(obs.snapshot().findings).toEqual([]);
    });

    it("marks the duration uncertain when the idle start was not observed (daemon restart)", async () => {
      states.set(SEAT.session, { seatNodeId: "n1", activity: "idle-at-prompt", idleSince: idleFor(DEFAULT_IDLE_THRESHOLD_MS, false), lastSwap: null });
      owed.set(SEAT.session, 1);
      const obs = build();
      await obs.scan();
      expect(obs.snapshot().findings[0]).toMatchObject({ durationUncertain: true, confidence: "suspected" });
    });

    it("an unknown activity state is unobserved, not healthy", async () => {
      states.set(SEAT.session, { seatNodeId: "n1", activity: "unknown", lastSwap: null });
      const obs = build();
      await obs.scan();
      expect(obs.snapshot().coverage.find((c) => c.detector === "idle_with_expected_work")?.status).toBe("unavailable");
    });
  });

  describe("episodes", () => {
    it("opens once, refreshes in place, and closes on recovery", async () => {
      permission.set(SEAT.session, { state: "confirmed", source: "oracle" });
      const obs = build();
      await obs.scan();
      const openedAt = obs.snapshot().findings[0]!.openedAt;
      const id = obs.snapshot().findings[0]!.episodeId;
      nowMs += 10_000;
      await obs.scan();
      expect(obs.snapshot().findings).toHaveLength(1);
      expect(obs.snapshot().findings[0]).toMatchObject({ openedAt, episodeId: id, lastObservedAt: iso(nowMs) });
      permission.set(SEAT.session, { state: "none", source: "reader" });
      nowMs += 10_000;
      await obs.scan();
      expect(obs.snapshot().findings).toEqual([]);
      expect(obs.snapshot().recentlyClosed[0]).toMatchObject({ episodeId: id, reason: "recovered" });
    });

    it("a recurrence opens a new episode instead of reusing the closed one", async () => {
      const obs = build();
      permission.set(SEAT.session, { state: "confirmed", source: "oracle" });
      await obs.scan();
      const first = obs.snapshot().findings[0]!.episodeId;
      permission.set(SEAT.session, { state: "none", source: "reader" });
      nowMs += 1000; await obs.scan();
      permission.set(SEAT.session, { state: "confirmed", source: "oracle" });
      nowMs += 1000; await obs.scan();
      expect(obs.snapshot().findings[0]!.episodeId).not.toBe(first);
    });

    it("keeps multiple findings per seat at once", async () => {
      permission.set(SEAT.session, { state: "confirmed", source: "oracle" });
      composer.set(SEAT.session, "text");
      const obs = build();
      await obs.scan();
      nowMs += DEFAULT_COMPOSER_GRACE_MS;
      await obs.scan();
      expect(obs.snapshot().findings.map((f) => f.kind).sort()).toEqual(["permission_blocked", "persistent_composer_input"]);
    });

    it("closes the episode and opens a new one when the occupant is replaced", async () => {
      permission.set(SEAT.session, { state: "confirmed", source: "oracle" });
      const obs = build();
      await obs.scan();
      const first = obs.snapshot().findings[0]!.episodeId;
      states.set(SEAT.session, { seatNodeId: "n1", activity: "idle-at-prompt", lastSwap: { generation: "g2", at: iso(nowMs) } });
      nowMs += 1000;
      await obs.scan();
      expect(obs.snapshot().findings[0]!.episodeId).not.toBe(first);
      expect(obs.snapshot().recentlyClosed[0]).toMatchObject({ episodeId: first, reason: "occupant_changed" });
    });

    it("keeps an episode open when the seat could not be read this scan (unobserved is not recovery)", async () => {
      permission.set(SEAT.session, { state: "confirmed", source: "oracle" });
      const obs = build();
      await obs.scan();
      permission.set(SEAT.session, { state: "unavailable", source: null });
      nowMs += 1000;
      await obs.scan();
      expect(obs.snapshot().findings).toHaveLength(1);
    });

    it("closes episodes of a seat that left the fleet", async () => {
      permission.set(SEAT.session, { state: "confirmed", source: "oracle" });
      const obs = build();
      await obs.scan();
      seats = [];
      nowMs += 1000;
      await obs.scan();
      expect(obs.snapshot().findings).toEqual([]);
      expect(obs.snapshot().recentlyClosed[0]).toMatchObject({ reason: "seat_gone" });
    });
  });

  describe("scope and freshness", () => {
    it("a --rig scan examines only that rig and leaves other rigs' episodes alone", async () => {
      seats = [SEAT, OTHER];
      states.set(OTHER.session, { seatNodeId: "n2", activity: "idle-at-prompt", lastSwap: null });
      permission.set(SEAT.session, { state: "confirmed", source: "oracle" });
      permission.set(OTHER.session, { state: "confirmed", source: "oracle" });
      const obs = build();
      await obs.scan();
      expect(obs.snapshot().findings).toHaveLength(2);
      permission.set(SEAT.session, { state: "none", source: "reader" });
      nowMs += 1000;
      await obs.scan({ rig: "alpha" });
      expect(obs.snapshot().findings.map((f) => f.rig)).toEqual(["beta"]);
      expect(obs.snapshot({ rigNames: new Set(["alpha"]) }).findings).toEqual([]);
    });

    it("reads composers for the whole fleet in one batched call", async () => {
      seats = [SEAT, OTHER];
      states.set(OTHER.session, { seatNodeId: "n2", activity: "idle-at-prompt", lastSwap: null });
      const obs = build();
      await obs.scan();
      expect(composerCalls).toBe(1);
    });

    it("before the first scan every detector is unavailable; a stale scan turns complete coverage partial and findings stale", async () => {
      const obs = build();
      expect(obs.snapshot().coverage.every((c) => c.status === "unavailable")).toBe(true);
      permission.set(SEAT.session, { state: "confirmed", source: "oracle" });
      await obs.scan();
      nowMs += 10 * 60_000;
      const snap = obs.snapshot();
      expect(snap.findings[0]!.stale).toBe(true);
      expect(snap.coverage.filter((c) => c.status === "complete")).toEqual([]);
    });

    it("single-flight: concurrent scans share one pass", async () => {
      const obs = build();
      await Promise.all([obs.scan(), obs.scan(), obs.scan()]);
      expect(composerCalls).toBe(1);
    });

    it("a failing batched composer read does not abort the scan", async () => {
      permission.set(SEAT.session, { state: "confirmed", source: "oracle" });
      const obs = build({ readComposers: async () => { throw new Error("tmux slow"); } });
      await obs.scan();
      expect(obs.snapshot().findings).toHaveLength(1);
    });
  });
});

describe("DeliveryAttemptLedger", () => {
  const input = (attemptId: string, sentHash: string | null, session = "s@r"): ObservationInput => ({
    seam: "send_verify", attemptId, binding: { sessionName: session, nodeId: "n", occupant: null, pane: null }, runtime: "claude-code",
    sentHash, pre: { state: "not_requested" }, post: { state: "not_requested" }, regexResult: {}, completedAt: "2026-10-24T00:00:00Z",
  });

  it("keeps only sends (non-null hash), newest first, one row per attempt, bounded per session", () => {
    const l = new DeliveryAttemptLedger();
    l.record(input("probe", null));
    for (let i = 0; i < LEDGER_ATTEMPTS_PER_SESSION + 2; i++) l.record(input(`a${i}`, `h${i}`));
    l.record(input("a5", "h5"));
    const ids = l.attemptsFor("s@r").map((a) => a.attemptId);
    expect(ids).toHaveLength(LEDGER_ATTEMPTS_PER_SESSION);
    expect(ids[0]).toBe("a5");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never throws on malformed input and tee isolates a failing sink", () => {
    const l = new DeliveryAttemptLedger();
    expect(() => l.record({} as ObservationInput)).not.toThrow();
    const seen: string[] = [];
    const sink = teeObserverSinks({ record() { throw new Error("boom"); } }, l, undefined);
    expect(() => sink.record(input("x", "hx"))).not.toThrow();
    seen.push(...l.attemptsFor("s@r").map((a) => a.attemptId));
    expect(seen).toEqual(["x"]);
  });
});
