# Stuck-message sweeper

OpenRig delivers messages by pasting text into a seat's terminal input box and
pressing Enter. Upstream issues
[#14](https://github.com/mvschwarz/openrig/issues/14) and
[#2429](https://github.com/mvschwarz/openrig/issues/2429) describe a failure mode
where the text lands but Enter never registers, so the message sits unsubmitted
until a human notices. On an always-on host with nobody watching panes, that is
silent stall.

This fork adds `rig sweep-stuck`: a scan across every managed seat that detects
that case and, when safe, presses Enter once.

Related read-only observation lives in the RIG-123 stuck-seat observer
(`persistent_composer_input`). The observer never presses Enter. This sweeper is
the resolution path.

## Detection rules

For each running Claude Code or Codex seat:

1. Skip seats that are mid-turn (`working` / `agent_active`).
2. Skip seats at a permission or interactive prompt (the existing prompt guard /
   `classifyPermissionPrompt` / pane `attention` classifier). Never press Enter
   there — that would approve the prompt.
3. Capture the pane and read the composer with the same recognizers
   `transport.verify_input_box` / `rig send --verify` use, including Claude's
   collapsed `[Pasted text #N +M lines]` label.
4. Fingerprint the visible composer text. A seat is stuck only when the same
   fingerprint is observed twice at least `--grace-ms` apart (default **60000**).
5. Attribute the text (see safety rules). Unattributable stuck text is reported,
   never submitted.

## Safety rules for auto-Enter

Auto-Enter runs only when **all** of the following hold:

| Gate | Rule |
|---|---|
| Idle | Pane classifier reports `agent_idle` |
| Prompt | Permission/interactive prompt classification is `none` |
| Typing guard | `submitOnly` refuses with `typing_guard_enabled` → report `skipped_typing_guard`, do not force |
| Attribution | Text is clearly OpenRig-delivered (below) |
| Unchanged | Same fingerprint across ≥ grace interval |
| Retry bound | At most one Enter retry after a failed verify; never a third |

**Attributable (safe to auto-Enter):**

- Visible OpenRig `From:` / `To:` / `---` messaging envelope
- Queue-wake body (`Queue handoff: …`) inside or without that envelope
- Collapsed paste label **and** a delivery-attempt ledger hit for this occupant
  (same correlation StuckSeatObserver uses)

**Not attributable (report `needs_human`, never Enter):**

- Any other draft text (human typing, foreign content)
- Collapsed paste with no correlating delivery attempt

After Enter, the sweeper re-captures: success means the composer is empty or the
seat started a turn. Failure is reported as `auto_enter_failed` and counted as
unresolved.

## CLI

```bash
rig sweep-stuck                 # scan + safe auto-Enter
rig sweep-stuck --dry-run       # report only
rig sweep-stuck --json          # machine-readable report
rig sweep-stuck --grace-ms 90000
rig sweep-stuck --rig my-rig
rig sweep-stuck --no-auto-enter # report attributable items without Enter
```

Exit code is non-zero when any item remains unresolved (`needs_human` or
`auto_enter_failed`).

Human output lists each session, action, attribution, excerpt (≤200 chars), and
detail. JSON is the full daemon report.

## Daemon API

`POST /api/transport/sweep-stuck`

```json
{ "dryRun": false, "graceMs": 60000, "rig": null, "autoEnter": true }
```

Returns HTTP 200 when nothing unresolved remains, 409 when something still needs
a human (or auto-Enter failed), 503 when the sweeper is not wired.

## Scheduling on macOS (launchd)

Daemon cron only supports daily/weekly slots, which is too coarse for this check.
Use launchd with `StartInterval` (seconds). A template ships at
`scripts/stuck-message-sweep.plist.template`.

```bash
# Install (replace paths; StartInterval 180 = every 3 minutes)
SCRIPT="$HOME/.openrig/bin/rig"   # or $(command -v rig)
HOME_DIR="$HOME"
sed -e "s|__RIG__|$SCRIPT|g" -e "s|__HOME__|$HOME_DIR|g" \
  scripts/stuck-message-sweep.plist.template \
  > ~/Library/LaunchAgents/com.openrig.stuck-message-sweep.plist

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.openrig.stuck-message-sweep.plist
launchctl kickstart -k gui/$(id -u)/com.openrig.stuck-message-sweep
```

Logs go to `~/.openrig/stuck-message-sweep/launchd.log`. Prefer `--dry-run` for
the first day, then drop it once the report looks right.

To stop:

```bash
launchctl bootout gui/$(id -u)/com.openrig.stuck-message-sweep
```

## Notify hook

When set, each unresolved or auto-fixed item POSTs a small JSON summary to an
external webhook (generic; the receiver is whatever assistant you point at).

| Source | Name |
|---|---|
| Env | `OPENRIG_STUCK_SWEEP_NOTIFY_URL` |
| Env (optional bearer) | `OPENRIG_STUCK_SWEEP_NOTIFY_BEARER` |

Payload shape:

```json
{
  "kind": "openrig.stuck_message",
  "seat": "dev.impl",
  "session": "dev-impl@alpha",
  "rig": "alpha",
  "action": "needs_human",
  "attribution": "human_draft",
  "excerpt": "…",
  "detail": "…",
  "deliveryAttemptId": null,
  "verified": null
}
```

`action` is `auto_fixed` or `needs_human`. Secrets stay in env vars; nothing is
hard-coded. A missing URL disables notify.

## Audit

Every auto-Enter attempt emits `transport.stuck_message_enter` on the daemon
event bus (`outcome`: `verified` | `unverified` | `failed`), with a short excerpt
and optional delivery-attempt id — never the full pane dump.
