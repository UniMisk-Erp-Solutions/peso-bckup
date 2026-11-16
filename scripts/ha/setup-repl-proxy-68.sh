#!/usr/bin/env bash
# PesoWise: expose primary Postgres on .68:5432 for replication from .46 only.
set -euo pipefail
SUDO_PASS="${SUDO_PASSWORD:?}"
DB=supabase-db-ypwzkftxvvbjfvsll1y3aesk
BIND=192.168.23.68
PORT=5432
run_sudo() { echo "$SUDO_PASS" | sudo -S "$@"; }

DB_IP=$(run_sudo docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$DB")
[[ -n "$DB_IP" ]] || { echo "FAIL: no DB container IP"; exit 1; }
echo "DB container IP=$DB_IP"

run_sudo apt-get install -y socat >/dev/null 2>&1 || true

UNIT=/etc/systemd/system/pesowise-repl-proxy.service
TMP=$(mktemp)
cat >"$TMP" <<EOF
[Unit]
Description=PesoWise replication TCP proxy (.68 DB for .46 standby)
After=docker.service

[Service]
Type=simple
ExecStart=/usr/bin/socat TCP-LISTEN:${PORT},bind=${BIND},reuseaddr,fork TCP:${DB_IP}:${PORT}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
run_sudo cp "$TMP" "$UNIT"
rm -f "$TMP"

run_sudo systemctl daemon-reload
run_sudo systemctl enable pesowise-repl-proxy.service
run_sudo systemctl restart pesowise-repl-proxy.service
sleep 1
run_sudo systemctl is-active pesowise-repl-proxy.service

if command -v ufw >/dev/null 2>&1 && run_sudo ufw status 2>/dev/null | grep -q "Status: active"; then
  run_sudo ufw allow from 192.168.23.46 to any port "$PORT" proto tcp comment 'PesoWise repl .46 standby' || true
fi

echo "REPL_PROXY_OK ${BIND}:${PORT} -> ${DB_IP}:${PORT}"
