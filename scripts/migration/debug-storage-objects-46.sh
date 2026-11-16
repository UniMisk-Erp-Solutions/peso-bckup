#!/usr/bin/env bash
DB=pesowise-postgres-migration-v2
docker exec "$DB" psql -U pesowise_migration -d pesowise -c \
  "SELECT id, name, version FROM storage.objects WHERE name LIKE '361fbbcc%y5coiy1oyy%' LIMIT 1;"
