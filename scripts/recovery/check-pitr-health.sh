#!/usr/bin/env bash
# PITR health check for PesoWise production (.46).
set -euo pipefail
FAIL=0
WARN=0
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-supabase_admin}"
WAL_DIR="${WAL_DIR:-/var/lib/docker/volumes/kar0ro1k6jiyfxzzw7acnsza_supabase-db-config/_data/pitr-wal}"
BASE_DIR="${BASE_DIR:-/var/lib/pesowise-pitr-backup/base}"
DB_CONTAINER="${PESOWISE_DB_CONTAINER:-supabase-db-kar0ro1k6jiyfxzzw7acnsza}"
SLOT="${PESOWISE_PITR_SLOT:-pesowise_pitr}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

psql_pesowise() {
  docker exec "$DB_CONTAINER" psql -U supabase_admin -d postgres -tAc "$1"
}

pass() { echo "$1: PASS"; }
fail() { echo "$1: FAIL"; FAIL=1; }
warn() { echo "$1: WARN"; WARN=1; }

echo "PESOWISE PITR HEALTH"
echo "===================="

if psql_pesowise "SELECT 1" >/dev/null 2>&1; then
  pass "Postgres"
else
  fail "Postgres"
fi

slot_line=$(psql_pesowise \
  "SELECT active||'|'||COALESCE(restart_lsn::text,'') FROM pg_replication_slots WHERE slot_name='$SLOT';" 2>/dev/null || true)
if [[ "$slot_line" == t* ]]; then
  pass "PITR slot"
elif [[ -n "$slot_line" ]]; then
  warn "PITR slot (exists but inactive: $slot_line)"
else
  fail "PITR slot"
fi

if docker exec "$DB_CONTAINER" pgrep -f "pg_receivewal.*$SLOT" >/dev/null 2>&1; then
  pass "pg_receivewal"
else
  fail "pg_receivewal"
fi

wal_check_dir="$WAL_DIR"
if [[ ! -r "$WAL_DIR" ]] && docker exec "$DB_CONTAINER" test -d /etc/postgresql-custom/pitr-wal 2>/dev/null; then
  wal_check_dir="/etc/postgresql-custom/pitr-wal"
  WAL_LIST=$(docker exec "$DB_CONTAINER" find "$wal_check_dir" -maxdepth 1 -type f ! -name '*.partial' -printf '%T@ %f\n' 2>/dev/null | sort -n | tail -1)
fi

if [[ -d "$WAL_DIR" ]] || [[ -n "${WAL_LIST:-}" ]]; then
  newest="${WAL_LIST:-$(find "$WAL_DIR" -maxdepth 1 -type f ! -name '*.partial' -printf '%T@ %f\n' 2>/dev/null | sort -n | tail -1)}"
  if [[ -n "$newest" ]]; then
    ts=${newest%% *}
    age=$(( $(date +%s) - ${ts%.*} )) || age=999999
    echo "Latest WAL: ${age} sec old"
    [[ "$age" -lt 600 ]] && pass "WAL freshness" || warn "WAL freshness"
    if [[ -r "$WAL_DIR" ]]; then
      "$SCRIPT_DIR/validate-wal-archive.sh" "$WAL_DIR" && pass "WAL continuity" || fail "WAL continuity"
    else
      seg_count=$(docker exec "$DB_CONTAINER" find "$wal_check_dir" -maxdepth 1 -type f ! -name '*.partial' 2>/dev/null | wc -l)
      [[ "${seg_count:-0}" -gt 0 ]] && pass "WAL continuity" || fail "WAL continuity"
    fi
  else
    fail "WAL continuity"
  fi
else
  fail "WAL destination"
fi

latest_base=$(find "$BASE_DIR" -name SUCCESS -printf '%T@ %h\n' 2>/dev/null | sort -n | tail -1)
if [[ -n "$latest_base" ]]; then
  bts=${latest_base%% *}
  bage=$(( ($(date +%s) - ${bts%.*}) / 3600 ))
  echo "Base backup age: ${bage} h"
  pass "Base backup"
else
  fail "Base backup"
fi

df_line=$(df -P "${WAL_DIR}" 2>/dev/null | tail -1 || true)
if [[ -z "$df_line" ]]; then
  df_line=$(df -P / 2>/dev/null | tail -1 || true)
fi
if [[ -n "$df_line" ]]; then
  pct=$(echo "$df_line" | awk '{print $5}')
  echo "Disk free: $pct used on $(echo "$df_line" | awk '{print $1}')"
fi

# Optional: archive COPY on the hasto server's 4 TB disk (DOC-161). Informational
# only: never changes OVERALL, because the copy is a snapshot, not the live receiver.
ARCHIVE_ROOT="${PESOWISE_PITR_ARCHIVE_ROOT:-/srv/immich-data/backup/pesowise-pitr}"
if [[ -d "$ARCHIVE_ROOT/wal" ]]; then
  echo "--------------------"
  "$SCRIPT_DIR/check-pitr-archive-copy.sh" "$ARCHIVE_ROOT" | sed 's/^/  [archive copy] /' || true
  echo "--------------------"
fi

echo "===================="
if [[ "$FAIL" -eq 0 && "$WARN" -eq 0 ]]; then
  echo "OVERALL: PASS"
  exit 0
elif [[ "$FAIL" -eq 0 ]]; then
  echo "OVERALL: WARN"
  exit 0
else
  echo "OVERALL: FAIL"
  exit 1
fi
