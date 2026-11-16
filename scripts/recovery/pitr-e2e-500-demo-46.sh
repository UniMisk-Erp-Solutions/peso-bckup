#!/usr/bin/env bash
# On .46: fresh base tarball then 500 random expenses insert+delete. Prints paths for orchestrator.
set -euo pipefail
HA=/tmp/ha
sed -i 's/\r$//' "$HA"/pitr-base-backup-46-pack.sh "$HA"/pitr-base-backup-46-run.sh "$HA"/pitr-expense-demo-insert-delete-46.sh 2>/dev/null || true
bash "$HA/pitr-base-backup-46-run.sh" | tee /tmp/pitr-e2e-base.log
TAR=$(grep -o '/tmp/pitr-base-[0-9T]*Z\.tar\.gz' /tmp/pitr-e2e-base.log | tail -1)
[[ -f "$TAR" ]] || { echo "FAIL: no tarball"; exit 1; }
bash "$HA/pitr-expense-demo-insert-delete-46.sh" | tee /tmp/pitr-e2e-demo.log
echo "TARFILE=$TAR"
echo "MANIFEST=/tmp/pitr-expense-demo/manifest.json"
cat /tmp/pitr-expense-demo/manifest.json
