#!/usr/bin/env bash
set -euo pipefail
SUDO_PASS="${SUDO_PASSWORD:?}"
DB=supabase-db-ypwzkftxvvbjfvsll1y3aesk
run_sudo() { echo "$SUDO_PASS" | sudo -S "$@"; }
run_sudo bash -c "docker exec -i '$DB' psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 < /tmp/ha/20260925120000_ha_failover_test_events.sql"
run_sudo docker exec "$DB" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -c \
  "INSERT INTO ha_diag.failover_test_events (operation_id, note) VALUES ('rejoin-20260925', 'post-rehearsal .46 standby streaming') RETURNING id, created_at;"
echo HA_DIAG_OK
