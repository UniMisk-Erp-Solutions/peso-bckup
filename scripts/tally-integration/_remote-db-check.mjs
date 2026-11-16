import { Client } from "ssh2";

const pass = process.env.DEPLOY_SSH_PASSWORD;
const user = process.env.DEPLOY_SSH_USER ?? "hasto";
const DB = "supabase-db-kar0ro1k6jiyfxzzw7acnsza";

const sql = `
SELECT jsonb_build_object(
  'tally_delivery_state', to_regclass('public.tally_delivery_state') IS NOT NULL,
  'tally_sync_delivery_batches', to_regclass('public.tally_sync_delivery_batches') IS NOT NULL,
  'tally_connector_devices', to_regclass('public.tally_connector_devices') IS NOT NULL,
  'connector_claim_rpc', EXISTS(SELECT 1 FROM pg_proc WHERE proname='connector_claim_delivery_batch_v1'),
  'store_batches_rpc', EXISTS(SELECT 1 FROM pg_proc WHERE proname='store_tally_delivery_batches_v1')
);
`;

const bash = `docker exec ${DB} psql -U supabase_admin -d postgres -tAc "${sql.replace(/"/g, '\\"')}"`;

const conn = new Client();
conn.on("ready", () => {
  conn.exec(bash, (err, stream) => {
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
