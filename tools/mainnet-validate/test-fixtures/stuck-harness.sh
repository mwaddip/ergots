#!/bin/bash
# Stuck harness — emits one startup heartbeat then goes silent for 600s.
# Used by 2j-b T6.2 to verify the Monitor-based heartbeat-watchdog fires
# 'harness-silent-heartbeat' after 5 min of silence.
#
# Skipped by default; orchestrator probe sets a short watchdog timeout
# (e.g., 10s) for the synthetic test rather than the production 5-min
# default.

set -euo pipefail

echo "[heartbeat] starting at h=1 (tip=10000)"
sleep 600
