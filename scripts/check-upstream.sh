#!/usr/bin/env bash
# Fetch upstream and report new commits not yet in our main branch.
# Designed for launchd / cron; writes a report to ~/.openrig/upstream-check.md
# and prints to stdout.

set -euo pipefail

REPO_DIR="/Users/duncanleung/Documents/Develop/openrig"
REPORT_FILE="$HOME/.openrig/upstream-check.md"
REMOTE="upstream"
BRANCH="main"

cd "$REPO_DIR"

git fetch "$REMOTE" --quiet 2>/dev/null

LOCAL_HEAD=$(git rev-parse "$BRANCH" 2>/dev/null)
UPSTREAM_HEAD=$(git rev-parse "$REMOTE/$BRANCH" 2>/dev/null)

if [ "$LOCAL_HEAD" = "$UPSTREAM_HEAD" ]; then
  cat > "$REPORT_FILE" <<EOF
---
checked: $(date -u +%Y-%m-%dT%H:%M:%SZ)
status: current
new_commits: 0
---
# Upstream Check

Up to date with $REMOTE/$BRANCH at \`${UPSTREAM_HEAD:0:8}\`.
EOF
  echo "upstream-check: up to date"
  exit 0
fi

NEW_COUNT=$(git rev-list --count "$BRANCH".."$REMOTE/$BRANCH")
MERGE_BASE=$(git merge-base "$BRANCH" "$REMOTE/$BRANCH")

# Categorize commits by area
DAEMON_COUNT=$(git log --oneline "$BRANCH".."$REMOTE/$BRANCH" -- packages/daemon/ | wc -l | tr -d ' ')
CLI_COUNT=$(git log --oneline "$BRANCH".."$REMOTE/$BRANCH" -- packages/cli/ | wc -l | tr -d ' ')
SKILLS_COUNT=$(git log --oneline "$BRANCH".."$REMOTE/$BRANCH" -- packages/skills/ context/ | wc -l | tr -d ' ')
OTHER_COUNT=$((NEW_COUNT - DAEMON_COUNT - CLI_COUNT - SKILLS_COUNT))
[ "$OTHER_COUNT" -lt 0 ] && OTHER_COUNT=0

# Check for conflicts with our modified files
OUR_FILES=$(git diff --name-only "$MERGE_BASE"..HEAD 2>/dev/null || true)
THEIR_FILES=$(git diff --name-only "$MERGE_BASE".."$REMOTE/$BRANCH" 2>/dev/null || true)
OVERLAP=$(comm -12 <(echo "$OUR_FILES" | sort) <(echo "$THEIR_FILES" | sort) 2>/dev/null || true)
CONFLICT_COUNT=$(echo "$OVERLAP" | grep -c . 2>/dev/null || echo 0)

cat > "$REPORT_FILE" <<EOF
---
checked: $(date -u +%Y-%m-%dT%H:%M:%SZ)
status: behind
new_commits: $NEW_COUNT
conflict_risk_files: $CONFLICT_COUNT
---
# Upstream Check

**$NEW_COUNT new commits** on $REMOTE/$BRANCH since last merge.

## Breakdown

| Area | Commits |
|------|---------|
| daemon | $DAEMON_COUNT |
| cli | $CLI_COUNT |
| skills/context | $SKILLS_COUNT |
| other | $OTHER_COUNT |

## Recent commits

$(git log --oneline --format="- \`%h\` %s" "$BRANCH".."$REMOTE/$BRANCH" | head -30)

EOF

if [ -n "$OVERLAP" ] && [ "$CONFLICT_COUNT" -gt 0 ]; then
  cat >> "$REPORT_FILE" <<EOF
## Conflict risk

These files changed in both our branch and upstream:

$(echo "$OVERLAP" | sed 's/^/- /')

Review these before merging.
EOF
fi

echo "upstream-check: $NEW_COUNT new commits ($DAEMON_COUNT daemon, $CLI_COUNT cli, $SKILLS_COUNT skills/context). $CONFLICT_COUNT conflict-risk files."
