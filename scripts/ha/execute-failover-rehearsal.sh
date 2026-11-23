#!/usr/bin/env bash
# PesoWise controlled failover rehearsal — run from operator jump host or .46.
# Touches ONLY PesoWise containers and haproxy-pesowise config.
set -euo pipefail

# shellcheck disable=SC2034
PRIMARY_HOST=192.168.23.46
STANDBY_HOST=192.168.23.68
PRIMARY_DB=supabase-db-kar0ro1k6jiyfxzzw7acnsza
STANDBY_DB=supabase-db-ypwzkftxvvbjfvsll1y3aesk
PRIMARY_KONG=supabase-kong-kar0ro1k6jiyfxzzw7acnsza
HAPROXY_CFG=/data/coolify/proxy/haproxy-pesowise/haproxy.cfg
LOG=/var/lib/pesowise-ha/rehearsal-$(date -u +%Y%m%dT%H%M%SZ).log
mkdir -p /var/lib/pesowise-ha
exec > >(tee -a "$LOG") 2>&1

echo "=== PesoWise failover rehearsal start $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

MAINT_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "MAINTENANCE_START=$MAINT_START"
docker stop "$PRIMARY_KONG" || true

FINAL_LSN=$(docker exec "$PRIMARY_DB" psql -U supabase_admin -d postgres -tAc "SELECT pg_current_wal_lsn();")
echo "FINAL_PRIMARY_LSN=$FINAL_LSN"

echo "Waiting for .68 replay >= $FINAL_LSN (via SSH)..."
for i in $(seq 1 120); do
  R=$(ssh -o StrictHostKeyChecking=accept-new "${STANDBY_SSH}" \
    "echo ${STANDBY_SUDO_PASS} | sudo -S docker exec ${STANDBY_DB} psql -U postgres -d postgres -tAc \"SELECT pg_last_wal_replay_lsn();\"" 2>/dev/null || echo "")
  if [[ -n "$R" ]]; then
    ok=$(docker exec "$PRIMARY_DB" psql -U supabase_admin -d postgres -tAc \
      "SELECT pg_wal_lsn_diff('$FINAL_LSN'::pg_lsn, '$R'::pg_lsn) <= 0;" 2>/dev/null || echo f)
    if [[ "$ok" == "t" ]]; then
      echo "Catch-up OK at replay_lsn=$R"
      break
    fi
  fi
  sleep 2
done

FENCE_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "FENCE_START=$FENCE_AT"
PESOWISE_FENCE_CONFIRM=FENCE_46_NOW bash /home/hasto/peso-bckup-priyanshu/scripts/ha/fence-primary-46.sh --execute

ssh "${STANDBY_SSH}" "echo ${STANDBY_SUDO_PASS} | sudo -S docker run --rm --network host supabase/postgres:15.8.1.085 \
  bash -c 'timeout 2 bash -c \"echo >/dev/tcp/${PRIMARY_HOST}/5432\"' && exit 1 || exit 0"

PROMOTE_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "PROMOTE_START=$PROMOTE_AT"
ssh "${STANDBY_SSH}" "echo ${STANDBY_SUDO_PASS} | sudo -S env RUN_LOCALLY=standby PESOWISE_HA_PROMOTE_CONFIRM=PROMOTE_STANDBY_NOW \
  bash /home/hasto/peso-bckup-priyanshu/scripts/ha/promote-standby.sh --execute" || \
ssh "${STANDBY_SSH}" "echo ${STANDBY_SUDO_PASS} | sudo -S env RUN_LOCALLY=standby PESOWISE_HA_PROMOTE_CONFIRM=PROMOTE_STANDBY_NOW \
  bash /tmp/ha/promote-standby.sh --execute"

echo "Promotion done $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "LOG=$LOG"
