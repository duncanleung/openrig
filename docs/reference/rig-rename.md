# Rig rename

`rig rename <old> <new>` (RIG-61) renames a stopped rig in the daemon's database and under
`OPENRIG_HOME` in one operation. If a step fails, the daemon undoes it.

## Usage

```bash
rig rename poly-copy prediction-market            # print the plan, change nothing
rig rename poly-copy prediction-market --yes      # apply
rig rename poly-copy prediction-market --json     # machine-readable plan or result
rig rename --recover                              # undo a rename that did not finish
```

- Without `--yes` the command prints the plan and changes nothing. `--dry-run` does the same and
  wins over `--yes`.
- Exit codes: 0 plan printed or rename done. 1 refused (a blocker, a bad name, or an unknown rig).
  2 the daemon reported a failure.
- The new name uses letters, digits, `-`, `_` and `.`. It starts with a letter or digit and has at
  most 64 characters. It cannot contain `@`, a path separator, or `..`.
- Every archived or active rig that has the old name is renamed.

## Pre-check (what blocks a rename)

The rig must be quiescent. `rig rename` never stops a rig for you. Run `rig down <old>` first. The
command lists every blocker at once.

| Code | Blocks when |
|---|---|
| `live_sessions` | A session of the rig has a status other than `exited`, `superseded` or `detached` |
| `live_tmux_sessions` | tmux still has a session with a name of the rig |
| `active_workflows` | A workflow instance bound to the rig, or created by one of its seats, has status `active` or `waiting` |
| `open_queue_items` | A queue item in state `pending`, `in-progress` or `blocked` has the rig as source, destination or hand-off target |
| `active_watchdog_jobs` | A watchdog job in state `active` targets a seat of the rig |
| `name_collision_rig` | Any rig, active or archived, already has the new name |
| `name_collision_files` | A spec file, spec directory, `topology/rigs/<new>`, `transcripts/<new>`, `refocus/<new>` or a `seat@<new>.*` state file exists |
| `new_name_in_history` | Rows in the database already refer to the new name (a deleted rig used it). The compensating update could not be exact, so the rename is refused. |
| `journal_present` | An earlier rename did not finish (see Recovery) |
| `rename_in_progress` | Another rename runs in this daemon |

The database checks run again inside the transaction. A seat that starts after the pre-check cannot
slip through.

## What is renamed

### Database (one transaction)

The manifest in `packages/daemon/src/domain/rig-rename-manifest.ts` is the only list of columns. It has
four kinds of column:

| Kind | Rewrite |
|---|---|
| `rig-name` | The column equals the old name. Set it to the new name. |
| `session` | The value is `seat@rig`. Change it only when the text after the **first** `@` equals the old name. `x@old-2`, `old@host` and `a@b@old` stay as they are. |
| `json` | Parse the JSON. Rewrite strings and object keys as `session`, and values under `rig`, `target_rig`, `bound_rig`, `rigName`, `rig_name`, `targetRig`, `boundRig` when they equal the old name. |
| `text` | YAML text. Rewrite `@old` where the rig name ends at a boundary. |

Covered tables: `rigs`, `sessions`, `bindings`, `context_usage`, `seat_identity_verdicts`,
`session_digests`, `daily_token_snapshots`, `usage_samples`, `review_runs`, `queue_items`,
`queue_transitions`, `queue_transitions_archive`, `inbox_entries`, `outbox_entries`, `stream_items`,
`watchdog_jobs`, `watchdog_history`, `workflow_specs`, `workflow_instances`, `workflow_step_trails`,
`mission_control_actions`, `classifier_leases`, `classification_attempts`, `project_classifications`,
`views_custom`, `chat_messages`, `thread_seat_map`, `thread_part_map`, `node_permission_selections`,
`seat_delivery_guards`, `seat_delivery_guard_changes`, `nodes`.

A test (`rig-rename-manifest.test.ts`) migrates a database with the real migrations. It fails when a
text column named like a rig or a session is neither in the manifest nor in the justified exclusion
list. A migration cannot add such a column silently. SQL identifiers come from the manifest only. The
old and new names are bound parameters.

### Files under `OPENRIG_HOME`

| Where | Change |
|---|---|
| `specs/**` rig spec | `name:` line edited in place (comments and layout stay), `seat@old` references rewritten. A file named `<old>.yaml` or a directory `<old>/` that holds the spec is renamed. |
| Workflow spec files | `target.rig` / `target_rig` and `seat@old` in `preferred_targets` rewritten. Files come from the spec roots and from `workflow_specs.source_path`. Built-in specs shipped with the daemon are never edited. |
| `state/provider-usage`, `state/context-usage`, `provider-usage`, `context` | Each `*.json` is parsed and rewritten. File names can be `seat@old.json` or a UUID, so the content decides. Files named `seat@old.*` are renamed. |
| `compaction/restore-pending` | Same as above. |
| `topology/rigs/<old>`, `refocus/<old>` | Text files rewritten, directory renamed. |
| `prompts` | `seat@old.*` files renamed, text rewritten. |
| `transcripts/<old>`, `logs` | Directory and `seat@old.*` files renamed in place. Content is never rewritten. |

Files above 2 MB, symbolic links, and built-in specs are skipped and listed in the plan.

After a successful rename the daemon scans the state directories for the old name and reports what is
left. Hits are reported, not rewritten.

## What is NOT renamed

- Live sessions and their tmux names. The rig must be stopped, so v1 has no live rename. After
  `rig up <new>` the seats get tmux names with the new rig name.
- Transcript text, log text, queue message bodies, chat bodies and `events.payload`. They are history.
- Compose project names of rig services. They derive from the rig name at the next `rig up`.
- Any project, repository or workspace directory that happens to contain the old name.

## Order and design

```
validate -> pre-check -> journal -> DB transaction -> file ops (journaled) -> verify -> drop journal
```

The daemon does both halves, because it resolves `OPENRIG_HOME` and holds the database. The CLI only
asks and prints.

1. The daemon writes the journal `OPENRIG_HOME/run/rig-rename-journal.json` before it changes anything.
   Each file edit first copies the original to `run/rig-rename-journal.backup/`.
2. The database is first because one transaction is atomic. If it fails, nothing is on disk yet.
3. File ops run in a fixed order: content rewrites, file renames, then directory renames. Each op is
   recorded in the journal before and after it runs.
4. Verify: no manifest column still refers to the old name, every rename landed, and every rewritten
   file has the planned bytes.
5. Success removes the journal.

A single-flight lock stops two renames from overlapping inside the daemon. A journal on disk blocks
every new rename until it is resolved.

## Recovery

If a file step or the verify step fails, the daemon:

1. rolls back the files in reverse from the journal, then
2. runs the same manifest the other way (new to old) in one transaction.

Outcomes:

| Result | Meaning |
|---|---|
| `rename_failed_rolled_back` (HTTP 500, CLI exit 2) | Everything is restored. Nothing changed. The journal is gone. |
| `rename_recovery_required` with state `rollback-failed` | A file could not be restored. The database was **not** reverted and still uses the new name. The journal is kept. |
| `rename_recovery_required` with state `compensation-failed` | The files are restored but the database could not be reverted. The journal is kept. |

For a `rename_recovery_required` error: fix the cause named in the message, then run
`rig rename --recover`. Recovery rolls back every started or finished op in the journal and then
reverses the database if it still uses the new name. It is safe to run more than once. If the daemon
dies mid-rename, the journal stays and the next `rig rename` refuses with the journal path. Run
`rig rename --recover` then.

Manual recovery, if `--recover` cannot run: read `run/rig-rename-journal.json`. For each op in state
`started` or `done`, undo it from the last op to the first: rename `to` back to `from`, or copy the
`backup` file over `path`. Then rewrite every manifest column from the new name back to the old name.
Delete the journal and its `.backup` directory last.

## API

| Call | Purpose |
|---|---|
| `POST /api/rigs/:name/rename` | Body `{ "newName": string, "dryRun"?: boolean }`. Returns the plan (rows per column, file ops, blockers). 200 plan or done, 400 bad name, 404 no such rig, 409 blocked, 500 failed. |
| `GET /api/rig-rename/journal` | The journal of an unfinished rename, or `{ "journal": null }` |
| `POST /api/rig-rename/recover` | Roll back an unfinished rename from its journal |

## Limits

- One rename at a time per daemon.
- The rename does not refresh in-memory state of the running daemon. The database and files are the
  source of truth. If a view still shows the old name, restart the daemon.
- Closed queue items that name the rig (`seat@<old>`) are renamed with it. Open items block the rename.
