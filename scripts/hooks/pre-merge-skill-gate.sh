#!/usr/bin/env bash
# Pre-merge skill-file gate (RIG-176). Blocks `gh pr merge` when the PR touches skill files
# and no human-approved gate file exists for the current PR head SHA.
#
# Called by ~/.claude/hooks/pre-merge-review-gate.sh after the review-evidence check passes.
# May also be wired directly as a separate PreToolUse hook (same pattern as pre-merge-review-gate).
#
# Gate file: .ai/status/skill-gate-pr<N>.md
#   Must contain:
#     approved-sha: <40-char hex>   — the PR head SHA at the time of approval
#     approved: <any text>          — completion marker (e.g. "approved: canary-verified")
#   bypass: <reason>               — emergency override (bypasses SHA check too)
#
# The gate is invalidated if the PR head moves after approval (SHA mismatch).
#
# Usage (from pre-merge-review-gate.sh):
#   bash scripts/hooks/pre-merge-skill-gate.sh <PR_NUM> <PROJECT_DIR>
#
# Exit codes:
#   0 — allowed (no skill files, gate cleared, or bypass)
#   2 — blocked (skill files detected, no approval or SHA mismatch)
set -euo pipefail

PR_NUM="${1:-}"
PROJECT_DIR="${2:-$(pwd)}"
REPO="${SKILL_GATE_REPO:-}"

if [[ -z "$PR_NUM" ]]; then
  echo "⚠ SKILL GATE: no PR number provided — skipping skill gate." >&2
  exit 0
fi

# Resolve the repo for the gh api call (required for complete file list).
if [[ -z "$REPO" ]]; then
  REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)
fi

if [[ -z "$REPO" ]]; then
  echo "⚠ SKILL GATE: could not resolve repo — skipping skill gate." >&2
  exit 0
fi

# Fetch the current PR head SHA.
HEAD_SHA=$(gh pr view "$PR_NUM" --repo "$REPO" --json headRefOid -q .headRefOid 2>/dev/null || true)

# Fetch complete file list using paginated REST API (no 200-file truncation).
# A skill file is any .md under a skills/ directory.
SKILL_FILES=$(gh api --paginate "repos/${REPO}/pulls/${PR_NUM}/files" --jq '.[].filename' 2>/dev/null \
  | grep -E '(^|/)skills/.*\.md$' || true)

if [[ -z "$SKILL_FILES" ]]; then
  exit 0  # No skill files — gate not required.
fi

SKILL_COUNT=$(echo "$SKILL_FILES" | wc -l | tr -d ' ')
GATE_FILE="$PROJECT_DIR/.ai/status/skill-gate-pr${PR_NUM}.md"

# Bypass: emergency override.
if [[ -f "$GATE_FILE" ]] && grep -qE 'bypass:' "$GATE_FILE" 2>/dev/null; then
  echo "✅ SKILL GATE: bypass accepted for PR #${PR_NUM} (${SKILL_COUNT} skill file(s))." >&2
  exit 0
fi

if [[ ! -f "$GATE_FILE" ]]; then
  echo "⛔ SKILL GATE: PR #${PR_NUM} touches ${SKILL_COUNT} skill file(s) but has no approval." >&2
  echo "   Skill files changed:" >&2
  echo "$SKILL_FILES" | head -5 | sed 's/^/     /' >&2
  echo "   Required: create .ai/status/skill-gate-pr${PR_NUM}.md containing:" >&2
  echo "     approved-sha: ${HEAD_SHA:-<pr-head-sha>}" >&2
  echo "     approved: canary-verified  # or another human approval note" >&2
  echo "   Emergency override: add 'bypass: <reason>' instead." >&2
  exit 2
fi

# Check approval marker.
if ! grep -qE '^approved:' "$GATE_FILE" 2>/dev/null; then
  echo "⛔ SKILL GATE: .ai/status/skill-gate-pr${PR_NUM}.md has no 'approved:' line." >&2
  echo "   Add 'approved: <reason>' after verifying the skill change is safe." >&2
  exit 2
fi

# Check SHA binding — the canary must match the current head.
APPROVED_SHA=$(grep -E '^approved-sha:' "$GATE_FILE" 2>/dev/null | head -1 | awk '{print $2}' || true)
if [[ -z "$APPROVED_SHA" ]]; then
  echo "⛔ SKILL GATE: .ai/status/skill-gate-pr${PR_NUM}.md has no 'approved-sha:' line." >&2
  echo "   Add 'approved-sha: ${HEAD_SHA:-<pr-head-sha>}' to bind the approval to the current commit." >&2
  exit 2
fi

if [[ -n "$HEAD_SHA" && "$APPROVED_SHA" != "$HEAD_SHA" ]]; then
  echo "⛔ SKILL GATE: PR #${PR_NUM} head has moved since approval." >&2
  echo "   Approved SHA : $APPROVED_SHA" >&2
  echo "   Current SHA  : $HEAD_SHA" >&2
  echo "   The canary is invalidated. Re-verify and update the approval file with the new SHA." >&2
  exit 2
fi

echo "✅ SKILL GATE: PR #${PR_NUM} skill-file approval confirmed (SHA ${APPROVED_SHA:0:8}…, ${SKILL_COUNT} file(s))." >&2
exit 0
