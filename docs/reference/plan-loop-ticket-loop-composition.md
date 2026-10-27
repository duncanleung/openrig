# Plan-loop: dispatch `/ticket-loop` for implementation (RIG-133)

## Problem

`/plan-loop` sent each slice to the implement seat with its own inline instructions: run
`/spec-worktree`, implement the tasks, open a PR, report `PLAN_LOOP_RESULT`. `/factory-loop` sends
`/ticket-loop <ID>` instead. `/ticket-loop` holds worktree seeding, the D+C+A classifier, the research
gate, phase isolation and the plan-review gate. Plan slices got none of them, and each new
`/ticket-loop` improvement widened the gap.

## Change

The skill diff (`plan-loop-ticket-loop-composition-skill.diff`) changes
`~/.claude/skills/plan-loop/SKILL.md`. `/plan-loop` keeps slice order, dependencies, the phase gate,
review dispatch and the merge gate. `/ticket-loop` owns the implement-to-PR lifecycle inside one slice.

1. **Step 2a materializes a ticket.** After the queue claim, `/plan-loop` creates one Obsidian ticket
   per slice (`ticket create --project P --kind feature --json`). `ticket create` takes no body, so
   the skill fills the empty Problem, Goal and Notes sections by editing the generated file once. The
   Problem section holds the slice context. The Goal section holds the tasks and the checkpoint. The
   Notes section holds `plan_ref`, the branch name, the repo, the base branch and the baseline test
   failures. This is the RIG-134 bridge, inlined as the ticket suggested.
2. **Step 2b dispatches `/ticket-loop <ID>`** to the implement seat. The old inline worktree and
   implementation prompt is gone. The dispatch message has the same fields `/factory-loop` and the
   orchestrator already use: tracker line, repo, `GH_REPO`, base branch, push rules, and the exact
   `TICKET_LOOP_RESULT` format.
3. **Step 2c maps the result to plan-loop states.**

   | `TICKET_LOOP_RESULT` | Plan-loop transition | Tracker write |
   |---|---|---|
   | `outcome=pr-created` | `implementing` -> `pr-open` | `in-review` |
   | `outcome=escalate` or `classification=ESCALATE` | `implementing` -> `blocked` (`block_phase: implementing`) | none |
   | `outcome=failed` | `implementing` -> `blocked` (`block_phase: implementing`) | none |
   | no result, seat idle | `implementing` -> `blocked` (`block_phase: implementing`) | none |

4. **The `worktree-setup` state is removed.** `/ticket-loop` owns the worktree. Old status files that
   carry `worktree-setup` are read as `implementing`.
5. **Tracker writes follow `/factory-loop`:** `claimed` -> `in-progress`, `pr-open` -> `in-review`,
   `merged` -> `done`, `abandoned` -> `cancelled`. `/ticket-loop` never changes ticket status.
6. **Restart safety.** `ticket_id` is recorded before any dispatch. A restart searches for
   `plan_ref` and reuses the ticket, so one slice never gets two tickets. Reconciliation has a new row
   for a claimed slice with a ticket and no dispatch.
7. **No inline fallback.** A missing implement seat blocks the slice. The orchestrator does not run
   `/ticket-loop` itself (same rule as RIG-128).
8. New pre-flight 8 checks the ticket CLI and resolves `TICKET_PROJECT` and `GH_REPO` (origin, never
   upstream on a fork). No matching project stops the run and asks the human.

Steps 2d (phase gate), the review dispatch and the merge gate do not change.

## Unchanged

- Slice ordering, dependency enforcement (slice N needs slice N-1 merged) and the budget checks.
- `/pr-review-lifecycle` review dispatch and the merge policy.
- The `blocked` and `abandoned` rules, except that `worktree-setup` is no longer a phase.

## Apply

```bash
cd ~/.claude/skills
patch -p1 --dry-run < <repo>/docs/reference/plan-loop-ticket-loop-composition-skill.diff
patch -p1 < <repo>/docs/reference/plan-loop-ticket-loop-composition-skill.diff
```

The diff targets `a/plan-loop/SKILL.md` as installed on 2026-10-27 (25,451 bytes, last changed
2026-10-15).

## Verified

- The diff applies with `patch -p1` to a copy of the installed skill. The result is byte-identical to
  the edited file.
- The live skill file was not modified.
- The edited skill has no remaining `/spec-worktree` or `PLAN_LOOP_RESULT`. `worktree-setup` appears
  once, in the note that tells old status files to read it as `implementing`.

## Not verified

- No `/plan-loop` run was made with the patched skill. The ticket body fill, the dispatch message and
  the result mapping are untested end to end.
- Restart reuse relies on `ticket search`. I read its code: it matches a case-insensitive substring
  of the title, the body or the ID, so it finds the `plan_ref` line. The skill writes the path in
  backticks and searches with the closing backtick, so `slice-1` does not match `slice-10`. I did
  not run it against a real plan.
- `plan_ref` is plain text in the Notes section. There is no `plan_ref` frontmatter field, because
  the ticket schema has none.
- Slice dependencies between tickets are not wired (`blocked_by`). `/plan-loop` still enforces
  order itself.
- The merge gate and review seat flow were not touched, so the interaction of `in-review` tracker
  writes with `/pr-review-lifecycle` is unexamined.
