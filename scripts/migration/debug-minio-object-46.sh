#!/usr/bin/env bash
set -euo pipefail
MINIO=pesowise-minio-migration-v2
path="361fbbcc-6ada-4442-8848-ba0d59b74169/1782737950386-y5coiy1oyy.png"
docker exec "$MINIO" sh -c 'mc alias set local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null'
docker exec "$MINIO" mc find local/stub --name "*y5coiy1oyy*" 2>/dev/null | head -10
docker exec "$MINIO" mc ls -r "local/stub/storage-single-tenant/receipts/361fbbcc-6ada-4442-8848-ba0d59b74169/" 2>/dev/null | head -5
