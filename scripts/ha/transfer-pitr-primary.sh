#!/usr/bin/env bash
# Enable PITR on the current writable primary (run ON primary host after promotion).
set -euo pipefail
EXECUTE=0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RECOVERY_DIR="$(cd "$SCRIPT_DIR/../recovery" && pwd)"
DB_CONTAINER="${PESOWISE_DB_CONTAINER:-}"
SLOT="${PESOWISE_PITR_SLOT:-pesowise_pitr}"
WAL_DIR="${WAL_DIR:-}"
BASE_DIR="${BASE_DIR:-/var/lib/pesowise-pitr-backup/base}"
CONFIRM="${PESOWISE_PITR_TRANSFER_CONFIRM:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute) EXECUTE=1; shift ;;
    --host) PRIMARY_IP="$2"; shift 2 ;;
    *) echo "Usage: $0 [--execute] [--host IP]"; exit 1 ;;
  esac
done

PRIMARY_IP="${PRIMARY_IP:-$(hostname -I | awk '{print $1}')}"
echo "transfer-pitr-primary: execute=$EXECUTE host=$PRIMARY_IP container=${DB_CONTAINER:-auto}"

if [[ "$EXECUTE" -ne 1 ]]; then
  echo "DRY RUN steps:"
  echo "  1) CREATE PHYSICAL SLOT $SLOT (if not exists)"
  echo "  2) Ensure WAL dir + pg_receivewal unit"
  echo "  3) create-base-backup.sh from local primary"
  echo "  4) check-pitr-health.sh OVERALL PASS"
  exit 0
fi

[[ "$CONFIRM" == "PITR_TRANSFER_NOW" ]] || {
  echo "Refusing: set PESOWISE_PITR_TRANSFER_CONFIRM=PITR_TRANSFER_NOW" >&2
  exit 1
}

if [[ -z "$DB_CONTAINER" ]]; then
  DB_CONTAINER=$(docker ps --format '{{.Names}}' | grep -E '^supabase-db-' | head -1)
fi

rec=$(docker exec "$DB_CONTAINER" psql -U supabase_admin -d postgres -tAc "SELECT pg_is_in_recovery();")
[[ "$rec" == "f" ]] || { echo "FAIL: not primary"; exit 1; }

docker exec "$DB_CONTAINER" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -c \
  "SELECT pg_create_physical_replication_slot('${SLOT}') WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name='${SLOT}');" 2>/dev/null || true

if [[ -x "$RECOVERY_DIR/install-pg-receivewal-service.sh" ]]; then
  PESOWISE_DB_CONTAINER="$DB_CONTAINER" "$RECOVERY_DIR/install-pg-receivewal-service.sh" --execute || true
fi

if [[ -x "$RECOVERY_DIR/create-base-backup.sh" ]]; then
  SOURCE_HOST=127.0.0.1 PESOWISE_DB_CONTAINER="$DB_CONTAINER" "$RECOVERY_DIR/create-base-backup.sh" --execute
fi

PGHOST=127.0.0.1 PESOWISE_DB_CONTAINER="$DB_CONTAINER" "$RECOVERY_DIR/check-pitr-health.sh"
