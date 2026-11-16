#!/usr/bin/env bash
# Remote HA lab E2E on .68 only (app46/pg46 actions via env PRIMARY_SSH from orchestrator).
set -euo pipefail

rec68=$(docker exec pesowise-ha-lab-pg68 psql -U postgres -tAc "SELECT pg_is_in_recovery();")
echo "pg68 recovery=$rec68"
[[ "$rec68" == "t" ]] || { echo "FAIL: pg68 not standby"; exit 1; }

cnt=$(docker exec pesowise-ha-lab-pg68 psql -U postgres -tAc "SELECT count(*) FROM ha_lab_probe;" 2>/dev/null || echo 0)
echo "ha_lab_probe count on standby=$cnt"

curl -sf http://127.0.0.1:18088/ | grep -q app-node && echo "haproxy ok"

echo "REMOTE_LAB_E2E_BASE=PASS"
