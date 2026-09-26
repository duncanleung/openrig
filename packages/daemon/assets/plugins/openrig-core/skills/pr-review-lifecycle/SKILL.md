---
name: pr-review-lifecycle
description: "Use when a PR needs the full review→fix→merge loop. Covers: dispatching /code-review-dual, running /code-review-validate-findings, polling for external bot reviews (CodeRabbit, Greptile), dispatching fix agents, scoped re-review after fixes, SHA-tracked staleness, 3-cycle escalation, and the merge gate. The orchestrator or reviewer loads this when assigned PR review work."
metadata:
  openrig:
    stage: field-captured
    sibling_skills:
      - review-team
      - queue-handoff
      - delegating-work
---

# PR Review Lifecycle

The full review→fix→merge protocol for pull requests. This skill turns a review
assignment into a deterministic loop that runs until the PR is merged, reported
merge-ready, or escalated.

Load this skill when you are assigned PR review work by the orchestrator or the
human. The `review-team` skill covers review methodology (how to review); this
skill covers review lifecycle (what to do with the PR from open to merged).

## Roles

**Orchestrator use:** dispatch review agents, track PR status across the rig,
decide when to merge. The orchestrator does not run reviews in its own context.

**Reviewer use:** execute the review steps when working directly on a PR. A
reviewer that holds this skill can run the full lifecycle autonomously.

## Step 1 — Discover PRs

Accept PR numbers from the assignment. If none given, discover open PRs:

```bash
gh pr list --state open --json number,headRefName,headRefOid,title,mergeable,isDraft
```

Skip drafts unless explicitly included. Record each PR's current HEAD SHA — this
is the staleness anchor for the entire protocol.

## Step 2 — Check review status

For each PR, determine whether `/code-review-dual` AND
`/code-review-validate-findings` have both completed against the current HEAD.

### 2a — Get current HEAD

```bash
gh pr view <N> --json headRefOid --jq '.headRefOid'
```

### 2b — Find existing review artifacts

1. Check `~/.claude/logs/code-review/` for a log directory matching this repo +
   branch.
2. Read the log's `metrics.json` or `summary.md` to find the SHA it ran against.
3. Check `.ai/status/review-pr<N>.md` for prior review status.
4. Record the dual SHA and the validation SHA separately.

### 2c — Decision matrix

| Prior review? | SHA matches HEAD? | Cause of difference | Action |
|---|---|---|---|
| None | — | — | Full review (Step 3) |
| Dual + validation both exist | Both match | — | Skip to merge gate (Step 5) |
| Dual exists, validation missing | Dual matches | — | Validate findings (Step 3d) |
| Review exists | Stale | Fix-push for known findings | Scoped re-review (Step 4) |
| Review exists | Stale | Unknown changes | Full review (Step 3) |

**Distinguishing fix-push from unknown-change:** check `.ai/status/fix-pr<N>.md`.
If a fix agent wrote that file and its `reviewed_sha` matches the prior review's
SHA, the new commits are fix commits. Otherwise treat as unknown changes.

### 2d — No test-only exemption

A push that touches only test files still moves HEAD. The merge gate requires
dual+val at current HEAD. Treat a test-only push as an unknown change (full
review).

## Step 3 — Run reviews

### 3a — Dispatch dual review

Dispatch `/code-review-dual` for each PR that needs review. Never run reviews in
the orchestrator's own context — each review costs 190–230K tokens.

Use `rig` seat or subagent dispatch:

```bash
rig send <reviewer-session> "/code-review-dual <N>"
```

Or spawn a dedicated review agent via the rig's seat infrastructure.

Review agents stay pinned to `claude-opus-4-6[1m]` for spend control — do not
inherit the orchestrator's model. Each dual review fans out to 8+ hunters plus
validators; a costlier model multiplies across every PR.

### 3b — Monitor and process results

When the review completes, classify the result:

| Result | Action |
|---|---|
| 0 must-fix findings | Run validation (Step 3d), then merge gate (Step 5) |
| Must-fix findings exist | Dispatch fix agent (Step 3e) |
| Review failed or errored | Retry once, escalate on second failure |

### 3c — Wait for external bot reviews

After dual review completes, poll for external bot reviews and validate their
findings before dispatching fixes or proceeding to the merge gate.

Known bot reviewer logins: `coderabbitai` (CodeRabbit), `greptile[bot]`
(Greptile).

Query review threads via GraphQL — the REST endpoint may 404 where GraphQL
works. Never trust the CodeRabbit status check — it reports SUCCESS even when it
skipped or errored. Check `reviewThreads` content, not check status.

```bash
OWNER=$(gh repo view --json owner --jq '.owner.login')
REPO=$(gh repo view --json name --jq '.name')
gh api graphql -f query="{ repository(owner:\"$OWNER\", name:\"$REPO\") {
  pullRequest(number:<N>) {
    reviewThreads(first:100) { totalCount nodes {
      path line startLine isResolved
      comments(first:5) { nodes { author { login } body } }
    } }
  }
} }"
```

Filter threads where the first comment's `author.login` matches a known bot.

**Polling cadence:**

1. Query immediately after dual review completes.
2. If no bot threads found, poll every 60s for up to 5 minutes.
3. Once threads appear, wait one additional 60s settle window for the bot to
   finish posting all inline comments.
4. After 5 minutes with no threads, log "No bot reviews received within timeout"
   and proceed without bot findings.

**Extracting findings from bot comments:**

Parse each thread into a finding. Skip resolved threads and
praise/informational comments with no actionable content.

- **File and line**: from `path`, `line`, `startLine`.
- **Description**: from the first comment `body`. Strip CodeRabbit/Greptile
  markdown decorators (collapsible sections, tool references, fingerprints).
- **Severity**:
  - CodeRabbit: `🔴 Critical/Major` → mustFix; `🟡 Minor` → suggestion;
    `🟢 Info` or praise → skip.
  - Greptile: `severity: high/critical` → mustFix; others → suggestion.
  - Unknown → default to suggestion.
- **Category**: extract from the bot's category tag. Default `"external-review"`.

**Write report.json for validate-findings:**

```bash
BRANCH=$(gh pr view <N> --json headRefName --jq '.headRefName' | tr '/' '-')
HEAD=$(gh pr view <N> --json headRefOid --jq '.headRefOid')
LOG_DIR="$HOME/.claude/logs/code-review/bot-$(basename $(git rev-parse --show-toplevel))-${BRANCH}-$(date +%Y%m%dT%H%M%S)"
mkdir -p "$LOG_DIR"
```

Write `$LOG_DIR/report.json`:

```json
{
  "metadata": {
    "sha": "<HEAD>",
    "branch": "<branch>",
    "source": "external-bot-reviews",
    "bots": ["coderabbitai"]
  },
  "result": {
    "mustFix": [
      {
        "description": "<finding text>",
        "file": "<path>",
        "lines": "<startLine>-<line>",
        "category": "<category>",
        "score": 5,
        "verdict": "PLAUSIBLE",
        "deepResearch": false,
        "externalSource": "<bot login>",
        "fixRecommendation": "<extracted fix or empty>"
      }
    ],
    "suggestions": []
  }
}
```

For CodeRabbit `fixRecommendation`: extract the diff content from `Proposed fix`
or `Committable suggestion` sections inside `<details>` tags.

### 3d — Validate findings (mandatory)

After every dual review, run `/code-review-validate-findings` at the same SHA.
This confirms findings are real, not false positives.

Run validation in the same agent as the dual review (it needs the review
context). If the review produced no findings, record an explicit completed
result (`validation: 0 findings @ <sha>`) in `.ai/status/review-pr<N>.md`.

If `/code-review-validate-findings` is unavailable or fails, the PR is not
cleared — escalate.

For bot findings, spawn a separate validation agent — do not reuse the dual
review agent (its context is full):

```bash
rig send <validator-session> "/code-review-validate-findings <N> --log-dir $LOG_DIR"
```

Merge validated must-fix findings from bot review into the combined findings
list alongside the dual review's surviving must-fix findings.

### 3e — Dispatch fix agents

If the review produced must-fix findings, dispatch an implementation agent.

Use Sonnet — fix agents apply specific, well-defined changes from review
findings. Bounded scope with clear instructions.

Brief the fix agent with:
- The specific findings to fix (file, line, description)
- The PR branch: `git checkout <branch>`
- Instructions to commit and push after fixing
- Instruction to write status to `.ai/status/fix-pr<N>.md`
- The reviewed SHA: `"Record reviewed_sha: <SHA> in your status file"`

The fix agent's status file must include `reviewed_sha: <SHA>`. Step 2c uses
this to distinguish fix-push staleness (scoped re-review) from unknown-change
staleness (full re-review).

After fixes are pushed, HEAD has changed. Go back to Step 2 for this PR.

## Step 4 — Scoped re-review (after fix-push only)

When Step 2c routes here, the only new commits are fixes for known findings. A
full `/code-review-dual` is wasteful — the task is verification, not discovery.

Use Sonnet — verification does not need Opus-level reasoning.

**Diff range: fix commits only.** Scan `<reviewed-SHA>..<current-HEAD>`, not the
full PR diff.

Brief the re-review agent:

```
You are verifying fixes on PR #<N>, branch <branch>.

The prior review at <reviewed-SHA> found these must-fix findings:
<list each finding: file, line, description, expected fix>

Since then, fix commits were pushed. Current HEAD is <current-HEAD>.

1. VERIFY FIXES — for each finding, check whether the fix commit addressed it.
   Report: FIXED / PARTIALLY FIXED / NOT FIXED with a one-line explanation.

2. REGRESSION SCAN — review only the fix diff
   (git diff <reviewed-SHA>..<current-HEAD>) for regressions. Do NOT re-review
   the rest of the PR.

Write results to .ai/status/rereview-pr<N>.md
```

**Processing results:**

| Result | Action |
|---|---|
| All FIXED, no regressions | Run Step 3 + 3d at current HEAD, then merge gate |
| Some NOT FIXED or PARTIALLY FIXED | Dispatch another fix agent (Step 3e) |
| Regressions in fix commits | Dispatch fix agent for regressions |
| Re-review errors or inconclusive | Fall back to full `/code-review-dual` |

### 3-cycle escalation limit

Three total review cycles (any mix of full + scoped) on the same PR triggers
escalation to the human. Write the cycle history to the status file. This
prevents infinite review→fix loops.

## Step 5 — Merge gate

Merge only when ALL conditions are true. Check each one explicitly.

### 5a — Dual review and validation at current HEAD

```bash
HEAD=$(gh pr view <N> --json headRefOid --jq '.headRefOid')
```

Compare HEAD against both recorded SHAs: the last `/code-review-dual` run and
the last `/code-review-validate-findings` run. If either does not match, go back
to Step 2.

### 5b — All findings resolved

Every validated must-fix finding must be either:
- Fixed (committed and pushed)
- Explicitly marked `no_change_needed` with a reason

### 5c — CI checks pass

```bash
gh pr checks <N>
```

All required checks must be green. If failing, investigate.

### 5d — No merge conflicts

```bash
gh pr view <N> --json mergeable --jq '.mergeable'
```

Must return `MERGEABLE`. If `CONFLICTING`, dispatch a rebase agent (Sonnet —
rebasing is mechanical). After rebase, HEAD changes — go back to Step 2.

### 5e — Merge

```bash
gh pr merge <N> --squash --auto
```

After merge:
- Write to `.ai/status/review-pr<N>.md`: `MERGED at <SHA> on <date>`
- Pull main: `git checkout main && git pull`
- Check if remaining PRs need rebase against new main

## Step 6 — Status reporting

Write status to `.ai/status/review-lifecycle-<session-id>.md` (session-qualified
to avoid collisions):

```
SESSION_ID: <session-id>

| PR | Title | HEAD SHA | Review status | Findings | Merge status |
|---|---|---|---|---|---|
| #140 | QUA-128 dividend safety | abc1234 | dual+val @ abc1234 | 0 must-fix | MERGED |
| #141 | QUA-125 reverse DCF | def5678 | stale dual @ old1234 | — | needs re-review |
```

Report `dual+val @ <sha>` only when both runs completed at that SHA. Otherwise
list each run's SHA separately.

## Context discipline

This protocol is orchestration work. The same context rules apply:

- Do not run `/code-review-dual` in the orchestrator's own context. Dispatch.
- Do not apply fixes in the orchestrator's own context. Dispatch.
- Do not read large diffs or file contents. Tell agents to summarize.
- Read agent output at most 40 lines at a time.

## Edge cases

- **PR force-pushed during review:** review is stale. Go back to Step 2.
- **PR closed or merged externally:** skip it. Remove from tracking table.
- **Review agent dies mid-run:** check seat status via `rig health` or
  `rig seat list`. If dead, dispatch a new review agent and re-run.
- **Fix agent introduces new issues:** the re-review cycle catches them.
- **Circular fix loop:** the 3-cycle escalation limit (Step 4) prevents
  infinite loops.
