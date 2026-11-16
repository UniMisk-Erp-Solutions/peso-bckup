#!/usr/bin/env bash
# Priyanshu HA — full local E2E (bash orchestrator). Prefer: npm run test:ha-e2e
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
export PESOWISE_HA_LAB=1

if command -v node >/dev/null 2>&1; then
  exec node "$SCRIPT_DIR/ha-e2e.mjs"
fi

REPORT_DIR="$ROOT/tools/priyanshu-ha-lab/reports"
mkdir -p "$REPORT_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
MASTER="$REPORT_DIR/e2e-master-$STAMP.log"
{
  bash "$SCRIPT_DIR/run-ha-lab-tests.sh"
  bash "$SCRIPT_DIR/ha-lab-docker-e2e.sh" || true
  echo "PRIYANSHU_HA_E2E_COMPLETE"
} 2>&1 | tee "$MASTER"
