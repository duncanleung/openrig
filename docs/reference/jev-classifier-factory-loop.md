# factory-loop: Jev classifier shadow verdict (RIG-99)

`/factory-loop` now accepts `merge_policy: auto-jev`. After the rule-based bucket is known, the
skill calls `rig ticket-factory jev-classify` and records the Jev verdict next to the bucket. The
policy is shadow mode (ADR-0008): its effective policy is `human`. The verdict never gates a merge.

The skill lives at `~/.claude/skills/factory-loop/SKILL.md`, outside this repo. The change is
delivered as a patch, not applied here. A human applies it.

## What this change depends on

| Piece | Where | State |
|-------|-------|-------|
| Classifier library (`classifyWithJev`, `decideJev`, `buildPrSummary`) | `packages/daemon/src/domain/jev-classifier.ts` | Merged (RIG-97, PR #49) |
| CLI verb `rig ticket-factory jev-classify` | `packages/cli/src/commands/ticket-factory-jev.ts` | Merged (RIG-99 PR1, PR #55, `d6814b38`) |
| Skill text that calls the verb | `factory-loop-jev-skill.diff` in this folder | This change |

The skill needs a `rig` build that includes `d6814b38`. An older `rig` answers "unknown command"
with a non-zero exit. The skill treats that as "no Jev verdict" and continues.

## Apply

The patch uses `-p1` paths relative to `~/.claude/skills`.

| File | sha256 |
|------|--------|
| Live `factory-loop/SKILL.md` before the patch | `812abd8809d56ceaa3af117fb6192ab91ea67c3255a7428bc004218b5c5766cd` (2190 lines) |
| Live `factory-loop/SKILL.md` after the patch | `505b9e98cd7ee156a5be797af2f9df205936c196f97506111997908a24695da4` (2258 lines) |
| `factory-loop-jev-skill.diff` | `be0dc7e34dad119b9b3cba72db9ad832c2ea0112fad015da3cb0b669a1caafd7` |

```bash
cd ~/.claude/skills
shasum -a 256 factory-loop/SKILL.md          # must print the "before" hash above
cp factory-loop/SKILL.md /tmp/factory-loop-SKILL.md.pre-jev     # backup
patch -p1 --dry-run < /path/to/openrig/docs/reference/factory-loop-jev-skill.diff
patch -p1 < /path/to/openrig/docs/reference/factory-loop-jev-skill.diff
shasum -a 256 factory-loop/SKILL.md          # must print the "after" hash above
```

If the "before" hash differs, the skill changed since this patch was written. Do not force the
patch. Re-read the 8 hunks and apply them by hand, or ask for a rebased diff.

### Base file

The ticket named the base as the live file at sha256 `148fd604…` (2185 lines). When this patch was
written, the live file had a different hash (`812abd88…`, 2190 lines) and already carried the RIG-89
cutover text. It also carries GitHub Issues and Jira text that does not match the RIG-95 and RIG-96
diffs in this folder line for line: `patch -R` of those two diffs fails on 6 to 7 of 10 hunks. This
patch is built and tested against the file at `812abd88…`. It does not depend on the RIG-95/96/89
diffs, and none of its 8 hunks touches the backlog-source sections.

### Roll back

```bash
cd ~/.claude/skills
patch -p1 -R < /path/to/openrig/docs/reference/factory-loop-jev-skill.diff
shasum -a 256 factory-loop/SKILL.md          # must print the "before" hash again
```

Or restore the backup copy. Rollback removes the `auto-jev` text only. Status files and queue notes
that already hold `jev:` data stay valid and are ignored.

## What changes

| Skill section | Change |
|---------------|--------|
| Front matter hint and usage | `--merge-policy` accepts `auto-jev`. One usage line. |
| Status file schema | New optional `jev:` block: `rule_bucket`, `verdict`, `risk_class`, `auto_merge_safe`, `would_auto_merge`, `model`, `recorded_at`. |
| Step 2d, new block `2d-jev` | When `merge_policy: auto-jev`, after the PR is recorded: take the bucket from `TICKET_LOOP_RESULT`, call the verb, apply the ESCALATE floor, write the verdict to the status file and a queue note. |
| Rail 7 merge gate display | One line for the Jev verdict, marked informational. |
| Merge authority and Merge policy | Four policies. `auto-jev` needs human approval for every bucket. |
| Config | `merge_policy` comment lists `auto-jev` and the optional `jev:` block. |

The `2d-jev` call:

```bash
rig ticket-factory jev-classify --pr "${PR_NUMBER}" --bucket "${RULE_BUCKET}" --repo "${GH_REPO}" --json
```

## Safety rules the patch writes into the skill

- **Shadow only.** `auto-jev` behaves as `human`. Rail 7 and Gate 3 do not change. Nothing reads the
  Jev fields to merge.
- **ESCALATE floor, twice.** The skill records `would_auto_merge: false` for a rule bucket of
  `ESCALATE` whatever the verb prints. The verb enforces the same floor.
- **A failure is "no verdict".** A non-zero exit (unknown command, daemon `dist` not built, `gh`
  failure), empty output, non-JSON output or a null verdict records `verdict: unavailable`. The skill
  does not retry, block or change state.
- **Input checks.** The bucket must be one of the four exact values. The PR number must be a positive
  integer from the result line. The verb validates both again before it starts `gh`.
- **Key handling.** The key is `TYPESAFE_API_KEY` in the calling seat's environment. A human
  provisions it. The skill never prints, logs or writes it. The verb redacts it from all output.
- **Data sent out.** The verb sends changed-file paths, line counts and file kinds to
  api.typesafe.ai. It sends no source text, diff hunks or commit messages. Path privacy was reviewed
  by `orch-lead` for RIG-99.

## Verify after applying

Run once in a seat without `TYPESAFE_API_KEY`:

```bash
rig ticket-factory jev-classify --pr <an open PR> --bucket AUTO --repo duncanleung/openrig --json
```

Expected: exit 0, `"jev":null`, `"effectivePolicy":"human-approval"`. Then run `/factory-loop
--ticket <ID> --merge-policy auto-jev --dry-run` and check that the dry run still dispatches nothing.
With the key set, the first real run records a `JEV (shadow)` queue note next to the bucket.

## Not verified

- The patch text was never run by a live `/factory-loop`. Only `patch` apply, dry-run and rollback
  were run, on copies of the skill.
- No call to api.typesafe.ai was made for this change. A real Jev response was never parsed in a
  skill run.
- The `jq` extraction lines in `2d-jev` were not run against a real verb output inside the skill.
- Hunks were not tested against any skill version other than `812abd88…`.
- ADR-0008 still names `jev-1.13` as the default model. The code and `.factory.yml` use `jev-latest`.
  A follow-up note for the ADR is not part of this change.
- Vendor data-retention terms are not verified.
- CI.
