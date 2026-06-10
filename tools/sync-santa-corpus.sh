#!/usr/bin/env bash
# One-command SANTA eval-corpus re-sync (conformance ledger Decision #3).
# Vendors the FULL JVM-blessed corpus as permanent regression pins; SANTA is
# upstream. Run at phase boundaries; REVIEW THE GIT DIFF before committing —
# upstream re-blessings arrive as diffs here.
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
