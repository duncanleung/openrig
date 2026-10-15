# Daemon cron

The daemon runs orchestration-layer scheduled jobs (RIG-84, [ADR-0007](../decisions/0007-daemon-cron-for-orchestration-jobs.md)).
The first job is the fleet audit (`fleet-audit.sh`, ADR-0006).

## What runs where

| Layer | Runs on | Examples |
|---|---|---|
| Orchestration (needs the daemon's database or queue) | Daemon cron | `fleet-audit` |
| Data pipeline (must run when the daemon is down) | launchd | EDGAR, price feeds, rebalance, pure-compute quality-investor |

Data-pipeline jobs stay on launchd. They do not read the daemon's database, and they must keep
running when the daemon is stopped or restarting. Do not move them.

## Job model

- Kind: `shell` only. The command is an absolute path to an executable regular file. Its real path
  (symlinks resolved) must sit under `OPENRIG_HOME` (default `~/.openrig`) or a directory listed in
  `OPENRIG_CRON_ALLOWED_DIRS` (colon-separated, absolute). Relative paths, `..` segments, symlink
  escapes, directories, and missing files are refused at registration and again at every run.
- Arguments: an optional array of strings. They pass as argv. No shell runs.
- Schedule, in the daemon's local timezone: `daily HH:MM` or `weekly <sun..sat> HH:MM`.
  5-field cron expressions are not supported.
- Child environment: `PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`, `HOME`, and
  `OPENRIG_HOME`. Nothing else. The daemon's secrets do not reach the job. `fleet-audit.sh`
  sources its own `fleet-audit.env`.
- Timeout: `timeoutSeconds` (default 300). On timeout the daemon sends SIGTERM to the job's process
  group, then SIGKILL after 5 seconds. `last_status` becomes `timeout`.
- Catch-up: after a restart, the daemon runs the most recent missed slot once, if it is newer than
  `last_run_at` and no older than `catchupWindowSeconds` (default 21600, 6 hours). Older slots are
  skipped. A newly registered job with a slot inside the window runs once right away. Set
  `catchupWindowSeconds` to 0 to prevent that.
- Output: the last 8 KB of stdout and stderr go to `$OPENRIG_HOME/cron/<name>.log`. Each run
  overwrites the file.
- `last_status` values: `running`, `ok`, `failed` (non-zero exit), `timeout`, `error` (could not
  start), `interrupted` (daemon stopped or died mid-run).
- `last_run_at` is the schedule guard: the slot time that the daemon last claimed. A manual run
  never changes it.

## API

| Call | Purpose |
|---|---|
| `GET /api/cron/jobs` | List jobs, last result, next slot |
| `POST /api/cron/jobs` | Register or update by `name` (idempotent) |
| `PATCH /api/cron/jobs/:name` | Change `enabled`, `schedule`, `timeoutSeconds`, `catchupWindowSeconds` |
| `POST /api/cron/jobs/:name/run` | Run now and wait. `?async=1` returns 202 after the start. |

A manual run uses the same single child slot, environment, timeout, and path checks. It returns 409
if another job is running. It works on a disabled job. It records `last_status`, exit code, and
duration, and it does not move `last_run_at`.

There is no CLI command yet. Use `curl` against the daemon URL.

## Register fleet-audit

Prerequisite: `~/.openrig/fleet-audit.sh` is installed and executable, and
`~/.openrig/fleet-audit.env` holds the Pushover credentials.

```bash
DAEMON=http://127.0.0.1:7433   # use your daemon URL
curl -sS -X POST "$DAEMON/api/cron/jobs" -H 'content-type: application/json' -d "{
  \"name\": \"fleet-audit\",
  \"schedule\": \"daily 06:00\",
  \"command\": \"$HOME/.openrig/fleet-audit.sh\"
}"
```

Registration is idempotent. Run it again to update the job.

Optional seed: start the daemon with `OPENRIG_CRON_SEED_FLEET_AUDIT=1`. At startup the daemon then
creates the `fleet-audit` job if it does not exist and the script is installed. It never changes an
existing row, so an operator's edits and disable stay in place. The seed is off by default.

## Verify one run

1. List the job: `curl -sS "$DAEMON/api/cron/jobs"`. Check `nextRunAt` is the next 06:00.
2. Run it once: `curl -sS -X POST "$DAEMON/api/cron/jobs/fleet-audit/run"`.
   To avoid an alert, register a separate job named `fleet-audit-dry` with `"args": ["--dry-run"]`
   and run that first.
3. Check the result: `status` is `ok`, `exitCode` is 0. Read `~/.openrig/cron/fleet-audit.log`.
4. Check the report in `~/.openrig/fleet-audit/`.

## Cutover from launchd

Order of operations. Do not skip step 1 or reorder steps 2 and 3. While both schedulers are active,
the audit runs twice at 06:00 and sends double Pushover alerts.

1. Register the job and verify one run (above). Complete this before 06:00 or after it, not during.
2. A human stops the launchd agent:
   ```bash
   launchctl bootout gui/$(id -u)/com.openrig.fleet-audit
   mv ~/Library/LaunchAgents/com.openrig.fleet-audit.plist ~/.openrig/fleet-audit/com.openrig.fleet-audit.plist.disabled
   ```
3. Confirm no orchestration agent remains: `launchctl list | grep openrig`.
   The two `com.duncanleung.*` agents (`openrig-start`, `openrig-upstream-check`) are fork
   operations. They are not orchestration jobs. Leave them in place.
4. Next morning, confirm `GET /api/cron/jobs` shows `lastRunAt` for 06:00 and `lastStatus: "ok"`.

## Rollback

Disable the cron job first, then restore launchd. This order prevents double alerts.

1. `curl -sS -X PATCH "$DAEMON/api/cron/jobs/fleet-audit" -H 'content-type: application/json' -d '{"enabled": false}'`
2. Re-bootstrap launchd with the install steps in the header of `scripts/fleet-audit.sh`
   (they use `scripts/fleet-audit.plist.template`):
   ```bash
   sed -e "s|__SCRIPT__|$PWD/scripts/fleet-audit.sh|" -e "s|__HOME__|$HOME|g" \
     scripts/fleet-audit.plist.template > ~/Library/LaunchAgents/com.openrig.fleet-audit.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.openrig.fleet-audit.plist
   ```
3. Confirm: `launchctl list | grep fleet-audit`.

## Limits

- The audit does not run while the daemon is down. A restart within 6 hours of 06:00 runs the missed
  audit once. A longer outage skips that day.
- One child runs at a time. A manual run during a scheduled run returns 409.
