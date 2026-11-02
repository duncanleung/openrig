# Hook scripts

## pre-merge-review-gate.sh (RIG-176, RIG-178)

The **canonical source** for `~/.claude/hooks/pre-merge-review-gate.sh`. The global
hook lives outside the repo (wired in `~/.claude/settings.json`); this file is the
versioned reference so fresh checkouts can reproduce the installation.

Blocks `gh pr merge` unless `/code-review-dual` evidence exists:
`.ai/status/review-pr<N>.md` with a completion marker (`✅ complete`, `✅ reviewed`,
or `dual-stack`). A `bypass: <reason>` line (anchored, must start the line) is an
emergency override.

After the review-evidence check passes, delegates to `scripts/hooks/pre-merge-skill-gate.sh`
when it exists in the project (RIG-176 skill-file gate).

### Install

```bash
cp scripts/hooks/pre-merge-review-gate.sh ~/.claude/hooks/pre-merge-review-gate.sh
# Then wire in ~/.claude/settings.json PreToolUse for the Bash tool.
```

---

## pre-merge-skill-gate.sh (RIG-176)

A project-level `PreToolUse` hook delegate. Blocks `gh pr merge` when the PR touches
skill files (`.md` files under any `skills/` directory) and no human-approved gate
file exists for the current PR head SHA.

Called by `~/.claude/hooks/pre-merge-review-gate.sh` after the review-evidence check
passes. The global hook delegates here when this script exists in the project.

### Gate file

`.ai/status/skill-gate-pr<N>.md` — create with both lines present:

```
approved-sha: <40-char PR head SHA>
approved: canary-verified   # or another human approval note
```

Emergency override: `bypass: <reason>` instead of the two-line form.

### How the gate works

1. Fetches the complete PR file list via `gh api --paginate` (no 200-file truncation).
2. If no skill files changed, exits 0 immediately.
3. Checks the gate file: must exist, have `approved:` and `approved-sha:` matching the
   current head. A SHA mismatch means the PR moved after approval — re-verify and update.
4. Exits 0 (allowed) or 2 (blocked) accordingly.

### Activate it (automatic)

`~/.claude/hooks/pre-merge-review-gate.sh` already calls this script when it exists in
the project at `scripts/hooks/pre-merge-skill-gate.sh`. No extra wiring needed.

---

## post-tool-truncate.sh (RIG-125)

A `PostToolUse` hook. It caps very large tool output before the model sees it, so tool
results build up in the context window more slowly. It runs no model call.

- Every string in `tool_response` longer than 8192 bytes is cut to its first 3072
  characters, a marker, and its last 2048 characters.
- Strings are cut in place. Bash `{stdout,stderr}`, Read `{file:{content}}` and MCP
  `[{type,text}]` keep their shape.
- Output at or under the cap, image output and anything the script cannot parse pass
  through unchanged. The script is fail-open: it always exits 0.
- The full output stays in the session transcript (JSONL). Only what the model sees changes.
- It runs `jq` once; a call takes about 10 ms.

### Activate it (manual step)

This repository does not edit `~/.claude/settings.json`. A person adds the entry. Add one
element to the `hooks.PostToolUse` array and keep the existing entries:

```json
{
  "matcher": "Bash|Read|Grep|Glob|WebFetch|mcp__.*",
  "hooks": [
    {
      "type": "command",
      "command": "bash /ABSOLUTE/PATH/TO/openrig/scripts/hooks/post-tool-truncate.sh",
      "timeout": 5
    }
  ]
}
```

Replace the path with the checkout that holds the script. Requires `jq` on `PATH`.
The hook applies to new tool calls only. Results already in context stay until compaction.

### Tune or turn off

| Variable | Default | Effect |
|---|---|---|
| `OPENRIG_TRUNCATE_CAP` | 8192 | Strings longer than this many bytes are cut. |
| `OPENRIG_TRUNCATE_HEAD` | 3072 | Characters kept from the start. |
| `OPENRIG_TRUNCATE_TAIL` | 2048 | Characters kept from the end. |
| `OPENRIG_TRUNCATE_DISABLE` | unset | `1` turns the hook off. |

Roll back: remove the settings entry.

### Known limits

- The cut is lossy for the model. A needed line in the middle of a long log or file is
  hidden. The marker says how many bytes were cut. Read the file again with an offset, or
  read the transcript, when you need it.
- The cap counts bytes; the head and tail count characters. A string is cut only when it has more
  than head + tail characters and the cut result is smaller in bytes than the original, so
  multi-byte text is never made larger. The marker counts the bytes actually removed.
  `OPENRIG_TRUNCATE_TAIL=0` keeps no tail.
- `updatedToolOutput` is checked against Claude Code 2.1.308 (`hookSpecificOutput`,
  `hookEventName: "PostToolUse"`, any JSON value). It accepts any value, but only the
  strings-in-place shape was verified against the transcript record shapes, not against a
  live hook run. Confirm once after you activate it.
- A response that holds an image block (`type: "image"` or `isImage: true`, at any depth) passes through
  unchanged, so base64 data is never cut.
- Hooks for one event run in parallel on the original output. Another hook that also
  rewrites output competes with this one (last write wins).
- Measured on one 1142-result session: 133 results (12%) were over 8 KB. Cutting them
  removes about 48% of tool-result bytes.
