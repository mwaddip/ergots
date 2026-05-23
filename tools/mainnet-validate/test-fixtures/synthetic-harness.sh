#!/bin/bash
# Synthetic harness — emits heartbeats, writes a canned error-report.json,
# exits non-zero. Used by 2j-b T6.2 to exercise the orchestrator's
# state-machine traversal (SMOKE → DIAGNOSING → ... → SMOKE) without
# spawning the real harness or paying the cost of a real 25 GB redb walk.
#
# Argument: <output-error-report-path>
# Exit 1 (signals halt) after writing the canned report.

set -euo pipefail

OUT="${1:-./error-report.json}"

echo "[heartbeat] starting at h=1 (tip=10000)"
sleep 1
for h in 100 200 300 400; do
    echo "[heartbeat] h=$h (epoch 0) — txs=$((h/10)) boxes=$((h/5)) spends=$((h/8)) — avg=10ms/blk"
    sleep 0.5
done
echo "[heartbeat] halt at h=500 — phase=evaluate-cost errorCode=cost-drift"

cat > "$OUT" <<'EOF'
{
  "timestamp": "2026-05-23T00:00:00.000Z",
  "height": 500,
  "phase": "evaluate-cost",
  "errorClass": "HarnessError",
  "errorCode": "cost-drift",
  "message": "synthetic halt for T6.2 probe",
  "location": {
    "txIndex": 0,
    "txId": "0000000000000000000000000000000000000000000000000000000000000000",
    "inputIndex": 0,
    "spentBoxId": "0000000000000000000000000000000000000000000000000000000000000000",
    "ergoTreeHex": "00d5040100"
  },
  "evaluateCost": { "expected": 100, "actual": 80, "delta": 20 },
  "bundleExcerpt": { "headerHex": "0000" }
}
EOF

exit 1
