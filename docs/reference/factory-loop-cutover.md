# Runbook: cutover from the /factory-loop skill to the daemon ticket-factory (RIG-89)

Goal: move ticket admission from the skill-based `/factory-loop` to the daemon workflow with no
double-dispatch, no lost work, and a rollback path.

## Scope and known limits

- The backlog lister and the admission prep checks in the daemon are still placeholders that throw
  (`startup.ts`). You can rehearse the cutover and roll it back now. The daemon cannot admit real
  tickets until real adapters land (not scheduled).
- The daemon cannot observe or stop the skill. "Legacy producer disabled" is an operator
  attestation. The tripwire (below) is a second check. `startup.ts` wires a read-only queue probe: it
  lists factory-loop tagged queue items in `pending`, `in-progress` or `blocked` that were created at
  or after the cutover time (the cutover row `updated_at` while the phase is `daemon`), and returns
  their `ticket:<ID>` tags. If the queue read fails, the tripwire logs a warning, returns
  `probeUnavailable: true` and does not pause. Known gap: an item that was already active before the
  cutover, for a ticket the reconcile did not announce, is not flagged.
- The skill lives outside this repo (`~/.claude/skills/factory-loop/SKILL.md`). This repo does not
  edit it. Apply `docs/reference/factory-loop-cutover-skill.diff` by hand:
  `cd ~/.claude/skills && patch -p1 < <repo>/docs/reference/factory-loop-cutover-skill.diff`.

## Phases

`legacy` (no row, the default) -> `reconciled` -> `daemon`; `daemon` -> `rolled-back` -> `daemon`.
While a cutover row exists, `POST /enable` answers 409 unless the phase is `daemon`. With no row,
the factory behaves as in RIG-88.

## Procedure

1. **Stop the old producer.** Stop any running `/factory-loop` session. Do not start a new one.
2. **Collect the legacy snapshot** (read-only):
   - queue: `rig queue list --json | jq '[.[] | select(.tags | index("factory-loop"))]'`
   - status files: `.ai/status/factory-loop-*.md`
   - PRs: `gh pr list --author @me --repo duncanleung/openrig --state all --json number,state,headRefName,mergedAt`
   - worktrees: `git worktree list --porcelain`
   - tracker: `linear issue view <ID> --json` for each ticket
   Build `{ items: [{ticketId, legacyState, prNumber?, branch?, hasWorktree?, source?}], prs: [{ticketId, number, state: open|merged|closed}], tickets: {<ID>: open|closed|unknown} }`.
3. **Reconcile.** `POST /api/ticket-factory/cutover/reconcile` with the snapshot. The response
   classifies every ticket:

   | Action | Meaning | Fence |
   |--------|---------|-------|
   | `hold` | In flight under the old system (migration path: it finishes there) | fenced |
   | `blocked` | PR closed unmerged, or worktree lost: a human decides | fenced |
   | `release-merged` | PR merged | not fenced |
   | `release-resolved` | Tracker closed it, or legacy state merged/abandoned | not fenced |
   | `stale-claim` | claimed/planning with no branch, PR or worktree: back to the backlog | not fenced |

   Tickets missing from a later snapshot stay fenced. Absence is not evidence of completion.
4. **Cut over.** `POST /cutover/start` with `{"legacyProducerDisabled": true}`. This sets phase
   `daemon` and enables the factory. It answers 409 before a reconcile or without the attestation.
5. **Let old work finish.** Held tickets finish under the old system. When one is done, release it
   by re-running reconcile with a fresh snapshot (a merged PR or closed ticket releases the claim).
   The daemon admits a released ticket only if the tracker has not resolved it.
6. **Watch.** `GET /cutover` shows phase, `daemonAdmitted`, legacy claims and completion facts.
   `POST /cutover/tripwire` pauses the daemon (drain) if a probe reports a legacy item that
   overlaps a daemon admission or that the reconcile did not announce.

## Three completion facts

Stored per ticket in `ticket_completion` as true / false / unknown (NULL). No fact is inferred from
another, and a later "unknown" never erases an earlier known value.

| Fact | Source |
|------|--------|
| workflow completed | Legacy: pipeline reached merge-ready or merged. Daemon: admission closed with "workflow completed" (`syncDaemonCompletion`) |
| PR merged | GitHub snapshot |
| ticket resolved | Tracker snapshot |

## No double-dispatch

- Daemon side: `TicketAdmissionService.admit()` refuses a ticket with an unreleased legacy claim
  (`legacy-held`) before running checks, and checks again inside the insert transaction. It also
  refuses a ticket the tracker already resolved (`already-resolved`).
- Skill side: the skill reads `daemonAdmitted` from `GET /cutover` before each claim and skips those
  tickets, and stops admitting entirely once the phase is `daemon`.

## Rollback

1. `POST /cutover/rollback`. The daemon factory pauses (drain). Active daemon tickets keep running
   and stay in `daemonAdmitted`. Phase becomes `rolled-back`; `POST /enable` now answers 409.
2. Run `/factory-loop` again. With the updated skill it skips daemon-admitted tickets.
3. To try again, reconcile with a fresh snapshot (the skill may have admitted work), then
   `POST /cutover/start`.
