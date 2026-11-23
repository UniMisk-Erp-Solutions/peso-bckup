import { Client } from "ssh2";

const pass = process.env.DEPLOY_SSH_PASSWORD;
const user = process.env.DEPLOY_SSH_USER ?? "hasto";
const DB = "supabase-db-kar0ro1k6jiyfxzzw7acnsza";

// Smaller org for 4-report sweep; large org for >1000 claim verification
const SMALL_ORG = "80ab039f-f9e2-4c76-8b5b-e65b15d66af9";
const SMALL_ADMIN = "7316914e-f8a8-49cb-808f-f549a56e668d";
const LARGE_ORG = "6709c1fe-e8c8-404d-bc68-d1edda923344";
const LARGE_ADMIN = "790267ca-f168-4cae-91c3-c3a7345dfcde";

const bash = `set -e
DB=${DB}
SRK=$(docker exec supabase-kong-kar0ro1k6jiyfxzzw7acnsza printenv SUPABASE_SERVICE_ROLE_KEY | tr -d '\\r')
URL=https://pesowise-backup-supabase.unimisk.com

run_job() {
  local ORG="$1" ADMIN="$2" RT="$3" PARAMS="$4" LABEL="$5"
  local DEDupe
  DEDUPE=$(echo -n "$ORG|$RT|$PARAMS|$(date +%s%N)" | md5sum | awk '{print $1}')
  JOB=$(docker exec $DB psql -U supabase_admin -d postgres -q -t -A -c \\
    "WITH ins AS (INSERT INTO tally_sync_jobs (organization_id,requested_by,report_type,parameters,dedupe_key,status) VALUES ('$ORG','$ADMIN','$RT','$PARAMS'::jsonb,'$DEDUPE','queued') RETURNING id) SELECT id FROM ins;" | head -1 | tr -d '[:space:]')
  echo "=== $LABEL job=$JOB ==="
  curl -s -X POST "$URL/functions/v1/run-tally-sync-job" \\
    -H "Authorization: Bearer $SRK" -H "Content-Type: application/json" \\
    -d "{\\"job_id\\":\\"$JOB\\"}" || true
  echo
  for i in $(seq 1 120); do
    ROW=$(docker exec $DB psql -U supabase_admin -d postgres -tAc \\
      "SELECT status||'|'||COALESCE(prepared_item_count::text,'')||'|'||COALESCE(source_row_count::text,'')||'|'||COALESCE(left(error_message_safe,80),'') FROM tally_sync_jobs WHERE id='$JOB';")
    echo "poll $i: $ROW"
    ST=$(echo "$ROW" | cut -d'|' -f1)
    if [ "$ST" = "prepared" ] || [ "$ST" = "failed" ]; then
      ITEMS=$(docker exec $DB psql -U supabase_admin -d postgres -tAc "SELECT count(*) FROM tally_sync_job_items WHERE job_id='$JOB';")
      echo "items_in_table=$ITEMS"
      break
    fi
    sleep 5
  done
}

# Four reports — small org, minimal filters
run_job "${SMALL_ORG}" "${SMALL_ADMIN}" "claim_verification" '{"context_version":1}' "claim_verification_no_filter_small"
run_job "${SMALL_ORG}" "${SMALL_ADMIN}" "claim_approval" '{"context_version":1}' "claim_approval_no_filter_small"
run_job "${SMALL_ORG}" "${SMALL_ADMIN}" "detailed_expense" '{"context_version":1,"year":"2026"}' "detailed_default_year_small"
run_job "${SMALL_ORG}" "${SMALL_ADMIN}" "daily_project_report" '{"context_version":1}' "daily_all_time_small"

# >1000 rows — large org claim verification (no optional filters)
run_job "${LARGE_ORG}" "${LARGE_ADMIN}" "claim_verification" '{"context_version":1}' "claim_verification_no_filter_large"
`;

const conn = new Client();
conn.on("ready", () => {
  conn.exec(bash, (err, stream) => {
    if (err) throw err;
    stream.on("data", (d) => process.stdout.write(d));
    stream.stderr.on("data", (d) => process.stderr.write(d));
    stream.on("close", (c) => process.exit(c ?? 0));
  });
}).connect({ host: "192.168.23.46", username: user, password: pass, readyTimeout: 60000 });
conn.on("error", (e) => {
  console.error(e.message);
  process.exit(1);
});
