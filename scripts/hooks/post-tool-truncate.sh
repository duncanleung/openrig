#!/usr/bin/env bash
# RIG-125 — PostToolUse hook: cap very large tool output before the model sees it.
#
# Reads the PostToolUse JSON from stdin. Every string inside `tool_response` that is longer than
# CAP bytes is cut to its first HEAD chars + a marker + its last TAIL chars. Strings are cut in
# place, so the response keeps its shape (Bash {stdout,stderr,...}, Read {file:{content}},
# MCP [{type,text}]). Emits `updatedToolOutput` only when something was cut.
#
# Fail-open: any error (no jq, bad JSON, no tool_response, image output) exits 0 with no output,
# which leaves the tool output unchanged. The full output stays in the session transcript.
# Tunables (environment): OPENRIG_TRUNCATE_CAP (8192), OPENRIG_TRUNCATE_HEAD (3072),
# OPENRIG_TRUNCATE_TAIL (2048), OPENRIG_TRUNCATE_DISABLE=1 (turn the hook off).
set -u
trap 'exit 0' ERR
[ "${OPENRIG_TRUNCATE_DISABLE:-}" = "1" ] && exit 0
command -v jq >/dev/null 2>&1 || exit 0

cap="${OPENRIG_TRUNCATE_CAP:-8192}"
head="${OPENRIG_TRUNCATE_HEAD:-3072}"
tail="${OPENRIG_TRUNCATE_TAIL:-2048}"
case "$cap$head$tail" in *[!0-9]*) exit 0 ;; esac

jq -c --argjson cap "$cap" --argjson head "$head" --argjson tail "$tail" '
  def cut: if type == "string" and utf8bytelength > $cap
    then .[0:$head] + "\n...[truncated " + ((utf8bytelength - $head - $tail) | tostring)
      + " bytes by post-tool-truncate; full output is in the session transcript]...\n" + .[-$tail:]
    else . end;
  if (.tool_response == null) or (.tool_response | type == "object" and .isImage == true) then empty
  else
    (.tool_response) as $orig
    | ($orig | walk(cut)) as $new
    | if $new == $orig then empty
      else {hookSpecificOutput: {hookEventName: "PostToolUse", updatedToolOutput: $new}} end
  end
' 2>/dev/null || true
exit 0
