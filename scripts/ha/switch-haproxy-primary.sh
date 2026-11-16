#!/usr/bin/env bash
# Run ON .46 — repoint HAProxy from Kong .46 to Kong .68 (failover cutover).
set -euo pipefail
EXECUTE=0
HAPROXY_CFG="${HAPROXY_CFG:-/data/coolify/proxy/haproxy-pesowise/haproxy.cfg}"
HAPROXY_CONTAINER="${HAPROXY_CONTAINER:-haproxy-pesowise-lb}"
OLD_BACKEND="${OLD_BACKEND:-192.168.23.46:54321}"
NEW_BACKEND="${NEW_BACKEND:-192.168.23.68:54321}"
CONFIRM="${PESOWISE_SWITCH_CONFIRM:-}"
FAILBACK=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute) EXECUTE=1; shift ;;
    --new) NEW_BACKEND="$2"; shift 2 ;;
    --failback-to-46) FAILBACK=1; NEW_BACKEND="192.168.23.46:54321"; shift ;;
    *) echo "Usage: $0 [--execute] [--new host:port] [--failback-to-46]"; exit 1 ;;
  esac
done

echo "switch-haproxy-primary: execute=$EXECUTE cfg=$HAPROXY_CFG"
echo "old=$OLD_BACKEND new=$NEW_BACKEND"

if [[ "$EXECUTE" -ne 1 ]]; then
  echo "DRY RUN: would backup cfg, replace 192.168.23.46:54321 -> $NEW_BACKEND, reload $HAPROXY_CONTAINER"
  exit 0
fi

[[ "$CONFIRM" == "SWITCH_APP_TO_68" || "$CONFIRM" == "SWITCH_APP_TO_46" ]] || {
  echo "Refusing: set PESOWISE_SWITCH_CONFIRM=SWITCH_APP_TO_68 or SWITCH_APP_TO_46" >&2
  exit 1
}

bak="${HAPROXY_CFG}.bak-ha-$(date -u +%Y%m%dT%H%M%SZ)"
sudo cp "$HAPROXY_CFG" "$bak"
if [[ "$CONFIRM" == "SWITCH_APP_TO_46" || "$FAILBACK" -eq 1 ]]; then
  sudo sed -i "s|192.168.23.68:54321|192.168.23.46:54321|g" "$HAPROXY_CFG"
  sudo sed -i "s|server app68|server app46|g" "$HAPROXY_CFG"
else
  sudo sed -i "s|192.168.23.46:54321|${NEW_BACKEND}|g" "$HAPROXY_CFG"
  sudo sed -i "s|server app46|server app68|g" "$HAPROXY_CFG"
fi
sudo docker restart "$HAPROXY_CONTAINER"
echo "Switched. Backup: $bak"
