---
id: ADR-0008
title: Third-party risk classifier in the merge path runs in shadow mode first
status: proposed
date: 2026-10-15
tags: [factory, merge-policy, classifier, security, third-party]
supersedes: []
related: [ADR-0006]
---

## Context

The ticket factory classifies each PR with rule-based buckets (AUTO, ADJUDICATE_LIGHT,
ADJUDICATE_HEAVY, ESCALATE). RIG-97 adds a second opinion from the TypeSafe AI System One API
("Jev"), a calibrated classifier that returns a risk class and an `auto_merge_safe` score between
0 and 1. The ticket proposes a `merge_policy: auto-jev` that would auto-merge when the score passes
a threshold.

A hosted classifier in the merge path creates three risks. First, a wrong high score can merge
unsafe code. Second, PR metadata leaves the machine. Third, the vendor API is new: its SDK is
pre-1.0, we have no calibration data for our PRs, and we have not verified two facts: whether the
API accepts the model id `jev-1.13` (the vendor docs show `jev-latest` and report versioned ids such
as `jev-1.13.0`), and the vendor's data-retention terms.

## Decision

1. **Shadow first.** `merge_policy: auto-jev` is a valid value. Its effective policy is
   `human-approval` with the reason `auto-jev: shadow mode`. No code path treats `auto-jev` as
   auto-merge. The Jev verdict is reported next to the rule-based bucket and never gates a merge.
2. **Direct HTTP, no SDK.** The client uses global `fetch` with an `AbortController` timeout. It adds
   no dependency. It never retries, never throws, and returns `null` on any failure.
3. **Redacted summary only.** The payload holds file paths, per-file add/delete counts, file kinds,
   totals, the test-file ratio, and the rule bucket. It holds no source text, diff hunks, or commit
   messages. The whole object passes through `redactDigestValue` (RIG-60) before it leaves the process.
4. **ESCALATE floor.** A rule-based ESCALATE bucket always wins. The Jev score can never lower it.
5. **`merge_gate: all` wins.** The existing precedence stays first: when the gate is `all`, every
   merge needs a human, whatever the merge policy says.
6. **No gating until calibration.** Gating requires data that compares Jev verdicts with human merge
   decisions on our PRs. A new ADR that supersedes this one must record that data and the threshold.
7. **Key handling.** A human provisions `TYPESAFE_API_KEY`. The code reads it from the environment,
   makes no network call when it is missing, and never logs it or puts it in an error message.

## Rejected Alternatives

- **Gate on the score from day one.** Rejected. We have no calibration data, and a false "safe"
  verdict merges unsafe code.
- **Use `@typesafe-ai/sdk`.** Rejected. The SDK is pre-1.0 and pulls transitive dependencies into the
  daemon. One POST does not justify them.
- **Send the diff for better accuracy.** Rejected. Source text can hold secrets and proprietary code.
  Redaction patterns do not catch all of them.
- **Let the Jev score downgrade an ESCALATE bucket.** Rejected. The rule-based floor covers
  irreversible areas (migrations, gateway, security keywords) that a score must not override.

## Rationale

Shadow mode costs one config value and gives the evidence needed to decide on gating. The redacted
summary limits the leak surface to path names, which the redactor also scrubs. Direct HTTP keeps the
dependency surface unchanged and keeps failure handling in one small function.

## Consequences

- `auto-jev` behaves like `human` for merging until a superseding ADR changes it.
- Each classification call sends path names to a third party. Repos with sensitive path names need
  review before the skill calls the classifier.
- The skill-side wiring is a separate ticket. This change adds no route and no startup wiring.
- The default model id `jev-1.13` is a config value (`jev.model` in `.factory.yml`). If the API
  rejects it, the client returns `null` and the factory continues unchanged.

## Revisit Triggers

- Calibration data exists that compares verdicts to human merge decisions on at least a few dozen PRs.
- The vendor retention terms are verified, or they change.
- The API rejects `jev-1.13`, or the vendor changes the response shape or releases a stable SDK.
- Someone proposes sending more than paths and counts to the vendor.
