# What changed in OpenRig 0.6.13

This note is for an agent on an install that was just upgraded to 0.6.13. It lists only what behaves differently from
0.6.12 and what to do about it. For everything OpenRig can do, read the capability map:
`rig context get onboarding-width/public-what-you-can-do.md`. Each release replaces this file, so
`rig context get reference/whats-new.md` describes the installed version once the upgraded daemon is running. Without
a running daemon, read `$OPENRIG_HOME/reference/whats-new.md`. The daemon refreshes that copy when it starts, so right
after an upgrade it can still hold the previous version's note.

## After the upgrade

- **Restart the daemon** (`rig daemon stop`, then `rig daemon start`). Migration `117` runs on every upgrade: it adds
  an empty, Codex-only `provider_account_readings` table. It fills only with `provider.usage_windows` on (off by
  default), and then keeps each resolved Codex account's readings across a restart. There's no migration `116`.
  Coming from 0.6.11 or earlier, 0.6.12's twelve migrations run first.
- **The bundled openrig-core plugin goes from 0.1.13 to 0.1.14.** Generated Claude hook commands in a project's
  `.claude/settings.local.json` call the daemon's Node by its absolute path; existing bare-`node` entries refresh on
  their own, and a person's wrapper is kept. The plugin's own manifest hooks still call bare `node`.
- **Seats pick up some changes only at their next launch:** a Pi seat's `effort` (sent as `--thinking`), a managed
  Claude seat's `EDITOR`, `VISUAL`, `DISPLAY`, `XAUTHORITY` and `WAYLAND_DISPLAY`, and the shipped agent specs' role
  file as the seat's role. Use `rig seat launch <seat> --fresh --stop --reason "<why>"` only when the person wants it
  now; don't relaunch a working team just to pick these up.
- **Slack recovery's first pass after the upgrade** scans tracked threads inside the seven-day window once from their
  root. Replies that already landed aren't delivered twice; recovered ones land as late rows that never answer a
  decision.

## Output that changed shape

- **`rig ps --nodes`** prints one line per seat after the table: `Model (<session>): configured <m>; last observed
  <model> (<source>; native record <time>)`, or `UNKNOWN (<reason>)`. JSON carries `modelObservation`; compact output
  is `[model, source, time]`, `{status: "unknown", reason}`, or `null` from an older daemon. Roster
  `live.observedModel` is now filled in.
- **`rig capture`** writes `[rig capture: <seat>: input box: <hint>]` to stderr for a Claude Code or Codex seat; stdout
  is unchanged. `--json` and the MCP tool carry `inputBox` (`status`, `confidence`, `cursor`, regions, `evidence`,
  `hint`). It's a heuristic: `unknown` means unknown.
- **`rig provider status`** rows carry a sign-in fact (`usable`, `needs sign-in`, `unknown`; JSON `signIn`). A
  signed-in Claude login never reads better than `unknown`. A signed-out Codex login reports `not_signed_in`, not
  `rpc_error`.
- **`rig provider status`** (with `provider.usage_windows` on) Codex rows keep their last reading across a daemon
  restart as history (`retained: "before_restart"`), labelled "kept from before the daemon restarted; not a current
  reading", with availability unknown until a fresh read. Rows add `accountHistory` (`linked`, or `unknown`; every
  Claude row is `unknown`), `lastObservedExhausted`, `retained` and, on an inactive account, `savedProfile: "not
  linked"`. A window whose reset has passed gains `expectation`: planning, not a reading. Run `rig provider status
  --refresh` before telling anyone an account has room.
- **`rig send`** can refuse with `caller_cancelled` (HTTP 409, `sent: false`, `inputPhase: "not_reached"`) when its
  caller went away before input started.
- **`rig seat restart --keep-conversation`** reports name a Codex startup screen: `Codex startup gate (<kind>): …`, and
  JSON gains `codexNoDaemonFlag`, `processMode` (always `unknown` for now) and `account.startupGateKind`.
- **`rig restore-check`**'s hook check can read `ready_with_caveats` where it read green; the exit code is still 0.
- **`GET /api/attention`** adds `queue-update:<qitemId>` items and a `"queue updates"` source.
- **The node-detail API's `targetPath`** names the file a guidance block is really in, or `""`; `declaredTarget` and
  `effectiveTarget` are new.
- **`rig grow --json`'s `rigId`** is the resolved id, and `rig grow` and `rig remove` can return `rig_ambiguous`.
- **The one-line installer** ends with `INSTALLED, SETUP NOT COMPLETE (exit N)` when `rig setup` isn't ready.

## Seats and restore

- **A fresh in-place Claude handover** checks a ready result from the old pane's history against the current screen,
  so the packet waits for the successor. It can still admit early when the screen, pane or process can't be read or
  proven: check that the successor read its packet.
- **A Claude launched through a wrapper script** is proven by its executable path; a restored auto-mode seat resumes
  ready.
- **After a failed restore, a ready `rig seat launch --fresh`** clears the old restore warning, and `rig seat
  clear-attention` no longer refuses for it.
- **A complete idle Claude Code or Codex screen** reads `idle` through terminal repaints.
- **Claude Code's MCP-server approval menu** reads `mcp_gate` and needs input; a restore doesn't call it ready, and an
  ordinary send is refused instead of pasted. A fresh running hook still sends into it.
- **Codex's "Trust this folder?" panel** reads `trust_gate` during launch, resume and restore.
- **A rig name with a dot** is refused at launch, at adding a member and at a first-start retry.

## Sends, wakes and the queue

- **A send whose caller went away** types nothing, then or later, if no input had started.
- **An old numbered menu in a Codex pane's scrollback** no longer blocks a send when a complete empty input box sits
  below the status row.
- **An OMP seat** whose turn ended with a typed transient provider failure (408, 429, 500, 502, 503, 504 or 529) can
  take an ordinary `rig send` retry; nothing retries on its own.
- **Parked rows for one seat that fall due in the same pass** arrive as one message naming each row.
- **A stuck-item finding on a person's item that an agent closed** goes to that agent, not the person.
- **`rig queue list --state "pending, in-progress"`** matches both states.

## New things you can do

- **Move a seat to a new working folder:** `rig seat set-cwd <seat> --cwd <absolute-path> --reason <text>` saves it
  for the next fresh launch or rebuild handover; the running agent doesn't move. Switch promptly with `rig seat launch
  <seat> --fresh --stop --reason "<why>"` or a rebuild handover, and not after a `rig down`/`rig up` or fork handover.
- **Set a Pi seat's effort:** `rig seat set-effort <seat> --effort <level> --reason "<why>"` and `rig seat effort
  <seat>` now work for Pi.
- **See which model a seat was using:** `rig ps --nodes`, `rig roster show`, `rig roster find`.
- **Use a rig name in `rig grow` and `rig remove`.**
- **Slack:** missed messages in mapped channels, recent threads and relayed channels are recovered; `rig slack status`
  shows a line per channel and a thread line.

## Off by default

- **The refocus work packet** stays off for Claude Code and Codex. With `OPENRIG_REFOCUS_WORK_PACKET=1`, its fields
  are bounded (about 160 characters per summary, 20 held and 10 next rows, about 1,500 characters per section).

## What to stop doing

- **Don't read `FAILED [4/4]` from the installer as a failed install:** the script now says `INSTALLED, SETUP NOT
  COMPLETE`, and the fix is `rig setup` again, not a reinstall.
- **Don't rely on Slack recovery for older open threads:** only threads whose root or close is within seven days are
  caught up.

## Known gaps in 0.6.13

- **On a Mac with more than one user account,** a second user's `rig` commands can reach the first user's daemon on
  its default port (7433). Running each user's daemon on its own port lets both work but doesn't keep them apart.
- **Managed compaction, refocus after a compaction and snapshot restore** behave as in 0.6.12: confirm a compaction by
  its restore request or the drop in context, and check that a restored seat is really working.
- **A fresh in-place Claude handover** can still report ready early when the screen, pane or process can't be read or
  proven.
- **One Slack app across machines** hasn't run on two real machines, and Slack recovery doesn't catch up older open
  threads.
- **`rig seat set-cwd`** checks the new folder once; switch promptly.
