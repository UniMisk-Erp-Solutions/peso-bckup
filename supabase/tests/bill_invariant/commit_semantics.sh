#!/usr/bin/env bash
# DOC-150: the DEFERRED trigger judged at real COMMIT, on a throwaway database.
# (a) INSERT as 'submitted' with no bill  -> COMMIT is refused, NO row survives (no stranded row)
# (b) INSERT as 'submitted' and the bill row in the SAME transaction -> COMMIT succeeds
# (c) draft + bill added in an EARLIER transaction, then UPDATE to submitted -> succeeds (attach-first flow)
set -uo pipefail
DB="${1:-pwbill2}"; PSQL="${PSQL:-psql}"; HERE="$(cd "$(dirname "$0")/../../.." && pwd)"
"$PSQL" -d postgres -qc "drop database if exists $DB" -c "create database $DB"
"$PSQL" -d "$DB" -q <<'SQL'
create type expense_status as enum ('draft','submitted','rejected','approved');
create table organization_settings (organization_id uuid primary key, attachment_required_above_amount numeric);
create table expenses (id uuid primary key default gen_random_uuid(), user_id uuid not null, organization_id uuid not null, status expense_status not null default 'draft', total_amount numeric, created_by_admin_id uuid);
create table attachments (id uuid primary key default gen_random_uuid(), expense_id uuid references expenses(id) on delete cascade, file_url text, storage_path text, deleted_at timestamptz);
create function is_organization_locked_for_restore_v1(p uuid) returns boolean language sql stable as $$ select false $$;
create role authenticated nologin; create role anon nologin; create role service_role nologin;
SQL
"$PSQL" -d "$DB" -q -v ON_ERROR_STOP=1 -f "$HERE/supabase/migrations/20261028100000_attachment_requirement_on_submit_v1.sql" || exit 1
ORG=$("$PSQL" -d "$DB" -Atc "select gen_random_uuid()"); U=$("$PSQL" -d "$DB" -Atc "select gen_random_uuid()")
"$PSQL" -d "$DB" -qc "insert into organization_settings values ('$ORG', 499)"
fail=0
out=$("$PSQL" -d "$DB" -Atq -c "insert into expenses (user_id, organization_id, status, total_amount) values ('$U','$ORG','submitted',800)" 2>&1)
if echo "$out" | grep -q "Bill photos are required for expenses above ₹499"; then echo "PASS (a) submitted insert without a bill is refused at COMMIT"; else echo "FAIL (a): $out"; fail=1; fi
n=$("$PSQL" -d "$DB" -Atc "select count(*) from expenses"); [ "$n" = 0 ] && echo "PASS (a) no row was left behind" || { echo "FAIL (a) $n rows left"; fail=1; }
out=$("$PSQL" -d "$DB" -Atq <<SQL 2>&1
begin;
with e as (insert into expenses (user_id, organization_id, status, total_amount) values ('$U','$ORG','submitted',800) returning id)
insert into attachments (expense_id, storage_path) select id, 'p' from e;
commit;
SQL
)
n=$("$PSQL" -d "$DB" -Atc "select count(*) from expenses where status='submitted'"); [ "$n" = 1 ] && echo "PASS (b) submitted + bill in the same transaction commits" || { echo "FAIL (b): $out"; fail=1; }
"$PSQL" -d "$DB" -qc "insert into expenses (id, user_id, organization_id, status, total_amount) values ('00000000-0000-0000-0000-0000000000aa','$U','$ORG','draft',900)"
out=$("$PSQL" -d "$DB" -Atq -c "update expenses set status='submitted' where id='00000000-0000-0000-0000-0000000000aa'" 2>&1)
echo "$out" | grep -q "Bill photos are required" && echo "PASS (c1) draft -> submitted without a bill is refused" || { echo "FAIL (c1): $out"; fail=1; }
s=$("$PSQL" -d "$DB" -Atc "select status from expenses where id='00000000-0000-0000-0000-0000000000aa'"); [ "$s" = draft ] && echo "PASS (c2) the draft is untouched (same row, still draft)" || { echo "FAIL (c2) $s"; fail=1; }
"$PSQL" -d "$DB" -qc "insert into attachments (expense_id, storage_path) values ('00000000-0000-0000-0000-0000000000aa','p')"
"$PSQL" -d "$DB" -Atq -c "update expenses set status='submitted' where id='00000000-0000-0000-0000-0000000000aa'" >/dev/null 2>&1
s=$("$PSQL" -d "$DB" -Atc "select status from expenses where id='00000000-0000-0000-0000-0000000000aa'"); [ "$s" = submitted ] && echo "PASS (c3) bill added -> the SAME id submits" || { echo "FAIL (c3) $s"; fail=1; }
[ $fail = 0 ] && echo "COMMIT SEMANTICS: PASS" || { echo "COMMIT SEMANTICS: FAIL"; exit 1; }
