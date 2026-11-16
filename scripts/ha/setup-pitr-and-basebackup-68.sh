#!/usr/bin/env bash
set -euo pipefail
SUDO_PASS="${SUDO_PASSWORD:?}"
DB=supabase-db-ypwzkftxvvbjfvsll1y3aesk
run_sudo() { echo "$SUDO_PASS" | sudo -S "$@"; }

run_sudo docker exec "$DB" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -c \
  "SELECT pg_create_physical_replication_slot('pesowise_pitr') WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name='pesowise_pitr');"
run_sudo docker exec "$DB" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -c \
  "SELECT pg_create_physical_replication_slot('pesowise_46_standby') WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name='pesowise_46_standby');"

run_sudo systemctl restart pesowise-pitr-pg-receivewal.service || true
sleep 3
run_sudo docker exec "$DB" pgrep -af pg_receivewal | head -2 || echo "WARN: no receivewal yet"

DEST=/var/lib/pesowise-pitr-backup/base
TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$DEST/$TS"
run_sudo mkdir -p "$OUT/data"
run_sudo docker exec "$DB" bash -lc 'rm -rf /tmp/pitr-base-full && runuser -u postgres -- pg_basebackup -h /var/run/postgresql -U supabase_admin -D /tmp/pitr-base-full -Fp -Xs -P'
START_LSN=$(run_sudo docker exec "$DB" psql -U supabase_admin -d postgres -tAc "SELECT pg_current_wal_lsn();")
SYSID=$(run_sudo docker exec "$DB" psql -U supabase_admin -d postgres -tAc "SELECT system_identifier FROM pg_control_system();")
TL=$(run_sudo docker exec "$DB" psql -U supabase_admin -d postgres -tAc "SELECT timeline_id FROM pg_control_checkpoint();")
run_sudo docker cp "$DB:/tmp/pitr-base-full/." "$OUT/data/"
run_sudo rm -f "$OUT/data/standby.signal" 2>/dev/null || true
echo "ok" | run_sudo tee "$OUT/SUCCESS"
printf '{"system_identifier":"%s","timeline":"%s","start_lsn":"%s","primary":"192.168.23.68"}\n' "$SYSID" "$TL" "$START_LSN" | run_sudo tee "$OUT/metadata.json"
echo "BASE_BACKUP_OK $OUT"
