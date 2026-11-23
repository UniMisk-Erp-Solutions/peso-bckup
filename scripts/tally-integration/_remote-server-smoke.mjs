import { Client } from "ssh2";

const pass = process.env.DEPLOY_SSH_PASSWORD;
const user = process.env.DEPLOY_SSH_USER ?? "hasto";
const DB = "supabase-db-kar0ro1k6jiyfxzzw7acnsza";
const ORG = "80ab039f-f9e2-4c76-8b5b-e65b15d66af9";
const ADMIN = "7316914e-f8a8-49cb-808f-f549a56e668d";

const bash = `
set -e
DB=${DB}
SRK=$(docker exec supabase-kong-kar0ro1k6jiyfxzzw7acnsza printenv SUPABASE_SERVICE_ROLE_KEY | tr -d '\\r')
URL=https://pesowise-backup-supabase.unimisk.com

echo "=== edge probes (no connector token) ==="
for fn in start-tally-sync run-tally-sync-job run-tally-sync-delivery tally-connector; do
  code=$(curl -s -o /tmp/out.json -w "%{http_code}" -X POST "$URL/functions/v1/$fn" -H "Content-Type: application/json" -d '{}')
  echo "$fn HTTP $code body=$(head -c 200 /tmp/out.json)"
done

echo "=== tally-connector invalid token ==="
code=$(curl -s -o /tmp/out.json -w "%{http_code}" -X POST "$URL/functions/v1/tally-connector" \\
  -H "Content-Type: application/json" -H "X-Connector-Token: invalid-token-invalid-token-invalid" \\
  -d '{"action":"heartbeat"}')
echo "tally-connector bad-token HTTP $code body=$(head -c 120 /tmp/out.json)"

echo "=== run-tally-sync-delivery service role empty job ==="
curl -s -X POST "$URL/functions/v1/run-tally-sync-delivery" \\
  -H "Authorization: Bearer $SRK" -H "Content-Type: application/json" -d '{"job_id":"00000000-0000-0000-0000-000000000000"}'
echo

DEDUPE=$(echo -n "server-smoke|daily|$(date +%s%N)" | md5sum | awk '{print $1}')
JOB=$(docker exec $DB psql -U supabase_admin -d postgres -q -t -A -c \\
  "WITH ins AS (INSERT INTO tally_sync_jobs (organization_id,requested_by,report_type,parameters,dedupe_key,status) VALUES ('${ORG}','${ADMIN}','daily_project_report','{\\"context_version\\":1}'::jsonb,'$DEDUPE','queued') RETURNING id) SELECT id FROM ins;" | head -1 | tr -d '[:space:]')
echo "=== pipeline job=$JOB ==="
curl -s -X POST "$URL/functions/v1/run-tally-sync-job" -H "Authorization: Bearer $SRK" -H "Content-Type: application/json" -d "{\\"job_id\\":\\"$JOB\\"}"
echo
sleep 3
curl -s -X POST "$URL/functions/v1/run-tally-sync-delivery" -H "Authorization: Bearer $SRK" -H "Content-Type: application/json" -d "{\\"job_id\\":\\"$JOB\\"}" || true
echo
sleep 2
docker exec $DB psql -U supabase_admin -d postgres -c "SELECT id,status,prepared_item_count FROM tally_sync_jobs WHERE id='$JOB';"
docker exec $DB psql -U supabase_admin -d postgres -c "SELECT count(*) AS batches, min(status) AS min_st, max(status) AS max_st FROM tally_sync_delivery_batches WHERE job_id='$JOB';"
docker exec $DB psql -U supabase_admin -d postgres -tAc "SELECT count(*) FROM tally_delivery_state WHERE last_job_id='$JOB';"
`;

const conn = new Client();
conn.on("ready", () => {
  conn.exec(bash, (err, stream) => {
    if (err) throw err;
    stream.on("data", (d) => process.stdout.write(d));
    stream.stderr.on("data", (d) => process.stderr.write(d));
    stream.on("close", (c) => process.exit(c ?? 0));
  });
}).connect({ host: "192.168.23.46", username: user, password: pass });
