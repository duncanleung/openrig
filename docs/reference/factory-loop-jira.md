# factory-loop: Jira backlog source (RIG-96)

`/factory-loop` reads its backlog from Linear. This change adds `backlog.source: jira` as an
opt-in source that uses the Atlassian MCP tools (`mcp__atlassian-rovo-mcp__*`). Linear stays the
default. A config without `source`, or with `source: linear`, behaves as before.

The skill lives at `~/.claude/skills/factory-loop/SKILL.md`, outside this repo. The change is
delivered as a patch, not applied here. It follows the structure of
[factory-loop-github-issues.md](factory-loop-github-issues.md) (RIG-95).

## Apply

Apply the RIG-95 patch first. The Jira patch is written against the skill after RIG-95
(`factory-loop-github-issues-skill.diff`), because both change the same sections.

```bash
patch -b ~/.claude/skills/factory-loop/SKILL.md < docs/reference/factory-loop-github-issues-skill.diff
patch -b ~/.claude/skills/factory-loop/SKILL.md < docs/reference/factory-loop-jira-skill.diff
```

`-b` keeps a `.orig` backup. If `patch` reports rejects, the skill changed since; apply the hunks
by hand. Skip the first command if RIG-95 is already applied.

## What changes

| Skill section | Change |
|---------------|--------|
| Pre-flight 1 | `source: jira` needs the Atlassian MCP connected, `backlog.project` (validated against `^[A-Z][A-Z0-9_]*$`), a cloud ID (config, or auto-detected when the account has exactly one site), and an input scope: `trusted_reporters` or `label_filter` (see Security). |
| Step 0 (R2, R3) | Reconcile with `getJiraIssue` (status, labels, resolution, assignee). Moved to a `done`-category status → `abandoned`, with labels removed and no Jira transition attempted. A `getJiraIssue` failure stops the run. Back in a `new`-category status after a terminal state → re-enters the backlog. Reassignment is reported, not acted on. |
| Step 1 | JQL search by project, extra filter in parentheses, excluding issues labelled `factory:*`. Jira priority maps to Urgent / High / Medium / Low / None. Sorted by priority then oldest. Ticket ID is the Jira key. |
| Transitions | `claimed` moves to In Progress and adds `factory:in-progress`. `blocked` adds `factory:blocked`. `merged` moves to Done. `abandoned` moves to Won't Do, Cancelled or Closed (skipped when the issue is already done). A comment is added at claim, PR open, block, merge and abandon. Both `factory:*` labels are removed on merge, abandon, stale claim, and external close or reopen. |
| Advisor prompts (2e) | `TICKET_VIEW_CMD` gains a Jira form (`getJiraIssue`), output wrapped in `<untrusted_data>`. |
| Config | `project` (required), `cloud_id`, `query_filter` (must be valid JQL), `label_filter`, `trusted_reporters`. One of `label_filter` or `trusted_reporters` is required. |
| Failure handling | MCP failure on the backlog fetch, or `getJiraIssue` failure during reconcile, stops the run. A missing transition, comment or label failure warns, retries once, and continues. A missing transition on an already-done issue is a no-op. |

## Config

```yaml
backlog:
  source: jira
  project: PROJ
  cloud_id: example.atlassian.net      # optional if the account has one site
  query_filter: 'status = "Backlog"'   # optional; must be valid JQL, not Linear syntax
  priority_floor: low
  label_filter: "factory-ready"        # required unless trusted_reporters is set
  trusted_reporters: ["<accountId>"]   # required unless label_filter is set
```

## Design notes

- **No hardcoded transitions.** Workflows differ per project. The skill calls
  `getTransitionsForJiraIssue` each time and matches by target status name, then by status
  category. With no match it does not guess: it logs the options and continues without the status
  change. This is the same discover-never-hardcode rule as the `/ticket-loop` tracker adapter.
- **External close is label cleanup only.** An issue already in a `done`-category status may have no outgoing transition, so reconcile removes both `factory:*` labels and closes the queue item without calling `transitionJiraIssue`.
- **Labels are read-modify-write.** `editJiraIssue` replaces the `labels` field. The skill reads
  the current labels, then writes back the full list with one change.
- **JQL scope.** The project key is validated, `query_filter` comes from the config file, and it
  is AND-ed inside parentheses so it cannot widen the project. `--ticket` keys must match
  `^[A-Z][A-Z0-9_]*-[0-9]+$`.
- **`/ticket-loop` already supports Jira.** The skill names the tracker in the dispatch prompt so
  the adapter does not probe Linear first. No ticket text is pasted for dispatch.

## Security: ticket content is untrusted

Jira summaries, descriptions and comments are written by anyone with access to the project. Text
that reaches an advisor prompt goes inside `<untrusted_data>` tags with an instruction to treat it
as a description of the work only. Pre-flight requires an input scope: a non-empty `backlog.trusted_reporters` allow-list, or a
`backlog.label_filter`, or both. With neither, the run stops. There is no unscoped backlog.
`query_filter` does not count, because its default is only a status filter. `trusted_reporters`
also applies to `--ticket` issues. A label filter limits who can queue work only as far as label
rights in the project are restricted, so prefer `trusted_reporters` when the project accepts tickets
from outside the team. The tags reduce the risk. They do not remove it.

## RIG-82 overlap

RIG-82 ("add Jira ticket source to /factory-loop") asks for the same capability: fetch tickets
from Jira with `searchJiraIssuesUsingJql` and dispatch them through `/ticket-loop`. RIG-96 covers
all of it and adds transitions, reconciliation and config. RIG-82 mentions auto-detecting the
tracker and the daemon migration (RIG-81). Neither is in this patch. Treat RIG-82 as a duplicate
of RIG-96 unless those two points matter.

## Not covered

- The daemon ticket factory (RIG-87 to RIG-93) has its own backlog lister placeholder. It does
  not read Jira. This patch covers the skill path only.
- Auto-detecting the source from the repo. The source is explicit in config.
- The patch was not run against a live Jira site. No MCP call in it was executed. The
  `editJiraIssue` label write and the `resolution` retry rest on the tool schemas, not on a run.
