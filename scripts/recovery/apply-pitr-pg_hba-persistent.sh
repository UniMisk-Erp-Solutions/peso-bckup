#!/usr/bin/env bash
# Merge persisted PITR pg_hba snippet into the running DB container and reload.
# Snippet lives on the Coolify config volume (survives container recreate if re-applied on start).
set -euo pipefail

EXECUTE=0
DB_CONTAINER="${PESOWISE_DB_CONTAINER:-supabase-db-kar0ro1k6jiyfxzzw7acnsza}"
CONFIG_VOL="${PESOWISE_DB_CONFIG_VOL:-/var/lib/docker/volumes/kar0ro1k6jiyfxzzw7acnsza_supabase-db-config/_data}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SNIPPET_SRC="${SCRIPT_DIR}/pesowise-pitr-pg_hba.snippet"
SNIPPET_VOL="${CONFIG_VOL}/pesowise-pitr-pg_hba.snippet"
HBA_LIVE="/etc/postgresql/pg_hba.conf"
MARKER="PESOWISE_PITR_PERSISTED"

usage() {
  echo "Usage: $0 [--execute]  (default: dry-run)"
  exit 1
}

[[ "${1:-}" == "--execute" ]] && EXECUTE=1
[[ "${1:-}" == "--dry-run" || "${1:-}" == "" ]] && EXECUTE=0
[[ "${1:-}" == "--execute" || "${1:-}" == "--dry-run" || -z "${1:-}" ]] || usage

echo "apply-pitr-pg_hba: execute=$EXECUTE container=$DB_CONTAINER"

if [[ "$EXECUTE" -eq 1 ]]; then
  sudo mkdir -p "$CONFIG_VOL"
  sudo cp "$SNIPPET_SRC" "$SNIPPET_VOL"
  sudo chmod 644 "$SNIPPET_VOL"
fi

echo "Persisted snippet target: $SNIPPET_VOL"

if ! sudo docker exec "$DB_CONTAINER" test -f "$HBA_LIVE"; then
  echo "FAIL: $HBA_LIVE not found in container" >&2
  exit 1
fi

if sudo docker exec "$DB_CONTAINER" grep -q "$MARKER" "$HBA_LIVE" 2>/dev/null; then
  echo "Live pg_hba already contains $MARKER — skip append"
elif [[ "$EXECUTE" -eq 1 ]]; then
  sudo docker exec -i "$DB_CONTAINER" bash -lc "cat >> $HBA_LIVE" < "$SNIPPET_VOL"
  echo "Appended snippet to $HBA_LIVE"
else
  echo "DRY RUN: would append snippet to $HBA_LIVE"
  exit 0
fi

if [[ "$EXECUTE" -eq 1 ]]; then
  sudo docker exec "$DB_CONTAINER" psql -U supabase_admin -d postgres -tAc "SELECT pg_reload_conf();" >/dev/null
  echo "pg_reload_conf: OK"
fi

echo "Verify .68 replication still present:"
sudo docker exec "$DB_CONTAINER" grep "192.168.23.68" "$HBA_LIVE" || echo "WARN: no .68 replication line visible"

exit 0
