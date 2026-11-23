import { Client } from "ssh2";
const pass = process.env.DEPLOY_SSH_PASSWORD;
const user = process.env.DEPLOY_SSH_USER ?? "hasto";
const DB = "supabase-db-kar0ro1k6jiyfxzzw7acnsza";
const names = [
  "create_tally_connector_pairing_code_v1",
  "exchange_tally_connector_pairing_v1",
  "resolve_tally_connector_device_v1",
  "revoke_tally_connector_v1",
  "set_tally_org_company_v1",
  "connector_heartbeat_v1",
  "connector_ack_delivery_batch_v1",
  "connector_claim_delivery_batch_v1",
  "store_tally_delivery_batches_v1",
  "load_tally_sync_job_items_v1",
  "load_tally_delivery_state_v1",
];
const list = names.map((n) => `'${n}'`).join(",");
const bash = `docker exec ${DB} psql -U supabase_admin -d postgres -tAc "SELECT proname FROM pg_proc WHERE proname IN (${list}) ORDER BY 1;"`;
const conn = new Client();
conn.on("ready", () => {
  conn.exec(bash, (err, s) => {
    if (err) throw err;
    s.on("data", (d) => process.stdout.write(d));
    s.on("close", (c) => process.exit(c ?? 0));
  });
}).connect({ host: "192.168.23.46", username: user, password: pass });
