#!/usr/bin/env bash
# Switch logical DB routing to new primary — DRY RUN default. Does not run in prod without approval.
set -euo pipefail
EXECUTE=0
OLD_TARGET="${OLD_DB_TARGET:-192.168.23.46:5432}"
NEW_TARGET="${NEW_DB_TARGET:-192.168.23.68:5432}"
HAPROXY_CFG="${HAPROXY_CFG:-/data/coolify/proxy/haproxy-pesowise/haproxy.cfg}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute) EXECUTE=1; shift ;;
    --new) NEW_TARGET="$2"; shift 2 ;;
    --old) OLD_TARGET="$2"; shift 2 ;;
    *) echo "Usage: $0 [--execute] [--old host:port] [--new host:port]"; exit 1 ;;
  esac
done

new_host="${NEW_TARGET%%:*}"
new_port="${NEW_TARGET##*:}"

echo "switch-db-primary: execute=$EXECUTE"
echo "old=$OLD_TARGET new=$NEW_TARGET"
echo "haproxy_cfg=$HAPROXY_CFG"

echo "Precheck: new primary must not be in recovery"
if [[ "$EXECUTE" -eq 1 ]]; then
  rec=$(psql -h "$new_host" -p "$new_port" -U supabase_admin -d postgres -tAc "SELECT pg_is_in_recovery();" 2>/dev/null || echo err)
  [[ "$rec" == "f" ]] || { echo "FAIL: target still in recovery or unreachable"; exit 1; }
fi

echo "Minimum production changes (documented, not auto-applied):"
echo "  1) HAProxy/Kong/Supavisor DB upstream → $NEW_TARGET"
echo "  2) Reload haproxy-pesowise-lb container"
echo "  3) Restart PostgREST/Auth/Storage on hosts still pointing at .46 DB"

if [[ "$EXECUTE" -ne 1 ]]; then
  echo "DRY RUN complete"
  exit 0
fi

echo "BLOCKED: edit $HAPROXY_CFG manually per docs/ha/DB_ENDPOINT_SWITCH_PLAN.md"
exit 2
