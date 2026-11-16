#!/usr/bin/env bash
set -euo pipefail
SUDO_PASS="${SUDO_PASSWORD:?}"
DB=supabase-db-ypwzkftxvvbjfvsll1y3aesk
PRIMARY=192.168.23.46
FINAL="${1:?FINAL_LSN required}"
run_sudo() { echo "$SUDO_PASS" | sudo -S "$@"; }
PP=$(run_sudo docker inspect "$DB" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p' | head -1)
for i in $(seq 1 90); do
  R=$(run_sudo docker exec "$DB" psql -U postgres -d postgres -tAc "SELECT pg_last_wal_replay_lsn();")
  diff=$(run_sudo docker run --rm --network host -e PGPASSWORD="$PP" supabase/postgres:15.8.1.085 \
    psql -h "$PRIMARY" -p 5432 -U supabase_admin -d postgres -tAc "SELECT pg_wal_lsn_diff('${FINAL}'::pg_lsn, '${R}'::pg_lsn);" 2>/dev/null || echo 999)
  echo "attempt=$i replay=$R diff=$diff"
  if [[ "$diff" == "0" || "$diff" -lt 0 ]]; then
    echo CATCHUP_OK
    exit 0
  fi
  sleep 2
done
echo CATCHUP_FAIL
exit 1
