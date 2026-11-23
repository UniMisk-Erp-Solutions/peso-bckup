#!/usr/bin/env bash
# On .68: extract base pack, run PITR recovery, print report.
set -euo pipefail
export SUDO_PASSWORD="${SUDO_PASSWORD:?}"
TAR="${1:?tar path on .68}"
MAN="${2:-/tmp/pitr-expense-demo/manifest.json}"
BASE_ROOT=/var/lib/pesowise-pitr-backup/base
run_sudo() { echo "$SUDO_PASSWORD" | sudo -S "$@"; }

run_sudo mkdir -p "$BASE_ROOT" /tmp/pitr-expense-demo
run_sudo tar -xzf "$TAR" -C "$BASE_ROOT"
sed -i 's/\r$//' /tmp/ha/pitr-recover-expense-from-68-wal.sh /tmp/ha/restore-pitr.sh /tmp/ha/recovery-path-guard.sh 2>/dev/null || true
run_sudo docker rm -f pitr-expense-recovery 2>/dev/null || true
run_sudo rm -rf /var/lib/pesowise-pitr-recovery-demo
bash /tmp/ha/pitr-recover-expense-from-68-wal.sh "$MAN"
