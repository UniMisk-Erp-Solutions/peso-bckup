import { Client } from "ssh2";

const pass = process.env.DEPLOY_SSH_PASSWORD;
const user = process.env.DEPLOY_SSH_USER ?? "hasto";

const cmd = `
SRK=$(docker exec supabase-kong-kar0ro1k6jiyfxzzw7acnsza printenv SUPABASE_SERVICE_ROLE_KEY | tr -d '\\r')
URL=https://pesowise-backup-supabase.unimisk.com
echo "=== run-tally-sync-job ==="
curl -s -X POST "$URL/functions/v1/run-tally-sync-job" \\
  -H "Authorization: Bearer $SRK" -H "Content-Type: application/json" -d '{}'
echo
echo "=== start-tally-sync (expect forbidden for dummy org) ==="
curl -s -X POST "$URL/functions/v1/start-tally-sync" \\
  -H "Authorization: Bearer $SRK" -H "Content-Type: application/json" \\
  -d '{"organization_id":"00000000-0000-0000-0000-000000000000","report_type":"claim_verification","parameters":{}}'
echo
`;

const conn = new Client();
conn.on("ready", () => {
  conn.exec(cmd, (err, stream) => {
    if (err) throw err;
    stream.on("data", (d) => process.stdout.write(d));
    stream.stderr.on("data", (d) => process.stderr.write(d));
    stream.on("close", (c) => process.exit(c ?? 0));
  });
}).connect({ host: "192.168.23.46", username: user, password: pass });
conn.on("error", (e) => {
  console.error(e.message);
  process.exit(1);
});
