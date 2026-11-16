#!/usr/bin/env bash
# Fence .68 Postgres during failback (.46 is sole primary).
set -euo pipefail
EXECUTE=0
DB=supabase-db-ypwzkftxvvbjfvsll1y3aesk
CONFIRM="${PESOWISE_FENCE_68_CONFIRM:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute) EXECUTE=1; shift ;;
    *) echo "Usage: $0 [--execute]"; exit 1 ;;
  esac
done

run_sudo() { echo "${SUDO_PASSWORD:?}" | sudo -S "$@"; }

if [[ "$EXECUTE" -ne 1 ]]; then
  echo "DRY RUN: would stop $DB and disable pesowise-repl-proxy on .68"
  exit 0
fi

[[ "$CONFIRM" == "FENCE_68_NOW" ]] || { echo "Set PESOWISE_FENCE_68_CONFIRM=FENCE_68_NOW"; exit 1; }

run_sudo systemctl stop pesowise-repl-proxy.service 2>/dev/null || true
run_sudo docker stop "$DB"
echo "FENCE_68_OK $(date -u +%Y-%m-%dT%H:%M:%SZ)"
