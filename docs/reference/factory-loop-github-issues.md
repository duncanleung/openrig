# factory-loop: GitHub Issues backlog source (RIG-95)

`/factory-loop` reads its backlog from Linear. This change adds `backlog.source: github-issues`
as an opt-in source. Linear stays the default. A config without `source`, or with
`source: linear`, behaves as before.

The skill lives at `~/.claude/skills/factory-loop/SKILL.md`, outside this repo. The change is
delivered as a patch, not applied here.

## Security: issue content is untrusted

Issue titles, bodies, comments and labels are written by third parties. On a public repo, anyone
can open an issue. A body can carry text that tries to steer the implementer or advisor agent
(prompt injection). The patch defends in three ways:

- `backlog.label_filter` (or `team`) is **required**. Pre-flight stops without it. There is no
  unfiltered backlog.
- An author check: issues are dropped unless `authorAssociation` is in
  `backlog.trusted_associations` (default `OWNER, MEMBER, COLLABORATOR`). Labels alone are not an
  author check, because anyone with triage rights can add one.
- Issue text goes into every prompt (implementer and both advisor prompts) inside
  `<untrusted_data>` tags with an instruction to treat it as a description of the work only.

Do not point `github-issues` at a repo where untrusted users hold triage rights. The tags reduce
the risk. They do not remove it.

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
| Step 0 (R2, R3) | Reconcile with `gh issue view --json state,stateReason,labels,title`. Externally closed issue → `abandoned`. Externally reopened issue → re-enters the backlog as a new ticket. Both `factory:in-progress` and `factory:blocked` are removed on close, reopen, merge and abandon, so a previously blocked ticket is not filtered out by Step 1. |
| Step 1 | `gh issue list --state open --json number,title,labels,createdAt`, optional `--label` filter, drop issues already labelled `factory:*`, map labels to priority, sort by priority then oldest. Ticket ID is `GH-<number>`. |
| Advisor prompts (2e) | Both ADJUDICATE prompts use `${TICKET_VIEW_CMD}`: `linear issue view` for Linear, `gh issue view` for GitHub Issues, output wrapped in `<untrusted_data>`. |
| Transitions | `claimed` adds `factory:in-progress`. `blocked` adds `factory:blocked`. `merged` closes with reason `completed`. `abandoned` closes with reason `not planned`. |
| Config | `repo` (required), `label_filter`, `priority_labels`. `team` doubles as the label filter when `label_filter` is unset. |
| Failure handling | `gh` failure on fetch stops the run. Label or close failure warns and retries once. |

## Config

```yaml
backlog:
  source: github-issues
  repo: duncanleung/rea
  label_filter: "backlog"          # required
  trusted_associations: [OWNER, MEMBER, COLLABORATOR]   # optional, default shown
  priority_labels:
    urgent: "priority:urgent"
    high: "priority:high"
    medium: "priority:medium"
    low: "priority:low"
```

## Not covered

- `/ticket-loop` resolves tickets through its tracker adapter (Linear or Jira). It has no GitHub
  Issues adapter. The patch has `/factory-loop` pass the issue body inline in the dispatch prompt, inside `<untrusted_data>` tags.
  A native adapter is a separate change.
- The daemon ticket factory (RIG-87 to RIG-93) has its own backlog lister placeholder. It does not
  read GitHub Issues. This patch only covers the skill path.
- The patch was not run against a live repo. No `gh` call in it was executed.
