#!/usr/bin/env bash
set -euo pipefail
DB=pesowise-postgres-migration-v2
DIR=/tmp/pesowise-migration-staging
PW="${STAGING_TEST_PASSWORD:-StagingMigrate2026!}"
EMAIL_FILE="$DIR/staging-test-users.emails"

IDS=$(docker exec "$DB" psql -U pesowise_migration -d pesowise -tAc "
SELECT string_agg(quote_literal(user_id::text), ',')
FROM (
  SELECT DISTINCT ON (ur.role) u.id AS user_id
  FROM public.user_roles ur
  JOIN auth.users u ON u.id = ur.user_id
  WHERE ur.role::text IN ('admin','engineer','employee','cashier')
  ORDER BY ur.role, u.created_at
) s;
" | tr -d '[:space:]')

if [[ -z "$IDS" ]]; then
  echo "No role users found in user_roles; abort." >&2
  exit 1
fi

HASH=$(docker exec pesowise-api-migration-staging node -e "require('bcrypt').hash('$PW', 10).then(h=>process.stdout.write(h))")

docker exec "$DB" psql -U pesowise_migration -d pesowise -c \
  "UPDATE auth.users SET encrypted_password = '${HASH//\'/\'\'}' WHERE id IN (${IDS});"

docker exec "$DB" psql -U pesowise_migration -d pesowise -tAc "
SELECT DISTINCT ON (ur.role) ur.role::text || '|' || coalesce(u.email, i.identity_data->>'email') || '|' || u.id::text
FROM public.user_roles ur
JOIN auth.users u ON u.id = ur.user_id
LEFT JOIN auth.identities i ON i.user_id = u.id AND i.provider = 'email'
WHERE ur.role::text IN ('admin','engineer','employee','cashier')
ORDER BY ur.role, u.created_at;
" > "$EMAIL_FILE"

echo "STAGING_TEST_USERS_READY emails=$EMAIL_FILE"
