#!/usr/bin/env bash
set -euo pipefail
SUDO_PASS="${SUDO_PASSWORD:?}"
PRIMARY=192.168.23.46
PORT=5432
BASE_DIR=/var/lib/pesowise-pitr-backup/base
DB=supabase-db-ypwzkftxvvbjfvsll1y3aesk
run_sudo() { echo "$SUDO_PASS" | sudo -S "$@"; }
PP=$(run_sudo docker inspect "$DB" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p' | head -1)
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
echo BASE_OK "$OUT"
