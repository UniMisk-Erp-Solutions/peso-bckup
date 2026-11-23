#!/usr/bin/env bash
# Deploy isolated HA lab on THIS host (.68). Never stops production Supabase stack.
set -euo pipefail
LAB=/tmp/pesowise-ha-lab
TAR=/tmp/pesowise-ha-lab-remote.tar.gz
if [ ! -f "$LAB/docker-compose.node68.yml" ] && [ -f "$TAR" ]; then
  rm -rf "$LAB" /tmp/priyanshu-ha-lab
  tar -xzf "$TAR" -C /tmp
  mv /tmp/priyanshu-ha-lab "$LAB"
fi
COMPOSE="$LAB/docker-compose.node68.yml"
export LAB_PG_PRIMARY_HOST="${LAB_PG_PRIMARY_HOST:-192.168.23.46}"

guard() {
  local prod=supabase-db-ypwzkftxvvbjfvsll1y3aesk
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$prod"; then
    echo "OK: production DB $prod still running"
  fi
}

guard
cd "$LAB"
docker compose -f "$COMPOSE" down -v 2>/dev/null || true
docker compose -f "$COMPOSE" build --no-cache pg68 2>/dev/null || docker compose -f "$COMPOSE" build pg68
docker compose -f "$COMPOSE" up -d

echo "Waiting for standby from $LAB_PG_PRIMARY_HOST:54346 ..."
for i in $(seq 1 60); do
  rec=$(docker exec pesowise-ha-lab-pg68 psql -U postgres -tAc "SELECT pg_is_in_recovery();" 2>/dev/null || echo x)
  [[ "$rec" == "t" ]] && break
  sleep 3
done

rec46_msg="check primary separately on .46"
rec68=$(docker exec pesowise-ha-lab-pg68 psql -U postgres -tAc "SELECT pg_is_in_recovery();")
echo "lab pg68 recovery=$rec68"
curl -sf http://127.0.0.1:18088/ | head -1 || echo "haproxy starting..."
echo "LAB_68_UP ports=18088,54368 haproxy->46:18046+app68"
