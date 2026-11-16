#!/usr/bin/env bash
# PesoWise: expose primary Postgres on .46:5432 for replication from .68 only.
set -euo pipefail
DB=supabase-db-kar0ro1k6jiyfxzzw7acnsza
BIND=192.168.23.46
PORT=5432
STANDBY_IP=192.168.23.68

DB_IP=$(sudo docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$DB")
[[ -n "$DB_IP" ]] || { echo "FAIL: no DB container IP"; exit 1; }
echo "DB container IP=$DB_IP"

sudo apt-get install -y socat >/dev/null 2>&1 || true

UNIT=/etc/systemd/system/pesowise-repl-proxy.service
TMP=$(mktemp)
cat >"$TMP" <<EOF
[Unit]
Description=PesoWise replication TCP proxy (.46 DB for .68 standby)
After=docker.service

[Service]
Type=simple
ExecStart=/usr/bin/socat TCP-LISTEN:${PORT},bind=${BIND},reuseaddr,fork TCP:${DB_IP}:${PORT}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo cp "$TMP" "$UNIT"
rm -f "$TMP"

sudo systemctl daemon-reload
sudo systemctl enable pesowise-repl-proxy.service
sudo systemctl restart pesowise-repl-proxy.service
sleep 1
sudo systemctl is-active pesowise-repl-proxy.service

if command -v ufw >/dev/null 2>&1 && sudo ufw status 2>/dev/null | grep -q "Status: active"; then
  sudo ufw allow from "$STANDBY_IP" to any port "$PORT" proto tcp comment 'PesoWise repl .68 standby' || true
fi

echo "REPL_PROXY_OK ${BIND}:${PORT} -> ${DB_IP}:${PORT}"
