#!/usr/bin/env bash
# Re-register context-usage-threshold watchdog jobs with smart-zone-aware
# absolute token thresholds. Run after: rig up, rig restart, or an upstream merge.
#
# The daemon's continuity-policy-materializer hardcodes 600K/900K token thresholds
# (prepare/cutover), which is deep in the dumb zone for 1M context windows.
# This script registers watchdog jobs at the research-backed thresholds:
#   - Orchestrators: 120K tokens (warn zone boundary)
#   - Other seats: 160K tokens
#
# RIG-148 tracks making this configurable in the daemon itself.
# Until then, run this script after every rig instantiation.
#
# Usage: scripts/register-compaction-watchdogs.sh [rig-name]
#   Default rig: openrig

set -euo pipefail

RIG="${1:-openrig}"
REGISTRAR="orch-lead@${RIG}"

# Seat → threshold mapping (POSIX case — no declare -A, compatible with bash 3.2)
# Orchestrators compact earlier because their context is ~80% their own thinking
SEATS="orch-lead orch-advisor dev-impl dev-memory quality-reviewer"

seat_threshold() {
  case "$1" in
    orch-lead|orch-advisor) echo 120000 ;;
    *)                      echo 160000 ;;
  esac
}

echo "Registering compaction watchdogs for rig: $RIG"
echo "Thresholds: orchestrators=120K, others=160K"
echo

for seat in $SEATS; do
  session="${seat}@${RIG}"
  threshold=$(seat_threshold "$seat")
  threshold_k=$((threshold / 1000))

  echo -n "  ${session} (${threshold_k}K tokens)... "

  result=$(rig watchdog register \
    --policy context-usage-threshold \
    --target-session "$session" \
    --interval-seconds 60 \
    --threshold-tokens "$threshold" \
    --registered-by "$REGISTRAR" \
    --message "Context usage crossed ${threshold_k}K tokens for ${session}. Run /precompact to prepare, then /compact." \
    --json 2>&1) || { echo "FAILED: $result"; continue; }

  job_id=$(echo "$result" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('jobId','?'))" 2>/dev/null)
  echo "OK (job: ${job_id})"
done

echo
echo "Done. Verify with: rig watchdog list | grep context-usage-threshold"
