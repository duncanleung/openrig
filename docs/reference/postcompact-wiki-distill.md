# Post-compact restore-map distill to wiki (RIG-2)

After a compaction finishes, a hook reads the seat's restore map, redacts it, asks Haiku for a
short distill, redacts the answer, and writes one page to `wiki/sessions/`. The seat does nothing.

The hook lives outside this repo, in `~/.claude/hooks/`. This change ships it as a patch. A human
applies it and adds one settings entry. Nothing here edits `~/.claude`.

## Decisions (approved by `orch-lead`)

| # | Decision | How the hook does it |
|---|----------|----------------------|
| 1 | Ship as a diff plus a design doc. A human applies it. | `postcompact-wiki-distill-hook.diff` creates one new file. |
| 2 | `ANTHROPIC_API_KEY` comes from the hook environment. A human provisions it. | The hook reads the variable. It never writes it to a log, a page or argv. No key means no call. |
| 3 | Pages go to the repo `wiki/sessions/`. | The hook finds the shared checkout root and writes there, also from a worktree. |
| 4 | Redact before the call and before the write. | A port of `redactDigestString` (RIG-60) runs on the map, and again on the model answer. |
| 5 | Fire only after a successful `/compact`. | The hook is a `SessionStart` hook with matcher `compact`. Claude Code fires it with `source: "compact"` after compaction ends. A failed compaction does not fire it. |

## Correction to the first plan

The first escalation said the hook source is not in this repo. That was only half true.
`precompact-hook.mjs` has a source copy at
`packages/daemon/assets/plugins/openrig-core/skills/claude-compaction-restore/scripts/`. The
installed copy under `~/.claude/plugins/shared:openrig-core/` is refreshed on every OpenRig
upgrade. A patch to that copy would be lost. So the new hook is a separate file in
`~/.claude/hooks/`, and a plugin upgrade does not touch it. Moving it into the plugin assets is a
later option. It would ship an API call to every OpenRig user, so it needs its own decision.

## Dependencies

| Piece | Where | State |
|-------|-------|-------|
| Restore map with completion marker | `<cwd>/.openrig/compaction/preparation/<seat>/<attempt>/RESTORE-MAP.md` | Exists (managed compaction) |
| `SessionStart` with `source: "compact"` | Claude Code hook input | Documented (`SessionStartHookInput`) |
| `wiki/index.md` in the repo | this repo | Exists |
| `ANTHROPIC_API_KEY` in the Claude process environment | the human | Not verified for OpenRig seats |
| Node 18 or newer (global `fetch`) | the host | Not verified, tests ran on the local Node |

## Apply

The patch uses `-p1` paths relative to `~/.claude`. It creates one file.

| File | sha256 |
|------|--------|
| `hooks/postcompact-wiki-distill.mjs` after the patch | `42976a6ee971edae52853db9066ce40d010bf0469de2b573a5b0c63e8174314e` |
| `postcompact-wiki-distill-hook.diff` | `def95c6a6838feb432f4c119392db4cceca0f2354d476ea8a974065f42791edc` |

```bash
cd ~/.claude
test ! -e hooks/postcompact-wiki-distill.mjs && echo "ok: file absent"   # must print ok
patch -p1 --dry-run < /path/to/openrig/docs/reference/postcompact-wiki-distill-hook.diff
patch -p1 < /path/to/openrig/docs/reference/postcompact-wiki-distill-hook.diff
shasum -a 256 hooks/postcompact-wiki-distill.mjs      # must print the hash above
```

Then add this entry to the `SessionStart` array in `~/.claude/settings.json`. Keep the existing
entries. Edit the file by hand, or ask for a reviewed edit.

```json
{
  "matcher": "compact",
  "hooks": [
    {
      "type": "command",
      "command": "node \"$HOME/.claude/hooks/postcompact-wiki-distill.mjs\"",
      "timeout": 10
    }
  ]
}
```

The key must be in the environment of the Claude process that compacts. Without it, the hook
logs `skipped-no-key` and stops.

### Roll back

Remove the settings entry. Then:

```bash
cd ~/.claude
patch -p1 -R < /path/to/openrig/docs/reference/postcompact-wiki-distill-hook.diff
test ! -e hooks/postcompact-wiki-distill.mjs && echo "ok: removed"
```

Pages already written stay in `wiki/sessions/`. Delete them with `git clean` or by hand if wanted.

## What the hook does

1. Read the hook input. Stop unless the event is `SessionStart` and `source` is `compact`.
2. Stop unless `OPENRIG_SESSION_NAME` and `ANTHROPIC_API_KEY` are set.
3. Find the newest `RESTORE-MAP.md` for the seat under `<cwd>/.openrig/compaction/preparation/`.
   Stop if it is older than 15 minutes.
4. Find the shared checkout root with `git rev-parse --git-common-dir`. Stop unless
   `wiki/index.md` exists there. The hook never creates a wiki in a project that has none.
5. Start a detached child process and return. The session start is not delayed.
6. The child skips when the page for this attempt exists. Otherwise it reads at most 64 KB of the
   map, removes the completion marker, redacts, and calls the Messages API with model
   `claude-haiku-5-5`. Time limit: 25 seconds. No retry.
7. Redact the answer. Require the headings Accomplished, Decisions and Open items. Add front
   matter (seat, date, attempt, `confidence: low`). Write
   `wiki/sessions/YYYY-MM-DD-<seat>-<attempt8>.md` without overwriting.
8. Append one status line to `~/.openrig/compaction/postcompact-distill.log`. The line holds time,
   seat, attempt, outcome and an HTTP status. It holds no map text and no key.

The hook does not edit `wiki/index.md`, does not run `git add` or `git commit`, and always exits 0.

## Safety rules

- **Redaction twice.** The same patterns as `redactDigestString` run before the call and before the
  write. The hook also removes the exact value of `ANTHROPIC_API_KEY` from any text.
- **The map is data.** The prompt tells the model to ignore instructions in it. Pages carry
  `confidence: low` because other seats read the wiki and treat wiki text as untrusted.
- **No overwrite, no traversal.** Seat and attempt names pass through a character filter. The file
  is written with a hard link, so an existing page is never replaced.
- **Never blocks.** Any error is logged and the session continues.
- **Scope.** The entry sits in global settings, so the hook starts for every compaction. It does
  nothing unless a fresh OpenRig map exists in `cwd` and the repo has `wiki/index.md`.

## Tests run (on the hook file, hermetic)

A local mock of the Messages API, a temporary git repo, and a temporary `OPENRIG_HOME`. No call
went to `api.anthropic.com`. 11 checks pass:

1. Request body holds no planted secret. The page holds no planted secret and no key, even when the
   mock answer echoes them. `wiki/index.md` is unchanged. Model id and `x-api-key` header are as set.
2. No key: no call, no page.
3. `source` of `startup` or `resume`, or another event: nothing runs.
4. API status 500: no page, status logged, exit 0.
5. A second run for the same attempt makes no call and no second page.
6. No `wiki/index.md`: skipped, no `wiki/` folder created.
7. A map one hour old: skipped.
8. A model answer without the headings: no page.
9. A hostile seat name stays inside `wiki/sessions/`.
10. The hook returns in about 50 ms while the mock waits 1.5 s. The page arrives later.
11. A worktree `cwd` writes into the shared checkout.

Negative control: a copy of the hook with the redaction call before the API request removed fails
check 1 (`request leaks sk-live-...`). The real file passes.

## Known limits

- **Redaction removes useful text.** The shared 40-character base64 pattern also matches long
  absolute paths and sha256 hashes. On a real 13.8 KB restore map it made 7 replacements, for
  example `sha256 [REDACTED]` and `/[REDACTED]/.openrig/...`. Distills lose those values. A hex
  exception would help, but it would break byte equivalence with RIG-60, so this change does not
  add it.
- **Pages are untracked files.** They appear in `git status` of the main checkout. A seat or a
  human commits the useful ones, and links them from `wiki/index.md` with `/wiki-update`.
- **Data sent out.** The redacted map goes to the Anthropic API. This is the same vendor as the
  seat, but retention terms for this call are not verified.

## Not verified

- No live call to `api.anthropic.com`. The real response shape, the model id
  `claude-haiku-5-5` and the key were never exercised.
- Acceptance 1 (a real compaction produces a page) was never run. No real `SessionStart` with
  `source: "compact"` reached the hook.
- Acceptance 4 (cost near 0.01 to 0.02 USD per compaction) is a target, not a measurement. No
  pricing source was checked. Input is the map, up to 64 KB, and output is capped at 1500 tokens.
- Acceptance 3 holds by construction (the hook sends only the map) but no token count was measured.
- Whether OpenRig seats have `ANTHROPIC_API_KEY` in their environment.
- Page quality: the prompt was never run on a real model.
- Only the hook file was tested. The `settings.json` entry was not applied or run.
- Windows, Linux, and Node versions other than the local one.
- CI.
