#!/usr/bin/env bash
# Run on .46 host after failover: standby WAL receiver checks.
set -euo pipefail
export HA_ROLE=standby
export PRIMARY_HOST="${PRIMARY_HOST:-192.168.23.68}"
export STANDBY_HOST="${STANDBY_HOST:-192.168.23.46}"
export PRIMARY_DB_CONTAINER="${PRIMARY_DB_CONTAINER:-supabase-db-ypwzkftxvvbjfvsll1y3aesk}"
export STANDBY_DB_CONTAINER="${STANDBY_DB_CONTAINER:-supabase-db-kar0ro1k6jiyfxzzw7acnsza}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$SCRIPT_DIR/check-ha-health.sh"
