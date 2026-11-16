#!/usr/bin/env bash
set -euo pipefail
export SUDO_PASSWORD="${SUDO_PASSWORD:?}"
TAR="${1:-/tmp/pitr-wal-backfill.tar.gz}"
WAL_HOST=/var/lib/docker/volumes/ypwzkftxvvbjfvsll1y3aesk_supabase-db-config/_data/pitr-wal
run_sudo() { echo "$SUDO_PASSWORD" | sudo -S "$@"; }
run_sudo tar -xzf "$TAR" -C /tmp
run_sudo cp -a /tmp/pitr-wal-backfill/* "$WAL_HOST/"
run_sudo chown -R 105:106 "$WAL_HOST" 2>/dev/null || run_sudo chown -R 999:999 "$WAL_HOST" 2>/dev/null || true
run_sudo ls "$WAL_HOST" | tail -15
echo WAL_BACKFILL_OK
