#!/usr/bin/env bash
# Phases 1-7 PesoWise failover — run steps via plink to .46/.68
set -euo pipefail
echo "Phase: lock .68"
echo "$SUDO68" | sudo -S mkdir -p /var/lib/pesowise-ha
echo "$SUDO68" | sudo -S bash /tmp/ha/ha-lock.sh release 2>/dev/null || true
echo "$SUDO68" | sudo -S bash /tmp/ha/ha-lock.sh acquire --operator pesowise-agent --reason controlled_manual_failover_rehearsal
