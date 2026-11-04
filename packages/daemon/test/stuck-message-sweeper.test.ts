import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  StuckMessageSweeper,
  DEFAULT_STUCK_GRACE_MS,
  type StuckMessageSweeperDeps,
} from "../src/domain/stuck-message-sweeper.js";
import type { SeatTarget } from "../src/domain/stuck-seat-observer.js";
import { DeliveryAttemptLedger } from "../src/domain/delivery-attempt-ledger.js";
import type { ObservationInput } from "../src/domain/capture-observer.js";

const T0 = Date.parse("2026-11-04T22:00:00Z");
const SEAT: SeatTarget = { rig: "alpha", logicalId: "dev.impl", session: "dev-impl@alpha", runtime: "claude-code" };

const ENVELOPE = [
  "From: orch.lead@alpha",
  "To: dev-impl@alpha",
  "Sent: 11-04 22:00Z",
  "---",
  "Please review the PR.",
  "---",
  '↩ Reply: rig send orch.lead@alpha "..."',
].join("\n");

function idlePane(body: string): string {
  const lines = body.split("\n");
  // A prior transcript line gives findClaudeComposer a status head so short
  // composers (collapsed paste) classify as idle rather than unknown.
  return [
    "Earlier agent output that proves the status head.",
    "──────────────",
    `❯ ${lines[0]}`,
    ...lines.slice(1).map((l) => `  ${l}`),
    "──────────────",
    "  ⏵⏵ accept edits on (shift+tab to cycle)",
  ].join("\n");
}

function permissionPane(): string {
  return [
    "Authorize the release?",
    "",
    "❯ 1. Authorize publish → @latest (Recommended)",
    "  2. Roll back",
    "──────────────",
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ].join("\n");
}

type State = {
  seatNodeId: string;
  activity: string;
  idleSince?: { at: string; transitionObserved: boolean } | null;
  lastSwap: { generation: string; at: string } | null;
};

describe("StuckMessageSweeper", () => {
  let nowMs: number;
  let seats: SeatTarget[];
  let states: Map<string, State>;
  let permission: Map<string, { state: "confirmed" | "suspected" | "none" | "unavailable"; source: "oracle" | "reader" | null }>;
  let panes: Map<string, string>;
  let ledger: DeliveryAttemptLedger;
  let submitOnly: ReturnType<typeof vi.fn>;
  let pressEnter: ReturnType<typeof vi.fn>;
  let auditEvents: Array<Record<string, unknown>>;
  let notifyItems: Array<unknown>;

  function build(over: Partial<StuckMessageSweeperDeps> = {}): StuckMessageSweeper {
    return new StuckMessageSweeper({
      listSeats: (rig) => seats.filter((s) => !rig || s.rig === rig),
      seatActivity: {
        getSeatStateBySession: (s: string) => (states.get(s) ?? null) as never,
        classifyPermissionPrompt: async (s: string) => permission.get(s) ?? { state: "none", source: "reader" },
      },
      capturePane: async (s) => panes.get(s) ?? null,
      submitOnly: submitOnly as never,
      pressEnter: pressEnter as never,
      attempts: ledger,
      eventBus: { emit: (e) => { auditEvents.push(e as never); return e as never; } },
      notify: async (item) => { notifyItems.push(item); },
      now: () => new Date(nowMs),
      sleep: async () => undefined,
      ...over,
    });
  }

  beforeEach(() => {
    nowMs = T0;
    seats = [SEAT];
    states = new Map([[SEAT.session, { seatNodeId: "n1", activity: "idle-at-prompt", idleSince: null, lastSwap: null }]]);
    permission = new Map();
    panes = new Map();
    ledger = new DeliveryAttemptLedger();
    submitOnly = vi.fn(async () => ({ ok: true }));
    pressEnter = vi.fn(async () => ({ ok: true }));
    auditEvents = [];
    notifyItems = [];
  });

  async function agePastGrace(sweeper: StuckMessageSweeper) {
    await sweeper.sweep({ dryRun: true });
    nowMs += DEFAULT_STUCK_GRACE_MS;
  }

  it("reports nothing inside the grace interval", async () => {
    panes.set(SEAT.session, idlePane(ENVELOPE));
    const sweeper = build();
    const first = await sweeper.sweep({ dryRun: true });
    expect(first.items).toMatchObject([{ action: "skipped_grace" }]);
    expect(first.unresolved).toBe(false);
    nowMs += DEFAULT_STUCK_GRACE_MS - 1;
    const second = await sweeper.sweep({ dryRun: true });
    expect(second.items).toMatchObject([{ action: "skipped_grace" }]);
  });

  it("dry-run reports attributable envelope stuck text without pressing Enter", async () => {
    panes.set(SEAT.session, idlePane(ENVELOPE));
    const sweeper = build();
    await agePastGrace(sweeper);
    const report = await sweeper.sweep({ dryRun: true });
    expect(report.items).toHaveLength(1);
    expect(report.items[0]).toMatchObject({
      action: "auto_enter",
      attribution: "openrig_envelope",
      session: SEAT.session,
    });
    expect(submitOnly).not.toHaveBeenCalled();
    expect(report.unresolved).toBe(false);
  });

  it("never auto-Enters a human draft — needs_human and unresolved", async () => {
    panes.set(SEAT.session, idlePane("half-written request I am still typing"));
    const sweeper = build();
    await agePastGrace(sweeper);
    const report = await sweeper.sweep({ dryRun: false });
    expect(report.items[0]).toMatchObject({ action: "needs_human", attribution: "human_draft" });
    expect(submitOnly).not.toHaveBeenCalled();
    expect(pressEnter).not.toHaveBeenCalled();
    expect(report.unresolved).toBe(true);
    expect(notifyItems).toHaveLength(1);
  });

  it("refuses Enter at a permission/interactive prompt", async () => {
    panes.set(SEAT.session, permissionPane());
    permission.set(SEAT.session, { state: "confirmed", source: "oracle" });
    const sweeper = build();
    await sweeper.sweep({ dryRun: false });
    nowMs += DEFAULT_STUCK_GRACE_MS;
    const report = await sweeper.sweep({ dryRun: false });
    expect(report.items.some((i) => i.action === "skipped_prompt")).toBe(true);
    expect(submitOnly).not.toHaveBeenCalled();
  });

  it("skips seats that are mid-turn (busy)", async () => {
    states.set(SEAT.session, { seatNodeId: "n1", activity: "working", lastSwap: null });
    panes.set(SEAT.session, idlePane(ENVELOPE));
    const sweeper = build();
    const report = await sweeper.sweep({ dryRun: false });
    expect(report.items).toEqual([]);
    expect(submitOnly).not.toHaveBeenCalled();
  });

  it("auto-Enters an OpenRig envelope after grace and verifies the box cleared", async () => {
    panes.set(SEAT.session, idlePane(ENVELOPE));
    const sweeper = build();
    await agePastGrace(sweeper);
    // After Enter, the composer is empty.
    submitOnly.mockImplementation(async () => {
      panes.set(SEAT.session, [
        "──────────────",
        "❯ ",
        "──────────────",
        "  ⏵⏵ accept edits on (shift+tab to cycle)",
      ].join("\n"));
      return { ok: true };
    });
    const report = await sweeper.sweep({ dryRun: false });
    expect(submitOnly).toHaveBeenCalledTimes(1);
    expect(submitOnly.mock.calls[0]![0]).toBe(SEAT.session);
    expect(report.items[0]).toMatchObject({ action: "auto_enter_verified", attribution: "openrig_envelope", verified: true });
    expect(auditEvents).toEqual([
      expect.objectContaining({ type: "transport.stuck_message_enter", outcome: "verified", sessionName: SEAT.session }),
    ]);
    expect(notifyItems).toHaveLength(1);
    expect(report.unresolved).toBe(false);
  });

  it("auto-Enters an attributed collapsed paste via pressEnter, not submitOnly", async () => {
    ledger.record({
      seam: "send_verify",
      attemptId: "att-9",
      binding: { sessionName: SEAT.session, nodeId: "n1", occupant: "g1", pane: "%1" },
      runtime: "claude-code",
      sentHash: "h1",
      pre: { state: "not_requested" },
      post: { state: "not_requested" },
      regexResult: { ok: true },
      completedAt: new Date(T0 - 5000).toISOString(),
    } as ObservationInput);
    panes.set(SEAT.session, idlePane("[Pasted text #3 +40 lines]"));
    const sweeper = build();
    await agePastGrace(sweeper);
    pressEnter.mockImplementation(async () => {
      panes.set(SEAT.session, [
        "──────────────",
        "❯ ",
        "──────────────",
        "  ⏵⏵ accept edits on (shift+tab to cycle)",
      ].join("\n"));
      return { ok: true };
    });
    const report = await sweeper.sweep({ dryRun: false });
    expect(pressEnter).toHaveBeenCalledTimes(1);
    expect(submitOnly).not.toHaveBeenCalled();
    expect(report.items[0]).toMatchObject({
      action: "auto_enter_verified",
      attribution: "collapsed_paste",
      deliveryAttemptId: "att-9",
    });
  });

  it("does not auto-Enter a collapsed paste without delivery attribution", async () => {
    panes.set(SEAT.session, idlePane("[Pasted text #3 +40 lines]"));
    const sweeper = build();
    await agePastGrace(sweeper);
    const report = await sweeper.sweep({ dryRun: false });
    expect(report.items[0]?.action).toBe("needs_human");
    expect(pressEnter).not.toHaveBeenCalled();
    expect(report.unresolved).toBe(true);
  });

  it("respects typing_guard refusal from submitOnly", async () => {
    panes.set(SEAT.session, idlePane(ENVELOPE));
    submitOnly.mockResolvedValue({ ok: false, reason: "typing_guard_enabled", error: "Typing guard prevents submit-only" });
    const sweeper = build();
    await agePastGrace(sweeper);
    const report = await sweeper.sweep({ dryRun: false });
    expect(report.items[0]).toMatchObject({ action: "skipped_typing_guard" });
    expect(report.unresolved).toBe(false);
  });

  it("retries Enter at most once when verification fails", async () => {
    panes.set(SEAT.session, idlePane(ENVELOPE));
    // Enter "succeeds" but the pane never clears.
    submitOnly.mockResolvedValue({ ok: true });
    const sweeper = build();
    await agePastGrace(sweeper);
    const report = await sweeper.sweep({ dryRun: false });
    expect(submitOnly.mock.calls.length).toBe(2); // first + one retry
    expect(report.items[0]).toMatchObject({ action: "auto_enter_failed", verified: false });
    expect(report.unresolved).toBe(true);
  });
});
