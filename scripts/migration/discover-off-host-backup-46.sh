#!/usr/bin/env bash
# Phase 16 — discover PesoWise-only off-host backup destinations (read-only).
set -euo pipefail
OUT=/tmp/pesowise-migration-backup/off-host-discovery-$(date -u +%Y%m%dT%H%M%SZ).txt
exec > >(tee "$OUT") 2>&1

echo "# PesoWise off-host backup discovery (Gate O)"
echo "## Local PesoWise paths on .46"
for p in /tmp/pesowise-migration-backup /tmp/pesowise-migration-v2 /tmp/pesowise-migration-staging; do
  if [[ -d "$p" ]]; then
    echo "FOUND $p"
    du -sh "$p" 2>/dev/null || true
  else
    echo "MISSING $p"
  fi
done

echo "## Documented production PITR archive (.68)"
echo "NOTE: 192.168.23.68 hosts production Supabase WAL/PITR for kar0ro1k6jiyfxzzw7acnsza — not inspected (out of scope)."
echo "Migration v2 (15432) has no authorized off-host copy configured in repo scripts."

echo "## Authorized migration off-host destination"
if [[ -f /etc/pesowise-migration/off-host-backup.conf ]]; then
  echo "FOUND /etc/pesowise-migration/off-host-backup.conf"
else
  echo "BLOCKED — NO AUTHORIZED OFF-HOST DESTINATION for migration v2 backups"
fi
echo "REPORT=$OUT"
