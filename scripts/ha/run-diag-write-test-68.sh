#!/usr/bin/env bash
set -euo pipefail
SUDO_PASS="${SUDO_PASSWORD:?}"
DB=supabase-db-ypwzkftxvvbjfvsll1y3aesk
run_sudo() { echo "$SUDO_PASS" | sudo -S "$@"; }
run_sudo docker exec -i "$DB" psql -U supabase_admin -d postgres < /tmp/ha/ha_failover_test_events.sql
run_sudo docker exec "$DB" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO ha_diag.failover_test_events (operation_id, note) VALUES ('rehearsal-20260925', 'insert');
SELECT count(*) AS cnt FROM ha_diag.failover_test_events WHERE operation_id='rehearsal-20260925';
UPDATE ha_diag.failover_test_events SET note='updated' WHERE operation_id='rehearsal-20260925';
DELETE FROM ha_diag.failover_test_events WHERE operation_id='rehearsal-20260925';
SELECT 'DIAG_WRITE_TEST_OK' AS result;
SQL
