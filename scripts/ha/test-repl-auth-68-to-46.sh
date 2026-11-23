#!/usr/bin/env bash
set -euo pipefail
SUDO_PASS="${SUDO_PASSWORD:?}"
run_sudo() { echo "$SUDO_PASS" | sudo -S "$@"; }
PP=$(run_sudo docker inspect supabase-db-ypwzkftxvvbjfvsll1y3aesk --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p' | head -1)
run_sudo env PGPASSWORD="$PP" docker run --rm --network host -e PGPASSWORD \
  supabase/postgres:15.8.1.085 \
  pg_basebackup -h 192.168.23.46 -p 5432 -U replicator -D /tmp/bbtest -Fp -Xs -n
echo AUTH_OK
