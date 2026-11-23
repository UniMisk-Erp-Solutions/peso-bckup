#!/usr/bin/env bash
# PITR health on .68 after failover (primary + pg_receivewal on same host).
set -euo pipefail
export PESOWISE_DB_CONTAINER="${PESOWISE_DB_CONTAINER:-supabase-db-ypwzkftxvvbjfvsll1y3aesk}"
export WAL_DIR="${WAL_DIR:-/var/lib/docker/volumes/ypwzkftxvvbjfvsll1y3aesk_supabase-db-config/_data/pitr-wal}"
export BASE_DIR="${BASE_DIR:-/var/lib/pesowise-pitr-backup/base}"
export PESOWISE_PITR_SLOT="${PESOWISE_PITR_SLOT:-pesowise_pitr}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RECOVERY="${SCRIPT_DIR}/../recovery/check-pitr-health.sh"
[[ -f "$RECOVERY" ]] || RECOVERY="/tmp/ha/check-pitr-health.sh"
exec bash "$RECOVERY"
