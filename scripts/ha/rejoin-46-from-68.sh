#!/usr/bin/env bash
set -euo pipefail
SUDO_PASS="${SUDO_PASSWORD:?}"
SSH46_PASS="${SSH46_PASS:?}"
DB=supabase-db-ypwzkftxvvbjfvsll1y3aesk
SLOT=pesowise_46_standby
run_sudo() { echo "$SUDO_PASS" | sudo -S "$@"; }

run_sudo docker exec "$DB" bash -lc "rm -rf /tmp/rejoin-46 && runuser -u postgres -- pg_basebackup -h /var/run/postgresql -U supabase_admin -D /tmp/rejoin-46 -Fp -Xs -P -R -S ${SLOT}"
run_sudo docker exec "$DB" bash -lc 'tar -C /tmp/rejoin-46 -cf - .' | \
  sshpass -p "$SSH46_PASS" ssh -o StrictHostKeyChecking=accept-new hasto@192.168.23.46 \
  "sudo bash -s" <<'REMOTE'
set -euo pipefail
DB=supabase-db-kar0ro1k6jiyfxzzw7acnsza
VOL=/var/lib/docker/volumes/kar0ro1k6jiyfxzzw7acnsza_supabase-db-data/_data
sudo mkdir -p "$VOL"
sudo tar -xf - -C "$VOL"
sudo touch "$VOL/standby.signal"
if [[ -f "$VOL/postgresql.auto.conf" ]]; then
  sudo bash -c "grep -v primary_slot_name '$VOL/postgresql.auto.conf' > /tmp/pga46.conf"
  sudo bash -c "echo \"primary_slot_name = 'pesowise_46_standby'\" >> /tmp/pga46.conf"
  sudo cp /tmp/pga46.conf "$VOL/postgresql.auto.conf"
  sudo sed -i 's/host=192.168.23.46/host=192.168.23.68/g' "$VOL/postgresql.auto.conf" || true
fi
sudo chown -R 105:106 "$VOL"
sudo docker start "$DB"
REMOTE
echo REJOIN_VIA_SCP_OK
