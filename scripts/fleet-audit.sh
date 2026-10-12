#!/usr/bin/env bash
# fleet-audit.sh — daily fleet token audit with Pushover alerts (ADR-0006 guards 2 and 3).
#
# Pure shell + sqlite3 + curl. No daemon, no LLM calls. Reads daily_token_snapshots
# and review_runs from ~/.openrig/openrig.sqlite (read-only).
#
# Alerts (audited day = yesterday unless FLEET_AUDIT_DAY is set):
#   compaction spiral  seat with > COMPACTION_LIMIT compactions/day and 0 useful output   priority 0
#   cost outlier       seat with > TOKEN_LIMIT tokens/day                                 priority 0
#   output ratio       seat with > RATIO_LIMIT tokens per useful output                   priority 0
#   dormant rig        rig with no activity for DORMANT_DAYS days and no active queue work priority -1
#   weekly digest      Sundays: tokens by rig, top 5 seats, dormant rig count             priority -1
#
# Compactions: daily_token_snapshots has no compaction column. `resets` (token counter
# resets) is the proxy; it tracked the mac-fan-speed-rsi incident (2,468 resets/day).
# Useful output: review_runs rows (rig_name, seat_name, started_at day). Commits and queue
# closures are not in the database, so they are not counted.
#
# Env:
#   PUSHOVER_USER_KEY, PUSHOVER_APP_TOKEN   Pushover credentials. Missing = alerts skipped, report still written.
#   OPENRIG_HOME            default ~/.openrig
#   FLEET_AUDIT_ENV         optional env file, default $OPENRIG_HOME/fleet-audit.env
#   FLEET_AUDIT_DB          default $OPENRIG_HOME/openrig.sqlite
#   FLEET_AUDIT_DIR         default $OPENRIG_HOME/fleet-audit
#   FLEET_AUDIT_DAY         YYYY-MM-DD to audit (default: yesterday)
#   FLEET_AUDIT_WEEKLY=1    force the weekly digest on any weekday
#   COMPACTION_LIMIT (10)  TOKEN_LIMIT (10000000)  RATIO_LIMIT (10000000)
#   DORMANT_DAYS (3)  IDLE_TOKENS (100000 tokens per rig across the window counts as idle)
#   KEEP_REPORTS (30)
#
# Usage: fleet-audit.sh [--dry-run]     (--dry-run prints alerts instead of sending them)
#
# Install (launchd, daily 06:00):
#   1. Put credentials in ~/.openrig/fleet-audit.env (chmod 600), sourced by this script:
#        PUSHOVER_USER_KEY=...
#        PUSHOVER_APP_TOKEN=...      # app: https://pushover.net/apps/nqbujh-openrig
#   2. sed -e "s|__SCRIPT__|$PWD/scripts/fleet-audit.sh|" -e "s|__HOME__|$HOME|g" \
#        scripts/fleet-audit.plist.template > ~/Library/LaunchAgents/com.openrig.fleet-audit.plist
#   3. launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.openrig.fleet-audit.plist
#   Test now:  scripts/fleet-audit.sh --dry-run     Run via launchd: launchctl kickstart gui/$(id -u)/com.openrig.fleet-audit
#   Remove:    launchctl bootout gui/$(id -u)/com.openrig.fleet-audit
#   Logs: ~/.openrig/fleet-audit/launchd.log

set -euo pipefail

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

OPENRIG_HOME="${OPENRIG_HOME:-$HOME/.openrig}"
ENV_FILE="${FLEET_AUDIT_ENV:-$OPENRIG_HOME/fleet-audit.env}"
# shellcheck disable=SC1090
[[ -r "$ENV_FILE" ]] && { set -a; . "$ENV_FILE"; set +a; }
DB="${FLEET_AUDIT_DB:-$OPENRIG_HOME/openrig.sqlite}"
OUT_DIR="${FLEET_AUDIT_DIR:-$OPENRIG_HOME/fleet-audit}"
COMPACTION_LIMIT="${COMPACTION_LIMIT:-10}"
TOKEN_LIMIT="${TOKEN_LIMIT:-10000000}"
RATIO_LIMIT="${RATIO_LIMIT:-10000000}"
DORMANT_DAYS="${DORMANT_DAYS:-3}"
IDLE_TOKENS="${IDLE_TOKENS:-100000}"
KEEP_REPORTS="${KEEP_REPORTS:-30}"

log() { printf '%s fleet-audit: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" >&2; }
die() { log "ERROR $*"; exit 1; }

for n in COMPACTION_LIMIT TOKEN_LIMIT RATIO_LIMIT DORMANT_DAYS IDLE_TOKENS KEEP_REPORTS; do
  [[ "${!n}" =~ ^[0-9]+$ ]] || die "$n must be a non-negative integer (got '${!n}')"
done
command -v sqlite3 >/dev/null || die "sqlite3 not found"
[[ -r "$DB" ]] || die "database not readable: $DB"

if [[ -n "${FLEET_AUDIT_DAY:-}" ]]; then
  DAY="$FLEET_AUDIT_DAY"
else
  DAY="$(date -v-1d +%F 2>/dev/null || date -d yesterday +%F)"
fi
[[ "$DAY" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || die "bad day '$DAY'"

q() { sqlite3 -readonly -separator $'\t' "$DB" "$1"; }

# Per rig+seat totals for one day, with useful-output count. Restarts create several
# seat_session rows per seat, so group by seat.
SEAT_DAY="
WITH seat_day AS (
  SELECT s.rig_name AS rig, s.seat_name AS seat,
         SUM(s.total_tokens_delta) AS tok, SUM(s.resets) AS comp,
         (SELECT COUNT(*) FROM review_runs r
           WHERE r.rig_name = s.rig_name AND r.seat_name = s.seat_name
             AND substr(r.started_at, 1, 10) = s.day) AS outs
  FROM daily_token_snapshots s
  WHERE s.day = '$DAY' AND s.rig_name IS NOT NULL
  GROUP BY s.rig_name, s.seat_name)"

SPIRALS="$(q "$SEAT_DAY SELECT rig||'/'||seat, comp, tok FROM seat_day WHERE comp > $COMPACTION_LIMIT AND outs = 0 ORDER BY comp DESC;")"
OUTLIERS="$(q "$SEAT_DAY SELECT rig||'/'||seat, tok, outs FROM seat_day WHERE tok > $TOKEN_LIMIT ORDER BY tok DESC;")"
RATIOS="$(q "$SEAT_DAY SELECT rig||'/'||seat, tok/outs, outs FROM seat_day WHERE outs > 0 AND tok/outs > $RATIO_LIMIT ORDER BY tok/outs DESC;")"
TOTAL="$(q "SELECT COALESCE(SUM(total_tokens_delta),0), COUNT(DISTINCT seat_session) FROM daily_token_snapshots WHERE day = '$DAY';")"

# Dormant: seen in the last 30 days, under IDLE_TOKENS across the window, no review runs
# in the window, and no pending/in-progress queue items addressed to the rig.
DORMANT="$(q "
WITH win AS (
  SELECT rig_name, SUM(total_tokens_delta) AS tok FROM daily_token_snapshots
  WHERE day > date('$DAY', '-$DORMANT_DAYS day') AND day <= '$DAY' AND rig_name IS NOT NULL
  GROUP BY rig_name),
known AS (
  SELECT DISTINCT rig_name FROM daily_token_snapshots
  WHERE day > date('$DAY', '-30 day') AND day <= '$DAY' AND rig_name IS NOT NULL)
SELECT k.rig_name, COALESCE(w.tok, 0) FROM known k LEFT JOIN win w USING (rig_name)
WHERE COALESCE(w.tok, 0) < $IDLE_TOKENS
  AND NOT EXISTS (SELECT 1 FROM review_runs r WHERE r.rig_name = k.rig_name
                    AND substr(r.started_at, 1, 10) > date('$DAY', '-$DORMANT_DAYS day')
                    AND substr(r.started_at, 1, 10) <= '$DAY')
  AND NOT EXISTS (SELECT 1 FROM queue_items qi WHERE qi.state IN ('pending', 'in-progress')
                    AND qi.destination_session LIKE '%@' || k.rig_name)
ORDER BY k.rig_name;")"

count_lines() { if [[ -z "$1" ]]; then echo 0; else printf '%s\n' "$1" | wc -l | tr -d ' '; fi; }
human() { awk -v n="$1" 'BEGIN{ if (n>=1e9) printf "%.2fB", n/1e9; else if (n>=1e6) printf "%.1fM", n/1e6; else if (n>=1e3) printf "%.0fK", n/1e3; else printf "%d", n }'; }

# ---- Report ----------------------------------------------------------------
mkdir -p "$OUT_DIR"
REPORT="$OUT_DIR/$DAY.md"
{
  echo "# Fleet token audit — $DAY"
  echo
  IFS=$'\t' read -r tot_tok tot_seats <<<"$TOTAL"
  echo "Total: $(human "$tot_tok") tokens across $tot_seats seat sessions."
  echo "Limits: compactions > $COMPACTION_LIMIT/day with 0 output; tokens > $(human "$TOKEN_LIMIT")/day; tokens per output > $(human "$RATIO_LIMIT"); dormant $DORMANT_DAYS days."
  echo
  echo "## Compaction spirals ($(count_lines "$SPIRALS"))"
  if [[ -n "$SPIRALS" ]]; then while IFS=$'\t' read -r s c t; do echo "- $s: $c compactions, $(human "$t") tokens, 0 outputs"; done <<<"$SPIRALS"; else echo "None."; fi
  echo
  echo "## Cost outliers ($(count_lines "$OUTLIERS"))"
  if [[ -n "$OUTLIERS" ]]; then while IFS=$'\t' read -r s t o; do echo "- $s: $(human "$t") tokens, $o outputs"; done <<<"$OUTLIERS"; else echo "None."; fi
  echo
  echo "## Output ratio ($(count_lines "$RATIOS"))"
  if [[ -n "$RATIOS" ]]; then while IFS=$'\t' read -r s r o; do echo "- $s: $(human "$r") tokens per output ($o outputs)"; done <<<"$RATIOS"; else echo "None."; fi
  echo
  echo "## Dormant rigs ($(count_lines "$DORMANT"))"
  if [[ -n "$DORMANT" ]]; then while IFS=$'\t' read -r r t; do echo "- $r: $(human "$t") tokens in $DORMANT_DAYS days"; done <<<"$DORMANT"; else echo "None."; fi
} >"$REPORT"
cp "$REPORT" "$OUT_DIR/latest.md"
log "report written: $REPORT"

# Retention: keep the newest KEEP_REPORTS dated reports (latest.md never matches the glob).
# shellcheck disable=SC2012
ls -1 "$OUT_DIR"/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].md 2>/dev/null | sort -r | tail -n +"$((KEEP_REPORTS + 1))" | while read -r old; do rm -f -- "$old"; done

# ---- Pushover ----------------------------------------------------------------
SENT=0 FAILED=0
notify() { # title message priority
  local title="$1" message="$2" priority="$3"
  message="${message:0:1000}"
  if (( DRY_RUN )); then
    printf '[dry-run] priority=%s title=%s\n%s\n\n' "$priority" "$title" "$message"
    return 0
  fi
  if [[ -z "${PUSHOVER_USER_KEY:-}" || -z "${PUSHOVER_APP_TOKEN:-}" ]]; then
    log "NOTIFY-SKIPPED no Pushover credentials: $title"
    return 0
  fi
  local resp
  resp="$(curl --silent --show-error --max-time 30 \
    --form-string "token=$PUSHOVER_APP_TOKEN" --form-string "user=$PUSHOVER_USER_KEY" \
    --form-string "title=${title:0:250}" --form-string "message=$message" \
    --form-string "priority=$priority" https://api.pushover.net/1/messages.json 2>&1)" || true
  if [[ "$resp" == *'"status":1'* ]]; then SENT=$((SENT + 1)); else FAILED=$((FAILED + 1)); log "Pushover failed: $title: ${resp:0:200}"; fi
}

fmt() { # TSV lines + awk program -> text
  printf '%s\n' "$1" | awk -F'\t' "$2"
}

if [[ -n "$SPIRALS" ]]; then
  notify "OpenRig: compaction spiral ($DAY)" "$(fmt "$SPIRALS" '{printf "%s: %s compactions, %.1fM tokens, 0 outputs\n",$1,$2,$3/1e6}')" 0
fi
if [[ -n "$OUTLIERS" ]]; then
  notify "OpenRig: cost outlier ($DAY)" "$(fmt "$OUTLIERS" '{printf "%s: %.1fM tokens, %s outputs\n",$1,$2/1e6,$3}')" 0
fi
if [[ -n "$RATIOS" ]]; then
  notify "OpenRig: output ratio ($DAY)" "$(fmt "$RATIOS" '{printf "%s: %.1fM tokens per output (%s outputs)\n",$1,$2/1e6,$3}')" 0
fi
if [[ -n "$DORMANT" ]]; then
  notify "OpenRig: dormant rigs ($DAY)" "$(fmt "$DORMANT" '{printf "%s: %.0fK tokens\n",$1,$2/1e3}')" -1
fi

# ---- Weekly digest (Sunday) --------------------------------------------------
if [[ "$(date '+%u')" == 7 || "${FLEET_AUDIT_WEEKLY:-0}" == 1 ]]; then
  W="day > date('$DAY', '-7 day') AND day <= '$DAY'"
  BY_RIG="$(q "SELECT COALESCE(rig_name,'(none)'), SUM(total_tokens_delta) FROM daily_token_snapshots WHERE $W GROUP BY 1 ORDER BY 2 DESC LIMIT 10;")"
  TOP_SEATS="$(q "SELECT COALESCE(rig_name,'(none)')||'/'||COALESCE(seat_name,'?'), SUM(total_tokens_delta) FROM daily_token_snapshots WHERE $W GROUP BY rig_name, seat_name ORDER BY 2 DESC LIMIT 5;")"
  WEEK_TOTAL="$(q "SELECT COALESCE(SUM(total_tokens_delta),0) FROM daily_token_snapshots WHERE $W;")"
  DORMANT_N="$(count_lines "$DORMANT")"
  DIGEST="Week to $DAY: $(human "$WEEK_TOTAL") tokens. Dormant rigs: $DORMANT_N.
By rig:
$(fmt "$BY_RIG" '{printf "  %s %.1fM\n",$1,$2/1e6}')
Top seats:
$(fmt "$TOP_SEATS" '{printf "  %s %.1fM\n",$1,$2/1e6}')"
  { echo; echo "## Weekly digest"; echo '```'; echo "$DIGEST"; echo '```'; } >>"$REPORT"
  cp "$REPORT" "$OUT_DIR/latest.md"
  notify "OpenRig: weekly fleet digest" "$DIGEST" -1
fi

log "done: day=$DAY spirals=$(count_lines "$SPIRALS") outliers=$(count_lines "$OUTLIERS") ratios=$(count_lines "$RATIOS") dormant=$(count_lines "$DORMANT") sent=$SENT failed=$FAILED"
(( FAILED == 0 )) || exit 2
