#!/usr/bin/env bash
# Console audit 2026-10-16: public.profiles.notification_settings migration, on a THROWAWAY database.
#   PGHOST/PGPORT/PGUSER must point at a disposable server.  Usage: ./notification_settings_test.sh [db]
set -euo pipefail
DB="${1:-pwnotif}"
PSQL="${PSQL:-psql}"
HERE="$(cd "$(dirname "$0")" && pwd)"
MIG="$HERE/../../migrations/20261027100000_profiles_notification_settings_v1.sql"

"$PSQL" -d postgres -qc "drop database if exists $DB" -c "create database $DB"
# a profiles table that ALREADY has rows before the migration (Production situation)
"$PSQL" -d "$DB" -qv ON_ERROR_STOP=1 <<'SQL'
create table public.profiles (id uuid primary key default gen_random_uuid(), user_id uuid not null, name text not null default 'n', email text not null default 'e', balance numeric default 0);
insert into public.profiles (user_id) select gen_random_uuid() from generate_series(1,50);
SQL

echo "== before: selecting the column fails exactly like Production (42703)"
OUT="$("$PSQL" -d "$DB" -Atqc "select notification_settings from public.profiles limit 1" 2>&1 || true)"
if echo "$OUT" | grep -q 'does not exist'; then echo PASS; else echo "FAIL: $OUT"; exit 1; fi

"$PSQL" -d "$DB" -qv ON_ERROR_STOP=1 -f "$MIG"
"$PSQL" -d "$DB" -qv ON_ERROR_STOP=1 -f "$MIG"   # idempotent: second run must be a no-op

check() { # label, sql, expected
  local got; got="$("$PSQL" -d "$DB" -Atq -c "$2")"
  if [ "$got" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1 (got '$got', expected '$3')"; exit 1; fi
}
check "all 50 existing rows got the default (no rewrite/backfill needed)" \
  "select count(*) from public.profiles where notification_settings = '{\"popup_enabled\": true, \"sound_enabled\": true, \"desktop_enabled\": false}'::jsonb" "50"
check "column is jsonb NOT NULL" \
  "select data_type||'/'||is_nullable from information_schema.columns where table_name='profiles' and column_name='notification_settings'" "jsonb/NO"
check "select works (what the app sends)" \
  "select (notification_settings->>'popup_enabled') from public.profiles limit 1" "true"
check "update works and persists" \
  "update public.profiles set notification_settings = '{\"popup_enabled\": false, \"sound_enabled\": false, \"desktop_enabled\": true}' where user_id = (select user_id from public.profiles limit 1) returning notification_settings->>'desktop_enabled'" "true"
check "a new profile row gets the default" \
  "insert into public.profiles (user_id) values (gen_random_uuid()) returning notification_settings->>'sound_enabled'" "true"
OUT="$("$PSQL" -d "$DB" -Atqc "update public.profiles set notification_settings = '[]' where user_id = (select user_id from public.profiles limit 1)" 2>&1 || true)"
if echo "$OUT" | grep -q 'profiles_notification_settings_is_object'; then echo "PASS  a non-object value is rejected"; else echo "FAIL  non-object accepted"; exit 1; fi
OUT="$("$PSQL" -d "$DB" -Atqc "update public.profiles set notification_settings = null where user_id = (select user_id from public.profiles limit 1)" 2>&1 || true)"
if echo "$OUT" | grep -q 'null value'; then echo "PASS  NULL is rejected"; else echo "FAIL  NULL accepted"; exit 1; fi
echo "NOTIFICATION SETTINGS MIGRATION: PASS"
