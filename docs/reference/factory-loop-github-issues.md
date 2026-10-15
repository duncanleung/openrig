# factory-loop: GitHub Issues backlog source (RIG-95)

`/factory-loop` reads its backlog from Linear. This change adds `backlog.source: github-issues`
as an opt-in source. Linear stays the default. A config without `source`, or with
`source: linear`, behaves as before.

The skill lives at `~/.claude/skills/factory-loop/SKILL.md`, outside this repo. The change is
delivered as a patch, not applied here.

## Apply

```bash
patch ~/.claude/skills/factory-loop/SKILL.md < docs/reference/factory-loop-github-issues-skill.diff
```

The patch is against the skill after the RIG-89 cutover edits (pre-flight 0 present). If `patch`
reports rejects, the skill changed since; re-read the hunks and apply by hand. To undo, keep the
`.orig` file that `patch` writes with `-b`.

## What changes

| Skill section | Change |
|---------------|--------|
| Pre-flight 1 | Linear CLI is required only for `source: linear`. `github-issues` requires `backlog.repo`, issues enabled, and creates the `factory:in-progress` and `factory:blocked` labels. |
| Step 0 (R2, R3) | Reconcile with `gh issue view --json state,stateReason,labels,title`. Externally closed issue → `abandoned`. Externally reopened issue → re-enters the backlog as a new ticket. |
| Step 1 | `gh issue list --state open --json number,title,labels,createdAt`, optional `--label` filter, drop issues already labelled `factory:*`, map labels to priority, sort by priority then oldest. Ticket ID is `GH-<number>`. |
| Transitions | `claimed` adds `factory:in-progress`. `blocked` adds `factory:blocked`. `merged` closes with reason `completed`. `abandoned` closes with reason `not planned`. |
| Config | `repo` (required), `label_filter`, `priority_labels`. `team` doubles as the label filter when `label_filter` is unset. |
| Failure handling | `gh` failure on fetch stops the run. Label or close failure warns and retries once. |

## Config

```yaml
backlog:
  source: github-issues
  repo: duncanleung/rea
  label_filter: "backlog"
  priority_labels:
    urgent: "priority:urgent"
    high: "priority:high"
    medium: "priority:medium"
    low: "priority:low"
```

## Not covered

- `/ticket-loop` resolves tickets through its tracker adapter (Linear or Jira). It has no GitHub
  Issues adapter. The patch has `/factory-loop` pass the issue body inline in the dispatch prompt.
  A native adapter is a separate change.
- The daemon ticket factory (RIG-87 to RIG-93) has its own backlog lister placeholder. It does not
  read GitHub Issues. This patch only covers the skill path.
- The patch was not run against a live repo. No `gh` call in it was executed.
