# Compaction threshold tuning (RIG-126)

Stage 2 of graduated compaction. Stage 1 is the `PostToolUse` truncation hook
(`scripts/hooks/README.md`). This page says how to measure the hook and how to lower the
compaction threshold. It does not change any setting.

## Current setting

| Key | Value | Effect |
|---|---|---|
| `policies.claude_compaction.threshold_percent` | 25 | A Claude seat is asked to compact at this share of its context window. |

Read it: `rig config get policies.claude_compaction.threshold_percent`.

## Step 1: measure a baseline

`scripts/measure-context-growth.mjs` splits session JSONL files at the time the hook was
activated and reports, for each side:

- assistant turns and tool results;
- tool results over 8192 bytes, and results the hook cut;
- tool-result bytes per turn and JSONL bytes per turn.

```bash
node scripts/measure-context-growth.mjs --activated <ISO time> \
  ~/.claude/projects/<cwd-slug>/<session>.jsonl [more files...]
```

Add `--json` for machine output. Bytes per turn is a proxy. The API gives no token rate per
turn (RIG-124). Compare sessions with a similar tool mix, such as two ticket-loop builds.
One session is not a baseline; use two or three on each side.

## Step 2: lower the threshold (human step)

Change it only after the baseline shows a lower growth rate with the hook active:

```bash
rig config set policies.claude_compaction.threshold_percent 20
```

Roll back with `rig config set policies.claude_compaction.threshold_percent 25`. An agent
does not run this command on a peer's request.

## Step 3: watch for early compaction

After the change, look for a seat that compacts within two turns of a restore. Run
`rig compact-plan` to see who is near the wall. If review seats that read many files compact
too early, restore 25.

## Not covered

The stuck-sweep false positives named in RIG-126 are not part of this page. The sweep
(`queue-stuck-sweep.ts`) has no idle-at-prompt path; it reports wake failures and unclaimed
rows. Find the firing qitems first.
