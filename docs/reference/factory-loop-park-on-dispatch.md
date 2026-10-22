# Factory-loop: park the queue item while a seat works (RIG-127)

## Problem

The factory-loop orchestrator claims a queue item, sends work to a seat with `rig send`, and
waits. During the wait it makes no queue change, and its pane shows an idle prompt.

`derivePickup()` (`packages/daemon/src/domain/queue-pickup.ts`) gives the 45-minute
`queue.hard_stale_minutes` grace only when the owner activity is `working`. An idle prompt does
not qualify, so the row falls to `queue.pickup_stall_threshold_minutes` (3 minutes) and reads
`stalled-after-claim`. The stuck-sweep then raises a false finding. Six findings were seen on
2026-10-22 for one RIG-125 item. Whether they were six findings or refreshes of one is not
checked here.

## Fix

A row in state `blocked` derives as `parked` on the first line of `derivePickup()` and the
sweep's stalled path skips it. The orchestrator is waiting on a dependency, so parking is
accurate. After each `rig send` dispatch the skill runs:

```bash
rig queue block <qitem> --on external:seat-result:<ticket>-<phase> \
  --continuation "awaiting <seat> result for <ticket> (<phase>)" --wake-after 60m
```

When the result arrives it runs `rig queue update <qitem> --state in-progress --note "..."`.

No daemon change. The skill lives outside this repo (`~/.claude/skills/factory-loop/SKILL.md`),
so this repo ships a patch. A person applies it:

```bash
cd ~/.claude/skills && patch -p1 < <repo>/docs/reference/factory-loop-park-on-dispatch-skill.diff
```

The patch adds a "Park the queue item while the seat works" block to Step 2c and a one-line
reference in the review-seat dispatch.

## Verified

On a throwaway row, on this daemon (rows closed afterwards):

| Step | Result |
|---|---|
| `rig queue block <q> --on external:seat-result:rig127-test --continuation ... --wake-after 5m` | `state=blocked`, `pickup.state=parked` |
| `rig queue update <q> --state in-progress --note ...` | `state=in-progress`, `blockedOn=null`, `pickup.state=working` |

The patch applies cleanly to the installed skill (`patch --dry-run`).

## Limits

- Not run end to end. No factory-loop run was made with the patch, so the false-positive count
  with it is unmeasured. Compare `rig view show pickup` findings over a few dispatches.
- `external:` blockers do not auto-unpark. The skill must unpark when the result arrives. If it
  does not, the 60-minute wake fires and the lease check runs.
- A parked row still gets `unconsumed-wait` findings when a wake notice goes unread.
- The patch covers the implement and review dispatches. The `/phase-gate` advisor wait is not
  changed; that skill owns its own wait.
- The `.ai/status/` lease files stay. Moving them to queue state is a separate change.
