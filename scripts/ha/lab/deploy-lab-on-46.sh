#!/usr/bin/env bash
# Deploy isolated HA lab on THIS host (.46). Never stops production containers.
set -euo pipefail
LAB=/tmp/pesowise-ha-lab
TAR=/tmp/pesowise-ha-lab-remote.tar.gz
if [ ! -f "$LAB/docker-compose.node46.yml" ] && [ -f "$TAR" ]; then
  rm -rf "$LAB" /tmp/priyanshu-ha-lab
  tar -xzf "$TAR" -C /tmp
  mv /tmp/priyanshu-ha-lab "$LAB"
fi
COMPOSE="$LAB/docker-compose.node46.yml"

guard() {
  local prod=supabase-db-kar0ro1k6jiyfxzzw7acnsza
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$prod"; then
    echo "OK: production DB $prod still running (lab uses other names/ports)"
  fi
  if docker ps -a --format '{{.Names}}' | grep -E '^pesowise-ha-lab-' >/dev/null; then
    echo "Existing lab containers found — will recreate lab stack only"
  fi
}

guard
cd "$LAB"
docker compose -f "$COMPOSE" down -v 2>/dev/null || true
docker compose -f "$COMPOSE" up -d

for i in $(seq 1 40); do
  docker exec pesowise-ha-lab-pg46 pg_isready -U postgres -q 2>/dev/null && break
  sleep 2
done
docker exec pesowise-ha-lab-pg46 pg_isready -U postgres
curl -sf http://127.0.0.1:18046/ | head -1
echo "LAB_46_UP ports=18046,54346"
