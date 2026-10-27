#!/usr/bin/env bash
# Snapshot fork customizations before `git merge upstream/main` (RIG-141).
#
# Reads the ```fork-checks block in FORK_CUSTOMIZATIONS.md, collects every file
# the checks name, and for each existing file records its sha256 and its count
# of RIG-tagged lines, and saves a copy under a temp directory. The directory
# path is stored in .git/fork-premerge-snapshot so scripts/post-merge-verify.sh
# finds it. Refuses to run on a dirty tree: the snapshot must match HEAD.
#
# Usage: scripts/pre-merge-upstream.sh [--manifest FILE]

set -euo pipefail

REPO_DIR="$(git rev-parse --show-toplevel)"
MANIFEST="$REPO_DIR/FORK_CUSTOMIZATIONS.md"
if [ "${1:-}" = "--manifest" ]; then MANIFEST="$2"; fi
cd "$REPO_DIR"

[ -f "$MANIFEST" ] || { echo "pre-merge-upstream: manifest not found: $MANIFEST" >&2; exit 2; }

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "pre-merge-upstream: tracked files have uncommitted changes; commit or stash first (git stash -u)." >&2
  exit 2
fi

SNAP="$(mktemp -d "${TMPDIR:-/tmp}/fork-premerge.XXXXXX")"
mkdir -p "$SNAP/files"
: >"$SNAP/index.tsv"

# File paths are the 1st field after the type, plus the 3rd field of `callsite`.
paths="$(awk -F'|' '
  /^```fork-checks/ { b = 1; next }
  /^```/            { b = 0; next }
  b && $0 !~ /^#/ && NF >= 3 {
    t = $2; gsub(/^[ \t]+|[ \t]+$/, "", t)
    a = $3; gsub(/^[ \t]+|[ \t]+$/, "", a); print a
    if (t == "callsite") { c = $5; gsub(/^[ \t]+|[ \t]+$/, "", c); print c }
  }' "$MANIFEST" | sort -u)"

count=0; missing=0
while IFS= read -r path; do
  [ -n "$path" ] || continue
  if [ ! -f "$path" ]; then
    echo "  skip (not a file now): $path"
    missing=$((missing + 1))
    continue
  fi
  mkdir -p "$SNAP/files/$(dirname "$path")"
  cp -p "$path" "$SNAP/files/$path"
  sha="$(shasum -a 256 "$path" | cut -d' ' -f1)"
  tags="$(grep -Ec 'RIG-[0-9]+' "$path" || true)"
  printf '%s\t%s\t%s\n' "$sha" "$tags" "$path" >>"$SNAP/index.tsv"
  count=$((count + 1))
done <<<"$paths"

git rev-parse HEAD >"$SNAP/head"
printf '%s\n' "$SNAP" >"$(git rev-parse --git-path fork-premerge-snapshot)"

n_checks="$(awk '/^```fork-checks/{b=1;next} /^```/{b=0;next} b && $0 !~ /^#/ && NF>0 {n++} END{print n+0}' "$MANIFEST")"
echo "pre-merge-upstream: snapshot of $count files at HEAD $(git rev-parse --short HEAD)"
echo "  saved to:    $SNAP"
echo "  not a file:  $missing (listed above; checks on them will FAIL or show as GAP after the merge)"
echo "  sha index:   $SNAP/index.tsv"
echo
echo "After the merge, scripts/post-merge-verify.sh will run $n_checks checks and compare"
echo "these files for deletion and for dropped RIG-tagged lines."
echo
echo "Next: git merge upstream/main && scripts/post-merge-verify.sh"
