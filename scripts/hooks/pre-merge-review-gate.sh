#!/usr/bin/env bash
# Pre-merge review gate: blocks `gh pr merge` unless /code-review-dual evidence exists.
# RIG-176: also delegates to project-level pre-merge-skill-gate.sh when present.
# RIG-178: fixed D (input envelope), A (empty PR fail-closed), B (anchored ^bypass:).
#
# CANONICAL SOURCE: scripts/hooks/pre-merge-review-gate.sh (this file).
# Installation: copy to ~/.claude/hooks/pre-merge-review-gate.sh and wire as a
# PreToolUse hook in ~/.claude/settings.json.
#
# Evidence check: .ai/status/review-pr<N>.md must exist and contain a completion marker
# (✅ complete, ✅ reviewed, or dual-stack). If the file exists with "bypass: <reason>" on its
# own line (anchored ^bypass:), it also passes for documented emergency hotfixes.
#
# Exit codes:
#   0 — allowed (review evidence found, or command is not `gh pr merge`)
#   2 — blocked (no review evidence; stderr explains why)
set -euo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('command','') or d.get('command',''))" 2>/dev/null || echo "")

if ! echo "$COMMAND" | grep -qE 'gh\s+pr\s+merge'; then
  exit 0
fi

PR_NUM=$(echo "$COMMAND" | grep -oE '[0-9]+' 2>/dev/null | head -1 || true)
if [[ -z "$PR_NUM" ]]; then
  echo "⛔ PRE-MERGE GATE: could not extract PR number from command." >&2
  echo "   Use: gh pr merge <N> (explicit number required for review-gate verification)." >&2
  exit 2
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
REVIEW_FILE="$PROJECT_DIR/.ai/status/review-pr${PR_NUM}.md"

if [[ -f "$REVIEW_FILE" ]]; then
  if grep -qE '(✅ complete|✅ reviewed|dual-stack)' "$REVIEW_FILE" 2>/dev/null \
     || grep -qE '^bypass:' "$REVIEW_FILE" 2>/dev/null; then
    # Review gate passed — run project-level skill gate if present (RIG-176).
    SKILL_GATE_SCRIPT="$PROJECT_DIR/scripts/hooks/pre-merge-skill-gate.sh"
    if [[ -f "$SKILL_GATE_SCRIPT" ]]; then
      bash "$SKILL_GATE_SCRIPT" "$PR_NUM" "$PROJECT_DIR"
    fi
    exit 0
  fi
  echo "⚠ PRE-MERGE GATE: .ai/status/review-pr${PR_NUM}.md exists but has no completion marker." >&2
  echo "Add '✅ complete' after /code-review-dual finishes, or 'bypass: <reason>' for emergencies." >&2
  exit 2
fi

echo "⛔ PRE-MERGE GATE: No /code-review-dual evidence for PR #${PR_NUM}." >&2
echo "Expected: .ai/status/review-pr${PR_NUM}.md" >&2
echo "Run: /code-review-dual on PR #${PR_NUM}, then merge." >&2
echo "Emergency override: create .ai/status/review-pr${PR_NUM}.md with 'bypass: <reason>'." >&2
exit 2
