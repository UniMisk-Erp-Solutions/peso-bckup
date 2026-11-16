#!/usr/bin/env bash
# Web UI (pgAdmin) for Coolify pesowise-primary-postgres — LAN only.
set -euo pipefail

CONTAINER=pesowise-pgadmin-coolify
HOST_PORT=5050
PG_HOST=192.168.23.46
PG_PORT=15435
PG_USER=pesowise_app
PG_DB=pesowise
CREDS_PG=/tmp/pesowise-migration-backup/coolify-pesowise-primary-postgres.env
ADMIN_ENV=/tmp/pesowise-migration-backup/pesowise-pgadmin.env
CONF_DIR=/tmp/pesowise-pgadmin-config
mkdir -p /tmp/pesowise-migration-backup "$CONF_DIR"

if [[ -f "$CREDS_PG" ]]; then
  # shellcheck disable=SC1090
  source "$CREDS_PG"
  PG_PASS="${POSTGRES_PASSWORD:?}"
else
  PG_PASS=$(docker inspect mqgd6kfhdrcbpa2c2bvyjwvc --format '{{range .Config.Env}}{{println .}}{{end}}' \
    | sed -n 's/^POSTGRES_PASSWORD=//p' | head -1)
  if [[ -z "$PG_PASS" ]]; then
    echo "MISSING_POSTGRES_PASSWORD"
    exit 1
  fi
fi

if [[ ! -f "$ADMIN_ENV" ]]; then
  ADMIN_EMAIL=admin@pesowise.example.com
  ADMIN_PASS=$(openssl rand -base64 18 | tr -d '/+=' | head -c 20)
  {
    echo "PGADMIN_DEFAULT_EMAIL=$ADMIN_EMAIL"
    echo "PGADMIN_DEFAULT_PASSWORD=$ADMIN_PASS"
  } > "$ADMIN_ENV"
  chmod 600 "$ADMIN_ENV"
fi
# shellcheck disable=SC1090
source "$ADMIN_ENV"

mkdir -p "$CONF_DIR"
python3 <<PY
import json
cfg = {
  "Servers": {
    "1": {
      "Name": "PesoWise Primary (Coolify)",
      "Group": "Servers",
      "Host": "${PG_HOST}",
      "Port": ${PG_PORT},
      "MaintenanceDB": "${PG_DB}",
      "Username": "${PG_USER}",
      "Password": """${PG_PASS}""",
      "SSLMode": "prefer",
      "Comment": "Coolify Postgres — copied from Supabase (read-only source preserved)"
    }
  }
}
with open("${CONF_DIR}/servers.json", "w") as f:
    json.dump(cfg, f, indent=2)
PY
# pgAdmin in container runs as uid 5050 — must read mounted files
chown -R 5050:5050 "$CONF_DIR" 2>/dev/null || true
chmod 755 "$CONF_DIR"
chmod 644 "$CONF_DIR/servers.json"

docker rm -f "$CONTAINER" 2>/dev/null || true
docker volume rm pesowise-pgadmin-coolify-data 2>/dev/null || true
docker pull dpage/pgadmin4:8.14
docker run -d --name "$CONTAINER" --restart unless-stopped \
  -p "${HOST_PORT}:80" \
  -e "PGADMIN_DEFAULT_EMAIL=${PGADMIN_DEFAULT_EMAIL}" \
  -e "PGADMIN_DEFAULT_PASSWORD=${PGADMIN_DEFAULT_PASSWORD}" \
  -e PGADMIN_CONFIG_SERVER_MODE=False \
  -e PGADMIN_CONFIG_MASTER_PASSWORD_REQUIRED=False \
  -e PGADMIN_CONFIG_UPGRADE_SERVERS_JSON=True \
  -e "PGADMIN_SERVER_JSON_FILE=/pgadmin4/servers.json" \
  -v "$CONF_DIR/servers.json:/pgadmin4/servers.json:ro" \
  -v pesowise-pgadmin-coolify-data:/var/lib/pgadmin \
  dpage/pgadmin4:8.14

for i in $(seq 1 40); do
  curl -sf "http://127.0.0.1:${HOST_PORT}/misc/ping" >/dev/null 2>&1 && break
  sleep 2
done
sleep 5
docker logs "$CONTAINER" 2>&1 | grep -iE 'server|error|permission' | tail -8 || true

echo "PGADMIN_URL=http://${PG_HOST}:${HOST_PORT}"
echo "PGADMIN_LOGIN_EMAIL=${PGADMIN_DEFAULT_EMAIL}"
echo "PGADMIN_LOGIN_PASSWORD=${PGADMIN_DEFAULT_PASSWORD}"
echo "PGADMIN_ENV_FILE=$ADMIN_ENV"
echo "TREE_PATH=Servers > PesoWise Primary (Coolify) > Databases > pesowise > Schemas > public > Tables"
echo "PESOWISE_PGADMIN_DONE"
