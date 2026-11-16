#!/usr/bin/env node
/** Re-run run-tally-sync-delivery for a prepared job (Coolify SSH + service role). */
import { Client } from "ssh2";
import { requireCoolifySshPassword, resolveCoolifySshHost, resolveCoolifySshUser } from "./_coolifySshCredentials.mjs";

const jobId = process.argv[2];
if (!jobId) {
  console.error("Usage: node redispatch-tally-delivery.mjs <job_id>");
  process.exit(2);
}

const URL = "https://pesowise-backup-supabase.unimisk.com";
const KONG = "supabase-kong-kar0ro1k6jiyfxzzw7acnsza";
const bash = `set -e
SRK=$(docker exec ${KONG} printenv SUPABASE_SERVICE_ROLE_KEY | tr -d '\\r')
echo "=== POST run-tally-sync-delivery job=${jobId} ==="
curl -s -w "\\nHTTP_CODE:%{http_code}\\nTIME:%{time_total}s\\n" -X POST "${URL}/functions/v1/run-tally-sync-delivery" \\
  -H "Authorization: Bearer $SRK" -H "Content-Type: application/json" \\
  -d '{"job_id":"${jobId}"}'
echo "=== batch count ==="
docker exec supabase-db-kar0ro1k6jiyfxzzw7acnsza psql -U supabase_admin -d postgres -tAc \\
  "SELECT status||':'||count(*)::text FROM tally_sync_delivery_batches WHERE job_id='${jobId}' GROUP BY status;"
docker exec supabase-db-kar0ro1k6jiyfxzzw7acnsza psql -U supabase_admin -d postgres -tAc \\
  "SELECT status||'|'||prepared_item_count::text FROM tally_sync_jobs WHERE id='${jobId}';"
`;

const pass = requireCoolifySshPassword();
const conn = new Client();
conn
  .on("ready", () => {
    conn.exec(bash, (err, stream) => {
      if (err) throw err;
      stream.on("data", (d) => process.stdout.write(d));
      stream.stderr.on("data", (d) => process.stderr.write(d));
      stream.on("close", (c) => process.exit(c ?? 0));
    });
  })
  .connect({ host: resolveCoolifySshHost(), username: resolveCoolifySshUser(), password: pass });
conn.on("error", (e) => {
  console.error(e.message);
  process.exit(1);
});
