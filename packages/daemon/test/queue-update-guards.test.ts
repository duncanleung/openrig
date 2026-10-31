// RIG-114: pins the guard half of QueueRepository.update() — codes, first-failing
// order and meta shape — on the pure functions, with no database. The repository
// tests (queue-repository, queue-park-wake, queue-blocker-refusal-shape, ...)
// pin the same behavior end to end; these tests catch a dropped or reordered guard
// at the source.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import {
  guardBlocker,
  guardFieldAdmission,
  guardInformationalPark,
  guardReopen,
  guardStateAndWake,
  guardStatePreservingAppend,
  type QueueGuardVocab,
} from "../src/domain/queue-update-guards.js";
import {
  QUEUE_STATES,
  QueueRepository,
  QueueRepositoryError,
  isBlockerLive,
  isTypedGateBlocker,
  typedGateBlockerPrefix,
  type QueueUpdateInput,
} from "../src/domain/queue-repository.js";

const vocab: QueueGuardVocab = {
  queueStates: QUEUE_STATES,
  isBlockerLive,
  typedGateBlockerPrefix,
  isTypedGateBlocker,
};

const base = (over: Partial<QueueUpdateInput> = {}): QueueUpdateInput => ({
  qitemId: "qitem-1",
  actorSession: "dev-impl@openrig",
  ...over,
});

describe("guardStatePreservingAppend", () => {
  it("requires --state, a note, or a valid summary", () => {
    const f = guardStatePreservingAppend(base(), false, false);
    expect(f).toMatchObject({ ok: false, code: "state_or_note_required", meta: undefined });
  });

  it("passes a note-only append", () => {
    expect(guardStatePreservingAppend(base({ transitionNote: "n" }), true, false)).toBeNull();
  });

  it("passes a valid summary alone as a state-preserving append", () => {
    expect(guardStatePreservingAppend(base({ summary: "s" }), false, true)).toBeNull();
  });

  it.each([
    ["reopen", { reopen: true }],
    ["closureReason", { closureReason: "no-follow-on" }],
    ["closureTarget", { closureTarget: "x" }],
    ["handedOffTo", { handedOffTo: "x" }],
    ["blockedOn", { blockedOn: "x" }],
    ["wakeWatchdogId", { wakeWatchdogId: "w" }],
    ["wakeAfterSeconds", { wakeAfterSeconds: 60 }],
    ["wakeMaxSeconds", { wakeMaxSeconds: 60 }],
    ["wakeProgressEvidence", { wakeProgressEvidence: {} }],
    ["wakeMessage", { wakeMessage: "m" }],
    ["evidenceRef", { evidenceRef: "e" }],
  ] as const)("refuses state-write field %s", (_name, over) => {
    const f = guardStatePreservingAppend(base({ transitionNote: "n", ...over }), true, false);
    expect(f?.code).toBe("note_append_fields_not_admitted");
    expect(f?.meta).toBeUndefined();
  });

  it("checks the state/note/summary check before the disallowed fields", () => {
    // nothing provided (no state, no note, no valid summary) wins over a disallowed field present
    const f = guardStatePreservingAppend(base({ evidenceRef: "e" }), false, false);
    expect(f?.code).toBe("state_or_note_required");
  });
});

describe("guardStateAndWake", () => {
  it("rejects an unknown state and lists the valid ones", () => {
    const f = guardStateAndWake(base({ state: "bogus" as never }), vocab);
    expect(f?.code).toBe("invalid_state");
    expect(f?.message).toBe(`state=bogus not valid; valid: ${QUEUE_STATES.join(", ")}`);
    expect(f?.meta).toBeUndefined();
  });

  it("rejects a missing state", () => {
    expect(guardStateAndWake(base(), vocab)?.code).toBe("invalid_state");
  });

  it("passes a plain valid state", () => {
    expect(guardStateAndWake(base({ state: "done" }), vocab)).toBeNull();
  });

  it("keeps the wake checks in the original order", () => {
    const cases: Array<[Partial<QueueUpdateInput>, string]> = [
      [{ state: "pending", wakeAfterSeconds: 60 }, "wake_not_admitted"],
      [{ state: "pending", wakeWatchdogId: "w" }, "wake_not_admitted"],
      [{ state: "blocked", wakeWatchdogId: "w", wakeAfterSeconds: 60 }, "wake_ambiguous"],
      [{ state: "blocked", wakeAfterSeconds: 0 }, "wake_after_invalid"],
      [{ state: "blocked", wakeAfterSeconds: 1.5 }, "wake_after_invalid"],
      [{ state: "blocked", wakeMessage: "m" }, "wake_message_not_admitted"],
      [{ state: "blocked", wakeAfterSeconds: 60, wakeMaxSeconds: 30 }, "wake_max_invalid"],
      [{ state: "blocked", wakeMaxSeconds: 60 }, "wake_max_invalid"],
      [{ state: "blocked", wakeAfterSeconds: 60, wakeMessage: "   " }, "wake_message_invalid"],
    ];
    for (const [over, code] of cases) {
      expect(guardStateAndWake(base(over), vocab)?.code, JSON.stringify(over)).toBe(code);
    }
  });

  it("reports wake_not_admitted before wake_ambiguous and wake_after_invalid", () => {
    const f = guardStateAndWake(base({ state: "pending", wakeWatchdogId: "w", wakeAfterSeconds: -1 }), vocab);
    expect(f?.code).toBe("wake_not_admitted");
  });

  it("reports wake_ambiguous before wake_after_invalid", () => {
    const f = guardStateAndWake(base({ state: "blocked", wakeWatchdogId: "w", wakeAfterSeconds: -1 }), vocab);
    expect(f?.code).toBe("wake_ambiguous");
  });

  it("admits a valid timer wake", () => {
    expect(guardStateAndWake(base({ state: "blocked", wakeAfterSeconds: 60, wakeMaxSeconds: 120, wakeMessage: "m" }), vocab)).toBeNull();
  });
});

describe("guardReopen", () => {
  const meta = (cur: string, req: string) => ({ currentState: cur, requestedState: req });

  it("requires the reopen acknowledgment, with meta", () => {
    const f = guardReopen(base({ state: "pending" }), { state: "done" }, true, true, vocab);
    expect(f?.code).toBe("terminal_reopen_requires_ack");
    expect(f?.meta).toEqual(meta("done", "pending"));
    expect(f?.message).toContain("Re-run deliberately with --reopen --note <reason>.");
  });

  it("rejects a non-active reopen target, with meta", () => {
    const f = guardReopen(base({ state: "failed", reopen: true }), { state: "done" }, true, true, vocab);
    expect(f?.code).toBe("terminal_reopen_target_invalid");
    expect(f?.meta).toEqual(meta("done", "failed"));
  });

  it("requires a note on a reopen, with meta", () => {
    const f = guardReopen(base({ state: "pending", reopen: true }), { state: "done" }, false, true, vocab);
    expect(f?.code).toBe("reopen_note_required");
    expect(f?.meta).toEqual(meta("done", "pending"));
  });

  it("rejects --reopen on a row that is not terminal, with meta", () => {
    const f = guardReopen(base({ state: "blocked", reopen: true }), { state: "pending" }, true, false, vocab);
    expect(f?.code).toBe("reopen_not_applicable");
    expect(f?.meta).toEqual(meta("pending", "blocked"));
  });

  it("keeps the ack, target, note, applicable order", () => {
    // no ack, bad target and no note: the ack error wins
    expect(guardReopen(base({ state: "failed" }), { state: "done" }, false, true, vocab)?.code).toBe("terminal_reopen_requires_ack");
    // ack given, bad target and no note: the target error wins
    expect(guardReopen(base({ state: "failed", reopen: true }), { state: "done" }, false, true, vocab)?.code).toBe("terminal_reopen_target_invalid");
  });

  it("passes a deliberate reopen and a plain non-terminal update", () => {
    expect(guardReopen(base({ state: "pending", reopen: true }), { state: "done" }, true, true, vocab)).toBeNull();
    expect(guardReopen(base({ state: "in-progress" }), { state: "pending" }, false, false, vocab)).toBeNull();
  });
});

describe("guardInformationalPark", () => {
  it("rejects a park on an informational blocker row", () => {
    const f = guardInformationalPark(base({ state: "blocked" }), {}, "qitem-9", () => ({ state: "pending", humanIntent: "update" }));
    expect(f?.code).toBe("invalid_human_notification");
    expect(f?.message).toBe("An informational update is not an approval dependency. Create a separate decision request if a human decision is needed.");
    expect(f?.meta).toBeUndefined();
  });

  it("rejects an informational row that parks on a human seat", () => {
    const f = guardInformationalPark(base({ state: "blocked" }), { humanIntent: "update" }, "human-duncan@kernel", () => null);
    expect(f?.code).toBe("invalid_human_notification");
    expect(f?.message).toBe("An informational delivery cannot become a human approval park; author a separate decision request.");
  });

  it("looks the blocker up only when state is blocked and a blocker is set", () => {
    let calls = 0;
    const lookup = () => { calls += 1; return null; };
    guardInformationalPark(base({ state: "pending" }), {}, "qitem-9", lookup);
    guardInformationalPark(base({ state: "blocked" }), {}, null, lookup);
    expect(calls).toBe(0);
    guardInformationalPark(base({ state: "blocked" }), {}, "qitem-9", lookup);
    expect(calls).toBe(1);
  });

  it("passes a decision park", () => {
    expect(guardInformationalPark(base({ state: "blocked" }), { humanIntent: "decision" }, "qitem-9", () => ({ state: "pending", humanIntent: "decision" }))).toBeNull();
  });
});

describe("guardFieldAdmission", () => {
  it("rejects summary off a non-human-park done close; evidenceRef is allowed on done close", () => {
    const f = guardFieldAdmission(base({ state: "done", summary: "s", evidenceRef: "e" }), false, true);
    expect(f?.code).toBe("summary_evidence_not_persistable");
    expect(f?.meta).toEqual({ invalidFields: ["summary"] });
    expect(f?.message).toContain("--summary");
  });

  it("allows evidenceRef alone on a done close", () => {
    expect(guardFieldAdmission(base({ state: "done", evidenceRef: "e" }), false, true)).toBeNull();
  });

  it("rejects evidenceRef on a non-human-park non-done state", () => {
    const f = guardFieldAdmission(base({ state: "in-progress", evidenceRef: "e" }), false, false);
    expect(f?.code).toBe("summary_evidence_not_persistable");
    expect(f?.meta).toEqual({ invalidFields: ["evidenceRef"] });
  });

  it("allows summary and evidence on a human park", () => {
    expect(guardFieldAdmission(base({ state: "blocked", summary: "s", evidenceRef: "e", blockedOn: "human-d@kernel" }), true, false)).toBeNull();
  });

  it("rejects closure fields on a state that cannot store them, with an empty meta object", () => {
    const f = guardFieldAdmission(base({ state: "pending", closureReason: "no-follow-on" }), false, false);
    expect(f?.code).toBe("closure_fields_not_admitted");
    expect(f?.meta).toEqual({});
  });

  it.each([
    ["done", { closureReason: "no-follow-on" }, true],
    ["blocked", { closureReason: "blocked_on", closureTarget: "qitem-9" }, false],
    ["handed-off", { closureReason: "handed_off_to", closureTarget: "x" }, false],
    ["canceled", { closureReason: "superseded", closureTarget: "qitem-9" }, false],
  ] as const)("admits the closure form for state %s", (state, over, isDoneClose) => {
    expect(guardFieldAdmission(base({ state, ...over }), false, isDoneClose)).toBeNull();
  });

  it("requires a successor for a superseded cancel, with an empty meta object", () => {
    const f = guardFieldAdmission(base({ state: "canceled", closureReason: "superseded" }), false, false);
    expect(f?.code).toBe("missing_closure_target");
    expect(f?.meta).toEqual({});
  });

  it("rejects blockedOn off a blocked state, with an empty meta object", () => {
    const f = guardFieldAdmission(base({ state: "pending", blockedOn: "x" }), false, false);
    expect(f?.code).toBe("blocked_on_not_admitted");
    expect(f?.meta).toEqual({});
  });

  it("keeps the summary, closure, supersede, blocked_on order", () => {
    const all = base({ state: "pending", summary: "s", closureReason: "no-follow-on", blockedOn: "x" });
    expect(guardFieldAdmission(all, false, false)?.code).toBe("summary_evidence_not_persistable");
    expect(guardFieldAdmission({ ...all, summary: undefined }, false, false)?.code).toBe("closure_fields_not_admitted");
    expect(guardFieldAdmission({ ...all, summary: undefined, closureReason: undefined }, false, false)?.code).toBe("blocked_on_not_admitted");
  });
});

describe("guardBlocker", () => {
  const live = () => ({ state: "pending" });

  it("does nothing off a blocked state, on a human park, or with no blocker", () => {
    expect(guardBlocker(base({ state: "pending" }), false, "qitem-9", () => null, vocab)).toBeNull();
    expect(guardBlocker(base({ state: "blocked" }), true, "qitem-9", () => null, vocab)).toBeNull();
    expect(guardBlocker(base({ state: "blocked" }), false, null, () => null, vocab)).toBeNull();
  });

  it("rejects a qitem blocker that does not exist, naming rejectedBlocker", () => {
    const f = guardBlocker(base({ state: "blocked" }), false, "qitem-9", () => null, vocab);
    expect(f?.code).toBe("blocker_not_found");
    expect(f?.meta).toEqual({ rejectedBlocker: "qitem-9" });
  });

  it("rejects a qitem blocker that is not live, naming its state", () => {
    const f = guardBlocker(base({ state: "blocked" }), false, "qitem-9", () => ({ state: "done" }), vocab);
    expect(f?.code).toBe("blocker_not_live");
    expect(f?.meta).toEqual({ rejectedBlocker: "qitem-9", blockerState: "done" });
  });

  it("rejects a bare typed-gate prefix", () => {
    const f = guardBlocker(base({ state: "blocked" }), false, "fold:", live, vocab);
    expect(f?.code).toBe("blocker_malformed");
    expect(f?.meta).toEqual({ rejectedBlocker: "fold:" });
    expect(f?.message).toContain("bare 'fold:' prefix");
  });

  it("admits a live qitem, a well-formed typed gate and a legacy gate name", () => {
    expect(guardBlocker(base({ state: "blocked" }), false, "qitem-9", live, vocab)).toBeNull();
    expect(guardBlocker(base({ state: "blocked" }), false, "fold:one-home", live, vocab)).toBeNull();
    expect(guardBlocker(base({ state: "blocked" }), false, "some-gate", live, vocab)).toBeNull();
  });
});

describe("failure to error mapping", () => {
  it("QueueRepositoryError carries the code, message and meta of a guard failure", () => {
    const f = guardReopen(base({ state: "pending" }), { state: "done" }, true, true, vocab);
    expect(f).not.toBeNull();
    const e = new QueueRepositoryError(f!.code, f!.message, f!.meta);
    expect(e.code).toBe("terminal_reopen_requires_ack");
    expect(e.meta).toEqual({ currentState: "done", requestedState: "pending" });
  });
});

// The repository wiring: each guard is called, in the original order between stages,
// and a failure surfaces as a QueueRepositoryError with the guard's code and meta.
describe("QueueRepository.update wiring", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
  });
  afterEach(() => db.close());

  async function newRow(): Promise<string> {
    return (await repo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "x" })).qitemId;
  }
  function refusal(input: QueueUpdateInput): QueueRepositoryError {
    try {
      repo.update(input);
    } catch (err) {
      expect(err).toBeInstanceOf(QueueRepositoryError);
      return err as QueueRepositoryError;
    }
    throw new Error("expected a refusal");
  }

  it("surfaces the append guards", async () => {
    const id = await newRow();
    expect(refusal({ qitemId: id, actorSession: "a@r" }).code).toBe("state_or_note_required");
    // evidenceRef is disallowed on state-preserving appends (summary with a note is allowed)
    expect(refusal({ qitemId: id, actorSession: "a@r", transitionNote: "n", evidenceRef: "e" }).code).toBe("note_append_fields_not_admitted");
  });

  it("surfaces the state and wake guards before the reopen and field guards", async () => {
    const id = await newRow();
    expect(refusal({ qitemId: id, actorSession: "a@r", state: "bogus" as never }).code).toBe("invalid_state");
    // wake_not_admitted wins over blocked_on_not_admitted and summary_evidence_not_persistable
    expect(refusal({ qitemId: id, actorSession: "a@r", state: "pending", wakeAfterSeconds: 60, blockedOn: "x", summary: "s" }).code).toBe("wake_not_admitted");
  });

  it("surfaces the reopen guards with their meta", async () => {
    const id = await newRow();
    repo.update({ qitemId: id, actorSession: "a@r", state: "done", closureReason: "no-follow-on", transitionNote: "closed" });
    const e = refusal({ qitemId: id, actorSession: "a@r", state: "pending" });
    expect(e.code).toBe("terminal_reopen_requires_ack");
    expect(e.meta).toEqual({ currentState: "done", requestedState: "pending" });
  });

  it("runs the closure check after the reopen guards and before the field guards", async () => {
    const id = await newRow();
    // state=done with no closure reason: validateClosure answers, not a field guard
    expect(refusal({ qitemId: id, actorSession: "a@r", state: "done", blockedOn: "x" }).code).toBe("missing_closure_reason");
  });

  it("surfaces the field-admission guards before the blocker guards", async () => {
    const id = await newRow();
    // blocked_on_not_admitted needs state != blocked; closure_fields_not_admitted comes first
    expect(refusal({ qitemId: id, actorSession: "a@r", state: "pending", closureReason: "no-follow-on", blockedOn: "x" }).code).toBe("closure_fields_not_admitted");
    // summary on a non-human park wins over a malformed blocker
    expect(refusal({ qitemId: id, actorSession: "a@r", state: "blocked", blockedOn: "fold:", summary: "s" }).code).toBe("summary_evidence_not_persistable");
  });

  it("surfaces the blocker guards", async () => {
    const id = await newRow();
    const e = refusal({ qitemId: id, actorSession: "a@r", state: "blocked", blockedOn: "fold:", transitionNote: "park" });
    expect(e.code).toBe("blocker_malformed");
    expect(e.meta).toEqual({ rejectedBlocker: "fold:" });
  });

  it("surfaces the informational-park guard", async () => {
    const decision = await newRow();
    const info = await newRow();
    // create() admits humanIntent only for a human destination; mark the row directly.
    db.prepare("UPDATE queue_items SET human_intent = 'update' WHERE qitem_id = ?").run(info);
    expect(refusal({ qitemId: decision, actorSession: "a@r", state: "blocked", blockedOn: info, transitionNote: "park" }).code).toBe("invalid_human_notification");
  });
});
