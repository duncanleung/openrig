# Factory-loop: dispatch skills to seats, never load them in the orchestrator (RIG-128)

## Problem

After compaction and restore, the orch-lead session starts at 83K tokens. That is 41.6% of the
200K compaction threshold. The orchestrator then has about 100K tokens of working room, and
orchestrator work (rig commands, seat management, reviews) uses it in 3-5 turns.

Measured 2026-10-22 on session `f89aa0b9`, post-compact turn at index 9029 (83,210 tokens):

| Part | Tokens |
|---|---|
| Compaction summary | ~20-25K |
| Skills retained from earlier windows | ~45-50K |
| CLAUDE.md files (project, user, root) | ~8-10K |
| Memory index, git status, environment, hook definitions | ~3-5K |

Eight skills persist through compaction: `factory-loop`, `codex-second-opinion`, `ticket-enrich`,
`phase-gate`, `loop`, `deep-research-plus`, `code-review-dual`, `ask-user-question`.

## Cause

Measurement shows that skill bodies enter the orchestrator through explicit `Skill()` calls. Text
that only mentions a skill name does not load it. Four explicit loads are removable:

| Skill | Full body (tokens) | Load path today | After this change |
|---|---|---|---|
| `phase-gate` | 3,813 | `Skill(phase-gate)` in Step 2e | `rig send` to the advisor seat |
| `code-review-dual` | 12,970 | Direct `Skill()` call, and the single-seat review fallback | `rig send` to the review seat only |
| `ticket-enrich` | 2,568 | `Skill(ticket-enrich)` by the orchestrator | `rig send` to the advisor seat |
| `codex-second-opinion` | 3,192 | Loaded inside `ticket-enrich` validate mode | Runs in the advisor seat with `ticket-enrich` |

The four bodies total 22,543 tokens at full size. The ticket estimates 10-20K of saved baseline
after compaction truncation, because compaction already truncates `factory-loop` and
`code-review-dual`.

## Change

The skill diff (`factory-loop-dispatch-rewrite-skill.diff`) makes four changes to
`~/.claude/skills/factory-loop/SKILL.md`:

1. **Step 2e dispatches the gate with `rig send`.** The orchestrator sends the
   `/phase-gate boundary=post-implement ...` request to the advisor seat, parks the queue item
   (`PHASE=validate`, as in RIG-127), and parses `GATE_RESULT`. The brief carries the exact
   `GATE_RESULT` format. The advisor seat runs `/phase-gate` in its own context.
2. **Enrichment follows the same rule.** The orchestrator sends `/ticket-enrich ${TICKET_ID}` to
   the advisor seat (`PHASE=enrich`). `/codex-second-opinion` runs there as part of it.
3. **Inline fallbacks become block and retry.** The implement, advisor and review dispatch steps
   no longer run the skill in the orchestrator when a seat is missing or no topology exists. The
   ticket moves to `blocked` for that phase (`block_phase: implementing | validating | reviewing`),
   the orchestrator reports to the human, and the dispatch retries on the next wake. The phase-gate
   stays mandatory for non-AUTO tickets. A stable budget needs this: an inline run puts the full
   skill body back into the orchestrator and defeats the change (Codex finding).
4. **Pre-flight 5 checks seats, not skill files.** The orchestrator does not need the skill files
   for `ticket-loop`, `pr-review-lifecycle` or `phase-gate`. It needs the seats that run them.

An opening rule in the "Seat dispatch model" paragraph states the contract: do not call the `Skill`
tool for a dispatched skill. Skill names stay in the text, because the `rig send` briefs use them.

## Unchanged

- `factory-loop` and `recap` run in the orchestrator and stay as they are.
- The orchestrator still parses `TICKET_LOOP_RESULT`, `REVIEW_RESULT` and `GATE_RESULT`. The
  formats do not change.
- The review brief (`rig send ${REVIEW_SEAT} "/code-review-dual ..."`) was already a dispatch and
  does not change.
- Gate 2 stays mandatory. Only the way the gate runs changes.

## Before and after

| Step | Before | After |
|---|---|---|
| 2c implement | `rig send` to the impl seat. Inline `/ticket-loop` when the seat is missing. | `rig send`. Block and retry when the seat is missing. |
| 2e validate | `/phase-gate ...` invoked by the orchestrator. Inline validator when no advisor seat. | `rig send` to the advisor seat. Block and retry when no advisor seat. |
| 2f review | `rig send`. Inline `/pr-review-lifecycle` when no review seat. | `rig send`. Block and retry when no review seat. |
| Enrich | `Skill(ticket-enrich)` in the orchestrator. | `rig send` to the advisor seat. |

## Apply

```bash
cd ~/.claude/skills
patch -p1 --dry-run < <repo>/docs/reference/factory-loop-dispatch-rewrite-skill.diff
patch -p1 < <repo>/docs/reference/factory-loop-dispatch-rewrite-skill.diff
```

The diff targets `a/factory-loop/SKILL.md`. It applies to the version of the skill that includes
the RIG-127 park-on-dispatch change. If RIG-127's diff is not applied yet, apply it first: the
RIG-128 hunks reference the "Park the queue item as in Step 2c" wording that RIG-127 adds.

## Verified

- The diff applies with `patch -p1` to a copy of the live skill, and the result is byte-identical
  to the edited file.
- The live skill file was not modified.
- The edited skill has no remaining instruction to run `/ticket-loop`, `/phase-gate`,
  `/pr-review-lifecycle` or `/code-review-dual` inline. `grep -in inline` shows only the "do not run
  inline" rules, the ticket-content template wording, and the example status file.

## Not verified

- The post-change baseline. The 83K to under 50K result needs a fresh orchestrator window and a
  compaction cycle. Use `scripts/` context-growth measurement (RIG-126) on the next factory run.
- The 50K target also needs a smaller compaction summary. This change alone is estimated at 10-20K.
- The leftover `or "self" for single-seat mode` comment in the example `.factory.yml` status block
  is documentation. This change leaves it.
