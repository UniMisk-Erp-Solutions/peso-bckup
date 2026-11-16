#!/usr/bin/env bash
# Docker layer: HAProxy + Postgres streaming + promote (local lab only).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
COMPOSE="$ROOT/tools/priyanshu-ha-lab/docker-compose.yml"
REPORT_DIR="$ROOT/tools/priyanshu-ha-lab/reports"
mkdir -p "$REPORT_DIR"
REPORT="$REPORT_DIR/docker-e2e-$(date -u +%Y%m%dT%H%M%SZ).log"
export PESOWISE_HA_LAB=1

exec > >(tee -a "$REPORT") 2>&1

echo "=== Priyanshu HA Docker E2E ==="
echo "compose=$COMPOSE"

if ! command -v docker >/dev/null 2>&1; then
  echo "SKIP: docker not installed"
  exit 0
fi

if ! docker info >/dev/null 2>&1; then
  echo "SKIP: docker daemon not running"
  exit 0
fi

docker compose -f "$COMPOSE" down -v 2>/dev/null || true
docker compose -f "$COMPOSE" up -d --build

echo "--- wait pg46 ---"
for i in $(seq 1 60); do
  docker compose -f "$COMPOSE" exec -T pg46 pg_isready -U postgres -q && break
  sleep 2
done

echo "--- wait pg68 standby ---"
for i in $(seq 1 90); do
  rec=$(docker compose -f "$COMPOSE" exec -T pg68 psql -U postgres -tAc "SELECT pg_is_in_recovery();" 2>/dev/null || echo x)
  [[ "$rec" == "t" ]] && break
  sleep 3
done

rec46=$(docker compose -f "$COMPOSE" exec -T pg46 psql -U postgres -tAc "SELECT pg_is_in_recovery();")
rec68=$(docker compose -f "$COMPOSE" exec -T pg68 psql -U postgres -tAc "SELECT pg_is_in_recovery();")
echo "pg46 recovery=$rec46 pg68 recovery=$rec68"
[[ "$rec46" == "f" && "$rec68" == "t" ]] || { echo "FAIL replication roles"; exit 1; }

docker compose -f "$COMPOSE" exec -T pg46 psql -U postgres -c \
  "INSERT INTO ha_lab_probe (node, note) VALUES ('46', 'replication_test');"
sleep 2
cnt68=$(docker compose -f "$COMPOSE" exec -T pg68 psql -U postgres -tAc "SELECT count(*) FROM ha_lab_probe;")
echo "standby row count=$cnt68"
[[ "$cnt68" -ge 2 ]] || { echo "FAIL standby did not replicate"; exit 1; }

echo "--- HAProxy ---"
curl -sf http://127.0.0.1:18088/ | grep -q app-node && echo "haproxy ok"

docker compose -f "$COMPOSE" stop app46
sleep 4
out=$(curl -sf http://127.0.0.1:18088/ || true)
echo "haproxy after app46 down: $out"
echo "$out" | grep -q 'app-node=68' || { echo "FAIL haproxy failover to app68"; exit 1; }

echo "--- simulate PG46 failure + promote pg68 ---"
docker compose -f "$COMPOSE" stop pg46
sleep 2
docker compose -f "$COMPOSE" exec -T pg68 psql -U postgres -tAc "SELECT pg_promote(true);"
sleep 3
rec68_after=$(docker compose -f "$COMPOSE" exec -T pg68 psql -U postgres -tAc "SELECT pg_is_in_recovery();")
echo "pg68 after promote recovery=$rec68_after"
[[ "$rec68_after" == "f" ]] || { echo "FAIL promote"; exit 1; }

docker compose -f "$COMPOSE" exec -T pg68 psql -U postgres -c \
  "INSERT INTO ha_lab_probe (node, note) VALUES ('68', 'after_promote');"

echo "DOCKER_PG_E2E=PASS"
echo "Report: $REPORT"
# leave stack up for inspection; caller may down
exit 0
