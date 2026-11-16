#!/usr/bin/env bash
set -euo pipefail
DB=pesowise-postgres-migration-v2
docker exec "$DB" psql -U pesowise_migration -d pesowise -c \
  "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='attachments' ORDER BY 1;"
docker exec "$DB" psql -U pesowise_migration -d pesowise -tAc \
  "SELECT count(*) FILTER (WHERE coalesce(storage_path,'') <> ''), count(*) FILTER (WHERE coalesce(storage_path,'') = '' AND file_url <> '') FROM public.attachments;"
docker exec "$DB" psql -U pesowise_migration -d pesowise -c \
  "SELECT id, left(coalesce(storage_path,''),60) AS sp, left(file_url,80) AS fu FROM public.attachments WHERE coalesce(storage_path,'') <> '' ORDER BY created_at ASC LIMIT 3;"
ADMIN=$(grep '^admin|' /tmp/pesowise-migration-staging/staging-test-users.emails | head -1 | cut -d'|' -f3)
docker exec "$DB" psql -U pesowise_migration -d pesowise -c \
  "SELECT p.organization_id, om.organization_id, om.role FROM public.profiles p LEFT JOIN public.organization_memberships om ON om.user_id=p.id WHERE p.id='${ADMIN}'::uuid;"
docker exec "$DB" psql -U pesowise_migration -d pesowise -tAc \
  "SELECT count(*) FROM public.organization_memberships WHERE user_id='${ADMIN}'::uuid;"
docker exec "$DB" psql -U pesowise_migration -d pesowise -c \
  "SELECT EXISTS (SELECT 1 FROM public.attachments a JOIN public.expenses e ON e.id=a.expense_id WHERE a.storage_path LIKE '368d9f32%' AND e.organization_id IS NOT NULL) AS sample_exists;"
docker exec "$DB" psql -U pesowise_migration -d pesowise -tAc \
  "SELECT e.organization_id::text FROM public.attachments a JOIN public.expenses e ON e.id=a.expense_id WHERE a.storage_path LIKE '368d9f32%' LIMIT 1;"
