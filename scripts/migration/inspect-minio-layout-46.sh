#!/usr/bin/env bash
docker exec supabase-db-kar0ro1k6jiyfxzzw7acnsza psql -U supabase_admin -d postgres -c "SELECT bucket_id, left(name,80) FROM storage.objects LIMIT 8;"
docker exec supabase-minio-kar0ro1k6jiyfxzzw7acnsza sh -c 'mc alias set local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" && mc ls local/stub/storage-single-tenant | head -15'
docker exec supabase-minio-kar0ro1k6jiyfxzzw7acnsza sh -c 'mc find local/stub --path "*/receipts/*" | head -5'
docker exec supabase-minio-kar0ro1k6jiyfxzzw7acnsza sh -c 'mc du local/stub --depth 2'
