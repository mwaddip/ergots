#!/usr/bin/env bash
# One-command SANTA eval-corpus re-sync (conformance ledger Decision #3).
# Vendors the FULL JVM-blessed corpus as permanent regression pins; SANTA is
# upstream. Run at phase boundaries; REVIEW THE GIT DIFF before committing —
# upstream re-blessings arrive as diffs here.
#
# NO-DELETE POLICY: this script never removes local files. Lingering local
# files (present here but absent upstream) are deliberate permanent pins — a
# file removed upstream surfaces via the "local-only" report below for a
# manual decision, never auto-deleted.
set -euo pipefail
SANTA="${SANTA_VECTORS:-$HOME/projects/santa/vectors/eval}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/packages/ergoscript/test/fixtures/conformance"
for v in v5 v6; do
  for tier in spec authored; do
    mkdir -p "$DEST/$v/$tier"
    cp "$SANTA/$v/$tier"/*.json "$DEST/$v/$tier/"
  done
done
echo "synced from $SANTA"
echo "review: git -C \"$(dirname "$DEST")\" status --short -- \"$DEST\""

# Report files present locally but absent upstream (per version/tier).
# These are deliberate permanent pins (no-delete policy); a file removed
# upstream appears here so you can decide whether to keep or drop it manually.
echo ""
echo "--- local-only (withdrawn upstream?) ---"
found_any=0
for v in v5 v6; do
  for tier in spec authored; do
    local_dir="$DEST/$v/$tier"
    upstream_dir="$SANTA/$v/$tier"
    # comm -13: lines only in the second sorted input (local only)
    local_files="$(ls "$local_dir"/*.json 2>/dev/null | xargs -n1 basename | sort)"
    upstream_files="$(ls "$upstream_dir"/*.json 2>/dev/null | xargs -n1 basename | sort)"
    only_local="$(comm -13 <(echo "$upstream_files") <(echo "$local_files") 2>/dev/null || true)"
    if [ -n "$only_local" ]; then
      found_any=1
      while IFS= read -r f; do
        echo "  $v/$tier/$f"
      done <<< "$only_local"
    fi
  done
done
if [ "$found_any" -eq 0 ]; then
  echo "  (none)"
fi
