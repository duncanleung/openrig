# GateGuard

GateGuard is a Claude Code PreToolUse hook. It denies the first file edit in a turn until the agent states concrete facts. It then allows the retry.

Status: opt-in, default off. Live seat behavior is not verified (see "Not verified").

## What it does

1. The hook runs before `Edit`, `Write`, `MultiEdit`, and `NotebookEdit`.
2. The first gated call in a turn gets a deny. The agent sees this message:

   > Before editing, present: (a) the specific files that import/consume this code, (b) the schema or interface contract, (c) the verbatim user instruction or ticket requirement.

3. The agent states the facts and retries. The retry is allowed, and so is every other gated call in the same turn.
4. A new user prompt starts a new turn. The `UserPromptSubmit` hook (`gateguard.cjs --reset`) clears the "denied this turn" marker.

## Enable

Set `OPENRIG_GATEGUARD=1` in the seat environment. The values `1`, `true`, `on`, and `yes` turn the gate on. Unset, empty, or any other value turns it off.

The plugin registration is in `packages/daemon/assets/plugins/openrig-core/hooks/claude.json`. The script is `hooks/scripts/gateguard.cjs`. Setting the variable on seats is not part of this change. Codex seats are not covered.

## Bypass rules

The gate allows these edits without a deny:

- Test files. The path has a `test`, `tests`, or `__tests__` directory segment, or the file name contains `.test.` or `.spec.`. Backslashes count as `/`.
- Trivial edits. The edit changes fewer than 5 lines:
  - `Edit`: the larger line count of `old_string` and `new_string`.
  - `MultiEdit`: the sum of that value over all edits.
  - `Write`: the line count of `content`.
  - `NotebookEdit`: the line count of `new_source`.

## Fail-open behavior

Any error allows the edit. The script exits 0 with no output when:

- stdin is empty, is not valid JSON, or has no `session_id`;
- the state directory cannot be written;
- an unexpected exception occurs;
- stdin does not close within 2 seconds.

If the script cannot save the marker, it allows the edit instead of denying again and again. An event log failure never changes the decision.

## State and event log

Per-session state: `<OPENRIG_HOME>/state/gateguard/<session>.json` with `{"deniedThisTurn": boolean}`. Session ids with characters outside `[A-Za-z0-9._-]` are hashed, so a session id cannot leave the directory.

Event log: `<OPENRIG_HOME>/state/gateguard/events.jsonl`. One JSON line per decision:

```json
{"ts":"2026-10-16T13:30:10.214Z","session":"s1","tool":"Edit","file":"/repo/src/a.ts","decision":"deny"}
```

`decision` is one of `deny`, `allow-second`, `allow-bypass-test`, `allow-bypass-trivial`, `allow-error`. Calls with the gate off write nothing. `OPENRIG_HOME` defaults to `~/.openrig`.

## How to measure

This change records events only. It does not analyze them. The before/after comparison of the review-finding rate with the gate on and off is a later ticket.

## Not verified

- Live behavior on a real Claude Code seat. Tests run the script as a child process with the documented hook JSON. No test runs it inside Claude Code.
- Whether Claude Code retries a denied edit within the same turn after it states the facts.
- Whether the deny message changes review-finding rates.
