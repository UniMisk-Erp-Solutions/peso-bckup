#!/usr/bin/env bash
set -euo pipefail
SRC=supabase-minio-kar0ro1k6jiyfxzzw7acnsza
TGT=pesowise-minio-coolify-primary
V2=pesowise-minio-migration-v2
MINIO_ENV=/tmp/pesowise-migration-backup/pesowise-minio-coolify-primary.env

if [[ ! -f "$MINIO_ENV" ]]; then
  {
    echo "MINIO_ROOT_USER=pesowise_coolify"
    echo "MINIO_ROOT_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)"
  } > "$MINIO_ENV"
  chmod 600 "$MINIO_ENV"
fi
# shellcheck disable=SC1090
source "$MINIO_ENV"

if ! docker ps --format '{{.Names}}' | grep -qx "$TGT"; then
  docker volume create pesowise-minio-coolify-primary-data >/dev/null
  docker run -d --name "$TGT" --restart unless-stopped \
    -p 19015:9000 -p 19016:9001 \
    -e MINIO_ROOT_USER="$MINIO_ROOT_USER" \
    -e MINIO_ROOT_PASSWORD="$MINIO_ROOT_PASSWORD" \
    -v pesowise-minio-coolify-primary-data:/data \
    ghcr.io/coollabsio/minio:RELEASE.2025-10-15T17-29-55Z server /data --console-address ":9001"
  sleep 5
fi

mapfile -t src_creds < <(docker exec "$SRC" sh -c 'printf "%s\n%s\n" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"')
mapfile -t tgt_creds < <(docker exec "$TGT" sh -c 'printf "%s\n%s\n" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"')
NET=$(docker inspect "$SRC" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' | awk '{print $1}')
docker network connect "$NET" "$TGT" 2>/dev/null || true
if docker ps --format '{{.Names}}' | grep -qx "$V2"; then
  docker network connect "$NET" "$V2" 2>/dev/null || true
fi

docker exec "$TGT" sh -c "
  set -e
  mc alias set src http://${SRC}:9000 '${src_creds[0]}' '${src_creds[1]}'
  mc alias set tgt http://127.0.0.1:9000 '${tgt_creds[0]}' '${tgt_creds[1]}'
  mc ls src || true
  for b in stub receipts expense-attachments organization-logos generated-reports balance-import-archive bills; do
    mc mb --ignore-existing tgt/\${b}
    mc mirror --overwrite src/\${b} tgt/\${b} 2>/dev/null || true
    sc=\$(mc ls -r src/\${b} 2>/dev/null | wc -l)
    tc=\$(mc ls -r tgt/\${b} 2>/dev/null | wc -l)
    dl=\$(mc diff src/\${b} tgt/\${b} 2>/dev/null | wc -l)
    echo \"supabase_mirror \${b} src=\${sc} tgt=\${tc} diff=\${dl}\"
  done
"

if docker ps --format '{{.Names}}' | grep -qx "$V2"; then
  mapfile -t v2_creds < <(docker exec "$V2" sh -c 'printf "%s\n%s\n" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"')
  docker exec "$TGT" sh -c "
    mc alias set v2 http://${V2}:9000 '${v2_creds[0]}' '${v2_creds[1]}' || true
    for b in stub receipts expense-attachments organization-logos generated-reports balance-import-archive bills; do
      mc mirror --overwrite v2/\${b} tgt/\${b} 2>/dev/null || true
      tc=\$(mc ls -r tgt/\${b} 2>/dev/null | wc -l)
      echo \"v2_topup \${b} tgt=\${tc}\"
    done
  "
fi
echo "MINIO_MIRROR_COOLIFY_PRIMARY_DONE"

