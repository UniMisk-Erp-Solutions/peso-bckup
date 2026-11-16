#!/usr/bin/env bash
# PITR on .68 (read-replica host): WAL via pg_receivewal from .46 primary; bases on .68 disk.
set -euo pipefail
SUDO_PASS="${SUDO_PASSWORD:?}"
DB=supabase-db-ypwzkftxvvbjfvsll1y3aesk
PRIMARY=192.168.23.46
PORT=5432
SLOT=pesowise_pitr
WAL=/etc/postgresql-custom/pitr-wal
LOG=/etc/postgresql-custom/pitr-logs
BASE_DIR=/var/lib/pesowise-pitr-backup/base

run_sudo() { echo "$SUDO_PASS" | sudo -S "$@"; }

PP=$(run_sudo docker inspect "$DB" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p' | head -1)
[[ -n "$PP" ]] || { echo "FAIL: POSTGRES_PASSWORD"; exit 1; }

run_sudo systemctl stop pesowise-pitr-pg-receivewal.service 2>/dev/null || true

WRAPPER=/usr/local/bin/pesowise-pitr-pg-receivewal.sh
TMP=$(mktemp)
PP_ESC=$(printf '%s' "$PP" | sed "s/'/'\\\\''/g")
cat >"$TMP" <<EOF
#!/usr/bin/env bash
set -euo pipefail
C=$DB
docker exec "\$C" bash -lc 'mkdir -p $WAL $LOG && chown -R postgres:postgres $WAL $LOG'
docker exec "\$C" pkill -f 'pg_receivewal.*$SLOT' 2>/dev/null || true
sleep 1
docker exec -d "\$C" bash -lc 'export PGPASSWORD='"'"'$PP_ESC'"'"'; exec runuser -u postgres -- pg_receivewal -h $PRIMARY -p $PORT -U replicator -D $WAL --slot=$SLOT -v >> $LOG/receivewal.log 2>&1'
EOF
run_sudo cp "$TMP" "$WRAPPER"
rm -f "$TMP"
run_sudo chmod 755 "$WRAPPER"

UNIT=/etc/systemd/system/pesowise-pitr-pg-receivewal.service
cat >"$TMP" <<EOF
[Unit]
Description=PesoWise PITR pg_receivewal from .46 (archive on .68)
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$WRAPPER
Restart=on-failure
RestartSec=15

[Install]
WantedBy=multi-user.target
EOF
run_sudo cp "$TMP" "$UNIT"
rm -f "$TMP"

run_sudo systemctl daemon-reload
run_sudo systemctl enable pesowise-pitr-pg-receivewal.service
run_sudo systemctl restart pesowise-pitr-pg-receivewal.service
sleep 4

run_sudo docker exec "$DB" pgrep -af pg_receivewal | head -2 || { echo "FAIL: pg_receivewal"; exit 1; }

TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$BASE_DIR/$TS"
run_sudo mkdir -p "$OUT/data"
run_sudo env PGPASSWORD="$PP" docker run --rm --network host -e PGPASSWORD \
  -v "$OUT/data:/backup" \
  supabase/postgres:15.8.1.085 \
  pg_basebackup -h "$PRIMARY" -p "$PORT" -U supabase_admin -D /backup -Fp -Xs -P --no-slot

SYSID=$(run_sudo docker run --rm --network host -e PGPASSWORD="$PP" supabase/postgres:15.8.1.085 \
  psql -h "$PRIMARY" -p "$PORT" -U supabase_admin -d postgres -tAc "SELECT system_identifier FROM pg_control_system();")
TL=$(run_sudo docker run --rm --network host -e PGPASSWORD="$PP" supabase/postgres:15.8.1.085 \
  psql -h "$PRIMARY" -p "$PORT" -U supabase_admin -d postgres -tAc "SELECT timeline_id FROM pg_control_checkpoint();")
START_LSN=$(run_sudo docker run --rm --network host -e PGPASSWORD="$PP" supabase/postgres:15.8.1.085 \
  psql -h "$PRIMARY" -p "$PORT" -U supabase_admin -d postgres -tAc "SELECT pg_current_wal_lsn();")

echo ok | run_sudo tee "$OUT/SUCCESS"
printf '{"system_identifier":"%s","timeline":"%s","start_lsn":"%s","primary":"192.168.23.46","pitr_host":"192.168.23.68"}\n' "$SYSID" "$TL" "$START_LSN" | run_sudo tee "$OUT/metadata.json"
echo "PITR_68_REPLICA_OK base=$OUT"
