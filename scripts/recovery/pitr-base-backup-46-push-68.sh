#!/usr/bin/env bash
# Local base backup on .46 primary; copy SUCCESS dir to .68 base path via scp.
set -euo pipefail
DB=supabase-db-kar0ro1k6jiyfxzzw7acnsza
DEST=/var/lib/pesowise-pitr-backup/base
TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$DEST/$TS"
mkdir -p "$OUT/data"
docker exec "$DB" bash -lc 'rm -rf /tmp/pitr-base-local && runuser -u postgres -- pg_basebackup -h /var/run/postgresql -U supabase_admin -D /tmp/pitr-base-local -Fp -Xs -P'
docker cp "$DB:/tmp/pitr-base-local/." "$OUT/data/"
rm -f "$OUT/data/standby.signal" 2>/dev/null || true
echo ok >"$OUT/SUCCESS"
SYSID=$(docker exec "$DB" psql -U supabase_admin -tAc "SELECT system_identifier FROM pg_control_system();")
TL=$(docker exec "$DB" psql -U supabase_admin -tAc "SELECT timeline_id FROM pg_control_checkpoint();")
LSN=$(docker exec "$DB" psql -U supabase_admin -tAc "SELECT pg_current_wal_lsn();")
printf '{"system_identifier":"%s","timeline":"%s","start_lsn":"%s","primary":"192.168.23.46","pitr_host":"192.168.23.68"}\n' "$SYSID" "$TL" "$LSN" >"$OUT/metadata.json"
echo "Packaging for .68 ..."
tar -C "$DEST" -czf "/tmp/pitr-base-${TS}.tar.gz" "$TS"
sshpass -p 'qwertyui' scp -o StrictHostKeyChecking=no "/tmp/pitr-base-${TS}.tar.gz" mithil@192.168.23.68:/tmp/
ssh -o StrictHostKeyChecking=no mithil@192.168.23.68 "echo qwertyui | sudo -S mkdir -p $DEST && echo qwertyui | sudo -S tar -xzf /tmp/pitr-base-${TS}.tar.gz -C $DEST && echo qwertyui | sudo -S rm /tmp/pitr-base-${TS}.tar.gz"
echo "BASE_OK $TS on .68"
