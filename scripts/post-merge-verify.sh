#!/usr/bin/env bash
# Verify fork customizations survived `git merge upstream/main` (RIG-141).
#
# Reads the ```fork-checks block in FORK_CUSTOMIZATIONS.md and runs each check
# against the working tree. Prints PASS / FAIL / GAP per check; exits 1 if any
# check FAILs. GAP lines are known-missing customizations (marked with a leading
# "!" in the manifest); they warn but do not fail, so the script stays usable
# until the gap is fixed. Remove the "!" once it is fixed so a regression fails.
#
# If scripts/pre-merge-upstream.sh ran first, also compares the pre-merge
# snapshot: a snapshotted file that is gone FAILs, and a file whose count of
# RIG-tagged lines dropped WARNs (a generic net for drops no check covers).
#
# Usage: scripts/post-merge-verify.sh [--manifest FILE]

set -uo pipefail

REPO_DIR="$(git rev-parse --show-toplevel)"
MANIFEST="$REPO_DIR/FORK_CUSTOMIZATIONS.md"
if [ "${1:-}" = "--manifest" ]; then MANIFEST="$2"; fi
cd "$REPO_DIR"

[ -f "$MANIFEST" ] || { echo "post-merge-verify: manifest not found: $MANIFEST" >&2; exit 2; }

pass=0; fail=0; gap=0; warn=0

report() { # status id message
  case "$1" in
    PASS) pass=$((pass + 1)) ;;
    FAIL) fail=$((fail + 1)) ;;
    GAP)  gap=$((gap + 1)) ;;
  esac
  printf '%-5s %s  %s\n' "$1" "$2" "$3"
}

# Trim leading/trailing whitespace without xargs (xargs eats backslashes and quotes).
trim() { local v="$1"; v="${v#"${v%%[![:space:]]*}"}"; printf '%s' "${v%"${v##*[![:space:]]}"}"; }

# ---- check engine -----------------------------------------------------------
# Each function echoes a failure reason and returns 1, or returns 0.

chk_file() { [ -f "$1" ] || { echo "missing file $1"; return 1; }; }

chk_has() { # file ere
  [ -f "$1" ] || { echo "missing file $1"; return 1; }
  grep -Eq -- "$2" "$1" || { echo "no match for /$2/ in $1"; return 1; }
}

# SYMBOL is declared in DEFFILE and invoked (not declared) in CALLERFILE.
# A rename upstream, or a deleted caller, fails this even if the name still
# appears in a comment: comment lines are ignored.
chk_callsite() { # deffile symbol callerfile
  local def="$1" sym="$2" caller="$3"
  [ -f "$def" ] || { echo "missing file $def"; return 1; }
  [ -f "$caller" ] || { echo "missing file $caller"; return 1; }
  grep -Eq -- "(function|async|private|public|protected|static|const|class)[[:space:]]+${sym}[[:space:]]*[(<=]|^[[:space:]]+(async[[:space:]]+)?${sym}[[:space:]]*[(<]" "$def" \
    || { echo "$sym not declared in $def"; return 1; }
  grep -E -- "(^|[^A-Za-z0-9_])${sym}[[:space:]]*\(" "$caller" \
    | grep -Ev -- "^[[:space:]]*(//|\*|/\*)" \
    | grep -Evq -- "(function|private|public|protected|static)[[:space:]]+(async[[:space:]]+)?${sym}[[:space:]]*[(<]" \
    || { echo "$sym is not called in $caller"; return 1; }
}

# Members of an exported array literal: `export const NAME ... = [` to the
# first line that is `];`. Prints one identifier per entry line.
array_members() { # file name
  awk -v n="$2" '
    $0 ~ "^export const " n "[: =]" { f = 1; next }
    f && /^\];/ { exit }
    f && /^[[:space:]]+[A-Za-z_][A-Za-z0-9_]*,?[[:space:]]*(\/\/.*)?$/ { gsub(/[ ,\t]/, "", $0); sub(/\/\/.*/, "", $0); print $1 }
  ' "$1"
}

chk_array_min() { # file name min
  [ -f "$1" ] || { echo "missing file $1"; return 1; }
  local n; n="$(array_members "$1" "$2" | wc -l | tr -d ' ')"
  [ "$n" -ge "$3" ] || { echo "$2 has $n entries, manifest expects >= $3"; return 1; }
}

chk_array_has() { # file name id1,id2,...
  [ -f "$1" ] || { echo "missing file $1"; return 1; }
  local members id missing=""
  members="$(array_members "$1" "$2")"
  for id in ${3//,/ }; do
    printf '%s\n' "$members" | grep -qx -- "$id" || missing="$missing $id"
    grep -Eq -- "^import \{[^}]*\b${id}\b[^}]*\} from" "$1" || missing="$missing $id(import)"
  done
  [ -z "$missing" ] || { echo "$2 missing:$missing"; return 1; }
}

run_check() { # type args...
  local type="$1"; shift
  case "$type" in
    file)        chk_file "$1" ;;
    has)         chk_has "$1" "$2" ;;
    callsite)    chk_callsite "$1" "$2" "$3" ;;
    array_min)   chk_array_min "$1" "$2" "$3" ;;
    array_has)   chk_array_has "$1" "$2" "$3" ;;
    *)           echo "unknown check type '$type'"; return 1 ;;
  esac
}

# ---- run manifest -----------------------------------------------------------
echo "post-merge-verify: manifest $(basename "$MANIFEST"), HEAD $(git rev-parse --short HEAD)"
echo

in_block=0
while IFS= read -r line; do
  case "$line" in
    '```fork-checks') in_block=1; continue ;;
    '```') in_block=0; continue ;;
  esac
  [ "$in_block" = 1 ] || continue
  case "$line" in ''|'#'*) continue ;; esac

  IFS='|' read -r id type a1 a2 a3 <<<"$line"
  id="$(trim "$id")"; type="$(trim "$type")"
  a1="$(trim "$a1")"; a2="$(trim "${a2:-}")"; a3="$(trim "${a3:-}")"
  known_gap=0
  case "$id" in '!'*) known_gap=1; id="${id#!}" ;; esac
  id="$(trim "$id")"

  if reason="$(run_check "$type" "$a1" "$a2" "$a3")"; then
    if [ "$known_gap" = 1 ]; then
      report FAIL "$id" "marked as a known gap but now passes: remove the leading '!' in the manifest"
    else
      report PASS "$id" "$type $a1${a2:+ :: $a2}${a3:+ :: $a3}"
    fi
  else
    if [ "$known_gap" = 1 ]; then report GAP "$id" "$reason"; else report FAIL "$id" "$reason"; fi
  fi
done <"$MANIFEST"

# ---- compare against the pre-merge snapshot ---------------------------------
SNAP_PTR="$(git rev-parse --git-path fork-premerge-snapshot)"
if [ -f "$SNAP_PTR" ] && SNAP="$(cat "$SNAP_PTR")" && [ -d "$SNAP/files" ]; then
  echo
  echo "snapshot: $SNAP"
  while IFS=$'\t' read -r sha tags path; do
    if [ ! -f "$path" ]; then
      report FAIL "snapshot" "customized file is gone after merge: $path"
      continue
    fi
    now="$(grep -Ec 'RIG-[0-9]+' "$path" || true)"
    if [ "$now" -lt "$tags" ]; then
      warn=$((warn + 1))
      printf '%-5s %s  %s\n' WARN snapshot "$path: RIG-tagged lines $tags -> $now (inspect: diff $SNAP/files/$path $path)"
    fi
  done <"$SNAP/index.tsv"
else
  echo
  echo "snapshot: none (run scripts/pre-merge-upstream.sh before the merge to enable file-drop detection)"
fi

echo
echo "post-merge-verify: $pass passed, $fail failed, $gap known gaps, $warn warnings"
[ "$fail" -eq 0 ] || { echo "post-merge-verify: FAILED. Fork customizations were dropped; fix before pushing." >&2; exit 1; }
