#!/usr/bin/env bash
set -euo pipefail
SUDO_PASS="${SUDO_PASSWORD:?}"
DB=supabase-db-ypwzkftxvvbjfvsll1y3aesk
run_sudo() { echo "$SUDO_PASS" | sudo -S "$@"; }
HBA=/etc/postgresql/pg_hba.conf
run_sudo docker exec "$DB" bash -lc "grep -q PESOWISE_PITR_PERSISTED $HBA || printf '\n# PESOWISE_PITR_PERSISTED\nlocal   replication     supabase_admin                          scram-sha-256\nhost    replication     supabase_admin      127.0.0.1/32        scram-sha-256\nhost    replication     replicator      192.168.23.46/32        scram-sha-256\n' >> $HBA"
run_sudo docker exec "$DB" psql -U supabase_admin -d postgres -tAc "SELECT pg_reload_conf();"
run_sudo systemctl restart pesowise-pitr-pg-receivewal.service
sleep 4
run_sudo docker exec "$DB" pgrep -af pg_receivewal | head -2
PP=$(run_sudo docker inspect "$DB" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p' | head -1)
run_sudo docker exec "$DB" psql -U supabase_admin -d postgres -c "ALTER USER replicator WITH REPLICATION PASSWORD '$PP';"
run_sudo docker exec "$DB" bash -lc 'rm -rf /tmp/pitr-base-full && runuser -u postgres -- pg_basebackup -h 127.0.0.1 -U supabase_admin -D /tmp/pitr-base-full -Fp -Xs -P'
DEST=/var/lib/pesowise-pitr-backup/base
TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$DEST/$TS"
run_sudo mkdir -p "$OUT/data"
run_sudo docker cp "$DB:/tmp/pitr-base-full/." "$OUT/data/"
run_sudo rm -f "$OUT/data/standby.signal" 2>/dev/null || true
echo ok | run_sudo tee "$OUT/SUCCESS"
echo "PITR_CHAIN_OK $OUT"
