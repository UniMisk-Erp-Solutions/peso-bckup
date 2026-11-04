#!/usr/bin/env bash
# DOC-148 part 2 -- REAL concurrency proof on a throwaway database (never Production).
# Eight psql sessions race to resolve the SAME 300 logical submission ids (+ 300 batch lines of ONE
# client_batch_id). The unique index must leave exactly one row per id, and every call for an id
# must have returned the same expense_id.
#   PGHOST/PGPORT/PGUSER must point at a disposable server. Usage: ./concurrency.sh [db_name]
set -euo pipefail
DB="${1:-pwconc}"
PSQL="${PSQL:-psql}"
HERE="$(cd "$(dirname "$0")" && pwd)"
MIG="$HERE/../../migrations"

"$PSQL" -d postgres -qc "drop database if exists $DB" -c "create database $DB"
"$PSQL" -d "$DB" -v ON_ERROR_STOP=1 -q -f "$HERE/acceptance_schema.sql" -f "$HERE/integrity_issues_live_fn.sql" \
  -f "$MIG/20261025100000_stranded_draft_submit_flow_v1.sql" -f "$MIG/20261026100000_server_side_submission_identity_v1.sql"

ORG=$("$PSQL" -d "$DB" -Atc "select gen_random_uuid()")
USR=$("$PSQL" -d "$DB" -Atc "select gen_random_uuid()")
"$PSQL" -d "$DB" -qc "insert into organization_memberships values ('$USR','$ORG',true,'employee')"
BATCH=$("$PSQL" -d "$DB" -Atc "select gen_random_uuid()")

# 300 fixed single-expense ids + 300 batch lines (ids derived from $BATCH)
"$PSQL" -d "$DB" -qc "create table race_ids as select gen_random_uuid() as k, g as n from generate_series(1,300) g"
"$PSQL" -d "$DB" -qc "create table race_out (src int, kind text, n int, expense_id uuid)"

worker() {
  local src="$1"
  "$PSQL" -d "$DB" -q <<SQL
set request.jwt.claim.sub = '$USR';
do \$\$
declare r record; j jsonb;
begin
  for r in select k, n from race_ids order by random() loop
    j := public.resolve_or_create_expense_v1('$ORG', r.k, '{"title":"t","destination":"d","trip_start":"2026-10-10","trip_end":"2026-10-10","total_amount":1}'::jsonb);
    insert into race_out values ($src, 'single', r.n, (j->>'expense_id')::uuid);
    j := public.resolve_or_create_expense_v1('$ORG', null, '{"title":"t","destination":"d","trip_start":"2026-10-10","trip_end":"2026-10-10","total_amount":1}'::jsonb, '$BATCH', r.n);
    insert into race_out values ($src, 'line', r.n, (j->>'expense_id')::uuid);
    commit;  -- each resolve is its own transaction, as it is from PostgREST
  end loop;
end \$\$;
SQL
}

for s in 1 2 3 4 5 6 7 8; do worker "$s" & done
wait

ROWS=$("$PSQL" -d "$DB" -Atc "select count(*) from expenses")
SINGLE=$("$PSQL" -d "$DB" -Atc "select count(distinct expense_id) from race_out where kind='single'")
LINES=$("$PSQL" -d "$DB" -Atc "select count(distinct expense_id) from race_out where kind='line'")
DISAGREE=$("$PSQL" -d "$DB" -Atc "select count(*) from (select kind, n from race_out group by kind, n having count(distinct expense_id) > 1) x")
CALLS=$("$PSQL" -d "$DB" -Atc "select count(*) from race_out")
AUDIT=$("$PSQL" -d "$DB" -Atc "select count(*) from audit_logs where action='expense_created'")

echo "concurrent calls:                 $CALLS (8 sessions x 600)"
echo "expense rows in table:            $ROWS   (expected 600)"
echo "distinct single-expense ids:      $SINGLE (expected 300)"
echo "distinct batch-line ids:          $LINES  (expected 300)"
echo "ids where sessions disagreed:     $DISAGREE (expected 0)"
echo "expense_created audit rows:       $AUDIT  (expected 600)"
if [ "$ROWS" = 600 ] && [ "$SINGLE" = 300 ] && [ "$LINES" = 300 ] && [ "$DISAGREE" = 0 ] && [ "$AUDIT" = 600 ]; then
  echo "CONCURRENCY TEST: PASS"
else
  echo "CONCURRENCY TEST: FAIL"; exit 1
fi
