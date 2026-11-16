#!/usr/bin/env bash
# Terminate stale walsender rows on .46 (run from .68). Dry-run default.
set -euo pipefail
EXECUTE=0
PRIMARY="${PRIMARY_HOST:-192.168.23.46}"
DB=supabase-db-ypwzkftxvvbjfvsll1y3aesk

run_sudo() { echo "${SUDO_PASSWORD:?Set SUDO_PASSWORD}" | sudo -S "$@"; }
PP=$(run_sudo docker inspect "$DB" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p' | head -1)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute) EXECUTE=1; shift ;;
    *) shift ;;
  esac
done

echo "Stale walsenders (.68 client on primary):"
run_sudo docker run --rm --network host -e PGPASSWORD="$PP" supabase/postgres:15.8.1.085 \
  psql -h "$PRIMARY" -p 5432 -U supabase_admin -d postgres -x -c \
  "SELECT pid, application_name, state, replay_lag, sent_lsn, replay_lsn
   FROM pg_stat_replication WHERE client_addr = '192.168.23.68'
   ORDER BY application_name NULLS FIRST;"

if [[ "$EXECUTE" -ne 1 ]]; then
  echo "DRY RUN: would terminate rows where application_name IS NULL AND replay_lag > interval '5 minutes'"
  exit 0
fi

run_sudo docker run --rm --network host -e PGPASSWORD="$PP" supabase/postgres:15.8.1.085 \
  psql -h "$PRIMARY" -p 5432 -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_replication
   WHERE client_addr = '192.168.23.68'
     AND COALESCE(application_name,'') = ''
     AND replay_lag > interval '5 minutes';"

echo "Done. Re-check pg_stat_replication."
