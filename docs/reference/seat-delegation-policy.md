# Seat delegation policy for the openrig rig (RIG-129)

## Purpose

The orchestrator (`orch-lead`) must send work to seats. Work done inline fills its context window.
The window is the scarce resource: RIG-128 measured an 83K baseline after compaction. This policy
maps each work type to a seat and states what the orchestrator keeps.

## Audit evidence (2026-10-23)

| Seat | State | Evidence |
|---|---|---|
| `orch-lead` | working | Holds the factory-loop queue item (`parked`, RIG-127). Runs the state machine and the merge gate. |
| `dev-impl` | working | Runs `/ticket-loop` for every ticket (9 session logs in the wiki). |
| `quality-reviewer` | idle between reviews | Runs `/code-review-dual` for every PR (4 session logs). |
| `orch-advisor` | idle | Is `advisor_seat` in `.factory.yml`. Gets work only when the orchestrator sends it. No standing work type. |
| `dev-memory` | idle | `cwd` is `~/Documents/Develop/openrig-memory`. Not in `.factory.yml`. No delegated work found. |

Queue check: `rig queue list --destination <seat>@openrig --limit 50 --json` returns `[]` for
`orch-advisor`, `dev-impl`, `dev-memory` and `quality-reviewer`. Only `orch-lead` has an item. The
default listing may hide closed rows, so "never used" is not established. Dispatch to the seats
goes through `rig send`, which leaves no durable record of the dispatch.

Inline work seen in orch-lead session logs (from the ticket enrichment, not re-verified here):
phase gate run inline with Codex when the advisor seat was unavailable (`2026-10-22`), `/ticket-enrich`
for three tickets run inline (`2026-10-21`), and `/wiki-update` at wrap-up.

RIG-128 (PR #80, merged) removes the first two: the factory-loop skill now dispatches the gate and
enrichment to the advisor seat and blocks and retries when the seat is missing.

## Policy

| Work type | Seat | Dispatch | Orchestrator keeps |
|---|---|---|---|
| Implementation (`/ticket-loop`) | `dev-impl` | `rig send`, park (`PHASE=implement`) | State machine, `TICKET_LOOP_RESULT` parse |
| PR review (`/code-review-dual`, `/code-review-validate-findings`) | `quality-reviewer` | `rig send`, park (`PHASE=review`) | `REVIEW_RESULT` parse |
| Phase gate (`/phase-gate`) | `orch-advisor` | `rig send`, park (`PHASE=validate`) | `GATE_RESULT` parse |
| Ticket enrichment (`/ticket-enrich`, `/codex-second-opinion`) | `orch-advisor` | `rig send`, park (`PHASE=enrich`) | `ENRICH_RESULT` parse |
| Research and design debate (`/deep-research-plus`, `/symmetric-debate`) | `orch-advisor` | `rig send` with a result line | One-line result |
| Wiki curation at wrap-up (`/wiki-update`) | `orch-advisor` | `rig send` with the session summary | Nothing. Do not run it inline. |
| `openrig-memory` repo work | `dev-memory` | `rig send` | One-line result |
| Merge gate, queue state, human escalation | `orch-lead` | n/a | Everything |

Rules:

1. The orchestrator does not call the `Skill` tool for a skill in this table (RIG-128).
2. A dispatch always carries a result format and a return address, and the orchestrator parks the
   queue item (RIG-127) until the result arrives.
3. When the target seat is missing, the orchestrator blocks and retries. It does not run the skill
   inline.
4. Each seat reports one line. Plans, diffs and findings stay in the seat.

## Decision for the operator: `dev-memory`

The enrichment recommends removing `dev-memory` from the topology. This change does not do that.
Reasons:

- The rig spec is outside this repository, and a seat removal loses the seat's lineage.
- A standing operator directive (auto-memory `project_dev-memory-seat.md`, 2026-10-01) routes
  `openrig-memory` work to this seat.
- The enrichment says the seat has been idle since 2026-10-18. The memory note says it joined on
  2026-10-01. The first date is not verified.

| Option | Trade-off |
|---|---|
| Keep, with a defined workload (`openrig-memory` work from the policy table) | No topology change. Costs one idle seat until work exists. |
| Remove | Simpler topology. Recreating the seat later loses lineage. Needs a rig spec change and a memory update. |

Recommendation: keep it until the operator confirms that `openrig-memory` work has stopped. Then
remove it with `rig down`/spec edit and delete the memory note in the same change.

## Not done

- No pre/post context measurement. That needs a factory run on the merged RIG-128 skill. Use the
  RIG-126 script on the next run.
- No change to `.factory.yml`, the rig spec or `CLAUDE.md`.
- No change to dispatch mechanics. `rig send` stays the dispatch path. Making the queue the
  primary dispatch path (a durable audit trail) is a separate decision.
