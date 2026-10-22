# Hook scripts

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
- Hooks for one event run in parallel on the original output. Another hook that also
  rewrites output competes with this one (last write wins).
- Measured on one 1142-result session: 133 results (12%) were over 8 KB. Cutting them
  removes about 48% of tool-result bytes.
