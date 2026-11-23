#!/usr/bin/env bash
# Isolated PITR E2E: 500 + 500 fixture rows, delete, restore to target time.
# NEVER uses PesoWise production container paths.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB_ROOT="${LAB_ROOT:-/tmp/pesowise-pitr-lab}"
WAIT_SEC="${WAIT_SEC:-30}"
EXECUTE="${EXECUTE:-1}"
PG_IMAGE="${PG_IMAGE:-postgres:15-alpine}"

echo "=== PesoWise PITR E2E LAB root=$LAB_ROOT wait=${WAIT_SEC}s ==="
rm -rf "$LAB_ROOT"
mkdir -p "$LAB_ROOT"/{wal,base,source,restore,report}

# Source postgres with archiving
docker rm -f pitr-lab-source pitr-lab-restore 2>/dev/null || true
docker run -d --name pitr-lab-source \
  -e POSTGRES_PASSWORD=labpass \
  -v "$LAB_ROOT/wal:/wal" \
  "$PG_IMAGE" \
  postgres -c wal_level=replica -c archive_mode=on -c archive_command='test ! -f /wal/%f && cp %p /wal/%f'

for i in $(seq 1 30); do
  docker exec pitr-lab-source pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 2
done
docker exec pitr-lab-source pg_isready -U postgres || { echo "source postgres not ready"; exit 1; }
export PGPASSWORD=labpass
docker exec pitr-lab-source psql -U postgres -c "
CREATE SCHEMA recovery_fixture;
CREATE TABLE recovery_fixture.expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recovery_test_id uuid NOT NULL,
  batch text NOT NULL,
  organization_id uuid NOT NULL,
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE recovery_fixture.expense_form_field_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id uuid REFERENCES recovery_fixture.expenses(id) ON DELETE CASCADE,
  recovery_test_id uuid NOT NULL,
  field_key text NOT NULL,
  field_value text
);
"

TEST_ID=$(docker exec pitr-lab-source psql -U postgres -tAc "SELECT gen_random_uuid();")
ORG_ID=$(docker exec pitr-lab-source psql -U postgres -tAc "SELECT gen_random_uuid();")
echo "recovery_test_id=$TEST_ID" | tee "$LAB_ROOT/report/ids.txt"

docker exec pitr-lab-source psql -U postgres -c "
INSERT INTO recovery_fixture.expenses (recovery_test_id, batch, organization_id, title)
SELECT '$TEST_ID', 'A', '$ORG_ID', 'fixture-A-'||g
FROM generate_series(1,500) g;
INSERT INTO recovery_fixture.expense_form_field_values (expense_id, recovery_test_id, field_key, field_value)
SELECT e.id, '$TEST_ID', 'k', 'v' FROM recovery_fixture.expenses e WHERE e.recovery_test_id='$TEST_ID' AND batch='A';
"
echo "T1=$(date -u +"%Y-%m-%d %H:%M:%S+00")" | tee -a "$LAB_ROOT/report/timeline.txt"
sleep "$WAIT_SEC"

docker exec pitr-lab-source psql -U postgres -c "
INSERT INTO recovery_fixture.expenses (recovery_test_id, batch, organization_id, title)
SELECT '$TEST_ID', 'B', '$ORG_ID', 'fixture-B-'||g
FROM generate_series(1,500) g;
INSERT INTO recovery_fixture.expense_form_field_values (expense_id, recovery_test_id, field_key, field_value)
SELECT e.id, '$TEST_ID', 'k', 'v' FROM recovery_fixture.expenses e WHERE e.recovery_test_id='$TEST_ID' AND batch='B';
"
T_PRE=$(docker exec pitr-lab-source psql -U postgres -tAc "SELECT to_char(now(), 'YYYY-MM-DD\"T\"HH24:MI:SSOF');" | tr -d ' \r\n')
echo "T_PRE_DELETE=$T_PRE" | tee -a "$LAB_ROOT/report/timeline.txt"
sleep 2
docker exec pitr-lab-source psql -U postgres -c "SELECT pg_switch_wal();"
docker exec pitr-lab-source psql -U postgres -c "CHECKPOINT;"
docker exec pitr-lab-source pg_basebackup -U postgres -D /tmp/base -Fp -Xs -P -R
docker cp pitr-lab-source:/tmp/base "$LAB_ROOT/base/data"
echo "SUCCESS" > "$LAB_ROOT/base/SUCCESS"

CNT=$(docker exec pitr-lab-source psql -U postgres -tAc "SELECT count(*) FROM recovery_fixture.expenses WHERE recovery_test_id='$TEST_ID';")
[[ "$CNT" == "1000" ]] || { echo "FAIL expected 1000 before delete got $CNT"; exit 1; }

docker exec pitr-lab-source psql -U postgres -c "DELETE FROM recovery_fixture.expenses WHERE recovery_test_id='$TEST_ID';"
CNT2=$(docker exec pitr-lab-source psql -U postgres -tAc "SELECT count(*) FROM recovery_fixture.expenses WHERE recovery_test_id='$TEST_ID';")
[[ "$CNT2" == "0" ]] || { echo "FAIL delete"; exit 1; }

docker exec pitr-lab-source psql -U postgres -c "SELECT pg_switch_wal();"

# Restore instance
docker stop pitr-lab-source
TARGET_TIME="$T_PRE"
REST_PGDATA="$LAB_ROOT/restore/pgdata"
mkdir -p "$REST_PGDATA"
cp -a "$LAB_ROOT/base/data/." "$REST_PGDATA/"
cat >> "$REST_PGDATA/postgresql.auto.conf" <<EOF
restore_command = 'cp /wal/%f %p'
recovery_target_time = '$T_PRE'
recovery_target_action = 'promote'
EOF
touch "$REST_PGDATA/recovery.signal"

docker run -d --name pitr-lab-restore \
  -e POSTGRES_PASSWORD=labpass \
  -v "$LAB_ROOT/wal:/wal:ro" \
  -v "$REST_PGDATA:/var/lib/postgresql/data" \
  -p 55432:5432 \
  "$PG_IMAGE"

echo "Waiting for recovery..."
for i in $(seq 1 60); do
  if docker exec pitr-lab-restore psql -U postgres -tAc "SELECT 1" 2>/dev/null; then break; fi
  sleep 2
done

RCNT=$(docker exec pitr-lab-restore psql -U postgres -tAc "SELECT count(*) FROM recovery_fixture.expenses WHERE recovery_test_id='$TEST_ID';" 2>/dev/null || echo 0)
EFV=$(docker exec pitr-lab-restore psql -U postgres -tAc "SELECT count(*) FROM recovery_fixture.expense_form_field_values WHERE recovery_test_id='$TEST_ID';" 2>/dev/null || echo 0)

REPORT="$LAB_ROOT/report/PITR_E2E_TEST_REPORT.md"
{
  echo "# PITR E2E lab report"
  echo "- recovery_test_id: $TEST_ID"
  echo "- target_time: $TARGET_TIME"
  echo "- expenses_recovered: $RCNT / 1000"
  echo "- efv_recovered: $EFV / 1000"
  echo "- production_touched: NO (Docker lab only)"
  if [[ "$RCNT" == "1000" && "$EFV" == "1000" ]]; then echo "- FINAL: PASS"; else echo "- FINAL: FAIL"; fi
} > "$REPORT"
cat "$REPORT"
cp "$REPORT" "$SCRIPT_DIR/../../docs/recovery/PITR_E2E_TEST_REPORT.md" 2>/dev/null || true

[[ "$RCNT" == "1000" ]] || exit 1
[[ "$EFV" == "1000" ]] || exit 1
echo "E2E PASS"
