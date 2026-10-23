# What changed in OpenRig 0.6.14

This note is for an agent on an install that was just upgraded to 0.6.14. It lists only what behaves differently from
0.6.13 and what to do about it. For everything OpenRig can do, read the capability map:
`rig context get onboarding-width/public-what-you-can-do.md`. Each release replaces this file, so
`rig context get reference/whats-new.md` describes the installed version once the upgraded daemon is running. Without
a running daemon, read `$OPENRIG_HOME/reference/whats-new.md`. The daemon refreshes that copy when it starts, so right
after an upgrade it can still hold the previous version's note. Coming from 0.6.12 or earlier, also read 0.6.13's
release notes: its changes and migration `117` arrive with this upgrade.

## After the upgrade

- **Restart the daemon** (`rig daemon stop`, then `rig daemon start`). No migration runs. One setting is added,
  `transport.local_user_guard`, off by default (see below).
- **The bundled openrig-core plugin goes from 0.1.14 to 0.1.15.** Installed copies are replaced and carry refocus's own
  notes lookup.

## Output that changed shape

- **`rig ask --wake`** on a seat whose runtime isn't Claude or Codex prints `Wake runtime '<runtime>' … is not
  supported. Supported runtimes are claude and codex.` A `member@rig` target exits 2 (the daemon refuses it); a raw-id
  `--runtime` value exits 1 (the CLI refuses it). No wake starts.
- **`/healthz`** gains `euid`, the daemon's effective user ID, beside `pid`, whether or not the Mac check is on.
- **`rig compact`** (manual) waits up to 240 seconds for its result, up from 180, because preparation now has 180
  seconds, up from 120.

## Seats and restore

- **A seat that refuses every send with "Managed pane identity unavailable or changed; no input written."** because an
  older OpenRig never recorded its tmux pane can be repaired in place: `rig reconcile-session <seat>
  --repair-missing-pane --no-launch`. It fills only the missing pane and keeps the session, resume token and occupant
  generation; the result names the same session, with continuity unverified. It refuses, writing nothing, with
  `repair_not_applicable` (the binding already has a pane), `pane_ambiguous` (more than one pane or window),
  `pane_missing` (no PID), `guard_target_changed`, `guard_operation_in_progress`, `typing_guard_enabled` or
  `repair_timed_out`. Against an older daemon it reads `repair_missing_pane_unsupported` and never adopts. It records no
  event.
- **A manual `rig compact` whose preparation stops at an ordinary approval** keeps waiting within its deadline instead
  of giving up. OpenRig never answers the approval: the person, or an agent allowed to, answers it.
- **Refocus resolves each ancestor's notes file itself** (`NOTES.md`, then `MISSION_NOTES.md`) instead of starting `rig
  scope resolve-notes` per ancestor. Its output, budgets and settings are unchanged.

## New things you can do

- **Repair a missing pane without adopting:** `rig reconcile-session <seat> --repair-missing-pane --no-launch`.
- **Point a person at a page written for them:** `docs/reference/quickstart.md` ("Getting started") is the first-use
  page, with a glossary. `docs/reference/getting-started.md` is now titled "OpenRig setup reference" and opens with what
  the agent doing the setup needs; its sections and anchors are unchanged, so `rig context get
  reference/getting-started.md#…` lookups still work.

## Off by default

- **A Mac local-user check.** On a Mac shared by several accounts, `rig config set transport.local_user_guard true` (or
  `OPENRIG_TRANSPORT_LOCAL_USER_GUARD=true` in the CLI's environment) makes the CLI refuse a local daemon another account
  runs. It compares the PID and effective UID the daemon reports in `/healthz` with two `ps` readings and a second
  health response, and refuses only when they agree on another account; the refusal names `rig daemon start --port
  <unused-port>`. Missing, disagreeing or timed-out evidence, and an older daemon without `euid`, keep today's
  behaviour. No daemon restart is needed. Explicit `OPENRIG_URL` targets and registered remote hosts keep their routing,
  later browser or TUI connections aren't checked, and with it on `sudo rig …` against a user-owned daemon refuses. It
  isn't authentication: it trusts the daemon's own report. Details: `rig context get
  reference/getting-started.md#optional-mac-local-user-check`.

## What to stop doing

- **Don't use plain `rig reconcile-session` to fix a launched seat's missing pane.** It adopts the seat into a new
  session with no resume token; use `--repair-missing-pane --no-launch`.
- **Don't abandon a manual `rig compact` because preparation hit an approval.** Answer it, or ask the person to, within
  the 180 seconds.
- **Don't try `rig ask --wake` on a Pi or custom seat.** Use `rig ask` without `--wake` to search what it said, or send
  to the live seat.

## Known gaps in 0.6.14

- **The compaction and refocus fixes** are tested without a native compaction or a loaded machine: confirm a
  compaction by its restore request or the drop in context, and check that a restored seat is really working.
- **The pane repair refuses while typing protection is on.** The compaction refusal for a protected seat whose pane
  isn't recorded still suggests plain `rig reconcile-session <seat> --no-launch`, which adopts. For a running launched
  seat whose pane was never recorded, use `rig reconcile-session <seat> --repair-missing-pane --no-launch` instead;
  it needs typing protection off, so turn protection off only if the person agrees. A delivery held from before the
  repair can still refuse.
- **`rig context get reference/quickstart.md` doesn't resolve:** the page isn't in the reference context pack. Read it
  from the package's `docs/reference/` or the repository.
- **On a Mac with more than one user account,** a second user's `rig` commands can reach the first user's daemon on
  its default port (7433) unless `transport.local_user_guard` is on. The check trusts the daemon's own report, identity
  can change between the check and the connection, and direct HTTP clients aren't covered.
- **0.6.13's other known gaps still apply:** a fresh in-place Claude handover can report ready early when the screen,
  pane or process can't be read or proven; one Slack app across machines hasn't run on two real machines, and Slack
  recovery doesn't catch up older open threads; `rig seat set-cwd` checks the new folder once.
