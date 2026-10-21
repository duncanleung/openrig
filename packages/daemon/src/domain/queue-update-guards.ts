/**
 * Queue update guards (RIG-114).
 *
 * The guard half of QueueRepository.updateInTransactionalContext(), moved out
 * verbatim and in the same order: append, state and wake coherence, reopen,
 * informational parks, field admission, and blocker shape. Each guard returns
 * `null` when the input passes, or a structured failure. The repository turns a
 * failure into `QueueRepositoryError(code, message, meta)`, the same way it
 * handles `validateClosure` (hot-potato-enforcer) and `validateHumanPark`
 * (human-route-enforcer).
 *
 * This module has no database access and no I/O. It is a leaf: it takes
 * `import type` from the repository only, so there is no import cycle. The
 * repository passes in the vocabulary it owns (`QueueGuardVocab`) and, for the
 * two checks that read another row, a `getBlocker` callback.
 *
 * Out of scope on purpose: claim(), unclaim() and handoff() guards;
 * validateClosure, validateHumanPark, the workflow-frontier predicate and the
 * retained claim blocker (they read history or other domains). The terminal
 * sets TERMINAL_QUEUE_STATES, ACTIVE_QUEUE_STATES and the guarded-terminal
 * test stay distinct and stay in the repository.
 */

import type { QueueUpdateInput } from "./queue-repository.js";
import { isHumanSeatSessionRef } from "./session-name.js";

export interface QueueGuardFailure {
  ok: false;
  code: string;
  message: string;
  meta: Record<string, unknown> | undefined;
}

function guardFail(code: string, message: string, meta?: Record<string, unknown>): QueueGuardFailure {
  return { ok: false, code, message, meta };
}

/** Vocabulary owned by queue-repository.ts, injected so this module stays a leaf. */
export interface QueueGuardVocab {
  queueStates: readonly string[];
  isBlockerLive: (state: string) => boolean;
  typedGateBlockerPrefix: (value: string) => string | null;
  isTypedGateBlocker: (value: unknown) => boolean;
}

/** The part of another row that the guards read. */
export interface QueueGuardBlocker {
  state: string;
  humanIntent?: string | null;
}
export type QueueGuardBlockerLookup = (qitemId: string) => QueueGuardBlocker | null | undefined;

/** A state-preserving append: only --note (and an optional same --state) is allowed. */
export function guardStatePreservingAppend(input: QueueUpdateInput, hasNote: boolean): QueueGuardFailure | null {
  if (input.state === undefined && !hasNote) {
    return guardFail(
      "state_or_note_required",
      "queue update requires --state or a non-empty --note; nothing was written",
    );
  }
  const disallowed = input.reopen === true
    || input.closureReason != null
    || input.closureTarget != null
    || input.handedOffTo != null
    || input.blockedOn != null
    || input.wakeWatchdogId != null
    || input.wakeAfterSeconds != null
    || input.wakeMaxSeconds != null
    || input.wakeProgressEvidence != null
    || input.wakeMessage != null
    || input.summary != null
    || input.evidenceRef != null;
  if (disallowed) {
    return guardFail(
      "note_append_fields_not_admitted",
      "a state-preserving note append accepts only --note (and an optional same --state); state-write fields were supplied, so nothing was written",
    );
  }
  return null;
}

/** State validity and park-wake option coherence, in the original first-failing order. */
export function guardStateAndWake(input: QueueUpdateInput, vocab: QueueGuardVocab): QueueGuardFailure | null {
  const QUEUE_STATES = vocab.queueStates;
  if (typeof input.state !== "string" || !QUEUE_STATES.includes(input.state)) {
    return guardFail(
      "invalid_state",
      `state=${input.state} not valid; valid: ${QUEUE_STATES.join(", ")}`
    );
  }
  if ((input.wakeWatchdogId != null || input.wakeAfterSeconds != null) && input.state !== "blocked") {
    return guardFail(
      "wake_not_admitted",
      "a park wake persists only with state=blocked; park the row or drop the wake option",
    );
  }
  if (input.wakeWatchdogId != null && input.wakeAfterSeconds != null) {
    return guardFail(
      "wake_ambiguous",
      "choose one explicit park wake: an existing watchdog id or an atomic timer",
    );
  }
  if (input.wakeAfterSeconds != null && (!Number.isInteger(input.wakeAfterSeconds) || input.wakeAfterSeconds <= 0)) {
    return guardFail(
      "wake_after_invalid",
      `wakeAfterSeconds must be a positive integer (got ${input.wakeAfterSeconds})`,
    );
  }
  if (input.wakeMessage != null && input.wakeAfterSeconds == null) {
    return guardFail(
      "wake_message_not_admitted",
      "wakeMessage is internal timer content and requires wakeAfterSeconds",
    );
  }
  if (input.wakeMaxSeconds != null && (input.wakeAfterSeconds == null || !Number.isInteger(input.wakeMaxSeconds) || input.wakeMaxSeconds < input.wakeAfterSeconds)) {
    return guardFail("wake_max_invalid", "wakeMaxSeconds requires an initial delay and must be an integer at least as large");
  }
  if (input.wakeMessage != null && input.wakeMessage.trim().length === 0) {
    return guardFail(
      "wake_message_invalid",
      "wakeMessage must be non-empty when supplied",
    );
  }
  return null;
}

/** Terminal-row reopen validation. `isReopen` is computed by the repository. */
export function guardReopen(
  input: QueueUpdateInput,
  qitem: { state: string },
  hasNote: boolean,
  isReopen: boolean,
  vocab: QueueGuardVocab,
): QueueGuardFailure | null {
  const { isBlockerLive } = vocab;
  if (isReopen && !input.reopen) {
    return guardFail(
      "terminal_reopen_requires_ack",
      `qitem ${input.qitemId} is currently '${qitem.state}'; state='${input.state}' would reopen a terminal row. Re-run deliberately with --reopen --note <reason>.`,
      { currentState: qitem.state, requestedState: input.state },
    );
  }
  // guardStateAndWake has already proved state is a valid QueueState (the original code narrowed it with isQueueState).
  if (isReopen && !isBlockerLive(input.state as string)) {
    return guardFail(
      "terminal_reopen_target_invalid",
      `qitem ${input.qitemId} is currently '${qitem.state}'; --reopen requires an active target state (pending, in-progress, or blocked), not '${input.state}'.`,
      { currentState: qitem.state, requestedState: input.state },
    );
  }
  if (isReopen && !hasNote) {
    return guardFail(
      "reopen_note_required",
      `qitem ${input.qitemId} is currently '${qitem.state}'; deliberate reopen requires --note <reason> so the repair is auditable.`,
      { currentState: qitem.state, requestedState: input.state },
    );
  }
  if (input.reopen && !isReopen) {
    return guardFail(
      "reopen_not_applicable",
      `--reopen applies only when moving a terminal row to an active state; qitem ${input.qitemId} is currently '${qitem.state}'.`,
      { currentState: qitem.state, requestedState: input.state },
    );
  }
  return null;
}

/**
 * Informational (human_intent=update) rows cannot be approval dependencies.
 * `getBlocker` stays lazy: it runs only when state is blocked and a blocker is set.
 */
export function guardInformationalPark(
  input: QueueUpdateInput,
  qitem: { humanIntent?: string | null },
  effectiveBlockedOn: string | null,
  getBlocker: QueueGuardBlockerLookup,
): QueueGuardFailure | null {
  if (input.state === "blocked" && effectiveBlockedOn && getBlocker(effectiveBlockedOn)?.humanIntent === "update") {
    return guardFail("invalid_human_notification", "An informational update is not an approval dependency. Create a separate decision request if a human decision is needed.");
  }
  if (qitem.humanIntent === "update" && input.state === "blocked" && isHumanSeatSessionRef(effectiveBlockedOn ?? "")) {
    return guardFail("invalid_human_notification", "An informational delivery cannot become a human approval park; author a separate decision request.");
  }
  return null;
}

/** Summary and evidence admission, then closure-field and blocked-on coherence. */
export function guardFieldAdmission(input: QueueUpdateInput, isHumanPark: boolean): QueueGuardFailure | null {
  // OPR.0.5.1 slice-51-06 D2 — summary/evidence_ref are persist-able ONLY at a human-seat park
  // (see the FR-6 note below). Silently ignoring them on any other transition is a data-loss trap
  // (the operator believes the metadata was saved). HARD-REJECT before ANY UPDATE/log/event so the
  // caller learns immediately and nothing is half-applied. null/undefined = absent (allowed);
  // empty string = present (a deliberate value → rejected on a non-park transition).
  if (!isHumanPark) {
    const invalidFields: Array<"summary" | "evidenceRef"> = [];
    if (input.summary != null) invalidFields.push("summary");
    if (input.evidenceRef != null) invalidFields.push("evidenceRef");
    if (invalidFields.length > 0) {
      const flags = invalidFields.map((f) => (f === "summary" ? "--summary" : "--evidence-ref")).join(" / ");
      return guardFail(
        "summary_evidence_not_persistable",
        `${invalidFields.join(" + ")} persist only on a human-seat park (state=blocked on a human seat); the '${input.state}' transition cannot store them. Remove ${flags}, or park the item (rig queue block --on <human-seat> --summary … --evidence-ref …).`,
        { invalidFields },
      );
    }
  }

  // SWEEP-a (shape f2576102) — closure/blocked-field COHERENCE, beside the reference
  // reject above: an incoherent field must never silently persist (worse than a drop —
  // the COALESCE below would write it). Admits-map, derived from LIVE schema use:
  //   closure_reason/closure_target → state "done", OR the PARK-RECORD form
  //     (state "blocked" with closureReason "blocked_on" — the workflow gate/park
  //     writers' established shape, workflow-runtime.ts:587/1013);
  //   blocked_on → state "blocked" only.
  const isParkRecord = input.state === "blocked" && input.closureReason === "blocked_on";
  // Third live form (found by the neighborhood suites): the transactional handoff
  // closes its source as state "handed-off" with closureReason "handed_off_to".
  const isHandoffClose = input.state === "handed-off" && input.closureReason === "handed_off_to";
  // 0.5.1-53 Atom 2a — FOURTH admitted form: the supersession-cancel. A row corrected by
  // cancel-and-replace records state=canceled + closureReason=superseded + closureTarget=<successor>,
  // so superseded is distinguishable from abandoned (a plain cancel keeps closureReason=null).
  const isSupersedeCancel = input.state === "canceled" && input.closureReason === "superseded";
  if (input.state !== "done" && !isParkRecord && !isHandoffClose && !isSupersedeCancel && (input.closureReason != null || input.closureTarget != null)) {
    return guardFail(
      "closure_fields_not_admitted",
      `closure_reason/closure_target persist only on state=done, the blocked park-record form, the handoff close, or the superseded cancel; the '${input.state}' transition cannot store them. Close the item (--state done --closure-reason …) or drop the flags.`,
      {},
    );
  }
  // A supersession must name WHAT replaced this row — fail LOUD before any write (never a silent
  // no-op leaving a stale row, the dead-signal class), symmetric with handed_off_to's target rule.
  if (isSupersedeCancel && !input.closureTarget) {
    return guardFail(
      "missing_closure_target",
      `closure_reason=superseded requires closure_target (the successor qitem that replaced this row).`,
      {},
    );
  }
  if (input.blockedOn != null && input.state !== "blocked") {
    return guardFail(
      "blocked_on_not_admitted",
      `blocked_on persists only on state=blocked; the '${input.state}' transition cannot store it. Park the item (rig queue block --on …) or drop --blocked-on.`,
      {},
    );
  }
  return null;
}

/** Blocker shape at the park moment: a qitem blocker must exist and be live; a typed gate needs a body. */
export function guardBlocker(
  input: QueueUpdateInput,
  isHumanPark: boolean,
  effectiveBlockedOn: string | null,
  getBlocker: QueueGuardBlockerLookup,
  vocab: QueueGuardVocab,
): QueueGuardFailure | null {
  const { isBlockerLive, typedGateBlockerPrefix, isTypedGateBlocker } = vocab;
  // 0.5.1-53 Atom 1b(ii) + 1a — blocker validation at the park moment. Non-human blocker kinds:
  //   qitem-ref ("qitem-…")        → must EXIST and be LIVE (1b-ii); a ghost or dead blocker never lifts.
  //   typed gate (fold:/auth:/…)   → first-class (1a), but a bare prefix with no gate body is malformed
  //                                   (a typo must not masquerade as a gate).
  //   anything else (legacy gate-name) → left as-is; out of this slice.
  // Human-seat parks (isHumanPark) enforce their own FR-6 contract above.
  if (input.state === "blocked" && !isHumanPark && typeof effectiveBlockedOn === "string") {
    if (effectiveBlockedOn.startsWith("qitem-")) {
      const blocker = getBlocker(effectiveBlockedOn);
      if (!blocker) {
        return guardFail(
          "blocker_not_found",
          `blocked_on names a qitem that does not exist on this daemon: ${effectiveBlockedOn}. A qitem absent from this daemon cannot be a live blocker here. If it is stored on another host, use a typed gate such as external:<host>/<id> with --wake-watchdog or --wake-after.`,
          // F1 (error-honesty): the rejected value is named rejectedBlocker — an error payload
          // never carries the success-shaped blockedOn field (the field-filtered-misread class).
          { rejectedBlocker: effectiveBlockedOn },
        );
      }
      if (!isBlockerLive(blocker.state)) {
        return guardFail(
          "blocker_not_live",
          `blocked_on names a resolved qitem: ${effectiveBlockedOn} is '${blocker.state}'. A park must name a LIVE blocker — parking on a completed/closed row is a dead-blocker park that never self-clears.`,
          { rejectedBlocker: effectiveBlockedOn, blockerState: blocker.state },
        );
      }
    } else {
      const typedPrefix = typedGateBlockerPrefix(effectiveBlockedOn);
      if (typedPrefix && !isTypedGateBlocker(effectiveBlockedOn)) {
        return guardFail(
          "blocker_malformed",
          `blocked_on '${effectiveBlockedOn}' is a bare '${typedPrefix}' prefix with no gate body. A typed gate blocker must name its gate (e.g. fold:one-home+attestation).`,
          { rejectedBlocker: effectiveBlockedOn },
        );
      }
    }
  }
  return null;
}
